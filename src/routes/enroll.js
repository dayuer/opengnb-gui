'use strict';

const express = require('express');

/**
 * 节点注册 API（审批制 + passcode）
 * @param {import('../services/key-manager')} keyManager
 * @param {object} security - { requireAuth, audit }
 */
function createEnrollRouter(keyManager, security = {}) {
  const router = express.Router();
  const { requireAuth, audit } = security;

  // --- 公开端点（节点调用） ---

  // GET /api/enroll/pubkey — 下载 Console SSH 公钥
  router.get('/pubkey', (req, res) => {
    res.json({ publicKey: keyManager.getPublicKey() });
  });

  // POST /api/enroll — 节点提交注册申请（需 passcode）
  router.post('/', (req, res) => {
    const result = keyManager.submitEnrollment(req.body);
    res.status(result.success ? 200 : 400).json(result);
  });

  // GET /api/enroll/status/:id — 节点查询审批状态
  router.get('/status/:id', (req, res) => {
    const node = keyManager.getAllNodes().find(n => n.id === req.params.id);
    if (!node) return res.status(404).json({ status: 'unknown' });
    res.json({
      status: node.status,
      tunAddr: node.tunAddr || '',
      gnbNodeId: node.gnbNodeId || '',
      consoleGnbNodeId: keyManager.gnbNodeId,
      consoleGnbTunAddr: keyManager.gnbTunAddr,
    });
  });

  // POST /api/enroll/:id/ready — 节点通知就绪（synon + 公钥已部署）
  router.post('/:id/ready', (req, res) => {
    const result = keyManager.markNodeReady(req.params.id, req.body);
    res.status(result.success ? 200 : 400).json(result);
  });

  // --- GNB 公钥交换（公开） ---

  // GET /api/enroll/gnb-pubkey — 获取 Console 的 GNB Ed25519 公钥
  router.get('/gnb-pubkey', (req, res) => {
    const pubKey = keyManager.getGnbPublicKey();
    if (!pubKey) return res.status(404).json({ error: 'Console GNB 公钥不存在' });
    res.json({ publicKey: pubKey, nodeId: keyManager.gnbNodeId });
  });

  // POST /api/enroll/:id/gnb-pubkey — 终端上传自身 GNB 公钥
  router.post('/:id/gnb-pubkey', (req, res) => {
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
  router.get('/passcode', ...adminMiddleware, (req, res) => {
    const { nodeId } = req.query;
    const passcode = keyManager.generatePasscode(nodeId || '');
    res.json({ passcode, note: '此 passcode 仅可使用一次' });
  });

  // GET /api/enroll/pending — 待审批列表
  router.get('/pending', ...adminMiddleware, (req, res) => {
    res.json({ nodes: keyManager.getPendingNodes() });
  });

  // GET /api/enroll/all — 全部节点
  router.get('/all', ...adminMiddleware, (req, res) => {
    res.json({ nodes: keyManager.getAllNodes() });
  });

  // POST /api/enroll/:id/approve — 审批通过
  router.post('/:id/approve', ...adminMiddleware, (req, res) => {
    const result = keyManager.approveNode(req.params.id, req.body || {});
    res.status(result.success ? 200 : 404).json(result);
  });

  // POST /api/enroll/:id/reject — 拒绝
  router.post('/:id/reject', ...adminMiddleware, (req, res) => {
    const result = keyManager.rejectNode(req.params.id);
    res.status(result.success ? 200 : 404).json(result);
  });

  // DELETE /api/enroll/:id — 删除
  router.delete('/:id', ...adminMiddleware, (req, res) => {
    const result = keyManager.removeNode(req.params.id);
    res.status(result.success ? 200 : 404).json(result);
  });

  // @alpha: 批量操作
  // POST /api/enroll/batch — 批量审批/拒绝/删除
  router.post('/batch', ...adminMiddleware, (req, res) => {
    const { action, ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: '缺少 ids 数组' });

    const actions = { approve: 'batchApprove', reject: 'batchReject', remove: 'batchRemove' };
    const method = actions[action];
    if (!method) return res.status(400).json({ error: `无效 action: ${action}，允许: approve/reject/remove` });

    const result = keyManager[method](ids);
    res.json(result);
  });

  // @alpha: 修改节点分组
  // PATCH /api/enroll/:id/group
  router.patch('/:id/group', ...adminMiddleware, (req, res) => {
    const { groupId } = req.body;
    const result = keyManager.updateNodeGroup(req.params.id, groupId);
    res.status(result.success ? 200 : 404).json(result);
  });

  return router;
}

module.exports = createEnrollRouter;

