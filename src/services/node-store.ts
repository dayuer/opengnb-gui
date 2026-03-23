'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { createLogger } = require('./logger');
const log = createLogger('NodeStore');

/**
 * SQLite 节点存储层
 * @alpha: V2 重构 — SQLite 为唯一数据源
 *
 * 设计原则：
 *   - better-sqlite3 同步 API，与 Node.js 单线程模型天然匹配
 *   - 所有写操作自带事务，并发安全
 *   - 对外暴露与原 this.nodes 数组兼容的接口
 */
class NodeStore {
  dbPath: string;
  db: any;
  _stmts: any;

  /**
   * @param {string} dbPath - SQLite 数据库文件路径
   */
  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * 初始化数据库（建表）
   * @param {Array} [existingNodes] - 可选的种子节点数据
   */
  init(existingNodes: any[] = []) {
    // 确保目录存在
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    // 性能优化
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this._createTables();
    this._prepareStatements();

    // 迁移：如果 DB 为空且有历史数据
    if (existingNodes.length > 0 && this.count() === 0) {
      this._migrateFromJson(existingNodes);
    }

    // @alpha: 迁移旧式 hostname-based ID → 平台生成 ID
    this._migrateNodeIds();
  }

  /** @private 建表 */
  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT,
        tunAddr TEXT DEFAULT '',
        gnbNodeId TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        sshUser TEXT DEFAULT 'synon',
        sshPort INTEGER DEFAULT 22,
        netmask TEXT DEFAULT '255.0.0.0',
        groupId TEXT DEFAULT '',
        clawToken TEXT DEFAULT '',
        clawPort INTEGER DEFAULT 18789,
        gnbMapPath TEXT DEFAULT '',
        gnbCtlPath TEXT DEFAULT '',
        ready INTEGER DEFAULT 0,
        ownerId TEXT DEFAULT '',
        skills TEXT DEFAULT '[]',
        submittedAt TEXT,
        approvedAt TEXT,
        updatedAt TEXT,
        readyAt TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tunAddr
        ON nodes(tunAddr) WHERE tunAddr != '';
      CREATE INDEX IF NOT EXISTS idx_status ON nodes(status);
      CREATE INDEX IF NOT EXISTS idx_groupId ON nodes(groupId);

      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT DEFAULT '#388bfd',
        createdAt TEXT
      );

      CREATE TABLE IF NOT EXISTS metrics (
        nodeId TEXT NOT NULL,
        ts INTEGER NOT NULL,
        cpu INTEGER DEFAULT 0,
        memPct INTEGER DEFAULT 0,
        diskPct INTEGER DEFAULT 0,
        sshLatency INTEGER DEFAULT 0,
        loadAvg TEXT DEFAULT '0',
        p2pDirect INTEGER DEFAULT 0,
        p2pTotal INTEGER DEFAULT 0,
        memTotalMB INTEGER DEFAULT 0,
        memUsedMB INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_node_ts ON metrics(nodeId, ts);

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT DEFAULT 'system',
        detail_json TEXT DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts_action ON audit_logs(ts, action);

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        passwordHash TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        apiToken TEXT DEFAULT '',
        createdAt TEXT
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        nodeId TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT DEFAULT 'dispatched',
        exitCode INTEGER,
        stdout TEXT,
        stderr TEXT,
        error TEXT,
        createdAt TEXT NOT NULL,
        completedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_node ON jobs(nodeId);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(createdAt);
    `);

    // @alpha: 向后兼容迁移 — 旧 db 的 users 表可能缺少 apiToken 列
    try {
      this.db.exec(`ALTER TABLE users ADD COLUMN apiToken TEXT DEFAULT ''`);
    } catch { /* 列已存在，忽略 */ }

    // @alpha: 向后兼容迁移 — 旧 db 的 nodes 表可能缺少 ownerId 列
    try {
      this.db.exec(`ALTER TABLE nodes ADD COLUMN ownerId TEXT DEFAULT ''`);
    } catch { /* 列已存在，忽略 */ }

    // @alpha: 向后兼容迁移 — 旧 db 的 nodes 表可能缺少 skills 列
    try {
      this.db.exec(`ALTER TABLE nodes ADD COLUMN skills TEXT DEFAULT '[]'`);
    } catch { /* 列已存在，忽略 */ }
  }

  /** @private 预编译常用语句 */
  _prepareStatements() {
    this._stmts = {
      findById: this.db.prepare('SELECT * FROM nodes WHERE id = ?'),
      findByName: this.db.prepare('SELECT * FROM nodes WHERE name = ? LIMIT 1'),
      findByStatus: this.db.prepare('SELECT * FROM nodes WHERE status = ?'),
      all: this.db.prepare('SELECT * FROM nodes'),
      count: this.db.prepare('SELECT COUNT(*) AS cnt FROM nodes'),
      countByStatus: this.db.prepare('SELECT COUNT(*) AS cnt FROM nodes WHERE status = ?'),
      insert: this.db.prepare(`
        INSERT OR REPLACE INTO nodes
        (id, name, tunAddr, gnbNodeId, status, sshUser, sshPort, netmask,
         groupId, clawToken, clawPort, gnbMapPath, gnbCtlPath, ready,
         ownerId, skills, submittedAt, approvedAt, updatedAt, readyAt)
        VALUES
        (@id, @name, @tunAddr, @gnbNodeId, @status, @sshUser, @sshPort, @netmask,
         @groupId, @clawToken, @clawPort, @gnbMapPath, @gnbCtlPath, @ready,
         @ownerId, @skills, @submittedAt, @approvedAt, @updatedAt, @readyAt)
      `),
      remove: this.db.prepare('DELETE FROM nodes WHERE id = ?'),
      findByTunAddr: this.db.prepare('SELECT * FROM nodes WHERE tunAddr = ? AND id != ?'),
      allTunAddrs: this.db.prepare("SELECT tunAddr FROM nodes WHERE tunAddr != ''"),
      approvedWithGnb: this.db.prepare(
        "SELECT * FROM nodes WHERE status = 'approved' AND gnbNodeId != '' AND tunAddr != ''"
      ),
      // 分组
      allGroups: this.db.prepare('SELECT * FROM groups ORDER BY createdAt'),
      findGroupById: this.db.prepare('SELECT * FROM groups WHERE id = ?'),
      findGroupByName: this.db.prepare('SELECT * FROM groups WHERE name = ?'),
      insertGroup: this.db.prepare(
        'INSERT INTO groups (id, name, color, createdAt) VALUES (@id, @name, @color, @createdAt)'
      ),
      updateGroupStmt: this.db.prepare('UPDATE groups SET name = @name, color = @color WHERE id = @id'),
      removeGroupStmt: this.db.prepare('DELETE FROM groups WHERE id = ?'),
      clearGroupId: this.db.prepare("UPDATE nodes SET groupId = '' WHERE groupId = ?"),
      countNodesByGroup: this.db.prepare('SELECT COUNT(*) AS cnt FROM nodes WHERE groupId = ?'),
      // 指标
      recordMetric: this.db.prepare(`
        INSERT INTO metrics (nodeId, ts, cpu, memPct, diskPct, sshLatency, loadAvg, p2pDirect, p2pTotal, memTotalMB, memUsedMB)
        VALUES (@nodeId, @ts, @cpu, @memPct, @diskPct, @sshLatency, @loadAvg, @p2pDirect, @p2pTotal, @memTotalMB, @memUsedMB)
      `),
      queryMetrics: this.db.prepare('SELECT * FROM metrics WHERE nodeId = ? AND ts >= ? ORDER BY ts'),
      deleteMetricsBefore: this.db.prepare('DELETE FROM metrics WHERE ts < ?'),
      deleteNodeMetricsBefore: this.db.prepare('DELETE FROM metrics WHERE nodeId = ? AND ts < ?'),
      latestMetricPerNode: this.db.prepare(`
        SELECT m.* FROM metrics m
        INNER JOIN (SELECT nodeId, MAX(ts) AS maxTs FROM metrics GROUP BY nodeId) latest
        ON m.nodeId = latest.nodeId AND m.ts = latest.maxTs
      `),
      metricsCount: this.db.prepare('SELECT COUNT(*) AS cnt FROM metrics'),
      metricsCountByNode: this.db.prepare('SELECT COUNT(*) AS cnt FROM metrics WHERE nodeId = ?'),
      oldestMetrics: this.db.prepare('SELECT MIN(ts) AS oldest FROM metrics'),
      // 审计日志
      insertAudit: this.db.prepare(
        'INSERT INTO audit_logs (ts, action, actor, detail_json) VALUES (@ts, @action, @actor, @detailJson)'
      ),
      auditCount: this.db.prepare('SELECT COUNT(*) AS cnt FROM audit_logs'),
      deleteAuditBefore: this.db.prepare('DELETE FROM audit_logs WHERE ts < ?'),
      queryAudit: this.db.prepare(
        'SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?'
      ),
      queryAuditByAction: this.db.prepare(
        'SELECT * FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT ? OFFSET ?'
      ),
      // 用户
      insertUser: this.db.prepare(
        'INSERT INTO users (id, username, passwordHash, role, createdAt) VALUES (@id, @username, @passwordHash, @role, @createdAt)'
      ),
      findUserByName: this.db.prepare('SELECT * FROM users WHERE username = ?'),
      findUserById: this.db.prepare('SELECT * FROM users WHERE id = ?'),
      findUserByApiToken: this.db.prepare('SELECT * FROM users WHERE apiToken = ?'),
      allUsers: this.db.prepare('SELECT id, username, role, apiToken, createdAt FROM users ORDER BY createdAt'),
      removeUser: this.db.prepare('DELETE FROM users WHERE id = ?'),
      userCount: this.db.prepare('SELECT COUNT(*) AS cnt FROM users'),
      updateApiToken: this.db.prepare('UPDATE users SET apiToken = ? WHERE id = ?'),
      updatePassword: this.db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?'),
      updateUserRole: this.db.prepare('UPDATE users SET role = ? WHERE id = ?'),
      // @alpha: 异步 job
      insertJob: this.db.prepare(
        `INSERT INTO jobs (id, nodeId, command, status, createdAt)
         VALUES (@id, @nodeId, @command, @status, @createdAt)`
      ),
      findJob: this.db.prepare('SELECT * FROM jobs WHERE id = ?'),
      updateJobResult: this.db.prepare(
        `UPDATE jobs SET status = @status, exitCode = @exitCode,
         stdout = @stdout, stderr = @stderr, error = @error,
         completedAt = @completedAt WHERE id = @id`
      ),
      jobsByNode: this.db.prepare(
        'SELECT * FROM jobs WHERE nodeId = ? ORDER BY createdAt DESC LIMIT ?'
      ),
      recentJobs: this.db.prepare(
        'SELECT * FROM jobs ORDER BY createdAt DESC LIMIT ?'
      ),
      deleteJobsBefore: this.db.prepare('DELETE FROM jobs WHERE createdAt < ?'),
    };
  }

  /**
   * 从 JSON 数组迁移数据
   * @private
   */
  _migrateFromJson(nodes: any) {
    const insertMany = this.db.transaction((items: any) => {
      for (const n of items) {
        this._stmts.insert.run(this._toRow(n));
      }
    });
    insertMany(nodes);
    log.info(`已从 JSON 迁移 ${nodes.length} 个节点`);
  }

  /**
   * @alpha: 将旧式 hostname-based ID 迁移为平台生成的唯一 ID
   * 规则：id 不以 'node-' 开头的节点需要迁移
   * @private
   */
  _migrateNodeIds() {
    const crypto = require('crypto');
    const oldNodes = this.db.prepare(
      "SELECT * FROM nodes WHERE id NOT LIKE 'node-%'"
    ).all();
    if (oldNodes.length === 0) return;

    log.info(`发现 ${oldNodes.length} 个旧式 ID 节点，开始迁移...`);
    const txn = this.db.transaction(() => {
      for (const node of oldNodes) {
        const newId = 'node-' + crypto.randomBytes(9).toString('base64url');
        const oldId = node.id;
        // 保留旧 id 为 name（如果 name 为空或等于 id）
        const name = (node.name && node.name !== oldId) ? node.name : oldId;

        // 更新 metrics 和 jobs 外键（在删除旧记录前）
        this.db.prepare('UPDATE metrics SET nodeId = ? WHERE nodeId = ?').run(newId, oldId);
        this.db.prepare('UPDATE jobs SET nodeId = ? WHERE nodeId = ?').run(newId, oldId);

        // 先删除旧记录（避免 tunAddr UNIQUE 约束冲突）
        this.db.prepare('DELETE FROM nodes WHERE id = ?').run(oldId);

        // 插入新 ID 记录
        this.db.prepare(`
          INSERT INTO nodes (id, name, tunAddr, gnbNodeId, status, sshUser, sshPort,
            netmask, groupId, clawToken, clawPort, gnbMapPath, gnbCtlPath, ready,
            ownerId, skills, submittedAt, approvedAt, updatedAt, readyAt)
          VALUES (@id, @name, @tunAddr, @gnbNodeId, @status, @sshUser, @sshPort,
            @netmask, @groupId, @clawToken, @clawPort, @gnbMapPath, @gnbCtlPath, @ready,
            @ownerId, @skills, @submittedAt, @approvedAt, @updatedAt, @readyAt)
        `).run({
          ...node, id: newId, name, ready: node.ready ? 1 : 0, skills: node.skills || '[]', ownerId: node.ownerId || '',
        });

        log.info(`迁移: ${oldId} → ${newId} (name: ${name})`);
      }
    });
    txn();
    log.info('旧式 ID 迁移完成');
  }

  /**
   * 将节点对象规范化为数据库行
   * @private
   */
  _toRow(node: any) {
    return {
      id: node.id || '',
      name: node.name || node.id || '',
      tunAddr: node.tunAddr || '',
      gnbNodeId: node.gnbNodeId || '',
      status: node.status || 'pending',
      sshUser: node.sshUser || 'synon',
      sshPort: node.sshPort || 22,
      netmask: node.netmask || '255.0.0.0',
      groupId: node.groupId || '',
      clawToken: node.clawToken || '',
      clawPort: node.clawPort || 18789,
      gnbMapPath: node.gnbMapPath || '',
      gnbCtlPath: node.gnbCtlPath || '',
      ready: node.ready ? 1 : 0,
      ownerId: node.ownerId || '',
      skills: typeof node.skills === 'string' ? node.skills : JSON.stringify(node.skills || []),
      submittedAt: node.submittedAt || null,
      approvedAt: node.approvedAt || null,
      updatedAt: node.updatedAt || null,
      readyAt: node.readyAt || null,
    };
  }

  /**
   * 将数据库行转换为兼容的节点对象
   * @private
   */
  _fromRow(row: any) {
    if (!row) return null;
    return {
      ...row,
      ready: !!row.ready,
      skills: row.skills ? JSON.parse(row.skills) : []
    };
  }

  // ═══════════════════════════════════════
  // 查询接口
  // ═══════════════════════════════════════

  findById(id: any) {
    return this._fromRow(this._stmts.findById.get(id));
  }

  /** @alpha: 按 name 查找节点（用于重复注册匹配） */
  findByName(name: any) {
    return this._fromRow(this._stmts.findByName.get(name));
  }

  findByStatus(status: any) {
    return this._stmts.findByStatus.all(status).map((r: any) => this._fromRow(r));
  }

  all() {
    return this._stmts.all.all().map((r: any) => this._fromRow(r));
  }

  count() {
    return this._stmts.count.get().cnt;
  }

  countByStatus(status: any) {
    return this._stmts.countByStatus.get(status).cnt;
  }

  /**
   * 检查 tunAddr 是否已被其他节点占用
   */
  isTunAddrTaken(tunAddr: any, excludeNodeId = '') {
    const row = this._stmts.findByTunAddr.get(tunAddr, excludeNodeId);
    return row ? this._fromRow(row) : null;
  }

  /**
   * 获取所有已审批且有 GNB 配置的节点
   */
  approvedWithGnb() {
    return this._stmts.approvedWithGnb.all().map((r: any) => this._fromRow(r));
  }

  /**
   * 按条件过滤节点（分页支持）
   */
  filter({ status, groupId, keyword, page = 1, pageSize = 0 }: any = {}) {
    let sql = 'SELECT * FROM nodes WHERE 1=1';
    const params: any = {};
    if (status) { sql += ' AND status = @status'; params.status = status; }
    if (groupId) { sql += ' AND groupId = @groupId'; params.groupId = groupId; }
    if (keyword) {
      sql += ' AND (id LIKE @kw OR name LIKE @kw OR tunAddr LIKE @kw)';
      params.kw = `%${keyword}%`;
    }
    sql += ' ORDER BY submittedAt DESC';
    if (pageSize > 0) {
      sql += ' LIMIT @limit OFFSET @offset';
      params.limit = pageSize;
      params.offset = (page - 1) * pageSize;
    }
    return this.db.prepare(sql).all(params).map((r: any) => this._fromRow(r));
  }

  // ═══════════════════════════════════════
  // 写入接口
  // ═══════════════════════════════════════

  insert(node: any) {
    this._stmts.insert.run(this._toRow(node));
  }

  /**
   * 更新指定节点的字段
   * @param {string} id
   * @param {object} fields - 要更新的字段
   */
  update(id: any, fields: any) {
    const sets = [];
    const params: Record<string, any> = { id };
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'id') continue; // 不允许改 id
      sets.push(`${key} = @${key}`);
      // @fix: better-sqlite3 只接受 number|string|bigint|Buffer|null
      // 数组/对象必须 JSON 序列化，布尔必须转 0/1
      if (Array.isArray(val) || (val !== null && typeof val === 'object')) {
        params[key] = JSON.stringify(val);
      } else if (typeof val === 'boolean') {
        params[key] = val ? 1 : 0;
      } else {
        params[key] = val ?? null;
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  remove(id: any) {
    this._stmts.remove.run(id);
  }

  // ═══════════════════════════════════════
  // IP 分配
  // ═══════════════════════════════════════

  /**
   * 获取所有已分配的 TUN 地址
   * @returns {Set<string>}
   */
  allTunAddrs() {
    return new Set(this._stmts.allTunAddrs.all().map((r: any) => r.tunAddr));
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.db) this.db.close();
  }

  // ═══════════════════════════════════════
  // 分组 CRUD
  // ═══════════════════════════════════════

  /** 获取所有分组 */
  allGroups() {
    return this._stmts.allGroups.all();
  }

  /** 按 ID 查找分组 */
  findGroupById(id: any) {
    return this._stmts.findGroupById.get(id) || null;
  }

  /** 按名称查找分组（唯一性检查） */
  findGroupByName(name: any) {
    return this._stmts.findGroupByName.get(name) || null;
  }

  /** 插入分组 */
  insertGroup(group: any) {
    this._stmts.insertGroup.run(group);
  }

  /** 更新分组 */
  updateGroupFields(id: any, { name, color }: any) {
    const existing = this.findGroupById(id);
    if (!existing) return false;
    this._stmts.updateGroupStmt.run({
      id,
      name: name !== undefined ? name : existing.name,
      color: color !== undefined ? color : existing.color,
    });
    return true;
  }

  /**
   * 删除分组（事务：清空关联节点 groupId + 删除分组）
   */
  removeGroup(id: any) {
    const txn = this.db.transaction((groupId: any) => {
      this._stmts.clearGroupId.run(groupId);
      this._stmts.removeGroupStmt.run(groupId);
    });
    txn(id);
  }

  /** 获取分组内的节点数量 */
  countNodesByGroup(groupId: any) {
    return this._stmts.countNodesByGroup.get(groupId).cnt;
  }

  // ═══════════════════════════════════════
  // 指标时序
  // ═══════════════════════════════════════

  /** 记录一个指标数据点 */
  recordMetric(point: any) {
    this._stmts.recordMetric.run(point);
  }

  /** 批量记录指标（事务） */
  recordMetricsBatch(points: any) {
    const txn = this.db.transaction((items: any) => {
      for (const p of items) this._stmts.recordMetric.run(p);
    });
    txn(points);
  }

  /** 查询节点指标（ts >= sinceTs） */
  queryMetrics(nodeId: any, sinceTs: any) {
    return this._stmts.queryMetrics.all(nodeId, sinceTs);
  }

  /** 获取每个节点的最新数据点 */
  latestMetricPerNode() {
    return this._stmts.latestMetricPerNode.all();
  }

  /** 删除所有节点中早于 ts 的指标 */
  deleteMetricsBefore(ts: any) {
    return this._stmts.deleteMetricsBefore.run(ts);
  }

  /** 删除单个节点中早于 ts 的指标 */
  deleteNodeMetricsBefore(nodeId: any, ts: any) {
    return this._stmts.deleteNodeMetricsBefore.run(nodeId, ts);
  }

  /** 指标总数 */
  metricsCount() {
    return this._stmts.metricsCount.get().cnt;
  }

  /** 单节点指标数量 */
  metricsCountByNode(nodeId: any) {
    return this._stmts.metricsCountByNode.get(nodeId).cnt;
  }

  /**
   * 降采样：将指定节点早于 cutoffTs 的数据按 windowMs 窗口聚合
   * @returns {number} 删除的原始点数
   */
  downsampleNodeMetrics(nodeId: any, cutoffTs: any, windowMs: any) {
    // 读取需要降采样的区间
    const old = this.db.prepare(
      'SELECT * FROM metrics WHERE nodeId = ? AND ts < ? ORDER BY ts'
    ).all(nodeId, cutoffTs);

    if (old.length === 0) return 0;

    // 按窗口分桶聚合
    const buckets = new Map();
    for (const p of old) {
      const key = Math.floor(p.ts / windowMs) * windowMs;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(p);
    }

    const txn = this.db.transaction(() => {
      // 删除原始点
      this._stmts.deleteNodeMetricsBefore.run(nodeId, cutoffTs);
      // 插入聚合点
      for (const [bucketTs, points] of buckets) {
        const avg = (key: any) => Math.round(points.reduce((s: any, p: any) => s + (p[key] || 0), 0) / points.length);
        this._stmts.recordMetric.run({
          nodeId,
          ts: bucketTs,
          cpu: avg('cpu'),
          memPct: avg('memPct'),
          diskPct: avg('diskPct'),
          sshLatency: avg('sshLatency'),
          loadAvg: points[points.length - 1].loadAvg || '0',
          p2pDirect: avg('p2pDirect'),
          p2pTotal: avg('p2pTotal'),
          memTotalMB: points[points.length - 1].memTotalMB || 0,
          memUsedMB: points[points.length - 1].memUsedMB || 0,
        });
      }
    });
    txn();
    return old.length;
  }

  // ═══════════════════════════════════════
  // 审计日志
  // ═══════════════════════════════════════

  /** 插入审计日志 */
  insertAudit({ ts, action, actor, detailJson }: any) {
    this._stmts.insertAudit.run({ ts, action, actor, detailJson });
  }

  /** 查询审计日志（分页，可选 action 过滤） */
  queryAuditLogs({ action, limit = 50, offset = 0 }: any = {}) {
    if (action) {
      return this._stmts.queryAuditByAction.all(action, limit, offset);
    }
    return this._stmts.queryAudit.all(limit, offset);
  }

  /** 审计日志总数 */
  auditCount() {
    return this._stmts.auditCount.get().cnt;
  }

  /** 删除早于指定时间的审计日志 */
  deleteAuditBefore(ts: any) {
    return this._stmts.deleteAuditBefore.run(ts);
  }

  // ═══════════════════════════════════════
  //  用户管理
  // ═══════════════════════════════════════

  /** 插入用户 */
  insertUser({ id, username, passwordHash, role = 'admin' }: any) {
    this._stmts.insertUser.run({ id, username, passwordHash, role, createdAt: new Date().toISOString() });
  }

  /** 按用户名查找 */
  findUserByName(username: any) {
    return this._stmts.findUserByName.get(username) || null;
  }

  /** 按 ID 查找 */
  findUserById(id: any) {
    return this._stmts.findUserById.get(id) || null;
  }

  /** 全部用户（脱敏） */
  allUsers() {
    return this._stmts.allUsers.all();
  }

  /** 删除用户 */
  deleteUser(id: any) {
    return this._stmts.removeUser.run(id);
  }

  /** 更新用户角色 */
  updateUserRole(id: any, role: any) {
    return this._stmts.updateUserRole.run(role, id);
  }

  /** 用户总数 */
  userCount() {
    return this._stmts.userCount.get().cnt;
  }
}

module.exports = NodeStore;
export {}; // CJS 模块标记
