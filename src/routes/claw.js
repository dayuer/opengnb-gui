'use strict';

const express = require('express');

/**
 * OpenClaw RPC 代理路由
 *
 * 前端通过这些 API 间接访问终端节点上的 OpenClaw Gateway。
 *
 * GET  /api/claw/:nodeId/status  — Gateway 状态
 * GET  /api/claw/:nodeId/models  — 模型列表
 * GET  /api/claw/:nodeId/config  — 读取配置
 * POST /api/claw/:nodeId/config  — 修改配置 (body: { patch, baseHash })
 * GET  /api/claw/:nodeId/sessions — 会话列表
 * GET  /api/claw/:nodeId/channels — 渠道状态
 */
module.exports = function createClawRouter({ clawRPC, getNodesConfig }) {
  const router = express.Router();

  // 中间件：解析 nodeId → nodeConfig
  router.use('/:nodeId', (req, res, next) => {
    const nodes = getNodesConfig();
    const nodeConfig = nodes.find(n => n.id === req.params.nodeId);
    if (!nodeConfig) return res.status(404).json({ error: `节点 ${req.params.nodeId} 不存在` });
    if (!nodeConfig.clawToken) return res.status(400).json({ error: `节点 ${req.params.nodeId} 未配置 OpenClaw Token` });
    req.nodeConfig = nodeConfig;
    next();
  });

  // GET /api/claw/:nodeId/status
  router.get('/:nodeId/status', async (req, res) => {
    try {
      const result = await clawRPC.getStatus(req.nodeConfig);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/claw/:nodeId/models
  router.get('/:nodeId/models', async (req, res) => {
    try {
      const result = await clawRPC.getModels(req.nodeConfig);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/claw/:nodeId/config
  router.get('/:nodeId/config', async (req, res) => {
    try {
      const result = await clawRPC.getConfig(req.nodeConfig);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/claw/:nodeId/config  { patch: "...", baseHash: "..." }
  router.post('/:nodeId/config', async (req, res) => {
    try {
      const { patch, baseHash } = req.body;
      if (!patch) return res.status(400).json({ error: '缺少 patch 参数' });
      const result = await clawRPC.patchConfig(req.nodeConfig, patch, baseHash);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/claw/:nodeId/sessions
  router.get('/:nodeId/sessions', async (req, res) => {
    try {
      const result = await clawRPC.getSessions(req.nodeConfig);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/claw/:nodeId/channels
  router.get('/:nodeId/channels', async (req, res) => {
    try {
      const result = await clawRPC.getChannels(req.nodeConfig);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
