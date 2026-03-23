'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { createLogger } = require('./logger');
const log = createLogger('NodeStore');

// --- 子模块 mixin ---
const { prepareGroupStatements, groupMethods } = require('../stores/group-store');
const { prepareMetricsStatements, metricsMethods } = require('../stores/metrics-store-sql');
const { prepareAuditStatements, auditMethods } = require('../stores/audit-store');
const { prepareUserStatements, userMethods } = require('../stores/user-store');
const { prepareJobStatements } = require('../stores/job-store');

/**
 * SQLite 节点存储层
 * @alpha: V2 重构 — SQLite 为唯一数据源
 *
 * 设计原则：
 *   - better-sqlite3 同步 API，与 Node.js 单线程模型天然匹配
 *   - 所有写操作自带事务，并发安全
 *   - 对外暴露与原 this.nodes 数组兼容的接口
 *   - V3: 通过 mixin 模式组合分组/指标/审计/用户/Job 子模块
 */
class NodeStore {
  dbPath: string;
  db: any;
  _stmts: any;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * 初始化数据库（建表 + 混入子模块）
   */
  init(existingNodes: any[] = []) {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
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

    // 向后兼容迁移
    try { this.db.exec(`ALTER TABLE users ADD COLUMN apiToken TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
    try { this.db.exec(`ALTER TABLE nodes ADD COLUMN ownerId TEXT DEFAULT ''`); } catch { /* 列已存在 */ }
    try { this.db.exec(`ALTER TABLE nodes ADD COLUMN skills TEXT DEFAULT '[]'`); } catch { /* 列已存在 */ }
  }

  /** @private 预编译常用语句（组合子模块的 statements） */
  _prepareStatements() {
    this._stmts = {
      // --- 节点核心 ---
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
      // --- 子模块 statements ---
      ...prepareGroupStatements(this.db),
      ...prepareMetricsStatements(this.db),
      ...prepareAuditStatements(this.db),
      ...prepareUserStatements(this.db),
      ...prepareJobStatements(this.db),
    };
  }

  // ═══════════════════════════════════════
  // 迁移
  // ═══════════════════════════════════════

  /** @private 从 JSON 数组迁移数据 */
  _migrateFromJson(nodes: any) {
    const insertMany = this.db.transaction((items: any) => {
      for (const n of items) {
        this._stmts.insert.run(this._toRow(n));
      }
    });
    insertMany(nodes);
    log.info(`已从 JSON 迁移 ${nodes.length} 个节点`);
  }

  /** @private 将旧式 hostname-based ID 迁移为平台生成的唯一 ID */
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
        const name = (node.name && node.name !== oldId) ? node.name : oldId;

        this.db.prepare('UPDATE metrics SET nodeId = ? WHERE nodeId = ?').run(newId, oldId);
        this.db.prepare('UPDATE jobs SET nodeId = ? WHERE nodeId = ?').run(newId, oldId);
        this.db.prepare('DELETE FROM nodes WHERE id = ?').run(oldId);
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

  // ═══════════════════════════════════════
  // 数据转换
  // ═══════════════════════════════════════

  /** @private 将节点对象规范化为数据库行 */
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

  /** @private 将数据库行转换为兼容的节点对象 */
  _fromRow(row: any) {
    if (!row) return null;
    return {
      ...row,
      ready: !!row.ready,
      skills: row.skills ? JSON.parse(row.skills) : []
    };
  }

  // ═══════════════════════════════════════
  // 节点查询
  // ═══════════════════════════════════════

  findById(id: any) {
    return this._fromRow(this._stmts.findById.get(id));
  }

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

  isTunAddrTaken(tunAddr: any, excludeNodeId = '') {
    const row = this._stmts.findByTunAddr.get(tunAddr, excludeNodeId);
    return row ? this._fromRow(row) : null;
  }

  approvedWithGnb() {
    return this._stmts.approvedWithGnb.all().map((r: any) => this._fromRow(r));
  }

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
  // 节点写入
  // ═══════════════════════════════════════

  insert(node: any) {
    this._stmts.insert.run(this._toRow(node));
  }

  update(id: any, fields: any) {
    const sets = [];
    const params: Record<string, any> = { id };
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'id') continue;
      sets.push(`${key} = @${key}`);
      // @fix: better-sqlite3 只接受 number|string|bigint|Buffer|null
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

  allTunAddrs() {
    return new Set(this._stmts.allTunAddrs.all().map((r: any) => r.tunAddr));
  }

  close() {
    if (this.db) this.db.close();
  }
}

// ═══════════════════════════════════════
// Mixin 混入 — 将子模块方法挂载到 NodeStore.prototype
// ═══════════════════════════════════════

Object.assign(NodeStore.prototype, groupMethods, metricsMethods, auditMethods, userMethods);

module.exports = NodeStore;
export {}; // CJS 模块标记
