'use strict';

const crypto = require('crypto');

/**
 * Bearer Token 认证中间件
 *
 * 从 Authorization 头提取 Token，与 ADMIN_TOKEN 环境变量比对。
 * 若未配置 ADMIN_TOKEN，启动时自动生成随机 Token 并输出到控制台。
 */

let _adminToken = process.env.ADMIN_TOKEN || '';

/** 初始化 Token — 若未配置则自动生成 */
function initToken() {
  if (!_adminToken) {
    _adminToken = crypto.randomBytes(24).toString('hex');
    console.log(`\n  ⚠️  未配置 ADMIN_TOKEN，已自动生成:`);
    console.log(`  🔑  ${_adminToken}\n`);
  }
  return _adminToken;
}

/** 获取当前 Token（供 WebSocket 认证复用） */
function getAdminToken() {
  return _adminToken;
}

/**
 * Express 中间件：要求 Bearer Token 认证
 * 用法: router.use(requireAuth)
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未提供认证 Token。请在 Authorization 头中携带 Bearer Token。' });
  }

  const token = authHeader.slice(7);

  // 常量时间比较，防止计时攻击
  if (!_adminToken || !timingSafeEqual(token, _adminToken)) {
    return res.status(401).json({ error: '认证失败：Token 无效' });
  }

  next();
}

/** 常量时间字符串比较 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { requireAuth, initToken, getAdminToken };
