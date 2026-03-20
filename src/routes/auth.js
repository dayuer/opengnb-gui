'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const {
  requireAuth, signJwt, hashPassword, verifyPassword,
} = require('../middleware/auth');

/**
 * 认证路由
 * @alpha: 用户注册/登录/Token 管理
 *
 * @param {object} store - NodeStore 实例
 */
function createAuthRouter(store) {
  const router = Router();

  // --- 公开端点 ---

  /** POST /api/auth/login — 登录获取 JWT */
  router.post('/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '请提供用户名和密码' });
    }

    const user = store.findUserByName(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = signJwt({
      userId: user.id,
      username: user.username,
      role: user.role,
    });

    res.json({ token, expiresIn: '24h', username: user.username, role: user.role });
  });

  // --- 需要认证的端点 ---

  /** GET /api/auth/token — 获取当前有效 token（供 initnode.sh 使用） */
  router.get('/token', requireAuth, (req, res) => {
    // 为当前用户签发新 JWT
    const token = signJwt({
      userId: req.user.userId,
      username: req.user.username,
      role: req.user.role,
    });
    res.json({ token, expiresIn: '24h' });
  });

  /** POST /api/auth/register — 创建新用户 */
  router.post('/register', requireAuth, (req, res) => {
    const { username, password, role } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '请提供用户名和密码' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: '密码长度至少 8 位' });
    }
    // 检查重名
    if (store.findUserByName(username)) {
      return res.status(409).json({ error: '用户名已存在' });
    }

    const id = crypto.randomBytes(8).toString('hex');
    const passwordHash = hashPassword(password);
    store.insertUser({ id, username, passwordHash, role: role || 'admin' });

    res.status(201).json({ id, username, role: role || 'admin' });
  });

  /** GET /api/auth/users — 用户列表（脱敏） */
  router.get('/users', requireAuth, (req, res) => {
    res.json(store.allUsers());
  });

  /** DELETE /api/auth/users/:id — 删除用户 */
  router.delete('/users/:id', requireAuth, (req, res) => {
    const { id } = req.params;
    // 禁止删除自身
    if (req.user.userId === id) {
      return res.status(400).json({ error: '不能删除当前登录用户' });
    }
    store.deleteUser(id);
    res.status(204).end();
  });

  return router;
}

module.exports = createAuthRouter;
