'use strict';

const express = require('express');

/**
 * 节点管理 API 路由
 * @param {import('../services/gnb-monitor')} monitor
 * @param {import('../services/ssh-manager')} sshManager
 * @param {Array} nodesConfig
 */
function createNodesRouter(monitor, sshManager, nodesConfig) {
  const router = express.Router();

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

  // POST /api/nodes/:id/exec — 执行远程命令（仅允许安全命令）
  router.post('/:id/exec', async (req, res) => {
    const { command } = req.body;
    if (!command) {
      return res.status(400).json({ error: '缺少 command 参数' });
    }

    // 安全白名单 — 仅允许只读诊断命令
    const safeCommands = ['gnb_ctl', 'ping', 'traceroute', 'ip addr', 'ip route', 'cat', 'ls', 'uname', 'uptime', 'free', 'df'];
    const isSafe = safeCommands.some(sc => command.trim().startsWith(sc));

    if (!isSafe) {
      return res.status(403).json({
        error: '命令未在安全白名单中。请使用 AI 运维接口执行需审批的操作。',
        allowed: safeCommands,
      });
    }

    const nodeConfig = nodesConfig.find(n => n.id === req.params.id);
    if (!nodeConfig) {
      return res.status(404).json({ error: `节点 ${req.params.id} 未配置` });
    }

    try {
      const result = await sshManager.exec(nodeConfig, command);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createNodesRouter;
