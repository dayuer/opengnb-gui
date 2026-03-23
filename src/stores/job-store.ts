'use strict';

/**
 * 异步 Job 读写 — NodeStore 的子模块
 *
 * 负责 jobs 表的所有读写操作。
 */

/** 准备 Job 相关的预编译语句 */
function prepareJobStatements(db: any) {
  return {
    insertJob: db.prepare(
      `INSERT INTO jobs (id, nodeId, command, status, createdAt)
       VALUES (@id, @nodeId, @command, @status, @createdAt)`
    ),
    findJob: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    updateJobResult: db.prepare(
      `UPDATE jobs SET status = @status, exitCode = @exitCode,
       stdout = @stdout, stderr = @stderr, error = @error,
       completedAt = @completedAt WHERE id = @id`
    ),
    jobsByNode: db.prepare(
      'SELECT * FROM jobs WHERE nodeId = ? ORDER BY createdAt DESC LIMIT ?'
    ),
    recentJobs: db.prepare(
      'SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?'
    ),
    deleteJobsBefore: db.prepare('DELETE FROM jobs WHERE createdAt < ?'),
  };
}

module.exports = { prepareJobStatements };
export {}; // CJS 模块标记
