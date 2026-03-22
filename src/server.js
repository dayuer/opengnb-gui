'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

const KeyManager = require('./services/key-manager');
const SSHManager = require('./services/ssh-manager');
const GnbMonitor = require('./services/gnb-monitor');
const AiOps = require('./services/ai-ops');
const Provisioner = require('./services/provisioner');
const AuditLogger = require('./services/audit-logger');
const MetricsStore = require('./services/metrics-store');
const createNodesRouter = require('./routes/nodes');
const createAiRouter = require('./routes/ai');
const createEnrollRouter = require('./routes/enroll');
const createMirrorRouter = require('./routes/mirror');
const createClawRouter = require('./routes/claw');
const createAuthRouter = require('./routes/auth');
const createJobsRouter = require('./routes/jobs');
const ClawRPC = require('./services/claw-rpc');
const { requireAuth, requireAdmin, initToken, getAdminToken, setJwtSecret, setStore, hashPassword, verifyJwt } = require('./middleware/auth');
const { createRateLimit } = require('./middleware/rate-limit');
const { errorHandler } = require('./middleware/error-handler');
const { resolvePaths, ensureDataDirs } = require('./services/data-paths');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data');

// @alpha: 集中路径管理 + 自动创建目录
const dataPaths = resolvePaths(DATA_DIR);
ensureDataDirs(dataPaths);

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve(__dirname, '../public')));

// --- 安全响应头（安全审计 L5 修复） ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// --- 全局速率限制 ---
app.use('/api', createRateLimit({ windowMs: 60000, max: 200 }));

const keyManager = new KeyManager({ dataDir: DATA_DIR, paths: dataPaths });
const sshManager = new SSHManager({ knownHostsPath: path.join(DATA_DIR, 'security', 'known_hosts.json') });

// --- 运维日志持久化（按终端分开存储） ---
const OPS_LOG_DIR = dataPaths.logs.opsDir;
const MAX_OPS_LOG = 200;

function loadOpsLog(nodeId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(OPS_LOG_DIR, `${nodeId}.json`), 'utf-8'));
  } catch (_) { return []; }
}

function saveOpsLog(nodeId, role, content) {
  const logPath = path.join(OPS_LOG_DIR, `${nodeId}.json`);
  let logs = loadOpsLog(nodeId);
  logs.push({ role, content, ts: new Date().toISOString() });
  if (logs.length > MAX_OPS_LOG) logs = logs.slice(-MAX_OPS_LOG);
  try { fs.writeFileSync(logPath, JSON.stringify(logs, null, 2)); } catch (_) {}
}

function loadAllOpsLogs() {
  try {
    const files = fs.readdirSync(OPS_LOG_DIR).filter(f => f.endsWith('.json'));
    const all = {};
    for (const f of files) {
      const nodeId = f.replace('.json', '');
      all[nodeId] = loadOpsLog(nodeId);
    }
    return all;
  } catch (_) { return {}; }
}

async function boot() {
  // 初始化认证 Token（向后兼容）
  const adminToken = initToken();

  // 初始化审计日志（共享 NodeStore SQLite 实例，需在 keyManager.init 后）
  await keyManager.init();

  // @alpha: JWT secret — 用 Console 私钥的哈希
  const jwtSecret = require('crypto')
    .createHash('sha256')
    .update(keyManager.getPrivateKey())
    .digest('hex');
  setJwtSecret(jwtSecret);

  // @alpha: 首次启动自动创建 admin 用户
  const store = keyManager.store;
  setStore(store);

  // @alpha: 异步 Job 管理器（SQLite 持久化）
  const JobManager = require('./services/job-manager');
  const jobManager = new JobManager({ store, timeoutMs: 60000 });
  if (store.userCount() === 0) {
    const crypto = require('crypto');
    const tempPwd = crypto.randomBytes(8).toString('hex');
    const id = crypto.randomBytes(8).toString('hex');
    const apiToken = crypto.randomBytes(16).toString('hex'); // @security: 128-bit 熵（安全审计 H2 修复）
    store.insertUser({ id, username: 'admin', passwordHash: hashPassword(tempPwd) });
    store._stmts.updateApiToken.run(apiToken, id);
    // @security: 密码写入文件而非 stdout（安全审计 L1 修复）
    const credFile = path.join(DATA_DIR, '.initial-credentials');
    const credContent = `admin:${tempPwd}\napiToken:${apiToken}\ncreated:${new Date().toISOString()}`;
    fs.writeFileSync(credFile, credContent, { mode: 0o600 });
    console.log(`\n  👤 首次启动，已创建管理员账号。`);
    console.log(`     凭据已写入: ${credFile}`);
    console.log(`     ⚠️  请登录后及时修改密码\n`);
  }

  const audit = new AuditLogger({ store });

  // 已审批节点配置
  const approvedNodes = keyManager.getApprovedNodesConfig();

  // @alpha: 初始化指标时序存储（共享 NodeStore SQLite 实例）
  const metricsStore = new MetricsStore({ store: keyManager.store });

  const monitor = new GnbMonitor(approvedNodes, {
    staleTimeoutMs: parseInt(process.env.STALE_TIMEOUT_MS || '60000', 10),
    metricsStore,
  });

  const provisioner = new Provisioner({
    sshManager,
    provisionConfig: {
      indexNodes: process.env.GNB_INDEX_NODES || '',
    },
  });

  const aiOps = new AiOps({
    nodesConfig: approvedNodes,
    sshManager,
    getNodeStatus: () => monitor.getAllStatus(),
    provisioner,
    jobManager,
  });

  const clawRPC = new ClawRPC(sshManager);

  // 审批回调：更新监控（V2: 移除全量 SSH 推送，节点通过 GET /api/enroll/address-conf 自行拉取）
  keyManager.onApproval = (updatedNodes) => {
    monitor.nodesConfig = updatedNodes;
    aiOps.nodesConfig = updatedNodes;
    if (!monitor._staleTimer && updatedNodes.length > 0) monitor.start();
    console.log(`[Approval] 监控已更新: ${updatedNodes.length} 个节点`);
  };

  // @alpha: 节点列表变更回调 — 广播用户专属 WS snapshot 实现前端实时更新
  keyManager.onChange = (action, nodeId) => {
    if (!wss) return;
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
    console.log(`[WS] 广播 snapshot (${action}: ${nodeId})`);
  };

  // 就绪回调：节点完成 synon + 公钥部署后，自动 SSH 安装 OpenClaw
  keyManager.onNodeReady = (nodeConfig) => {
    console.log(`[Ready] 节点 ${nodeConfig.id} 已就绪，启动 OpenClaw 远程安装`);
    provisioner.provision(nodeConfig, { installGnb: false, installClaw: true });
  };

  // @alpha: 编辑回调：同步运行时配置（远程 GNB 同步已移至 PUT 路由）
  keyManager.onNodeUpdate = (nodeId, changedFields) => {
    const updated = keyManager.getApprovedNodesConfig();
    monitor.nodesConfig = updated;
    aiOps.nodesConfig = updated;
    // tunAddr/sshPort/sshUser 变更时，旧 SSH 连接不再可用
    if (changedFields.some(f => ['tunAddr', 'sshPort', 'sshUser'].includes(f))) {
      sshManager.disconnect(nodeId);
    }
    console.log(`[NodeUpdate] 节点 ${nodeId} 已更新 [${changedFields.join(', ')}]`);
  };

  // --- 敏感端点速率限制 ---
  const strictLimit = createRateLimit({ windowMs: 60000, max: 20, message: '敏感操作请求过于频繁' });

  // --- API 路由 ---

  // V3 推模式：节点 agent 上报（统一认证 — ADMIN_TOKEN / apiToken / JWT）
  app.post('/api/monitor/report', express.json({ limit: '64kb' }), (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: '缺少认证' });

    // 统一管理员认证（与 WS 一致）
    let isAdmin = false;
    if (adminToken && token === adminToken) {
      isAdmin = true;
    } else if (store && token.length <= 64) {
      const user = store._stmts.findUserByApiToken?.get(token);
      if (user) isAdmin = true;
    } else {
      const payload = verifyJwt(token);
      if (payload) isAdmin = true;
    }

    // 管理员 + nodeId → 定位节点
    const nodeId = req.query.nodeId || req.body.nodeId;
    if (isAdmin && nodeId) {
      const allNodes = keyManager.getAllNodes();
      // @alpha: 优先精确匹配 id，回退匹配 name（兼容旧 hostname-based agent.env）
      let node = allNodes.find(n => n.id === nodeId && n.status === 'approved');
      if (!node) {
        node = allNodes.find(n => n.name === nodeId && n.status === 'approved');
      }
      if (node) {
        monitor.ingest(node.id, req.body);
        return res.json({ success: true, nodeId: node.id });
      }
    }

    return res.status(403).json({ error: '无效 token 或节点未找到' });
  });

  // 认证路由（login 公开，其余需认证）— @security: loginLimit 仅限制 /login 端点（安全审计 M1 修复）
  const loginLimit = createRateLimit({ windowMs: 60000, max: 5, message: '登录尝试过于频繁，请 1 分钟后重试' });
  app.post('/api/auth/login', loginLimit); // 仅对 login 端点限速
  app.use('/api/auth', express.json(), createAuthRouter(store));

  // 需认证 + 审计的管理路由
  app.use('/api/nodes', requireAuth, audit.middleware('nodes'), createNodesRouter(monitor, sshManager, monitor.nodesConfig, keyManager, metricsStore));
  app.use('/api/ai', requireAuth, strictLimit, audit.middleware('ai_ops'), createAiRouter(aiOps, saveOpsLog));

  // @alpha: 异步 Job 路由 — callback 端点公开（clawToken 认证），其余需管理员认证
  // 注意：wss 在后面初始化，此处用闭包延迟访问
  app.use('/api/jobs', createJobsRouter({
    jobManager,
    sshManager,
    keyManager: { getNodeById: (id) => store.findById(id) },
    requireAuth,
    broadcastWS: (msg) => {
      if (!wss) return;
      const data = JSON.stringify(msg);
      wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(data); });
    },
  }));

  // 初始化脚本下载（公开，必须在 enroll 路由之前注册）
  app.get('/api/enroll/init.sh', (req, res) => {
    const scriptPath = path.resolve(__dirname, '../scripts/initnode.sh');
    res.type('text/plain').sendFile(scriptPath);
  });
  app.get('/api/enroll/node-agent.sh', (req, res) => {
    const scriptPath = path.resolve(__dirname, '../scripts/node-agent.sh');
    res.type('text/plain').sendFile(scriptPath);
  });
  app.get('/api/enroll/setup.sh', (req, res) => {
    const scriptPath = path.resolve(__dirname, '../scripts/setup-console.sh');
    res.type('text/plain').sendFile(scriptPath);
  });

  // enroll 路由 — 分层认证（内部由 enrollRouter 处理公开/管理端点分离）
  app.use('/api/enroll', createEnrollRouter(keyManager, { requireAuth, audit }));

  // 镜像下载 — 公开
  app.use('/api/mirror', createMirrorRouter(DATA_DIR));

  // OpenClaw 管理 — 需认证
  app.use('/api/claw', requireAuth, audit.middleware('claw'), createClawRouter({
    clawRPC,
    getNodesConfig: () => keyManager.getApprovedNodesConfig(),
  }));

  // 配置下发 API — 需认证
  app.post('/api/provision/:id', requireAuth, strictLimit, audit.middleware('provision'), async (req, res) => {
    const nodeConfig = keyManager.getApprovedNodesConfig().find(n => n.id === req.params.id);
    if (!nodeConfig) return res.status(404).json({ error: '节点未审批或不存在' });

    res.json({ status: 'started', message: `开始配置下发: ${nodeConfig.name}` });
    provisioner.provision(nodeConfig, req.body || {});
  });

  app.get('/api/provision/:id/status', requireAuth, (req, res) => {
    const task = provisioner.getTaskStatus(req.params.id);
    if (!task) return res.status(404).json({ error: '无配置下发任务' });
    res.json(task);
  });

  // 健康检查 — @security: 精简返回信息（安全审计 L2 修复）
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // SPA fallback
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.resolve(__dirname, '../public/index.html'));
    }
  });

  // --- 统一错误处理（必须在所有路由之后） ---
  app.use(errorHandler);

  // --- WebSocket ---
  // 合并监控数据 + Claw 配置
  function enrichNodesData(statusArr) {
    const configs = keyManager.getApprovedNodesConfig();
    return statusArr.map(s => {
      const cfg = configs.find(c => c.id === s.id);
      return {
        ...s,
        clawToken: cfg?.clawToken ? cfg.clawToken.substring(0, 8) + '...' : '',
        clawPort: cfg?.clawPort || 0,
        groupId: cfg?.groupId || s.groupId || '',
      };
    });
  }

  const wss = new WebSocketServer({ noServer: true });
  const MAX_WS_CLIENTS = 10;

  // @alpha: WS token 校验 — 兼容 adminToken、JWT、apiToken，返回 {valid, userId}
  function _resolveWsToken(token) {
    if (adminToken && token === adminToken) return { valid: true, userId: 'admin' };
    // JWT
    const payload = verifyJwt(token);
    if (payload) return { valid: true, userId: payload.userId || '' };
    // apiToken
    if (store && token.length <= 64) {
      const user = store._stmts.findUserByApiToken?.get(token);
      if (user) return { valid: true, userId: user.id };
    }
    return { valid: false, userId: '' };
  }

  wss.on('connection', (ws, req) => {
    // 连接数限制
    if (wss.clients.size > MAX_WS_CLIENTS) {
      ws.close(4002, '连接数超限');
      return;
    }

    // @alpha: WebSocket 认证 — 支持 URL 参数（兼容）和首条消息认证（安全）
    // 同时兼容 adminToken 和 JWT
    let authenticated = false;
    const url = new URL(req.url, 'http://localhost');
    const wsToken = url.searchParams.get('token');
    if (wsToken) {
      const result = _resolveWsToken(wsToken);
      if (result.valid) {
        authenticated = true;
        ws._userId = result.userId;
      }
    }

    // @alpha: 首条消息认证（推荐方式，token 不暴露在 URL 中）
    const AUTH_TIMEOUT = 5000;
    let authTimer = null;

    function onAuthenticated() {
      if (authTimer) { clearTimeout(authTimer); authTimer = null; }
      ws._authenticated = true;
      console.log(`[WS] 客户端已认证 (userId: ${ws._userId || 'unknown'})`);
      audit.log('ws_connect', {}, req);

      // @alpha: 按用户过滤节点列表
      const userId = ws._userId || '';
      ws.send(JSON.stringify({
        type: 'snapshot',
        data: enrichNodesData(monitor.getAllStatus()),
        pending: keyManager.getPendingNodes().filter(n => !n.ownerId || n.ownerId === userId),
        groups: keyManager.getGroups(),
        allNodes: keyManager.getNodesByOwner(userId),
        timestamp: new Date().toISOString(),
      }));
      const allLogs = loadAllOpsLogs();
      if (Object.keys(allLogs).length > 0) {
        ws.send(JSON.stringify({ type: 'chat_history', logs: allLogs }));
      }
    }

    if (authenticated) {
      onAuthenticated();
    } else {
      // 等待首条消息认证，超时断开
      authTimer = setTimeout(() => {
        if (!authenticated) {
          audit.log('ws_auth_fail', { reason: 'timeout' }, req);
          ws.close(4001, '认证超时');
        }
      }, AUTH_TIMEOUT);

      ws.once('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'auth' && msg.token) {
            const result = _resolveWsToken(msg.token);
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
      console.log('[WS] 客户端断开');
    });
  });

  // --- Web SSH 终端 WebSocket ---
  const wssSsh = new WebSocketServer({ noServer: true });

  wssSsh.on('connection', async (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const nodeId = url.searchParams.get('nodeId');
    const cols = parseInt(url.searchParams.get('cols')) || 80;
    const rows = parseInt(url.searchParams.get('rows')) || 24;

    // @security: 改为首条消息认证，不再从 URL 提取 token（安全审计 H1 修复）
    const AUTH_TIMEOUT = 5000;
    const authTimer = setTimeout(() => {
      ws.close(4001, '认证超时');
    }, AUTH_TIMEOUT);

    ws.once('message', async (data) => {
      clearTimeout(authTimer);
      let msg;
      try { msg = JSON.parse(data.toString()); } catch (_) {
        ws.close(4001, '认证消息格式错误');
        return;
      }
      if (msg.type !== 'auth' || !msg.token || !_resolveWsToken(msg.token).valid) {
        ws.close(4001, '认证失败');
        return;
      }

      // 认证通过，建立 SSH
      const targetNodeId = msg.nodeId || nodeId;
      if (!targetNodeId) {
        ws.close(4003, '缺少 nodeId');
        return;
      }
      const configs = keyManager.getApprovedNodesConfig();
      const nodeConfig = configs.find(c => c.id === targetNodeId);
      if (!nodeConfig) {
        ws.close(4004, '节点不存在');
        return;
      }

      console.log(`[SSH-WS] 建立连接: 节点 ${nodeConfig.name || targetNodeId}`);

      let sshStream = null;
      try {
        sshStream = await sshManager.shell(nodeConfig, { cols: msg.cols || cols, rows: msg.rows || rows });
      } catch (err) {
        console.error(`[SSH-WS] SSH Shell 创建失败: ${err.message}`);
        ws.send(`\r\n\x1b[31m连接失败: ${err.message}\x1b[0m\r\n`);
        ws.close(4005, 'SSH 连接失败');
        return;
      }

      // SSH stdout → WebSocket
      sshStream.on('data', (data) => {
        if (ws.readyState === 1) ws.send(data);
      });
      sshStream.stderr.on('data', (data) => {
        if (ws.readyState === 1) ws.send(data);
      });
      sshStream.on('close', () => {
        console.log(`[SSH-WS] SSH Stream 关闭: ${targetNodeId}`);
        if (ws.readyState === 1) ws.close(1000, 'SSH 会话结束');
      });

      // WebSocket → SSH stdin
      ws.on('message', (msg) => {
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
        console.log(`[SSH-WS] WebSocket 断开: ${targetNodeId}`);
        if (sshStream && !sshStream.destroyed) {
          sshStream.end();
          sshStream.destroy();
        }
      });
      ws.on('error', (err) => {
        console.error(`[SSH-WS] WebSocket 错误: ${err.message}`);
        if (sshStream && !sshStream.destroyed) sshStream.destroy();
      });
    });
  });

  // --- AI Chat 终端 WebSocket ---
  // @alpha: 用户发自然语言 → Claude Code 流式执行 → 结果流式推送
  const wssAi = new WebSocketServer({ noServer: true });

  wssAi.on('connection', (ws, req) => {
    // @security: 改为首条消息认证（安全审计 H1 修复）
    const AUTH_TIMEOUT = 5000;
    let authenticated = false;
    let nodeId = null;

    const authTimer = setTimeout(() => {
      if (!authenticated) ws.close(4001, '认证超时');
    }, AUTH_TIMEOUT);

    ws.once('message', (raw) => {
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
      const authResult = _resolveWsToken(msg.token);
      if (!authResult.valid) {
        ws.send(JSON.stringify({ type: 'error', text: '认证失败' }));
        ws.close(4001);
        return;
      }
      authenticated = true;
      nodeId = msg.nodeId || null;
      console.log(`[AI-WS] 连接: nodeId=${nodeId}, user=${authResult.userId}`);

      const nodeConfig = aiOps._resolveNode(nodeId);
      let activeHandle = null;

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

        if (msg.type === 'chat' && msg.text?.trim()) {
          if (activeHandle) {
            ws.send(JSON.stringify({ type: 'busy', text: '上一条指令仍在执行，请稍候...' }));
            return;
          }

          ws.send(JSON.stringify({ type: 'ack', text: msg.text }));
          activeHandle = aiOps.streamChat(nodeConfig, msg.text, (chunk) => {
            if (ws.readyState !== 1) return;
            ws.send(JSON.stringify(chunk));
            if (chunk.type === 'done' || chunk.type === 'error') {
              activeHandle = null;
            }
          });
        }
      });

      ws.on('close', () => {
        console.log('[AI-WS] 断开');
        if (activeHandle) activeHandle.kill();
      });

      ws.on('error', (err) => {
        console.error(`[AI-WS] 错误: ${err.message}`);
        if (activeHandle) activeHandle.kill();
      });
    });
  });

  // --- HTTP upgrade 路由：手动分发到对应 WSS ---
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
    } else if (pathname === '/ws/ssh') {
      wssSsh.handleUpgrade(req, socket, head, (ws) => { wssSsh.emit('connection', ws, req); });
    } else if (pathname === '/ws/ai') {
      wssAi.handleUpgrade(req, socket, head, (ws) => { wssAi.emit('connection', ws, req); });
    } else {
      socket.destroy();
    }
  });

  // 监控更新 + 待审批推送 — @security: 按用户过滤（安全审计 M4 修复）
  monitor.on('update', (allStatus) => {
    for (const client of wss.clients) {
      if (client.readyState !== 1 || !client._authenticated) continue;
      const userId = client._userId || '';
      const payload = JSON.stringify({
        type: 'update',
        data: enrichNodesData(allStatus),
        pending: keyManager.getPendingNodes().filter(n => !n.ownerId || n.ownerId === userId),
        groups: keyManager.getGroups(),
        allNodes: keyManager.getNodesByOwner(userId),
        timestamp: new Date().toISOString(),
      });
      client.send(payload);
    }
  });

  // 配置下发日志推送 + 持久化
  provisioner.on('log', ({ nodeId, message }) => {
    saveOpsLog(nodeId, 'assistant', message);
    const payload = JSON.stringify({ type: 'provision_log', nodeId, message });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  });

  // @alpha: Agent 上报 OpenClaw token → 自动写入节点配置（推模式自发现）
  monitor.on('clawDiscovered', ({ nodeId, token, port }) => {
    if (token) {
      keyManager.updateNodeClawConfig(nodeId, { token, port });
      const updated = keyManager.getApprovedNodesConfig();
      monitor.nodesConfig = updated;
      aiOps.nodesConfig = updated;
      console.log(`[ClawDiscovered] 节点 ${nodeId} 从 Agent 上报自动写入 Token (port=${port})`);
    }
  });

  // OpenClaw token 就绪 → 保存到节点配置
  provisioner.on('claw_ready', ({ nodeId, token, port }) => {
    if (token) {
      keyManager.updateNodeClawConfig(nodeId, { token, port });
      // 刷新 aiOps 和 monitor 的节点列表
      const updated = keyManager.getApprovedNodesConfig();
      aiOps.nodesConfig = updated;
      console.log(`[ClawReady] 节点 ${nodeId} Token 已保存`);
    }
  });

  // --- 启动 ---
  server.listen(PORT, () => {
    console.log(`\n  ╔═══════════════════════════════════════════╗`);
    console.log(`  ║  SynonClaw Console — Management Platform  ║`);
    console.log(`  ╠═══════════════════════════════════════════╣`);
    console.log(`  ║  HTTP:  http://localhost:${PORT}             ║`);
    console.log(`  ║  WS:    ws://localhost:${PORT}/ws            ║`);
    console.log(`  ║  Auth:  Bearer Token ✓                     ║`);
    console.log(`  ║  Nodes: ${approvedNodes.length} approved / ${keyManager.getPendingNodes().length} pending        ║`);
    console.log(`  ╚═══════════════════════════════════════════╝\n`);
    console.log(`  节点初始化:`);
    console.log(`  curl -sSL http://<TUN_IP>:${PORT}/api/enroll/init.sh | \\`);
    console.log(`    CONSOLE=<TUN_IP>:${PORT} NODE_ID=<ID> TUN_ADDR=<IP> bash\n`);

    if (approvedNodes.length > 0) monitor.start();
  });

  const shutdown = () => {
    console.log('\n[Server] 正在关闭...');
    monitor.stop();
    sshManager.closeAll();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

boot().catch(err => {
  console.error('[Boot] 启动失败:', err);
  process.exit(1);
});
