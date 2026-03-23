'use strict';

// @alpha: 认证中间件测试 — 覆盖 S1.1-S1.6

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mockReq, mockRes } = require('../helpers');

describe('middleware/auth', () => {
  let requireAuth, initToken, getAdminToken;

  beforeEach(() => {
    // 每次重新加载模块以隔离状态
    delete require.cache[require.resolve('../../middleware/auth')];
    process.env.ADMIN_TOKEN = 'test-secret-token';
    const mod = require('../../middleware/auth');
    requireAuth = mod.requireAuth;
    initToken = mod.initToken;
    getAdminToken = mod.getAdminToken;
    initToken(); // 初始化 Token
  });

  // S1.1: 无 Authorization 头 → 401
  it('should reject request without Authorization header', () => {
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.ok(res._json.error.includes('未提供'));
    assert.equal(nextCalled, false);
  });

  // S1.2: 非 Bearer 格式 → 401
  it('should reject non-Bearer authorization', () => {
    const req = mockReq({ headers: { authorization: 'Basic abc123' } });
    const res = mockRes();
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
  });

  // S1.3: 错误 Token → 401
  it('should reject wrong token', () => {
    const req = mockReq({ headers: { authorization: 'Bearer wrong-token' } });
    const res = mockRes();
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.ok(res._json.error.includes('无效'));
    assert.equal(nextCalled, false);
  });

  // S1.4: 正确 Token → 放行
  it('should pass with correct token', () => {
    const req = mockReq({ headers: { authorization: 'Bearer test-secret-token' } });
    const res = mockRes();
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res._status, 200); // 未被修改
  });

  // S1.5: Bearer 后空值 → 401
  it('should reject empty bearer value', () => {
    const req = mockReq({ headers: { authorization: 'Bearer ' } });
    const res = mockRes();
    let nextCalled = false;
    requireAuth(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(nextCalled, false);
  });

  // S1.6: 未设置 ADMIN_TOKEN → 自动生成
  it('should auto-generate token when ADMIN_TOKEN is not set', () => {
    delete require.cache[require.resolve('../../middleware/auth')];
    delete process.env.ADMIN_TOKEN;
    const mod = require('../../middleware/auth');
    const token = mod.initToken();
    assert.ok(token.length === 48); // 24 bytes → 48 hex chars
    assert.equal(mod.getAdminToken(), token);
  });
});

// ═══════════════════════════════════════
// resolveToken — 统一 Token 解析器
// ═══════════════════════════════════════

describe('resolveToken', () => {
  let resolveToken, setJwtSecret, signJwt, setStore, initToken;

  beforeEach(() => {
    delete require.cache[require.resolve('../../middleware/auth')];
    process.env.ADMIN_TOKEN = 'test-admin-token';
    const mod = require('../../middleware/auth');
    resolveToken = mod.resolveToken;
    setJwtSecret = mod.setJwtSecret;
    signJwt = mod.signJwt;
    setStore = mod.setStore;
    initToken = mod.initToken;
    initToken();
    setJwtSecret('test-secret-key-for-resolveToken');
  });

  it('should resolve adminToken → { valid: true, userId: "admin" }', () => {
    const result = resolveToken('test-admin-token');
    assert.ok(result.valid);
    assert.equal(result.userId, 'admin');
  });

  it('should resolve valid JWT → { valid: true, userId }', () => {
    const jwt = signJwt({ userId: 'user-123', username: 'alice', role: 'admin' });
    const result = resolveToken(jwt);
    assert.ok(result.valid);
    assert.equal(result.userId, 'user-123');
  });

  it('should resolve valid apiToken → { valid: true, userId }', () => {
    const mockStore = {
      _stmts: {
        findUserByApiToken: {
          get: (token) => token === 'api-token-abc' ? { id: 'u-42', username: 'bob' } : undefined,
        },
      },
    };
    setStore(mockStore);
    const result = resolveToken('api-token-abc');
    assert.ok(result.valid);
    assert.equal(result.userId, 'u-42');
  });

  it('should reject invalid token → { valid: false }', () => {
    const result = resolveToken('completely-wrong');
    assert.equal(result.valid, false);
  });

  it('should reject null/undefined/empty', () => {
    assert.equal(resolveToken(null).valid, false);
    assert.equal(resolveToken(undefined).valid, false);
    assert.equal(resolveToken('').valid, false);
  });

  it('should prefer JWT over adminToken when both could match', () => {
    // JWT 有三段，adminToken 通常没有 → JWT 优先尝试
    const jwt = signJwt({ userId: 'jwt-user', role: 'admin' });
    const result = resolveToken(jwt);
    assert.ok(result.valid);
    assert.equal(result.userId, 'jwt-user');
  });
});
