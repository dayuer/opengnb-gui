'use strict';

// T1: RED — Sweeper 模块测试
// 验证 audit_logs 30天清理 + agent_tasks 7天清理

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDataDir } = require('../helpers');

describe('services/sweeper', () => {
  let Sweeper, NodeStore, nodeStore, dataDir, cleanup;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = tmpDataDir());
    NodeStore = require('../../services/node-store');
    Sweeper = require('../../services/sweeper');
    nodeStore = new NodeStore(path.join(dataDir, 'nodes.db'));
    nodeStore.init();
  });

  afterEach(() => { nodeStore.close(); cleanup(); });

  describe('sweep audit_logs', () => {
    it('应删除 30 天前的 audit_logs', () => {
      const sweeper = new Sweeper({ store: nodeStore });
      // 插入 31 天前的日志
      const old = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
      nodeStore.insertAudit({ ts: old, action: 'test_old', actor: 'system', detailJson: '{}' });
      // 插入当前日志
      const now = new Date().toISOString();
      nodeStore.insertAudit({ ts: now, action: 'test_new', actor: 'system', detailJson: '{}' });

      sweeper.sweep();

      const remaining = nodeStore.queryAuditLogs({ limit: 100 });
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].action, 'test_new');
    });

    it('不应删除 30 天内的 audit_logs', () => {
      const sweeper = new Sweeper({ store: nodeStore });
      const recent = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString();
      nodeStore.insertAudit({ ts: recent, action: 'test_recent', actor: 'system', detailJson: '{}' });

      sweeper.sweep();

      const remaining = nodeStore.queryAuditLogs({ limit: 100 });
      assert.equal(remaining.length, 1);
    });
  });

  describe('sweep agent_tasks', () => {
    it('应删除 7 天前已完成的 agent_tasks', () => {
      const sweeper = new Sweeper({ store: nodeStore });
      const old = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
      // 插入已完成的旧任务
      nodeStore.taskInsert({
        taskId: 'old-task', nodeId: 'n1', type: 'skill_install',
        command: 'test', skillId: '', skillName: '', status: 'completed',
        timeoutMs: 60000, queuedAt: old,
      });
      // 手动标记完成时间为 8 天前
      nodeStore.taskUpdateResult({
        taskId: 'old-task', status: 'completed', resultCode: 0,
        resultStdout: '', resultStderr: '', completedAt: old,
      });

      // 插入当前已完成任务
      const now = new Date().toISOString();
      nodeStore.taskInsert({
        taskId: 'new-task', nodeId: 'n1', type: 'skill_install',
        command: 'test', skillId: '', skillName: '', status: 'completed',
        timeoutMs: 60000, queuedAt: now,
      });
      nodeStore.taskUpdateResult({
        taskId: 'new-task', status: 'completed', resultCode: 0,
        resultStdout: '', resultStderr: '', completedAt: now,
      });

      sweeper.sweep();

      const remaining = nodeStore.taskAllByNode('n1', 100);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].taskId, 'new-task');
    });

    it('不应删除未完成的 agent_tasks（即使旧）', () => {
      const sweeper = new Sweeper({ store: nodeStore });
      const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      nodeStore.taskInsert({
        taskId: 'queued-task', nodeId: 'n1', type: 'skill_install',
        command: 'test', skillId: '', skillName: '', status: 'queued',
        timeoutMs: 60000, queuedAt: old,
      });

      sweeper.sweep();

      const remaining = nodeStore.taskAllByNode('n1', 100);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].taskId, 'queued-task');
    });
  });

  describe('custom retention', () => {
    it('应支持自定义保留天数', () => {
      const sweeper = new Sweeper({
        store: nodeStore,
        auditRetentionDays: 3,
        taskRetentionDays: 1,
      });
      // 插入 4 天前的审计日志
      const ts = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
      nodeStore.insertAudit({ ts, action: 'test', actor: 'system', detailJson: '{}' });

      sweeper.sweep();

      const remaining = nodeStore.queryAuditLogs({ limit: 100 });
      assert.equal(remaining.length, 0);
    });
  });
});
