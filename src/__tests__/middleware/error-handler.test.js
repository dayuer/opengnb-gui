'use strict';

// @alpha: 统一错误处理中间件测试 — 覆盖 S8.1-S8.3

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mockReq, mockRes } = require('../helpers');
const { errorHandler } = require('../../middleware/error-handler');

describe('middleware/error-handler', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = originalEnv; });

  // S8.1: 生产环境屏蔽内部错误
  it('should mask error details in production', () => {
    process.env.NODE_ENV = 'production';
    const req = mockReq({ method: 'GET', path: '/api/test' });
    const res = mockRes();
    errorHandler(new Error('数据库连接失败: password=xxx'), req, res, () => {});
    assert.equal(res._status, 500);
    assert.ok(res._json.error.includes('服务器内部错误'));
    assert.ok(!res._json.error.includes('数据库'));
  });

  // S8.2: 开发环境透传错误消息
  it('should show error details in development', () => {
    process.env.NODE_ENV = 'development';
    const req = mockReq({ method: 'GET', path: '/api/test' });
    const res = mockRes();
    errorHandler(new Error('具体错误信息'), req, res, () => {});
    assert.equal(res._status, 500);
    assert.equal(res._json.error, '具体错误信息');
  });

  // S8.3: 自定义状态码
  it('should use custom statusCode from error', () => {
    process.env.NODE_ENV = 'development';
    const err = new Error('未找到资源');
    err.statusCode = 422;
    const req = mockReq({ method: 'GET', path: '/api/test' });
    const res = mockRes();
    errorHandler(err, req, res, () => {});
    assert.equal(res._status, 422);
  });

  // 非 500 错误在生产环境也应透传消息
  it('should show error message for non-500 errors in production', () => {
    process.env.NODE_ENV = 'production';
    const err = new Error('参数无效');
    err.statusCode = 400;
    const req = mockReq({ method: 'POST', path: '/api/test' });
    const res = mockRes();
    errorHandler(err, req, res, () => {});
    assert.equal(res._status, 400);
    assert.equal(res._json.error, '参数无效');
  });
});
