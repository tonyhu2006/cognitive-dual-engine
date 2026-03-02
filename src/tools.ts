/**
 * @file src/tools.ts
 * @description OpenClaw Agent Tool 注册
 *
 * 架构说明：
 *   OpenClaw 的真实生命周期钩子（agent:bootstrap, tool_result_persist）
 *   不提供「拦截动作生成」的能力。实现双引擎路由的正确方式是：
 *
 *   1. 注册两个 Agent Tool，使 LLM 能在规划时主动调用它们：
 *      - `cognitive_assess`：执行元认知评估（对应 beforeTaskPlanning）
 *      - `flare_plan`：执行 FLARE 前瞻规划（对应 onActionGeneration 的系统2分支）
 *
 *   2. 通过 agent:bootstrap 钩子将包含调用指引的 SKILL.md 注入系统提示，
 *      引导 LLM 在任务开始时必须先调用 cognitive_assess。
 *      这在语义上等价于「被动/强制触发」——Agent 被 bootstrap 指令约束，
 *      无法绕过复杂度评估直接行动。
 *
 *   3. tool_result_persist 钩子在工具结果持久化前触发，
 *      执行 Limited Commitment 的状态清理（对应 afterActionExecution）。
 */

import type {
  OpenClawTool,
  OpenClawPluginApi,
  ToolHandlerContext,
  ToolHandlerResult,
  CognitiveDualEngineConfig,
} from "./types.js";
import { assessCognitive } from "./complexity-assessor.js";
import { FLAREEngine } from "./flare-engine.js";
import type { LLMSimulator } from "./flare-engine.js";
import {
  initRollingPlanState,
  getRollingPlanState,
  commitFirstAction,
  buildCurrentStateDescription,
} from "./rolling-planner.js";

// ------------------------------------------------------------------
// 创建 LLM 模拟器（连接 OpenClaw 底层的 pi-ai 能力）
// ------------------------------------------------------------------

/**
 * createLLMSimulator — 创建连接 OpenClaw LLM 能力的模拟器实例
 *
 * 在此使用 OpenClaw plugin api.runtime 中可用的 LLM 调用能力。
 * 实际调用路径：api.runtime → pi-agent-core → pi-ai → 配置的 LLM 提供商
 */
function createLLMSimulator(api: OpenClawPluginApi): LLMSimulator {
  return {
    async generateActionCandidates(
      currentState: string,
      taskDescription: string,
      n: number,
    ) {
      // 调用 LLM 生成候选动作列表
      // 在生产中，此处通过 api.runtime 调用底层 LLM
      // 并要求以 JSON 格式返回 n 个结构化候选动作
      api.logger.debug(
        `[FLARE:Simulator] 为状态生成 ${n} 个候选动作`,
        { stateLength: currentState.length },
      );

      // 构造提示，要求 LLM 返回严格的 JSON 候选动作列表
      const prompt = [
        `你正在帮助完成以下任务：\n${taskDescription}`,
        `\n当前状态：\n${currentState}`,
        `\n请生成 ${n} 个最合理的下一步候选动作，以 JSON 数组返回。`,
        `每个元素包含：{ "id": string, "description": string, "type": "tool_call"|"reasoning_step"|"final_response", "priorScore": 0.0-1.0 }`,
        `只返回 JSON 数组，不要其他内容。`,
      ].join("\n");

      try {
        // 通过 OpenClaw runtime 调用底层 LLM
        // api.runtime 是 pi-coding-agent 暴露的 LLM 入口
        const result = (await (api.runtime as any).llm?.complete?.({
          messages: [{ role: "user", content: prompt }],
          temperature: 0.7, // 适当随机性以探索多样候选
        })) as { content: string } | undefined;

        if (result?.content) {
          const parsed = JSON.parse(
            result.content.replace(/```json|```/g, "").trim(),
          );
          if (Array.isArray(parsed)) {
            return parsed.slice(0, n);
          }
        }
      } catch (e) {
        api.logger.warn("[FLARE:Simulator] 候选动作生成失败，使用兜底候选", e);
      }

      // 兜底：返回通用候选（保证树不为空）
      return [
        {
          id: `fallback_1`,
          description: "进行更多信息收集与分析",
          type: "reasoning_step" as const,
          priorScore: 0.5,
        },
        {
          id: `fallback_2`,
          description: "直接回答当前已知内容",
          type: "final_response" as const,
          priorScore: 0.3,
        },
      ].slice(0, n);
    },

    async simulateStateTransition(currentState, action, taskDescription) {
      const prompt = [
        `任务：${taskDescription}`,
        `当前状态：${currentState}`,
        `即将执行的动作：${action.description}（类型：${action.type}）`,
        `请预测执行此动作后：`,
        `1. 新的状态描述（nextState）`,
        `2. 即时奖励估计 (immediateReward, 0.0-1.0，1.0表示这步动作直接达成目标)`,
        `以 JSON 返回: { "nextState": string, "immediateReward": number }`,
      ].join("\n");

      try {
        const result = (await (api.runtime as any).llm?.complete?.({
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3, // 状态转移模拟用低温，提升一致性
        })) as { content: string } | undefined;

        if (result?.content) {
          const parsed = JSON.parse(
            result.content.replace(/```json|```/g, "").trim(),
          );
          if (parsed.nextState && typeof parsed.immediateReward === "number") {
            return parsed;
          }
        }
      } catch (_) {
        api.logger.warn("[FLARE:Simulator] 状态转移模拟失败，使用兜底估计");
      }

      return {
        nextState: `${currentState}\n[执行后] ${action.description}`,
        immediateReward: action.priorScore,
      };
    },

    async evaluateTerminalValue(state, taskDescription) {
      const prompt = [
        `任务：${taskDescription}`,
        `当前状态（模拟到达的叶节点）：${state}`,
        `请评估：如果在此状态停止，任务完成度如何？`,
        `返回一个 0.0-1.0 的数字（1.0=完全完成），只返回数字。`,
      ].join("\n");

      try {
        const result = (await (api.runtime as any).llm?.complete?.({
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        })) as { content: string } | undefined;

        if (result?.content) {
          const val = parseFloat(result.content.trim());
          if (!isNaN(val)) return Math.max(0, Math.min(1, val));
        }
      } catch (_) {
        // fallback
      }
      return 0.5;
    },
  };
}

// ------------------------------------------------------------------
// Tool 1: cognitive_assess — 元认知评估工具
// ------------------------------------------------------------------

/**
 * createCognitiveAssessTool — 创建元认知评估 Agent Tool
 *
 * 此工具是「beforeTaskPlanning」语义的实现载体。
 * LLM 在收到用户请求时，由 SKILL.md 指引，首先调用此工具进行复杂度评估，
 * 然后根据标签决定是否需要进一步调用 flare_plan。
 */
export function createCognitiveAssessTool(
  cfg: CognitiveDualEngineConfig,
): OpenClawTool {
  return {
    name: "cognitive_assess",
    description:
      "【必须在规划任何复杂任务前调用】元认知复杂度评估工具。" +
      "分析当前任务的复杂度，返回认知路由标签：" +
      "SYSTEM_1_INTUITION（简单任务，直接回答）或" +
      "SYSTEM_2_FLARE（复杂任务，需调用 flare_plan 进行前瞻规划）。",
    inputSchema: {
      type: "object",
      properties: {
        userRequest: {
          type: "string",
          description: "用户的原始请求文本",
        },
        conversationContext: {
          type: "string",
          description: "当前对话的上下文摘要（最近3-5轮）",
        },
      },
      required: ["userRequest"],
    },
    async handler(
      input: Record<string, unknown>,
      ctx: ToolHandlerContext,
    ): Promise<ToolHandlerResult> {
      const userRequest = String(input.userRequest ?? "");
      const conversationContext = String(input.conversationContext ?? "");

      // 执行元认知计算
      const metadata = assessCognitive(userRequest, conversationContext, {
        threshold: cfg.system2Threshold,
        weights: {
          logicalChainDepth: 0.30,
          toolDependency: 0.20,
          ambiguityLevel: 0.15,
          crossDomainComplexity: 0.15,
          stateHistoryDependency: 0.15,
          latencyTolerance: 0.05,
        },
      });

      // 确保会话规划状态已初始化
      if (!getRollingPlanState(ctx.sessionKey)) {
        initRollingPlanState(ctx.sessionKey);
      }

      // 将元认知结果写入会话状态
      const state = getRollingPlanState(ctx.sessionKey)!;
      state.lastCognitiveMetadata = metadata;

      const dimStr = Object.entries(metadata.complexity.dimensions)
        .map(([k, v]) => `${k}: ${Number(v).toFixed(2)}`)
        .join(", ");

      return {
        content: JSON.stringify({
          tag: metadata.tag,
          score: metadata.complexity.score.toFixed(3),
          confidence: metadata.complexity.confidence.toFixed(2),
          rationale: metadata.complexity.rationale,
          dimensions: dimStr,
          instruction:
            metadata.tag === "SYSTEM_2_FLARE"
              ? "复杂度超过阈值，请立即调用 flare_plan 工具进行前瞻规划，再采取行动。"
              : "复杂度低，可直接回答或执行，无需前瞻规划。",
        }),
      };
    },
  };
}

// ------------------------------------------------------------------
// Tool 2: flare_plan — FLARE 前瞻规划工具
// ------------------------------------------------------------------

/**
 * createFlarePlanTool — 创建 FLARE 前瞻规划 Agent Tool
 *
 * 此工具是「onActionGeneration」中系统2分支的实现载体。
 * 当 cognitive_assess 返回 SYSTEM_2_FLARE 时，Agent 调用此工具，
 * 在后台执行完整的 FLARE 搜索树规划，返回全局最优的第一步动作。
 *
 * 工具内部完整实现：
 *   ① 显式前瞻（前瞻树构建 + UCB扩展）
 *   ② 反向价值传播
 *   ③ 有限承诺（commitFirstAction）
 */
export function createFlarePlanTool(
  api: OpenClawPluginApi,
  cfg: CognitiveDualEngineConfig,
): OpenClawTool {
  const flareEngine = new FLAREEngine(
    {
      maxDepth: cfg.flareMaxDepth,
      branchFactor: cfg.flareBranchFactor,
      simulationsPerNode: cfg.flareSimulationsPerNode,
      ucbExploration: Math.SQRT2,
    },
    createLLMSimulator(api),
  );

  return {
    name: "flare_plan",
    description:
      "【仅在 cognitive_assess 返回 SYSTEM_2_FLARE 时调用】" +
      "执行 FLARE (Future-aware LookAhead with Reward Estimation) 前瞻规划。" +
      "在后台构建未来轨迹模拟树，通过反向价值传播选出全局最优的第一步动作，" +
      "避免自回归贪婪陷阱。返回应立即执行的最优首步行动建议。",
    inputSchema: {
      type: "object",
      properties: {
        taskDescription: {
          type: "string",
          description: "任务的完整目标描述（用于引导 LLM 模拟器）",
        },
        currentStateDescription: {
          type: "string",
          description:
            "当前状态的描述（包括已完成步骤、可用工具、约束条件等）",
        },
      },
      required: ["taskDescription"],
    },
    async handler(
      input: Record<string, unknown>,
      ctx: ToolHandlerContext,
    ): Promise<ToolHandlerResult> {
      const taskDescription = String(input.taskDescription ?? "");
      const currentStateDescription =
        String(input.currentStateDescription ?? "") ||
        buildCurrentStateDescription(ctx.sessionKey, taskDescription);

      api.logger.info(
        "[CognitiveDualEngine] 启动 FLARE 规划",
        {
          sessionKey: ctx.sessionKey,
          maxDepth: cfg.flareMaxDepth,
          branchFactor: cfg.flareBranchFactor,
        },
      );

      try {
        // 执行完整 FLARE 规划（含前瞻树构建 + 反向价值传播）
        const planResult = await flareEngine.plan(
          currentStateDescription,
          taskDescription,
        );

        // 有限承诺：登记第一步动作，清理未提交假设为下轮滚动规划做准备
        if (!getRollingPlanState(ctx.sessionKey)) {
          initRollingPlanState(ctx.sessionKey);
        }
        commitFirstAction(
          ctx.sessionKey,
          planResult.bestFirstAction,
          planResult.searchTree,
        );

        api.logger.info("[CognitiveDualEngine] FLARE 规划完成", {
          sessionKey: ctx.sessionKey,
          globalValue: planResult.globalValueEstimate.toFixed(3),
          simCount: planResult.simulationCount,
          bestAction: planResult.bestFirstAction.description,
        });

        return {
          content: JSON.stringify({
            status: "FLARE_PLAN_COMPLETE",
            bestFirstAction: {
              description: planResult.bestFirstAction.description,
              type: planResult.bestFirstAction.type,
              toolName: planResult.bestFirstAction.toolName,
              toolArgs: planResult.bestFirstAction.toolArgs,
            },
            globalValueEstimate: planResult.globalValueEstimate.toFixed(3),
            simulationsRun: planResult.simulationCount,
            instruction:
              "已完成前瞻规划。请严格按照 bestFirstAction 执行下一步，" +
              "执行后等待工具结果，再调用 cognitive_assess 决定是否需要重新规划。",
          }),
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        api.logger.error("[CognitiveDualEngine] FLARE 规划失败", { errMsg });
        return {
          content: JSON.stringify({
            status: "FLARE_PLAN_FAILED",
            error: errMsg,
            fallback: "FLARE 规划失败，降级为系统1直接响应。",
          }),
          isError: true,
        };
      }
    },
  };
}