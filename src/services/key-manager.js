'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { resolvePaths, ensureDataDirs } = require('./data-paths');
const NodeStore = require('./node-store');

/**
 * SSH 密钥管理器 + 节点注册（审批制）
 *
 * 流程：
 *   1. Console 首次启动自动生成 ED25519 密钥对
 *   2. 节点运行 initnode.sh → GET /api/enroll/pubkey 下载 Console 公钥
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

    // @alpha: 使用集中路径管理
    const paths = options.paths || resolvePaths(this.dataDir);
    this.keyDir = paths.security.sshDir;
    this.privateKeyPath = paths.security.privateKey;
    this.publicKeyPath = paths.security.publicKey;

    // GNB 配置路径（Console 节点）
    this.gnbNodeId = process.env.GNB_NODE_ID || '1001';
    this.gnbConfDir = process.env.GNB_CONF_DIR || `/opt/gnb/conf/${this.gnbNodeId}`;
    this.gnbTunAddr = process.env.GNB_TUN_ADDR || '10.1.0.1';
    this.gnbIndexAddr = process.env.GNB_INDEX_ADDR || '';

    // @alpha V2: SQLite 存储层
    this.store = new NodeStore(paths.registry.nodesDb);

    /** @type {Map<string, {passcode: string, createdAt: string, used: boolean}>} */
    this.passcodes = new Map();

    /** @type {Function|null} 审批回调 */
    this.onApproval = null;
    /** @type {Function|null} 节点就绪回调（触发 Provisioner） */
    this.onNodeReady = null;
  }

  /**
   * 初始化：确保密钥对存在，初始化 SQLite 存储
   */
  async init() {
    const paths = resolvePaths(this.dataDir);
    ensureDataDirs(paths);
    fs.mkdirSync(this.keyDir, { recursive: true });

    if (!fs.existsSync(this.privateKeyPath)) {
      this._generateKeyPair();
      console.log('[KeyManager] 已生成新的 ED25519 密钥对');
    } else {
      console.log('[KeyManager] 已加载现有密钥对');
    }

    // @alpha V2: 初始化 SQLite 存储
    this.store.init();

    const approved = this.store.countByStatus('approved');
    const pending = this.store.countByStatus('pending');
    const groupCount = this.store.allGroups().length;
    console.log(`[KeyManager] ${approved} 个已审批节点, ${pending} 个待审批, ${groupCount} 个分组 (SQLite)`);
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
    if (!nodeInfo.id) {
      return { success: false, status: 'error', message: '缺少 id' };
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

    const existing = this.store.findById(nodeInfo.id);
    if (existing) {
      if (existing.status === 'approved') {
        return { success: true, status: 'approved', message: '节点已通过审批' };
      }
      if (existing.status === 'pending') {
        const updates = { ...nodeInfo, updatedAt: new Date().toISOString() };
        delete updates.passcode;
        this.store.update(nodeInfo.id, updates);
        return { success: true, status: 'pending', message: '注册信息已更新，等待管理员审批' };
      }
    }

    const record = { ...nodeInfo };
    delete record.passcode;

    this.store.insert({
      ...record,
      tunAddr: record.tunAddr || '',
      sshUser: 'synon',
      sshPort: 22,
      gnbMapPath: record.gnbMapPath || `/opt/gnb/conf/${record.id}/gnb.map`,
      gnbCtlPath: record.gnbCtlPath || 'gnb_ctl',
      status: 'pending',
      ready: false,
      submittedAt: new Date().toISOString(),
      approvedAt: null,
    });

    return { success: true, status: 'pending', message: '注册申请已提交，等待管理员审批' };
  }

  /**
   * 节点标记为就绪（synon 已创建、公钥已部署）
   * @param {string} nodeId
   * @param {object} sshInfo - {sshUser, sshPort}
   */
  markNodeReady(nodeId, sshInfo = {}) {
    const node = this.store.findById(nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    if (node.status !== 'approved') return { success: false, message: '节点未通过审批' };

    this.store.update(nodeId, {
      ready: true,
      sshUser: sshInfo.sshUser || 'synon',
      sshPort: sshInfo.sshPort || 22,
      readyAt: new Date().toISOString(),
    });

    // 触发就绪回调（Provisioner 安装 OpenClaw）
    if (this.onNodeReady) {
      const config = this.getApprovedNodesConfig().find(n => n.id === nodeId);
      if (config) this.onNodeReady(config);
    }

    return { success: true, message: `节点 ${nodeId} 已就绪，Console 将开始远程配置` };
  }

  /**
   * 管理员审批通过（自动分配 IP + GNB 节点 ID）
   * @param {string} nodeId
   * @returns {{success: boolean, message: string}}
   */
  approveNode(nodeId, options = {}) {
    const node = this.store.findById(nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    if (node.status === 'approved') return { success: true, message: '已审批', tunAddr: node.tunAddr };

    // 分配 TUN 地址：优先手动指定，否则自动分配
    const tunAddr = options.tunAddr || node.tunAddr || this._nextAvailableIp();
    const gnbNodeId = options.gnbNodeId || node.gnbNodeId;

    this.store.update(nodeId, {
      tunAddr,
      gnbNodeId,
      status: 'approved',
      approvedAt: new Date().toISOString(),
    });

    // 重新读取更新后的节点
    const updated = this.store.findById(nodeId);

    // 自动更新 Console 的 GNB 配置
    this._updateGnbConfig(updated);

    if (this.onApproval) this.onApproval(this.getApprovedNodesConfig());

    return { success: true, message: `节点 ${nodeId} 已通过审批`, tunAddr: updated.tunAddr, gnbNodeId: updated.gnbNodeId };
  }

  /**
   * 生成全量 address.conf（index + 所有已审批节点）
   * @returns {string} address.conf 完整内容
   */
  generateFullAddressConf() {
    // 读取 index 行 (i|0|公网IP|端口)
    const addressConfPath = path.join(this.gnbConfDir, 'address.conf');
    let indexLine = `i|0|${this.gnbIndexAddr || '0.0.0.0'}|9001`;
    try {
      if (fs.existsSync(addressConfPath)) {
        const existing = fs.readFileSync(addressConfPath, 'utf8');
        const match = existing.match(/^i\|.*$/m);
        if (match) indexLine = match[0];
      }
    } catch (_) { /* 使用默认值 */ }

    const lines = [indexLine];
    // Console 自身
    lines.push(`${this.gnbNodeId}|${this.gnbTunAddr}|255.0.0.0`);
    // 所有已审批节点（从 SQLite 查询）
    for (const node of this.store.approvedWithGnb()) {
      if (node.tunAddr) {
        lines.push(`${node.gnbNodeId}|${node.tunAddr}|${node.netmask || '255.0.0.0'}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  /**
   * 审批后更新 Console 的 GNB 配置（全量重写）
   * @param {object} node - 已审批的节点
   */
  _updateGnbConfig(node) {
    if (!node.tunAddr) return;

    if (!node.gnbNodeId) {
      const gnbNodeId = this._nextGnbNodeId();
      this.store.update(node.id, { gnbNodeId });
      node.gnbNodeId = gnbNodeId;
    }

    this._writeFullGnbConf();
  }

  /**
   * 全量重写 index 侧 route.conf + address.conf + 重启 GNB
   * @private
   */
  _writeFullGnbConf() {
    try {
      if (!fs.existsSync(this.gnbConfDir)) {
        console.log(`[GNB] 配置目录不存在: ${this.gnbConfDir}，跳过`);
        return;
      }
      const fullConf = this.generateFullAddressConf();
      // address.conf = 全量（含 i| 行）
      fs.writeFileSync(path.join(this.gnbConfDir, 'address.conf'), fullConf);
      // route.conf = 全量（去掉 i| 行）
      const routeContent = fullConf.split('\n').filter(l => !l.startsWith('i|')).join('\n');
      fs.writeFileSync(path.join(this.gnbConfDir, 'route.conf'), routeContent);
      console.log(`[GNB] 配置已全量重写`);

      try {
        execSync('systemctl restart gnb', { timeout: 10000 });
        console.log('[GNB] 服务已重启');
      } catch (e) {
        console.log(`[GNB] 重启跳过: ${e.message}`);
      }
    } catch (err) {
      console.error(`[GNB] 全量重写失败: ${err.message}`);
    }
  }

  /**
   * 自动分配下一个 GNB 节点 ID（从 1002 开始，Console 自身是 1001）
   */
  _nextGnbNodeId() {
    const allNodes = this.store.all();
    const usedIds = allNodes
      .filter(n => n.gnbNodeId)
      .map(n => parseInt(n.gnbNodeId, 10));
    const consoleId = parseInt(this.gnbNodeId, 10);
    usedIds.push(consoleId);
    return String(Math.max(...usedIds) + 1);
  }

  /**
   * 自动分配下一个可用 TUN IP 地址
   * 策略：10.0.0.x → 10.0.1.x → ... → 10.255.255.x 顺序填充
   * 并发安全：Node.js 单线程，此方法同步执行，调用后立即 _save()
   * @returns {string} 如 '10.0.0.2'
   */
  _nextAvailableIp() {
    const usedIps = this.store.allTunAddrs();
    if (this.gnbTunAddr) usedIps.add(this.gnbTunAddr);

    // 遍历 10.0.0.x → 10.0.1.x → ... → 10.255.255.x
    for (let b = 0; b <= 255; b++) {
      for (let c = 0; c <= 255; c++) {
        const start = (b === 0 && c === 0) ? 2 : 1; // 10.0.0.0/1 跳过
        for (let d = start; d <= 254; d++) {
          const candidate = `10.${b}.${c}.${d}`;
          if (!usedIps.has(candidate)) return candidate;
        }
      }
    }
    throw new Error('IP 地址池已耗尽');
  }

  /**
   * 获取 Console GNB 节点的 Ed25519 公钥
   */
  getGnbPublicKey() {
    const pubKeyPath = path.join(this.gnbConfDir, 'security', `${this.gnbNodeId}.public`);
    try {
      return fs.readFileSync(pubKeyPath, 'utf8').trim();
    } catch {
      return null;
    }
  }

  /**
   * 保存终端节点的 GNB 公钥到 Console 的 ed25519 目录
   * @param {string} nodeId
   * @param {string} pubKey - hex 编码的 Ed25519 公钥
   */
  saveNodeGnbPubkey(nodeId, pubKey) {
    const node = this.store.findById(nodeId);
    if (!node || !node.gnbNodeId) {
      return { success: false, message: '节点不存在或未分配 GNB ID' };
    }
    const ed25519Dir = path.join(this.gnbConfDir, 'ed25519');
    if (!fs.existsSync(ed25519Dir)) fs.mkdirSync(ed25519Dir, { recursive: true });
    const keyPath = path.join(ed25519Dir, `${node.gnbNodeId}.public`);
    fs.writeFileSync(keyPath, pubKey.trim());
    console.log(`[GNB] 已保存节点 ${nodeId} (gnb ${node.gnbNodeId}) 的公钥`);

    // 保存公钥后重启 GNB 以加载
    try {
      execSync('systemctl restart gnb', { timeout: 10000 });
    } catch (e) {
      console.log(`[GNB] 重启服务跳过: ${e.message}`);
    }

    return { success: true, message: '公钥已保存' };
  }

  /**
   * 管理员拒绝
   * @param {string} nodeId
   */
  rejectNode(nodeId) {
    const node = this.store.findById(nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    this.store.update(nodeId, { status: 'rejected' });
    return { success: true, message: `节点 ${nodeId} 已拒绝` };
  }

  /**
   * 删除节点
   * @param {string} nodeId
   */
  removeNode(nodeId) {
    this.store.remove(nodeId);
    return { success: true, message: `节点 ${nodeId} 已删除` };
  }

  // ═══════════════════════════════════════
  // @alpha: 节点信息编辑
  // ═══════════════════════════════════════

  /** @private IPv4 格式校验 */
  static _isValidIPv4(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every(p => {
      const n = parseInt(p, 10);
      return String(n) === p && n >= 0 && n <= 255;
    });
  }

  /**
   * 编辑已审批节点的可变字段
   * @param {string} nodeId
   * @param {object} fields - { name?, tunAddr?, sshPort?, sshUser? }
   * @returns {{success: boolean, message: string, changedFields?: string[]}}
   */
  updateNode(nodeId, fields = {}) {
    const node = this.store.findById(nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    if (node.status !== 'approved') return { success: false, message: '仅已审批节点可编辑' };

    const allowed = ['name', 'tunAddr', 'sshPort', 'sshUser'];
    const changedFields = [];

    // 校验 tunAddr
    if (fields.tunAddr !== undefined) {
      const ip = String(fields.tunAddr).trim();
      if (!ip) return { success: false, message: 'tunAddr 不能为空' };
      if (!KeyManager._isValidIPv4(ip)) return { success: false, message: `IP 格式错误: ${ip}` };
      // 唯一性检查（SQLite 查询）
      const dup = this.store.isTunAddrTaken(ip, nodeId);
      if (dup) return { success: false, message: `IP ${ip} 已被节点 ${dup.name || dup.id} 使用`, code: 'CONFLICT' };
      fields.tunAddr = ip;
    }

    // 校验 sshPort
    if (fields.sshPort !== undefined) {
      const port = parseInt(fields.sshPort, 10);
      if (isNaN(port) || port < 1 || port > 65535) return { success: false, message: '端口范围 1-65535' };
      fields.sshPort = port;
    }

    // 校验 name
    if (fields.name !== undefined) {
      const name = String(fields.name).trim();
      if (!name) return { success: false, message: 'name 不能为空' };
      if (name.length > 64) return { success: false, message: 'name 最长 64 字符' };
      fields.name = name;
    }

    // 校验 sshUser
    if (fields.sshUser !== undefined) {
      const user = String(fields.sshUser).trim();
      if (!user) return { success: false, message: 'sshUser 不能为空' };
      fields.sshUser = user;
    }

    // 检测变更
    for (const key of allowed) {
      if (fields[key] !== undefined && node[key] !== fields[key]) {
        changedFields.push(key);
      }
    }

    if (changedFields.length === 0) return { success: true, message: '无变更', changedFields: [] };

    // 应用变更到 SQLite
    const updateFields = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) updateFields[key] = fields[key];
    }
    updateFields.updatedAt = new Date().toISOString();
    this.store.update(nodeId, updateFields);

    // tunAddr 变更时同步 GNB 配置
    if (changedFields.includes('tunAddr')) {
      const updatedNode = this.store.findById(nodeId);
      if (updatedNode && updatedNode.gnbNodeId) this._updateGnbAddressConf(updatedNode);
    }

    // 触发更新回调
    if (this.onNodeUpdate) this.onNodeUpdate(nodeId, changedFields);

    return { success: true, message: `节点 ${nodeId} 已更新`, changedFields };
  }

  /**
   * 编辑 tunAddr 时重写 GNB 配置（全量模式）
   * @private
   */
  _updateGnbAddressConf(node) {
    if (!node.tunAddr || !node.gnbNodeId) return;
    this._writeFullGnbConf();
  }

  /**
   * 获取全部节点（含状态）
   */
  getAllNodes() { return this.store.all(); }

  /**
   * 获取待审批节点
   */
  getPendingNodes() { return this.store.findByStatus('pending'); }

  // ═══════════════════════════════════════
  // @alpha: 分组管理（委托 NodeStore）
  // ═══════════════════════════════════════

  /**
   * 创建分组
   * @param {{name: string, color?: string}} opts
   * @returns {{id: string, name: string, color: string, createdAt: string}}
   */
  createGroup({ name, color = '#388bfd' }) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw new Error('名称不能为空');
    if (this.store.findGroupByName(trimmed)) throw new Error('同名分组已存在');

    const group = {
      id: crypto.randomBytes(8).toString('hex'),
      name: trimmed,
      color,
      createdAt: new Date().toISOString(),
    };
    this.store.insertGroup(group);
    return group;
  }

  /**
   * 获取分组列表（含每组节点计数）
   * @returns {Array<object>}
   */
  getGroups() {
    return this.store.allGroups().map(g => ({
      ...g,
      nodeCount: this.store.countNodesByGroup(g.id),
    }));
  }

  /**
   * 更新分组
   * @param {string} groupId
   * @param {{name?: string, color?: string}} updates
   */
  updateGroup(groupId, updates) {
    const ok = this.store.updateGroupFields(groupId, updates);
    if (!ok) return { success: false, message: '分组不存在' };
    return { success: true };
  }

  /**
   * 删除分组（事务：原子清空关联节点 groupId + 删除分组）
   * @param {string} groupId
   */
  deleteGroup(groupId) {
    this.store.removeGroup(groupId);
    return { success: true };
  }

  /**
   * 修改节点所属分组
   * @param {string} nodeId
   * @param {string|null} groupId
   */
  updateNodeGroup(nodeId, groupId) {
    const node = this.store.findById(nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    if (groupId && !this.store.findGroupById(groupId)) {
      return { success: false, message: '分组不存在' };
    }
    this.store.update(nodeId, { groupId: groupId || '' });
    return { success: true };
  }

  // ═══════════════════════════════════════
  // @alpha: 过滤查询 + 分页
  // ═══════════════════════════════════════

  /**
   * 带过滤和分页的节点查询
   * @param {{groupId?, subnet?, keyword?, status?, page?, pageSize?}} opts
   * @returns {{nodes: Array, total: number, page: number, pageSize: number, totalPages: number}}
   */
  getFilteredNodes(opts = {}) {
    let result = this.store.all();

    if (opts.groupId) result = result.filter(n => n.groupId === opts.groupId);
    if (opts.status) result = result.filter(n => n.status === opts.status);
    if (opts.keyword) {
      const kw = opts.keyword.toLowerCase();
      result = result.filter(n =>
        (n.name || '').toLowerCase().includes(kw) ||
        (n.id || '').toLowerCase().includes(kw) ||
        (n.tunAddr || '').toLowerCase().includes(kw)
      );
    }
    if (opts.subnet) result = result.filter(n => n.tunAddr && KeyManager._cidrMatch(n.tunAddr, opts.subnet));

    const total = result.length;
    const page = Math.max(1, parseInt(opts.page, 10) || 1);
    const pageSize = Math.max(1, parseInt(opts.pageSize, 10) || 50);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;

    return {
      nodes: result.slice(start, start + pageSize),
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  // ═══════════════════════════════════════
  // @alpha: 批量操作
  // ═══════════════════════════════════════

  /**
   * 批量审批
   * @param {string[]} ids
   * @returns {{succeeded: string[], failed: Array<{id: string, reason: string}>}}
   */
  batchApprove(ids) { return this._batchAction(ids, id => this.approveNode(id)); }

  /**
   * 批量拒绝
   * @param {string[]} ids
   */
  batchReject(ids) { return this._batchAction(ids, id => this.rejectNode(id)); }

  /**
   * 批量删除
   * @param {string[]} ids
   */
  batchRemove(ids) { return this._batchAction(ids, id => this.removeNode(id)); }

  /** @private 批量操作通用 */
  _batchAction(ids, action) {
    const succeeded = [];
    const failed = [];
    for (const id of ids) {
      const result = action(id);
      if (result.success) { succeeded.push(id); }
      else { failed.push({ id, reason: result.message }); }
    }
    return { succeeded, failed };
  }

  // ═══════════════════════════════════════
  // @alpha: CIDR 匹配
  // ═══════════════════════════════════════

  /**
   * 判断 IP 是否在 CIDR 范围内
   * @param {string} ip - 如 '10.1.0.2'
   * @param {string} cidr - 如 '10.1.0.0/24'
   * @returns {boolean}
   */
  static _cidrMatch(ip, cidr) {
    const [range, bits] = cidr.split('/');
    if (!range || !bits) return false;
    const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1) >>> 0;
    return (KeyManager._ipToInt(ip) & mask) === (KeyManager._ipToInt(range) & mask);
  }

  /** @private IP 字符串转 32 位整数 */
  static _ipToInt(ip) {
    return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  }


  /**
   * 获取已审批节点的 SSH 配置（供 Monitor 使用）
   * @returns {Array<object>}
   */
  getApprovedNodesConfig() {
    return this.store.findByStatus('approved')
      .filter(n => n.tunAddr)
      .map(n => ({
        id: n.id,
        name: n.name || n.id,
        tunAddr: n.tunAddr,
        sshPort: n.sshPort || 22,
        sshUser: n.sshUser || 'synon',
        sshKeyPath: this.privateKeyPath,
        gnbNodeId: n.gnbNodeId,
        netmask: n.netmask,
        gnbMapPath: n.gnbMapPath,
        gnbCtlPath: n.gnbCtlPath,
        clawToken: n.clawToken || '',
        clawPort: n.clawPort || 18789,
      }));
  }

  /**
   * 更新节点的 OpenClaw 配置（token + port）
   * @param {string} nodeId
   * @param {object} clawConfig - { token, port }
   */
  updateNodeClawConfig(nodeId, { token, port }) {
    const node = this.store.findById(nodeId);
    if (!node) return false;
    this.store.update(nodeId, {
      clawToken: token || node.clawToken,
      clawPort: port || node.clawPort,
    });
    console.log(`[KeyManager] 节点 ${nodeId} OpenClaw 配置已更新 (token: ${token ? token.substring(0, 8) + '...' : 'none'})`);
    return true;
  }

  // @alpha V2: _save/_backup/_loadWithRecovery 已移除，由 SQLite (NodeStore) 接管持久化
}

module.exports = KeyManager;
