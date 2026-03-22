'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const NodeStore = require('../../services/node-store');
const JobManager = require('../../services/job-manager');

// @alpha: 使用临时 db 隔离测试
function createTempStore() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const store = new NodeStore(dbPath);
  store.init();
  return { store, tmpDir };
}

describe('services/job-manager (SQLite 持久化)', () => {
  let store, tmpDir, jobManager;

  before(() => {
    ({ store, tmpDir } = createTempStore());
    jobManager = new JobManager({ store, timeoutMs: 2000 });
  });

  after(() => {
    jobManager.destroy();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create()', () => {
    it('创建 job 并持久化', () => {
      const { jobId, job } = jobManager.create('node-1', 'echo hello');
      assert.ok(jobId);
      assert.strictEqual(job.nodeId, 'node-1');
      assert.strictEqual(job.command, 'echo hello');
      assert.strictEqual(job.status, 'dispatched');
      assert.ok(job.createdAt);
    });

    it('jobId 唯一', () => {
      const a = jobManager.create('node-1', 'cmd1');
      const b = jobManager.create('node-1', 'cmd2');
      assert.notStrictEqual(a.jobId, b.jobId);
    });
  });

  describe('markRunning()', () => {
    it('dispatched → running', () => {
      const { jobId } = jobManager.create('node-2', 'test');
      jobManager.markRunning(jobId);
      const job = jobManager.get(jobId);
      assert.strictEqual(job.status, 'running');
    });

    it('非 dispatched 状态不变', () => {
      const { jobId } = jobManager.create('node-2', 'test');
      jobManager.complete(jobId, { exitCode: 0, stdout: 'ok' });
      jobManager.markRunning(jobId); // 应无效
      assert.strictEqual(jobManager.get(jobId).status, 'completed');
    });
  });

  describe('complete()', () => {
    it('正常完成 exitCode=0 → completed', () => {
      const { jobId } = jobManager.create('node-3', 'echo ok');
      const result = jobManager.complete(jobId, { exitCode: 0, stdout: 'ok\n', stderr: '' });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout, 'ok\n');
      assert.ok(result.completedAt);
    });

    it('exitCode≠0 → failed', () => {
      const { jobId } = jobManager.create('node-3', 'false');
      const result = jobManager.complete(jobId, { exitCode: 1, stdout: '', stderr: 'err' });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.exitCode, 1);
    });

    it('不存在的 jobId 返回 null', () => {
      assert.strictEqual(jobManager.complete('nonexistent', { exitCode: 0 }), null);
    });

    it('幂等：已完成的 job 不再更新', () => {
      const { jobId } = jobManager.create('node-3', 'test');
      jobManager.complete(jobId, { exitCode: 0, stdout: 'first' });
      const second = jobManager.complete(jobId, { exitCode: 1, stdout: 'second' });
      assert.strictEqual(second.status, 'completed'); // 仍是第一次的结果
      assert.strictEqual(second.exitCode, 0);
    });

    it('onComplete 回调触发', () => {
      let called = false;
      const jm = new JobManager({
        store,
        onComplete: (job) => { called = true; assert.strictEqual(job.status, 'completed'); },
      });
      const { jobId } = jm.create('node-cb', 'test');
      jm.complete(jobId, { exitCode: 0, stdout: 'ok' });
      assert.ok(called);
      jm.destroy();
    });
  });

  describe('fail()', () => {
    it('标记投递失败', () => {
      const { jobId } = jobManager.create('node-4', 'cmd');
      const result = jobManager.fail(jobId, 'SSH 连接断开');
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.error, 'SSH 连接断开');
      assert.ok(result.completedAt);
    });
  });

  describe('listByNode()', () => {
    it('按节点查询', () => {
      // 创建多个 job
      jobManager.create('node-list', 'cmd1');
      jobManager.create('node-list', 'cmd2');
      jobManager.create('node-other', 'cmd3');

      const list = jobManager.listByNode('node-list');
      assert.ok(list.length >= 2);
      assert.ok(list.every(j => j.nodeId === 'node-list'));
    });
  });

  describe('listRecent()', () => {
    it('返回最近 job', () => {
      const list = jobManager.listRecent(5);
      assert.ok(Array.isArray(list));
      assert.ok(list.length <= 5);
    });
  });

  describe('超时检查', () => {
    it('超时 job 标记为 timeout', async () => {
      const jm = new JobManager({ store, timeoutMs: 500 });
      const { jobId } = jm.create('node-timeout', 'sleep 999');
      jm.markRunning(jobId);

      // 等待超时
      await new Promise(r => setTimeout(r, 600));
      jm._checkTimeouts();

      const job = jm.get(jobId);
      assert.strictEqual(job.status, 'timeout');
      assert.ok(job.error.includes('超时'));
      jm.destroy();
    });
  });

  describe('stdout/stderr 截断', () => {
    it('超长输出被截断到 64KB', () => {
      const { jobId } = jobManager.create('node-trunc', 'big');
      const bigStdout = 'x'.repeat(100000);
      jobManager.complete(jobId, { exitCode: 0, stdout: bigStdout, stderr: '' });
      const job = jobManager.get(jobId);
      assert.ok(job.stdout.length <= 65536);
    });
  });
});
