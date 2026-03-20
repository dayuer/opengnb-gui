'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDataDir } = require('../helpers');

describe('services/metrics-store (SQLite)', () => {
  let MetricsStore, NodeStore, store, nodeStore, dataDir, cleanup;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = tmpDataDir());
    NodeStore = require('../../services/node-store');
    MetricsStore = require('../../services/metrics-store');
    nodeStore = new NodeStore(path.join(dataDir, 'nodes.db'));
    nodeStore.init();
    store = new MetricsStore({ store: nodeStore, maintenanceIntervalMs: 0 });
  });

  afterEach(() => { store.stop(); nodeStore.close(); cleanup(); });

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
      nodeStore.recordMetric({ nodeId: 'node-1', ts: now - 2 * 3600000, cpu: 10, memPct: 20, diskPct: 30, sshLatency: 50, loadAvg: '0', p2pDirect: 0, p2pTotal: 0, memTotalMB: 0, memUsedMB: 0 });
      nodeStore.recordMetric({ nodeId: 'node-1', ts: now - 30 * 60000, cpu: 20, memPct: 30, diskPct: 40, sshLatency: 60, loadAvg: '0', p2pDirect: 0, p2pTotal: 0, memTotalMB: 0, memUsedMB: 0 });
      nodeStore.recordMetric({ nodeId: 'node-1', ts: now - 5 * 60000, cpu: 30, memPct: 40, diskPct: 50, sshLatency: 70, loadAvg: '0', p2pDirect: 0, p2pTotal: 0, memTotalMB: 0, memUsedMB: 0 });

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
    it('关闭后重新打开数据不丢失', () => {
      store.record('node-1', { cpu: 42, memPct: 55, diskPct: 33, sshLatency: 80 });
      store.stop();
      nodeStore.close();

      // 重新打开
      const ns2 = new NodeStore(path.join(dataDir, 'nodes.db'));
      ns2.init();
      const store2 = new MetricsStore({ store: ns2, maintenanceIntervalMs: 0 });
      const data = store2.query('node-1', '1h');
      assert.equal(data.length, 1);
      assert.equal(data[0].cpu, 42);
      store2.stop();
      ns2.close();
    });
  });

  describe('downsample', () => {
    it('超过 24h 的数据被降采样', () => {
      const now = Date.now();
      // 插入 30 小时前的 100 个数据点（每 10s 一个点）
      for (let i = 0; i < 100; i++) {
        nodeStore.recordMetric({
          nodeId: 'node-1',
          ts: now - 30 * 3600000 + i * 10000,
          cpu: 50 + Math.round(Math.random() * 10),
          memPct: 60, diskPct: 40, sshLatency: 100,
          loadAvg: '0', p2pDirect: 0, p2pTotal: 0, memTotalMB: 0, memUsedMB: 0,
        });
      }
      // 执行降采样
      const cutoff = now - 24 * 3600000;
      nodeStore.downsampleNodeMetrics('node-1', cutoff, 5 * 60000);
      const count = nodeStore.metricsCountByNode('node-1');
      // 所有点都超过 24h，应该被聚合为更少的点
      assert.ok(count < 100);
      assert.ok(count > 0);
    });
  });

  describe('size limit', () => {
    it('7 天过期自动清理', () => {
      const now = Date.now();
      // 插入一个 8 天前的数据
      nodeStore.recordMetric({
        nodeId: 'node-1', ts: now - 8 * 24 * 3600000,
        cpu: 50, memPct: 50, diskPct: 50, sshLatency: 100,
        loadAvg: '0', p2pDirect: 0, p2pTotal: 0, memTotalMB: 0, memUsedMB: 0,
      });
      // 插入一个当前的数据
      store.record('node-1', { cpu: 60, memPct: 60, diskPct: 60, sshLatency: 100 });

      // 手动触发维护
      store._maintenance();
      const data = store.query('node-1', '7d');
      assert.equal(data.length, 1); // 只保留当前的
      assert.equal(data[0].cpu, 60);
    });
  });
});
