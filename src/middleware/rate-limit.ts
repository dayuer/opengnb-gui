'use strict';
import type { Request, Response, NextFunction } from 'express';

/**
 * 滑动窗口速率限制中间件（零依赖）
 *
 * 按 IP 隔离，自动清理过期条目。
 */

/**
 * 创建速率限制中间件
 * @param {object} options
 * @param {number} options.windowMs - 窗口时间（毫秒），默认 60000
 * @param {number} options.max - 窗口内最大请求数，默认 100
 * @param {string} [options.message] - 超限时的错误消息
 * @returns {Function} Express 中间件
 */
function createRateLimit({ windowMs = 60000, max = 100, message }: any = {}) {
  /** @type {Map<string, number[]>} IP → 请求时间戳数组 */
  const hits = new Map();

  // 定期清理过期条目（每分钟）
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of hits) {
      const valid = timestamps.filter((t: any) => now - t < windowMs);
      if (valid.length === 0) {
        hits.delete(ip);
      } else {
        hits.set(ip, valid);
      }
    }
  }, 60000);
  cleanupInterval.unref(); // 不阻止进程退出

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    const now = Date.now();

    let timestamps = hits.get(ip) || [];
    // 保留窗口内的记录
    timestamps = timestamps.filter((t: any) => now - t < windowMs);
    timestamps.push(now);
    hits.set(ip, timestamps);

    // 设置速率限制响应头
    const remaining = Math.max(0, max - timestamps.length);
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', new Date(now + windowMs).toISOString());

    if (timestamps.length > max) {
      return res.status(429).json({
        error: message || `请求过于频繁，请 ${Math.ceil(windowMs / 1000)} 秒后重试`,
      });
    }

    next();
  };
}

module.exports = { createRateLimit };
export {}; // CJS 模块标记
