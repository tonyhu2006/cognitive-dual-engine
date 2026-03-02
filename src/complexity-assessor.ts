/**
 * @file src/complexity-assessor.ts
 * @description 元认知计算器 (Meta-Cognition Computer)
 *
 * 职责：分析输入任务，对复杂度进行多维度评分，
 *       输出认知路由标签 (SYSTEM_1_INTUITION | SYSTEM_2_FLARE)。
 *
 * 设计依据：
 *   本模块实现用户需求中 `beforeTaskPlanning` 钩子的核心逻辑。
 *   由于 OpenClaw 真实 API 不提供此命名钩子，本模块以两种方式激活：
 *   1. 作为 `assess_complexity` Agent Tool，由 SKILL.md 引导 LLM 在规划前主动调用。
 *   2. 由 `agent:bootstrap` 钩子将评估指令注入 Agent 系统提示。
 *
 * 路由逻辑：
 *   综合复杂度 score = Σ(dimension_i * weight_i)
 *   score ≥ threshold → SYSTEM_2_FLARE（调用 FLARE 引擎进行前瞻规划）
 *   score < threshold  → SYSTEM_1_INTUITION（直接放行，使用 LLM 线性外推预测）
 *
 *   当置信度 < 0.6 时，保守起见一律路由至系统2，
 *   与 FLARE 论文"宁可多规划，不可贪婪短视"的精神一致。
 */

import type {
  ComplexityScore,
  CognitiveMetadata,
  CognitiveTag,
  ComplexityAssessorOptions,
  ComplexityDimensions,
  DimensionWeights,
} from "./types.js";

// ------------------------------------------------------------------
// 默认权重配置 — 各维度对「需要前瞻规划」贡献的先验权重
// 权重之和 = 1.0，确保 score ∈ [0, 1]
// ------------------------------------------------------------------
const DEFAULT_WEIGHTS: DimensionWeights = {
  logicalChainDepth:     0.30, // 逻辑链深度权重最高：多步依赖是 FLARE 最核心的适用场景
  toolDependency:        0.20, // 工具调用引入环境不确定性
  ambiguityLevel:        0.15, // 歧义需要提前规划消歧路径
  crossDomainComplexity: 0.15, // 跨域任务需要协调不同计算策略
  stateHistoryDependency:0.15, // 状态依赖使局部贪婪代价高昂
  latencyTolerance:      0.05, // 延迟容忍度仅作轻微影响
};

// 用于规则启发式打分的信号词典（不依赖外部 LLM 调用，零延迟）
const HIGH_COMPLEXITY_SIGNALS: ReadonlyArray<string> = [
  "分析", "比较", "规划", "设计", "重构", "优化",
  "实现.*步骤", "如何.*才能", "why", "analyze", "compare",
  "plan", "design", "refactor", "optimize", "implement",
  "step.by.step", "multi.step", "workflow", "pipeline",
];

const TOOL_SIGNALS: ReadonlyArray<string> = [
  "搜索", "查找", "读取", "写入", "执行", "运行", "发送", "调用",
  "search", "find", "read", "write", "execute", "run", "send",
  "browser", "file", "shell", "bash", "fetch", "api",
];

const AMBIGUITY_SIGNALS: ReadonlyArray<string> = [
  "maybe", "perhaps", "might", "or", "either", "possibly",
  "也许", "或者", "可能", "不确定",
];

// ------------------------------------------------------------------
// 核心评估函数
// ------------------------------------------------------------------

/**
 * 基于启发式规则评估单个维度得分
 *
 * 使用正则表达式对输入文本进行信号匹配，
 * 返回 [0, 1] 之间的归一化得分。
 * 在生产环境中，可将此函数替换为轻量级分类器调用，以提升精度。
 */
function scoreDimension(
  text: string,
  signals: ReadonlyArray<string>,
  baseScore: number = 0,
): number {
  const lowerText = text.toLowerCase();
  let matchCount = 0;

  for (const signal of signals) {
    if (new RegExp(signal, "i").test(lowerText)) {
      matchCount++;
    }
  }

  // 将命中数映射到 [0,1]，使用 tanh 软饱和避免极端值
  const rawScore = baseScore + matchCount / Math.max(signals.length, 1);
  return Math.tanh(rawScore * 2) / Math.tanh(2); // 归一化至 [0, ~1]
}

/**
 * 估算逻辑链深度：通过检测连词/步骤词计算估计推理跳数
 */
function estimateLogicalChainDepth(text: string): number {
  const stepIndicators = [
    /首先|然后|接着|最后|第[一二三四五六七八九十]\s*[步阶段]/g,
    /first|then|next|finally|step \d|phase \d/gi,
    /because|therefore|since|thus|hence/gi,
  ];

  let totalSteps = 0;
  for (const pattern of stepIndicators) {
    const matches = text.match(pattern);
    totalSteps += matches?.length ?? 0;
  }

  // 将步骤数映射到 [0,1]：0步→0，5+步→接近1
  return Math.min(totalSteps / 5, 1);
}

/**
 * computeComplexityScore — 多维度复杂度评估的主函数
 *
 * @param userInput      用户原始输入文本
 * @param conversationCtx 当前对话上下文（用于状态历史依赖分析）
 * @param options        评估选项（阈值、权重）
 * @returns ComplexityScore 含综合分、各维度分、置信度与解释
 */
export function computeComplexityScore(
  userInput: string,
  conversationCtx: string,
  options: Pick<ComplexityAssessorOptions, "weights">,
): ComplexityScore {
  const weights = options.weights;
  const combinedText = `${userInput} ${conversationCtx}`;

  // --- 各维度独立评分 ---

  const logicalChainDepth = Math.max(
    estimateLogicalChainDepth(userInput),
    scoreDimension(userInput, HIGH_COMPLEXITY_SIGNALS),
  );

  const toolDependency = scoreDimension(userInput, TOOL_SIGNALS);

  const ambiguityLevel = scoreDimension(userInput, AMBIGUITY_SIGNALS);

  const crossDomainComplexity = (() => {
    // 检测跨域信号：同时涉及多个技术领域
    const domains = [
      /code|程序|代码|编程/i,
      /data|数据|分析|统计/i,
      /design|设计|界面|UI/i,
      /business|业务|需求|流程/i,
      /research|研究|论文|学术/i,
    ];
    const domainHits = domains.filter((d) => d.test(combinedText)).length;
    return Math.min((domainHits - 1) / 3, 1); // 0个或1个领域→0，4+个→1
  })();

  // 历史状态依赖：基于对话上下文长度与工具调用历史推测
  const stateHistoryDependency = Math.min(
    conversationCtx.length / 2000, // 长上下文 → 更可能有状态依赖
    1,
  );

  // 延迟容忍度：任务越长越复杂，用户通常接受更长思考时间
  const latencyTolerance = Math.min(userInput.length / 300, 1);

  const dimensions: ComplexityDimensions = {
    logicalChainDepth,
    toolDependency,
    ambiguityLevel,
    crossDomainComplexity,
    stateHistoryDependency,
    latencyTolerance,
  };

  // --- 加权综合分 ---
  const score =
    dimensions.logicalChainDepth * weights.logicalChainDepth +
    dimensions.toolDependency * weights.toolDependency +
    dimensions.ambiguityLevel * weights.ambiguityLevel +
    dimensions.crossDomainComplexity * weights.crossDomainComplexity +
    dimensions.stateHistoryDependency * weights.stateHistoryDependency +
    dimensions.latencyTolerance * weights.latencyTolerance;

  // --- 置信度估计：当多个维度均有信号时，置信度更高 ---
  const signalCount = Object.values(dimensions).filter((v) => v > 0.2).length;
  const confidence = Math.min(signalCount / 4, 1); // 4个以上维度有信号 → 置信度=1

  // --- 决策解释 ---
  const topDimension = Object.entries(dimensions).reduce(
    (max, [k, v]) => (v > max[1] ? [k, v] : max),
    ["none", 0],
  );

  const rationale =
    `综合复杂度分: ${score.toFixed(3)}，置信度: ${confidence.toFixed(2)}。` +
    `最高贡献维度: ${topDimension[0]}(${Number(topDimension[1]).toFixed(2)})。`;

  return {
    score: Math.min(score, 1),
    dimensions,
    confidence,
    rationale,
  };
}

/**
 * assessCognitive — 公开入口：执行完整元认知计算，返回路由标签
 *
 * 路由规则（按优先级）：
 *   1. 置信度 < 0.4 → 保守路由至系统2（不确定时不冒险）
 *   2. score ≥ threshold → SYSTEM_2_FLARE
 *   3. score < threshold → SYSTEM_1_INTUITION
 */
export function assessCognitive(
  userInput: string,
  conversationCtx: string,
  options: ComplexityAssessorOptions,
): CognitiveMetadata {
  const complexity = computeComplexityScore(userInput, conversationCtx, {
    weights: options.weights,
  });

  let tag: CognitiveTag;

  if (complexity.confidence < 0.4) {
    // 置信度不足时，保守选择系统2，与 FLARE 论文"系统性放大早期错误"的警告一致
    tag = "SYSTEM_2_FLARE";
  } else if (complexity.score >= options.threshold) {
    tag = "SYSTEM_2_FLARE";
  } else {
    tag = "SYSTEM_1_INTUITION";
  }

  return {
    tag,
    complexity,
    computedAt: Date.now(),
    assessorVersion: "1.0.0",
  };
}