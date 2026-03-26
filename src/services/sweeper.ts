'use strict';

/**
 * 数据清理模块 (Sweeper)
 *
 * 职责：定期清理过期的 audit_logs 和已完成的 agent_tasks。
 * 不持有独立定时器，由 MetricsStore._maintenance() 驱动。
 *
 * 保留策略：
 *   - audit_logs: 30 天（可配置）
 *   - agent_tasks（已完成）: 7 天（可配置）
 */

const { createLogger } = require('./logger');
const log = createLogger('Sweeper');

interface SweeperStore {
  deleteAuditBefore(ts: string): { changes: number };
  taskDeleteOldBefore(isoDate: string): { changes: number };
}

interface SweeperOptions {
  store: SweeperStore;
  auditRetentionDays?: number;
  taskRetentionDays?: number;
}

class Sweeper {
  private _store: SweeperStore;
  private _auditRetentionMs: number;
  private _taskRetentionMs: number;

  constructor(options: SweeperOptions) {
    this._store = options.store;
    this._auditRetentionMs = (options.auditRetentionDays ?? 30) * 24 * 3600 * 1000;
    this._taskRetentionMs = (options.taskRetentionDays ?? 7) * 24 * 3600 * 1000;
  }

  /**
   * 执行一次清理
   * @returns {{ auditDeleted: number, taskDeleted: number }}
   */
  sweep(): { auditDeleted: number; taskDeleted: number } {
    const auditCutoff = new Date(Date.now() - this._auditRetentionMs).toISOString();
    const taskCutoff = new Date(Date.now() - this._taskRetentionMs).toISOString();

    const auditResult = this._store.deleteAuditBefore(auditCutoff);
    const taskResult = this._store.taskDeleteOldBefore(taskCutoff);

    const auditDeleted = auditResult?.changes ?? 0;
    const taskDeleted = taskResult?.changes ?? 0;

    if (auditDeleted > 0 || taskDeleted > 0) {
      log.info(`清理完成: audit_logs=${auditDeleted} agent_tasks=${taskDeleted}`);
    }

    return { auditDeleted, taskDeleted };
  }
}

module.exports = Sweeper;
export {}; // CJS 模块标记
