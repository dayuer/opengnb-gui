'use strict';

/**
 * 统一错误处理中间件
 *
 * 生产环境屏蔽内部错误细节，仅返回通用消息。
 * 所有错误记录到 console.error 并附带请求上下文。
 */

/**
 * Express 错误处理中间件（4 参数签名）
 */
function errorHandler(err: any, req: any, res: any, _next: any) {
  const isProd = process.env.NODE_ENV === 'production';
  const status = err.statusCode || err.status || 500;

  // 记录完整错误到服务端日志
  console.error(`[ERROR] ${req.method} ${req.path} — ${err.message}`, {
    ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
    status,
    stack: isProd ? undefined : err.stack,
  });

  res.status(status).json({
    error: isProd && status >= 500
      ? '服务器内部错误，请联系管理员'
      : err.message || '未知错误',
  });
}

module.exports = { errorHandler };
export {}; // CJS 模块标记
