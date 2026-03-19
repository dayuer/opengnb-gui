'use strict';

const fs = require('fs');
const path = require('path');
const { resolvePaths } = require('./data-paths');

/**
 * 审计日志服务
 *
 * JSONL 格式追加写入，记录所有敏感操作。
 * 自动按大小轮转（超过 10MB 归档）。
 */
class AuditLogger {
  /**
   * @param {object} options
   * @param {string} options.dataDir - 数据目录
   * @param {object} [options.paths] - data-paths 路径对象
   * @param {number} [options.maxSizeMB=10] - 单文件最大 MB
   */
  constructor({ dataDir, paths, maxSizeMB = 10 }) {
    // @alpha: 使用集中路径管理
    const p = paths || resolvePaths(dataDir);
    this.logPath = p.logs.auditLog;
    this.archiveDir = p.logs.auditArchive;
    this.maxSize = maxSizeMB * 1024 * 1024;

    try { fs.mkdirSync(this.archiveDir, { recursive: true }); } catch (_) {}
  }

  /**
   * 记录审计事件
   * @param {string} action - 操作类型（如 'auth', 'approve', 'exec', 'config'）
   * @param {object} detail - 详细信息
   * @param {object} [req] - Express 请求对象（提取 IP）
   */
  log(action, detail = {}, req = null) {
    const entry = {
      ts: new Date().toISOString(),
      action,
      actor: req
        ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown')
        : 'system',
      ...detail,
    };

    const line = JSON.stringify(entry) + '\n';

    try {
      fs.appendFileSync(this.logPath, line);
      this._rotateIfNeeded();
    } catch (err) {
      console.error(`[AuditLogger] 写入失败: ${err.message}`);
    }
  }

  /**
   * Express 中间件工厂 — 记录指定操作
   * @param {string} action
   * @returns {Function}
   */
  middleware(action) {
    return (req, _res, next) => {
      this.log(action, {
        method: req.method,
        path: req.path,
        body: req.method !== 'GET' ? this._sanitizeBody(req.body) : undefined,
      }, req);
      next();
    };
  }

  /** @private 脱敏请求体 */
  _sanitizeBody(body) {
    if (!body || typeof body !== 'object') return body;
    const clone = { ...body };
    // 脱敏可能的密码/Token 字段
    for (const key of ['password', 'token', 'passcode', 'privateKey', 'secret']) {
      if (clone[key]) clone[key] = '***';
    }
    return clone;
  }

  /** @private 日志轮转 */
  _rotateIfNeeded() {
    try {
      const stat = fs.statSync(this.logPath);
      if (stat.size < this.maxSize) return;

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = path.join(this.archiveDir, `audit_${ts}.log`);
      fs.renameSync(this.logPath, archivePath);
      console.log(`[AuditLogger] 日志已归档: ${archivePath}`);
    } catch (_) {}
  }
}

module.exports = AuditLogger;
