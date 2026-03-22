'use strict';

// @beta: 审计日志测试 — 覆盖 S6.1-S6.4 (SQLite 版)

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { tmpDataDir, mockReq } = require('../helpers');

describe('services/audit-logger (SQLite)', () => {
  let AuditLogger, NodeStore, nodeStore, audit, dataDir, cleanup;

  beforeEach(() => {
    ({ dir: dataDir, cleanup } = tmpDataDir());
    NodeStore = require('../../services/node-store');
    AuditLogger = require('../../services/audit-logger');
    nodeStore = new NodeStore(path.join(dataDir, 'nodes.db'));
    nodeStore.init();
    audit = new AuditLogger({ store: nodeStore });
  });

  afterEach(() => { nodeStore.close(); cleanup(); });

  // S6.1: 写入日志
  it('should write audit entries to SQLite', () => {
    audit.log('test_action', { target: 'node-1' });
    audit.log('test_action', { target: 'node-2' });

    assert.equal(audit.count(), 2);
    const rows = audit.query({});
    assert.equal(rows.length, 2);
    // 最新的在前
    assert.equal(rows[0].action, 'test_action');
    assert.ok(rows[0].ts);
    assert.equal(rows[0].actor, 'system');
  });

  // S6.2: 脱敏
  it('should sanitize sensitive fields in body', () => {
    const req = mockReq({ method: 'POST', path: '/test', body: { token: 'secret-value', name: 'visible' } });
    const middleware = audit.middleware('test');
    middleware(req, {}, () => {});

    const rows = audit.query({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail.body.token, '***');
    assert.equal(rows[0].detail.body.name, 'visible');
  });

  // S6.4: 中间件记录 method/path/ip
  it('should record method, path, and IP via middleware', () => {
    const req = mockReq({ method: 'POST', path: '/api/approve', ip: '192.168.1.1' });
    const middleware = audit.middleware('approve');
    middleware(req, {}, () => {});

    const rows = audit.query({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'approve');
    assert.equal(rows[0].detail.method, 'POST');
    assert.equal(rows[0].detail.path, '/api/approve');
    assert.equal(rows[0].actor, '192.168.1.1');
  });

  // S6.3: 条数限制清理
  it('should rotate when exceeding maxEntries', () => {
    const smallAudit = new AuditLogger({ store: nodeStore, maxEntries: 10 });
    for (let i = 0; i < 20; i++) {
      smallAudit.log('bulk', { data: `item-${i}` });
    }
    // 应保留约 9 条（删除最旧的 10%）
    assert.ok(smallAudit.count() <= 10, `应 <= 10 条，实际 ${smallAudit.count()}`);
    assert.ok(smallAudit.count() > 0);
  });

  // 按 action 查询
  it('should filter by action', () => {
    audit.log('auth_fail', { ip: '1.2.3.4' });
    audit.log('approve', { node: 'n1' });
    audit.log('auth_fail', { ip: '5.6.7.8' });

    const filtered = audit.query({ action: 'auth_fail' });
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(r => r.action === 'auth_fail'));
  });

  // 持久化
  it('should persist across reinit', () => {
    audit.log('test', { val: 42 });
    nodeStore.close();

    const ns2 = new NodeStore(path.join(dataDir, 'nodes.db'));
    ns2.init();
    const audit2 = new AuditLogger({ store: ns2 });
    assert.equal(audit2.count(), 1);
    ns2.close();
  });
});
