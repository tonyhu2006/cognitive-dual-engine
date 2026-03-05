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
import { createStateManagerService, getActiveSessions, getActiveSessionCount } from "./src/service.js";
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
    api.registerHook("agent:bootstrap", bootstrapHookHandler, { name: "cognitive-dual-engine:bootstrap" });
    api.logger.info("[CognitiveDualEngine] ✓ Hook registered: agent:bootstrap");

    api.registerHook("tool_result_persist", persistHookHandler, { name: "cognitive-dual-engine:persist" });
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
    handler() {
      const sessions = getActiveSessions();
      const sessionCount = getActiveSessionCount();

      if (sessionCount === 0) {
        return {
          text:
            "🧠 Cognitive Dual Engine Status: No active sessions\n" +
            "Send a message to trigger cognitive_assess, then retry.",
        };
      }

      const lines: string[] = [
        `🧠 **Cognitive Dual Engine Status**`,
        `Active sessions: ${sessionCount}`,
        `Config: threshold=${cfg.system2Threshold} | depth=${cfg.flareMaxDepth} | branch=${cfg.flareBranchFactor}`,
        ``,
      ];

      for (const sessionKey of sessions) {
        const state = getRollingPlanState(sessionKey);
        if (!state) continue;

        const meta = state.lastCognitiveMetadata;
        const tag = meta?.tag === "SYSTEM_2_FLARE"
          ? "⚡ System 2 (FLARE)"
          : "💨 System 1 (Intuition)";

        lines.push(
          `--- Session: ${sessionKey} ---`,
          `Route: ${tag}`,
          `Score: ${meta?.complexity.score.toFixed(3) ?? "N/A"} | Confidence: ${meta?.complexity.confidence.toFixed(2) ?? "N/A"}`,
          `Steps: ${state.stepCount} | Hypotheses: ${state.uncommittedHypotheses.length}`,
          `Observation: ${state.latestObservation.slice(0, 80) || "None"}`,
          ``,
        );
      }

      return { text: lines.join("\n") };
    },
  });

  // ================================================================
  // 6. Register tuning command: /cogtune
  //    Adjust FLARE engine parameters at runtime
  // ================================================================
  api.registerCommand({
    name: "cogtune",
    description: "Adjust cognitive engine parameters at runtime (threshold, depth, branch, simulations, or apply a preset)",
    acceptsArgs: true,
    requireAuth: true,
    handler(ctx) {
      const raw = (ctx.args ?? "").trim();

      // --- No args: show current config + estimated LLM calls ---
      if (!raw) {
        const est = estimateLLMCalls(cfg);
        return {
          text:
            `⚙️ **Cognitive Dual Engine — Current Configuration**\n` +
            `\n` +
            `| Parameter | Value |\n` +
            `|-----------|-------|\n` +
            `| system2Threshold | ${cfg.system2Threshold} |\n` +
            `| flareMaxDepth | ${cfg.flareMaxDepth} |\n` +
            `| flareBranchFactor | ${cfg.flareBranchFactor} |\n` +
            `| flareSimulationsPerNode | ${cfg.flareSimulationsPerNode} |\n` +
            `\n` +
            `📊 Estimated LLM calls per FLARE invocation: **~${est}**\n` +
            `\n` +
            `Usage:\n` +
            `  /cogtune threshold 0.75\n` +
            `  /cogtune depth 2\n` +
            `  /cogtune branch 2\n` +
            `  /cogtune simulations 1\n` +
            `  /cogtune preset minimal|balanced|thorough\n` +
            `  /cogtune reset`,
        };
      }

      const parts = raw.split(/\s+/);
      const subcommand = parts[0].toLowerCase();
      const value = parts[1];

      // --- Presets ---
      if (subcommand === "preset") {
        const presets: Record<string, Partial<CognitiveDualEngineConfig>> = {
          minimal: { system2Threshold: 0.80, flareMaxDepth: 1, flareBranchFactor: 2, flareSimulationsPerNode: 1 },
          balanced: { system2Threshold: 0.55, flareMaxDepth: 2, flareBranchFactor: 2, flareSimulationsPerNode: 1 },
          thorough: { system2Threshold: 0.40, flareMaxDepth: 3, flareBranchFactor: 3, flareSimulationsPerNode: 2 },
        };
        const presetName = (value ?? "").toLowerCase();
        const preset = presets[presetName];
        if (!preset) {
          return { text: `❌ Unknown preset "${value}". Available: minimal, balanced, thorough` };
        }
        Object.assign(cfg, preset);
        const est = estimateLLMCalls(cfg);
        return {
          text:
            `✅ Applied preset **${presetName}**\n` +
            `threshold=${cfg.system2Threshold} | depth=${cfg.flareMaxDepth} | branch=${cfg.flareBranchFactor} | sims=${cfg.flareSimulationsPerNode}\n` +
            `📊 Estimated LLM calls per FLARE: **~${est}**`,
        };
      }

      // --- Reset to defaults ---
      if (subcommand === "reset") {
        Object.assign(cfg, DEFAULT_CONFIG);
        const est = estimateLLMCalls(cfg);
        return {
          text:
            `🔄 Reset to defaults\n` +
            `threshold=${cfg.system2Threshold} | depth=${cfg.flareMaxDepth} | branch=${cfg.flareBranchFactor} | sims=${cfg.flareSimulationsPerNode}\n` +
            `📊 Estimated LLM calls per FLARE: **~${est}**`,
        };
      }

      // --- Set individual parameter ---
      const paramMap: Record<string, { key: keyof CognitiveDualEngineConfig; min: number; max: number; isFloat?: boolean }> = {
        threshold: { key: "system2Threshold", min: 0.1, max: 0.99, isFloat: true },
        depth: { key: "flareMaxDepth", min: 1, max: 5 },
        branch: { key: "flareBranchFactor", min: 1, max: 5 },
        simulations: { key: "flareSimulationsPerNode", min: 1, max: 5 },
        sims: { key: "flareSimulationsPerNode", min: 1, max: 5 },
      };

      const paramInfo = paramMap[subcommand];
      if (!paramInfo) {
        return { text: `❌ Unknown parameter "${subcommand}". Available: threshold, depth, branch, simulations, preset, reset` };
      }

      const num = paramInfo.isFloat ? parseFloat(value) : parseInt(value, 10);
      if (isNaN(num)) {
        return { text: `❌ Invalid value "${value}". Expected a number.` };
      }

      const clamped = Math.max(paramInfo.min, Math.min(paramInfo.max, num));
      (cfg as any)[paramInfo.key] = paramInfo.isFloat ? clamped : Math.round(clamped);

      const est = estimateLLMCalls(cfg);
      return {
        text:
          `✅ Set **${paramInfo.key}** = ${(cfg as any)[paramInfo.key]}` +
          (clamped !== num ? ` (clamped from ${num}, range: ${paramInfo.min}-${paramInfo.max})` : ``) +
          `\n📊 Estimated LLM calls per FLARE: **~${est}**`,
      };
    },
  });
  api.logger.info("[CognitiveDualEngine] ✓ Command registered: /cogtune");

  api.logger.info("[CognitiveDualEngine] ✓ Dual-engine cognitive routing plugin registered");
}

// ------------------------------------------------------------------
// Helper: estimate total LLM API calls per single flare_plan invocation
// ------------------------------------------------------------------
function estimateLLMCalls(cfg: CognitiveDualEngineConfig): number {
  const d = cfg.flareMaxDepth;
  const b = cfg.flareBranchFactor;
  const s = cfg.flareSimulationsPerNode;

  // Non-leaf nodes = sum of b^i for i=0..d-1
  let nonLeafNodes = 0;
  for (let i = 0; i < d; i++) nonLeafNodes += Math.pow(b, i);

  // Leaf nodes = b^d
  const leafNodes = Math.pow(b, d);

  // generateActionCandidates: 1 per non-leaf node
  const generateCalls = nonLeafNodes;
  // simulateStateTransition: b * s per non-leaf node
  const simCalls = nonLeafNodes * b * s;
  // evaluateTerminalValue: 1 per leaf node
  const evalCalls = leafNodes;

  return generateCalls + simCalls + evalCalls;
}