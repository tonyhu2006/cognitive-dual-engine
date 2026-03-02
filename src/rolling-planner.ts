/**
 * @file src/rolling-planner.ts
 * @description 滚动规划状态管理器 (Rolling Plan State Manager)
 *
 * 学术依据：FLARE 论文 §3.3 "Limited Commitment via Receding-Horizon Planning"
 *
 * ====================================================================
 * 有限承诺 (Limited Commitment) 的核心思想
 * ====================================================================
 * 传统序列规划一次性提交完整动作序列 [a_1, a_2, ..., a_T]，
 * 一旦 a_1 的估计有误，后续所有动作都可能系统性偏离。
 * FLARE 论文从理论上证明：有限承诺对早期估计误差是鲁棒的。
 *
 * 具体机制：
 *   1. 每次只承诺并执行规划树的第一步最优动作 a_1*
 *   2. 执行后，强制清空所有「未提交假设」(uncommitted hypotheses)：
 *      即规划树中 a_2, a_3, ... 等预期后续动作
 *   3. 获取实际环境反馈（工具执行结果、用户回复等）
 *   4. 以最新真实状态为基础，启动下一轮 FLARE 规划
 *
 * 本模块实现用户需求中 `afterActionExecution` 钩子的核心逻辑。
 * 在 OpenClaw 真实 API 中，通过 `tool_result_persist` 钩子激活，
 * 在每次工具执行结果持久化前执行状态更新与假设清理。
 *
 * ====================================================================
 * 与 OpenClaw 真实 Hook API 的映射关系
 * ====================================================================
 * 请求的 afterActionExecution 钩子  →  tool_result_persist 钩子
 *   - tool_result_persist 在每次工具结果被写入 session transcript 之前触发
 *   - 可同步修改 event.result 内容（实现结果增强）
 *   - 可同步读取 event.sessionKey 获取会话标识，更新 RollingPlanState
 */

import type { RollingPlanState, TreeNode, ActionCandidate } from "./types.js";

/** 内存中的会话规划状态存储（以 sessionKey 为键） */
const planStateStore = new Map<string, RollingPlanState>();

/**
 * initRollingPlanState — 初始化或重置会话的滚动规划状态
 * 在 agent:bootstrap 钩子触发时调用。
 */
export function initRollingPlanState(sessionKey: string): RollingPlanState {
  const state: RollingPlanState = {
    sessionKey,
    latestObservation: "",
    previousSearchTree: null,
    uncommittedHypotheses: [],
    stepCount: 0,
    lastCognitiveMetadata: null,
  };
  planStateStore.set(sessionKey, state);
  return state;
}

/**
 * getRollingPlanState — 获取会话的当前规划状态
 */
export function getRollingPlanState(
  sessionKey: string,
): RollingPlanState | undefined {
  return planStateStore.get(sessionKey);
}

/**
 * commitFirstAction — 有限承诺：提交第一步动作，清理未提交假设
 *
 * 这是 Limited Commitment 机制的核心操作。
 * 每次 FLARE 规划完成后，调用此函数：
 *   1. 记录"已承诺执行"的第一步动作
 *   2. 从规划树的第二步起，所有分支均标记为"未提交假设"
 *   3. 这些假设在下一次工具结果回调时被强制清空
 *
 * @param sessionKey       会话标识
 * @param committedAction  即将执行的第一步最优动作
 * @param searchTree       完整 FLARE 搜索树（用于提取未提交假设）
 */
export function commitFirstAction(
  sessionKey: string,
  committedAction: ActionCandidate,
  searchTree: TreeNode,
): void {
  const state = planStateStore.get(sessionKey);
  if (!state) {
    throw new Error(`[RollingPlanner] 未找到会话状态: ${sessionKey}`);
  }

  // 从搜索树第二层提取未提交假设（即规划树中的后续步骤）
  const uncommitted: ActionCandidate[] = [];
  const firstLevelChildren = searchTree.children;

  for (const child of firstLevelChildren) {
    // 跳过已承诺的最优第一步
    if (child.action?.id === committedAction.id) {
      // 将此分支的所有后续动作添加到未提交假设列表
      for (const grandChild of child.children) {
        if (grandChild.action) {
          uncommitted.push(grandChild.action);
        }
      }
      continue;
    }
    // 备选分支的动作也记录（用于审计）
    if (child.action) {
      uncommitted.push(child.action);
    }
  }

  state.uncommittedHypotheses = uncommitted;
  state.previousSearchTree = searchTree;
  state.stepCount++;
}

/**
 * onToolResultReceived — 工具执行结果回调处理
 *
 * 对应 `afterActionExecution` 的语义（通过 tool_result_persist 钩子触发）。
 *
 * 执行以下操作（严格遵循 FLARE Limited Commitment 机制）：
 *   1. 更新最新环境观测 (latestObservation)
 *   2. 强制清空未提交假设 (uncommittedHypotheses)
 *      — 无论旧假设是否"看起来"仍然有效，一律清空
 *      — 这是 FLARE 鲁棒性的关键：不依赖过期假设
 *   3. 失效旧搜索树（previousSearchTree 设为 null），强制下轮全新规划
 *
 * @param sessionKey    会话标识
 * @param toolResult    工具实际执行结果
 * @param toolName      触发的工具名称
 * @returns 更新后的状态快照（用于日志记录）
 */
export function onToolResultReceived(
  sessionKey: string,
  toolResult: string,
  toolName: string,
): { clearedHypothesesCount: number; newStepCount: number } {
  const state = planStateStore.get(sessionKey);
  if (!state) {
    // 首次使用时自动初始化
    initRollingPlanState(sessionKey);
    return { clearedHypothesesCount: 0, newStepCount: 0 };
  }

  const clearedCount = state.uncommittedHypotheses.length;

  // 核心操作：强制清空未提交假设
  // FLARE论文原话："Limited commitment discards all hypotheses beyond
  // the committed action, regardless of their apparent quality."
  state.uncommittedHypotheses = [];

  // 更新环境观测
  state.latestObservation = `[Tool: ${toolName}] ${toolResult}`;

  // 失效旧搜索树（下轮 FLARE 基于真实状态重新规划，而非继承旧树）
  state.previousSearchTree = null;

  return {
    clearedHypothesesCount: clearedCount,
    newStepCount: state.stepCount,
  };
}

/**
 * buildCurrentStateDescription — 构建当前状态描述文本，供 FLARE 下轮规划使用
 *
 * 聚合：最新工具观测 + 步骤计数 + 会话上下文摘要
 */
export function buildCurrentStateDescription(
  sessionKey: string,
  sessionContextSummary: string,
): string {
  const state = planStateStore.get(sessionKey);
  const observation = state?.latestObservation ?? "（无前序工具结果）";
  const step = state?.stepCount ?? 0;

  return (
    `[步骤 ${step}]\n` +
    `最新环境观测：${observation}\n` +
    `会话上下文摘要：${sessionContextSummary}`
  );
}

/** 清理会话状态（在 /reset 或 /new 命令时调用） */
export function clearRollingPlanState(sessionKey: string): void {
  planStateStore.delete(sessionKey);
}