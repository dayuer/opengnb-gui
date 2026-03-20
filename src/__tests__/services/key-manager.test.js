'use strict';

// @alpha: KeyManager 核心逻辑测试 — 覆盖 S5.1-S5.9 (V2: SQLite 适配)

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

  // S5.1: 初始化生成 ED25519 密钥对
  it('should generate ED25519 keypair on init', () => {
    assert.ok(fs.existsSync(km.privateKeyPath));
    assert.ok(fs.existsSync(km.publicKeyPath));
    const pubKey = km.getPublicKey();
    assert.ok(pubKey.startsWith('ssh-ed25519') || pubKey.includes('BEGIN'));
  });

  // S5.2: (Removed) JSON→SQLite 迁移已完成，测试已废弃

  // S5.3: 注册持久化（V2: 通过 getAllNodes 验证而非读文件）
  it('should persist enrollment to SQLite', () => {
    const passcode = km.generatePasscode('test');
    km.submitEnrollment({ passcode, id: 'node-1', name: 'Test Node' });

    const all = km.getAllNodes();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'node-1');
    assert.equal(all[0].status, 'pending');
    assert.equal(all[0].passcode, undefined);
  });

  // S5.4: 审批流转
  it('should approve pending node', () => {
    const passcode = km.generatePasscode();
    km.submitEnrollment({ passcode, id: 'n2', name: 'Node 2' });
    const result = km.approveNode('n2', { tunAddr: '10.1.0.2' });
    assert.ok(result.success);

    const node = km.getAllNodes().find(n => n.id === 'n2');
    assert.equal(node.status, 'approved');
    assert.equal(node.tunAddr, '10.1.0.2');
    assert.ok(node.approvedAt);
  });

  // 幂等: 重复审批
  it('should handle duplicate approve idempotently', () => {
    const passcode = km.generatePasscode();
    km.submitEnrollment({ passcode, id: 'n3', name: 'Node 3' });
    km.approveNode('n3');
    const result2 = km.approveNode('n3');
    assert.ok(result2.success);
    assert.ok(result2.message.includes('已审批'));
  });

  // S5.5: 拒绝流转
  it('should reject pending node', () => {
    const passcode = km.generatePasscode();
    km.submitEnrollment({ passcode, id: 'n4', name: 'Node 4' });
    const result = km.rejectNode('n4');
    assert.ok(result.success);
    const node = km.getAllNodes().find(n => n.id === 'n4');
    assert.equal(node.status, 'rejected');
  });

  // S5.6: 删除节点
  it('should remove node from list', () => {
    const passcode = km.generatePasscode();
    km.submitEnrollment({ passcode, id: 'n5', name: 'Node 5' });
    assert.equal(km.getAllNodes().length, 1);
    km.removeNode('n5');
    assert.equal(km.getAllNodes().length, 0);
  });

  // S5.9: getApprovedNodesConfig 仅返回 approved
  it('should only return approved nodes in config', () => {
    const pc1 = km.generatePasscode();
    const pc2 = km.generatePasscode();
    km.submitEnrollment({ passcode: pc1, id: 'a1', name: 'A1', tunAddr: '10.1.0.10' });
    km.submitEnrollment({ passcode: pc2, id: 'a2', name: 'A2', tunAddr: '10.1.0.11' });
    km.approveNode('a1');

    const configs = km.getApprovedNodesConfig();
    assert.equal(configs.length, 1);
    assert.equal(configs[0].id, 'a1');
    assert.ok(configs[0].sshKeyPath);
  });

  // Passcode 一次性使用 (S4.7)
  it('should reject reused passcode', () => {
    const passcode = km.generatePasscode();
    const r1 = km.submitEnrollment({ passcode, id: 'p1', name: 'P1' });
    assert.ok(r1.success);

    const r2 = km.submitEnrollment({ passcode, id: 'p2', name: 'P2' });
    assert.ok(!r2.success);
    assert.ok(r2.message.includes('已使用'));
  });

  // S5.7: SQLite 持久化验证（替代旧备份轮转测试）
  it('should persist across reinit (SQLite durability)', async () => {
    for (let i = 0; i < 5; i++) {
      const pc = km.generatePasscode();
      km.submitEnrollment({ passcode: pc, id: `d${i}`, name: `D${i}` });
    }
    assert.equal(km.getAllNodes().length, 5);
    km.store.close();

    // 重新初始化 — 数据应保留
    const km2 = new KeyManager({ dataDir });
    await km2.init();
    assert.equal(km2.getAllNodes().length, 5);
    km2.store.close();
  });

  // S5.8: SQLite 跨实例持久化
  it('should persist approvals across reinit', async () => {
    const pc = km.generatePasscode();
    km.submitEnrollment({ passcode: pc, id: 'persist', name: 'Persist' });
    km.approveNode('persist', { tunAddr: '10.5.0.1' });
    km.store.close();

    const km2 = new KeyManager({ dataDir });
    await km2.init();
    const node = km2.getAllNodes().find(n => n.id === 'persist');
    assert.ok(node);
    assert.equal(node.status, 'approved');
    assert.equal(node.tunAddr, '10.5.0.1');
    km2.store.close();
  });

  // ═══════════════════════════════════════
  // @alpha: updateNode 编辑节点信息测试
  // ═══════════════════════════════════════

  function createApprovedNode(km, id, overrides = {}) {
    const pc = km.generatePasscode();
    km.submitEnrollment({ passcode: pc, id, name: overrides.name || id });
    km.approveNode(id, { tunAddr: overrides.tunAddr || '10.1.0.10', gnbNodeId: overrides.gnbNodeId || '1002' });
    return km.getAllNodes().find(n => n.id === id);
  }

  describe('updateNode', () => {
    it('should update tunAddr', () => {
      createApprovedNode(km, 'u1');
      const result = km.updateNode('u1', { tunAddr: '10.2.0.2' });
      assert.ok(result.success);
      assert.deepStrictEqual(result.changedFields, ['tunAddr']);
      assert.equal(km.getAllNodes().find(n => n.id === 'u1').tunAddr, '10.2.0.2');
    });

    it('should update name', () => {
      createApprovedNode(km, 'u2');
      const result = km.updateNode('u2', { name: '新名称' });
      assert.ok(result.success);
      assert.deepStrictEqual(result.changedFields, ['name']);
    });

    it('should update sshPort', () => {
      createApprovedNode(km, 'u3');
      const result = km.updateNode('u3', { sshPort: 2222 });
      assert.ok(result.success);
      assert.equal(km.getAllNodes().find(n => n.id === 'u3').sshPort, 2222);
    });

    it('should update sshUser', () => {
      createApprovedNode(km, 'u4');
      const result = km.updateNode('u4', { sshUser: 'admin' });
      assert.ok(result.success);
      assert.equal(km.getAllNodes().find(n => n.id === 'u4').sshUser, 'admin');
    });

    it('should update multiple fields at once', () => {
      createApprovedNode(km, 'u5');
      const result = km.updateNode('u5', { tunAddr: '10.3.0.1', sshPort: 8022 });
      assert.ok(result.success);
      assert.deepStrictEqual(result.changedFields.sort(), ['sshPort', 'tunAddr']);
    });

    it('should reject invalid IPv4 (5 octets)', () => {
      createApprovedNode(km, 'u6');
      const result = km.updateNode('u6', { tunAddr: '10.2.0.0.2' });
      assert.ok(!result.success);
      assert.ok(result.message.includes('IP 格式错误'));
    });

    it('should reject duplicate tunAddr (CONFLICT)', () => {
      createApprovedNode(km, 'u7a', { tunAddr: '10.1.0.20' });
      createApprovedNode(km, 'u7b', { tunAddr: '10.1.0.21' });
      const result = km.updateNode('u7b', { tunAddr: '10.1.0.20' });
      assert.ok(!result.success);
      assert.equal(result.code, 'CONFLICT');
    });

    it('should reject port out of range', () => {
      createApprovedNode(km, 'u8');
      const r1 = km.updateNode('u8', { sshPort: 0 });
      assert.ok(!r1.success);
      const r2 = km.updateNode('u8', { sshPort: 99999 });
      assert.ok(!r2.success);
    });

    it('should reject non-approved node', () => {
      const pc = km.generatePasscode();
      km.submitEnrollment({ passcode: pc, id: 'u9', name: 'Pending' });
      const result = km.updateNode('u9', { name: 'Updated' });
      assert.ok(!result.success);
      assert.ok(result.message.includes('仅已审批'));
    });

    it('should return no changes when same values', () => {
      createApprovedNode(km, 'u10', { tunAddr: '10.1.0.50' });
      const result = km.updateNode('u10', { tunAddr: '10.1.0.50' });
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
      const result = km.submitEnrollment({ passcode, id: 'et1', name: 'ET1' });
      assert.ok(result.success);
      assert.ok(result.enrollToken);
      assert.equal(typeof result.enrollToken, 'string');
      assert.equal(result.enrollToken.length, 32); // 16 bytes hex
    });

    it('should NOT return enrollToken on failed enrollment', () => {
      const result = km.submitEnrollment({ passcode: 'invalid', id: 'et2', name: 'ET2' });
      assert.ok(!result.success);
      assert.equal(result.enrollToken, undefined);
    });

    it('should verify valid enrollToken', () => {
      const passcode = km.generatePasscode();
      const { enrollToken } = km.submitEnrollment({ passcode, id: 'et3', name: 'ET3' });
      const check = km.verifyEnrollToken(enrollToken);
      assert.ok(check.valid);
      assert.equal(check.nodeId, 'et3');
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
      const pc1 = km.generatePasscode();
      km.submitEnrollment({ passcode: pc1, id: 'et4', name: 'ET4' });
      km.approveNode('et4', { tunAddr: '10.1.0.40' });

      const pc2 = km.generatePasscode();
      const result = km.submitEnrollment({ passcode: pc2, id: 'et4', name: 'ET4' });
      assert.ok(result.success);
      assert.equal(result.status, 'approved');
      assert.ok(result.enrollToken);
    });
  });

  // ═══════════════════════════════════════
  // @alpha: passcode TTL 测试
  // ═══════════════════════════════════════

  describe('passcode TTL', () => {
    it('should accept fresh passcode', () => {
      const passcode = km.generatePasscode();
      const result = km.submitEnrollment({ passcode, id: 'ttl1', name: 'TTL1' });
      assert.ok(result.success);
    });

    it('should reject expired passcode (>30min)', () => {
      const passcode = km.generatePasscode();
      // 手动将 createdAt 设回 31 分钟前
      const pc = km.passcodes.get(passcode);
      pc.createdAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();

      const result = km.submitEnrollment({ passcode, id: 'ttl2', name: 'TTL2' });
      assert.ok(!result.success);
      assert.ok(result.message.includes('已过期'));
    });

    it('should accept passcode at 29 minutes', () => {
      const passcode = km.generatePasscode();
      const pc = km.passcodes.get(passcode);
      pc.createdAt = new Date(Date.now() - 29 * 60 * 1000).toISOString();

      const result = km.submitEnrollment({ passcode, id: 'ttl3', name: 'TTL3' });
      assert.ok(result.success);
    });
  });
});
