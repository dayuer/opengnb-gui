'use strict';

/**
 * OpenClaw RPC 代理
 *
 * Console 无法直接 HTTP 访问终端节点的 OpenClaw Gateway（绑定 127.0.0.1），
 * 因此通过 SSH exec curl 代理所有 RPC 调用。
 *
 * 支持:
 *   - HTTP API (GET/POST /v1/*, /status)
 *   - CLI 命令代理 (openclaw gateway call <method>)
 */
class ClawRPC {
  /**
   * @param {import('./ssh-manager')} sshManager
   */
  constructor(sshManager) {
    this.sshManager = sshManager;
  }

  /**
   * 通过 SSH 代理调用终端 OpenClaw HTTP API
   * @param {object} nodeConfig - 节点 SSH 配置（含 clawToken, clawPort）
   * @param {string} endpoint - API 路径 (e.g. '/status', '/v1/models')
   * @param {string} [method='GET'] - HTTP 方法
   * @param {object|null} [body=null] - POST body
   * @returns {Promise<object>}
   */
  async httpCall(nodeConfig, endpoint, method = 'GET', body = null) {
    const port = nodeConfig.clawPort || 18789;
    const token = nodeConfig.clawToken;
    if (!token) throw new Error(`节点 ${nodeConfig.id} 未配置 OpenClaw Token`);

    let cmd = `curl -s -m 10 -H "Authorization: Bearer ${token}"`;
    if (method !== 'GET') {
      cmd += ` -X ${method}`;
    }
    if (body) {
      cmd += ` -H "Content-Type: application/json" -d '${JSON.stringify(body)}'`;
    }
    cmd += ` http://127.0.0.1:${port}${endpoint}`;

    const result = await this.sshManager.exec(nodeConfig, cmd, 15000);
    const output = (result && result.stdout) ? result.stdout.trim() : (typeof result === 'string' ? result.trim() : '');
    try {
      return JSON.parse(output);
    } catch {
      return { raw: output };
    }
  }

  /**
   * 通过 SSH 代理调用 OpenClaw CLI RPC 方法
   * @param {object} nodeConfig
   * @param {string} method - RPC 方法名 (e.g. 'health', 'config.get')
   * @param {object} [params={}]
   * @returns {Promise<object>}
   */
  async rpcCall(nodeConfig, method, params = {}) {
    const envPath = 'export PATH=/usr/local/bin:$PATH;';
    const cmd = `${envPath} sudo openclaw gateway call ${method} --params '${JSON.stringify(params)}' --json 2>/dev/null`;
    const result = await this.sshManager.exec(nodeConfig, cmd, 30000);
    const output = (result && result.stdout) ? result.stdout.trim() : (typeof result === 'string' ? result.trim() : '');
    try {
      return JSON.parse(output);
    } catch {
      return { raw: output };
    }
  }

  // ——— 便捷方法 ———

  /** 健康检查 */
  async getStatus(nodeConfig) {
    return this.rpcCall(nodeConfig, 'status');
  }

  /** 模型列表 */
  async getModels(nodeConfig) {
    return this.httpCall(nodeConfig, '/v1/models');
  }

  /** 获取 Gateway 配置 */
  async getConfig(nodeConfig) {
    return this.rpcCall(nodeConfig, 'config.get');
  }

  /** 增量修改配置 */
  async patchConfig(nodeConfig, rawPatch, baseHash) {
    return this.rpcCall(nodeConfig, 'config.patch', { raw: rawPatch, baseHash });
  }

  /** 会话列表 */
  async getSessions(nodeConfig) {
    return this.rpcCall(nodeConfig, 'sessions.list');
  }

  /** 渠道状态 */
  async getChannels(nodeConfig) {
    return this.rpcCall(nodeConfig, 'channels.status');
  }

  /** 执行 Agent 推理 */
  async agentRun(nodeConfig, message, sessionKey) {
    return this.httpCall(nodeConfig, '/v1/agent/run', 'POST', { message, sessionKey });
  }
}

module.exports = ClawRPC;
