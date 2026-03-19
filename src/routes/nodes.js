'use strict';

const express = require('express');

/**
 * 节点管理 API 路由（含分组 + 指标子路由）
 * @param {import('../services/gnb-monitor')} monitor
 * @param {import('../services/ssh-manager')} sshManager
 * @param {Array} nodesConfig
 * @param {import('../services/key-manager')} [keyManager]
 * @param {import('../services/metrics-store')} [metricsStore]
 */
function createNodesRouter(monitor, sshManager, nodesConfig, keyManager, metricsStore) {
  const router = express.Router();

  // ═══════════════════════════════════════
  // @alpha: 指标时序 API — /api/nodes/metrics
  // ═══════════════════════════════════════
  if (metricsStore) {
    // GET /api/nodes/metrics/summary — 全局汇总
    router.get('/metrics/summary', (req, res) => {
      res.json(metricsStore.summary());
    });

    // GET /api/nodes/metrics?nodeId=xxx&range=1h
    router.get('/metrics', (req, res) => {
      const { nodeId, range } = req.query;
      if (!nodeId) {
        return res.status(400).json({ error: '缺少 nodeId 参数' });
      }
      const data = metricsStore.query(nodeId, range || '1h');
      res.json({ nodeId, range: range || '1h', points: data, alerts: metricsStore.getAlerts().filter(a => a.nodeId === nodeId) });
    });
  }  // ═══════════════════════════════════════
  // 分组管理子路由 — /api/nodes/groups
  // 必须放在 /:id 之前，避免 "groups" 被当作 nodeId
  // ═══════════════════════════════════════
  if (keyManager) {
    router.get('/groups', (req, res) => {
      res.json({ groups: keyManager.getGroups() });
    });

    router.post('/groups', (req, res) => {
      const { name, color } = req.body;
      try {
        const group = keyManager.createGroup({ name, color });
        res.status(201).json(group);
      } catch (err) {
        const status = err.message.includes('已存在') ? 409 : 400;
        res.status(status).json({ error: err.message });
      }
    });

    router.put('/groups/:id', (req, res) => {
      const result = keyManager.updateGroup(req.params.id, req.body);
      res.status(result.success ? 200 : 404).json(result);
    });

    router.delete('/groups/:id', (req, res) => {
      const result = keyManager.deleteGroup(req.params.id);
      res.status(result.success ? 200 : 404).json(result);
    });
  }

  // GET /api/nodes — 全部节点状态
  router.get('/', (req, res) => {
    res.json({
      timestamp: new Date().toISOString(),
      nodes: monitor.getAllStatus(),
    });
  });

  // GET /api/nodes/:id — 单节点详情
  router.get('/:id', (req, res) => {
    const status = monitor.getNodeStatus(req.params.id);
    if (!status) {
      return res.status(404).json({ error: `节点 ${req.params.id} 未找到` });
    }
    res.json(status);
  });

  // @alpha: PUT /api/nodes/:id — 编辑节点信息 + 远程 GNB 同步
  if (keyManager) {
    router.put('/:id', async (req, res) => {
      const { name, tunAddr, sshPort, sshUser } = req.body;
      let remoteSync = null;

      // 时序关键: 在 updateNode 之前通过旧 SSH 连接远程同步
      // updateNode 会同步触发 onNodeUpdate → disconnect()，清除 SSH 池
      if (tunAddr) {
        const oldNode = keyManager.getApprovedNodesConfig().find(n => n.id === req.params.id);
        if (oldNode && oldNode.gnbNodeId && oldNode.tunAddr && oldNode.tunAddr !== String(tunAddr).trim()) {
          try {
            const netmask = oldNode.netmask || '255.255.255.0';
            const newIp = String(tunAddr).trim();
            const sedCmd = `sudo sed -i 's/^${oldNode.gnbNodeId}|.*/${oldNode.gnbNodeId}|${newIp}|${netmask}/' /opt/gnb/conf/${oldNode.gnbNodeId}/address.conf`;
            const { code, stderr } = await sshManager.exec(oldNode, `${sedCmd} && sync && nohup bash -c 'sleep 1 && sudo systemctl restart gnb' >/dev/null 2>&1 &`, 15000);
            remoteSync = code === 0 ? 'ok' : `exit ${code}: ${stderr}`;
            console.log(`[RemoteSync] ${req.params.id}: ${oldNode.tunAddr} → ${newIp} (${remoteSync})`);
          } catch (err) {
            remoteSync = `failed: ${err.message}`;
            console.error(`[RemoteSync] 失败: ${err.message}`);
          }
        }
      }

      // 本地持久化（触发 onNodeUpdate → disconnect + 刷新 monitor/aiOps）
      const result = keyManager.updateNode(req.params.id, { name, tunAddr, sshPort, sshUser });
      if (!result.success) {
        const status = result.message.includes('不存在') ? 404
          : result.code === 'CONFLICT' ? 409 : 400;
        return res.status(status).json({ error: result.message });
      }
      if (remoteSync) result.remoteSync = remoteSync;

      res.json(result);
    });
  }

  // POST /api/nodes/:id/exec — 执行远程命令（仅允许安全命令）

  // 精确命令白名单
  const SAFE_COMMANDS = {
    'gnb_ctl':     /^gnb_ctl(\s+[\w-]+)*$/,
    'ping':        /^ping(\s+-c\s+\d{1,3})?\s+[\w.:/-]+$/,
    'traceroute':  /^traceroute\s+[\w.:/-]+$/,
    'ip addr':     /^ip\s+addr(\s+show(\s+[\w]+)?)?$/,
    'ip route':    /^ip\s+route(\s+show)?$/,
    'uname':       /^uname(\s+-[a-z]+)?$/i,
    'uptime':      /^uptime$/,
    'free':        /^free(\s+-[a-z]+)?$/i,
    'df':          /^df(\s+-[a-z]+)?(\s+\/[\w/]*)?$/i,
  };

  const SHELL_META = /[;|&`$(){}!><\n\r\\\\'\"]/;

  router.post('/:id/exec', async (req, res) => {
    const { command } = req.body;
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: '缺少 command 参数' });
    }

    const cmd = command.trim();

    if (SHELL_META.test(cmd)) {
      return res.status(403).json({ error: '命令包含禁止的特殊字符' });
    }

    const matched = Object.entries(SAFE_COMMANDS).some(([, regex]) => regex.test(cmd));
    if (!matched) {
      return res.status(403).json({
        error: '命令未在安全白名单中，或参数格式不合法。请使用 AI 运维接口执行需审批的操作。',
        allowed: Object.keys(SAFE_COMMANDS),
      });
    }

    const nodeConfig = nodesConfig.find(n => n.id === req.params.id);
    if (!nodeConfig) {
      return res.status(404).json({ error: `节点 ${req.params.id} 未配置` });
    }

    try {
      const result = await sshManager.exec(nodeConfig, cmd);
      res.json(result);
    } catch (err) {
      const msg = process.env.NODE_ENV === 'production' ? '命令执行失败' : err.message;
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

module.exports = createNodesRouter;
