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

  // 精确命令白名单：每个命令用正则限制允许的参数范围
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

  // 禁止 shell 元字符 — 阻断所有注入向量
  const SHELL_META = /[;|&`$(){}!><\n\r\\'"]/;

  router.post('/:id/exec', async (req, res) => {
    const { command } = req.body;
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: '缺少 command 参数' });
    }

    const cmd = command.trim();

    // 第一道防线：禁止 shell 元字符
    if (SHELL_META.test(cmd)) {
      return res.status(403).json({ error: '命令包含禁止的特殊字符' });
    }

    // 第二道防线：精确正则匹配
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
