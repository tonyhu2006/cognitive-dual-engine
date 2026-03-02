/**
 * @file src/service.ts
 * @description CognitiveDualEngine background service
 *
 * Provides a complete OpenClaw registered service implementation:
 *   - Manages RollingPlanState session lifecycle
 *   - Provides health checks for in-memory state store
 *   - Cleans up all session states when Gateway stops
 *
 * OpenClaw service registration spec:
 *   Register via api.registerService({ id, start(), stop() }).
 *   Gateway automatically calls start()/stop() on startup/shutdown.
 */

import type { OpenClawPluginApi, OpenClawService } from "./types.js";
import {
    getRollingPlanState,
    clearRollingPlanState,
} from "./rolling-planner.js";

/** Track all active session keys (for batch cleanup in stop()) */
const activeSessions = new Set<string>();

/**
 * trackSession — Record an active session (called externally during cognitive_assess)
 */
export function trackSession(sessionKey: string): void {
    activeSessions.add(sessionKey);
}

/**
 * untrackSession — Remove session tracking
 */
export function untrackSession(sessionKey: string): void {
    activeSessions.delete(sessionKey);
}

/**
 * getActiveSessionCount — Get the current number of active sessions
 */
export function getActiveSessionCount(): number {
    return activeSessions.size;
}

/**
 * createStateManagerService — Create the rolling plan state manager OpenClaw service
 *
 * This service is responsible for:
 *   - start(): Initialize state management, log startup
 *   - stop(): Clean up all session RollingPlanStates to prevent memory leaks on exit
 *
 * @param api OpenClaw Plugin API (for logging)
 * @returns OpenClawService instance
 */
export function createStateManagerService(
    api: OpenClawPluginApi,
): OpenClawService {
    return {
        id: "cognitive-dual-engine-state-manager",

        start(): void {
            api.logger.info(
                "[CognitiveDualEngine] Rolling plan state manager started",
                { timestamp: new Date().toISOString() },
            );
        },

        stop(): void {
            const sessionCount = activeSessions.size;

            for (const sessionKey of activeSessions) {
                try {
                    clearRollingPlanState(sessionKey);
                } catch (err) {
                    api.logger.warn(
                        `[CognitiveDualEngine] Failed to clear state for session ${sessionKey}`,
                        err,
                    );
                }
            }

            activeSessions.clear();

            api.logger.info(
                "[CognitiveDualEngine] Rolling plan state manager stopped",
                {
                    clearedSessions: sessionCount,
                    timestamp: new Date().toISOString(),
                },
            );
        },
    };
}
