'use strict';

const express = require('express');

/**
 * AI 运维 API 路由
 * @param {import('../services/ai-ops')} aiOps
 * @param {Function} saveOpsLog - saveOpsLog(nodeId, role, content)
 */
function createAiRouter(aiOps: any, saveOpsLog: any) {
  const router = express.Router();

  // POST /api/ai/chat — 运维指令
  router.post('/chat', async (req: any, res: any) => {
    try {
      const { message, nodeId } = req.body;
      if (!message) {
        return res.status(400).json({ error: '缺少 message 参数' });
      }

      // 运行命令路由
      const result = await aiOps.chat(message);

      // 确定日志归属的节点
      const logNodeId = result.targetNodeId || nodeId || '_global';

      // 持久化
      if (saveOpsLog) {
        saveOpsLog(logNodeId, 'user', message);
        saveOpsLog(logNodeId, 'assistant', result.response);
      }

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ response: `❌ 服务端异常: ${err.message}`, commands: [] });
    }
  });

  // POST /api/ai/confirm — 确认执行
  router.post('/confirm', async (req: any, res: any) => {
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
export {}; // CJS 模块标记
