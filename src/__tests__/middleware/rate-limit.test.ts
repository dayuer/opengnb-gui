'use strict';

// @alpha: 速率限制中间件测试 — 覆盖 S2.1-S2.5

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mockReq, mockRes } = require('../helpers');
const { createRateLimit } = require('../../middleware/rate-limit');

describe('middleware/rate-limit', () => {
  // S2.1: 未超限 → 全部 200
  it('should allow requests under limit', () => {
    const limiter = createRateLimit({ windowMs: 60000, max: 5 });
    for (let i = 0; i < 3; i++) {
      const req = mockReq({ ip: '1.2.3.4' });
      const res = mockRes();
      let nextCalled = false;
      limiter(req, res, () => { nextCalled = true; });
      assert.equal(nextCalled, true);
      assert.equal(res._headers['X-RateLimit-Remaining'], 5 - (i + 1));
    }
  });

  // S2.2: 超限 → 429
  it('should reject requests over limit with 429', () => {
    const limiter = createRateLimit({ windowMs: 60000, max: 3 });
    const results = [];
    for (let i = 0; i < 5; i++) {
      const req = mockReq({ ip: '10.0.0.1' });
      const res = mockRes();
      let nextCalled = false;
      limiter(req, res, () => { nextCalled = true; });
      results.push({ status: res._status, next: nextCalled });
    }
    // 前 3 次放行
    assert.equal(results[0].next, true);
    assert.equal(results[1].next, true);
    assert.equal(results[2].next, true);
    // 后 2 次拒绝
    assert.equal(results[3].status, 429);
    assert.equal(results[3].next, false);
    assert.equal(results[4].status, 429);
    assert.equal(results[4].next, false);
  });

  // S2.4: IP 隔离
  it('should isolate rate limits by IP', () => {
    const limiter = createRateLimit({ windowMs: 60000, max: 2 });

    // IP A 发 2 次
    for (let i = 0; i < 2; i++) {
      const req = mockReq({ ip: '10.0.0.1' });
      const res = mockRes();
      limiter(req, res, () => {});
    }

    // IP B 发 1 次 — 应该放行
    const req = mockReq({ ip: '10.0.0.2' });
    const res = mockRes();
    let nextCalled = false;
    limiter(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });

  // S2.5: 响应头检查
  it('should set rate limit response headers', () => {
    const limiter = createRateLimit({ windowMs: 60000, max: 10 });
    const req = mockReq({ ip: '10.0.0.3' });
    const res = mockRes();
    limiter(req, res, () => {});
    assert.equal(res._headers['X-RateLimit-Limit'], 10);
    assert.equal(res._headers['X-RateLimit-Remaining'], 9);
    assert.ok(res._headers['X-RateLimit-Reset']); // ISO 日期
  });

  // S2.3: 窗口滑动 — 过期后重新计数
  it('should reset after window expires', async () => {
    const limiter = createRateLimit({ windowMs: 100, max: 2 });

    // 先用满限额
    for (let i = 0; i < 2; i++) {
      limiter(mockReq({ ip: '10.0.0.4' }), mockRes(), () => {});
    }
    // 超限
    const res1 = mockRes();
    limiter(mockReq({ ip: '10.0.0.4' }), res1, () => {});
    assert.equal(res1._status, 429);

    // 等待窗口过期
    await new Promise(r => setTimeout(r, 150));

    // 重新请求 — 应该放行
    const res2 = mockRes();
    let nextCalled = false;
    limiter(mockReq({ ip: '10.0.0.4' }), res2, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  });
});
