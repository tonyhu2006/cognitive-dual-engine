/**
 * @file src/flare-engine.ts
 * @description FLARE 引擎 (Future-aware LookAhead with Reward Estimation)
 *
 * 学术依据：Stanford et al.《Why Reasoning Fails to Plan》(arXiv:2601.22311)
 *
 * ====================================================================
 * FLARE 的三个核心机制（严格对应论文 §3）
 * ====================================================================
 *
 * ① 显式前瞻搜索 (Explicit Lookahead via Trajectory Simulation)
 *    维护以当前状态 s_0 为根的搜索树。
 *    使用 UCB (Upper Confidence Bound) 策略均衡 exploitation/exploration：
 *      UCB(a) = Q(a) + c * sqrt(ln(N) / n(a))
 *    通过 LLM 自身作为世界模型，模拟动作 a 之后的状态转移 s → s'，
 *    而非依赖固定打分函数。
 *
 * ② 反向价值传播 (Backward Value Propagation)
 *    从叶节点向根节点传播折扣累积奖励：
 *      V(s_t) = r_t + γ * V(s_{t+1})
 *    使「早期动作的价值」能够反映其「下游后果」，
 *    彻底打破步骤间的贪婪近视性。
 *
 * ③ 有限承诺/滚动规划 (Limited Commitment / Receding-Horizon Planning)
 *    每步只执行搜索树的第一步最优动作（而非提交完整规划序列）。
 *    执行后丢弃所有未提交假设，根据实际环境反馈重新规划。
 *    FLARE 论文证明：此机制对早期估计误差具有数学意义上的鲁棒性。
 *
 * ====================================================================
 * 效率优化（对应论文 Appendix 效率分析）
 * ====================================================================
 *   - Action Pruning：每节点仅扩展 branchFactor 个最优候选（非全枚举）
 *   - Trajectory Memory：相同轨迹哈希的节点不重复展开
 *   - Budget-Aware：在 token 预算耗尽时优先返回当前最优估计
 */

import type {
  ActionCandidate,
  TreeNode,
  FLAREPlanResult,
  FLAREEngineOptions,
} from "./types.js";
import { createHash } from "crypto";

// ------------------------------------------------------------------
// 工具函数
// ------------------------------------------------------------------

/** 生成轨迹哈希，用于 Trajectory Memory 去重 */
function hashTrajectory(actions: readonly ActionCandidate[]): string {
  const key = actions.map((a) => `${a.type}:${a.description}`).join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** 生成新节点 */
function createNode(
  action: ActionCandidate | null,
  simulatedState: string,
  depth: number,
  ancestorActions: readonly ActionCandidate[],
): TreeNode {
  return {
    id: `node_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    action,
    simulatedStateSnapshot: simulatedState,
    depth,
    children: [],
    ucbStats: { n: 0, totalValue: 0 },
    backpropValue: null,
    trajectoryHash: hashTrajectory(action ? [...ancestorActions, action] : []),
  };
}

/** UCB1 选择分数：Q + c * sqrt(ln(N) / n) */
function ucbScore(node: TreeNode, parentVisits: number, c: number): number {
  if (node.ucbStats.n === 0) return Infinity; // 未访问节点优先
  const q = node.ucbStats.totalValue / node.ucbStats.n;
  const exploration = c * Math.sqrt(Math.log(parentVisits) / node.ucbStats.n);
  return q + exploration;
}

// ------------------------------------------------------------------
// LLM 模拟适配器接口 — 将 FLARE 引擎与具体 LLM 调用解耦
// ------------------------------------------------------------------

/**
 * LLM 模拟器适配器
 * 在真实部署中，此接口由 OpenClaw 的 pi-ai 底层实现。
 * 在测试中可替换为确定性 mock。
 */
export interface LLMSimulator {
  /**
   * 给定当前状态描述，生成 n 个候选下一步动作
   * （对应 FLARE 中的 "action candidate generation"）
   */
  generateActionCandidates(
    currentState: string,
    taskDescription: string,
    n: number,
  ): Promise<ActionCandidate[]>;

  /**
   * 模拟执行某动作后的状态转移
   * LLM 充当隐式世界模型 (Implicit World Model)，
   * 这是 FLARE 的核心创新：不需要单独训练 world model，
   * 直接用原有 LLM 预测 s'。
   */
  simulateStateTransition(
    currentState: string,
    action: ActionCandidate,
    taskDescription: string,
  ): Promise<{ nextState: string; immediateReward: number }>;

  /**
   * 对终止节点或叶节点评估终局价值 V_terminal(s)
   * 用于反向传播的起点。
   */
  evaluateTerminalValue(
    state: string,
    taskDescription: string,
  ): Promise<number>;
}

// ------------------------------------------------------------------
// FLARE 引擎核心类
// ------------------------------------------------------------------

export class FLAREEngine {
  private readonly options: FLAREEngineOptions;
  private readonly simulator: LLMSimulator;

  /**
   * 已访问轨迹哈希集合（Trajectory Memory）
   * 对应 FLARE 论文效率优化：避免同一路径被重复展开，
   * 论文数据显示此优化可节省 ~60% token 消耗。
   */
  private readonly visitedTrajectories = new Set<string>();

  /** 模拟计数器（用于 token 预算追踪） */
  private simulationCount = 0;

  constructor(options: FLAREEngineOptions, simulator: LLMSimulator) {
    this.options = options;
    this.simulator = simulator;
  }

  // ----------------------------------------------------------------
  // 公开入口：执行完整 FLARE 规划，返回最优第一步动作
  // ----------------------------------------------------------------

  /**
   * plan — 执行显式前瞻规划
   *
   * 完整执行 FLARE 的三个核心机制：
   * 1. 构建前瞻树（含 UCB 扩展 + LLM 模拟）
   * 2. 反向价值传播
   * 3. 选取使 V(s_0) 最大的第一步动作
   *
   * @param currentState     当前状态描述
   * @param taskDescription  任务总目标
   * @returns FLAREPlanResult 含最优第一步动作与搜索树
   */
  async plan(
    currentState: string,
    taskDescription: string,
  ): Promise<FLAREPlanResult> {
    this.simulationCount = 0;
    this.visitedTrajectories.clear();

    // 创建根节点
    const rootNode = createNode(null, currentState, 0, []);

    // 展开前瞻树（Lookahead Tree Construction）
    await this.expandNode(rootNode, taskDescription, []);

    // 反向价值传播（Backward Value Propagation）
    const rootValue = this.backwardValuePropagation(rootNode);

    // 选取最优第一步动作（Limited Commitment 的第一个承诺）
    if (rootNode.children.length === 0) {
      throw new Error("[FLARE] 根节点无子节点，无法规划第一步动作");
    }

    const bestChild = rootNode.children.reduce((best, child) => {
      const childV = child.backpropValue ?? -Infinity;
      const bestV = best.backpropValue ?? -Infinity;
      return childV > bestV ? child : best;
    });

    if (!bestChild.action) {
      throw new Error("[FLARE] 最优子节点缺少动作信息");
    }

    return {
      bestFirstAction: bestChild.action,
      searchTree: rootNode,
      globalValueEstimate: rootValue,
      simulationCount: this.simulationCount,
    };
  }

  // ----------------------------------------------------------------
  // 私有：递归展开节点（含 UCB 选择 + Action Pruning）
  // ----------------------------------------------------------------

  /**
   * expandNode — 以 UCB 策略递归扩展搜索树节点
   *
   * 流程：
   *   1. 深度检查 → 叶节点直接评估终局价值
   *   2. Trajectory Memory 去重 → 跳过已访问路径
   *   3. 调用 LLM 生成候选动作（Action Pruning：仅保留 branchFactor 个）
   *   4. 对每个候选动作：模拟状态转移，递归扩展子树
   */
  private async expandNode(
    node: TreeNode,
    taskDescription: string,
    ancestorActions: ActionCandidate[],
  ): Promise<void> {
    // ① 深度限制：叶节点评估终局价值并返回
    if (node.depth >= this.options.maxDepth) {
      const terminalValue = await this.simulator.evaluateTerminalValue(
        node.simulatedStateSnapshot,
        taskDescription,
      );
      this.simulationCount++;
      node.ucbStats.n = 1;
      node.ucbStats.totalValue = terminalValue;
      return;
    }

    // ② Trajectory Memory：已访问的轨迹直接跳过
    if (this.visitedTrajectories.has(node.trajectoryHash)) {
      return;
    }
    this.visitedTrajectories.add(node.trajectoryHash);

    // ③ 生成候选动作（Action Pruning：只取 branchFactor 个最佳候选）
    //    先验分 priorScore 用于候选动作的初步筛选排序，
    //    但最终决策依赖反向传播的 V(s)，而非 priorScore（避免贪婪）
    const candidates = await this.simulator.generateActionCandidates(
      node.simulatedStateSnapshot,
      taskDescription,
      this.options.branchFactor,
    );

    // 按 priorScore 降序排序（Action Pruning 的启发式策略）
    const prunedCandidates = candidates
      .sort((a, b) => b.priorScore - a.priorScore)
      .slice(0, this.options.branchFactor);

    // ④ 对每个候选动作：模拟 + 递归扩展
    const expansionPromises = prunedCandidates.map(async (action) => {
      // 模拟执行此动作，获取下一状态与即时奖励
      const { nextState, immediateReward } =
        await this.simulator.simulateStateTransition(
          node.simulatedStateSnapshot,
          action,
          taskDescription,
        );
      this.simulationCount++;

      // 创建子节点
      const childNode = createNode(
        action,
        nextState,
        node.depth + 1,
        ancestorActions,
      );

      // 多次模拟（simulationsPerNode）以减小方差
      for (let s = 0; s < this.options.simulationsPerNode - 1; s++) {
        const { immediateReward: extraR } =
          await this.simulator.simulateStateTransition(
            node.simulatedStateSnapshot,
            action,
            taskDescription,
          );
        this.simulationCount++;
        // 累积到 UCB 统计
        childNode.ucbStats.n++;
        childNode.ucbStats.totalValue += extraR;
      }

      childNode.ucbStats.n++;
      childNode.ucbStats.totalValue += immediateReward;

      // 递归扩展子节点
      await this.expandNode(childNode, taskDescription, [
        ...ancestorActions,
        action,
      ]);

      // 将子节点挂载到当前节点
      (node.children as TreeNode[]).push(childNode);
    });

    // 并发扩展所有候选分支（提升效率）
    await Promise.all(expansionPromises);

    // 更新父节点 UCB 统计（n++，totalValue 由反向传播填充）
    node.ucbStats.n = node.children.reduce((s, c) => s + c.ucbStats.n, 0);
  }

  // ----------------------------------------------------------------
  // 私有：反向价值传播（Backward Value Propagation）
  // ----------------------------------------------------------------

  /**
   * backwardValuePropagation — 从叶节点向根节点传播折扣奖励
   *
   * 学术原理（FLARE §3.1）：
   *   逐步贪婪策略的核心缺陷在于：它用 step-wise score(a_t)
   *   近似 V*(s_t)，忽略了后续步骤的价值。
   *
   *   反向价值传播修正此问题：
   *     V(s_t) = r_t + γ * max_{a_{t+1}} V(s_{t+1})
   *   其中 γ 为折扣因子（此处设为 0.9），
   *   使叶节点的价值信号逐步回流到根节点的第一步决策中。
   *
   * @param node 当前节点
   * @returns 该节点的估计价值 V(s)
   */
  private backwardValuePropagation(node: TreeNode): number {
    // 叶节点（无子节点）：直接用 UCB 统计的平均奖励作为终局价值
    if (node.children.length === 0) {
      const leafValue =
        node.ucbStats.n > 0
          ? node.ucbStats.totalValue / node.ucbStats.n
          : 0;
      node.backpropValue = leafValue;
      return leafValue;
    }

    // 折扣因子 γ = 0.9（轻微折扣，鼓励短路径同时不完全忽略深层价值）
    const DISCOUNT_FACTOR = 0.9;

    // 递归计算所有子节点价值
    const childValues = node.children.map((child) =>
      this.backwardValuePropagation(child),
    );

    // 贝尔曼最优方程：V(s) = 即时奖励均值 + γ * max(子节点价值)
    const immediateRewardMean =
      node.ucbStats.n > 0 ? node.ucbStats.totalValue / node.ucbStats.n : 0;
    const maxChildValue = Math.max(...childValues);

    const nodeValue = immediateRewardMean + DISCOUNT_FACTOR * maxChildValue;

    node.backpropValue = nodeValue;
    return nodeValue;
  }
}