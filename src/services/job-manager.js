'use strict';

const crypto = require('crypto');

/**
 * 异步 Job 管理器 — SQLite 持久化版
 *
 * 维护 SSH 异步命令的生命周期：
 *   dispatched → running → completed | failed | timeout
 *
 * 所有 job 持久化到 SQLite `jobs` 表，支持运维审计。
 *
 * @alpha: 核心服务
 */
class JobManager {
  /**
   * @param {object} options
   * @param {import('./node-store')} options.store - NodeStore 实例
   * @param {number} [options.timeoutMs=60000] - 默认超时
   * @param {Function} [options.onComplete] - job 完成回调（WS 推送用）
   */
  constructor(options = {}) {
    this.store = options.store;
    this.timeoutMs = options.timeoutMs || 60000;
    this.onComplete = options.onComplete || null;

    // @alpha: 定时检查超时 job（unref 避免阻止进程退出）
    this._cleanupTimer = setInterval(() => this._checkTimeouts(), 10000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * 创建新 job
   * @param {string} nodeId - 目标节点
   * @param {string} command - 原始命令
   * @returns {{jobId: string, job: object}}
   */
  create(nodeId, command) {
    const jobId = crypto.randomBytes(8).toString('hex');
    const now = new Date().toISOString();

    this.store._stmts.insertJob.run({
      id: jobId,
      nodeId,
      command,
      status: 'dispatched',
      createdAt: now,
    });

    const job = this.store._stmts.findJob.get(jobId);
    return { jobId, job };
  }

  /**
   * 标记 job 为 running（SSH 已投递）
   * @param {string} jobId
   */
  markRunning(jobId) {
    const job = this.store._stmts.findJob.get(jobId);
    if (job && job.status === 'dispatched') {
      this.store._stmts.updateJobResult.run({
        id: jobId,
        status: 'running',
        exitCode: null,
        stdout: null,
        stderr: null,
        error: null,
        completedAt: null,
      });
    }
  }

  /**
   * 接收 job 回调结果
   * @param {string} jobId
   * @param {object} result - {exitCode, stdout, stderr}
   * @returns {object|null}
   */
  complete(jobId, result) {
    const job = this.store._stmts.findJob.get(jobId);
    if (!job) return null;
    if (job.status === 'completed' || job.status === 'failed') return job;

    const status = result.exitCode === 0 ? 'completed' : 'failed';
    this.store._stmts.updateJobResult.run({
      id: jobId,
      status,
      exitCode: result.exitCode,
      stdout: (result.stdout || '').substring(0, 65536),
      stderr: (result.stderr || '').substring(0, 16384),
      error: null,
      completedAt: new Date().toISOString(),
    });

    const updated = this.store._stmts.findJob.get(jobId);
    if (this.onComplete) this.onComplete(updated);
    return updated;
  }

  /**
   * 标记 job 投递失败
   * @param {string} jobId
   * @param {string} error
   * @returns {object|null}
   */
  fail(jobId, error) {
    const job = this.store._stmts.findJob.get(jobId);
    if (!job) return null;

    this.store._stmts.updateJobResult.run({
      id: jobId,
      status: 'failed',
      exitCode: null,
      stdout: null,
      stderr: null,
      error: String(error).substring(0, 4096),
      completedAt: new Date().toISOString(),
    });

    const updated = this.store._stmts.findJob.get(jobId);
    if (this.onComplete) this.onComplete(updated);
    return updated;
  }

  /**
   * 查询 job
   * @param {string} jobId
   * @returns {object|null}
   */
  get(jobId) {
    return this.store._stmts.findJob.get(jobId) || null;
  }

  /**
   * 查询节点的 job 列表
   * @param {string} nodeId
   * @param {number} [limit=20]
   * @returns {object[]}
   */
  listByNode(nodeId, limit = 20) {
    return this.store._stmts.jobsByNode.all(nodeId, limit);
  }

  /**
   * 查询最近 job
   * @param {number} [limit=50]
   * @returns {object[]}
   */
  listRecent(limit = 50) {
    return this.store._stmts.recentJobs.all(limit);
  }

  /** @private 超时检查 */
  _checkTimeouts() {
    const cutoff = new Date(Date.now() - this.timeoutMs).toISOString();
    // 查找超时 job：状态为 dispatched/running 且创建时间早于 cutoff
    const pendingJobs = this.store.db.prepare(
      "SELECT * FROM jobs WHERE status IN ('dispatched', 'running') AND createdAt < ?"
    ).all(cutoff);

    for (const job of pendingJobs) {
      this.store._stmts.updateJobResult.run({
        id: job.id,
        status: 'timeout',
        exitCode: null,
        stdout: null,
        stderr: null,
        error: `超时 (${this.timeoutMs / 1000}s)`,
        completedAt: new Date().toISOString(),
      });
      const updated = this.store._stmts.findJob.get(job.id);
      if (this.onComplete) this.onComplete(updated);
    }
  }

  /** 清理 N 天前的 job 记录 */
  cleanBefore(daysAgo = 30) {
    const cutoff = new Date(Date.now() - daysAgo * 86400000).toISOString();
    return this.store._stmts.deleteJobsBefore.run(cutoff);
  }

  /** 清理资源 */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}

module.exports = JobManager;
