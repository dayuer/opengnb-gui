'use strict';

const crypto = require('crypto');

/**
 * 认证模块 — JWT 签发/验证 + 双模式 requireAuth
 * @alpha: V3 升级 — 从静态 ADMIN_TOKEN 升级为 JWT + 向后兼容
 *
 * JWT 格式: header.payload.signature（HMAC-SHA256）
 * payload: { userId, username, role, iat, exp }
 */

// --- 配置 ---
const JWT_EXPIRES = 24 * 60 * 60; // 24h（秒）
let _adminToken = process.env.ADMIN_TOKEN || '';
let _jwtSecret = '';
let _store = null; // NodeStore 实例（用于 apiToken 查找）

// --- Base64url ---
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const b64urlDecode = (str) => Buffer.from(str, 'base64url');

// --- JWT ---

/** @alpha: 设置 JWT 密钥（由 server.js 在启动时调用） */
function setJwtSecret(secret) {
  _jwtSecret = secret;
}

/** @alpha: 注入 NodeStore（用于 apiToken 查找） */
function setStore(store) {
  _store = store;
}

/** 签发 JWT */
function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + JWT_EXPIRES,
  }));
  const sig = crypto.createHmac('sha256', _jwtSecret)
    .update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** 验证 JWT，返回 payload 或 null */
function verifyJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    // 验签
    const expected = crypto.createHmac('sha256', _jwtSecret)
      .update(`${header}.${body}`).digest('base64url');
    if (!timingSafeEqual(sig, expected)) return null;
    // 解析
    const payload = JSON.parse(b64urlDecode(body).toString());
    // 过期检查
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// --- 密码哈希 ---

/** scrypt 哈希密码（同步） */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/** 验证密码 */
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return timingSafeEqual(derived, hash);
}

// --- 中间件 ---

/** 初始化 Token — 向后兼容 */
function initToken() {
  if (!_adminToken) {
    _adminToken = crypto.randomBytes(24).toString('hex');
    console.log(`\n  ⚠️  未配置 ADMIN_TOKEN，已自动生成:`);
    console.log(`  🔑  ${_adminToken}\n`);
  }
  return _adminToken;
}

/** 获取当前 ADMIN_TOKEN */
function getAdminToken() {
  return _adminToken;
}

/**
 * Express 中间件：双模式认证
 * 1. 优先检查 JWT
 * 2. 回退检查旧 ADMIN_TOKEN
 * 3. 都不通过 → 401
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未提供认证 Token' });
  }

  const token = authHeader.slice(7);

  // 1. 尝试 JWT
  const payload = verifyJwt(token);
  if (payload) {
    req.user = payload; // 挂载用户信息
    return next();
  }

  // 2. 尝试 apiToken（10 字符短 token）
  if (_store && token.length <= 20) {
    const user = _store._stmts.findUserByApiToken.get(token);
    if (user) {
      req.user = { userId: user.id, username: user.username, role: user.role };
      return next();
    }
  }

  // 3. 回退 ADMIN_TOKEN
  if (_adminToken && timingSafeEqual(token, _adminToken)) {
    req.user = { userId: 'admin', username: 'admin', role: 'admin' };
    return next();
  }

  return res.status(401).json({ error: '认证失败：Token 无效或已过期' });
}

/** 常量时间字符串比较 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  requireAuth, initToken, getAdminToken,
  setJwtSecret, setStore, signJwt, verifyJwt,
  hashPassword, verifyPassword,
};
