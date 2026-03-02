/**
 * @file src/hooks/bootstrap.hook.ts
 * @description agent:bootstrap 钩子处理器
 *
 * 此钩子在 Agent 会话初始化时触发，向 Agent 的 bootstrap 上下文
 * 注入认知路由指令，强制 Agent 在规划前先调用 cognitive_assess 工具。
 *
 * OpenClaw 事件系统说明：
 *   event.type === "agent" && event.action === "bootstrap"
 *   此事件在 Agent 会话启动时触发（用户首次发送消息或 /new 命令后）。
 *   通过向 event.context.bootstrapFiles 注入 .md 文件，
 *   可以在 Agent 的系统提示中添加自定义指令。
 *
 * 语义映射：
 *   设计文档中的 beforeTaskPlanning（注入阶段）→ 本钩子
 *   - 不直接拦截动作生成，而是通过 prompt engineering 强制 Agent 遵循认知路由流程
 *   - Agent 被 bootstrap 指令约束，无法绕过复杂度评估直接行动
 */

import type { OpenClawHookEvent } from "../types.js";

/**
 * 注入到 Agent bootstrap 上下文的认知路由指令
 *
 * 此指令文件会被 OpenClaw 作为 SKILL.md 类文件注入 Agent 对话的系统提示中，
 * 使 Agent 在每次收到用户请求时，必须按照指定流程行动。
 */
const COGNITIVE_ROUTING_SKILL = `## 【强制执行】认知路由规范 (Cognitive Routing Protocol)

你已装载「认知双引擎路由插件」，必须严格遵循以下协议处理所有任务：

### 规范流程

1. **步骤 1：元认知评估（必须）**
   收到任何用户请求后，**首先**调用 \`cognitive_assess\` 工具：
   - 输入参数 \`userRequest\`：用户的原始请求文本
   - 输入参数 \`conversationContext\`：近期对话上下文摘要（最近 3-5 轮）

2. **步骤 2：路由决策**
   根据 \`cognitive_assess\` 返回的 \`tag\` 字段决定后续行为：

   - **SYSTEM_1_INTUITION**（系统1·直觉路径）：
     复杂度低，可直接分析并响应，无需额外规划。
     直接按照自身推理能力完成任务。

   - **SYSTEM_2_FLARE**（系统2·前瞻规划路径）：
     复杂度高，**必须**接着调用 \`flare_plan\` 工具进行前瞻规划：
     - 输入 \`taskDescription\`：任务的完整目标描述
     - 输入 \`currentStateDescription\`：当前状态描述
     - 按照返回的 \`bestFirstAction\` 严格执行第一步动作

3. **步骤 3：滚动规划**
   每次执行工具动作后：
   - 如果任务尚未完成，重新调用 \`cognitive_assess\` 重新评估
   - 根据新评估结果决定是直接继续还是重新调用 \`flare_plan\`
   - 每一步都基于最新真实状态重新规划，不依赖过期假设

### 违规警告
跳过 \`cognitive_assess\` 直接行动，将导致系统性的「贪婪近视错误」
(step-wise greedy policy failure)——你可能在局部看似合理的路径上越走越远，
而全局最优解需要在早期做出不同的选择。
`;

/**
 * bootstrapHookHandler — agent:bootstrap 事件处理器
 *
 * @param event OpenClaw 钩子事件对象
 */
export async function bootstrapHookHandler(
    event: OpenClawHookEvent,
): Promise<void> {
    // 仅处理 agent:bootstrap 事件
    if (event.type !== "agent" || event.action !== "bootstrap") {
        return;
    }

    // 初始化 bootstrapFiles 数组（如不存在则创建）
    if (!event.context.bootstrapFiles) {
        event.context.bootstrapFiles = [];
    }

    // 注入认知路由指令到 Agent 系统提示
    event.context.bootstrapFiles.push({
        path: "COGNITIVE_ROUTING.md",
        content: COGNITIVE_ROUTING_SKILL,
    });
}

export default bootstrapHookHandler;
