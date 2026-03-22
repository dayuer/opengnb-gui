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
   * 通过 TUN 网络直接调用终端 OpenClaw HTTP API
   * @param {object} nodeConfig - 节点配置（含 clawToken, clawPort, tunAddr）
   * @param {string} endpoint - API 路径 (e.g. '/status', '/v1/models')
   * @param {string} [method='GET'] - HTTP 方法
   * @param {object|null} [body=null] - POST body
   * @returns {Promise<object>}
   */
  async httpCall(nodeConfig, endpoint, method = 'GET', body = null) {
    const port = nodeConfig.clawPort || 18789;
    const token = nodeConfig.clawToken;
    if (!token) throw new Error(`节点 ${nodeConfig.id} 未配置 OpenClaw Token`);

    const tunAddr = nodeConfig.tunAddr;
    if (!tunAddr) throw new Error(`节点 ${nodeConfig.id} 未配置 TUN 地址`);

    const url = `http://${tunAddr}:${port}${endpoint}`;
    const options = {
      method,
      headers: { 'Authorization': `Bearer ${token}` },
    };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    options.signal = controller.signal;

    try {
      const resp = await fetch(url, options);
      clearTimeout(timeout);
      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    } catch (err) {
      clearTimeout(timeout);
      throw new Error(`OpenClaw HTTP 调用失败 (${tunAddr}:${port}): ${err.message}`);
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
