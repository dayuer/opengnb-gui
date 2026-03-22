'use strict';

// @alpha: 命令白名单测试 — 覆盖 S3.1-S3.14

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { request } = require('../helpers');

// 构建最小测试 app — 仅挂载 nodes 路由
function createTestApp() {
  const app = express();
  app.use(express.json());

  // Mock monitor + sshManager
  const monitor = {
    getAllStatus: () => [{ id: 'n1', online: true }],
    getNodeStatus: (id) => id === 'n1' ? { id: 'n1', online: true } : null,
  };

  const sshManager = {
    exec: async () => ({ stdout: 'ok', stderr: '', code: 0 }),
  };

  const nodesConfig = [{ id: 'n1', name: 'TestNode', tunAddr: '10.0.0.1' }];

  const createNodesRouter = require('../../routes/nodes');
  app.use('/api/nodes', createNodesRouter(monitor, sshManager, nodesConfig));
  return app;
}

describe('routes/nodes exec whitelist', () => {
  // --- 合法命令 (S3.1-S3.5) ---

  it('S3.1 should allow "uptime"', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 'uptime' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('S3.2 should allow "ping -c 3 10.0.0.1"', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 'ping -c 3 10.0.0.1' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('S3.3 should allow "df -h"', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 'df -h' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('S3.4 should allow "ip addr show"', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 'ip addr show' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('S3.5 should allow "gnb_ctl status"', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 'gnb_ctl status' },
    });
    assert.equal(res.statusCode, 200);
  });

  // --- 拒绝的命令 (S3.6-S3.11) ---

  it('S3.6 should reject "cat /etc/passwd" (removed from whitelist)', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 'cat /etc/passwd' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('S3.7 should reject "ls -la /root" (removed from whitelist)', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 'ls -la /root' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('S3.8 should reject semicolon injection "uname; rm -rf /"', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 'uname; rm -rf /' },
    });
    assert.equal(res.statusCode, 403);
    assert.ok(res.body.error.includes('特殊字符'));
  });

  it('S3.9 should reject pipe injection "uptime | grep load"', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 'uptime | grep load' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('S3.10 should reject backtick injection', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 'echo `id`' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('S3.11 should reject $() injection', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 'ping $(whoami)' },
    });
    assert.equal(res.statusCode, 403);
  });

  // --- 边界 (S3.12-S3.14) ---

  it('S3.12 should reject missing command', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('S3.13 should reject non-string command', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/n1/exec', {
      body: { command: 123 },
    });
    assert.equal(res.statusCode, 400);
  });

  it('S3.14 should reject unknown node', async () => {
    const app = createTestApp();
    const res = await request(app, 'POST', '/api/nodes/unknown/exec', {
      body: { command: 'uptime' },
    });
    assert.equal(res.statusCode, 404);
  });
});
