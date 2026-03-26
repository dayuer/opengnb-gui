'use strict';

import type { Request, Response, NextFunction } from 'express';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');

const KeyManager = require('./services/key-manager');
const SSHManager = require('./services/ssh-manager');
const GnbMonitor = require('./services/gnb-monitor');
const TaskQueue = require('./services/task-queue');
const AiOps = require('./services/ai-ops');
const Provisioner = require('./services/provisioner');
const MirrorUpdater = require('./services/mirror-updater');
const AuditLogger = require('./services/audit-logger');
const MetricsStore = require('./services/metrics-store');
const SkillsStore = require('./services/skills-store');
const JobManager = require('./services/job-manager');
const ClawRPC = require('./services/claw-rpc');
const createNodesRouter = require('./routes/nodes');
const createAiRouter = require('./routes/ai');
const createEnrollRouter = require('./routes/enroll');
const createMirrorRouter = require('./routes/mirror');
const createClawRouter = require('./routes/claw');
const createAuthRouter = require('./routes/auth');
const createJobsRouter = require('./routes/jobs');
const createSkillsRouter = require('./routes/skills');
const createClawHubRouter = require('./routes/clawhub');
const { createPlaybookRoutes } = require('./routes/playbooks');
const { PlaybookEngine } = require('./services/playbook-engine');
const { requireAuth, requireAdmin, requireRole, initToken, getAdminToken, setJwtSecret, setStore, hashPassword, verifyJwt, resolveToken } = require('./middleware/auth');
const { createRateLimit } = require('./middleware/rate-limit');
const { errorHandler } = require('./middleware/error-handler');
const { resolvePaths, ensureDataDirs } = require('./services/data-paths');
const { createOpsLog } = require('./services/ops-log');
const { createWsHandlers } = require('./services/ws-handler');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../data');

// @alpha: 集中路径管理 + 自动创建目录
const dataPaths = resolvePaths(DATA_DIR);
ensureDataDirs(dataPaths);

const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '1mb' }));
// @beta: 优先服务 Vite 构建产物 dist/，回退 public/（兼容未构建场景）
const distDir = path.resolve(__dirname, '../dist');
const publicDir = path.resolve(__dirname, '../public');
const staticDir = fs.existsSync(distDir) ? distDir : publicDir;
app.use(express.static(staticDir));

// --- 安全响应头（安全审计 L5 修复） ---
app.use((req: Request, res: Response, next: NextFunction) => {
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

// --- 运维日志持久化 ---
const opsLog = createOpsLog(dataPaths.logs.opsDir);

// ═══════════════════════════════════════
// boot() 子函数 — 从 God Function 提炼
// ═══════════════════════════════════════

/**
 * 初始化数据库、认证、首次启动用户
 */
async function initDatabase() {
  const adminToken = initToken();
  await keyManager.init();

  // JWT secret — 用 Console 私钥的哈希
  const jwtSecret = crypto
    .createHash('sha256')
    .update(keyManager.getPrivateKey())
    .digest('hex');
  setJwtSecret(jwtSecret);

  const store = keyManager.store;
  setStore(store);

  // 首次启动自动创建 admin 用户
  if (store.userCount() === 0) {
    const tempPwd = 'admin123';
    const id = crypto.randomBytes(8).toString('hex');
    const apiToken = crypto.randomBytes(16).toString('hex');
    store.insertUser({ id, username: 'admin', passwordHash: hashPassword(tempPwd) });
    store._stmts.updateApiToken.run(apiToken, id);
    const credFile = path.join(DATA_DIR, '.initial-credentials');
    const credContent = `admin:${tempPwd}\napiToken:${apiToken}\ncreated:${new Date().toISOString()}`;
    fs.writeFileSync(credFile, credContent, { mode: 0o600 });
    console.log(`\n  👤 首次启动，已创建管理员账号。`);
    console.log(`     凭据已写入: ${credFile}`);
    console.log(`     ⚠️  请登录后及时修改密码\n`);
  }

  return { adminToken, store };
}

/**
 * 初始化所有服务实例
 */
function initServices(store: any) {
  const audit = new AuditLogger({ store });
  const approvedNodes = keyManager.getApprovedNodesConfig();

  // Sweeper — 挂载到 MetricsStore 维护周期
  const Sweeper = require('./services/sweeper');
  const sweeper = new Sweeper({ store });
  const metricsStore = new MetricsStore({ store, sweeper });

  const jobManager = new JobManager({ store, timeoutMs: 60000 });

  const monitor = new GnbMonitor(approvedNodes, {
    staleTimeoutMs: parseInt(process.env.STALE_TIMEOUT_MS || '60000', 10),
    metricsStore,
    store,
    audit,
  });

  const taskQueue = new TaskQueue(store, audit);

  const provisioner = new Provisioner({
    sshManager,
    provisionConfig: {
      indexNodes: process.env.GNB_INDEX_NODES || '',
      consoleApiBase: process.env.CONSOLE_API_BASE || `http://10.1.0.1:${PORT}`,
    },
  });

  const mirrorUpdater = new MirrorUpdater(DATA_DIR);

  const aiOps = new AiOps({
    nodesConfig: approvedNodes,
    sshManager,
    getNodeStatus: () => monitor.getAllStatus(),
    provisioner,
    jobManager,
  });

  const clawRPC = new ClawRPC(sshManager);

  const wsHandlers = createWsHandlers({
    server, keyManager, monitor, aiOps, sshManager, audit, opsLog,
  });

  const skillsStore = new SkillsStore(store.db);
  skillsStore.init();

  return { audit, approvedNodes, metricsStore, monitor, taskQueue, provisioner, mirrorUpdater, aiOps, clawRPC, wsHandlers, jobManager, skillsStore };
}

/**
 * 注册所有 API 路由
 */
function initRoutes(deps: any) {
  const { store, audit, monitor, taskQueue, aiOps, wsHandlers, jobManager, metricsStore, clawRPC, provisioner, skillsStore } = deps;

  const strictLimit = createRateLimit({ windowMs: 60000, max: 20, message: '敏感操作请求过于频繁' });

  // V3 推模式：节点 agent 上报
  app.post('/api/monitor/report', express.json({ limit: '64kb' }), (req: Request, res: Response) => {
    const token = String(req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token) return res.status(401).json({ error: '缺少认证' });

    const authResult = resolveToken(token);
    const isAdmin = authResult.valid;

    const nodeId = req.query.nodeId || req.body.nodeId;
    if (isAdmin && nodeId) {
      const allNodes = keyManager.getAllNodes();
      let node = allNodes.find((n: any) => n.id === nodeId && n.status === 'approved');
      if (!node) {
        node = allNodes.find((n: any) => n.name === nodeId && n.status === 'approved');
      }
      if (node) {
        if (Array.isArray(req.body.taskResults) && req.body.taskResults.length > 0) {
          taskQueue.processTaskResults(node.id, req.body.taskResults);
        }
        monitor.ingest(node.id, req.body);
        const tasks = taskQueue.getPendingTasks(node.id);
        return res.json({ success: true, nodeId: node.id, tasks });
      }
    }
    return res.status(403).json({ error: '无效 token 或节点未找到' });
  });

  // 认证路由
  const loginLimit = createRateLimit({ windowMs: 60000, max: 5, message: '登录尝试过于频繁，请 1 分钟后重试' });
  app.post('/api/auth/login', loginLimit);
  app.use('/api/auth', express.json(), createAuthRouter(store));

  // 管理路由（RBAC 权限控制）
  app.use('/api/nodes', requireAuth, audit.middleware('nodes'), createNodesRouter(monitor, sshManager, keyManager, metricsStore, taskQueue));
  app.use('/api/ai', requireAuth, requireRole('admin', 'operator'), strictLimit, audit.middleware('ai_ops'), createAiRouter(aiOps, opsLog.saveOpsLog));
  app.use('/api/jobs', createJobsRouter({ jobManager, sshManager, keyManager: { getNodeById: (id: any) => store.findById(id) }, requireAuth, broadcastWS: (msg: any) => { wsHandlers.broadcast(msg); } }));

  // 公开脚本下载
  app.get('/api/enroll/init.sh', (req: Request, res: Response) => {
    res.type('text/plain').sendFile(path.resolve(__dirname, '../scripts/initnode.sh'));
  });
  app.get('/api/enroll/node-agent.sh', (req: Request, res: Response) => {
    res.type('text/plain').sendFile(path.resolve(__dirname, '../scripts/node-agent.sh'));
  });
  app.get('/api/enroll/setup.sh', (req: Request, res: Response) => {
    res.type('text/plain').sendFile(path.resolve(__dirname, '../scripts/setup-console.sh'));
  });

  app.use('/api/enroll', createEnrollRouter(keyManager, { requireAuth, audit }));
  app.use('/api/mirror', createMirrorRouter(DATA_DIR));
  app.use('/api/skills', requireAuth, createSkillsRouter(skillsStore));
  app.use('/api/clawhub', requireAuth, createClawHubRouter());

  // Playbook 编排路由
  const playbookEngine = new PlaybookEngine(store, taskQueue);
  app.use('/api/playbooks', requireAuth, createPlaybookRoutes(playbookEngine));
  app.use('/api/claw', requireAuth, requireRole('admin', 'operator'), audit.middleware('claw'), createClawRouter({ clawRPC, getNodesConfig: () => keyManager.getApprovedNodesConfig() }));

  // Provision 路由 — 仅管理员
  app.post('/api/provision/:id', requireAuth, requireRole('admin'), strictLimit, audit.middleware('provision'), async (req: Request, res: Response) => {
    const nodeConfig = keyManager.getApprovedNodesConfig().find((n: any) => n.id === req.params.id);
    if (!nodeConfig) return res.status(404).json({ error: '节点未审批或不存在' });
    res.json({ status: 'started', message: `开始配置下发: ${nodeConfig.name}` });
    provisioner.provision(nodeConfig, req.body || {});
  });
  app.get('/api/provision/:id/status', requireAuth, (req: Request, res: Response) => {
    const task = provisioner.getTaskStatus(req.params.id);
    if (!task) return res.status(404).json({ error: '无配置下发任务' });
    res.json(task);
  });

  // 健康检查
  app.get('/api/health', (req: Request, res: Response) => {
    const allNodes = keyManager.getAllNodes();
    const approved = allNodes.filter((n: any) => n.status === 'approved');
    const pending = allNodes.filter((n: any) => n.status === 'pending');
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()), timestamp: new Date().toISOString(), nodesTotal: allNodes.length, nodesApproved: approved.length, nodesPending: pending.length });
  });

  // SPA fallback
  app.get('*', (req: Request, res: Response) => {
    if (!req.path.startsWith('/api')) res.sendFile(path.join(staticDir, 'index.html'));
  });

  app.use(errorHandler);
}

/**
 * 绑定事件处理器
 */
function initEventHandlers(deps: any) {
  const { monitor, taskQueue, provisioner, aiOps, wsHandlers, mirrorUpdater, approvedNodes } = deps;

  // 审批回调
  keyManager.onApproval = (updatedNodes: any) => {
    monitor.nodesConfig = updatedNodes;
    aiOps.nodesConfig = updatedNodes;
    if (!monitor._staleTimer && updatedNodes.length > 0) monitor.start();
    console.log(`[Approval] 监控已更新: ${updatedNodes.length} 个节点`);
  };

  keyManager.onChange = (action: any, nodeId: any) => {
    wsHandlers.broadcastSnapshot(action, nodeId);
  };

  keyManager.onNodeReady = (nodeConfig: any) => {
    console.log(`[Ready] 节点 ${nodeConfig.id} 已就绪，启动 OpenClaw 远程安装`);
    provisioner.provision(nodeConfig, { installGnb: false, installClaw: true });
  };

  keyManager.onNodeUpdate = (nodeId: any, changedFields: any) => {
    const updated = keyManager.getApprovedNodesConfig();
    monitor.nodesConfig = updated;
    aiOps.nodesConfig = updated;
    if (changedFields.some((f: any) => ['tunAddr', 'sshPort', 'sshUser'].includes(f))) {
      sshManager.disconnect(nodeId);
    }
    console.log(`[NodeUpdate] 节点 ${nodeId} 已更新 [${changedFields.join(', ')}]`);
  };

  monitor.on('update', (allStatus: any) => wsHandlers.broadcastMonitorUpdate(allStatus));

  provisioner.on('log', ({ nodeId, message }: any) => {
    opsLog.saveOpsLog(nodeId, 'assistant', message);
    wsHandlers.broadcast({ type: 'provision_log', nodeId, message });
  });

  monitor.on('clawDiscovered', ({ nodeId, token, port }: any) => {
    if (token) {
      keyManager.updateNodeClawConfig(nodeId, { token, port });
      const updated = keyManager.getApprovedNodesConfig();
      monitor.nodesConfig = updated;
      aiOps.nodesConfig = updated;
      console.log(`[ClawDiscovered] 节点 ${nodeId} 从 Agent 上报自动写入 Token (port=${port})`);
    }
  });

  provisioner.on('claw_ready', ({ nodeId, token, port }: any) => {
    if (token) {
      keyManager.updateNodeClawConfig(nodeId, { token, port });
      const updated = keyManager.getApprovedNodesConfig();
      aiOps.nodesConfig = updated;
      console.log(`[ClawReady] 节点 ${nodeId} Token 已保存`);
    }
  });

  return { approvedNodes, monitor, mirrorUpdater };
}

// ═══════════════════════════════════════
// 主启动流程
// ═══════════════════════════════════════

async function boot() {
  const { store } = await initDatabase();
  const services = initServices(store);
  initRoutes({ store, ...services });
  initEventHandlers(services);

  const { approvedNodes, monitor, mirrorUpdater, taskQueue } = services;

  // 孤儿任务自愈 — A) 启动扫描
  const healedCount = taskQueue.healOrphanTasks();
  if (healedCount > 0) console.log(`  🔧 启动时回收 ${healedCount} 个孤儿任务`);

  server.listen(PORT, () => {
    console.log(`\n  ╔═══════════════════════════════════════════╗`);
    console.log(`  ║  SynonClaw Console — Management Platform  ║`);
    console.log(`  ╠═══════════════════════════════════════════╣`);
    console.log(`  ║  HTTP:  http://localhost:${PORT}             ║`);
    console.log(`  ║  WS:    ws://localhost:${PORT}/ws            ║`);
    console.log(`  ║  WSD:   ws://localhost:${PORT}/ws/daemon     ║`);
    console.log(`  ║  Auth:  Bearer Token ✓                     ║`);
    console.log(`  ║  Nodes: ${approvedNodes.length} approved / ${keyManager.getPendingNodes().length} pending        ║`);
    console.log(`  ╚═══════════════════════════════════════════╝\n`);
    console.log(`  节点初始化:`);
    console.log(`  curl -sSL http://<TUN_IP>:${PORT}/api/enroll/init.sh | \\`);
    console.log(`    CONSOLE=<TUN_IP>:${PORT} NODE_ID=<ID> TUN_ADDR=<IP> bash\n`);

    if (approvedNodes.length > 0) monitor.start();
    mirrorUpdater.start();
    // 孤儿任务自愈 — B) 定时扫描
    taskQueue.startOrphanTimer();
  });

  // WebSocket 路径路由：根据 URL 分发到对应 WS 服务器
  server.on('upgrade', (request: any, socket: any, head: any) => {
    const pathname = request.url?.split('?')[0];
    const { wss, wssSsh, wssAi, wssDaemon } = services.wsHandlers;
    if (pathname === '/ws/daemon' && wssDaemon) {
      wssDaemon.handleUpgrade(request, socket, head, (ws: any) => {
        wssDaemon.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/ssh' && wssSsh) {
      wssSsh.handleUpgrade(request, socket, head, (ws: any) => {
        wssSsh.emit('connection', ws, request);
      });
    } else if (pathname === '/ws/ai' && wssAi) {
      wssAi.handleUpgrade(request, socket, head, (ws: any) => {
        wssAi.emit('connection', ws, request);
      });
    } else {
      // 主监控 WS
      wss.handleUpgrade(request, socket, head, (ws: any) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  const shutdown = () => {
    console.log('\n[Server] 正在关闭...');
    monitor.stop();
    taskQueue.stopOrphanTimer();
    mirrorUpdater.stop();
    sshManager.closeAll();
    services.wsHandlers.wss.clients.forEach((ws: any) => ws.terminate());
    if (services.wsHandlers.wssDaemon) {
      services.wsHandlers.wssDaemon.clients.forEach((ws: any) => ws.terminate());
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

boot().catch(err => {
  console.error('[Boot] 启动失败:', err);
  process.exit(1);
});
export {}; // CJS 模块标记
