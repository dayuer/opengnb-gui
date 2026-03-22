'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { tmpDataDir } = require('../helpers');
const path = require('path');

describe('auth (JWT + 用户管理)', () => {
  let NodeStore, nodeStore, auth, cleanup;

  beforeEach(() => {
    const tmp = tmpDataDir();
    cleanup = tmp.cleanup;

    NodeStore = require('../../services/node-store');
    nodeStore = new NodeStore(path.join(tmp.dir, 'nodes.db'));
    nodeStore.init();

    // 重新加载 auth 模块（每次测试隔离状态）
    delete require.cache[require.resolve('../../middleware/auth')];
    auth = require('../../middleware/auth');
    auth.setJwtSecret('test-secret-key-for-unit-tests');
  });

  afterEach(() => { if (nodeStore) nodeStore.close(); cleanup && cleanup(); });

  // --- S1: 用户创建 ---
  it('创建用户并查找', () => {
    const hash = auth.hashPassword('password123');
    nodeStore.insertUser({ id: 'u1', username: 'testuser', passwordHash: hash });

    const user = nodeStore.findUserByName('testuser');
    assert.ok(user);
    assert.equal(user.username, 'testuser');
    assert.equal(user.role, 'admin');
  });

  // --- E3: 重复用户名 ---
  it('拒绝重复用户名', () => {
    const hash = auth.hashPassword('pw12345678');
    nodeStore.insertUser({ id: 'u1', username: 'dup', passwordHash: hash });
    assert.throws(() => {
      nodeStore.insertUser({ id: 'u2', username: 'dup', passwordHash: hash });
    });
  });

  // --- S2: 登录成功 ---
  it('正确密码验证通过', () => {
    const hash = auth.hashPassword('mypassword');
    assert.ok(auth.verifyPassword('mypassword', hash));
  });

  // --- E1: 登录失败 ---
  it('错误密码验证失败', () => {
    const hash = auth.hashPassword('mypassword');
    assert.ok(!auth.verifyPassword('wrong', hash));
  });

  // --- S3: JWT 签发和验证 ---
  it('JWT 签发和验证', () => {
    const token = auth.signJwt({ userId: 'u1', username: 'admin', role: 'admin' });
    const payload = auth.verifyJwt(token);
    assert.ok(payload);
    assert.equal(payload.userId, 'u1');
    assert.equal(payload.username, 'admin');
    assert.ok(payload.exp > Math.floor(Date.now() / 1000));
  });

  // --- E5: 无效签名 ---
  it('无效 JWT 签名拒绝', () => {
    const token = auth.signJwt({ userId: 'u1' });
    // 篡改签名
    const tampered = token.slice(0, -5) + 'XXXXX';
    assert.equal(auth.verifyJwt(tampered), null);
  });

  // --- E2: 过期 JWT ---
  it('过期 JWT 拒绝', () => {
    // 设置一个过期的 secret 来生成已过期 token
    const crypto = require('crypto');
    // 手动构造已过期的 JWT
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
      userId: 'u1',
      iat: 1000,
      exp: 1001, // 远早于现在
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', 'test-secret-key-for-unit-tests')
      .update(`${header}.${body}`).digest('base64url');
    const expired = `${header}.${body}.${sig}`;
    assert.equal(auth.verifyJwt(expired), null);
  });

  // --- S4: 双模式 requireAuth ---
  it('双模式认证 — JWT 通过', () => {
    const token = auth.signJwt({ userId: 'u1', username: 'admin', role: 'admin' });
    let nextCalled = false;
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = { status: () => ({ json: () => {} }) };
    auth.requireAuth(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    assert.equal(req.user.userId, 'u1');
  });

  // --- 用户 CRUD ---
  it('用户列表和删除', () => {
    const hash = auth.hashPassword('p1234567');
    nodeStore.insertUser({ id: 'u1', username: 'alice', passwordHash: hash });
    nodeStore.insertUser({ id: 'u2', username: 'bob', passwordHash: hash });

    const users = nodeStore.allUsers();
    assert.equal(users.length, 2);
    // 脱敏：不应包含 passwordHash
    assert.ok(!users[0].passwordHash);

    nodeStore.deleteUser('u1');
    assert.equal(nodeStore.userCount(), 1);
  });

  // --- 持久化 ---
  it('用户数据持久化到 SQLite', () => {
    const hash = auth.hashPassword('persist8');
    nodeStore.insertUser({ id: 'u1', username: 'persist', passwordHash: hash });

    // 重新打开数据库
    const ns2 = new NodeStore(nodeStore.dbPath);
    ns2.init();
    const user = ns2.findUserByName('persist');
    assert.ok(user);
    assert.equal(user.username, 'persist');
    ns2.close();
  });
});
