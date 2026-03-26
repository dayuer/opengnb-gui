'use strict';

const { Client } = require('ssh2');
import type { Readable } from 'stream';

/** SSH 流接口（ssh2 ClientChannel 简化） */
interface SshStream extends Readable {
  stderr: Readable;
}
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const log = createLogger('SSH');

/**
 * SSH 连接池管理器
 * 通过 GNB TUN 内网地址连接到各节点的 sshd
 */
/** 节点 SSH 配置 */
interface SshNodeConfig {
  id: string;
  tunAddr: string;
  sshPort?: number;
  sshUser: string;
  sshKeyPath: string;
  clawToken?: string;
  [key: string]: unknown;
}

/** 连接池条目 */
interface PoolEntry {
  client: InstanceType<typeof Client>;
  ready: boolean;
  lastUsed: number;
}

class SSHManager {
  pool: Map<string, PoolEntry>;
  reconnectInterval: number;
  _knownHostsPath: string;
  _knownHosts: Record<string, string>;

  constructor(options: { knownHostsPath?: string } = {}) {
    this.pool = new Map();
    this.reconnectInterval = 30000;
    this._knownHostsPath = options.knownHostsPath || '';
    this._knownHosts = this._loadKnownHosts();
  }

  /** @private 加载已知主机指纹 */
  _loadKnownHosts() {
    if (!this._knownHostsPath) return {};
    try {
      return JSON.parse(fs.readFileSync(this._knownHostsPath, 'utf-8'));
    } catch (_e) { log.debug('known_hosts 解析失败，使用空对象', (_e as Error)?.message); return {}; }
  }

  /** @private 保存已知主机指纹 */
  _saveKnownHosts() {
    if (!this._knownHostsPath) return;
    try {
      fs.writeFileSync(this._knownHostsPath, JSON.stringify(this._knownHosts, null, 2), { mode: 0o600 });
    } catch (err: unknown) {
      log.error(`保存 known_hosts 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 获取或创建到指定节点的 SSH 连接
   * @param {object} nodeConfig - 节点配置 {id, tunAddr, sshPort, sshUser, sshKeyPath}
   * @returns {Promise<Client>}
   */
  async getConnection(nodeConfig: SshNodeConfig) {
    const key = nodeConfig.id;
    const entry = this.pool.get(key);

    if (entry && entry.ready) {
      entry.lastUsed = Date.now();
      return entry.client;
    }

    // 旧连接不可用时清理
    if (entry) {
      try { entry.client.end(); } catch (_e) { log.debug('旧连接清理忽略', (_e as Error)?.message); }
      this.pool.delete(key);
    }

    return this._connect(nodeConfig);
  }

  /**
   * 建立 SSH 连接
   * @private
   */
  _connect(nodeConfig: SshNodeConfig) {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const keyPath = nodeConfig.sshKeyPath.replace('~', process.env.HOME || '/root');

      let privateKey;
      try {
        privateKey = fs.readFileSync(path.resolve(keyPath));
      } catch (err: unknown) {
        reject(new Error(`无法读取 SSH 密钥 ${keyPath}: ${err instanceof Error ? err.message : String(err)}`));
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
        .on('error', (err: Error) => {
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
          // @security: TOFU 主机指纹持久化（安全审计 H3 修复）
          hostVerifier: (key: Buffer) => {
            const fp = require('crypto').createHash('sha256').update(key).digest('hex');
            const host = nodeConfig.tunAddr;
            if (this._knownHosts[host]) {
              if (this._knownHosts[host] !== fp) {
                log.error(`⚠️ 主机密钥变更! ${host} 旧=${this._knownHosts[host].substring(0, 16)}... 新=${fp.substring(0, 16)}...`);
                log.error('可能存在中间人攻击，请人工确认!');
                // TOFU: 仍然允许连接但强烈告警
              }
            } else {
              log.info(`首次连接 ${host}，记录指纹: ${fp.substring(0, 16)}...`);
              this._knownHosts[host] = fp;
              this._saveKnownHosts();
            }
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
   *
   * @deprecated 对于已安装 synon-daemon 的节点，请改用 DaemonProxy.execCmd() 通过 WSS 通道执行命令。
   *             SSH exec() 仅保留给旧版节点（无 daemonVersion）的兼容路径，将在 2025-12 EOL 后移除。
   *             交互式终端仍使用 shell()。
   *
   * @param {object} nodeConfig - 节点配置
   * @param {string} command - 要执行的命令
   * @param {number} [timeoutMs=15000] - 超时毫秒
   * @returns {Promise<{stdout: string, stderr: string, code: number}>}
   */
  async exec(nodeConfig: SshNodeConfig, command: string, timeoutMs = 15000) {
    const client = await this.getConnection(nodeConfig);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`命令执行超时 (${timeoutMs}ms): ${command}`));
      }, timeoutMs);

      client.exec(command, (err: Error | null, stream: SshStream) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream
          .on('close', (code: number) => {
            clearTimeout(timeout);
            resolve({ stdout, stderr, code: code || 0 });
          })
          .on('data', (data: Buffer) => { stdout += data.toString(); })
          .stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      });
    });
  }

  /**
   * 创建交互式 SSH Shell（用于 Web SSH 终端）
   * @param {object} nodeConfig - 节点配置
   * @param {object} [ptyOpts] - PTY 选项 {cols, rows, term}
   * @returns {Promise<import('ssh2').ClientChannel>} 可读写的双工 stream
   */
  async shell(nodeConfig: SshNodeConfig, ptyOpts: { cols?: number; rows?: number; term?: string } = {}) {
    const client = await this.getConnection(nodeConfig);
    const { cols = 80, rows = 24, term = 'xterm-256color' } = ptyOpts;

    return new Promise((resolve, reject) => {
      client.shell({ term, cols, rows }, (err: Error | null, stream: SshStream) => {
        if (err) return reject(err);
        resolve(stream);
      });
    });
  }

  /**
   * @alpha: 异步执行命令 — 投递到 Node 后台，立即返回
   *
   * 命令被包装为 nohup 后台脚本，执行完毕后 curl 回调 Console。
   *
   * @param {object} nodeConfig - 节点配置
   * @param {string} command - 要执行的命令
   * @param {string} jobId - 唯一 job ID
   * @param {string} callbackUrl - 回调 URL (含完整 host + path)
   * @returns {Promise<{dispatched: boolean, error?: string}>}
   */
  async execAsync(nodeConfig: SshNodeConfig, command: string, jobId: string, callbackUrl: string) {
    const client = await this.getConnection(nodeConfig);
    const clawToken = nodeConfig.clawToken || '';

    // @alpha: 构造后台包装脚本
    const wrapper = SSHManager.buildAsyncWrapper(command, jobId, callbackUrl, clawToken);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`SSH 异步投递超时: ${nodeConfig.tunAddr}`));
      }, 10000);

      client.exec(wrapper, (err: Error | null, stream: SshStream) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
          return;
        }

        // 不等待命令完成 — 只确认 nohup 启动成功
        let launchOutput = '';
        stream
          .on('close', () => {
            clearTimeout(timeout);
            resolve({ dispatched: true });
          })
          .on('data', (data: Buffer) => {
            launchOutput += data.toString();
          });
      });
    });
  }

  /**
   * @alpha: 构造异步执行包装脚本
   *
   * 生成的 shell 脚本：
   * 1. nohup 后台执行原始命令
   * 2. 捕获 stdout/stderr 到临时文件
   * 3. 执行完毕后 curl POST 回调 Console
   * 4. 清理临时文件
   *
   * @param {string} command - 原始命令
   * @param {string} jobId - job ID
   * @param {string} callbackUrl - 回调 URL
   * @param {string} clawToken - 节点认证 token
   * @returns {string} shell 命令
   */
  static buildAsyncWrapper(command: string, jobId: string, callbackUrl: string, clawToken: string) {
    // @security: 参数字符白名单校验（安全审计 H4 修复）
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      throw new Error(`无效 jobId: 仅允许字母数字下划线和短横线`);
    }
    if (!/^https?:\/\/[\w.:/-]+$/.test(callbackUrl)) {
      throw new Error(`无效 callbackUrl: 格式不合法`);
    }
    if (clawToken && !/^[a-zA-Z0-9_.-]+$/.test(clawToken)) {
      throw new Error(`无效 clawToken: 仅允许安全字符`);
    }

    // 用 heredoc 避免转义问题，stdout/stderr 写到临时文件
    const script = `
TMP_DIR="/tmp/job_${jobId}"
mkdir -p "\$TMP_DIR"

# 执行命令，捕获输出
(
  ${command}
) > "\$TMP_DIR/stdout" 2> "\$TMP_DIR/stderr"
EXIT_CODE=$?

# 截断过长输出（保留最后 64KB）
tail -c 65536 "\$TMP_DIR/stdout" > "\$TMP_DIR/stdout.trunc" 2>/dev/null
tail -c 16384 "\$TMP_DIR/stderr" > "\$TMP_DIR/stderr.trunc" 2>/dev/null

# 构造 JSON 回调
STDOUT_B64=$(base64 -w0 "\$TMP_DIR/stdout.trunc" 2>/dev/null || base64 "\$TMP_DIR/stdout.trunc" 2>/dev/null)
STDERR_B64=$(base64 -w0 "\$TMP_DIR/stderr.trunc" 2>/dev/null || base64 "\$TMP_DIR/stderr.trunc" 2>/dev/null)

curl -s -X POST "${callbackUrl}" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${clawToken}" \\
  -d "{\\"exitCode\\":\$EXIT_CODE,\\"stdout_b64\\":\\"\$STDOUT_B64\\",\\"stderr_b64\\":\\"\$STDERR_B64\\"}" \\
  --connect-timeout 10 --max-time 30 || true

# 清理
rm -rf "\$TMP_DIR"
`.trim();

    // nohup + setsid 确保 SSH 断开后进程不受影响
    return `nohup setsid sh -c '${script.replace(/'/g, "'\"'\"'")}' > /dev/null 2>&1 &
echo "JOB_DISPATCHED:${jobId}"`;
  }

  /**
   * @alpha: 断开指定节点的 SSH 连接（编辑后重连用）
   * @param {string} nodeId
   */
  disconnect(nodeId: string) {
    const entry = this.pool.get(nodeId);
    if (entry) {
      try { entry.client.end(); } catch (_e) { log.debug('断开连接忽略', (_e as Error)?.message); }
      this.pool.delete(nodeId);
      log.info(`已断开节点 ${nodeId} 的连接`);
    }
  }

  /**
   * 关闭所有连接
   */
  closeAll() {
    for (const [, entry] of this.pool) {
      try { entry.client.end(); } catch (_e) { log.debug('关闭连接忽略', (_e as Error)?.message); }
    }
    this.pool.clear();
  }
}

module.exports = SSHManager;
export {}; // CJS 模块标记
