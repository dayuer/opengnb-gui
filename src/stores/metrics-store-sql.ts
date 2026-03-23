'use strict';

/**
 * 指标时序读写 — NodeStore 的子模块
 *
 * 负责 metrics 表的所有读写操作（记录、查询、降采样）。
 */

/** 准备指标相关的预编译语句 */
function prepareMetricsStatements(db: any) {
  return {
    recordMetric: db.prepare(`
      INSERT INTO metrics (nodeId, ts, cpu, memPct, diskPct, sshLatency, loadAvg, p2pDirect, p2pTotal, memTotalMB, memUsedMB)
      VALUES (@nodeId, @ts, @cpu, @memPct, @diskPct, @sshLatency, @loadAvg, @p2pDirect, @p2pTotal, @memTotalMB, @memUsedMB)
    `),
    queryMetrics: db.prepare('SELECT * FROM metrics WHERE nodeId = ? AND ts >= ? ORDER BY ts'),
    deleteMetricsBefore: db.prepare('DELETE FROM metrics WHERE ts < ?'),
    deleteNodeMetricsBefore: db.prepare('DELETE FROM metrics WHERE nodeId = ? AND ts < ?'),
    latestMetricPerNode: db.prepare(`
      SELECT m.* FROM metrics m
      INNER JOIN (SELECT nodeId, MAX(ts) AS maxTs FROM metrics GROUP BY nodeId) latest
      ON m.nodeId = latest.nodeId AND m.ts = latest.maxTs
    `),
    metricsCount: db.prepare('SELECT COUNT(*) AS cnt FROM metrics'),
    metricsCountByNode: db.prepare('SELECT COUNT(*) AS cnt FROM metrics WHERE nodeId = ?'),
    oldestMetrics: db.prepare('SELECT MIN(ts) AS oldest FROM metrics'),
  };
}

/** 指标方法 mixin */
const metricsMethods = {
  /** 记录一个指标数据点 */
  recordMetric(this: any, point: any) {
    this._stmts.recordMetric.run(point);
  },

  /** 批量记录指标（事务） */
  recordMetricsBatch(this: any, points: any) {
    const txn = this.db.transaction((items: any) => {
      for (const p of items) this._stmts.recordMetric.run(p);
    });
    txn(points);
  },

  /** 查询节点指标（ts >= sinceTs） */
  queryMetrics(this: any, nodeId: any, sinceTs: any) {
    return this._stmts.queryMetrics.all(nodeId, sinceTs);
  },

  /** 获取每个节点的最新数据点 */
  latestMetricPerNode(this: any) {
    return this._stmts.latestMetricPerNode.all();
  },

  /** 删除所有节点中早于 ts 的指标 */
  deleteMetricsBefore(this: any, ts: any) {
    return this._stmts.deleteMetricsBefore.run(ts);
  },

  /** 删除单个节点中早于 ts 的指标 */
  deleteNodeMetricsBefore(this: any, nodeId: any, ts: any) {
    return this._stmts.deleteNodeMetricsBefore.run(nodeId, ts);
  },

  /** 指标总数 */
  metricsCount(this: any) {
    return this._stmts.metricsCount.get().cnt;
  },

  /** 单节点指标数量 */
  metricsCountByNode(this: any, nodeId: any) {
    return this._stmts.metricsCountByNode.get(nodeId).cnt;
  },

  /**
   * 降采样：将指定节点早于 cutoffTs 的数据按 windowMs 窗口聚合
   * @returns {number} 删除的原始点数
   */
  downsampleNodeMetrics(this: any, nodeId: any, cutoffTs: any, windowMs: any) {
    const old = this.db.prepare(
      'SELECT * FROM metrics WHERE nodeId = ? AND ts < ? ORDER BY ts'
    ).all(nodeId, cutoffTs);

    if (old.length === 0) return 0;

    // 按窗口分桶聚合
    const buckets = new Map();
    for (const p of old) {
      const key = Math.floor(p.ts / windowMs) * windowMs;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p);
    }

    const txn = this.db.transaction(() => {
      this._stmts.deleteNodeMetricsBefore.run(nodeId, cutoffTs);
      for (const [bucketTs, points] of buckets) {
        const avg = (key: any) => Math.round(points.reduce((s: any, p: any) => s + (p[key] || 0), 0) / points.length);
        this._stmts.recordMetric.run({
          nodeId,
          ts: bucketTs,
          cpu: avg('cpu'),
          memPct: avg('memPct'),
          diskPct: avg('diskPct'),
          sshLatency: avg('sshLatency'),
          loadAvg: points[points.length - 1].loadAvg || '0',
          p2pDirect: avg('p2pDirect'),
          p2pTotal: avg('p2pTotal'),
          memTotalMB: points[points.length - 1].memTotalMB || 0,
          memUsedMB: points[points.length - 1].memUsedMB || 0,
        });
      }
    });
    txn();
    return old.length;
  },
};

module.exports = { prepareMetricsStatements, metricsMethods };
export {}; // CJS 模块标记
