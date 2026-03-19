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
const createNodesRouter = require('./routes/nodes');
const createAiRouter = require('./routes/ai');
const createEnrollRouter = require('./routes/enroll');
const createMirrorRouter = require('./routes/mirror');
const createClawRouter = require('./routes/claw');
const ClawRPC = require('./services/claw-rpc');
const { requireAuth, initToken, getAdminToken } = require('./middleware/auth');
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

// --- 全局速率限制 ---
app.use('/api', createRateLimit({ windowMs: 60000, max: 200 }));

const keyManager = new KeyManager({ dataDir: DATA_DIR, paths: dataPaths });
const sshManager = new SSHManager();

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
  // 初始化认证 Token
  const adminToken = initToken();

  // 初始化审计日志
  const audit = new AuditLogger({ dataDir: DATA_DIR, paths: dataPaths });

  await keyManager.init();

  // 已审批节点配置
  const approvedNodes = keyManager.getApprovedNodesConfig();

  const monitor = new GnbMonitor(approvedNodes, {
    intervalMs: parseInt(process.env.POLL_INTERVAL_MS || '10000', 10),
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
  });

  const clawRPC = new ClawRPC(sshManager);

  // 审批回调：更新监控
  keyManager.onApproval = (updatedNodes) => {
    monitor.nodesConfig = updatedNodes;
    aiOps.nodesConfig = updatedNodes;
    if (!monitor._timer && updatedNodes.length > 0) monitor.start();
    console.log(`[Approval] 监控已更新: ${updatedNodes.length} 个节点`);
  };

  // 就绪回调：节点完成 synon + 公钥部署后，自动 SSH 安装 OpenClaw
  keyManager.onNodeReady = (nodeConfig) => {
    console.log(`[Ready] 节点 ${nodeConfig.id} 已就绪，启动 OpenClaw 远程安装`);
    provisioner.provision(nodeConfig, { installGnb: false, installClaw: true });
  };

  // --- 敏感端点速率限制 ---
  const strictLimit = createRateLimit({ windowMs: 60000, max: 20, message: '敏感操作请求过于频繁' });

  // --- API 路由 ---

  // 需认证 + 审计的管理路由
  app.use('/api/nodes', requireAuth, audit.middleware('nodes'), createNodesRouter(monitor, sshManager, monitor.nodesConfig, keyManager));
  app.use('/api/ai', requireAuth, strictLimit, audit.middleware('ai_ops'), createAiRouter(aiOps, saveOpsLog));

  // 初始化脚本下载（公开，必须在 enroll 路由之前注册）
  app.get('/api/enroll/init.sh', (req, res) => {
    const scriptPath = path.resolve(__dirname, '../scripts/init-node.sh');
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

  // 健康检查
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      nodesTotal: keyManager.getAllNodes().length,
      nodesApproved: keyManager.getApprovedNodesConfig().length,
      nodesPending: keyManager.getPendingNodes().length,
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
      };
    });
  }

  const wss = new WebSocketServer({ server, path: '/ws' });
  const MAX_WS_CLIENTS = 10;

  wss.on('connection', (ws, req) => {
    // WebSocket 认证：从 URL 参数提取 token
    const url = new URL(req.url, 'http://localhost');
    const wsToken = url.searchParams.get('token');
    if (adminToken && wsToken !== adminToken) {
      audit.log('ws_auth_fail', { reason: 'invalid_token' }, req);
      ws.close(4001, '认证失败');
      return;
    }

    // 连接数限制
    if (wss.clients.size > MAX_WS_CLIENTS) {
      ws.close(4002, '连接数超限');
      return;
    }

    console.log('[WS] 客户端连接');
    audit.log('ws_connect', {}, req);

    ws.send(JSON.stringify({
      type: 'snapshot',
      data: enrichNodesData(monitor.getAllStatus()),
      pending: keyManager.getPendingNodes(),
      groups: keyManager.getGroups(),
      allNodes: keyManager.getAllNodes(),
      timestamp: new Date().toISOString(),
    }));
    // 发送历史日志（按终端分组）
    const allLogs = loadAllOpsLogs();
    if (Object.keys(allLogs).length > 0) {
      ws.send(JSON.stringify({ type: 'chat_history', logs: allLogs }));
    }
    ws.on('close', () => console.log('[WS] 客户端断开'));
  });

  // 监控更新 + 待审批推送
  monitor.on('update', (allStatus) => {
    const payload = JSON.stringify({
      type: 'update',
      data: enrichNodesData(allStatus),
      pending: keyManager.getPendingNodes(),
      groups: keyManager.getGroups(),
      allNodes: keyManager.getAllNodes(),
      timestamp: new Date().toISOString(),
    });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
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
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║   GNB Console — Management Platform  ║`);
    console.log(`  ╠══════════════════════════════════════╣`);
    console.log(`  ║  HTTP:  http://localhost:${PORT}        ║`);
    console.log(`  ║  WS:    ws://localhost:${PORT}/ws       ║`);
    console.log(`  ║  Auth:  Bearer Token ✓                ║`);
    console.log(`  ║  Nodes: ${approvedNodes.length} approved / ${keyManager.getPendingNodes().length} pending   ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
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
