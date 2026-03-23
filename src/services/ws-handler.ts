'use strict';

const { WebSocketServer } = require('ws');
const { createLogger } = require('./logger');
const { resolveToken } = require('../middleware/auth');
const log = createLogger('WsHandler');
import type { Server } from 'http';
import type { Duplex } from 'stream';

/** WebSocket 客户端扩展 */
interface WsClient {
  readyState: number;
  _authenticated?: boolean;
  _userId?: string;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  once(event: string, fn: (...args: unknown[]) => void): void;
  on(event: string, fn: (...args: unknown[]) => void): void;
}

/** 状态节点 */
interface WsStatusNode {
  id: string;
  name?: string;
  groupId?: string;
  [key: string]: unknown;
}

const MAX_WS_CLIENTS = 10;

/**
 * WebSocket 处理器工厂
 *
 * 管理 3 个 WebSocket 服务器：
 * - wss     — 监控数据推送（主 WS）
 * - wssSsh  — SSH 终端代理
 * - wssAi   — AI Chat 代理
 *
 * @param {object} deps - 依赖注入
 * @returns {{ wss, broadcast }}
 */
function createWsHandlers(deps: {
  server: Server,
  keyManager: { getApprovedNodesConfig(): Record<string, unknown>[]; getPendingNodes(): Record<string, unknown>[]; getGroups(): unknown[]; getNodesByOwner(userId: string): unknown[] },
  monitor: { getAllStatus(): WsStatusNode[] },
  aiOps: { _resolveNode(nodeId: string | null): Record<string, unknown> | undefined; streamChat(nc: Record<string, unknown> | null | undefined, prompt: string, cb: (chunk: Record<string, unknown>) => void): { kill(): void } },
  sshManager: { shell(nodeConfig: Record<string, unknown>, opts: { cols: number; rows: number }): Promise<unknown> },
  audit: { log(action: string, data: Record<string, unknown>, req?: unknown): void },
  opsLog: { loadAllOpsLogs: () => Record<string, unknown> },
}) {
  const { server, keyManager, monitor, aiOps, sshManager, audit, opsLog } = deps;

  // --- 辅助函数 ---

  /** 合并监控数据 + Claw 配置 */
  function enrichNodesData(statusArr: WsStatusNode[]) {
    const configs = keyManager.getApprovedNodesConfig();
    return statusArr.map((s: WsStatusNode) => {
      const cfg = configs.find((c: Record<string, unknown>) => c.id === s.id);
      return {
        ...s,
        clawToken: cfg?.clawToken && typeof cfg.clawToken === 'string' ? cfg.clawToken.substring(0, 8) + '...' : '',
        clawPort: cfg?.clawPort || 0,
        groupId: cfg?.groupId || s.groupId || '',
      };
    });
  }

  // ═══════════════════════════════════════
  // 主 WebSocket — 监控数据推送
  // ═══════════════════════════════════════

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WsClient, req: { url: string }) => {
    if (wss.clients.size > MAX_WS_CLIENTS) {
      ws.close(4002, '连接数超限');
      return;
    }

    let authenticated = false;
    const url = new URL(req.url, 'http://localhost');
    const wsToken = url.searchParams.get('token');
    if (wsToken) {
      const result = resolveToken(wsToken);
      if (result.valid) {
        authenticated = true;
        ws._userId = result.userId;
      }
    }

    const AUTH_TIMEOUT = 5000;
    let authTimer: ReturnType<typeof setTimeout> | null = null;

    function onAuthenticated() {
      if (authTimer) { clearTimeout(authTimer); authTimer = null; }
      ws._authenticated = true;
      log.info(`客户端已认证 (userId: ${ws._userId || 'unknown'})`);
      audit.log('ws_connect', {}, req);

      const userId = ws._userId || '';
      ws.send(JSON.stringify({
        type: 'snapshot',
        data: enrichNodesData(monitor.getAllStatus()),
        pending: keyManager.getPendingNodes().filter((n: Record<string, unknown>) => !n.ownerId || n.ownerId === userId),
        groups: keyManager.getGroups(),
        allNodes: keyManager.getNodesByOwner(userId),
        timestamp: new Date().toISOString(),
      }));
      const allLogs = opsLog.loadAllOpsLogs();
      if (Object.keys(allLogs).length > 0) {
        ws.send(JSON.stringify({ type: 'chat_history', logs: allLogs }));
      }
    }

    if (authenticated) {
      onAuthenticated();
    } else {
      authTimer = setTimeout(() => {
        if (!authenticated) {
          audit.log('ws_auth_fail', { reason: 'timeout' }, req);
          ws.close(4001, '认证超时');
        }
      }, AUTH_TIMEOUT);

      ws.once('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth' && msg.token) {
            const result = resolveToken(msg.token);
            if (result.valid) {
              authenticated = true;
              ws._userId = result.userId;
              onAuthenticated();
            } else {
              audit.log('ws_auth_fail', { reason: 'invalid_token' }, req);
              ws.close(4001, '认证失败');
            }
          } else {
            ws.close(4001, '认证消息格式错误');
          }
        } catch {
          ws.close(4001, '认证消息格式错误');
        }
      });
    }

    ws.on('close', () => {
      if (authTimer) clearTimeout(authTimer);
      log.debug('客户端断开');
    });
  });

  // ═══════════════════════════════════════
  // SSH 终端 WebSocket
  // ═══════════════════════════════════════

  const wssSsh = new WebSocketServer({ noServer: true });

  wssSsh.on('connection', async (ws: WsClient, req: { url: string }) => {
    const url = new URL(req.url, 'http://localhost');
    const nodeId = url.searchParams.get('nodeId');
    const cols = parseInt(url.searchParams.get('cols') as string) || 80;
    const rows = parseInt(url.searchParams.get('rows') as string) || 24;

    const AUTH_TIMEOUT = 5000;
    const authTimer = setTimeout(() => {
      ws.close(4001, '认证超时');
    }, AUTH_TIMEOUT);

    ws.once('message', async (data: Buffer) => {
      clearTimeout(authTimer);
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) {
        ws.close(4001, '认证消息格式错误');
        return;
      }
      if (msg.type !== 'auth' || !msg.token || !resolveToken(msg.token).valid) {
        ws.close(4001, '认证失败');
        return;
      }

      const targetNodeId = msg.nodeId || nodeId;
      if (!targetNodeId) {
        ws.close(4003, '缺少 nodeId');
        return;
      }
      const configs = keyManager.getApprovedNodesConfig();
      const nodeConfig = configs.find((c: Record<string, unknown>) => c.id === targetNodeId);
      if (!nodeConfig) {
        ws.close(4004, '节点不存在');
        return;
      }

      log.info(`SSH 连接: 节点 ${nodeConfig.name || targetNodeId}`);

      let sshStream = null;
      try {
        sshStream = await sshManager.shell(nodeConfig, { cols: msg.cols || cols, rows: msg.rows || rows });
      } catch (err: unknown) {
        log.error(`SSH Shell 创建失败: ${err instanceof Error ? err.message : String(err)}`);
        ws.send(`\r\n\x1b[31m连接失败: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`);
        ws.close(4005, 'SSH 连接失败');
        return;
      }

      sshStream.on('data', (data: Buffer) => {
        if (ws.readyState === 1) ws.send(data);
      });
      sshStream.stderr.on('data', (data: Buffer) => {
        if (ws.readyState === 1) ws.send(data);
      });
      sshStream.on('close', () => {
        log.debug(`SSH Stream 关闭: ${targetNodeId}`);
        if (ws.readyState === 1) ws.close(1000, 'SSH 会话结束');
      });

      ws.on('message', (msg: Buffer | string) => {
        if (!sshStream || sshStream.destroyed) return;
        if (typeof msg === 'string' || (msg instanceof Buffer && msg[0] === 0x7b)) {
          try {
            const ctrl = JSON.parse(msg.toString());
            if (ctrl.type === 'resize' && ctrl.cols && ctrl.rows) {
              sshStream.setWindow(ctrl.rows, ctrl.cols, 0, 0);
              return;
            }
          } catch (_) { /* 不是 JSON，当作普通输入 */ }
        }
        sshStream.write(msg);
      });

      ws.on('close', () => {
        log.debug(`WebSocket 断开: ${targetNodeId}`);
        if (sshStream && !sshStream.destroyed) {
          sshStream.end();
          sshStream.destroy();
        }
      });
      ws.on('error', (err: Error) => {
        log.error(`WebSocket 错误: ${err.message}`);
        if (sshStream && !sshStream.destroyed) sshStream.destroy();
      });
    });
  });

  // ═══════════════════════════════════════
  // AI Chat 终端 WebSocket
  // ═══════════════════════════════════════

  const wssAi = new WebSocketServer({ noServer: true });

  wssAi.on('connection', (ws: WsClient, req: { url: string }) => {
    const AUTH_TIMEOUT = 5000;
    let authenticated = false;
    let nodeId: string | null = null;

    const authTimer = setTimeout(() => {
      if (!authenticated) ws.close(4001, '认证超时');
    }, AUTH_TIMEOUT);

    ws.once('message', (raw: Buffer) => {
      clearTimeout(authTimer);
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) {
        ws.close(4001, '认证消息格式错误');
        return;
      }
      if (msg.type !== 'auth' || !msg.token) {
        ws.close(4001, '认证消息格式错误');
        return;
      }
      const authResult = resolveToken(msg.token);
      if (!authResult.valid) {
        ws.send(JSON.stringify({ type: 'error', text: '认证失败' }));
        ws.close(4001);
        return;
      }
      authenticated = true;
      nodeId = msg.nodeId || null;
      log.info(`AI 连接: nodeId=${nodeId}, user=${authResult.userId}`);

      const nodeConfig = aiOps._resolveNode(nodeId);
      let activeHandle: { kill(): void } | null = null;

      ws.on('message', (raw: Buffer) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

        if (msg.type === 'chat' && msg.text?.trim()) {
          if (activeHandle) {
            ws.send(JSON.stringify({ type: 'busy', text: '上一条指令仍在执行，请稍候...' }));
            return;
          }

          ws.send(JSON.stringify({ type: 'ack', text: msg.text }));
          activeHandle = aiOps.streamChat(nodeConfig, msg.text, (chunk: Record<string, unknown>) => {
            if (ws.readyState !== 1) return;
            ws.send(JSON.stringify(chunk));
            if (chunk.type === 'done' || chunk.type === 'error') {
              activeHandle = null;
            }
          });
        }
      });

      ws.on('close', () => {
        log.debug('AI 会话断开');
        if (activeHandle) activeHandle.kill();
      });

      ws.on('error', (err: Error) => {
        log.error(`AI WebSocket 错误: ${err.message}`);
        if (activeHandle) activeHandle.kill();
      });
    });
  });

  // ═══════════════════════════════════════
  // HTTP upgrade 路由分发
  // ═══════════════════════════════════════

  server.on('upgrade', (req: { url: string }, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws: WsClient) => { wss.emit('connection', ws, req); });
    } else if (pathname === '/ws/ssh') {
      wssSsh.handleUpgrade(req, socket, head, (ws: WsClient) => { wssSsh.emit('connection', ws, req); });
    } else if (pathname === '/ws/ai') {
      wssAi.handleUpgrade(req, socket, head, (ws: WsClient) => { wssAi.emit('connection', ws, req); });
    } else {
      socket.destroy();
    }
  });

  // --- 公开接口 ---

  /** 向所有已认证 WS 客户端广播消息 */
  function broadcast(msg: string | Record<string, unknown>) {
    const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  }

  /** 向所有已认证客户端广播用户专属 snapshot */
  function broadcastSnapshot(action: string, nodeId: string) {
    for (const client of wss.clients) {
      if (client.readyState !== 1 || !client._authenticated) continue;
      const userId = client._userId || '';
      const snapshot = JSON.stringify({
        type: 'snapshot',
        allNodes: keyManager.getNodesByOwner(userId),
        timestamp: new Date().toISOString(),
      });
      client.send(snapshot);
    }
    log.info(`广播 snapshot (${action}: ${nodeId})`);
  }

  /** 推送监控更新（monitor 'update' 事件的处理器） */
  function broadcastMonitorUpdate(allStatus: WsStatusNode[]) {
    for (const client of wss.clients) {
      if (client.readyState !== 1 || !client._authenticated) continue;
      const userId = client._userId || '';
      const payload = JSON.stringify({
        type: 'update',
        data: enrichNodesData(allStatus),
        pending: keyManager.getPendingNodes().filter((n: Record<string, unknown>) => !n.ownerId || n.ownerId === userId),
        groups: keyManager.getGroups(),
        allNodes: keyManager.getNodesByOwner(userId),
        timestamp: new Date().toISOString(),
      });
      client.send(payload);
    }
  }

  return {
    wss,
    broadcast,
    broadcastSnapshot,
    broadcastMonitorUpdate,
    enrichNodesData,
  };
}

module.exports = { createWsHandlers };
export {}; // CJS 模块标记
