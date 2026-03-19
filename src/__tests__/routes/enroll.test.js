'use strict';

// @beta: 节点注册路由分层认证测试 — 覆盖 S4.1-S4.17

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { request, tmpDataDir } = require('../helpers');

describe('routes/enroll (split auth)', () => {
  let app, km, dataDir, cleanup;

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = tmpDataDir());

    delete require.cache[require.resolve('../../services/key-manager')];
    const KeyManager = require('../../services/key-manager');
    km = new KeyManager({ dataDir });
    await km.init();

    app = express();
    app.use(express.json());

    // 简单 auth 中间件用于测试
    const requireAuth = (req, res, next) => {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token !== 'admin-token') return res.status(401).json({ error: 'unauthorized' });
      next();
    };

    // 空审计 (测试用)
    const audit = { middleware: () => (_req, _res, next) => next() };

    const createEnrollRouter = require('../../routes/enroll');
    app.use('/api/enroll', createEnrollRouter(km, { requireAuth, audit }));
  });

  afterEach(() => { if (km && km.store) km.store.close(); cleanup(); });

  const auth = { Authorization: 'Bearer admin-token' };

  // --- 公开端点 ---

  // S4.1: 获取公钥 (公开)
  it('S4.1 should return pubkey without auth', async () => {
    const res = await request(app, 'GET', '/api/enroll/pubkey');
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.publicKey);
  });

  // S4.8: 查询状态 (公开)
  it('S4.8 should return status without auth', async () => {
    const res = await request(app, 'GET', '/api/enroll/status/abc');
    assert.equal(res.statusCode, 404); // 节点不存在但不需认证
    assert.ok(res.body.status);
  });

  // --- 管理端点需认证 ---

  // S4.2: 获取 passcode (需认证)
  it('S4.2 should require auth for passcode', async () => {
    const res = await request(app, 'GET', '/api/enroll/passcode');
    assert.equal(res.statusCode, 401);
  });

  // S4.3: 获取 passcode (已认证)
  it('S4.3 should return passcode with auth', async () => {
    const res = await request(app, 'GET', '/api/enroll/passcode', { headers: auth });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.passcode);
  });

  // S4.9: 审批 (需认证)
  it('S4.9 should require auth for approve', async () => {
    const res = await request(app, 'POST', '/api/enroll/test/approve');
    assert.equal(res.statusCode, 401);
  });

  // S4.11: 拒绝 (需认证)
  it('S4.11 should require auth for reject', async () => {
    const res = await request(app, 'POST', '/api/enroll/test/reject');
    assert.equal(res.statusCode, 401);
  });

  // S4.12: 删除 (需认证)
  it('S4.12 should require auth for delete', async () => {
    const res = await request(app, 'DELETE', '/api/enroll/test');
    assert.equal(res.statusCode, 401);
  });

  // S4.14: pending (需认证)
  it('S4.14 should require auth for pending', async () => {
    const res = await request(app, 'GET', '/api/enroll/pending');
    assert.equal(res.statusCode, 401);
  });

  // S4.15: all (需认证)
  it('S4.15 should require auth for all', async () => {
    const res = await request(app, 'GET', '/api/enroll/all');
    assert.equal(res.statusCode, 401);
  });

  // --- 注册流程 ---

  // S4.4: 注册成功
  it('S4.4 should enroll with valid passcode', async () => {
    // 先获取 passcode
    const pcRes = await request(app, 'GET', '/api/enroll/passcode', { headers: auth });
    const { passcode } = pcRes.body;

    const res = await request(app, 'POST', '/api/enroll', {
      body: { passcode, id: 'node-1', name: 'Test Node' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'pending');
  });

  // S4.5: 注册缺 passcode
  it('S4.5 should reject enrollment without passcode', async () => {
    const res = await request(app, 'POST', '/api/enroll', {
      body: { id: 'node-1' },
    });
    assert.equal(res.statusCode, 400);
  });

  // S4.6: 注册错误 passcode
  it('S4.6 should reject enrollment with wrong passcode', async () => {
    const res = await request(app, 'POST', '/api/enroll', {
      body: { passcode: 'invalid-code', id: 'node-1' },
    });
    assert.equal(res.statusCode, 400);
  });

  // S4.7: passcode 一次性
  it('S4.7 should reject reused passcode', async () => {
    const pcRes = await request(app, 'GET', '/api/enroll/passcode', { headers: auth });
    const { passcode } = pcRes.body;

    // 第一次注册
    await request(app, 'POST', '/api/enroll', {
      body: { passcode, id: 'node-1', name: 'First' },
    });

    // 第二次使用同一 passcode
    const res = await request(app, 'POST', '/api/enroll', {
      body: { passcode, id: 'node-2', name: 'Second' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.message.includes('已使用'));
  });

  // S4.10: 审批 (已认证+节点存在)
  it('S4.10 should approve pending node with auth', async () => {
    // 注册节点
    const pcRes = await request(app, 'GET', '/api/enroll/passcode', { headers: auth });
    await request(app, 'POST', '/api/enroll', {
      body: { passcode: pcRes.body.passcode, id: 'n1', name: 'N1' },
    });

    // 审批
    const res = await request(app, 'POST', '/api/enroll/n1/approve', {
      headers: auth,
      body: { tunAddr: '10.1.0.2' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);
  });

  // S4.13: 删除 (已认证)
  it('S4.13 should delete node with auth', async () => {
    const pcRes = await request(app, 'GET', '/api/enroll/passcode', { headers: auth });
    await request(app, 'POST', '/api/enroll', {
      body: { passcode: pcRes.body.passcode, id: 'del1', name: 'Del' },
    });

    const res = await request(app, 'DELETE', '/api/enroll/del1', { headers: auth });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.success);
  });

  // S4.16: 注册缺 id
  it('S4.16 should reject enrollment without id', async () => {
    const pcRes = await request(app, 'GET', '/api/enroll/passcode', { headers: auth });
    const res = await request(app, 'POST', '/api/enroll', {
      body: { passcode: pcRes.body.passcode, name: 'NoId' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.body.message.includes('id'));
  });
});
