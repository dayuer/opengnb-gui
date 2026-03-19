'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDataDir } = require('../helpers');

describe('services/metrics-store', () => {
  let MetricsStore, store, dataDir, cleanup;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = tmpDataDir());
    fs.mkdirSync(path.join(dataDir, 'registry'), { recursive: true });
    MetricsStore = require('../../services/metrics-store');
    store = new MetricsStore({
      metricsPath: path.join(dataDir, 'registry', 'metrics.json'),
      flushIntervalMs: 0, // 禁止自动 flush，手动控制
    });
  });

  afterEach(() => { store.stop(); cleanup(); });

  describe('record + query', () => {
    it('记录数据点并查询返回', () => {
      store.record('node-1', { cpu: 45, memPct: 60, diskPct: 30, sshLatency: 50, loadAvg: '0.5', p2pDirect: 1, p2pTotal: 2 });
      store.record('node-1', { cpu: 55, memPct: 65, diskPct: 31, sshLatency: 60, loadAvg: '0.6', p2pDirect: 2, p2pTotal: 3 });
      const data = store.query('node-1', '1h');
      assert.equal(data.length, 2);
      assert.equal(data[0].cpu, 45);
      assert.equal(data[1].cpu, 55);
    });

    it('查询不存在的节点返回空', () => {
      const data = store.query('nonexistent', '1h');
      assert.deepEqual(data, []);
    });

    it('按时间范围过滤', () => {
      const now = Date.now();
      // 手动插入带时间戳的数据
      store._data.set('node-1', [
        { ts: now - 2 * 3600000, cpu: 10, memPct: 20, diskPct: 30, sshLatency: 50 }, // 2h ago
        { ts: now - 30 * 60000, cpu: 20, memPct: 30, diskPct: 40, sshLatency: 60 },   // 30min ago
        { ts: now - 5 * 60000, cpu: 30, memPct: 40, diskPct: 50, sshLatency: 70 },    // 5min ago
      ]);
      const h1 = store.query('node-1', '1h');
      assert.equal(h1.length, 2); // 30min + 5min
      const h6 = store.query('node-1', '6h');
      assert.equal(h6.length, 3); // all
    });
  });

  describe('summary', () => {
    it('汇总全集群指标', () => {
      store.record('node-1', { cpu: 40, memPct: 50, diskPct: 30, sshLatency: 100, memTotalMB: 4000, memUsedMB: 2000, loadAvg: '1.0', p2pDirect: 1, p2pTotal: 2 });
      store.record('node-2', { cpu: 60, memPct: 70, diskPct: 40, sshLatency: 200, memTotalMB: 8000, memUsedMB: 5600, loadAvg: '2.0', p2pDirect: 2, p2pTotal: 3 });
      const s = store.summary();
      assert.equal(s.nodeCount, 2);
      assert.equal(s.avgCpu, 50); // (40+60)/2
      assert.equal(s.avgMemPct, 60); // (50+70)/2
      assert.equal(s.avgDiskPct, 35); // (30+40)/2
      assert.equal(s.avgLatency, 150);
    });

    it('空数据返回零值', () => {
      const s = store.summary();
      assert.equal(s.nodeCount, 0);
      assert.equal(s.avgCpu, 0);
    });
  });

  describe('alerts', () => {
    it('检测超阈值指标', () => {
      store.record('node-1', { cpu: 95, memPct: 50, diskPct: 30, sshLatency: 50 });
      store.record('node-2', { cpu: 40, memPct: 90, diskPct: 95, sshLatency: 1500 });
      const alerts = store.getAlerts();
      assert.equal(alerts.length, 4); // node-1:cpu + node-2:mem,disk,latency
    });

    it('正常指标无告警', () => {
      store.record('node-1', { cpu: 50, memPct: 60, diskPct: 70, sshLatency: 200 });
      const alerts = store.getAlerts();
      assert.equal(alerts.length, 0);
    });
  });

  describe('persistence', () => {
    it('flush 后重新加载数据不丢失', () => {
      store.record('node-1', { cpu: 42, memPct: 55, diskPct: 33, sshLatency: 80 });
      store.flush();

      const store2 = new MetricsStore({
        metricsPath: path.join(dataDir, 'registry', 'metrics.json'),
        flushIntervalMs: 0,
      });
      const data = store2.query('node-1', '1h');
      assert.equal(data.length, 1);
      assert.equal(data[0].cpu, 42);
      store2.stop();
    });
  });

  describe('downsample', () => {
    it('超过 24h 的数据被降采样', () => {
      const now = Date.now();
      const points = [];
      // 插入 30 小时的数据，每 10s 一个点
      for (let i = 0; i < 100; i++) {
        points.push({
          ts: now - 30 * 3600000 + i * 10000,
          cpu: 50 + Math.round(Math.random() * 10),
          memPct: 60, diskPct: 40, sshLatency: 100,
        });
      }
      store._data.set('node-1', points);
      store._downsample('node-1');
      const data = store._data.get('node-1');
      // 所有点都超过 24h，应该被聚合为更少的点
      assert.ok(data.length < 100);
      assert.ok(data.length > 0);
    });
  });

  describe('size limit', () => {
    it('超过上限自动清理最旧数据', () => {
      // 设置极小上限
      store._maxSizeBytes = 500;
      for (let i = 0; i < 50; i++) {
        store.record('node-1', { cpu: i, memPct: 50, diskPct: 30, sshLatency: 100 });
      }
      store._enforceLimit();
      const data = store._data.get('node-1');
      assert.ok(data.length < 50);
    });
  });
});
