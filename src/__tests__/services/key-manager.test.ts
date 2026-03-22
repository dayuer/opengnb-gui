'use strict';

// @alpha: KeyManager 核心逻辑测试 — 覆盖 S5.1-S5.9 (V2: SQLite 适配, V3: 平台自动生成 NodeID)

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDataDir } = require('../helpers');

describe('services/key-manager', () => {
  let KeyManager, km, dataDir, cleanup;

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = tmpDataDir());
    delete require.cache[require.resolve('../../services/key-manager')];
    delete require.cache[require.resolve('../../services/node-store')];
    KeyManager = require('../../services/key-manager');
    km = new KeyManager({ dataDir });
    await km.init();
  });

  afterEach(() => {
    if (km && km.store && km.store.db) km.store.close();
    cleanup();
  });

  // @alpha: 辅助函数 — 注册并返回平台生成的 nodeId
  function enrollNode(km, name, overrides = {}) {
    const pc = km.generatePasscode();
    const result = km.submitEnrollment({ passcode: pc, id: name, name, ...overrides });
    assert.ok(result.success, `注册 ${name} 失败: ${result.message}`);
    assert.ok(result.nodeId, `注册 ${name} 未返回 nodeId`);
    assert.ok(result.nodeId.startsWith('node-'), `nodeId 格式错误: ${result.nodeId}`);
    return result.nodeId;
  }

  function enrollAndApprove(km, name, overrides = {}) {
    const nodeId = enrollNode(km, name, overrides);
    const result = km.approveNode(nodeId, {
      tunAddr: overrides.tunAddr || '10.1.0.10',
      gnbNodeId: overrides.gnbNodeId || '1002',
    });
    assert.ok(result.success, `审批 ${nodeId} 失败: ${result.message}`);
    return nodeId;
  }

  // S5.1: 初始化生成 ED25519 密钥对
  it('should generate ED25519 keypair on init', () => {
    assert.ok(fs.existsSync(km.privateKeyPath));
    assert.ok(fs.existsSync(km.publicKeyPath));
    const pubKey = km.getPublicKey();
    assert.ok(pubKey.startsWith('ssh-ed25519') || pubKey.includes('BEGIN'));
  });

  // S5.3: 注册持久化 — 平台自动生成 nodeId
  it('should persist enrollment to SQLite with platform-generated ID', () => {
    const nodeId = enrollNode(km, 'Test-Node');

    const all = km.getAllNodes();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, nodeId);
    assert.equal(all[0].name, 'Test-Node');
    assert.equal(all[0].status, 'pending');
  });

  // S5.4: 审批流转
  it('should approve pending node', () => {
    const nodeId = enrollNode(km, 'Node-2');
    const result = km.approveNode(nodeId, { tunAddr: '10.1.0.2' });
    assert.ok(result.success);

    const node = km.getAllNodes().find(n => n.id === nodeId);
    assert.equal(node.status, 'approved');
    assert.equal(node.tunAddr, '10.1.0.2');
    assert.ok(node.approvedAt);
  });

  // 幂等: 重复审批
  it('should handle duplicate approve idempotently', () => {
    const nodeId = enrollNode(km, 'Node-3');
    km.approveNode(nodeId);
    const result2 = km.approveNode(nodeId);
    assert.ok(result2.success);
    assert.ok(result2.message.includes('已审批'));
  });

  // S5.5: 拒绝流转
  it('should reject pending node', () => {
    const nodeId = enrollNode(km, 'Node-4');
    const result = km.rejectNode(nodeId);
    assert.ok(result.success);
    const node = km.getAllNodes().find(n => n.id === nodeId);
    assert.equal(node, undefined); // 拒绝即删除
  });

  // S5.6: 删除节点
  it('should remove node from list', () => {
    const nodeId = enrollNode(km, 'Node-5');
    assert.equal(km.getAllNodes().length, 1);
    km.removeNode(nodeId);
    assert.equal(km.getAllNodes().length, 0);
  });

  // S5.9: getApprovedNodesConfig 仅返回 approved
  it('should only return approved nodes in config', () => {
    const id1 = enrollNode(km, 'A1');
    enrollNode(km, 'A2');
    km.approveNode(id1, { tunAddr: '10.1.0.10' });

    const configs = km.getApprovedNodesConfig();
    assert.equal(configs.length, 1);
    assert.equal(configs[0].id, id1);
    assert.ok(configs[0].sshKeyPath);
    assert.ok(configs[0].groupId !== undefined); // @alpha: groupId 已合并
  });

  // Passcode 一次性使用 (S4.7)
  it('should reject reused passcode', () => {
    const passcode = km.generatePasscode();
    const r1 = km.submitEnrollment({ passcode, id: 'P1', name: 'P1' });
    assert.ok(r1.success);

    const r2 = km.submitEnrollment({ passcode, id: 'P2', name: 'P2' });
    assert.ok(!r2.success);
    assert.ok(r2.message.includes('已使用'));
  });

  // S5.7: SQLite 持久化验证
  it('should persist across reinit (SQLite durability)', async () => {
    for (let i = 0; i < 5; i++) {
      enrollNode(km, `D${i}`);
    }
    assert.equal(km.getAllNodes().length, 5);
    km.store.close();

    // 重新初始化 — 数据应保留
    const km2 = new KeyManager({ dataDir });
    await km2.init();
    assert.equal(km2.getAllNodes().length, 5);
    // @alpha: 验证 name 字段保留
    const names = km2.getAllNodes().map(n => n.name).sort();
    assert.deepStrictEqual(names, ['D0', 'D1', 'D2', 'D3', 'D4']);
    km2.store.close();
  });

  // S5.8: SQLite 跨实例持久化
  it('should persist approvals across reinit', async () => {
    const nodeId = enrollAndApprove(km, 'Persist', { tunAddr: '10.5.0.1' });
    km.store.close();

    const km2 = new KeyManager({ dataDir });
    await km2.init();
    const node = km2.getAllNodes().find(n => n.id === nodeId);
    assert.ok(node);
    assert.equal(node.status, 'approved');
    assert.equal(node.tunAddr, '10.5.0.1');
    km2.store.close();
  });

  // ═══════════════════════════════════════
  // @alpha: updateNode 编辑节点信息测试
  // ═══════════════════════════════════════

  describe('updateNode', () => {
    it('should update tunAddr', () => {
      const id = enrollAndApprove(km, 'U1');
      const result = km.updateNode(id, { tunAddr: '10.2.0.2' });
      assert.ok(result.success);
      assert.deepStrictEqual(result.changedFields, ['tunAddr']);
      assert.equal(km.getAllNodes().find(n => n.id === id).tunAddr, '10.2.0.2');
    });

    it('should update name', () => {
      const id = enrollAndApprove(km, 'U2');
      const result = km.updateNode(id, { name: '新名称' });
      assert.ok(result.success);
      assert.deepStrictEqual(result.changedFields, ['name']);
    });

    it('should update sshPort', () => {
      const id = enrollAndApprove(km, 'U3');
      const result = km.updateNode(id, { sshPort: 2222 });
      assert.ok(result.success);
      assert.equal(km.getAllNodes().find(n => n.id === id).sshPort, 2222);
    });

    it('should update sshUser', () => {
      const id = enrollAndApprove(km, 'U4');
      const result = km.updateNode(id, { sshUser: 'admin' });
      assert.ok(result.success);
      assert.equal(km.getAllNodes().find(n => n.id === id).sshUser, 'admin');
    });

    it('should update multiple fields at once', () => {
      const id = enrollAndApprove(km, 'U5');
      const result = km.updateNode(id, { tunAddr: '10.3.0.1', sshPort: 8022 });
      assert.ok(result.success);
      assert.deepStrictEqual(result.changedFields.sort(), ['sshPort', 'tunAddr']);
    });

    it('should reject invalid IPv4 (5 octets)', () => {
      const id = enrollAndApprove(km, 'U6');
      const result = km.updateNode(id, { tunAddr: '10.2.0.0.2' });
      assert.ok(!result.success);
      assert.ok(result.message.includes('IP 格式错误'));
    });

    it('should reject duplicate tunAddr (CONFLICT)', () => {
      const id1 = enrollAndApprove(km, 'U7a', { tunAddr: '10.1.0.20' });
      const id2 = enrollAndApprove(km, 'U7b', { tunAddr: '10.1.0.21' });
      const result = km.updateNode(id2, { tunAddr: '10.1.0.20' });
      assert.ok(!result.success);
      assert.equal(result.code, 'CONFLICT');
    });

    it('should reject port out of range', () => {
      const id = enrollAndApprove(km, 'U8');
      const r1 = km.updateNode(id, { sshPort: 0 });
      assert.ok(!r1.success);
      const r2 = km.updateNode(id, { sshPort: 99999 });
      assert.ok(!r2.success);
    });

    it('should reject non-approved node', () => {
      const nodeId = enrollNode(km, 'U9-Pending');
      const result = km.updateNode(nodeId, { name: 'Updated' });
      assert.ok(!result.success);
      assert.ok(result.message.includes('仅已审批'));
    });

    it('should return no changes when same values', () => {
      const id = enrollAndApprove(km, 'U10', { tunAddr: '10.1.0.50' });
      const result = km.updateNode(id, { tunAddr: '10.1.0.50' });
      assert.ok(result.success);
      assert.deepStrictEqual(result.changedFields, []);
      assert.ok(result.message.includes('无变更'));
    });
  });

  // ═══════════════════════════════════════
  // @alpha: enrollToken 测试
  // ═══════════════════════════════════════

  describe('enrollToken', () => {
    it('should return enrollToken on successful enrollment', () => {
      const passcode = km.generatePasscode();
      const result = km.submitEnrollment({ passcode, id: 'ET1', name: 'ET1' });
      assert.ok(result.success);
      assert.ok(result.enrollToken);
      assert.equal(typeof result.enrollToken, 'string');
      assert.equal(result.enrollToken.length, 32); // 16 bytes hex
      // @alpha: 验证返回平台生成的 nodeId
      assert.ok(result.nodeId);
      assert.ok(result.nodeId.startsWith('node-'));
    });

    it('should NOT return enrollToken on failed enrollment', () => {
      const result = km.submitEnrollment({ passcode: 'invalid', id: 'ET2', name: 'ET2' });
      assert.ok(!result.success);
      assert.equal(result.enrollToken, undefined);
    });

    it('should verify valid enrollToken', () => {
      const passcode = km.generatePasscode();
      const { enrollToken, nodeId } = km.submitEnrollment({ passcode, id: 'ET3', name: 'ET3' });
      const check = km.verifyEnrollToken(enrollToken);
      assert.ok(check.valid);
      // @alpha: enrollToken 绑定的是平台生成的 nodeId，不是 hostname
      assert.equal(check.nodeId, nodeId);
      assert.ok(check.nodeId.startsWith('node-'));
    });

    it('should reject invalid enrollToken', () => {
      const check = km.verifyEnrollToken('nonexistent-token');
      assert.ok(!check.valid);
    });

    it('should reject null/undefined enrollToken', () => {
      assert.ok(!km.verifyEnrollToken(null).valid);
      assert.ok(!km.verifyEnrollToken(undefined).valid);
      assert.ok(!km.verifyEnrollToken('').valid);
    });

    it('should return enrollToken for already-approved node re-enrollment', () => {
      const nodeId = enrollAndApprove(km, 'ET4', { tunAddr: '10.1.0.40' });

      // @alpha: 重复注册同名节点 — 通过 name 匹配找到已审批的节点
      const pc2 = km.generatePasscode();
      const result = km.submitEnrollment({ passcode: pc2, id: 'ET4', name: 'ET4' });
      assert.ok(result.success);
      assert.equal(result.status, 'approved');
      assert.ok(result.enrollToken);
      assert.equal(result.nodeId, nodeId); // 返回原有 ID
    });
  });

  // ═══════════════════════════════════════
  // @alpha: passcode TTL 测试
  // ═══════════════════════════════════════

  describe('passcode TTL', () => {
    it('should accept fresh passcode', () => {
      const passcode = km.generatePasscode();
      const result = km.submitEnrollment({ passcode, id: 'TTL1', name: 'TTL1' });
      assert.ok(result.success);
    });

    it('should reject expired passcode (>30min)', () => {
      const passcode = km.generatePasscode();
      // 手动将 createdAt 设回 31 分钟前
      const pc = km.passcodes.get(passcode);
      pc.createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();

      const result = km.submitEnrollment({ passcode, id: 'TTL2', name: 'TTL2' });
      assert.ok(!result.success);
      assert.ok(result.message.includes('已过期'));
    });

    it('should accept passcode at 29 minutes', () => {
      const passcode = km.generatePasscode();
      const pc = km.passcodes.get(passcode);
      pc.createdAt = new Date(Date.now() - 29 * 60 * 1000).toISOString();

      const result = km.submitEnrollment({ passcode, id: 'TTL3', name: 'TTL3' });
      assert.ok(result.success);
    });
  });

  // ═══════════════════════════════════════
  // @alpha: 平台 NodeID 生成测试
  // ═══════════════════════════════════════

  describe('platform NodeID generation', () => {
    it('should generate unique IDs for different nodes', () => {
      const id1 = enrollNode(km, 'Same-Host');
      const pc2 = km.generatePasscode();
      // 不同 passcode 相同 hostname → 会被 findByName 匹配
      const result2 = km.submitEnrollment({ passcode: pc2, id: 'Different-Host', name: 'Different-Host' });
      assert.ok(result2.success);
      assert.notEqual(id1, result2.nodeId);
    });

    it('should store hostname as name field', () => {
      const nodeId = enrollNode(km, 'my-server-01');
      const node = km.store.findById(nodeId);
      assert.equal(node.name, 'my-server-01');
      assert.ok(node.id.startsWith('node-'));
      assert.notEqual(node.id, 'my-server-01');
    });

    it('should find existing node by name on re-enrollment', () => {
      const nodeId = enrollNode(km, 'repeat-host');
      const pc2 = km.generatePasscode();
      const result2 = km.submitEnrollment({ passcode: pc2, id: 'repeat-host', name: 'repeat-host' });
      assert.ok(result2.success);
      assert.equal(result2.nodeId, nodeId); // 同一个节点
    });
  });
});
