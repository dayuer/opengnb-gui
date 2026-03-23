'use strict';

/**
 * Agent 任务队列
 *
 * 从 GnbMonitor 中提炼的独立模块 — 管理技能安装/卸载等
 * Agent piggyback 任务的入队、出队、结果处理和查询。
 *
 * 职责单一：只做任务队列管理，不涉及节点监控。
 */

import type { AgentTask, TaskResult } from '../types/interfaces';

const EventEmitter = require('events');
const { createLogger } = require('./logger');
const log = createLogger('TaskQueue');

/** 入队请求 — 外部传入的最小字段集 */
interface EnqueueInput {
  taskId: string;
  type?: string;
  command?: string;
  skillId?: string;
  skillName?: string;
  timeoutMs?: number;
}

/** 下发给 Agent 的精简任务 */
interface DispatchedTask {
  taskId: string;
  type: string;
  command: string;
  timeoutMs: number;
}

/** 审计日志接口（仅用到 log 方法） */
interface IAuditLogger {
  log(action: string, details: Record<string, unknown>, req?: unknown): void;
}

class TaskQueue extends EventEmitter {
  private _store: { taskInsert: Function; taskPendingByNode: Function; taskMarkDispatched: Function; taskUpdateResult: Function; taskAllByNode: Function; taskFind: Function; taskDelete: Function } | null;
  private _audit: IAuditLogger | null;

  constructor(store: unknown, audit: unknown) {
    super();
    this._store = store as typeof this._store;
    this._audit = audit as IAuditLogger | null;
  }

  /**
   * 入队：写入 SQLite
   */
  enqueueTask(nodeId: string, task: EnqueueInput): Partial<AgentTask> {
    const row = {
      taskId: task.taskId,
      nodeId,
      type: task.type || 'skill_install',
      command: task.command || '',
      skillId: task.skillId || '',
      skillName: task.skillName || '',
      status: 'queued' as const,
      timeoutMs: task.timeoutMs || 60000,
      queuedAt: new Date().toISOString(),
    };

    if (!this._store) {
      log.warn('store 未注入，任务无法持久化');
      return row;
    }

    this._store.taskInsert(row);
    log.info(`任务入队 node=${nodeId} taskId=${task.taskId} type=${task.type} cmd=${task.command}`);
    this._audit?.log('task_enqueue', { nodeId, taskId: task.taskId, type: task.type, skillName: task.skillName, command: task.command });
    this.emit('taskQueued', { nodeId, task: row });
    return row;
  }

  /**
   * 出队：返回待执行任务并标记 dispatched
   */
  getPendingTasks(nodeId: string): DispatchedTask[] {
    if (!this._store) return [];
    const pending: AgentTask[] = this._store.taskPendingByNode(nodeId);
    const now = new Date().toISOString();
    for (const t of pending) {
      this._store.taskMarkDispatched(t.taskId, now);
      this._audit?.log('task_dispatch', { nodeId, taskId: t.taskId, type: t.type });
    }
    return pending.map((t) => ({
      taskId: t.taskId,
      type: t.type,
      command: t.command,
      timeoutMs: t.timeoutMs || 60000,
    }));
  }

  /**
   * 处理 agent 上报的任务执行结果
   */
  processTaskResults(nodeId: string, results: TaskResult[]) {
    if (!this._store) return;
    for (const result of results) {
      const status = result.code === 0 ? 'completed' : 'failed';
      this._store.taskUpdateResult({
        taskId: result.taskId,
        status,
        resultCode: result.code,
        resultStdout: (result.stdout || '').slice(0, 2000),
        resultStderr: (result.stderr || '').slice(0, 2000),
        completedAt: new Date().toISOString(),
      });
      log.info(`任务${status} node=${nodeId} taskId=${result.taskId} code=${result.code}`);
      this._audit?.log('task_result', {
        nodeId, taskId: result.taskId, status,
        code: result.code,
        stdout: (result.stdout || '').slice(0, 500),
        stderr: (result.stderr || '').slice(0, 500),
      });
      this.emit('taskCompleted', { nodeId, taskId: result.taskId, status });
    }
  }

  /**
   * 获取指定节点的任务列表（最新 50 条）
   */
  getNodeTasks(nodeId: string): Array<AgentTask & { result?: { code: number | null; stdout: string | null; stderr: string | null } }> {
    if (!this._store) return [];
    const rows: AgentTask[] = this._store.taskAllByNode(nodeId, 50);
    return rows.map((r) => ({
      ...r,
      result: r.resultCode != null ? {
        code: r.resultCode,
        stdout: r.resultStdout ?? null,
        stderr: r.resultStderr ?? null,
      } : undefined,
    }));
  }

  /**
   * 删除指定任务
   */
  deleteTask(taskId: string, req?: unknown): boolean {
    if (!this._store) return false;
    const task: AgentTask | undefined = this._store.taskFind(taskId);
    if (!task) return false;
    this._store.taskDelete(taskId);
    if (this._audit) {
      this._audit.log('task_delete', { taskId, nodeId: task.nodeId, type: task.type, skillName: task.skillName }, req);
    }
    return true;
  }
}

module.exports = TaskQueue;
export {};

