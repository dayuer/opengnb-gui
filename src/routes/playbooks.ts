'use strict';

/**
 * Playbook REST API 路由
 *
 * POST   /api/playbooks          — 创建
 * GET    /api/playbooks           — 列表
 * GET    /api/playbooks/:id       — 详情
 * POST   /api/playbooks/:id/start — 启动
 * POST   /api/playbooks/:id/cancel — 取消
 * DELETE /api/playbooks/:id       — 删除
 *
 * 权限: requireRole('admin', 'operator')
 */

const { Router } = require('express');
const { requireRole } = require('../middleware/auth');

function createPlaybookRoutes(engine: any) {
  const router = Router();

  // 创建 Playbook
  router.post('/', requireRole('admin', 'operator'), (req: any, res: any) => {
    const { name, description, steps, targetNodeIds } = req.body;
    if (!name || !steps || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: '缺少 name 或 steps' });
    }
    if (!targetNodeIds || !Array.isArray(targetNodeIds) || targetNodeIds.length === 0) {
      return res.status(400).json({ error: '缺少 targetNodeIds' });
    }
    // 验证每个步骤有 name 和 command
    for (const s of steps) {
      if (!s.name || !s.command) {
        return res.status(400).json({ error: `步骤缺少 name 或 command` });
      }
    }
    try {
      const playbook = engine.create({ name, description, steps, targetNodeIds });
      res.json(playbook);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 列表
  router.get('/', requireRole('admin', 'operator'), (req: any, res: any) => {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    res.json(engine.list(limit, offset));
  });

  // 详情
  router.get('/:id', requireRole('admin', 'operator'), (req: any, res: any) => {
    const detail = engine.getPlaybookDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'Playbook 不存在' });
    res.json(detail);
  });

  // 启动
  router.post('/:id/start', requireRole('admin', 'operator'), (req: any, res: any) => {
    try {
      engine.start(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // 取消
  router.post('/:id/cancel', requireRole('admin', 'operator'), (req: any, res: any) => {
    try {
      engine.cancel(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // 删除
  router.delete('/:id', requireRole('admin'), (req: any, res: any) => {
    try {
      engine.delete(req.params.id);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createPlaybookRoutes };
export {}; // CJS 模块标记
