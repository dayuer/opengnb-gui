'use strict';

/**
 * 指标时序存储服务
 * @alpha: 基于 SQLite 的持久化存储 — 替代 JSON 全量 flush
 *
 * 委托 NodeStore 进行 INSERT/SELECT/DELETE。
 * 自身负责告警阈值检测、降采样调度和时间范围转换。
 */
class MetricsStore {
  /**
   * @param {object} options
   * @param {import('./node-store')} options.store - NodeStore 实例
   * @param {number} [options.maintenanceIntervalMs=300000] - 降采样+过期清理间隔（默认 5 分钟）
   * @param {number} [options.maxPoints=1000000] - 指标数据点上限
   */
  constructor(options = {}) {
    this._store = options.store;
    this._maintenanceIntervalMs = options.maintenanceIntervalMs ?? 300000;
    this._maxPoints = options.maxPoints ?? 1000000;

    // 告警阈值
    this._thresholds = {
      cpu: 90,
      memPct: 85,
      diskPct: 90,
      sshLatency: 1000,
    };

    // 降采样窗口: 超过 24h 的数据聚合为 5min 粒度
    this._downsampleAfterMs = 24 * 3600 * 1000;
    this._downsampleWindowMs = 5 * 60 * 1000;
    // 最大保留: 7 天
    this._maxRetentionMs = 7 * 24 * 3600 * 1000;

    this._timer = null;
    if (this._maintenanceIntervalMs > 0) {
      this._timer = setInterval(() => this._maintenance(), this._maintenanceIntervalMs);
    }
  }

  /**
   * 记录一个数据点
   * @param {string} nodeId
   * @param {object} snapshot
   */
  record(nodeId, snapshot) {
    this._store.recordMetric({
      nodeId,
      ts: Date.now(),
      cpu: snapshot.cpu ?? 0,
      memPct: snapshot.memPct ?? 0,
      diskPct: snapshot.diskPct ?? 0,
      sshLatency: snapshot.sshLatency ?? 0,
      loadAvg: snapshot.loadAvg || '0',
      p2pDirect: snapshot.p2pDirect ?? 0,
      p2pTotal: snapshot.p2pTotal ?? 0,
      memTotalMB: snapshot.memTotalMB ?? 0,
      memUsedMB: snapshot.memUsedMB ?? 0,
    });
  }

  /**
   * 查询节点时序数据
   * @param {string} nodeId
   * @param {string} range - '1h' | '6h' | '24h' | '7d'
   * @returns {Array<object>}
   */
  query(nodeId, range = '1h') {
    const sinceTs = Date.now() - this._rangeToMs(range);
    return this._store.queryMetrics(nodeId, sinceTs);
  }

  /**
   * 全局汇总指标（基于每个节点的最新数据点）
   * @returns {object}
   */
  summary() {
    const nodes = this._store.latestMetricPerNode();
    if (nodes.length === 0) {
      return { nodeCount: 0, avgCpu: 0, avgMemPct: 0, avgDiskPct: 0, avgLatency: 0, alertCount: 0 };
    }

    const avg = (arr, key) => Math.round(arr.reduce((s, n) => s + (n[key] || 0), 0) / arr.length);
    return {
      nodeCount: nodes.length,
      avgCpu: avg(nodes, 'cpu'),
      avgMemPct: avg(nodes, 'memPct'),
      avgDiskPct: avg(nodes, 'diskPct'),
      avgLatency: avg(nodes, 'sshLatency'),
      alertCount: this.getAlerts().length,
    };
  }

  /**
   * 获取当前告警列表
   * @returns {Array<{nodeId, metric, value, threshold}>}
   */
  getAlerts() {
    const alerts = [];
    const nodes = this._store.latestMetricPerNode();
    for (const latest of nodes) {
      if (latest.cpu > this._thresholds.cpu) {
        alerts.push({ nodeId: latest.nodeId, metric: 'cpu', value: latest.cpu, threshold: this._thresholds.cpu });
      }
      if (latest.memPct > this._thresholds.memPct) {
        alerts.push({ nodeId: latest.nodeId, metric: 'memPct', value: latest.memPct, threshold: this._thresholds.memPct });
      }
      if (latest.diskPct > this._thresholds.diskPct) {
        alerts.push({ nodeId: latest.nodeId, metric: 'diskPct', value: latest.diskPct, threshold: this._thresholds.diskPct });
      }
      if (latest.sshLatency > this._thresholds.sshLatency) {
        alerts.push({ nodeId: latest.nodeId, metric: 'sshLatency', value: latest.sshLatency, threshold: this._thresholds.sshLatency });
      }
    }
    return alerts;
  }

  /** 停止定时器 */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ─── 私有方法 ───

  /** 定时维护：过期清理 + 降采样 */
  _maintenance() {
    const now = Date.now();
    // 删除 7 天前的数据
    this._store.deleteMetricsBefore(now - this._maxRetentionMs);
    // 降采样 24h 前的数据（逐节点）
    this._downsampleAll();
  }

  /** 对所有有数据的节点执行降采样 */
  _downsampleAll() {
    const cutoff = Date.now() - this._downsampleAfterMs;
    // 获取有数据的节点 ID 列表
    const nodes = this._store.latestMetricPerNode();
    for (const { nodeId } of nodes) {
      this._store.downsampleNodeMetrics(nodeId, cutoff, this._downsampleWindowMs);
    }
  }

  /** 时间范围字符串转毫秒 */
  _rangeToMs(range) {
    const map = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000 };
    return map[range] || map['1h'];
  }
}

module.exports = MetricsStore;
