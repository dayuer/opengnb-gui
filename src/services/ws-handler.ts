'use strict';

const { WebSocketServer } = require('ws');
const { createLogger } = require('./logger');
const { resolveToken, verifyJwt } = require('../middleware/auth');
const { checkCommandSafety } = require('./command-filter');
import alertingGateway from './alerting-gateway';
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
  monitor: { getAllStatus(): WsStatusNode[]; ingestFromDaemon(nodeId: string, frame: Record<string, unknown>): void },
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

      // 提取用户角色用于命令拦截
      const authResult = resolveToken(msg.token);
      const userRole = authResult.role || 'viewer';
      const authUserId = authResult.userId || 'unknown';
      let lineBuf = ''; // 非 admin 的行缓冲区

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

        // RBAC 命令拦截: 非 admin 用户启用行缓冲检查
        if (userRole !== 'admin') {
          const data = typeof msg === 'string' ? msg : msg.toString('utf-8');
          for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            if (ch === '\r' || ch === '\n') {
              // 检查累积的命令行
              const cmd = lineBuf.trim();
              lineBuf = '';
              if (cmd.length > 0) {
                const blocked = checkCommandSafety(cmd);
                if (blocked) {
                  // 发送 Ctrl+U 清除远端行缓冲 + 红色告警
                  sshStream.write('\x15');
                  const warn = `\r\n\x1b[31m🚫 命令被拦截: ${blocked.reason}\x1b[0m\r\n\x1b[33m原始命令: ${cmd}\x1b[0m\r\n`;
                  if (ws.readyState === 1) ws.send(warn);
                  deps.audit.log('ssh_cmd_blocked', { nodeId: targetNodeId, command: cmd, reason: blocked.reason, userId: authUserId });
                  continue;
                }
              }
              // 安全命令或空行 → 转发回车
              sshStream.write(ch);
            } else {
              // 普通字符: 累积到行缓冲 + 实时转发（保持回显）
              lineBuf += ch;
              sshStream.write(ch);
            }
          }
        } else {
          // admin: 零拦截直通
          sshStream.write(msg);
        }
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
    if (pathname === '/ws/daemon') {
      wssDaemon.handleUpgrade(req, socket, head, (ws: WsClient) => { wssDaemon.emit('connection', ws, req); });
    } else if (pathname === '/ws/ssh') {
      wssSsh.handleUpgrade(req, socket, head, (ws: WsClient) => { wssSsh.emit('connection', ws, req); });
    } else if (pathname === '/ws/ai') {
      wssAi.handleUpgrade(req, socket, head, (ws: WsClient) => { wssAi.emit('connection', ws, req); });
    } else if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws: WsClient) => { wss.emit('connection', ws, req); });
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

  // ═══════════════════════════════════════
  // Daemon WebSocket — synon-daemon 控制面通道 (/ws/daemon)
  // ═══════════════════════════════════════

  const wssDaemon = new WebSocketServer({ noServer: true });

  /** nodeId → WsClient 映射（在线 daemon 注册表）*/
  const daemonConns = new Map<string, WsClient>();

  /** reqId → Promise resolve/reject（用于 req/res 配对）*/
  const daemonPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  /** daemon 重连回调 — 由 server.ts 注入，用于密钥滚动补发等逻辑 */
  let onDaemonConnect: ((nodeId: string) => void) | null = null;

  /** 向指定节点的 daemon 发送命令，等待响应（最多 10s）*/
  function sendToDaemon(nodeId: string, cmd: Record<string, unknown>, timeout = 10000): Promise<unknown> {
    const ws = daemonConns.get(nodeId);
    if (!ws || ws.readyState !== 1) {
      return Promise.reject(new Error(`节点 ${nodeId} daemon 未连接`));
    }
    const reqId = `${nodeId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        daemonPending.delete(reqId);
        reject(new Error(`daemon 命令超时 (reqId=${reqId})`));
      }, timeout);

      daemonPending.set(reqId, {
        resolve: (v) => { clearTimeout(timer); daemonPending.delete(reqId); resolve(v); },
        reject: (e) => { clearTimeout(timer); daemonPending.delete(reqId); reject(e); },
      });

      ws.send(JSON.stringify({ ...cmd, reqId }));
    });
  }

  wssDaemon.on('connection', (ws: WsClient) => {
    let nodeId = '';
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pendingPingTs = 0; // 用于 RTT 计算的 ping 发出时间

    // 等待第一帧 hello 鉴权
    ws.once('message', (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { ws.close(4000, 'JSON 解析失败'); return; }

      if (msg.type !== 'hello') { ws.close(4001, '非法首帧'); return; }

      nodeId = String(msg.nodeId || '');
      const token = String(msg.token || '');

      // 复用 resolveToken 鉴权（验证节点的 apiToken）
      const authResult = resolveToken({ headers: { authorization: `apiToken ${token}` } } as unknown as Record<string, unknown>);
      if (!authResult) { ws.close(4003, '认证失败'); return; }

      // 写入 daemonVersion 到内存状态
      const daemonVersion = String(msg.version || '0.0.0');
      daemonConns.set(nodeId, ws);
      log.info(`daemon 已上线: ${nodeId} (v${daemonVersion})`);

      // ① 立即将节点标记为在线（不等下次心跳）
      if (monitor) {
        const existing = monitor.getAllStatus().find((s: WsStatusNode) => s.id === nodeId);
        if (existing) {
          Object.assign(existing, {
            daemonVersion,
            daemonConnectedAt: new Date().toISOString(),
            online: true,
            wsConnected: true,
            error: undefined,
          });
        }
        // 立即推送在线状态给前端
        broadcastMonitorUpdate(monitor.getAllStatus());
      }

      ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));

      // 密钥滚动补发：若该节点有待同步的新公钥，立即发送
      if (onDaemonConnect) onDaemonConnect(nodeId);

      // ② 每 10s 发 WS Ping 帧，测量控制面 RTT
      pingTimer = setInterval(() => {
        if (ws.readyState !== 1) return;
        pendingPingTs = Date.now();
        (ws as unknown as { ping?: (data: Buffer, mask: boolean, cb?: () => void) => void }).ping?.(Buffer.alloc(0), false);
      }, 10000);

      // 接收 Pong — 记录 RTT 写入 monitor 状态
      (ws as unknown as { on: (event: string, fn: (data: Buffer) => void) => void }).on('pong', () => {
        if (!pendingPingTs) return;
        const pingMs = Date.now() - pendingPingTs;
        pendingPingTs = 0;
        if (monitor) {
          const existing = monitor.getAllStatus().find((s: WsStatusNode) => s.id === nodeId);
          if (existing) (existing as Record<string, unknown>).pingMs = pingMs;
          broadcastMonitorUpdate(monitor.getAllStatus());
        }
        log.debug(`ping RTT ${nodeId}: ${pingMs}ms`);
      });

      // 注册后续消息处理器
      ws.on('message', (data: Buffer | string) => {
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(data.toString()); } catch { return; }

        switch (frame.type) {
          case 'heartbeat':
            // 通知 monitor 更新节点状态
            if (monitor && frame.sysInfo) {
              monitor.ingestFromDaemon(nodeId, frame);
            }
            break;

          case 'cmd_result': {
            // 匹配 pending req（兼容 Phase 3 exec_cmd 的 code/stdout/stderr 字段）
            const pending = daemonPending.get(String(frame.reqId || ''));
            if (pending) {
              if (frame.ok) pending.resolve(frame);
              else pending.reject(new Error(String(frame.stderr || (frame.payload as Record<string, unknown>)?.error || '命令失败')));
            }
            break;
          }

          case 'watchdog_alert':
            // 广播 watchdog 告警到前端监控 WS
            broadcast(JSON.stringify({ type: 'watchdog_alert', data: frame }));
            if (audit) {
              audit.log('watchdog_alert', { nodeId, service: frame.service, reason: frame.reason });
            }
            // 推送外部告警通知（飞书/钉钉等）
            alertingGateway.alertWatchdog(
              nodeId,
              String(frame.service || 'unknown'),
              String(frame.reason || ''),
              Boolean(frame.restarted),
            );
            break;

          case 'claw_event':
            // 转发 OpenClaw 实时事件（health/tick）给前端
            broadcast(JSON.stringify({ type: 'claw_event', nodeId, event: frame.event, data: frame.data }));
            break;

          default:
            log.debug(`daemon 未知帧 type=${frame.type}`);
        }
      });
    });

    ws.on('close', () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (nodeId) {
        daemonConns.delete(nodeId);
        log.info(`daemon 已下线: ${nodeId}`);
        // ③ 立即将节点标记为离线，广播给前端
        if (monitor) {
          const existing = monitor.getAllStatus().find((s: WsStatusNode) => s.id === nodeId);
          if (existing) {
            Object.assign(existing, {
              online: false,
              wsConnected: false,
              pingMs: null,
              error: 'daemon WS 断开',
            });
          }
          broadcastMonitorUpdate(monitor.getAllStatus());
        }
      }
    });
  });

  return {
    wss,
    wssDaemon,
    broadcast,
    broadcastSnapshot,
    broadcastMonitorUpdate,
    enrichNodesData,
    sendToDaemon,
    daemonConns,
    setOnDaemonConnect: (fn: (nodeId: string) => void) => { onDaemonConnect = fn; },
  };
}

module.exports = { createWsHandlers };
export {}; // CJS 模块标记
