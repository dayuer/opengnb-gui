'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 指标时序存储服务
 * @alpha: 环形缓冲 + 降采样 + 持久化 + 告警检测
 *
 * 存储结构: Map<nodeId, Array<DataPoint>>
 * DataPoint: { ts, cpu, memPct, diskPct, sshLatency, loadAvg, p2pDirect, p2pTotal, memTotalMB, memUsedMB }
 */
class MetricsStore {
  /**
   * @param {object} options
   * @param {string} options.metricsPath - metrics.json 文件路径
   * @param {number} [options.flushIntervalMs=300000] - 持久化间隔(默认5分钟)
   * @param {number} [options.maxSizeBytes=52428800] - 存储上限(默认50MB)
   */
  constructor(options = {}) {
    this._metricsPath = options.metricsPath;
    this._flushIntervalMs = options.flushIntervalMs ?? 300000;
    this._maxSizeBytes = options.maxSizeBytes ?? 50 * 1024 * 1024;

    /** @type {Map<string, Array<object>>} 节点时序数据 */
    this._data = new Map();

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

    this._load();

    this._timer = null;
    if (this._flushIntervalMs > 0) {
      this._timer = setInterval(() => {
        this._downsampleAll();
        this._enforceLimit();
        this.flush();
      }, this._flushIntervalMs);
    }
  }

  /**
   * 记录一个数据点
   * @param {string} nodeId
   * @param {object} snapshot - { cpu, memPct, diskPct, sshLatency, loadAvg, p2pDirect, p2pTotal, memTotalMB, memUsedMB }
   */
  record(nodeId, snapshot) {
    if (!this._data.has(nodeId)) {
      this._data.set(nodeId, []);
    }
    const point = {
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
    };
    this._data.get(nodeId).push(point);
  }

  /**
   * 查询节点时序数据
   * @param {string} nodeId
   * @param {string} range - '1h' | '6h' | '24h'
   * @returns {Array<object>}
   */
  query(nodeId, range = '1h') {
    const points = this._data.get(nodeId);
    if (!points || points.length === 0) return [];

    const rangeMs = this._rangeToMs(range);
    const cutoff = Date.now() - rangeMs;
    return points.filter(p => p.ts >= cutoff);
  }

  /**
   * 全局汇总指标（基于每个节点的最新数据点）
   * @returns {object}
   */
  summary() {
    const nodes = [];
    for (const [nodeId, points] of this._data) {
      if (points.length === 0) continue;
      const latest = points[points.length - 1];
      nodes.push({ nodeId, ...latest });
    }

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
    for (const [nodeId, points] of this._data) {
      if (points.length === 0) continue;
      const latest = points[points.length - 1];

      if (latest.cpu > this._thresholds.cpu) {
        alerts.push({ nodeId, metric: 'cpu', value: latest.cpu, threshold: this._thresholds.cpu });
      }
      if (latest.memPct > this._thresholds.memPct) {
        alerts.push({ nodeId, metric: 'memPct', value: latest.memPct, threshold: this._thresholds.memPct });
      }
      if (latest.diskPct > this._thresholds.diskPct) {
        alerts.push({ nodeId, metric: 'diskPct', value: latest.diskPct, threshold: this._thresholds.diskPct });
      }
      if (latest.sshLatency > this._thresholds.sshLatency) {
        alerts.push({ nodeId, metric: 'sshLatency', value: latest.sshLatency, threshold: this._thresholds.sshLatency });
      }
    }
    return alerts;
  }

  /**
   * 持久化到磁盘
   */
  flush() {
    try {
      const obj = {};
      for (const [nodeId, points] of this._data) {
        obj[nodeId] = points;
      }
      const dir = path.dirname(this._metricsPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = this._metricsPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(obj));
      fs.renameSync(tmpPath, this._metricsPath);
    } catch (err) {
      console.error(`[MetricsStore] flush 失败: ${err.message}`);
    }
  }

  /** 停止定时器 */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ─── 私有方法 ───

  /** 从磁盘加载 */
  _load() {
    try {
      if (!fs.existsSync(this._metricsPath)) return;
      const raw = JSON.parse(fs.readFileSync(this._metricsPath, 'utf-8'));
      for (const [nodeId, points] of Object.entries(raw)) {
        this._data.set(nodeId, Array.isArray(points) ? points : []);
      }
    } catch (_) {
      // 文件损坏，从空开始
    }
  }

  /** 降采样所有节点 */
  _downsampleAll() {
    for (const nodeId of this._data.keys()) {
      this._downsample(nodeId);
    }
  }

  /**
   * 降采样：超过 24h 的原始数据聚合为 5min 窗口平均值
   * @param {string} nodeId
   */
  _downsample(nodeId) {
    const points = this._data.get(nodeId);
    if (!points || points.length === 0) return;

    const now = Date.now();
    const cutoff24h = now - this._downsampleAfterMs;
    const cutoffMax = now - this._maxRetentionMs;

    // 分成三部分: 过期删除 | 需要降采样 | 保留原始
    const toRemove = [];
    const toDownsample = [];
    const toKeep = [];

    for (const p of points) {
      if (p.ts < cutoffMax) {
        toRemove.push(p);
      } else if (p.ts < cutoff24h) {
        toDownsample.push(p);
      } else {
        toKeep.push(p);
      }
    }

    // 如果没有需要降采样的，直接去掉过期的
    if (toDownsample.length === 0) {
      if (toRemove.length > 0) {
        this._data.set(nodeId, toKeep);
      }
      return;
    }

    // 按 5min 窗口聚合
    const buckets = new Map();
    for (const p of toDownsample) {
      const bucketKey = Math.floor(p.ts / this._downsampleWindowMs) * this._downsampleWindowMs;
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
      buckets.get(bucketKey).push(p);
    }

    const aggregated = [];
    for (const [bucketTs, bPoints] of buckets) {
      const avg = (key) => Math.round(bPoints.reduce((s, p) => s + (p[key] || 0), 0) / bPoints.length);
      aggregated.push({
        ts: bucketTs,
        cpu: avg('cpu'),
        memPct: avg('memPct'),
        diskPct: avg('diskPct'),
        sshLatency: avg('sshLatency'),
        loadAvg: bPoints[bPoints.length - 1].loadAvg || '0',
        p2pDirect: avg('p2pDirect'),
        p2pTotal: avg('p2pTotal'),
      });
    }

    // 合并: 降采样结果 + 原始24h内
    aggregated.sort((a, b) => a.ts - b.ts);
    this._data.set(nodeId, [...aggregated, ...toKeep]);
  }

  /** 强制存储限制 */
  _enforceLimit() {
    const size = this._estimateSize();
    if (size <= this._maxSizeBytes) return;

    // 每个节点按比例裁剪最旧的 20%
    for (const [nodeId, points] of this._data) {
      const trimCount = Math.ceil(points.length * 0.2);
      this._data.set(nodeId, points.slice(trimCount));
    }
  }

  /** 估算内存中数据大小 */
  _estimateSize() {
    let total = 0;
    for (const points of this._data.values()) {
      // 每个数据点约 100 bytes JSON
      total += points.length * 100;
    }
    return total;
  }

  /** 时间范围字符串转毫秒 */
  _rangeToMs(range) {
    const map = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000 };
    return map[range] || map['1h'];
  }
}

module.exports = MetricsStore;
