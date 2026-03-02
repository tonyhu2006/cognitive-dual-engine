/**
 * @file src/service.ts
 * @description CognitiveDualEngine 后台服务
 *
 * 提供 OpenClaw registered service 的完整实现：
 *   - 管理 RollingPlanState 的会话生命周期
 *   - 提供内存中状态存储的健康检查
 *   - 在 Gateway 停止时清理所有会话状态
 *
 * OpenClaw 服务注册规范：
 *   通过 api.registerService({ id, start(), stop() }) 注册，
 *   Gateway 在启动/停止时自动调用 start()/stop()。
 */

import type { OpenClawPluginApi, OpenClawService } from "./types.js";
import {
    getRollingPlanState,
    clearRollingPlanState,
} from "./rolling-planner.js";

/** 追踪所有活跃会话 key（用于 stop() 时批量清理） */
const activeSessions = new Set<string>();

/**
 * trackSession — 记录活跃会话（供外部模块在 cognitive_assess 时调用）
 */
export function trackSession(sessionKey: string): void {
    activeSessions.add(sessionKey);
}

/**
 * untrackSession — 移除会话追踪
 */
export function untrackSession(sessionKey: string): void {
    activeSessions.delete(sessionKey);
}

/**
 * getActiveSessionCount — 获取当前活跃会话数
 */
export function getActiveSessionCount(): number {
    return activeSessions.size;
}

/**
 * createStateManagerService — 创建滚动规划状态管理器 OpenClaw 服务
 *
 * 此服务负责：
 *   - start()：初始化状态管理，记录启动日志
 *   - stop()：清理所有会话的 RollingPlanState，防止进程退出时内存泄漏
 *
 * @param api OpenClaw Plugin API（用于日志输出）
 * @returns OpenClawService 实例
 */
export function createStateManagerService(
    api: OpenClawPluginApi,
): OpenClawService {
    return {
        id: "cognitive-dual-engine-state-manager",

        start(): void {
            api.logger.info(
                "[CognitiveDualEngine] 滚动规划状态管理器已启动",
                { timestamp: new Date().toISOString() },
            );
        },

        stop(): void {
            // 批量清理所有活跃会话的规划状态
            const sessionCount = activeSessions.size;

            for (const sessionKey of activeSessions) {
                try {
                    clearRollingPlanState(sessionKey);
                } catch (err) {
                    api.logger.warn(
                        `[CognitiveDualEngine] 清理会话 ${sessionKey} 状态失败`,
                        err,
                    );
                }
            }

            activeSessions.clear();

            api.logger.info(
                "[CognitiveDualEngine] 滚动规划状态管理器已停止",
                {
                    clearedSessions: sessionCount,
                    timestamp: new Date().toISOString(),
                },
            );
        },
    };
}
