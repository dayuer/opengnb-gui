'use strict';

const express = require('express');

/**
 * 异步 Job 路由
 *
 * 端点：
 *   POST /api/jobs/:jobId/callback  — Node 回调（clawToken 认证）
 *   GET  /api/jobs/:jobId           — 查询单个 job（管理员认证）
 *   GET  /api/jobs                  — 查询 job 列表（管理员认证）
 *   POST /api/jobs/dispatch         — 手动投递异步命令（管理员认证）
 *
 * @alpha: 核心路由
 */
function createJobsRouter({ jobManager, sshManager, keyManager, requireAuth, broadcastWS }: any) {
  const router = express.Router();

  /**
   * POST /:jobId/callback — Node 执行完毕后回调
   *
   * 安全：通过 clawToken 认证 + jobId 绑定 nodeId 校验
   */
  router.post('/:jobId/callback', express.json({ limit: '256kb' }), (req: any, res: any) => {
    const { jobId } = req.params;

    // @alpha: 从 Authorization header 提取 clawToken
    const authHeader = req.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
      return res.status(401).json({ error: '缺少认证 token' });
    }

    // 查找 job
    const job = jobManager.get(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job 不存在' });
    }

    // @alpha: 校验 clawToken 与 job 绑定的 nodeId 匹配
    const node = keyManager.getNodeById(job.nodeId);
    if (!node || node.clawToken !== token) {
      return res.status(403).json({ error: 'Token 与 Job 节点不匹配' });
    }

    // 已完成的 job 不再接受回调（幂等）
    if (job.status === 'completed' || job.status === 'failed') {
      return res.json({ ok: true, status: job.status, note: '已完成，忽略重复回调' });
    }

    // 解析回调数据
    const { exitCode, stdout_b64, stderr_b64 } = req.body;
    let stdout = '';
    let stderr = '';
    try {
      if (stdout_b64) stdout = Buffer.from(stdout_b64, 'base64').toString('utf-8');
      if (stderr_b64) stderr = Buffer.from(stderr_b64, 'base64').toString('utf-8');
    } catch (e) {
      stdout = String(stdout_b64 || '');
      stderr = String(stderr_b64 || '');
    }

    const completed = jobManager.complete(jobId, {
      exitCode: exitCode ?? -1,
      stdout,
      stderr,
    });

    // @alpha: WS 推送 job 结果
    if (broadcastWS && completed) {
      broadcastWS({
        type: 'job_result',
        job: completed,
      });
    }

    console.log(`[Job] 回调: ${jobId} node=${job.nodeId} exit=${exitCode}`);
    res.json({ ok: true, status: completed.status });
  });

  /**
   * GET /:jobId — 查询单个 job
   */
  router.get('/:jobId', requireAuth, (req: any, res: any) => {
    const job = jobManager.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job 不存在' });
    res.json(job);
  });

  /**
   * GET / — 查询 job 列表
   *
   * 查询参数：
   *   nodeId — 按节点过滤
   *   limit  — 数量限制（默认 50）
   */
  router.get('/', requireAuth, (req: any, res: any) => {
    const { nodeId, limit = '50' } = req.query;
    const n = Math.min(parseInt(limit) || 50, 200);

    if (nodeId) {
      res.json(jobManager.listByNode(nodeId, n));
    } else {
      res.json(jobManager.listRecent(n));
    }
  });

  /**
   * POST /dispatch — 手动投递异步命令
   *
   * Body: { nodeId, command }
   */
  router.post('/dispatch', requireAuth, express.json(), async (req: any, res: any) => {
    const { nodeId, command } = req.body;
    if (!nodeId || !command) {
      return res.status(400).json({ error: '缺少 nodeId 或 command' });
    }

    // 查找节点配置
    const node = keyManager.getNodeById(nodeId);
    if (!node || node.status !== 'approved') {
      return res.status(404).json({ error: '节点不存在或未审批' });
    }

    // 创建 job
    const { jobId, job } = jobManager.create(nodeId, command);

    // 构造回调 URL — 使用请求的 Host header
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('host');
    const callbackUrl = `${proto}://${host}/api/jobs/${jobId}/callback`;

    try {
      await sshManager.execAsync(node, command, jobId, callbackUrl);
      jobManager.markRunning(jobId);

      // WS 通知 job 已投递
      if (broadcastWS) {
        broadcastWS({ type: 'job_dispatched', job: jobManager.get(jobId) });
      }

      console.log(`[Job] 投递: ${jobId} node=${nodeId} cmd=${command.substring(0, 80)}`);
      res.json({ jobId, status: 'running' });
    } catch (err: any) {
      jobManager.fail(jobId, err.message);
      console.error(`[Job] 投递失败: ${jobId} ${err.message}`);
      res.status(502).json({ error: `投递失败: ${err.message}`, jobId });
    }
  });

  return router;
}

module.exports = createJobsRouter;
export {}; // CJS 模块标记
