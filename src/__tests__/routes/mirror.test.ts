'use strict';

// @beta: 镜像路由安全测试 — 覆盖 S7.1-S7.4

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { request, tmpDataDir } = require('../helpers');

describe('routes/mirror security', () => {
  let app, dataDir, cleanup;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = tmpDataDir());

    // 创建镜像目录和测试文件
    const gnbDir = path.join(dataDir, 'mirror', 'gnb');
    fs.mkdirSync(gnbDir, { recursive: true });
    fs.writeFileSync(path.join(gnbDir, 'gnb-linux-amd64.tar.gz'), 'fake-binary');
    fs.writeFileSync(path.join(gnbDir, '.version'), '1.0.0');

    app = express();
    const createMirrorRouter = require('../../routes/mirror');
    app.use('/api/mirror', createMirrorRouter(dataDir));
  });

  afterEach(() => { cleanup(); });

  // S7.4: 文件列表
  it('S7.4 should return file list for gnb', async () => {
    const res = await request(app, 'GET', '/api/mirror/gnb');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.software, 'gnb');
    assert.equal(res.body.version, '1.0.0');
    assert.ok(Array.isArray(res.body.files));
    assert.ok(res.body.files.length > 0);
  });

  // S7.1: 正常下载
  it('S7.1 should download valid file', async () => {
    const res = await request(app, 'GET', '/api/mirror/gnb/gnb-linux-amd64.tar.gz');
    assert.equal(res.statusCode, 200);
  });

  // S7.2: 路径遍历
  it('S7.2 should reject path traversal ..', async () => {
    const res = await request(app, 'GET', '/api/mirror/gnb/..%2F..%2Fetc%2Fpasswd');
    // basename 会处理编码，应返回 400 或 404
    assert.ok([400, 404].includes(res.statusCode));
  });

  // S7.3: 文件不存在
  it('S7.3 should return 404 for nonexistent file', async () => {
    const res = await request(app, 'GET', '/api/mirror/gnb/nonexistent.tar.gz');
    assert.equal(res.statusCode, 404);
  });

  // 额外: 点文件过滤
  it('should filter hidden files from listing', async () => {
    const res = await request(app, 'GET', '/api/mirror/gnb');
    const names = res.body.files.map(f => f.name);
    // .version 是隐藏文件，不应出现在列表中
    assert.ok(!names.includes('.version'));
  });
});
