'use strict';

// @beta: API 集成测试 — 覆盖 S10.1-S10.2 + 认证端到端

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { tmpDataDir } = require('../helpers');

/**
 * 启动最小化 Console 服务用于集成测试
 * 不依赖 GnbMonitor/SSHManager 的实际 SSH 连接
 */
async function createIntegrationApp(dataDir) {
  process.env.ADMIN_TOKEN = 'integration-token';
  process.env.DATA_DIR = dataDir;

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // 加载安全中间件
  delete require.cache[require.resolve('../../middleware/auth')];
  const { requireAuth, initToken } = require('../../middleware/auth');
  const { createRateLimit } = require('../../middleware/rate-limit');
  const { errorHandler } = require('../../middleware/error-handler');

  initToken();
  app.use('/api', createRateLimit({ windowMs: 60000, max: 100 }));

  // 初始化 KeyManager
  delete require.cache[require.resolve('../../services/key-manager')];
  const KeyManager = require('../../services/key-manager');
  const km = new KeyManager({ dataDir });
  await km.init();

  // 健康检查 (公开)
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      nodesTotal: km.getAllNodes().length,
      nodesApproved: km.getApprovedNodesConfig().length,
      nodesPending: km.getPendingNodes().length,
      timestamp: new Date().toISOString(),
    });
  });

  // 受保护端点
  app.get('/api/protected', requireAuth, (req, res) => {
    res.json({ message: 'ok' });
  });

  // 统一错误处理
  app.use(errorHandler);

  return app;
}

function httpReq(port, method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = options.body ? JSON.stringify(options.body) : '';
    const req = http.request({
      hostname: '127.0.0.1', port, path,
      method: method.toUpperCase(),
      headers: {
        ...options.headers,
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ statusCode: res.statusCode, body, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

describe('integration/api', () => {
  let server, port, dataDir, cleanup;

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = tmpDataDir());
    const app = await createIntegrationApp(dataDir);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterEach((_, done) => {
    server.close(() => { cleanup(); done(); });
  });

  // S10.1: 健康检查返回正确数据
  it('S10.1 should return health status', async () => {
    const res = await httpReq(port, 'GET', '/api/health');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(typeof res.body.uptime === 'number');
    assert.ok(typeof res.body.nodesTotal === 'number');
    assert.ok(typeof res.body.nodesApproved === 'number');
    assert.ok(typeof res.body.nodesPending === 'number');
    assert.ok(res.body.timestamp);
  });

  // S10.2: 健康检查无需认证
  it('S10.2 should not require auth for health', async () => {
    const res = await httpReq(port, 'GET', '/api/health');
    assert.equal(res.statusCode, 200);
  });

  // 端到端: 无 Token → 401
  it('should reject protected endpoint without token', async () => {
    const res = await httpReq(port, 'GET', '/api/protected');
    assert.equal(res.statusCode, 401);
  });

  // 端到端: 正确 Token → 200
  it('should allow protected endpoint with correct token', async () => {
    const res = await httpReq(port, 'GET', '/api/protected', {
      headers: { Authorization: 'Bearer integration-token' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'ok');
  });

  // 端到端: 错误 Token → 401
  it('should reject protected endpoint with wrong token', async () => {
    const res = await httpReq(port, 'GET', '/api/protected', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(res.statusCode, 401);
  });

  // 速率限制头存在
  it('should include rate limit headers', async () => {
    const res = await httpReq(port, 'GET', '/api/health');
    assert.ok(res.headers['x-ratelimit-limit']);
    assert.ok(res.headers['x-ratelimit-remaining']);
  });
});
