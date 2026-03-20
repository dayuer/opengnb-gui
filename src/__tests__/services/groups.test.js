'use strict';

// @alpha: 分组 CRUD + 批量操作 + CIDR 过滤 测试 — 覆盖 S1-S7, S11-S15 (V3: 平台自动生成 NodeID)

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tmpDataDir } = require('../helpers');

// @alpha: 辅助 — 注册节点并返回平台生成的 nodeId
function enroll(km, name, overrides = {}) {
  const pc = km.generatePasscode();
  const result = km.submitEnrollment({ passcode: pc, id: name, name, ...overrides });
  assert.ok(result.success, `注册 ${name} 失败: ${result.message}`);
  return result.nodeId;
}

describe('分组 CRUD', () => {
  let KeyManager, km, dataDir, cleanup;

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = tmpDataDir());
    delete require.cache[require.resolve('../../services/key-manager')];
    KeyManager = require('../../services/key-manager');
    km = new KeyManager({ dataDir });
    await km.init();
  });

  afterEach(() => { if (km && km.store) km.store.close(); cleanup(); });

  // S1: 创建分组
  it('S1: 创建分组并返回 group 对象', () => {
    const g = km.createGroup({ name: '华东生产', color: '#3fb950' });
    assert.ok(g.id);
    assert.equal(g.name, '华东生产');
    assert.equal(g.color, '#3fb950');
    assert.ok(g.createdAt);
  });

  // S2: 获取分组列表含节点计数
  it('S2: 获取分组列表含 nodeCount', () => {
    const g1 = km.createGroup({ name: 'A' });
    km.createGroup({ name: 'B' });

    // 添加节点并关联到分组
    const nodeId = enroll(km, 'N1');
    km.updateNodeGroup(nodeId, g1.id);

    const groups = km.getGroups();
    assert.equal(groups.length, 2);
    const gA = groups.find(g => g.name === 'A');
    assert.equal(gA.nodeCount, 1);
  });

  // S11: 删除分组，节点回归未分组
  it('S11: 删除分组时清空关联节点 groupId', () => {
    const g = km.createGroup({ name: 'ToDelete' });
    const nodeId = enroll(km, 'N2');
    km.updateNodeGroup(nodeId, g.id);

    km.deleteGroup(g.id);
    const node = km.getAllNodes().find(n => n.id === nodeId);
    assert.ok(!node.groupId, '节点 groupId 应被清空');
    assert.equal(km.getGroups().length, 0);
  });

  // S12: 重命名分组
  it('S12: 重命名分组', () => {
    const g = km.createGroup({ name: 'Old' });
    const updated = km.updateGroup(g.id, { name: 'New', color: '#f85149' });
    assert.ok(updated.success);
    assert.equal(km.getGroups()[0].name, 'New');
    assert.equal(km.getGroups()[0].color, '#f85149');
  });

  // 边界: 空名拒绝
  it('边界: 空名拒绝', () => {
    assert.throws(() => km.createGroup({ name: '' }), /名称不能为空/);
    assert.throws(() => km.createGroup({ name: '  ' }), /名称不能为空/);
  });

  // 边界: 重复名拒绝
  it('边界: 重复名拒绝', () => {
    km.createGroup({ name: 'Dup' });
    assert.throws(() => km.createGroup({ name: 'Dup' }), /同名分组已存在/);
  });

  // 持久化: 分组保存到 SQLite
  it('分组持久化到 SQLite（reinit 后保留）', async () => {
    km.createGroup({ name: 'Persist' });
    km.store.close();

    // 重新初始化 — 分组应保留在 SQLite 中
    const km2 = new KeyManager({ dataDir });
    await km2.init();
    const groups = km2.getGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, 'Persist');
    km2.store.close();
  });
});

describe('节点-分组关联', () => {
  let KeyManager, km, dataDir, cleanup;

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = tmpDataDir());
    delete require.cache[require.resolve('../../services/key-manager')];
    KeyManager = require('../../services/key-manager');
    km = new KeyManager({ dataDir });
    await km.init();
  });

  afterEach(() => { if (km && km.store) km.store.close(); cleanup(); });

  // S3: 关联节点到分组
  it('S3: 关联节点到分组', () => {
    const g = km.createGroup({ name: 'MyGroup' });
    const nodeId = enroll(km, 'N1');
    const result = km.updateNodeGroup(nodeId, g.id);
    assert.ok(result.success);
    const node = km.getAllNodes().find(n => n.id === nodeId);
    assert.equal(node.groupId, g.id);
  });

  // S4: 按分组过滤节点
  it('S4: 按分组过滤节点', () => {
    const g = km.createGroup({ name: 'Filter' });
    const id1 = enroll(km, 'N1');
    enroll(km, 'N2');
    km.updateNodeGroup(id1, g.id);

    const filtered = km.getFilteredNodes({ groupId: g.id });
    assert.equal(filtered.nodes.length, 1);
    assert.equal(filtered.nodes[0].id, id1);
  });

  // 边界: 分组不存在
  it('边界: 关联不存在的分组', () => {
    const nodeId = enroll(km, 'N1');
    const result = km.updateNodeGroup(nodeId, 'nonexistent');
    assert.ok(!result.success);
  });
});

describe('网段过滤', () => {
  let KeyManager, km, dataDir, cleanup;

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = tmpDataDir());
    delete require.cache[require.resolve('../../services/key-manager')];
    KeyManager = require('../../services/key-manager');
    km = new KeyManager({ dataDir });
    await km.init();
  });

  afterEach(() => { if (km && km.store) km.store.close(); cleanup(); });

  // S5: CIDR 匹配
  it('S5: CIDR 匹配过滤', () => {
    const id1 = enroll(km, 'N1', { tunAddr: '10.1.0.2' });
    enroll(km, 'N2', { tunAddr: '10.1.1.5' });

    const result = km.getFilteredNodes({ subnet: '10.1.0.0/24' });
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0].id, id1);
  });

  // 边界: 无 TUN 地址节点
  it('边界: 无 TUN 地址节点不匹配 CIDR', () => {
    enroll(km, 'N1'); // 无 tunAddr
    const result = km.getFilteredNodes({ subnet: '10.1.0.0/24' });
    assert.equal(result.nodes.length, 0);
  });

  // 关键词搜索
  it('S10: 关键词搜索名称/ID/TUN', () => {
    enroll(km, 'Production Server', { tunAddr: '10.1.0.2' });
    enroll(km, 'Test Server', { tunAddr: '10.1.1.5' });

    // 搜索名称
    assert.equal(km.getFilteredNodes({ keyword: 'Prod' }).nodes.length, 1);
    // 搜索 name（旧式 hostname 搜索仍有效因为存在 name 字段）
    assert.equal(km.getFilteredNodes({ keyword: 'Test' }).nodes.length, 1);
    // 搜索 TUN
    assert.equal(km.getFilteredNodes({ keyword: '10.1.1' }).nodes.length, 1);
  });

  // 状态过滤
  it('按状态过滤', () => {
    const id1 = enroll(km, 'N1');
    enroll(km, 'N2');
    km.approveNode(id1);

    assert.equal(km.getFilteredNodes({ status: 'approved' }).nodes.length, 1);
    assert.equal(km.getFilteredNodes({ status: 'pending' }).nodes.length, 1);
  });

  // 分页
  it('S15: 分页', () => {
    for (let i = 0; i < 10; i++) {
      enroll(km, `N${i}`);
    }

    const page1 = km.getFilteredNodes({ page: 1, pageSize: 3 });
    assert.equal(page1.nodes.length, 3);
    assert.equal(page1.total, 10);
    assert.equal(page1.totalPages, 4);
    assert.equal(page1.page, 1);

    const page4 = km.getFilteredNodes({ page: 4, pageSize: 3 });
    assert.equal(page4.nodes.length, 1); // 最后一页只有 1 条
  });

  // 复合过滤
  it('复合过滤: 分组+CIDR+关键词+状态', () => {
    const g = km.createGroup({ name: 'Combo' });
    const id1 = enroll(km, 'Prod 01', { tunAddr: '10.1.0.2' });
    const id2 = enroll(km, 'Prod 02', { tunAddr: '10.1.0.3' });
    enroll(km, 'Test 01', { tunAddr: '10.1.1.5' });
    km.updateNodeGroup(id1, g.id);
    km.updateNodeGroup(id2, g.id);
    km.approveNode(id1);

    // 分组 + 状态 approved
    const result = km.getFilteredNodes({ groupId: g.id, status: 'approved' });
    assert.equal(result.nodes.length, 1);
    assert.equal(result.nodes[0].id, id1);
  });
});

describe('批量操作', () => {
  let KeyManager, km, dataDir, cleanup;

  beforeEach(async () => {
    ({ dir: dataDir, cleanup } = tmpDataDir());
    delete require.cache[require.resolve('../../services/key-manager')];
    KeyManager = require('../../services/key-manager');
    km = new KeyManager({ dataDir });
    await km.init();
  });

  afterEach(() => { if (km && km.store) km.store.close(); cleanup(); });

  // S6: 批量审批
  it('S6: 批量审批', () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(enroll(km, `N${i}`));
    }

    const result = km.batchApprove(ids);
    assert.equal(result.succeeded.length, 3);
    assert.equal(result.failed.length, 0);
    assert.ok(km.getAllNodes().every(n => n.status === 'approved'));
  });

  // S7: 批量删除
  it('S7: 批量删除', () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(enroll(km, `N${i}`));
    }

    const result = km.batchRemove(ids);
    assert.equal(result.succeeded.length, 3);
    assert.equal(km.getAllNodes().length, 0);
  });

  // 批量拒绝
  it('批量拒绝', () => {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(enroll(km, `N${i}`));
    }

    const result = km.batchReject(ids);
    assert.equal(result.succeeded.length, 3);
    assert.ok(km.getAllNodes().every(n => n.status === 'rejected'));
  });

  // 边界: 空 ids
  it('边界: 空 ids 返回空结果', () => {
    const result = km.batchApprove([]);
    assert.equal(result.succeeded.length, 0);
    assert.equal(result.failed.length, 0);
  });

  // 边界: 部分不存在
  it('边界: 部分不存在的 ids', () => {
    const nodeId = enroll(km, 'Exists');

    const result = km.batchApprove([nodeId, 'ghost']);
    assert.equal(result.succeeded.length, 1);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].id, 'ghost');
  });
});
