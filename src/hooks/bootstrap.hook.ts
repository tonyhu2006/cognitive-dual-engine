/**
 * @file src/hooks/bootstrap.hook.ts
 * @description agent:bootstrap hook handler
 *
 * This hook fires when an Agent session initializes, injecting cognitive
 * routing instructions into the Agent's bootstrap context. This forces
 * the Agent to call cognitive_assess before planning any actions.
 *
 * OpenClaw event system:
 *   event.type === "agent" && event.action === "bootstrap"
 *   Fires on Agent session startup (user's first message or /new command).
 *   By pushing .md files into event.context.bootstrapFiles,
 *   custom instructions are added to the Agent's system prompt.
 *
 * Semantic mapping:
 *   Design doc's beforeTaskPlanning (injection phase) → this hook
 *   - Does not intercept action generation directly; instead uses prompt
 *     engineering to constrain the Agent to follow the cognitive routing flow
 */

import type { OpenClawHookEvent } from "../types.js";

/**
 * Cognitive routing instructions injected into the Agent's bootstrap context.
 *
 * This instruction file is injected by OpenClaw as a SKILL.md-type file into
 * the Agent conversation's system prompt, ensuring the Agent follows the
 * specified workflow whenever it receives a user request.
 */
const COGNITIVE_ROUTING_SKILL = `## [MANDATORY] Cognitive Routing Protocol

You have the "Cognitive Dual Engine" routing plugin loaded. You MUST strictly follow this protocol for ALL tasks:

### Required Workflow

1. **Step 1: Meta-cognitive Assessment (MANDATORY)**
   Upon receiving ANY user request, **first** call the \`cognitive_assess\` tool:
   - Input \`userRequest\`: the user's raw request text
   - Input \`conversationContext\`: recent conversation context summary (last 3-5 turns)

2. **Step 2: Routing Decision**
   Based on the \`tag\` field returned by \`cognitive_assess\`:

   - **SYSTEM_1_INTUITION** (System 1 · Intuition path):
     Complexity is low — analyze and respond directly without additional planning.
     Complete the task using your own reasoning capabilities.

   - **SYSTEM_2_FLARE** (System 2 · Lookahead planning path):
     Complexity is high — you **MUST** then call the \`flare_plan\` tool for lookahead planning:
     - Input \`taskDescription\`: full description of the task objective
     - Input \`currentStateDescription\`: description of current state
     - Execute strictly the first action from the returned \`bestFirstAction\`

3. **Step 3: Rolling Re-planning**
   After each tool action execution:
   - If the task is not yet complete, call \`cognitive_assess\` again to re-evaluate
   - Based on the new assessment, decide whether to proceed directly or call \`flare_plan\` again
   - Each step re-plans from the latest real state — never rely on stale hypotheses

### Violation Warning
Skipping \`cognitive_assess\` and acting directly will cause systematic "greedy myopia errors"
(step-wise greedy policy failure) — you may drift further down a locally plausible path
while the globally optimal solution requires different early-stage choices.
`;

/**
 * bootstrapHookHandler — agent:bootstrap event handler
 *
 * @param event OpenClaw hook event object
 */
export async function bootstrapHookHandler(
    event: OpenClawHookEvent,
): Promise<void> {
    // Only handle agent:bootstrap events
    if (event.type !== "agent" || event.action !== "bootstrap") {
        return;
    }

    // Initialize bootstrapFiles array if it doesn't exist
    if (!event.context.bootstrapFiles) {
        event.context.bootstrapFiles = [];
    }

    // Inject cognitive routing instructions into Agent system prompt
    event.context.bootstrapFiles.push({
        path: "COGNITIVE_ROUTING.md",
        content: COGNITIVE_ROUTING_SKILL,
    });
}

export default bootstrapHookHandler;
