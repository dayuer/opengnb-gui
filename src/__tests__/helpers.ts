'use strict';

/**
 * 测试辅助工具
 * 提供 mock Express req/res 对象, 临时目录等
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

/**
 * 创建 mock Express Request 对象
 */
function mockReq(overrides = {}) {
  return {
    method: 'GET',
    path: '/',
    headers: {},
    ip: '127.0.0.1',
    body: {},
    query: {},
    params: {},
    ...overrides,
  };
}

/**
 * 创建 mock Express Response 对象 (带链式调用)
 */
function mockRes() {
  const res = {
    _status: 200,
    _json: null,
    _headers: {},
    status(code) { res._status = code; return res; },
    json(data) { res._json = data; return res; },
    setHeader(key, value) { res._headers[key] = value; return res; },
    getHeader(key) { return res._headers[key]; },
  };
  return res;
}

/**
 * 创建隔离的临时数据目录
 * @returns {{ dir: string, cleanup: Function }}
 */
function tmpDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnb-test-'));
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, cleanup };
}

/**
 * 用 Express app 发送 HTTP 请求
 * @param {express.Application} app
 * @param {string} method
 * @param {string} path
 * @param {object} [options]
 * @returns {Promise<{statusCode: number, body: object, headers: object}>}
 */
function request(app, method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const bodyStr = options.body ? JSON.stringify(options.body) : '';
      const reqOptions = {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: method.toUpperCase(),
        headers: {
          ...options.headers,
          ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };

      const req = http.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          let body;
          try { body = JSON.parse(data); } catch { body = data; }
          resolve({ statusCode: res.statusCode, body, headers: res.headers });
        });
      });

      req.on('error', (err) => { server.close(); reject(err); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

module.exports = { mockReq, mockRes, tmpDataDir, request };
