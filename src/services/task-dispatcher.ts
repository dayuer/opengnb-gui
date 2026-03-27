'use strict';

/**
 * task-dispatcher.ts — 任务类型 → Daemon WS 消息 策略映射表
 *
 * 设计模式：Strategy Pattern
 *
 * 核心问题：Console 的 TaskQueue 将任务写入 SQLite 后通过 emit('taskQueued')
 * 通知订阅方。ws-handler 调用本模块将 task.type 翻译为 daemon 理解的 WS 结构体，
 * 避免路由层拼接 shell 命令。
 *
 * daemon 端已原生实现的处理器：
 *   - skill_install   → skills_manager::install()
 *   - skill_uninstall  → skills_manager::uninstall()
 *   - claw_restart     → claw_manager::restart()
 *   - claw_upgrade     → claw_manager::upgrade()
 *   - exec_cmd         → exec_handler::exec_allowed()（白名单校验）
 */

const crypto = require('crypto');

/** 任务上下文（从 TaskQueue 获取） */
interface TaskContext {
  taskId: string;
  type: string;
  command?: string;
  skillId?: string;
  skillName?: string;
  nodeId?: string;
  version?: string;
  [key: string]: unknown;
}

/** 发往 daemon 的 WS 消息 */
interface WsMessage {
  type: string;
  reqId: string;
  [key: string]: unknown;
}

/** 策略函数签名 */
type DispatchStrategy = (task: TaskContext, reqId: string) => WsMessage;

// ═══════════════════════════════════════
// 策略注册表
// ═══════════════════════════════════════

const STRATEGIES: Record<string, DispatchStrategy> = {
  skill_install: (task, reqId) => ({
    type: 'skill_install',
    reqId,
    skillId: task.skillId || '',
  }),

  skill_uninstall: (task, reqId) => ({
    type: 'skill_uninstall',
    reqId,
    skillId: task.skillId || '',
  }),

  claw_restart: (_task, reqId) => ({
    type: 'claw_restart',
    reqId,
  }),

  claw_upgrade: (task, reqId) => ({
    type: 'claw_upgrade',
    reqId,
    version: task.version || undefined,
  }),
};

/** 降级策略：未知 type → exec_cmd（走 daemon 白名单） */
const FALLBACK: DispatchStrategy = (task, reqId) => ({
  type: 'exec_cmd',
  reqId,
  command: task.command || '',
});

// ═══════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════

/**
 * 将 TaskQueue 任务翻译为 daemon WS 消息
 *
 * @param task - TaskQueue 中的任务对象
 * @returns daemon 可理解的 WS 消息结构体
 */
function buildWsMessage(task: TaskContext): WsMessage {
  const reqId = `task-${task.taskId}-${crypto.randomUUID().slice(0, 8)}`;
  const strategy = STRATEGIES[task.type] || FALLBACK;
  return strategy(task, reqId);
}

/**
 * 分发任务到指定 daemon
 *
 * @param task     - 含 nodeId 的完整任务对象
 * @param sendFn   - ws-handler 提供的 sendToDaemon 函数
 * @returns daemon 的响应
 */
async function dispatchTask(
  task: TaskContext,
  sendFn: (nodeId: string, msg: Record<string, unknown>) => Promise<unknown>,
): Promise<unknown> {
  const msg = buildWsMessage(task);
  return sendFn(task.nodeId || '', msg);
}

module.exports = { buildWsMessage, dispatchTask, STRATEGIES };
export {};
