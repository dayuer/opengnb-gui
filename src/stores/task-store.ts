'use strict';

/**
 * Agent 任务队列持久化 — NodeStore 的子模块
 *
 * 负责 agent_tasks 表的所有读写操作。
 * 状态流：queued → dispatched → completed / failed / timeout
 */

/** 准备 Task 相关的预编译语句 */
function prepareTaskStatements(db: any) {
  return {
    insertTask: db.prepare(
      `INSERT INTO agent_tasks (taskId, nodeId, type, command, skillId, skillName, status, timeoutMs, queuedAt)
       VALUES (@taskId, @nodeId, @type, @command, @skillId, @skillName, @status, @timeoutMs, @queuedAt)`
    ),
    findTask: db.prepare('SELECT * FROM agent_tasks WHERE taskId = ?'),
    pendingByNode: db.prepare(
      `SELECT * FROM agent_tasks WHERE nodeId = ? AND status = 'queued' ORDER BY queuedAt ASC`
    ),
    allByNode: db.prepare(
      `SELECT * FROM agent_tasks WHERE nodeId = ? ORDER BY queuedAt DESC LIMIT ?`
    ),
    updateDispatched: db.prepare(
      `UPDATE agent_tasks SET status = 'dispatched', dispatchedAt = @dispatchedAt WHERE taskId = @taskId`
    ),
    updateResult: db.prepare(
      `UPDATE agent_tasks SET status = @status, resultCode = @resultCode,
       resultStdout = @resultStdout, resultStderr = @resultStderr,
       completedAt = @completedAt WHERE taskId = @taskId`
    ),
    deleteOld: db.prepare(
      `DELETE FROM agent_tasks WHERE completedAt IS NOT NULL AND completedAt < ?`
    ),
    deleteById: db.prepare('DELETE FROM agent_tasks WHERE taskId = ?'),
    findStaleDispatched: db.prepare(
      `SELECT * FROM agent_tasks WHERE status = 'dispatched' AND dispatchedAt < ?`
    ),
  };
}

/** 混入 NodeStore 的方法：任务队列 CRUD */
const taskMethods = {
  // 入队
  taskInsert(task: any) {
    return this._stmts.insertTask.run(task);
  },
  // 查单个
  taskFind(taskId: string) {
    return this._stmts.findTask.get(taskId);
  },
  // 待下发（queued）
  taskPendingByNode(nodeId: string) {
    return this._stmts.pendingByNode.all(nodeId);
  },
  // 某节点所有任务（最新 50 条）
  taskAllByNode(nodeId: string, limit = 50) {
    return this._stmts.allByNode.all(nodeId, limit);
  },
  // 标记已下发
  taskMarkDispatched(taskId: string, dispatchedAt: string) {
    return this._stmts.updateDispatched.run({ taskId, dispatchedAt });
  },
  // 更新执行结果
  taskUpdateResult(params: any) {
    return this._stmts.updateResult.run(params);
  },
  // 清理旧任务（已完成超过 N 天）
  taskDeleteOldBefore(isoDate: string) {
    return this._stmts.deleteOld.run(isoDate);
  },
  // 删除单条任务
  taskDelete(taskId: string) {
    return this._stmts.deleteById.run(taskId);
  },
  // 查找超期未完成的 dispatched 任务（孤儿检测）
  taskFindStaleDispatched(cutoff: string) {
    return this._stmts.findStaleDispatched.all(cutoff);
  },
};

module.exports = { prepareTaskStatements, taskMethods };
export {}; // CJS 模块标记
