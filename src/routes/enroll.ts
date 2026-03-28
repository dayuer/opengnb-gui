'use strict';
import type { Request, Response, NextFunction } from 'express';

const express = require('express');
const { createRateLimit } = require('../middleware/rate-limit');

/**
 * 节点注册 API（审批制 + passcode）
 * @param {import('../services/key-manager')} keyManager
 * @param {object} security - { requireAuth, audit }
 */
function createEnrollRouter(keyManager: any, security: any = {}) {
  const router = express.Router();
  const { requireAuth, audit } = security;

  // --- @alpha: enrollToken 认证中间件（节点端点） ---

  /**
   * 从 Bearer token 提取并验证 enrollToken
   * 失败返回 401；通过后 req.enrollNode = {nodeId}
   */
  const requireEnrollToken = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '未提供 enrollToken' });
    }
    const token = authHeader.slice(7);
    const result = keyManager.verifyEnrollToken(token);
    if (!result.valid) {
      return res.status(401).json({ error: 'enrollToken 无效' });
    }
    req.enrollNode = { nodeId: result.nodeId };
    next();
  };

  /**
   * 校验 :id 参数与 enrollToken 绑定的 nodeId 是否一致
   * 必须在 requireEnrollToken 之后使用
   */
  const requireNodeIdMatch = (req: Request, res: Response, next: NextFunction) => {
    if (req.params.id !== req.enrollNode.nodeId) {
      return res.status(403).json({ error: '无权访问此节点' });
    }
    next();
  };

  // --- 公开端点（无需认证） ---

  // GET /api/enroll/pubkey — 下载 Console SSH 公钥
  router.get('/pubkey', (req: Request, res: Response) => {
    res.json({ publicKey: keyManager.getPublicKey() });
  });

  // @alpha: GET /api/enroll/address-conf — 受 enrollToken 保护
  router.get('/address-conf', requireEnrollToken, (req: Request, res: Response) => {
    res.type('text/plain').send(keyManager.generateFullAddressConf());
  });

  // POST /api/enroll — 节点提交注册申请（需 passcode）
  // @security: 独立限速防滞用（安全审计 M5 修复）
  const enrollLimit = createRateLimit({ windowMs: 60000, max: 10, message: '注册请求过于频繁' });
  router.post('/', enrollLimit, (req: Request, res: Response) => {
    const result = keyManager.submitEnrollment(req.body);
    res.status(result.success ? 200 : 400).json(result);
  });

  // @alpha: GET /api/enroll/status/:id — 支持 enrollToken 或 admin/apiToken 认证
  //   解决服务器重启后 enrollToken 丢失导致脚本轮询失败
  const flexAuthStatus = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: '未提供认证 token' });
    }
    const token = authHeader.slice(7);
    // 优先尝试 enrollToken
    const enrollResult = keyManager.verifyEnrollToken(token);
    if (enrollResult.valid) {
      // enrollToken 仍需校验 nodeId 绑定
      if (req.params.id && req.params.id !== enrollResult.nodeId) {
        return res.status(403).json({ error: '无权访问此节点' });
      }
      req.enrollNode = { nodeId: enrollResult.nodeId };
      return next();
    }
    // 降级: admin/apiToken — 允许任何管理员查询任意节点状态
    if (requireAuth) {
      requireAuth(req, res, (err: any) => {
        if (err) return res.status(401).json({ error: 'token 无效' });
        req.enrollNode = { nodeId: req.params.id }; // 管理员可查任意节点
        next();
      });
    } else {
      res.status(401).json({ error: 'token 无效' });
    }
  };

  router.get('/status/:id', flexAuthStatus, (req: Request, res: Response) => {
    const node = keyManager.getAllNodes().find((n: any) => n.id === req.params.id);
    if (!node) return res.status(404).json({ status: 'deleted', message: '节点不存在或已被拒绝' });
    res.json({
      status: node.status,
      tunAddr: node.tunAddr || '',
      gnbNodeId: node.gnbNodeId || '',
      consoleGnbNodeId: keyManager.gnbNodeId,
      consoleGnbTunAddr: keyManager.gnbTunAddr,
      consoleGnbNetmask: keyManager.gnbNetmask,
      consoleGnbTunSubnet: keyManager.gnbTunSubnet,
    });
  });

  // @alpha: POST /api/enroll/:id/ready — 受 enrollToken + nodeId 绑定保护
  router.post('/:id/ready', requireEnrollToken, requireNodeIdMatch, (req: Request, res: Response) => {
    const result = keyManager.markNodeReady(req.params.id, req.body);
    res.status(result.success ? 200 : 400).json(result);
  });

  // --- GNB 公钥交换 ---

  // GET /api/enroll/gnb-pubkey — 获取 Console 的 GNB Ed25519 公钥（保持公开）
  router.get('/gnb-pubkey', (req: Request, res: Response) => {
    const pubKey = keyManager.getGnbPublicKey();
    if (!pubKey) return res.status(404).json({ error: 'Console GNB 公钥不存在' });
    res.json({ publicKey: pubKey, nodeId: keyManager.gnbNodeId });
  });

  // @alpha: POST /api/enroll/:id/gnb-pubkey — 受 enrollToken + nodeId 绑定保护
  router.post('/:id/gnb-pubkey', requireEnrollToken, requireNodeIdMatch, (req: Request, res: Response) => {
    const { publicKey } = req.body;
    if (!publicKey) return res.status(400).json({ error: '缺少 publicKey' });
    const result = keyManager.saveNodeGnbPubkey(req.params.id, publicKey);
    res.status(result.success ? 200 : 400).json(result);
  });

  // --- 管理员端点（需认证） ---

  // 构建管理员中间件链
  const adminMiddleware = [];
  if (requireAuth) adminMiddleware.push(requireAuth);
  if (audit) adminMiddleware.push(audit.middleware('enroll_admin'));

  // GET /api/enroll/passcode — 获取一次性注册 passcode（管理员操作）
  router.get('/passcode', ...adminMiddleware, (req: Request, res: Response) => {
    const { nodeId } = req.query;
    // @alpha: passcode 绑定生成者 userId（节点归属）
    const passcode = keyManager.generatePasscode(nodeId || '', req.user?.userId || '');
    res.json({ passcode, note: '此 passcode 仅可使用一次' });
  });

  // GET /api/enroll/pending — 待审批列表
  router.get('/pending', ...adminMiddleware, (req: Request, res: Response) => {
    res.json({ nodes: keyManager.getPendingNodes() });
  });

  // GET /api/enroll/all — 全部节点
  router.get('/all', ...adminMiddleware, (req: Request, res: Response) => {
    res.json({ nodes: keyManager.getAllNodes() });
  });

  // POST /api/enroll/:id/approve — 审批通过
  router.post('/:id/approve', ...adminMiddleware, (req: Request, res: Response) => {
    const result = keyManager.approveNode(req.params.id, req.body || {});
    res.status(result.success ? 200 : 404).json(result);
  });

  // POST /api/enroll/:id/reject — 拒绝
  router.post('/:id/reject', ...adminMiddleware, (req: Request, res: Response) => {
    const result = keyManager.rejectNode(req.params.id);
    res.status(result.success ? 200 : 404).json(result);
  });

  // DELETE /api/enroll/:id — 删除
  router.delete('/:id', ...adminMiddleware, (req: Request, res: Response) => {
    const result = keyManager.removeNode(req.params.id);
    res.status(result.success ? 200 : 404).json(result);
  });

  // @alpha: 批量操作
  // POST /api/enroll/batch — 批量审批/拒绝/删除
  router.post('/batch', ...adminMiddleware, (req: Request, res: Response) => {
    const { action, ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: '缺少 ids 数组' });

    const actions: Record<string, string> = { approve: 'batchApprove', reject: 'batchReject', remove: 'batchRemove' };
    const method = actions[action];
    if (!method) return res.status(400).json({ error: `无效 action: ${action}，允许: approve/reject/remove` });

    const result = keyManager[method](ids);
    res.json(result);
  });

  // @alpha: 修改节点分组
  // PATCH /api/enroll/:id/group
  router.patch('/:id/group', ...adminMiddleware, (req: Request, res: Response) => {
    const { groupId } = req.body;
    const result = keyManager.updateNodeGroup(req.params.id, groupId);
    res.status(result.success ? 200 : 404).json(result);
  });

  // POST /api/enroll/:id/claw-token — 节点或管理员提交 OpenClaw token
  // 认证：enrollToken（initnode 自动提交）或 adminMiddleware（手动管理）
  const clawTokenAuth = (req: Request, res: Response, next: NextFunction) => {
    // 先尝试 enrollToken
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const result = keyManager.verifyEnrollToken(token);
      if (result.valid) {
        req.enrollNode = { nodeId: result.nodeId };
        return next();
      }
    }
    // 回退到 admin 认证
    requireAuth(req, res, next);
  };
  router.post('/:id/claw-token', clawTokenAuth, (req: Request, res: Response) => {
    const { token: clawToken, port } = req.body;
    if (!clawToken || typeof clawToken !== 'string' || clawToken.length < 16) {
      return res.status(400).json({ error: '无效 clawToken' });
    }
    const ok = keyManager.updateNodeClawConfig(req.params.id, {
      token: clawToken,
      port: port || 18789,
    });
    if (!ok) return res.status(404).json({ error: '节点不存在' });
    res.json({ success: true, message: 'OpenClaw Token 已保存' });
  });

  return router;
}

module.exports = createEnrollRouter;

export {}; // CJS 模块标记
