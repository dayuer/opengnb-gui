'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * SSH 密钥管理器 + 节点注册（审批制）
 *
 * 流程：
 *   1. Console 首次启动自动生成 ED25519 密钥对
 *   2. 节点运行 init-node.sh → GET /api/enroll/pubkey 下载 Console 公钥
 *   3. 节点将公钥写入 authorized_keys → POST /api/enroll 提交注册（状态 pending）
 *   4. 管理员在 Web UI 审批 → POST /api/enroll/:id/approve（状态变为 approved）
 *   5. 仅 approved 的节点才会被 GnbMonitor 纳入监控
 */
class KeyManager {
  /**
   * @param {object} options
   * @param {string} options.dataDir - 数据目录
   */
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.resolve(__dirname, '../../data');
    this.keyDir = path.join(this.dataDir, 'ssh');
    this.privateKeyPath = path.join(this.keyDir, 'console_ed25519');
    this.publicKeyPath = path.join(this.keyDir, 'console_ed25519.pub');

    /**
     * 节点注册表
     * status: 'pending' | 'approved' | 'rejected'
     * @type {Array<object>}
     */
    this.nodes = [];
    this.nodesPath = path.join(this.dataDir, 'nodes.json');
    this.backupDir = path.join(this.dataDir, 'backups');
    this.maxBackups = 5;

    /** @type {Map<string, {passcode: string, createdAt: string, used: boolean}>} */
    this.passcodes = new Map();

    /** @type {Function|null} 审批回调 */
    this.onApproval = null;
    /** @type {Function|null} 节点就绪回调（触发 Provisioner） */
    this.onNodeReady = null;
  }

  /**
   * 初始化：确保密钥对存在，加载节点注册表（含备份恢复）
   */
  async init() {
    fs.mkdirSync(this.keyDir, { recursive: true });
    fs.mkdirSync(this.backupDir, { recursive: true });

    if (!fs.existsSync(this.privateKeyPath)) {
      this._generateKeyPair();
      console.log('[KeyManager] 已生成新的 ED25519 密钥对');
    } else {
      console.log('[KeyManager] 已加载现有密钥对');
    }

    // 加载节点注册表（主文件 → 备份恢复）
    this.nodes = this._loadWithRecovery();

    console.log(`[KeyManager] ${this.nodes.filter(n => n.status === 'approved').length} 个已审批节点, ${this.nodes.filter(n => n.status === 'pending').length} 个待审批`);
  }

  /** @private */
  _generateKeyPair() {
    const { execSync } = require('child_process');
    try {
      execSync(`ssh-keygen -t ed25519 -f "${this.privateKeyPath}" -N "" -C "gnb-console"`, { stdio: 'pipe' });
    } catch (err) {
      // 回退：用 Node.js crypto 生成
      const { generateKeyPairSync } = crypto;
      const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      fs.writeFileSync(this.privateKeyPath, privateKey, { mode: 0o600 });
      fs.writeFileSync(this.publicKeyPath, publicKey);
    }
  }

  getPrivateKey() { return fs.readFileSync(this.privateKeyPath); }
  getPublicKey() { return fs.readFileSync(this.publicKeyPath, 'utf-8').trim(); }

  /**
   * 生成一次性注册 passcode
   * @param {string} [label] - 标签
   * @returns {string} passcode
   */
  generatePasscode(label = '') {
    const passcode = crypto.randomBytes(16).toString('hex');
    this.passcodes.set(passcode, { label, createdAt: new Date().toISOString(), used: false });
    return passcode;
  }

  /**
   * 节点提交注册申请（需携带有效 passcode）
   * @param {object} nodeInfo - {passcode, id, name, tunAddr, gnbMapPath, gnbCtlPath}
   * @returns {{success: boolean, status: string, message: string}}
   */
  submitEnrollment(nodeInfo) {
    if (!nodeInfo.id || !nodeInfo.tunAddr) {
      return { success: false, status: 'error', message: '缺少 id 或 tunAddr' };
    }

    // 验证 passcode
    if (!nodeInfo.passcode) {
      return { success: false, status: 'error', message: '缺少 passcode' };
    }
    const pc = this.passcodes.get(nodeInfo.passcode);
    if (!pc) {
      return { success: false, status: 'error', message: 'passcode 无效' };
    }
    if (pc.used) {
      return { success: false, status: 'error', message: 'passcode 已使用' };
    }

    // 标记 passcode 已用
    pc.used = true;
    pc.usedBy = nodeInfo.id;

    const existing = this.nodes.find(n => n.id === nodeInfo.id);
    if (existing) {
      if (existing.status === 'approved') {
        return { success: true, status: 'approved', message: '节点已通过审批' };
      }
      if (existing.status === 'pending') {
        Object.assign(existing, nodeInfo, { updatedAt: new Date().toISOString() });
        delete existing.passcode;
        this._save();
        return { success: true, status: 'pending', message: '注册信息已更新，等待管理员审批' };
      }
    }

    const record = { ...nodeInfo };
    delete record.passcode;

    this.nodes.push({
      ...record,
      sshUser: 'synon',
      sshPort: 22,
      gnbMapPath: record.gnbMapPath || `/opt/gnb/conf/${record.id}/gnb.map`,
      gnbCtlPath: record.gnbCtlPath || 'gnb_ctl',
      status: 'pending',
      ready: false,
      submittedAt: new Date().toISOString(),
      approvedAt: null,
    });
    this._save();

    return { success: true, status: 'pending', message: '注册申请已提交，等待管理员审批' };
  }

  /**
   * 节点标记为就绪（synon 已创建、公钥已部署）
   * @param {string} nodeId
   * @param {object} sshInfo - {sshUser, sshPort}
   */
  markNodeReady(nodeId, sshInfo = {}) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    if (node.status !== 'approved') return { success: false, message: '节点未通过审批' };

    node.ready = true;
    node.sshUser = sshInfo.sshUser || 'synon';
    node.sshPort = sshInfo.sshPort || 22;
    node.readyAt = new Date().toISOString();
    this._save();

    // 触发就绪回调（Provisioner 安装 OpenClaw）
    if (this.onNodeReady) {
      const config = this.getApprovedNodesConfig().find(n => n.id === nodeId);
      if (config) this.onNodeReady(config);
    }

    return { success: true, message: `节点 ${nodeId} 已就绪，Console 将开始远程配置` };
  }

  /**
   * 管理员审批通过
   * @param {string} nodeId
   * @returns {{success: boolean, message: string}}
   */
  approveNode(nodeId) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    if (node.status === 'approved') return { success: true, message: '已审批' };

    node.status = 'approved';
    node.approvedAt = new Date().toISOString();
    this._save();

    if (this.onApproval) this.onApproval(this.getApprovedNodesConfig());

    return { success: true, message: `节点 ${nodeId} 已通过审批` };
  }

  /**
   * 管理员拒绝
   * @param {string} nodeId
   */
  rejectNode(nodeId) {
    const node = this.nodes.find(n => n.id === nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    node.status = 'rejected';
    this._save();
    return { success: true, message: `节点 ${nodeId} 已拒绝` };
  }

  /**
   * 删除节点
   * @param {string} nodeId
   */
  removeNode(nodeId) {
    this.nodes = this.nodes.filter(n => n.id !== nodeId);
    this._save();
    return { success: true, message: `节点 ${nodeId} 已删除` };
  }

  /**
   * 获取全部节点（含状态）
   */
  getAllNodes() { return this.nodes; }

  /**
   * 获取待审批节点
   */
  getPendingNodes() { return this.nodes.filter(n => n.status === 'pending'); }

  /**
   * 获取已审批节点的 SSH 配置（供 Monitor 使用）
   * @returns {Array<object>}
   */
  getApprovedNodesConfig() {
    return this.nodes
      .filter(n => n.status === 'approved')
      .map(n => ({
        id: n.id,
        name: n.name || n.id,
        tunAddr: n.tunAddr,
        sshPort: n.sshPort || 22,
        sshUser: n.sshUser || 'synon',
        sshKeyPath: this.privateKeyPath,
        gnbMapPath: n.gnbMapPath,
        gnbCtlPath: n.gnbCtlPath,
      }));
  }

  /** @private 保存并备份 */
  _save() {
    this._backup();
    const tmpPath = this.nodesPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(this.nodes, null, 2));
    fs.renameSync(tmpPath, this.nodesPath); // 原子写入
  }

  /** @private 备份当前文件（轮转保留 maxBackups 个） */
  _backup() {
    if (!fs.existsSync(this.nodesPath)) return;

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupDir, `nodes_${ts}.json`);

    try {
      fs.copyFileSync(this.nodesPath, backupPath);
    } catch (err) {
      console.error(`[KeyManager] 备份失败: ${err.message}`);
      return;
    }

    // 清理过期备份
    const backups = this._getBackupFiles();
    while (backups.length > this.maxBackups) {
      const oldest = backups.shift();
      try { fs.unlinkSync(path.join(this.backupDir, oldest)); } catch (_) {}
    }
  }

  /** @private 加载节点数据（主文件 → 自动从备份恢复） */
  _loadWithRecovery() {
    // 尝试主文件
    if (fs.existsSync(this.nodesPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.nodesPath, 'utf-8'));
        if (Array.isArray(data)) return data;
      } catch (err) {
        console.error(`[KeyManager] 主文件损坏: ${err.message}，尝试从备份恢复`);
      }
    }

    // 从最新备份恢复
    const backups = this._getBackupFiles();
    for (let i = backups.length - 1; i >= 0; i--) {
      const bp = path.join(this.backupDir, backups[i]);
      try {
        const data = JSON.parse(fs.readFileSync(bp, 'utf-8'));
        if (Array.isArray(data)) {
          // 恢复到主文件
          fs.writeFileSync(this.nodesPath, JSON.stringify(data, null, 2));
          console.log(`[KeyManager] 已从备份恢复: ${backups[i]}`);
          return data;
        }
      } catch (_) {
        continue;
      }
    }

    console.log('[KeyManager] 无可用数据，初始化为空');
    return [];
  }

  /** @private 获取备份文件列表（按时间排序） */
  _getBackupFiles() {
    try {
      return fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('nodes_') && f.endsWith('.json'))
        .sort();
    } catch (_) {
      return [];
    }
  }
}

module.exports = KeyManager;
