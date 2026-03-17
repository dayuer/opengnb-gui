'use strict';

const express = require('express');

/**
 * 节点注册 API（审批制 + passcode）
 * @param {import('../services/key-manager')} keyManager
 */
function createEnrollRouter(keyManager) {
  const router = express.Router();

  // GET /api/enroll/pubkey — 下载 Console SSH 公钥
  router.get('/pubkey', (req, res) => {
    res.json({ publicKey: keyManager.getPublicKey() });
  });

  // GET /api/enroll/passcode — 获取一次性注册 passcode
  // 节点 init 脚本调用此端点获取注册码
  router.get('/passcode', (req, res) => {
    const { nodeId } = req.query;
    const passcode = keyManager.generatePasscode(nodeId || '');
    res.json({ passcode, note: '此 passcode 仅可使用一次' });
  });

  // POST /api/enroll — 节点提交注册申请（需 passcode）
  // body: { passcode, id, name, tunAddr, gnbMapPath, gnbCtlPath }
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

  // --- 管理员端点 ---

  // GET /api/enroll/pending — 待审批列表
  router.get('/pending', (req, res) => {
    res.json({ nodes: keyManager.getPendingNodes() });
  });

  // GET /api/enroll/all — 全部节点
  router.get('/all', (req, res) => {
    res.json({ nodes: keyManager.getAllNodes() });
  });

  // POST /api/enroll/:id/approve — 审批通过（body 可携带 tunAddr）
  router.post('/:id/approve', (req, res) => {
    const result = keyManager.approveNode(req.params.id, req.body || {});
    res.status(result.success ? 200 : 404).json(result);
  });

  // POST /api/enroll/:id/reject — 拒绝
  router.post('/:id/reject', (req, res) => {
    const result = keyManager.rejectNode(req.params.id);
    res.status(result.success ? 200 : 404).json(result);
  });

  // --- GNB 公钥交换 ---

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

  // DELETE /api/enroll/:id — 删除
  router.delete('/:id', (req, res) => {
    const result = keyManager.removeNode(req.params.id);
    res.status(result.success ? 200 : 404).json(result);
  });

  return router;
}

module.exports = createEnrollRouter;
