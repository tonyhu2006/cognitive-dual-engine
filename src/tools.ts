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
        `[FLARE:Simulator] Generating ${n} candidate actions for current state`,
        { stateLength: currentState.length },
      );

      // 构造提示，要求 LLM 返回严格的 JSON 候选动作列表
      const prompt = [
        `You are helping to complete the following task:\n${taskDescription}`,
        `\nCurrent state:\n${currentState}`,
        `\nPlease generate ${n} most reasonable next-step candidate actions, returned as a JSON array.`,
        `Each element should contain: { "id": string, "description": string, "type": "tool_call"|"reasoning_step"|"final_response", "priorScore": 0.0-1.0 }`,
        `Return only the JSON array, nothing else.`,
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
        api.logger.warn("[FLARE:Simulator] Candidate action generation failed, using fallback candidates", e);
      }

      // 兜底：返回通用候选（保证树不为空）
      return [
        {
          id: `fallback_1`,
          description: "Gather more information and analyze",
          type: "reasoning_step" as const,
          priorScore: 0.5,
        },
        {
          id: `fallback_2`,
          description: "Directly respond with currently known information",
          type: "final_response" as const,
          priorScore: 0.3,
        },
      ].slice(0, n);
    },

    async simulateStateTransition(currentState, action, taskDescription) {
      const prompt = [
        `Task: ${taskDescription}`,
        `Current state: ${currentState}`,
        `Action about to execute: ${action.description} (type: ${action.type})`,
        `Please predict after executing this action:`,
        `1. The new state description (nextState)`,
        `2. Immediate reward estimate (immediateReward, 0.0-1.0, where 1.0 means the action directly achieves the goal)`,
        `Return as JSON: { "nextState": string, "immediateReward": number }`,
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
        api.logger.warn("[FLARE:Simulator] State transition simulation failed, using fallback estimate");
      }

      return {
        nextState: `${currentState}\n[After execution] ${action.description}`,
        immediateReward: action.priorScore,
      };
    },

    async evaluateTerminalValue(state, taskDescription) {
      const prompt = [
        `Task: ${taskDescription}`,
        `Current state (simulated leaf node): ${state}`,
        `Please evaluate: if stopping at this state, how complete is the task?`,
        `Return a single number between 0.0-1.0 (1.0 = fully complete), return only the number.`,
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
      "[MUST be called before planning any complex task] Meta-cognitive complexity assessment tool. " +
      "Analyzes the current task's complexity and returns a cognitive routing tag: " +
      "SYSTEM_1_INTUITION (simple task, respond directly) or " +
      "SYSTEM_2_FLARE (complex task, requires calling flare_plan for lookahead planning).",
    inputSchema: {
      type: "object",
      properties: {
        userRequest: {
          type: "string",
          description: "The user's raw request text",
        },
        conversationContext: {
          type: "string",
          description: "Current conversation context summary (last 3-5 turns)",
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
              ? "Complexity exceeds threshold. Call flare_plan tool immediately for lookahead planning before taking action."
              : "Complexity is low. Respond or execute directly without lookahead planning.",
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
      "[Call ONLY when cognitive_assess returns SYSTEM_2_FLARE] " +
      "Execute FLARE (Future-aware LookAhead with Reward Estimation) lookahead planning. " +
      "Builds a future trajectory simulation tree in the background, selects the globally optimal " +
      "first action via backward value propagation, avoiding autoregressive greedy traps. " +
      "Returns the optimal first action to execute immediately.",
    inputSchema: {
      type: "object",
      properties: {
        taskDescription: {
          type: "string",
          description: "Full task objective description (used to guide the LLM simulator)",
        },
        currentStateDescription: {
          type: "string",
          description:
            "Description of current state (including completed steps, available tools, constraints, etc.)",
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
        "[CognitiveDualEngine] Starting FLARE planning",
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

        api.logger.info("[CognitiveDualEngine] FLARE planning completed", {
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
              "Lookahead planning complete. Execute the next step strictly according to bestFirstAction, " +
              "then wait for tool results before calling cognitive_assess to decide whether re-planning is needed.",
          }),
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        api.logger.error("[CognitiveDualEngine] FLARE planning failed", { errMsg });
        return {
          content: JSON.stringify({
            status: "FLARE_PLAN_FAILED",
            error: errMsg,
            fallback: "FLARE planning failed, falling back to System 1 direct response.",
          }),
          isError: true,
        };
      }
    },
  };
}