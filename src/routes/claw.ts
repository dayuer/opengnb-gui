'use strict';
import type { Request, Response, NextFunction } from 'express';

const express = require('express');
const crypto = require('crypto');

/**
 * OpenClaw RPC 代理路由
 *
 * 前端通过这些 API 间接访问终端节点上的 OpenClaw Gateway。
 *
 * GET  /api/claw/:nodeId/status   — Gateway 状态
 * GET  /api/claw/:nodeId/models   — 模型列表
 * GET  /api/claw/:nodeId/config   — 读取配置
 * POST /api/claw/:nodeId/config   — 修改配置 (body: { patch, baseHash })
 * GET  /api/claw/:nodeId/sessions — 会话列表
 * GET  /api/claw/:nodeId/channels — 渠道状态
 * POST /api/claw/:nodeId/restart  — 重启 OpenClaw（Agent 任务队列）
 * POST /api/claw/:nodeId/update   — 更新 OpenClaw（Agent 任务队列）
 */
module.exports = function createClawRouter({ clawRPC, getNodesConfig, taskQueue }: any) {
  const router = express.Router();

  // 中间件：解析 nodeId → nodeConfig（restart/update 不需要 clawToken，单独处理）
  router.use('/:nodeId', (req: Request, res: Response, next: NextFunction) => {
    const nodes = getNodesConfig();
    const nodeConfig = nodes.find((n: any) => n.id === req.params.nodeId);
    if (!nodeConfig) return res.status(404).json({ error: `节点 ${req.params.nodeId} 不存在` });
    req.nodeConfig = nodeConfig;
    next();
  });

  // ──── 无需 clawToken 的操作 ─────────────────────────

  // POST /api/claw/:nodeId/restart — 重启 OpenClaw
  router.post('/:nodeId/restart', (req: Request, res: Response) => {
    if (!taskQueue) return res.status(503).json({ error: '任务队列不可用' });
    const task = {
      taskId: crypto.randomUUID(),
      type: 'claw_restart',
      command: '',  // 语义化类型，无需 shell 命令（daemon 原生处理）
      skillId: 'openclaw',
      skillName: 'OpenClaw',
      timeoutMs: 30000,
    };
    taskQueue.enqueueTask(req.params.nodeId, task);
    res.json({ taskId: task.taskId, status: 'queued', message: '重启任务已入队' });
  });

  // POST /api/claw/:nodeId/update — 更新 OpenClaw
  router.post('/:nodeId/update', (req: Request, res: Response) => {
    if (!taskQueue) return res.status(503).json({ error: '任务队列不可用' });
    const task = {
      taskId: crypto.randomUUID(),
      type: 'claw_upgrade',
      command: '',  // 语义化类型，由 daemon claw_manager::upgrade() 原生执行
      skillId: 'openclaw',
      skillName: 'OpenClaw Update',
      timeoutMs: 180000,
    };
    taskQueue.enqueueTask(req.params.nodeId, task);
    res.json({ taskId: task.taskId, status: 'queued', message: '更新任务已入队' });
  });

  // ──── 需要 clawToken 的 RPC 操作 ───────────────────

  // 子中间件：续验 clawToken
  const requireClawToken = (req: Request, res: Response, next: NextFunction) => {
    if (!(req.nodeConfig as any)?.clawToken) {
      return res.status(400).json({ error: `节点 ${req.params.nodeId} 未配置 OpenClaw Token` });
    }
    next();
  };

  // GET /api/claw/:nodeId/status
  router.get('/:nodeId/status', requireClawToken, async (req: Request, res: Response) => {
    try {
      const result = await clawRPC.getStatus(req.nodeConfig);
      res.json(result);
    } catch (err: unknown) {
      const msg = process.env.NODE_ENV === 'production' ? '操作失败' : (err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/claw/:nodeId/models
  router.get('/:nodeId/models', requireClawToken, async (req: Request, res: Response) => {
    try {
      const result = await clawRPC.getModels(req.nodeConfig);
      res.json(result);
    } catch (err: unknown) {
      const msg = process.env.NODE_ENV === 'production' ? '操作失败' : (err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/claw/:nodeId/config
  router.get('/:nodeId/config', requireClawToken, async (req: Request, res: Response) => {
    try {
      const result = await clawRPC.getConfig(req.nodeConfig);
      res.json(result);
    } catch (err: unknown) {
      const msg = process.env.NODE_ENV === 'production' ? '操作失败' : (err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: msg });
    }
  });

  // POST /api/claw/:nodeId/config  { patch: "...", baseHash: "..." }
  router.post('/:nodeId/config', requireClawToken, async (req: Request, res: Response) => {
    try {
      const { patch, baseHash } = req.body;
      if (!patch) return res.status(400).json({ error: '缺少 patch 参数' });
      const result = await clawRPC.patchConfig(req.nodeConfig, patch, baseHash);
      res.json(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('E_CONFLICT')) {
        return res.status(409).json({ error: '配置已被修改，请刷新合并最新配置后再保存', type: 'E_CONFLICT' });
      }
      res.status(500).json({ error: process.env.NODE_ENV === 'production' ? '操作失败' : msg });
    }
  });

  // GET /api/claw/:nodeId/sessions
  router.get('/:nodeId/sessions', requireClawToken, async (req: Request, res: Response) => {
    try {
      const result = await clawRPC.getSessions(req.nodeConfig);
      res.json(result);
    } catch (err: unknown) {
      const msg = process.env.NODE_ENV === 'production' ? '操作失败' : (err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/claw/:nodeId/channels
  router.get('/:nodeId/channels', requireClawToken, async (req: Request, res: Response) => {
    try {
      const result = await clawRPC.getChannels(req.nodeConfig);
      res.json(result);
    } catch (err: unknown) {
      const msg = process.env.NODE_ENV === 'production' ? '操作失败' : (err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: msg });
    }
  });

  return router;
};
export {}; // CJS 模块标记
