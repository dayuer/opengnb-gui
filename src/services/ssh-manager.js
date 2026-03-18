'use strict';

const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

/**
 * SSH 连接池管理器
 * 通过 GNB TUN 内网地址连接到各节点的 sshd
 */
class SSHManager {
  constructor() {
    /** @type {Map<string, {client: Client, ready: boolean, lastUsed: number}>} */
    this.pool = new Map();
    this.reconnectInterval = 30000;
  }

  /**
   * 获取或创建到指定节点的 SSH 连接
   * @param {object} nodeConfig - 节点配置 {id, tunAddr, sshPort, sshUser, sshKeyPath}
   * @returns {Promise<Client>}
   */
  async getConnection(nodeConfig) {
    const key = nodeConfig.id;
    const entry = this.pool.get(key);

    if (entry && entry.ready) {
      entry.lastUsed = Date.now();
      return entry.client;
    }

    // 旧连接不可用时清理
    if (entry) {
      try { entry.client.end(); } catch (_) { /* 忽略 */ }
      this.pool.delete(key);
    }

    return this._connect(nodeConfig);
  }

  /**
   * 建立 SSH 连接
   * @private
   */
  _connect(nodeConfig) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const keyPath = nodeConfig.sshKeyPath.replace('~', process.env.HOME || '/root');

      let privateKey;
      try {
        privateKey = fs.readFileSync(path.resolve(keyPath));
      } catch (err) {
        reject(new Error(`无法读取 SSH 密钥 ${keyPath}: ${err.message}`));
        return;
      }

      const timeout = setTimeout(() => {
        client.end();
        reject(new Error(`SSH 连接超时: ${nodeConfig.tunAddr}`));
      }, 30000);

      client
        .on('ready', () => {
          clearTimeout(timeout);
          this.pool.set(nodeConfig.id, {
            client,
            ready: true,
            lastUsed: Date.now(),
          });
          resolve(client);
        })
        .on('error', (err) => {
          clearTimeout(timeout);
          this.pool.delete(nodeConfig.id);
          reject(new Error(`SSH 连接失败 ${nodeConfig.tunAddr}: ${err.message}`));
        })
        .on('close', () => {
          const entry = this.pool.get(nodeConfig.id);
          if (entry) entry.ready = false;
        })
        .connect({
          host: nodeConfig.tunAddr,
          port: nodeConfig.sshPort || 22,
          username: nodeConfig.sshUser,
          privateKey,
          readyTimeout: 30000,
          keepaliveInterval: 15000,
          // TOFU 模式：记录主机指纹，不阻断连接
          hostVerifier: (key) => {
            console.log(`[SSH] 主机密钥: ${nodeConfig.tunAddr} fingerprint=${key.toString('hex').substring(0, 16)}...`);
            return true;
          },
          // 限制加密算法白名单
          algorithms: {
            kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256'],
            cipher: ['aes128-gcm@openssh.com', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes256-ctr'],
            hmac: ['hmac-sha2-256', 'hmac-sha2-512'],
          },
        });
    });
  }

  /**
   * 在远程节点执行命令
   * @param {object} nodeConfig - 节点配置
   * @param {string} command - 要执行的命令
   * @param {number} [timeoutMs=15000] - 超时毫秒
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async exec(nodeConfig, command, timeoutMs = 15000) {
    const client = await this.getConnection(nodeConfig);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`命令执行超时 (${timeoutMs}ms): ${command}`));
      }, timeoutMs);

      client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream
          .on('close', (code) => {
            clearTimeout(timeout);
            resolve({ stdout, stderr, code: code || 0 });
          })
          .on('data', (data) => { stdout += data.toString(); })
          .stderr.on('data', (data) => { stderr += data.toString(); });
      });
    });
  }

  /**
   * 关闭所有连接
   */
  closeAll() {
    for (const [, entry] of this.pool) {
      try { entry.client.end(); } catch (_) { /* 忽略 */ }
    }
    this.pool.clear();
  }
}

module.exports = SSHManager;
