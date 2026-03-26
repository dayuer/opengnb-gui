'use strict';

import type { JwtPayload, UserRecord, TokenResult } from '../types/interfaces';

const crypto = require('crypto');

/**
 * 认证模块 — JWT 签发/验证 + 双模式 requireAuth
 * @alpha: V3 升级 — 从静态 ADMIN_TOKEN 升级为 JWT + 向后兼容
 *
 * JWT 格式: header.payload.signature（HMAC-SHA256）
 * payload: { userId, username, role, iat, exp }
 */

// Express 请求/响应简化类型（避免引入完整 express 类型包）
interface Request { headers: Record<string, string | undefined>; user?: Partial<JwtPayload>; [key: string]: unknown; }
interface Response { status(code: number): Response; json(body: unknown): void; }
type NextFunction = () => void;

// --- 配置 ---
const JWT_EXPIRES = 24 * 60 * 60; // 24h（秒）
let _adminToken = process.env.ADMIN_TOKEN || '';
let _jwtSecret = '';
let _store: { _stmts: { findUserByApiToken: { get(token: string): Partial<UserRecord> | undefined } } } | null = null;

// --- Base64url ---
const b64url = (buf: string) => Buffer.from(buf).toString('base64url');
const b64urlDecode = (str: string) => Buffer.from(str, 'base64url');

// --- JWT ---

/** @alpha: 设置 JWT 密钥（由 server.ts 在启动时调用） */
function setJwtSecret(secret: string) {
  _jwtSecret = secret;
}

/** @alpha: 注入 NodeStore（用于 apiToken 查找） */
function setStore(store: unknown) {
  _store = store as typeof _store;
}

/** 签发 JWT */
function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>): string {
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
function verifyJwt(token: string): JwtPayload | null {
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
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/** 验证密码 */
function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return timingSafeEqual(derived, hash);
}

// --- 中间件 ---

/** 初始化 Token — 向后兼容 */
function initToken(): string {
  if (!_adminToken) {
    _adminToken = crypto.randomBytes(24).toString('hex');
    console.log(`\\n  ⚠️  未配置 ADMIN_TOKEN，已自动生成:`);
    console.log(`  🔑  ${_adminToken}\\n`);
  }
  return _adminToken;
}

/** 获取当前 ADMIN_TOKEN */
function getAdminToken(): string {
  return _adminToken;
}

/**
 * Express 中间件：双模式认证
 * 1. 优先检查 JWT
 * 2. 回退检查旧 ADMIN_TOKEN
 * 3. 都不通过 → 401
 */
function requireAuth(req: Request, res: Response, next: NextFunction) {
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

  // 2. 尝试 apiToken（hex 编码，最长 64 字符）
  if (_store && token.length <= 64) {
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

/**
 * 统一 Token 解析器 — 纯函数，可在任意上下文（Express 中间件 / WS / 内联认证）调用
 *
 * 三级 fallback 顺序:
 *   1. adminToken 精确匹配
 *   2. JWT 验签 + 解析
 *   3. apiToken 数据库查找
 *
 * @param token - Bearer 后的原始 token 字符串
 * @returns {{ valid: boolean, userId?: string }}
 */
function resolveToken(token: string): TokenResult {
  if (!token || typeof token !== 'string') return { valid: false };

  // 1. adminToken 精确匹配
  if (_adminToken && timingSafeEqual(token, _adminToken)) {
    return { valid: true, userId: 'admin', role: 'admin', source: 'adminToken' };
  }

  // 2. JWT
  const payload = verifyJwt(token);
  if (payload) {
    return { valid: true, userId: payload.userId || '', role: payload.role || 'viewer', source: 'jwt' };
  }

  // 3. apiToken
  if (_store && token.length <= 64) {
    const user = _store._stmts.findUserByApiToken?.get(token);
    if (user) {
      return { valid: true, userId: user.id, role: (user as any).role || 'viewer', source: 'apiToken' };
    }
  }

  return { valid: false };
}

/**
 * Express 中间件工厂：要求请求者角色在允许列表中
 * 必须在 requireAuth 之后使用
 *
 * @example requireRole('admin', 'operator') → 允许 admin 和 operator
 */
function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role || '')) {
      return res.status(403).json({ error: `需要角色: ${roles.join(' | ')}` });
    }
    next();
  };
}

/**
 * Express 中间件：要求管理员角色（requireRole('admin') 的快捷方式）
 * 必须在 requireAuth 之后使用
 */
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

/** 常量时间字符串比较 */
function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  requireAuth, requireAdmin, requireRole, initToken, getAdminToken,
  setJwtSecret, setStore, signJwt, verifyJwt,
  hashPassword, verifyPassword, resolveToken,
};
export {}; // CJS 模块标记
