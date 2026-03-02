/**
 * @file src/types.ts
 * @description CognitiveDualEngine 插件完整类型定义
 *
 * 类型设计原则：
 *   - 每个接口严格对应一个认知层的数据契约
 *   - 所有外部 I/O 均为 readonly，防止副作用污染
 *   - 使用 discriminated union 确保状态机的类型安全切换
 */

// ===================================================================
// § 1. 认知路由标签 — 元认知计算的最终裁决
// ===================================================================

/**
 * 认知路由标签（Cognitive Routing Tag）
 *
 * SYSTEM_1_INTUITION:
 *   对应 Kahneman(2011) 系统1，快速、自动、低消耗。
 *   学术依据(DeepMind arXiv:2601.22364)：在自然语言等「持续预测」任务中，
 *   LLM 深层会自发将 token 序列的表征轨迹「拉直」(Representational
 *   Straightening)，使模型能通过线性外推高效完成下一步预测，无需显式搜索。
 *   ⚠️ 重要限制：该论文同时发现一个「双重解离」(Dichotomy)——此机制仅在
 *   「持续预测」类任务中稳定；在少样本学习等「结构化预测」任务中，拉直度与
 *   任务表现无显著相关。因此 SYSTEM_1 路由仅适用于确定性高、逻辑链短的简单任务。
 *
 * SYSTEM_2_FLARE:
 *   对应 Kahneman(2011) 系统2，审慎、深思、高消耗。
 *   学术依据(Stanford et al. arXiv:2601.22311)：LLM 自回归生成天然是
 *   「逐步贪婪策略」(Step-wise Greedy Policy)，在长视野任务中会系统性地
 *   陷入局部最优陷阱。FLARE (Future-aware LookAhead with Reward Estimation)
 *   通过三个核心机制打破此限制：显式轨迹模拟、反向价值传播、有限承诺/滚动规划。
 */
export type CognitiveTag = "SYSTEM_1_INTUITION" | "SYSTEM_2_FLARE";

// ===================================================================
// § 2. 复杂度评分系统 — 元认知计算的多维输入
// ===================================================================

/**
 * 复杂度评估维度
 * 每个维度对应一类会导致系统1失效的认知负荷来源。
 */
export interface ComplexityDimensions {
  /**
   * 逻辑链深度 (0.0–1.0)
   * 估计完成任务所需的推理跳数。
   * 高值表示需要多步依赖推理（FLARE论文核心攻克的场景）。
   */
  logicalChainDepth: number;

  /**
   * 工具依赖度 (0.0–1.0)
   * 任务需要调用外部工具/API的程度。
   * 工具调用会引入环境反馈，使下一步动作依赖外部状态，需要滚动规划。
   */
  toolDependency: number;

  /**
   * 歧义性 (0.0–1.0)
   * 用户意图的不确定程度。高歧义任务需要提前规划消歧路径。
   */
  ambiguityLevel: number;

  /**
   * 跨域性 (0.0–1.0)
   * 任务跨越多个知识领域的程度。
   * 注：DeepMind论文发现模型在不同任务下使用不同计算策略（"Swiss Army knife"）；
   * 高跨域任务更可能触发策略切换，需要显式规划协调。
   */
  crossDomainComplexity: number;

  /**
   * 历史状态依赖 (0.0–1.0)
   * 当前决策对之前多步操作结果的敏感程度。
   * 高值意味着贪婪的局部决策可能在未来产生无法恢复的错误（FLARE论文核心分析）。
   */
  stateHistoryDependency: number;

  /**
   * 延迟容忍度 (0.0–1.0，越高=越能接受延迟=越适合系统2)
   * 任务对响应时延的容忍程度。实时对话倾向系统1；离线分析任务可容忍系统2开销。
   */
  latencyTolerance: number;
}

/** 复杂度维度的权重配置，用于加权求和计算综合分 */
export interface DimensionWeights {
  logicalChainDepth: number;
  toolDependency: number;
  ambiguityLevel: number;
  crossDomainComplexity: number;
  stateHistoryDependency: number;
  latencyTolerance: number;
}

/** 元认知计算的最终输出 */
export interface ComplexityScore {
  /** 加权综合分 (0.0–1.0) */
  readonly score: number;
  /** 各维度细分得分（用于可解释性审计） */
  readonly dimensions: ComplexityDimensions;
  /**
   * 元认知置信度 (0.0–1.0)
   * 当置信度低时，应偏向保守路由至系统2（宁可多算，不可漏算）。
   */
  readonly confidence: number;
  /** 路由决策的自然语言解释 */
  readonly rationale: string;
}

/** 附加在上下文中的完整认知元数据 */
export interface CognitiveMetadata {
  readonly tag: CognitiveTag;
  readonly complexity: ComplexityScore;
  readonly computedAt: number;
  /** 元认知计算的版本，便于 A/B 追踪 */
  readonly assessorVersion: string;
}

// ===================================================================
// § 3. FLARE 规划树数据结构
// ===================================================================

/** 动作类型枚举 */
export type ActionType = "tool_call" | "reasoning_step" | "final_response";

/**
 * 动作候选 — FLARE 树中每个节点的可选动作单元
 *
 * 对应 FLARE 论文中的 "action candidate a_i"。
 * 候选动作不会立即执行，而是先在模拟树中被评估未来价值，
 * 再由反向价值传播决定是否选择。
 */
export interface ActionCandidate {
  readonly id: string;
  readonly description: string;
  readonly type: ActionType;
  readonly toolName?: string;
  readonly toolArgs?: Readonly<Record<string, unknown>>;
  /**
   * 即时先验奖励估计 r_0 (由模型快速打分，非精确值)
   * 对应 FLARE 中的 step-wise score，但仅作参考，
   * 最终价值由反向传播的 V(s) 决定。
   */
  readonly priorScore: number;
}

/**
 * FLARE 模拟树节点
 *
 * 学术依据：Stanford FLARE 论文 §3.2 "Lookahead Tree Construction"
 * 树结构维护从当前状态出发的所有可能轨迹前缀，
 * 使「下游结果能够影响早期决策」成为可能。
 */
export interface TreeNode {
  readonly id: string;
  /** 此节点选择的动作（根节点为 null） */
  readonly action: ActionCandidate | null;
  /** 执行此动作后的模拟状态快照 */
  readonly simulatedStateSnapshot: string;
  /** 此节点的深度（根=0） */
  readonly depth: number;
  /** 子节点列表 */
  readonly children: TreeNode[];
  /**
   * UCB 选择统计（用于均衡 exploitation/exploration）
   * n: 访问次数；totalValue: 累积价值
   */
  readonly ucbStats: { n: number; totalValue: number };
  /**
   * 反向传播后的估计值 V(s)
   * 初始为 null，由 backwardValuePropagation() 填充。
   */
  backpropValue: number | null;
  /**
   * 轨迹模拟记录（用于 trajectory memory 避免重复评估）
   * 对应 FLARE 论文效率优化：同一子树路径不重复展开。
   */
  readonly trajectoryHash: string;
}

/** FLARE 规划结果，由 System2 分支返回给调用方 */
export interface FLAREPlanResult {
  /** 经反向价值传播后的最优第一步动作 */
  readonly bestFirstAction: ActionCandidate;
  /** 规划过程中构建的完整搜索树（用于滚动规划时复用） */
  readonly searchTree: TreeNode;
  /**
   * 当前步的全局最优价值估计 V*(s_0)
   * 可用于与阈值比较，决定是否需要重新规划。
   */
  readonly globalValueEstimate: number;
  /** 本次规划消耗的模拟次数（用于 token 预算追踪） */
  readonly simulationCount: number;
}

// ===================================================================
// § 4. 滚动规划状态 — Limited Commitment 的实现基础
// ===================================================================

/**
 * 滚动规划状态快照
 *
 * 学术依据：FLARE 论文 §3.3 "Limited Commitment via Receding-Horizon"
 * 核心思想：每执行一步动作后，不继承旧规划，而是根据实际环境反馈
 * 重新评估并裁剪未提交的预期假设（uncommitted hypotheses）。
 * 这使 Agent 对早期估计误差具有鲁棒性。
 */
export interface RollingPlanState {
  /** 当前会话标识 */
  readonly sessionKey: string;
  /** 上一步执行后的实际环境反馈 */
  latestObservation: string;
  /**
   * 上一轮 FLARE 搜索树（部分结果可以复用为下轮的先验）
   * 若为 null，则下轮执行全新规划。
   */
  previousSearchTree: TreeNode | null;
  /**
   * 未提交的假设列表（Uncommitted Hypotheses）
   * 存储上一轮规划中「预期」但尚未实际执行的后续步骤。
   * afterActionExecution 对应的钩子(tool_result_persist)会强制清空此列表，
   * 以防旧假设污染新的滚动规划。
   */
  uncommittedHypotheses: ActionCandidate[];
  /** 当前步骤编号（从1开始） */
  stepCount: number;
  /** 认知元数据（上一次元认知计算结果） */
  lastCognitiveMetadata: CognitiveMetadata | null;
}

// ===================================================================
// § 5. Plugin 配置类型
// ===================================================================

/** 从 openclaw.plugin.json configSchema 解析出的配置对象 */
export interface CognitiveDualEngineConfig {
  readonly system2Threshold: number;
  readonly flareMaxDepth: number;
  readonly flareBranchFactor: number;
  readonly flareSimulationsPerNode: number;
  readonly enabled: boolean;
}

/** 复杂度评估器的选项 */
export interface ComplexityAssessorOptions {
  readonly threshold: number;
  readonly weights: DimensionWeights;
}

/** FLARE 引擎的选项 */
export interface FLAREEngineOptions {
  readonly maxDepth: number;
  readonly branchFactor: number;
  readonly simulationsPerNode: number;
  /** UCB 探索常数 c（默认 √2） */
  readonly ucbExploration: number;
}

// ===================================================================
// § 6. OpenClaw API 相关类型（按文档定义）
// ===================================================================

/** OpenClaw HookHandler 的事件类型（简化版，覆盖本插件所需事件） */
export interface OpenClawHookEvent {
  type: "command" | "session" | "agent" | "gateway";
  action: string;
  sessionKey: string;
  timestamp: Date;
  /** 向用户发送消息的管道，往此数组 push 字符串即可 */
  messages: string[];
  context: {
    sessionEntry?: unknown;
    sessionId?: string;
    sessionFile?: string;
    commandSource?: string;
    senderId?: string;
    workspaceDir?: string;
    bootstrapFiles?: Array<{ path: string; content: string }>;
    cfg?: Record<string, unknown>;
  };
}

/** tool_result_persist 钩子的特殊事件类型 */
export interface ToolResultPersistEvent {
  type: "tool_result_persist";
  sessionKey: string;
  toolName: string;
  /** 工具执行结果（可变，修改此字段即可改变持久化内容） */
  result: {
    content: string | unknown;
    isError?: boolean;
  };
}

/** OpenClaw Plugin API（按官方文档定义的注册接口） */
export interface OpenClawPluginApi {
  config: Record<string, unknown>;
  logger: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
    debug(msg: string, ...args: unknown[]): void;
  };
  registerTool(tool: OpenClawTool): void;
  registerService(service: OpenClawService): void;
  registerCommand(command: OpenClawCommand): void;
  /**
   * 注册事件钩子处理器（可选——部分 OpenClaw 版本可能不提供此方法）
   * 事件名称示例："agent:bootstrap", "tool_result_persist"
   */
  registerHook?(eventName: string, handler: Function): void;
  runtime: {
    tts?: unknown;
    [key: string]: unknown;
  };
}

/** OpenClaw Agent Tool（插件可注册的工具，供 LLM 调用） */
export interface OpenClawTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler(input: Record<string, unknown>, ctx: ToolHandlerContext): Promise<ToolHandlerResult>;
}

/** 工具执行上下文 */
export interface ToolHandlerContext {
  sessionKey: string;
  senderId?: string;
  cfg: Record<string, unknown>;
}

/** 工具执行结果 */
export interface ToolHandlerResult {
  content: string;
  isError?: boolean;
}

/** OpenClaw 后台服务 */
export interface OpenClawService {
  id: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

/** OpenClaw 自动回复命令 */
export interface OpenClawCommand {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler(ctx: {
    sessionKey?: string;
    senderId?: string;
    channel: string;
    args?: string;
    config: Record<string, unknown>;
  }): { text: string } | Promise<{ text: string }>;
}