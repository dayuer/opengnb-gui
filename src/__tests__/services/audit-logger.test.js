'use strict';

// @beta: 审计日志测试 — 覆盖 S6.1-S6.4

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDataDir, mockReq } = require('../helpers');
const AuditLogger = require('../../services/audit-logger');

describe('services/audit-logger', () => {
  let dataDir, cleanup, audit;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = tmpDataDir());
    audit = new AuditLogger({ dataDir });
  });

  afterEach(() => { cleanup(); });

  // S6.1: 写入日志 — JSONL 格式
  it('should write JSONL entries to audit.log', () => {
    audit.log('test_action', { target: 'node-1' });
    audit.log('test_action', { target: 'node-2' });

    const content = fs.readFileSync(audit.logPath, 'utf-8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.action, 'test_action');
    assert.equal(entry.target, 'node-1');
    assert.ok(entry.ts); // 有时间戳
    assert.equal(entry.actor, 'system'); // 无 req 时为 system
  });

  // S6.2: 脱敏 — token/passcode 字段替换为 ***
  it('should sanitize sensitive fields in body', () => {
    const req = mockReq({ method: 'POST', path: '/test', body: { token: 'secret-value', name: 'visible' } });
    const middleware = audit.middleware('test');
    middleware(req, {}, () => {});

    const content = fs.readFileSync(audit.logPath, 'utf-8');
    const entry = JSON.parse(content.trim());
    assert.equal(entry.body.token, '***');
    assert.equal(entry.body.name, 'visible');
  });

  // S6.4: 中间件记录 method/path/ip
  it('should record method, path, and IP via middleware', () => {
    const req = mockReq({ method: 'POST', path: '/api/approve', ip: '192.168.1.1' });
    const middleware = audit.middleware('approve');
    middleware(req, {}, () => {});

    const content = fs.readFileSync(audit.logPath, 'utf-8');
    const entry = JSON.parse(content.trim());
    assert.equal(entry.action, 'approve');
    assert.equal(entry.method, 'POST');
    assert.equal(entry.path, '/api/approve');
    assert.equal(entry.actor, '192.168.1.1');
  });

  // S6.3: 轮转 — 超过 maxSize 时归档
  it('should rotate log when exceeding maxSize', () => {
    const smallAudit = new AuditLogger({ dataDir, maxSizeMB: 0.0001 }); // ~100 bytes
    // 写入足够多的数据触发轮转
    for (let i = 0; i < 20; i++) {
      smallAudit.log('bulk', { data: 'x'.repeat(50) });
    }

    const archives = fs.readdirSync(smallAudit.archiveDir);
    assert.ok(archives.length > 0, '应有归档文件');
  });
});
