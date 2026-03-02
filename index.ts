/**
 * @file index.ts
 * @description CognitiveDualEngine plugin entry point
 *
 * OpenClaw plugin registration spec (per docs.openclaw.ai/tools/plugin):
 *   Plugin exports a function `(api) => void` or object `{ id, register(api) {} }`
 *   api.registerTool()     — register Agent-callable tools
 *   api.registerService()  — register background services
 *   api.registerCommand()  — register slash commands
 *   registerPluginHooksFromDir() — register hook handlers
 *
 * This plugin implements three semantic phases:
 *
 *   Semantic Phase              OpenClaw Implementation
 *   ─────────────────────────────────────────────────────
 *   beforeTaskPlanning    →  cognitive_assess tool
 *                            + agent:bootstrap hook (injects SKILL.md)
 *   onActionGeneration    →  flare_plan tool
 *                            (SYSTEM_1 fast path; SYSTEM_2 invokes this tool)
 *   afterActionExecution  →  tool_result_persist hook
 *                            (Limited Commitment state cleanup)
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
// Default config (used when openclaw.plugin.json provides no overrides)
// ------------------------------------------------------------------
const DEFAULT_CONFIG: CognitiveDualEngineConfig = {
  system2Threshold: 0.55,
  flareMaxDepth: 3,
  flareBranchFactor: 3,
  flareSimulationsPerNode: 2,
  enabled: true,
};

// ------------------------------------------------------------------
// Plugin registration entry (conforms to OpenClaw Plugin API spec)
// ------------------------------------------------------------------
export default function register(api: OpenClawPluginApi): void {
  // Merge user config with defaults
  const rawCfg = (api.config as Partial<CognitiveDualEngineConfig>) ?? {};
  const cfg: CognitiveDualEngineConfig = {
    ...DEFAULT_CONFIG,
    ...rawCfg,
  };

  if (!cfg.enabled) {
    api.logger.info("[CognitiveDualEngine] Plugin disabled, skipping registration");
    return;
  }

  api.logger.info("[CognitiveDualEngine] Initializing dual-engine cognitive routing plugin", {
    system2Threshold: cfg.system2Threshold,
    flareMaxDepth: cfg.flareMaxDepth,
    flareBranchFactor: cfg.flareBranchFactor,
  });

  // ================================================================
  // 1. Register Agent Tool: cognitive_assess
  //    Semantic mapping: beforeTaskPlanning (meta-cognition + scoring + routing)
  // ================================================================
  api.registerTool(createCognitiveAssessTool(cfg));
  api.logger.info("[CognitiveDualEngine] ✓ Tool registered: cognitive_assess");

  // ================================================================
  // 2. Register Agent Tool: flare_plan
  //    Semantic mapping: onActionGeneration SYSTEM_2 branch
  //    (explicit lookahead + backward value propagation + limited commitment)
  // ================================================================
  api.registerTool(createFlarePlanTool(api, cfg));
  api.logger.info("[CognitiveDualEngine] ✓ Tool registered: flare_plan");

  // ================================================================
  // 3. Register background service: state manager
  //    Manages RollingPlanState lifecycle across sessions
  // ================================================================
  api.registerService(createStateManagerService(api));
  api.logger.info("[CognitiveDualEngine] ✓ Service registered: state-manager");

  // ================================================================
  // 4. Register hooks (via OpenClaw Hook system)
  //
  //    Two hooks mapping to two semantic phases:
  //    - agent:bootstrap       → beforeTaskPlanning (injection phase)
  //    - tool_result_persist   → afterActionExecution (state cleanup)
  // ================================================================

  if (typeof api.registerHook === "function") {
    api.registerHook("agent:bootstrap", bootstrapHookHandler);
    api.logger.info("[CognitiveDualEngine] ✓ Hook registered: agent:bootstrap");

    api.registerHook("tool_result_persist", persistHookHandler);
    api.logger.info("[CognitiveDualEngine] ✓ Hook registered: tool_result_persist");
  } else {
    api.logger.warn(
      "[CognitiveDualEngine] api.registerHook unavailable. " +
      "Ensure OpenClaw version >= 2025.0.0, or use registerPluginHooksFromDir('./hooks').",
    );
  }

  // ================================================================
  // 5. Register management command: /cogstatus
  //    View current cognitive routing state for the session
  // ================================================================
  api.registerCommand({
    name: "cogstatus",
    description: "View current cognitive routing state (meta-cognition score + plan steps)",
    acceptsArgs: false,
    requireAuth: true,
    handler(ctx) {
      const sessionKey = (ctx as Record<string, unknown>).sessionKey as string ?? "unknown";
      const state = getRollingPlanState(sessionKey);

      if (!state) {
        return {
          text:
            "🧠 Cognitive Dual Engine Status: Session not initialized\n" +
            "Send any message to trigger agent:bootstrap, then retry.",
        };
      }

      const meta = state.lastCognitiveMetadata;
      const tagEmoji =
        meta?.tag === "SYSTEM_2_FLARE" ? "⚡ System 2 (FLARE)" : "💨 System 1 (Intuition)";

      return {
        text:
          `🧠 **Cognitive Dual Engine Status**\n` +
          `Session: ${sessionKey}\n` +
          `Current route: ${tagEmoji}\n` +
          `Complexity score: ${meta?.complexity.score.toFixed(3) ?? "Not assessed"}\n` +
          `Confidence: ${meta?.complexity.confidence.toFixed(2) ?? "N/A"}\n` +
          `Plan steps: ${state.stepCount}\n` +
          `Uncommitted hypotheses: ${state.uncommittedHypotheses.length}\n` +
          `Latest observation: ${state.latestObservation.slice(0, 80) || "None"}\n` +
          `\nThreshold: ${cfg.system2Threshold} | FLARE depth: ${cfg.flareMaxDepth} | Branch factor: ${cfg.flareBranchFactor}`,
      };
    },
  });

  api.logger.info("[CognitiveDualEngine] ✓ Dual-engine cognitive routing plugin registered");
}