'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');

const KeyManager = require('./services/key-manager');
const SSHManager = require('./services/ssh-manager');
const GnbMonitor = require('./services/gnb-monitor');
const AiOps = require('./services/ai-ops');
const Provisioner = require('./services/provisioner');
const MirrorUpdater = require('./services/mirror-updater');
const AuditLogger = require('./services/audit-logger');
const MetricsStore = require('./services/metrics-store');
const SkillsStore = require('./services/skills-store');
const createNodesRouter = require('./routes/nodes');
const createAiRouter = require('./routes/ai');
const createEnrollRouter = require('./routes/enroll');
const createMirrorRouter = require('./routes/mirror');
const createClawRouter = require('./routes/claw');
const createAuthRouter = require('./routes/auth');
const createJobsRouter = require('./routes/jobs');
const createSkillsRouter = require('./routes/skills');
const ClawRPC = require('./services/claw-rpc');
const { requireAuth, requireAdmin, initToken, getAdminToken, setJwtSecret, setStore, hashPassword, verifyJwt } = require('./middleware/auth');
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
app.use((req: any, res: any, next: any) => {
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
    const tempPwd = 'admin123';
    const id = crypto.randomBytes(8).toString('hex');
    const apiToken = crypto.randomBytes(16).toString('hex'); // 128-bit 安全 apiToken
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

  // --- WebSocket 初始化（委托 ws-handler 模块） ---
  const wsHandlers = createWsHandlers({
    server, keyManager, monitor, aiOps, sshManager, audit, opsLog,
    adminToken, verifyJwt, store,
  });

  // 审批回调：更新监控
  keyManager.onApproval = (updatedNodes: any) => {
    monitor.nodesConfig = updatedNodes;
    aiOps.nodesConfig = updatedNodes;
    if (!monitor._staleTimer && updatedNodes.length > 0) monitor.start();
    console.log(`[Approval] 监控已更新: ${updatedNodes.length} 个节点`);
  };

  // @alpha: 节点列表变更回调 — 广播用户专属 WS snapshot
  keyManager.onChange = (action: any, nodeId: any) => {
    wsHandlers.broadcastSnapshot(action, nodeId);
  };

  // 就绪回调：节点完成 synon + 公钥部署后，自动 SSH 安装 OpenClaw
  keyManager.onNodeReady = (nodeConfig: any) => {
    console.log(`[Ready] 节点 ${nodeConfig.id} 已就绪，启动 OpenClaw 远程安装`);
    provisioner.provision(nodeConfig, { installGnb: false, installClaw: true });
  };

  // @alpha: 编辑回调：同步运行时配置
  keyManager.onNodeUpdate = (nodeId: any, changedFields: any) => {
    const updated = keyManager.getApprovedNodesConfig();
    monitor.nodesConfig = updated;
    aiOps.nodesConfig = updated;
    if (changedFields.some((f: any) => ['tunAddr', 'sshPort', 'sshUser'].includes(f))) {
      sshManager.disconnect(nodeId);
    }
    console.log(`[NodeUpdate] 节点 ${nodeId} 已更新 [${changedFields.join(', ')}]`);
  };

  // --- 敏感端点速率限制 ---
  const strictLimit = createRateLimit({ windowMs: 60000, max: 20, message: '敏感操作请求过于频繁' });

  // --- API 路由 ---

  // V3 推模式：节点 agent 上报（统一认证 — ADMIN_TOKEN / apiToken / JWT）
  app.post('/api/monitor/report', express.json({ limit: '64kb' }), (req: any, res: any) => {
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
      let node = allNodes.find((n: any) => n.id === nodeId && n.status === 'approved');
      if (!node) {
        node = allNodes.find((n: any) => n.name === nodeId && n.status === 'approved');
      }
      if (node) {
        // 处理 agent 上报的任务执行结果
        if (Array.isArray(req.body.taskResults) && req.body.taskResults.length > 0) {
          monitor.processTaskResults(node.id, req.body.taskResults);
        }

        monitor.ingest(node.id, req.body);

        // Piggyback: 在响应中下发待执行任务
        const tasks = monitor.getPendingTasks(node.id);
        return res.json({ success: true, nodeId: node.id, tasks });
      }
    }

    return res.status(403).json({ error: '无效 token 或节点未找到' });
  });

  // 认证路由（login 公开，其余需认证）
  const loginLimit = createRateLimit({ windowMs: 60000, max: 5, message: '登录尝试过于频繁，请 1 分钟后重试' });
  app.post('/api/auth/login', loginLimit);
  app.use('/api/auth', express.json(), createAuthRouter(store));

  // 需认证 + 审计的管理路由
  app.use('/api/nodes', requireAuth, audit.middleware('nodes'), createNodesRouter(monitor, sshManager, monitor.nodesConfig, keyManager, metricsStore));
  app.use('/api/ai', requireAuth, strictLimit, audit.middleware('ai_ops'), createAiRouter(aiOps, opsLog.saveOpsLog));

  // @alpha: 异步 Job 路由
  app.use('/api/jobs', createJobsRouter({
    jobManager,
    sshManager,
    keyManager: { getNodeById: (id: any) => store.findById(id) },
    requireAuth,
    broadcastWS: (msg: any) => { wsHandlers.broadcast(msg); },
  }));

  // 初始化脚本下载（公开）
  app.get('/api/enroll/init.sh', (req: any, res: any) => {
    const scriptPath = path.resolve(__dirname, '../scripts/initnode.sh');
    res.type('text/plain').sendFile(scriptPath);
  });
  app.get('/api/enroll/node-agent.sh', (req: any, res: any) => {
    const scriptPath = path.resolve(__dirname, '../scripts/node-agent.sh');
    res.type('text/plain').sendFile(scriptPath);
  });
  app.get('/api/enroll/setup.sh', (req: any, res: any) => {
    const scriptPath = path.resolve(__dirname, '../scripts/setup-console.sh');
    res.type('text/plain').sendFile(scriptPath);
  });

  // enroll 路由
  app.use('/api/enroll', createEnrollRouter(keyManager, { requireAuth, audit }));

  // 镜像下载 — 公开
  app.use('/api/mirror', createMirrorRouter(DATA_DIR));

  // 技能注册表 — 需认证
  const skillsStore = new SkillsStore(path.join(DATA_DIR, 'skills.db'));
  skillsStore.init();
  app.use('/api/skills', requireAuth, createSkillsRouter(skillsStore));

  // OpenClaw 管理 — 需认证
  app.use('/api/claw', requireAuth, audit.middleware('claw'), createClawRouter({
    clawRPC,
    getNodesConfig: () => keyManager.getApprovedNodesConfig(),
  }));

  // 配置下发 API — 需认证
  app.post('/api/provision/:id', requireAuth, strictLimit, audit.middleware('provision'), async (req: any, res: any) => {
    const nodeConfig = keyManager.getApprovedNodesConfig().find((n: any) => n.id === req.params.id);
    if (!nodeConfig) return res.status(404).json({ error: '节点未审批或不存在' });

    res.json({ status: 'started', message: `开始配置下发: ${nodeConfig.name}` });
    provisioner.provision(nodeConfig, req.body || {});
  });

  app.get('/api/provision/:id/status', requireAuth, (req: any, res: any) => {
    const task = provisioner.getTaskStatus(req.params.id);
    if (!task) return res.status(404).json({ error: '无配置下发任务' });
    res.json(task);
  });

  // 健康检查
  app.get('/api/health', (req: any, res: any) => {
    const allNodes = keyManager.getAllNodes();
    const approved = allNodes.filter((n: any) => n.status === 'approved');
    const pending = allNodes.filter((n: any) => n.status === 'pending');
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      nodesTotal: allNodes.length,
      nodesApproved: approved.length,
      nodesPending: pending.length,
    });
  });

  // SPA fallback
  app.get('*', (req: any, res: any) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(staticDir, 'index.html'));
    }
  });

  // --- 统一错误处理（必须在所有路由之后） ---
  app.use(errorHandler);

  // --- 事件处理 ---

  // 监控更新推送
  monitor.on('update', (allStatus: any) => {
    wsHandlers.broadcastMonitorUpdate(allStatus);
  });

  // 配置下发日志推送 + 持久化
  provisioner.on('log', ({ nodeId, message }: any) => {
    opsLog.saveOpsLog(nodeId, 'assistant', message);
    wsHandlers.broadcast({ type: 'provision_log', nodeId, message });
  });

  // @alpha: Agent 上报 OpenClaw token → 自动写入节点配置
  monitor.on('clawDiscovered', ({ nodeId, token, port }: any) => {
    if (token) {
      keyManager.updateNodeClawConfig(nodeId, { token, port });
      const updated = keyManager.getApprovedNodesConfig();
      monitor.nodesConfig = updated;
      aiOps.nodesConfig = updated;
      console.log(`[ClawDiscovered] 节点 ${nodeId} 从 Agent 上报自动写入 Token (port=${port})`);
    }
  });

  // OpenClaw token 就绪 → 保存到节点配置
  provisioner.on('claw_ready', ({ nodeId, token, port }: any) => {
    if (token) {
      keyManager.updateNodeClawConfig(nodeId, { token, port });
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
    mirrorUpdater.start();
  });

  const shutdown = () => {
    console.log('\n[Server] 正在关闭...');
    monitor.stop();
    mirrorUpdater.stop();
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
export {}; // CJS 模块标记
