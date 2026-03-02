/**
 * @file src/hooks/persist.hook.ts
 * @description tool_result_persist hook handler
 *
 * This hook fires before each tool execution result is written to the
 * session transcript. It performs the core "Limited Commitment" operation
 * from the FLARE paper:
 *   1. Receives actual environment feedback (tool execution result)
 *   2. Force-clears all "uncommitted hypotheses" from the previous planning round
 *   3. Invalidates the old search tree to ensure fresh re-planning
 *
 * Semantic mapping:
 *   Design doc's afterActionExecution → this hook
 *   - tool_result_persist fires synchronously before result persistence
 *   - event.sessionKey provides the session identifier
 *   - event.result can be modified (this plugin reads only, does not modify)
 *
 * Academic basis:
 *   FLARE paper §3.3 "Limited Commitment via Receding-Horizon Planning"
 *   - "Limited commitment discards all hypotheses beyond the committed action,
 *      regardless of their apparent quality."
 *   - This mechanism is mathematically robust to early estimation errors
 */

import type { ToolResultPersistEvent } from "../types.js";
import { onToolResultReceived } from "../rolling-planner.js";

/**
 * persistHookHandler — tool_result_persist event handler
 *
 * Fires after each tool execution, before the result is persisted to session log.
 * Performs Limited Commitment state cleanup:
 *   - Records tool result as latest environment observation (latestObservation)
 *   - Force-clears all uncommitted hypotheses (uncommittedHypotheses)
 *   - Invalidates old search tree (previousSearchTree → null)
 *
 * @param event tool_result_persist event object
 * @returns undefined (does not modify tool result content)
 */
export function persistHookHandler(
    event: ToolResultPersistEvent,
): undefined {
    // Extract tool execution result content
    const resultContent =
        typeof event.result.content === "string"
            ? event.result.content
            : JSON.stringify(event.result.content);

    // Execute Limited Commitment cleanup:
    // 1. Update latest environment observation
    // 2. Force-clear uncommitted hypotheses
    // 3. Invalidate old search tree
    const { clearedHypothesesCount } = onToolResultReceived(
        event.sessionKey,
        resultContent,
        event.toolName,
    );

    if (clearedHypothesesCount > 0) {
        console.info(
            `[CognitiveDualEngine] Limited Commitment: cleared ${clearedHypothesesCount} uncommitted hypotheses`,
        );
    }

    // Return undefined — do not modify tool result content
    // Only perform internal state updates (rolling plan state cleanup)
    return undefined;
}

export default persistHookHandler;
