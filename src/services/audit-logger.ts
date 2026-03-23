'use strict';
const { createLogger } = require('./logger');
const log = createLogger('AuditLogger');

/**
 * 审计日志服务
 * @alpha: 基于 SQLite 的持久化存储 — 替代 JSONL 文件追加
 *
 * 委托 NodeStore 进行 INSERT/SELECT/DELETE。
 * 自动按条数限制清理（超过 maxEntries 删除最旧记录）。
 */
class AuditLogger {
  _store: any;
  _maxEntries: number;

  constructor({ store, maxEntries = 100000 }: { store: any; maxEntries?: number }) {
    this._store = store;
    this._maxEntries = maxEntries;
  }

  /**
   * 记录审计事件
   * @param {string} action - 操作类型（如 'auth', 'approve', 'exec', 'config'）
   * @param {object} detail - 详细信息
   * @param {object} [req] - Express 请求对象（提取 IP）
   */
  log(action: any, detail = {}, req: any = null) {
    const actor = req
      ? (req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown')
      : 'system';

    try {
      this._store.insertAudit({
        ts: new Date().toISOString(),
        action,
        actor,
        detailJson: JSON.stringify(detail),
      });
      this._rotateIfNeeded();
    } catch (err: any) {
      log.error(`写入失败: ${err.message}`);
    }
  }

  /**
   * Express 中间件工厂 — 记录指定操作
   * @param {string} action
   * @returns {Function}
   */
  middleware(action: any) {
    return (req: any, _res: any, next: any) => {
      this.log(action, {
        method: req.method,
        path: req.path,
        body: req.method !== 'GET' ? this._sanitizeBody(req.body) : undefined,
      }, req);
      next();
    };
  }

  /**
   * 查询审计日志（分页）
   * @param {{action?: string, page?: number, pageSize?: number}} opts
   */
  query({ action, page = 1, pageSize = 50 }: any = {}) {
    const offset = (Math.max(1, page) - 1) * pageSize;
    const rows = this._store.queryAuditLogs({ action, limit: pageSize, offset });
    // 解析 detail_json
    return rows.map((r: any) => ({
      ...r,
      detail: r.detail_json ? JSON.parse(r.detail_json) : {},
    }));
  }

  /** 审计日志总数 */
  count() {
    return this._store.auditCount();
  }

  /** @private 脱敏请求体 */
  _sanitizeBody(body: any) {
    if (!body || typeof body !== 'object') return body;
    const clone = { ...body };
    for (const key of ['password', 'token', 'passcode', 'privateKey', 'secret']) {
      if (clone[key]) clone[key] = '***';
    }
    return clone;
  }

  /** @private 条数限制 */
  _rotateIfNeeded() {
    const count = this._store.auditCount();
    if (count <= this._maxEntries) return;
    // 保留最新的 maxEntries 条，按 id 删除最旧的
    const excess = count - this._maxEntries;
    const boundary = this._store.db.prepare(
      'SELECT id FROM audit_logs ORDER BY id ASC LIMIT 1 OFFSET ?'
    ).get(excess);
    if (boundary) {
      this._store.db.prepare('DELETE FROM audit_logs WHERE id < ?').run(boundary.id);
    }
  }
}

module.exports = AuditLogger;
export {}; // CJS 模块标记
