'use strict';

// @alpha: TaskQueue 独立模块测试 — 从 GnbMonitor 提炼的任务队列

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('services/task-queue', () => {
  // @alpha: 引入尚未存在的模块 — RED 阶段
  const TaskQueue = require('../../services/task-queue');

  let queue: any;
  let mockStore: any;
  let mockAudit: any;
  let emittedEvents: any[];

  beforeEach(() => {
    emittedEvents = [];

    // 模拟 NodeStore 的 task 相关 prepared statements
    const tasks: Record<string, any> = {};
    mockStore = {
      taskInsert: (row: any) => { tasks[row.taskId] = { ...row }; },
      taskPendingByNode: (nodeId: string) => Object.values(tasks)
        .filter((t: any) => t.nodeId === nodeId && t.status === 'queued'),
      taskMarkDispatched: (taskId: string, ts: string) => {
        if (tasks[taskId]) tasks[taskId].dispatchedAt = ts;
      },
      taskUpdateResult: (data: any) => {
        if (tasks[data.taskId]) Object.assign(tasks[data.taskId], data);
      },
      taskAllByNode: (nodeId: string, limit: number) =>
        Object.values(tasks).filter((t: any) => t.nodeId === nodeId).slice(0, limit),
      taskFind: (taskId: string) => tasks[taskId] || null,
      taskDelete: (taskId: string) => { delete tasks[taskId]; },
    };

    mockAudit = { log: (...args: any[]) => emittedEvents.push(['audit', ...args]) };

    queue = new TaskQueue(mockStore, mockAudit);
    queue.on('taskQueued', (e: any) => emittedEvents.push(['taskQueued', e]));
    queue.on('taskCompleted', (e: any) => emittedEvents.push(['taskCompleted', e]));
  });

  // ═══════════════════════════════════════
  // enqueueTask
  // ═══════════════════════════════════════

  describe('enqueueTask', () => {
    it('should insert task into store and return row', () => {
      const result = queue.enqueueTask('node-1', {
        taskId: 'task-001',
        type: 'skill_install',
        command: 'clawhub install foo',
        skillId: 'foo',
        skillName: 'Foo',
        timeoutMs: 120000,
      });
      assert.equal(result.taskId, 'task-001');
      assert.equal(result.nodeId, 'node-1');
      assert.equal(result.status, 'queued');
    });

    it('should emit taskQueued event', () => {
      queue.enqueueTask('node-1', { taskId: 'task-002', type: 'skill_install', command: 'test' });
      const ev = emittedEvents.find((e: any) => e[0] === 'taskQueued');
      assert.ok(ev, 'taskQueued event should fire');
      assert.equal(ev[1].nodeId, 'node-1');
    });

    it('should log to audit', () => {
      queue.enqueueTask('node-1', { taskId: 'task-003', type: 'skill_install', command: 'test' });
      const auditLog = emittedEvents.find((e: any) => e[0] === 'audit' && e[1] === 'task_enqueue');
      assert.ok(auditLog, 'audit log should be written');
    });

    it('should handle missing store gracefully', () => {
      const noStoreQueue = new TaskQueue(null, null);
      const result = noStoreQueue.enqueueTask('n', { taskId: 't', command: 'x' });
      assert.equal(result.taskId, 't');
    });
  });

  // ═══════════════════════════════════════
  // getPendingTasks
  // ═══════════════════════════════════════

  describe('getPendingTasks', () => {
    it('should return pending tasks and mark dispatched', () => {
      queue.enqueueTask('node-1', { taskId: 't1', type: 'skill_install', command: 'cmd1' });
      queue.enqueueTask('node-1', { taskId: 't2', type: 'skill_install', command: 'cmd2' });
      const pending = queue.getPendingTasks('node-1');
      assert.equal(pending.length, 2);
      assert.equal(pending[0].taskId, 't1');
      assert.equal(pending[0].command, 'cmd1');
    });

    it('should not return tasks for other nodes', () => {
      queue.enqueueTask('node-1', { taskId: 't1', command: 'cmd1' });
      queue.enqueueTask('node-2', { taskId: 't2', command: 'cmd2' });
      const pending = queue.getPendingTasks('node-1');
      assert.equal(pending.length, 1);
    });

    it('should return empty when store is null', () => {
      const noStoreQueue = new TaskQueue(null, null);
      assert.deepEqual(noStoreQueue.getPendingTasks('n'), []);
    });
  });

  // ═══════════════════════════════════════
  // processTaskResults
  // ═══════════════════════════════════════

  describe('processTaskResults', () => {
    it('should mark successful results as completed', () => {
      queue.enqueueTask('node-1', { taskId: 't1', command: 'cmd' });
      queue.processTaskResults('node-1', [
        { taskId: 't1', code: 0, stdout: 'ok', stderr: '' },
      ]);
      const ev = emittedEvents.find((e: any) => e[0] === 'taskCompleted');
      assert.ok(ev);
      assert.equal(ev[1].status, 'completed');
    });

    it('should mark non-zero code as failed', () => {
      queue.enqueueTask('node-1', { taskId: 't1', command: 'cmd' });
      queue.processTaskResults('node-1', [
        { taskId: 't1', code: 1, stdout: '', stderr: 'err' },
      ]);
      const ev = emittedEvents.find((e: any) => e[0] === 'taskCompleted');
      assert.equal(ev[1].status, 'failed');
    });
  });

  // ═══════════════════════════════════════
  // getNodeTasks
  // ═══════════════════════════════════════

  describe('getNodeTasks', () => {
    it('should return formatted tasks with result field', () => {
      mockStore.taskAllByNode = () => [{
        taskId: 't1', nodeId: 'n1', type: 'skill_install',
        resultCode: 0, resultStdout: 'ok', resultStderr: '',
      }];
      const tasks = queue.getNodeTasks('n1');
      assert.equal(tasks.length, 1);
      assert.deepEqual(tasks[0].result, { code: 0, stdout: 'ok', stderr: '' });
    });

    it('should return undefined result when no resultCode', () => {
      mockStore.taskAllByNode = () => [{
        taskId: 't2', nodeId: 'n1', type: 'skill_install',
        resultCode: null, resultStdout: null, resultStderr: null,
      }];
      const tasks = queue.getNodeTasks('n1');
      assert.equal(tasks[0].result, undefined);
    });
  });

  // ═══════════════════════════════════════
  // deleteTask
  // ═══════════════════════════════════════

  describe('deleteTask', () => {
    it('should delete existing task and return true', () => {
      queue.enqueueTask('n1', { taskId: 't1', command: 'cmd' });
      assert.equal(queue.deleteTask('t1'), true);
    });

    it('should return false for non-existent task', () => {
      assert.equal(queue.deleteTask('nonexistent'), false);
    });

    it('should return false when store is null', () => {
      const noStoreQueue = new TaskQueue(null, null);
      assert.equal(noStoreQueue.deleteTask('t'), false);
    });
  });
});
