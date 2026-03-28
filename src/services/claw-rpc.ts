'use strict';
import * as crypto from 'crypto';

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

/** 节点 Claw 配置 */
interface ClawNodeConfig {
  id: string;
  tunAddr: string;
  clawToken?: string;
  clawPort?: number;
  [key: string]: unknown;
}

/** SSH 管理器接口 */
interface ClawSshManager {
  exec(nodeConfig: ClawNodeConfig, command: string, timeout?: number): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** 对原始文本计算 SHA-256（统一 trim 消除尾部换行差异） */
function configHash(text: string): string {
  return crypto.createHash('sha256').update(text.trim()).digest('hex');
}

class ClawRPC {
  sshManager: ClawSshManager;

  constructor(sshManager: ClawSshManager) {
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
  async httpCall(nodeConfig: ClawNodeConfig, endpoint: string, method = 'GET', body: Record<string, unknown> | null = null) {
    const port = nodeConfig.clawPort || 18789;
    const token = nodeConfig.clawToken;
    if (!token) throw new Error(`节点 ${nodeConfig.id} 未配置 OpenClaw Token`);

    const tunAddr = nodeConfig.tunAddr;
    if (!tunAddr) throw new Error(`节点 ${nodeConfig.id} 未配置 TUN 地址`);

    const url = `http://${tunAddr}:${port}${endpoint}`;
    const options: RequestInit = {
      method,
      headers: { 'Authorization': `Bearer ${token}` } as Record<string, string>,
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
    } catch (err: unknown) {
      clearTimeout(timeout);
      throw new Error(`OpenClaw HTTP 调用失败 (${tunAddr}:${port}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 通过 SSH 代理调用 OpenClaw CLI RPC 方法
   * @param {object} nodeConfig
   * @param {string} method - RPC 方法名 (e.g. 'health', 'config.get')
   * @param {object} [params={}]
   * @returns {Promise<object>}
   */
  async rpcCall(nodeConfig: ClawNodeConfig, method: string, params: Record<string, unknown> = {}) {
    const envPath = 'export PATH=/usr/local/bin:$PATH;';
    const cmd = `${envPath} sudo openclaw gateway call ${method} --params '${JSON.stringify(params)}' --json 2>/dev/null`;
    const result = await this.sshManager.exec(nodeConfig, cmd, 30000);
    const output = result.stdout.trim();
    try {
      return JSON.parse(output);
    } catch {
      return { raw: output };
    }
  }

  // ——— 便捷方法 ———

  /** 健康检查 */
  async getStatus(nodeConfig: ClawNodeConfig) {
    return this.rpcCall(nodeConfig, 'status');
  }

  /** 模型列表 */
  async getModels(nodeConfig: ClawNodeConfig) {
    return this.httpCall(nodeConfig, '/v1/models');
  }

  /** 获取 Gateway 配置并附带 SHA-256 ETag（单次 SSH） */
  async getConfig(nodeConfig: ClawNodeConfig) {
    const cmd = `export PATH=/usr/local/bin:$PATH; sudo openclaw config get --json 2>/dev/null`;
    const result = await this.sshManager.exec(nodeConfig, cmd, 30000);
    const text = result.stdout;
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { data, hash: configHash(text) };
  }

  /** 增量修改配置（带 ETag 防脑裂校验） */
  async patchConfig(nodeConfig: ClawNodeConfig, rawPatch: string, baseHash: string) {
    // ⚠️ TOCTOU: check 和 write 之间存在竞态窗口，目前无法原子化（需 OpenClaw 原生 CAS 支持）
    if (baseHash) {
      const getCmd = `export PATH=/usr/local/bin:$PATH; sudo openclaw config get --json 2>/dev/null`;
      const currentRes = await this.sshManager.exec(nodeConfig, getCmd, 30000);
      if (configHash(currentRes.stdout) !== baseHash) {
        throw new Error('E_CONFLICT');
      }
    }
    return this.rpcCall(nodeConfig, 'config.patch', { raw: rawPatch, baseHash });
  }

  /** 会话列表 */
  async getSessions(nodeConfig: ClawNodeConfig) {
    return this.rpcCall(nodeConfig, 'sessions.list');
  }

  /** 渠道状态 */
  async getChannels(nodeConfig: ClawNodeConfig) {
    return this.rpcCall(nodeConfig, 'channels.status');
  }

  /** 执行 Agent 推理 */
  async agentRun(nodeConfig: ClawNodeConfig, message: string, sessionKey: string) {
    return this.httpCall(nodeConfig, '/v1/agent/run', 'POST', { message, sessionKey });
  }
}

module.exports = ClawRPC;
export {}; // CJS 模块标记
