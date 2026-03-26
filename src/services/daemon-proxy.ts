'use strict';

/**
 * DaemonProxy — 通过 WSS claw_rpc 消息代理 OpenClaw API
 *
 * 接口与 ClawRPC 完全一致，路由层无感知切换。
 * 降级策略：若节点 daemon 未连接，自动 fallback 到 ClawRPC（SSH 代理）。
 */

interface NodeConfig {
  id: string;
  tunAddr?: string;
  clawToken?: string;
  clawPort?: number;
  [key: string]: unknown;
}

interface WsHandlers {
  sendToDaemon(nodeId: string, cmd: Record<string, unknown>, timeout?: number): Promise<unknown>;
  daemonConns: Map<string, unknown>;
}

interface FallbackRPC {
  getStatus(nc: NodeConfig): Promise<unknown>;
  getModels(nc: NodeConfig): Promise<unknown>;
  getConfig(nc: NodeConfig): Promise<unknown>;
  patchConfig(nc: NodeConfig, rawPatch: string, baseHash: string): Promise<unknown>;
  getSessions(nc: NodeConfig): Promise<unknown>;
  getChannels(nc: NodeConfig): Promise<unknown>;
  agentRun(nc: NodeConfig, message: string, sessionKey: string): Promise<unknown>;
}

class DaemonProxy {
  private wsHandlers: WsHandlers;
  private fallback: FallbackRPC;

  constructor(wsHandlers: WsHandlers, fallback: FallbackRPC) {
    this.wsHandlers = wsHandlers;
    this.fallback = fallback;
  }

  /** 检查节点是否有活跃的 daemon 连接 */
  isDaemonConnected(nodeId: string): boolean {
    return this.wsHandlers.daemonConns.has(nodeId);
  }

  /**
   * 通过 WSS claw_rpc 调用 daemon，失败则降级到 SSH 代理
   * @param nodeConfig - 节点配置
   * @param method - RPC 方法名 (e.g. 'status', 'config.get')
   * @param params - 参数对象
   */
  private async callClaw(
    nodeConfig: NodeConfig,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    if (this.isDaemonConnected(nodeConfig.id)) {
      // 🔵 新路径：WSS → daemon → 本地 OpenClaw
      return this.wsHandlers.sendToDaemon(nodeConfig.id, {
        type: 'claw_rpc',
        method,
        params,
      });
    }
    // 🟡 降级路径：SSH exec curl（旧行为，节点无 daemon 时保持兼容）
    return this.callFallback(nodeConfig, method, params);
  }

  /** 路由到对应的 fallback 方法 */
  private callFallback(
    nodeConfig: NodeConfig,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    switch (method) {
      case 'status':   return this.fallback.getStatus(nodeConfig);
      case 'models':   return this.fallback.getModels(nodeConfig);
      case 'config.get': return this.fallback.getConfig(nodeConfig);
      case 'config.patch': return this.fallback.patchConfig(
        nodeConfig,
        String(params.raw ?? ''),
        String(params.baseHash ?? '')
      );
      case 'sessions.list': return this.fallback.getSessions(nodeConfig);
      case 'channels.status': return this.fallback.getChannels(nodeConfig);
      default: throw new Error(`DaemonProxy: 未知 fallback 方法 ${method}`);
    }
  }

  // ——— ClawRPC 兼容接口（路由层直接替换） ———

  getStatus(nodeConfig: NodeConfig) {
    return this.callClaw(nodeConfig, 'status');
  }

  getModels(nodeConfig: NodeConfig) {
    return this.callClaw(nodeConfig, 'models');
  }

  getConfig(nodeConfig: NodeConfig) {
    return this.callClaw(nodeConfig, 'config.get');
  }

  patchConfig(nodeConfig: NodeConfig, rawPatch: string, baseHash: string) {
    return this.callClaw(nodeConfig, 'config.patch', { raw: rawPatch, baseHash });
  }

  getSessions(nodeConfig: NodeConfig) {
    return this.callClaw(nodeConfig, 'sessions.list');
  }

  getChannels(nodeConfig: NodeConfig) {
    return this.callClaw(nodeConfig, 'channels.status');
  }

  agentRun(nodeConfig: NodeConfig, message: string, sessionKey: string) {
    return this.callClaw(nodeConfig, 'agent.run', { message, sessionKey });
  }
}

module.exports = DaemonProxy;
export {}; // CJS 模块标记
