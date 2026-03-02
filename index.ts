/**
 * @file index.ts
 * @description CognitiveDualEngine 插件入口
 *
 * OpenClaw 插件注册规范（来自官方文档 docs.openclaw.ai/tools/plugin）：
 *   插件导出一个函数 `(api) => void` 或对象 `{ id, register(api) {} }`
 *   api.registerTool()     注册 Agent 可调用工具
 *   api.registerService()  注册后台服务
 *   api.registerCommand()  注册斜杠命令
 *   registerPluginHooksFromDir() 注册 Hook 处理器
 *
 * 本插件实现「beforeTaskPlanning / onActionGeneration / afterActionExecution」
 * 三个语义阶段的方式：
 *
 *   语义阶段                   OpenClaw 实现载体
 *   ─────────────────────────────────────────────────
 *   beforeTaskPlanning    →  cognitive_assess tool
 *                            + agent:bootstrap 钩子注入 SKILL.md 指令
 *   onActionGeneration    →  flare_plan tool
 *                            (SYSTEM_1 分支直接放行，SYSTEM_2 调用此工具)
 *   afterActionExecution  →  tool_result_persist 钩子
 *                            (执行 Limited Commitment 状态清理)
 */

import type {
  OpenClawPluginApi,
  CognitiveDualEngineConfig,
} from "./src/types.js";
import { createCognitiveAssessTool, createFlarePlanTool } from "./src/tools.js";
import { getRollingPlanState } from "./src/rolling-planner.js";
import { createStateManagerService } from "./src/service.js";
import { bootstrapHookHandler } from "./src/hooks/bootstrap.hook.js";
import { persistHookHandler } from "./src/hooks/persist.hook.js";

// ------------------------------------------------------------------
// 默认配置（若 openclaw.plugin.json 未提供，则使用此值）
// ------------------------------------------------------------------
const DEFAULT_CONFIG: CognitiveDualEngineConfig = {
  system2Threshold: 0.55,
  flareMaxDepth: 3,
  flareBranchFactor: 3,
  flareSimulationsPerNode: 2,
  enabled: true,
};

// ------------------------------------------------------------------
// 插件注册主函数（符合 OpenClaw 官方 Plugin API 规范）
// ------------------------------------------------------------------
export default function register(api: OpenClawPluginApi): void {
  // 读取并合并插件配置
  const rawCfg = (api.config as Partial<CognitiveDualEngineConfig>) ?? {};
  const cfg: CognitiveDualEngineConfig = {
    ...DEFAULT_CONFIG,
    ...rawCfg,
  };

  if (!cfg.enabled) {
    api.logger.info("[CognitiveDualEngine] 插件已禁用，跳过注册");
    return;
  }

  api.logger.info("[CognitiveDualEngine] 初始化双引擎认知路由插件", {
    system2Threshold: cfg.system2Threshold,
    flareMaxDepth: cfg.flareMaxDepth,
    flareBranchFactor: cfg.flareBranchFactor,
  });

  // ================================================================
  // 1. 注册 Agent Tool：cognitive_assess
  //    语义对应：beforeTaskPlanning（元认知计算 + 复杂度评分 + 路由标签）
  // ================================================================
  api.registerTool(createCognitiveAssessTool(cfg));
  api.logger.info("[CognitiveDualEngine] ✓ 注册工具: cognitive_assess");

  // ================================================================
  // 2. 注册 Agent Tool：flare_plan
  //    语义对应：onActionGeneration 的 SYSTEM_2 分支
  //              （显式前瞻 + 反向价值传播 + 有限承诺）
  // ================================================================
  api.registerTool(createFlarePlanTool(api, cfg));
  api.logger.info("[CognitiveDualEngine] ✓ 注册工具: flare_plan");

  // ================================================================
  // 3. 注册后台服务：状态管理器
  //    负责会话生命周期内的 RollingPlanState 维护
  //    启动时初始化，停止时批量清理所有会话状态
  // ================================================================
  api.registerService(createStateManagerService(api));
  api.logger.info("[CognitiveDualEngine] ✓ 注册服务: state-manager");

  // ================================================================
  // 4. 注册钩子（通过 OpenClaw 真实 Hook 系统）
  //
  //    两个钩子对应三个语义阶段中的两个：
  //    - agent:bootstrap       → beforeTaskPlanning（注入阶段）
  //    - tool_result_persist   → afterActionExecution（状态清理）
  //
  //    实现文件分别位于：
  //    - src/hooks/bootstrap.hook.ts
  //    - src/hooks/persist.hook.ts
  //
  //    注册方式：在 OpenClaw 中，钩子可通过 api.registerHook 注册，
  //    或通过 registerPluginHooksFromDir("./hooks/") 自动扫描注册。
  //    此处采用显式注册以确保参数控制：
  // ================================================================

  // Hook A: agent:bootstrap — 注入认知路由指令到 Agent 系统提示
  if (typeof api.registerHook === "function") {
    api.registerHook("agent:bootstrap", bootstrapHookHandler);
    api.logger.info("[CognitiveDualEngine] ✓ 注册钩子: agent:bootstrap");

    api.registerHook("tool_result_persist", persistHookHandler);
    api.logger.info("[CognitiveDualEngine] ✓ 注册钩子: tool_result_persist");
  } else {
    // 降级方案：如果 api.registerHook 不可用（老版本 OpenClaw），
    // 在日志中提示用户改用 registerPluginHooksFromDir
    api.logger.warn(
      "[CognitiveDualEngine] api.registerHook 不可用，" +
      "请确保 OpenClaw 版本 ≥ 2025.0.0，或使用 registerPluginHooksFromDir('./hooks') 注册钩子。",
    );
  }

  // ================================================================
  // 5. 注册管理命令 /cogstatus
  //    用于查看当前会话的认知路由状态
  // ================================================================
  api.registerCommand({
    name: "cogstatus",
    description: "查看当前会话的认知路由状态（元认知评分 + 规划步数）",
    acceptsArgs: false,
    requireAuth: true,
    handler(ctx) {
      const sessionKey = (ctx as Record<string, unknown>).sessionKey as string ?? "unknown";
      const state = getRollingPlanState(sessionKey);

      if (!state) {
        return {
          text:
            "🧠 认知双引擎状态：会话未初始化\n" +
            "请发送任意消息触发 agent:bootstrap 后重试。",
        };
      }

      const meta = state.lastCognitiveMetadata;
      const tagEmoji =
        meta?.tag === "SYSTEM_2_FLARE" ? "⚡ 系统2(FLARE)" : "💨 系统1(直觉)";

      return {
        text:
          `🧠 **认知双引擎状态**\n` +
          `会话: ${sessionKey}\n` +
          `当前路由: ${tagEmoji}\n` +
          `复杂度分: ${meta?.complexity.score.toFixed(3) ?? "未评估"}\n` +
          `置信度: ${meta?.complexity.confidence.toFixed(2) ?? "N/A"}\n` +
          `规划步数: ${state.stepCount}\n` +
          `未提交假设数: ${state.uncommittedHypotheses.length}\n` +
          `最新观测: ${state.latestObservation.slice(0, 80) || "无"}\n` +
          `\n触发阈值: ${cfg.system2Threshold} | FLARE深度: ${cfg.flareMaxDepth} | 分支因子: ${cfg.flareBranchFactor}`,
      };
    },
  });

  api.logger.info("[CognitiveDualEngine] ✓ 双引擎认知路由插件注册完成");
}