'use strict';

const express = require('express');

/**
 * AI 运维 API 路由
 * @param {import('../services/ai-ops')} aiOps
 */
function createAiRouter(aiOps) {
  const router = express.Router();

  // POST /api/ai/chat — AI 运维对话
  router.post('/chat', async (req, res) => {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: '缺少 message 参数' });
    }

    const result = await aiOps.chat(message);
    res.json(result);
  });

  // POST /api/ai/confirm — 确认执行 AI 建议的命令
  router.post('/confirm', async (req, res) => {
    const { confirmId } = req.body;
    if (!confirmId) {
      return res.status(400).json({ error: '缺少 confirmId 参数' });
    }

    const results = await aiOps.confirmAndExec(confirmId);
    res.json({ results });
  });

  return router;
}

module.exports = createAiRouter;
