'use strict';

const path = require('path');
const fs = require('fs');

/**
 * 数据目录路径统一管理
 * @alpha: 消除分散硬编码，所有 data/ 子路径集中定义
 *
 * 目录结构:
 *   data/
 *   ├── registry/   — 核心业务数据 (nodes.db)
 *   ├── security/   — 安全凭证 (ssh/, backups/)
 *   ├── logs/       — 日志 (ops/)
 *   └── mirror/     — 软件镜像
 *
 * @param {string} dataDir - 数据根目录（默认 `<project>/data`）
 * @returns {object} paths
 */
function resolvePaths(dataDir: string) {
  const registryDir = path.join(dataDir, 'registry');
  const securityDir = path.join(dataDir, 'security');
  const logsDir = path.join(dataDir, 'logs');
  const mirrorDir = path.join(dataDir, 'mirror');

  return {
    root: dataDir,

    // 核心业务数据
    registry: {
      dir: registryDir,
      nodesDb: path.join(registryDir, 'nodes.db'),
    },

    // 安全凭证
    security: {
      dir: securityDir,
      sshDir: path.join(securityDir, 'ssh'),
      privateKey: path.join(securityDir, 'ssh', process.env.SSH_KEY_NAME || 'console_ed25519'),
      publicKey: path.join(securityDir, 'ssh', (process.env.SSH_KEY_NAME || 'console_ed25519') + '.pub'),
      backupDir: path.join(securityDir, 'backups'),
    },

    // 日志数据（运维日志仍为文件型存储）
    logs: {
      dir: logsDir,
      opsDir: path.join(logsDir, 'ops'),
    },

    // 软件镜像
    mirror: mirrorDir,
  };
}

/**
 * 确保所有数据子目录存在
 * @param {object} paths - resolvePaths 返回值
 */
function ensureDataDirs(paths: ReturnType<typeof resolvePaths>) {
  const dirs = [
    paths.registry.dir,
    paths.security.sshDir,
    paths.security.backupDir,
    paths.logs.opsDir,
    paths.mirror,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { resolvePaths, ensureDataDirs };
export {}; // CJS 模块标记
