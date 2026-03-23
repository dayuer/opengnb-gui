// @ts-nocheck
'use strict';

/**
 * 技能安装/卸载路由测试 — Agent 任务队列版
 *
 * 当前路由已重构为 Agent piggyback 模式：
 *   POST /:id/skills → monitor.enqueueTask() → 200 { taskId, status: 'queued' }
 *   DELETE /:id/skills/:skillId → monitor.enqueueTask() → 200 { taskId, status: 'queued' }
 *
 * 旧版直连 SSH exec 模式的测试已移除。
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { request } = require('../helpers');
const createNodesRouter = require('../../routes/nodes');

function createTestApp() {
  const app = express();
  app.use(express.json());

  const enqueuedTasks = [];

  const monitor = {
    getAllStatus: () => [{ id: 'n1', online: true }],
    getNodeStatus: (id) => id === 'n1' ? { id: 'n1', online: true } : null,
  };

  const taskQueue = {
    enqueueTask: (nodeId, task) => {
      enqueuedTasks.push({ nodeId, ...task });
      return task;
    },
    getNodeTasks: () => [],
    deleteTask: (taskId) => taskId === 'existing-task',
  };

  const sshManager = { exec: async () => ({ code: 0 }) };

  const nodesConfig = [
    { id: 'n1', name: 'TestNode', tunAddr: '10.0.0.1', status: 'approved' },
  ];

  app.use('/api/nodes', createNodesRouter(monitor, sshManager, nodesConfig, undefined, undefined, taskQueue));
  return { app, enqueuedTasks, monitor, taskQueue };
}

describe('Node Skills API (Agent 任务队列版)', () => {

  describe('POST /api/nodes/:id/skills — 安装入队', () => {

    it('should enqueue clawhub install task', async () => {
      const { app, enqueuedTasks } = createTestApp();
      const res = await request(app, 'POST', '/api/nodes/n1/skills', {
        body: { skillId: 'agent-browser', source: 'clawhub' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'queued');
      assert.ok(res.body.taskId);
      assert.equal(enqueuedTasks.length, 1);
      assert.equal(enqueuedTasks[0].command, 'clawhub install agent-browser');
      assert.equal(enqueuedTasks[0].type, 'skill_install');
    });

    it('should enqueue npm install task', async () => {
      const { app, enqueuedTasks } = createTestApp();
      const res = await request(app, 'POST', '/api/nodes/n1/skills', {
        body: { skillId: '@ollama/web-search', source: 'npm' },
      });
      assert.equal(res.statusCode, 200);
      assert.ok(enqueuedTasks[0].command.includes('npm install -g @ollama/web-search'));
    });

    it('should skip console source (no remote task)', async () => {
      const { app, enqueuedTasks } = createTestApp();
      const res = await request(app, 'POST', '/api/nodes/n1/skills', {
        body: { skillId: 'claude-code', source: 'console' },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'completed');
      assert.equal(enqueuedTasks.length, 0); // 不入队
    });

    it('should return 400 for unsupported source', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'POST', '/api/nodes/n1/skills', {
        body: { skillId: 'bad', source: 'ftp' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 400 when missing skillId', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'POST', '/api/nodes/n1/skills', {
        body: { source: 'npm' },
      });
      assert.equal(res.statusCode, 400);
    });

    it('should return 404 for unknown node', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'POST', '/api/nodes/unknown/skills', {
        body: { skillId: 'test', source: 'npm' },
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('DELETE /api/nodes/:id/skills/:skillId — 卸载入队', () => {

    it('should enqueue uninstall task with default disable command', async () => {
      const { app, enqueuedTasks } = createTestApp();
      const res = await request(app, 'DELETE', '/api/nodes/n1/skills/slack', {});
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, 'queued');
      assert.equal(enqueuedTasks[0].command, 'openclaw plugins disable slack');
      assert.equal(enqueuedTasks[0].type, 'skill_uninstall');
    });

    it('should reject invalid skill IDs', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'DELETE', '/api/nodes/n1/skills/bad;rm%20-rf%20/', {});
      assert.equal(res.statusCode, 400);
    });

    it('should return 404 for unknown node', async () => {
      const { app } = createTestApp();
      const res = await request(app, 'DELETE', '/api/nodes/unknown/skills/test', {});
      assert.equal(res.statusCode, 404);
    });
  });
});
