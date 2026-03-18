'use strict';

// @alpha: KeyManager 核心逻辑测试 — 覆盖 S5.1-S5.9

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDataDir } = require('../helpers');

describe('services/key-manager', () => {
  let KeyManager, km, dataDir, cleanup;

  beforeEach(async () => {
    // 每次用独立临时目录
    ({ dir: dataDir, cleanup } = tmpDataDir());
    // 重新加载模块
    delete require.cache[require.resolve('../../services/key-manager')];
    KeyManager = require('../../services/key-manager');
    km = new KeyManager({ dataDir });
    await km.init();
  });

  afterEach(() => { cleanup(); });

  // S5.1: 初始化生成 ED25519 密钥对
  it('should generate ED25519 keypair on init', () => {
    assert.ok(fs.existsSync(km.privateKeyPath));
    assert.ok(fs.existsSync(km.publicKeyPath));
    const pubKey = km.getPublicKey();
    assert.ok(pubKey.startsWith('ssh-ed25519') || pubKey.includes('BEGIN'));
  });

  // S5.2: 初始化加载已有数据
  it('should load existing nodes on init', async () => {
    // 写入测试数据
    const nodes = [{ id: 'n1', name: 'test', status: 'pending' }];
    fs.writeFileSync(km.nodesPath, JSON.stringify(nodes));

    const km2 = new KeyManager({ dataDir });
    await km2.init();
    assert.equal(km2.getAllNodes().length, 1);
    assert.equal(km2.getAllNodes()[0].id, 'n1');
  });

  // S5.3: 注册持久化
  it('should persist enrollment to nodes.json', () => {
    const passcode = km.generatePasscode('test');
    km.submitEnrollment({ passcode, id: 'node-1', name: 'Test Node' });

    // 读取文件验证
    const saved = JSON.parse(fs.readFileSync(km.nodesPath, 'utf-8'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, 'node-1');
    assert.equal(saved[0].status, 'pending');
    // passcode 不应保存到节点记录
    assert.equal(saved[0].passcode, undefined);
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
    // a2 remains pending

    const configs = km.getApprovedNodesConfig();
    assert.equal(configs.length, 1);
    assert.equal(configs[0].id, 'a1');
    assert.ok(configs[0].sshKeyPath); // 包含 SSH 配置
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

  // S5.7: 备份轮转
  it('should keep max backups', () => {
    km.maxBackups = 3;
    for (let i = 0; i < 10; i++) {
      const pc = km.generatePasscode();
      km.submitEnrollment({ passcode: pc, id: `b${i}`, name: `B${i}` });
    }
    const backups = fs.readdirSync(km.backupDir).filter(f => f.endsWith('.json'));
    assert.ok(backups.length <= 3);
  });

  // S5.8: 损坏恢复
  it('should recover from corrupted main file', async () => {
    // 先写入有效数据并保存多次（确保有包含数据的备份）
    const pc1 = km.generatePasscode();
    km.submitEnrollment({ passcode: pc1, id: 'recover', name: 'Recover' });

    // 再做一次变更，让上一次的数据存在于备份中
    const pc2 = km.generatePasscode();
    km.submitEnrollment({ passcode: pc2, id: 'recover2', name: 'Recover2' });

    // 确认备份目录有文件
    const backups = fs.readdirSync(km.backupDir).filter(f => f.endsWith('.json'));
    assert.ok(backups.length > 0, '应有备份文件');

    // 损坏主文件
    fs.writeFileSync(km.nodesPath, 'CORRUPTED{{{');

    // 重新加载 — 应从备份恢复
    const km2 = new KeyManager({ dataDir });
    await km2.init();
    // 备份中至少应有第一次 submitEnrollment 的数据
    assert.ok(km2.getAllNodes().length > 0, '应从备份恢复出节点数据');
  });
});
