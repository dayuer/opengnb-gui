'use strict';

/**
 * 审计日志读写 — NodeStore 的子模块
 *
 * 负责 audit_logs 表的所有读写操作。
 */

/** 准备审计相关的预编译语句 */
function prepareAuditStatements(db: any) {
  return {
    insertAudit: db.prepare(
      'INSERT INTO audit_logs (ts, action, actor, detail_json) VALUES (@ts, @action, @actor, @detailJson)'
    ),
    auditCount: db.prepare('SELECT COUNT(*) AS cnt FROM audit_logs'),
    deleteAuditBefore: db.prepare('DELETE FROM audit_logs WHERE ts < ?'),
    queryAudit: db.prepare(
      'SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?'
    ),
    queryAuditByAction: db.prepare(
      'SELECT * FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT ? OFFSET ?'
    ),
  };
}

/** 审计方法 mixin */
const auditMethods = {
  /** 插入审计日志 */
  insertAudit(this: any, { ts, action, actor, detailJson }: any) {
    this._stmts.insertAudit.run({ ts, action, actor, detailJson });
  },

  /** 查询审计日志（分页，可选 action 过滤） */
  queryAuditLogs(this: any, { action, limit = 50, offset = 0 }: any = {}) {
    if (action) {
      return this._stmts.queryAuditByAction.all(action, limit, offset);
    }
    return this._stmts.queryAudit.all(limit, offset);
  },

  /** 审计日志总数 */
  auditCount(this: any) {
    return this._stmts.auditCount.get().cnt;
  },

  /** 删除早于指定时间的审计日志 */
  deleteAuditBefore(this: any, ts: any) {
    return this._stmts.deleteAuditBefore.run(ts);
  },
};

module.exports = { prepareAuditStatements, auditMethods };
export {}; // CJS 模块标记
