'use strict';

const express = require('express');

/**
 * 分组管理 API 路由
 * @alpha: CRUD 端点
 * @param {import('../services/key-manager')} keyManager
 */
function createGroupsRouter(keyManager) {
  const router = express.Router();

  // GET /api/groups — 分组列表（含 nodeCount）
  router.get('/', (req, res) => {
    res.json({ groups: keyManager.getGroups() });
  });

  // POST /api/groups — 创建分组
  router.post('/', (req, res) => {
    const { name, color } = req.body;
    try {
      const group = keyManager.createGroup({ name, color });
      res.status(201).json(group);
    } catch (err) {
      const status = err.message.includes('已存在') ? 409 : 400;
      res.status(status).json({ error: err.message });
    }
  });

  // PUT /api/groups/:id — 更新分组
  router.put('/:id', (req, res) => {
    const result = keyManager.updateGroup(req.params.id, req.body);
    res.status(result.success ? 200 : 404).json(result);
  });

  // DELETE /api/groups/:id — 删除分组
  router.delete('/:id', (req, res) => {
    const result = keyManager.deleteGroup(req.params.id);
    res.status(result.success ? 200 : 404).json(result);
  });

  return router;
}

module.exports = createGroupsRouter;
