'use strict';

/**
 * 轻量结构化日志 — 替代散落的 console.log/error
 *
 * 用法:
 *   const { createLogger } = require('./logger');
 *   const log = createLogger('SSH');
 *   log.info('已连接', host);
 *   log.warn('密钥变更', { host, oldFp, newFp });
 *   log.error('连接失败', err.message);
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m',
};

const RESET = '\x1b[0m';
let globalLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

function createLogger(module: string): Logger {
  const tag = `[${module}]`;

  function emit(level: LogLevel, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[globalLevel]) return;
    const ts = new Date().toISOString().substring(11, 23);
    const color = LEVEL_COLORS[level];
    const prefix = `${color}${ts} ${level.toUpperCase().padEnd(5)}${RESET} ${tag}`;
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
  }

  return {
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
  };
}

module.exports = { createLogger, setLogLevel };
