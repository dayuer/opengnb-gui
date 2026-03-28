'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { resolvePaths, ensureDataDirs } = require('./data-paths');
const NodeStore = require('./node-store');
const GnbConfig = require('./gnb-config');
const { createLogger } = require('./logger');
const log = createLogger('KeyManager');

// @alpha: passcode 有效期（毫秒）
const PASSCODE_TTL_MS = 30 * 60 * 1000; // 30 分钟

// @alpha: 平台自动生成 NodeID — 12 位 URL-safe 随机字符
function generateNodeId() {
  return 'node-' + crypto.randomBytes(9).toString('base64url');
}
import type { FieldValidationResult, NodeRecord, GroupRecord } from '../types/interfaces';

/** 构造函数选项 */
interface KmOptions {
  dataDir?: string;
  paths?: ReturnType<typeof resolvePaths>;
}

/** Passcode 条目 */
interface PasscodeEntry {
  label: string;
  userId: string;
  createdAt: string;
  used: boolean;
  usedBy?: string;
}

/** EnrollToken 条目 */
interface EnrollTokenEntry {
  nodeId: string;
  createdAt: string;
}

/** 节点注册信息 */
interface EnrollmentInfo {
  passcode: string;
  id?: string;
  name?: string;
  tunAddr?: string;
  gnbMapPath?: string;
  gnbCtlPath?: string;
  [key: string]: unknown;
}

/** SSH 连接信息 */
interface SshInfo {
  sshUser?: string;
  sshPort?: number;
}

/** 过滤查询选项 */
interface FilterOpts {
  groupId?: string;
  status?: string;
  keyword?: string;
  subnet?: string;
  page?: string | number;
  pageSize?: string | number;
}

// --- updateNode 字段校验器 ---
// 每个校验器签名: (raw, nodeId, store) => FieldValidationResult
const FIELD_VALIDATORS: Record<string, (raw: unknown, nodeId: string, store: { isTunAddrTaken: (ip: string, excludeId: string) => { name?: string; id: string } | undefined }) => FieldValidationResult> = {
  name(raw) {
    const name = String(raw).trim();
    if (!name) return { value: raw, error: 'name 不能为空' };
    if (name.length > 64) return { value: raw, error: 'name 最长 64 字符' };
    return { value: name };
  },
  tunAddr(raw, nodeId, store) {
    const ip = String(raw).trim();
    if (!ip) return { value: raw, error: 'tunAddr 不能为空' };
    const ipv4Re = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const m = ip.match(ipv4Re);
    if (!m || [m[1], m[2], m[3], m[4]].some(o => +o > 255)) {
      return { value: raw, error: `IP 格式错误: ${ip}` };
    }
    const dup = store.isTunAddrTaken(ip, nodeId);
    if (dup) return { value: ip, error: `IP ${ip} 已被节点 ${dup.name || dup.id} 使用`, code: 'CONFLICT' };
    return { value: ip };
  },
  sshPort(raw) {
    const port = parseInt(String(raw), 10);
    if (isNaN(port) || port < 1 || port > 65535) return { value: raw, error: '端口范围 1-65535' };
    return { value: port };
  },
  sshUser(raw) {
    const user = String(raw).trim();
    if (!user) return { value: raw, error: 'sshUser 不能为空' };
    return { value: user };
  },
};

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
  dataDir: string;
  keyDir: string;
  privateKeyPath: string;
  publicKeyPath: string;
  gnbNodeId: string;
  gnbConfDir: string;
  gnbTunAddr: string;
  gnbTunSubnet: string;
  gnbIndexAddr: string;
  gnbNetmask: string;
  store: InstanceType<typeof NodeStore>;
  _gnb: InstanceType<typeof GnbConfig>;
  passcodes: Map<string, PasscodeEntry>;
  enrollTokens: Map<string, EnrollTokenEntry>;
  onApproval: Function | null;
  onNodeReady: Function | null;
  onChange: Function | null;
  onNodeUpdate: Function | null;
  onRouteUpdate: ((nodeId: string, addressConf: string) => void) | null;

  /**
   * @param {object} options
   * @param {string} options.dataDir - 数据目录
   */
  constructor(options: KmOptions = {}) {
    this.dataDir = options.dataDir || path.resolve(__dirname, '../../data');

    // @alpha: 使用集中路径管理
    const paths = options.paths || resolvePaths(this.dataDir);
    this.keyDir = paths.security.sshDir;
    this.privateKeyPath = paths.security.privateKey;
    this.publicKeyPath = paths.security.publicKey;

    // GNB 配置路径（Console 节点）
    this.gnbNodeId = process.env.GNB_NODE_ID || '1001';
    this.gnbConfDir = process.env.GNB_CONF_DIR || `/opt/gnb/conf/${this.gnbNodeId}`;
    this.gnbTunAddr = process.env.GNB_TUN_ADDR || '192.168.100.1';
    this.gnbTunSubnet = process.env.GNB_TUN_SUBNET || '192.168.100.0/16';
    this.gnbIndexAddr = process.env.GNB_INDEX_ADDR || '';

    // @alpha V2: SQLite 存储层
    this.store = new NodeStore(paths.registry.nodesDb);

    // GNB 配置管理（委托）
    this._gnb = new GnbConfig({
      gnbNodeId: this.gnbNodeId,
      gnbConfDir: this.gnbConfDir,
      gnbTunAddr: this.gnbTunAddr,
      gnbIndexAddr: this.gnbIndexAddr,
      gnbTunSubnet: this.gnbTunSubnet,
      store: this.store,
    });

    // 暴露掩码属性（为 enroll 接口提供）
    this.gnbNetmask = this._gnb._subnetMask;

    /** @type {Map<string, {passcode: string, createdAt: string, used: boolean}>} */
    this.passcodes = new Map();

    // @alpha: enrollToken 存储 — token → {nodeId, createdAt}
    /** @type {Map<string, {nodeId: string, createdAt: string}>} */
    this.enrollTokens = new Map();

    /** @type {Function|null} 审批回调 */
    this.onApproval = null;
    /** @type {Function|null} 节点就绪回调（触发 Provisioner） */
    this.onNodeReady = null;
    /** @type {Function|null} 节点列表变更回调（WS 广播） */
    this.onChange = null;
    /** @type {Function|null} 节点更新回调 */
    this.onNodeUpdate = null;
    /**
     * 节点审批或 IP 变更时回调——向 daemon 广播最新 address.conf
     * 由 server.ts 接线 wsHandlers.sendToDaemon
     */
    this.onRouteUpdate = null;
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
      log.info('已生成新的 ED25519 密钥对');
    } else {
      log.info('已加载现有密钥对');
    }

    // @alpha V2: 初始化 SQLite 存储
    this.store.init();

    const approved = this.store.countByStatus('approved');
    const pending = this.store.countByStatus('pending');
    const groupCount = this.store.allGroups().length;
    log.info(`${approved} 个已审批节点, ${pending} 个待审批, ${groupCount} 个分组 (SQLite)`);
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
  generatePasscode(label = '', userId = '') {
    const passcode = crypto.randomBytes(16).toString('hex');
    this.passcodes.set(passcode, { label, userId, createdAt: new Date().toISOString(), used: false });
    return passcode;
  }

  /**
   * 节点提交注册申请（需携带有效 passcode）
   * @param {object} nodeInfo - {passcode, id, name, tunAddr, gnbMapPath, gnbCtlPath}
   * @returns {{success: boolean, status: string, message: string}}
   */
  submitEnrollment(nodeInfo: EnrollmentInfo) {
    // @alpha: 用户提交的 id 实际是 hostname，平台自动生成唯一 NodeID
    const submittedName = nodeInfo.id || nodeInfo.name || '';
    if (!submittedName) {
      return { success: false, status: 'error', message: '缺少节点名称' };
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
    // @alpha: passcode TTL 校验
    if (Date.now() - new Date(pc.createdAt).getTime() > PASSCODE_TTL_MS) {
      return { success: false, status: 'error', message: 'passcode 已过期' };
    }

    // 标记 passcode 已用
    pc.used = true;
    pc.usedBy = submittedName;

    // @alpha: 查找是否已有同名节点（按 name 或旧式 id 匹配）
    const existing = this.store.findById(submittedName) || this.store.findByName?.(submittedName);
    if (existing) {
      const enrollToken = this._issueEnrollToken(existing.id);
      if (existing.status === 'approved') {
        return { success: true, status: 'approved', nodeId: existing.id, message: '节点已通过审批', enrollToken };
      }
      if (existing.status === 'pending') {
        const updates = { name: submittedName, updatedAt: new Date().toISOString() };
        this.store.update(existing.id, updates);
        return { success: true, status: 'pending', nodeId: existing.id, message: '注册信息已更新，等待管理员审批', enrollToken };
      }
    }

    // @alpha: 平台生成唯一 NodeID
    const nodeId = generateNodeId();
    const enrollToken = this._issueEnrollToken(nodeId);

    const record = { ...nodeInfo };
    delete record.passcode;

    this.store.insert({
      ...record,
      id: nodeId,
      name: submittedName,
      tunAddr: record.tunAddr || '',
      sshUser: 'synon',
      sshPort: 22,
      gnbMapPath: record.gnbMapPath || `/opt/gnb/conf/${nodeId}/gnb.map`,
      gnbCtlPath: record.gnbCtlPath || 'gnb_ctl',
      status: 'pending',
      ready: false,
      ownerId: pc.userId || '',
      submittedAt: new Date().toISOString(),
      approvedAt: null,
    });

    // @alpha: 通知前端新节点注册
    if (this.onChange) this.onChange('enroll', nodeId);

    return { success: true, status: 'pending', nodeId, message: '注册申请已提交，等待管理员审批', enrollToken };
  }

  // @alpha: 签发 enrollToken — 128-bit 随机，绑定 nodeId
  /** @private */
  _issueEnrollToken(nodeId: string) {
    const token = crypto.randomBytes(16).toString('hex');
    this.enrollTokens.set(token, { nodeId, createdAt: new Date().toISOString() });
    return token;
  }

  /**
   * 验证 enrollToken（40 分钟过期）
   * @param {string} token
   * @returns {{valid: boolean, nodeId?: string}}
   */
  verifyEnrollToken(token: string) {
    if (!token) return { valid: false };
    const entry = this.enrollTokens.get(token);
    if (!entry) return { valid: false };
    // @security: enrollToken TTL 校验（安全审计 M2 修复）
    const ENROLL_TOKEN_TTL_MS = 40 * 60 * 1000; // 40 分钟（略长于 passcode 30min，免得初始化中途过期）
    if (Date.now() - new Date(entry.createdAt).getTime() > ENROLL_TOKEN_TTL_MS) {
      this.enrollTokens.delete(token);
      return { valid: false };
    }
    return { valid: true, nodeId: entry.nodeId };
  }

  /**
   * 节点标记为就绪（synon 已创建、公钥已部署）
   * @param {string} nodeId
   * @param {object} sshInfo - {sshUser, sshPort}
   */
  markNodeReady(nodeId: string, sshInfo: SshInfo = {}) {
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
      const config = this.getApprovedNodesConfig().find((n) => n.id === nodeId);
      if (config) this.onNodeReady(config);
    }

    return { success: true, message: `节点 ${nodeId} 已就绪，Console 将开始远程配置` };
  }

  /**
   * 管理员审批通过（自动分配 IP + GNB 节点 ID）
   * @param {string} nodeId
   * @returns {{success: boolean, message: string}}
   */
  approveNode(nodeId: string, options: { tunAddr?: string; gnbNodeId?: string } = {}) {
    const node = this.store.findById(nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    if (node.status === 'approved') return { success: true, message: '已审批', tunAddr: node.tunAddr };

    // 分配 TUN 地址：优先手动指定，否则自动分配
    const tunAddr = options.tunAddr || node.tunAddr || this._gnb.nextAvailableIp();
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
    this._gnb.updateGnbConfig(updated);

    if (this.onApproval) this.onApproval(this.getApprovedNodesConfig());
    if (this.onChange) this.onChange('approve', nodeId);

    // 广播最新地址表到所有在线 daemon
    if (this.onRouteUpdate) {
      const addressConf = this._gnb.generateFullAddressConf();
      this.onRouteUpdate(nodeId, addressConf);
    }

    return { success: true, message: `节点 ${nodeId} 已通过审批`, tunAddr: updated.tunAddr, gnbNodeId: updated.gnbNodeId };
  }

  // ═══════════════════════════════════════
  // GNB 配置管理（委托给 GnbConfig）
  // ═══════════════════════════════════════
  generateFullAddressConf() { return this._gnb.generateFullAddressConf(); }
  getGnbPublicKey() { return this._gnb.getGnbPublicKey(); }
  saveNodeGnbPubkey(nodeId: string, pubKey: string) { return this._gnb.saveNodeGnbPubkey(nodeId, pubKey); }

  /**
   * 管理员拒绝
   * @param {string} nodeId
   */
  rejectNode(nodeId: string) {
    const node = this.store.findById(nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    this.store.remove(nodeId);
    this._gnb.writeFullGnbConf(); // 同步 address.conf
    if (this.onChange) this.onChange('reject', nodeId);
    return { success: true, message: `节点 ${nodeId} 已拒绝并删除` };
  }

  /**
   * 删除节点
   * @param {string} nodeId
   */
  removeNode(nodeId: string) {
    this.store.remove(nodeId);
    this._gnb.writeFullGnbConf(); // 同步 address.conf
    if (this.onChange) this.onChange('remove', nodeId);
    return { success: true, message: `节点 ${nodeId} 已删除` };
  }

  // ═══════════════════════════════════════
  // @alpha: 节点信息编辑
  // ═══════════════════════════════════════

  /** @private IPv4 格式校验 */
  static _isValidIPv4(ip: string) {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every((p: string) => {
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
  updateNode(nodeId: string, fields: Partial<NodeRecord> = {}) {
    const node = this.store.findById(nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    if (node.status !== 'approved') return { success: false, message: '仅已审批节点可编辑' };

    const allowed = ['name', 'tunAddr', 'sshPort', 'sshUser'];

    // 数据驱动校验 — 每个字段对应一个 (value, nodeId, store) => { value, error? } 的校验器
    for (const key of allowed) {
      if (fields[key] === undefined) continue;
      const validator = FIELD_VALIDATORS[key];
      if (!validator) continue;
      const result = validator(fields[key], nodeId, this.store);
      if (result.error) return { success: false, message: result.error, code: result.code };
      fields[key] = result.value;
    }

    // 检测变更
    const changedFields = allowed.filter(key =>
      fields[key] !== undefined && node[key] !== fields[key]
    );
    if (changedFields.length === 0) return { success: true, message: '无变更', changedFields: [] };

    // 应用变更到 SQLite
    const updateFields: Partial<NodeRecord & { updatedAt: string }> = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) updateFields[key] = fields[key];
    }
    updateFields.updatedAt = new Date().toISOString();
    this.store.update(nodeId, updateFields);

    // tunAddr 变更时同步 GNB 配置 + 广播 route_update
    if (changedFields.includes('tunAddr')) {
      const updatedNode = this.store.findById(nodeId);
      if (updatedNode && updatedNode.gnbNodeId) this._gnb.updateGnbAddressConf(updatedNode);
      if (this.onRouteUpdate) {
        const addressConf = this._gnb.generateFullAddressConf();
        this.onRouteUpdate(nodeId, addressConf);
      }
    }

    // 触发更新回调
    if (this.onNodeUpdate) this.onNodeUpdate(nodeId, changedFields);

    return { success: true, message: `节点 ${nodeId} 已更新`, changedFields };
  }

  /**
   * @alpha: 更新节点的 skills 清单（用于面板展示）
   * @param {string} nodeId
   * @param {Array} skillsArray
   */
  updateNodeSkills(nodeId: string, skillsArray: unknown[]) {
    const node = this.store.findById(nodeId);
    if (!node) return { success: false, message: '节点不存在' };
    this.store.update(nodeId, { skills: skillsArray });
    if (this.onNodeUpdate) this.onNodeUpdate(nodeId, ['skills']);
    return { success: true, message: '技能列表已持久化' };
  }



  /**
   * 获取全部节点（含状态）
   */
  getAllNodes() { return this.store.all(); }



  /**
   * @alpha: 按 ownerId 获取节点（用户隔离）
   * @param {string} ownerId
   */
  getNodesByOwner(ownerId: string) {
    if (!ownerId) return this.store.all();
    // 空 ownerId 节点（旧数据）对所有用户可见
    return this.store.all().filter((n: NodeRecord) => !n.ownerId || n.ownerId === ownerId);
  }

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
  createGroup({ name, color = '#388bfd' }: { name: string; color?: string }) {
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
    return this.store.allGroups().map((g: GroupRecord) => ({
      ...g,
      nodeCount: this.store.countNodesByGroup(g.id),
    }));
  }

  /**
   * 更新分组
   * @param {string} groupId
   * @param {{name?: string, color?: string}} updates
   */
  updateGroup(groupId: string, updates: Partial<GroupRecord>) {
    const ok = this.store.updateGroupFields(groupId, updates);
    if (!ok) return { success: false, message: '分组不存在' };
    return { success: true };
  }

  /**
   * 删除分组（事务：原子清空关联节点 groupId + 删除分组）
   * @param {string} groupId
   */
  deleteGroup(groupId: string) {
    this.store.removeGroup(groupId);
    return { success: true };
  }

  /**
   * 修改节点所属分组
   * @param {string} nodeId
   * @param {string|null} groupId
   */
  updateNodeGroup(nodeId: string, groupId: string | null) {
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
  getFilteredNodes(opts: FilterOpts = {}) {
    let result = this.store.all();

    if (opts.groupId) result = result.filter((n: NodeRecord) => n.groupId === opts.groupId);
    if (opts.status) result = result.filter((n: NodeRecord) => n.status === opts.status);
    if (opts.keyword) {
      const kw = opts.keyword.toLowerCase();
      result = result.filter((n: NodeRecord) =>
        (n.name || '').toLowerCase().includes(kw) ||
        (n.id || '').toLowerCase().includes(kw) ||
        (n.tunAddr || '').toLowerCase().includes(kw)
      );
    }
    if (opts.subnet) result = result.filter((n: NodeRecord) => n.tunAddr && KeyManager._cidrMatch(n.tunAddr, opts.subnet));

    const total = result.length;
    const page = Math.max(1, parseInt(String(opts.page), 10) || 1);
    const pageSize = Math.max(1, parseInt(String(opts.pageSize), 10) || 50);
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
  batchApprove(ids: string[]) { return this._batchAction(ids, (id: string) => this.approveNode(id)); }

  /**
   * 批量拒绝
   * @param {string[]} ids
   */
  batchReject(ids: string[]) { return this._batchAction(ids, (id: string) => this.rejectNode(id)); }

  /**
   * 批量删除
   * @param {string[]} ids
   */
  batchRemove(ids: string[]) { return this._batchAction(ids, (id: string) => this.removeNode(id)); }

  /** @private 批量操作通用 */
  _batchAction(ids: string[], action: (id: string) => { success: boolean; message?: string }) {
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
  static _cidrMatch(ip: string, cidr: string) {
    const [range, bits] = cidr.split('/');
    if (!range || !bits) return false;
    const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1) >>> 0;
    return (KeyManager._ipToInt(ip) & mask) === (KeyManager._ipToInt(range) & mask);
  }

  /** @private IP 字符串转 32 位整数 */
  static _ipToInt(ip: string) {
    return ip.split('.').reduce((acc: number, oct: string) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
  }


  /**
   * 获取已审批节点的 SSH 配置（供 Monitor 使用）
   * @returns {Array<object>}
   */
  getApprovedNodesConfig() {
    return this.store.findByStatus('approved')
      .filter((n: NodeRecord) => n.tunAddr)
      .map((n: NodeRecord) => ({
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
        groupId: n.groupId || '',
        skills: n.skills || [],
      }));
  }

  /**
   * 更新节点的 OpenClaw 配置（token + port）
   * @param {string} nodeId
   * @param {object} clawConfig - { token, port }
   */
  updateNodeClawConfig(nodeId: string, { token, port }: { token?: string; port?: number }) {
    const node = this.store.findById(nodeId);
    if (!node) return false;
    this.store.update(nodeId, {
      clawToken: token || node.clawToken,
      clawPort: port || node.clawPort,
    });
    log.info(`节点 ${nodeId} OpenClaw 配置已更新 (token: ${token ? token.substring(0, 8) + '...' : 'none'})`);
    return true;
  }

  // @alpha V2: _save/_backup/_loadWithRecovery 已移除，由 SQLite (NodeStore) 接管持久化

  /**
   * 密钥滚动更新 — 两阶段广播，零中断
   *
   * Phase 1: 向所有在线 daemon 追加新公钥
   * Phase 2: Console 切换私钥 → 向所有在线 daemon 删除旧公钥
   * 离线节点: 写 pubkeyRotationPending=1，重连时补发
   */
  async rotateKeyPair(
    wsHandlers: { sendToDaemon: Function; daemonConns: Map<string, unknown> },
    sshManager: { closeAll: () => void }
  ) {
    log.info('密钥轮换开始...');

    const oldPubKey = this.getPublicKey();

    // 备份旧密钥（用于 Phase 2 识别 + 回滚）
    const backupTs = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const backupPrivate = `${this.privateKeyPath}.bak-${backupTs}`;
    const backupPublic = `${this.publicKeyPath}.bak-${backupTs}`;
    fs.copyFileSync(this.privateKeyPath, backupPrivate);
    fs.copyFileSync(this.publicKeyPath, backupPublic);

    // 直接覆盖原文件名生成新密钥对
    try {
      fs.unlinkSync(this.privateKeyPath);
      fs.unlinkSync(this.publicKeyPath);
    } catch { /* 忽略 */ }

    try {
      execSync(`ssh-keygen -t ed25519 -f "${this.privateKeyPath}" -N "" -C "gnb-console-rotated-${Date.now()}"`, { stdio: 'pipe' });
    } catch {
      const { generateKeyPairSync } = crypto;
      const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      fs.writeFileSync(this.privateKeyPath, privateKey, { mode: 0o600 });
      fs.writeFileSync(this.publicKeyPath, publicKey);
    }
    const newPubKey = fs.readFileSync(this.publicKeyPath, 'utf-8').trim();
    log.info(`新公钥已生成: ${newPubKey.slice(0, 40)}...`);

    const onlineDaemons = Array.from(wsHandlers.daemonConns.keys() as IterableIterator<string>);
    const allApproved = this.store.findByStatus('approved') as any[];

    // Phase 1: 追加新公钥到所有在线 daemon
    if (onlineDaemons.length > 0) {
      const reqId = `keyrot-p1-${Date.now()}`;
      const results = await Promise.allSettled(onlineDaemons.map((id: string) =>
        wsHandlers.sendToDaemon(id, { type: 'key_rotate', reqId, newPubkey: newPubKey }, 20000)
      ));
      results.forEach((r: PromiseSettledResult<unknown>, i: number) => {
        if (r.status === 'rejected') log.warn(`Phase1 daemon ${onlineDaemons[i]} 失败: ${(r as PromiseRejectedResult).reason?.message}`);
      });
    }

    // 离线节点标记 pending（等待重连后补发）
    const offlineIds = allApproved
      .filter((n: any) => !wsHandlers.daemonConns.has(n.id))
      .map((n: any) => n.id);
    for (const id of offlineIds) {
      this.store.update(id, { pubkeyRotationPending: 1 });
    }
    if (offlineIds.length > 0) log.info(`${offlineIds.length} 个离线节点已标记 pending`);

    // Console 已切换到新私钥（文件已原地覆盖），重置 SSH 连接池
    sshManager.closeAll();
    log.info('Console 已切换到新私钥，SSH 连接池已重置');

    // Phase 2: 删除旧公钥
    if (onlineDaemons.length > 0) {
      const reqId = `keyrot-p2-${Date.now()}`;
      await Promise.allSettled(onlineDaemons.map((id: string) =>
        wsHandlers.sendToDaemon(id, {
          type: 'key_rotate', reqId,
          newPubkey: newPubKey,
          removeOldPubkey: oldPubKey,
        }, 20000)
      ));
    }

    // 清理备份文件（轮换成功后）
    try { fs.unlinkSync(backupPrivate); } catch { /* ignore */ }
    try { fs.unlinkSync(backupPublic); } catch { /* ignore */ }

    log.info(`密钥轮换完成: ${onlineDaemons.length} 在线已同步, ${offlineIds.length} 离线待同步`);
    return { onlineCount: onlineDaemons.length, pendingCount: offlineIds.length };
  }

  /** 标记节点密钥已同步（daemon 重连后补发成功时调用） */
  markKeyRotationSynced(nodeId: string) {
    this.store.update(nodeId, { pubkeyRotationPending: 0 });
  }

  /** 获取需要补发新公钥的离线节点列表 */
  getPendingRotationNodes(): string[] {
    return (this.store.all() as any[])
      .filter((n: any) => n.pubkeyRotationPending === 1)
      .map((n: any) => n.id);
  }
}

module.exports = KeyManager;
export {}; // CJS 模块标记
