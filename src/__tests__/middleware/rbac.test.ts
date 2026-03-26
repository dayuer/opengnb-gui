'use strict';

// T8: RED — RBAC 中间件测试
// 验证 requireRole 对 admin/operator/viewer 的拦截行为

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { mockReq, mockRes } = require('../helpers');

describe('middleware/rbac — requireRole', () => {
  const { requireRole, requireAuth, setJwtSecret, signJwt, setStore } = require('../../middleware/auth');

  beforeEach(() => {
    setJwtSecret('test-secret-for-rbac');
    // 无需 store，JWT 验证不查 DB
    setStore(null);
  });

  function makeReqWithRole(role: string) {
    const token = signJwt({ userId: 'u1', username: 'test', role });
    return mockReq({ headers: { authorization: `Bearer ${token}` } });
  }

  describe('requireRole("admin")', () => {
    const middleware = requireRole('admin');

    it('应放行 admin 角色', () => {
      const req = makeReqWithRole('admin');
      // 先执行 requireAuth 挂载 req.user
      const res1 = mockRes();
      let nextCalled1 = false;
      requireAuth(req, res1, () => { nextCalled1 = true; });
      assert.ok(nextCalled1, 'requireAuth 应放行');

      const res2 = mockRes();
      let nextCalled2 = false;
      middleware(req, res2, () => { nextCalled2 = true; });
      assert.ok(nextCalled2, 'admin 应被放行');
    });

    it('应拦截 operator 角色', () => {
      const req = makeReqWithRole('operator');
      const res1 = mockRes();
      requireAuth(req, res1, () => {});

      const res2 = mockRes();
      let nextCalled = false;
      middleware(req, res2, () => { nextCalled = true; });
      assert.equal(nextCalled, false, 'operator 不应被放行');
      assert.equal(res2._status, 403);
    });

    it('应拦截 viewer 角色', () => {
      const req = makeReqWithRole('viewer');
      const res1 = mockRes();
      requireAuth(req, res1, () => {});

      const res2 = mockRes();
      let nextCalled = false;
      middleware(req, res2, () => { nextCalled = true; });
      assert.equal(nextCalled, false, 'viewer 不应被放行');
      assert.equal(res2._status, 403);
    });
  });

  describe('requireRole("admin", "operator")', () => {
    const middleware = requireRole('admin', 'operator');

    it('应放行 admin', () => {
      const req = makeReqWithRole('admin');
      const res1 = mockRes();
      requireAuth(req, res1, () => {});
      const res2 = mockRes();
      let nextCalled = false;
      middleware(req, res2, () => { nextCalled = true; });
      assert.ok(nextCalled);
    });

    it('应放行 operator', () => {
      const req = makeReqWithRole('operator');
      const res1 = mockRes();
      requireAuth(req, res1, () => {});
      const res2 = mockRes();
      let nextCalled = false;
      middleware(req, res2, () => { nextCalled = true; });
      assert.ok(nextCalled);
    });

    it('应拦截 viewer', () => {
      const req = makeReqWithRole('viewer');
      const res1 = mockRes();
      requireAuth(req, res1, () => {});
      const res2 = mockRes();
      let nextCalled = false;
      middleware(req, res2, () => { nextCalled = true; });
      assert.equal(nextCalled, false);
      assert.equal(res2._status, 403);
    });
  });

  describe('无 user 对象', () => {
    it('应拦截未认证请求', () => {
      const middleware = requireRole('admin');
      const req = mockReq({});
      const res = mockRes();
      let nextCalled = false;
      middleware(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, false);
      assert.equal(res._status, 403);
    });
  });
});
