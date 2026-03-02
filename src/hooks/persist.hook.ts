/**
 * @file src/hooks/persist.hook.ts
 * @description tool_result_persist 钩子处理器
 *
 * 此钩子在每次工具执行结果被写入 session transcript 之前触发。
 * 用于执行 FLARE 论文中「有限承诺 (Limited Commitment)」的核心操作：
 *   1. 接收实际环境反馈（工具执行结果）
 *   2. 强制清空上一轮规划中的所有「未提交假设」
 *   3. 失效旧搜索树，确保下轮规划基于真实状态
 *
 * 语义映射：
 *   设计文档中的 afterActionExecution → 本钩子
 *   - tool_result_persist 在工具结果持久化前同步触发
 *   - 可读取 event.sessionKey 获取会话标识
 *   - 可修改 event.result 内容（本插件不修改，仅读取用于更新内部状态）
 *
 * 学术依据：
 *   FLARE 论文 §3.3 "Limited Commitment via Receding-Horizon Planning"
 *   - "Limited commitment discards all hypotheses beyond the committed action,
 *      regardless of their apparent quality."
 *   - 此机制对早期估计误差具有数学意义上的鲁棒性
 */

import type { ToolResultPersistEvent } from "../types.js";
import { onToolResultReceived } from "../rolling-planner.js";

/**
 * persistHookHandler — tool_result_persist 事件处理器
 *
 * 每次工具执行完成、结果即将写入会话记录时触发。
 * 执行 Limited Commitment 状态清理：
 *   - 将工具结果记录为最新环境观测 (latestObservation)
 *   - 强制清空所有未提交假设 (uncommittedHypotheses)
 *   - 失效旧搜索树 (previousSearchTree → null)
 *
 * @param event tool_result_persist 事件对象
 * @returns undefined（不修改工具执行结果内容）
 */
export function persistHookHandler(
    event: ToolResultPersistEvent,
): undefined {
    // 提取工具执行结果内容
    const resultContent =
        typeof event.result.content === "string"
            ? event.result.content
            : JSON.stringify(event.result.content);

    // 执行有限承诺清理：
    // 1. 更新最新环境观测
    // 2. 强制清空未提交假设
    // 3. 失效旧搜索树
    const { clearedHypothesesCount } = onToolResultReceived(
        event.sessionKey,
        resultContent,
        event.toolName,
    );

    if (clearedHypothesesCount > 0) {
        // 使用 console.info 而非 api.logger，因为 Hook handler 不直接接收 api 对象
        // 在 OpenClaw 的 Hook 执行环境中，console 输出会被 Gateway 捕获并路由到日志系统
        console.info(
            `[CognitiveDualEngine] Limited Commitment: 清理了 ${clearedHypothesesCount} 个未提交假设`,
        );
    }

    // 返回 undefined 表示不修改工具结果内容
    // 仅执行内部状态更新（滚动规划状态清理）
    return undefined;
}

export default persistHookHandler;
