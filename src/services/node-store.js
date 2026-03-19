'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

/**
 * SQLite 节点存储层
 * @alpha: V2 重构 — 替代 nodes.json 全内存数组
 *
 * 设计原则：
 *   - better-sqlite3 同步 API，与 Node.js 单线程模型天然匹配
 *   - 所有写操作自带事务，并发安全
 *   - 对外暴露与原 this.nodes 数组兼容的接口
 */
class NodeStore {
  /**
   * @param {string} dbPath - SQLite 数据库文件路径
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * 初始化数据库（建表 + 可选迁移）
   * @param {Array} [existingNodes] - 从 nodes.json 迁移的数据
   */
  init(existingNodes = []) {
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
        submittedAt TEXT,
        approvedAt TEXT,
        updatedAt TEXT,
        readyAt TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tunAddr
        ON nodes(tunAddr) WHERE tunAddr != '';
      CREATE INDEX IF NOT EXISTS idx_status ON nodes(status);
      CREATE INDEX IF NOT EXISTS idx_groupId ON nodes(groupId);
    `);
  }

  /** @private 预编译常用语句 */
  _prepareStatements() {
    this._stmts = {
      findById: this.db.prepare('SELECT * FROM nodes WHERE id = ?'),
      findByStatus: this.db.prepare('SELECT * FROM nodes WHERE status = ?'),
      all: this.db.prepare('SELECT * FROM nodes'),
      count: this.db.prepare('SELECT COUNT(*) AS cnt FROM nodes'),
      countByStatus: this.db.prepare('SELECT COUNT(*) AS cnt FROM nodes WHERE status = ?'),
      insert: this.db.prepare(`
        INSERT OR REPLACE INTO nodes
        (id, name, tunAddr, gnbNodeId, status, sshUser, sshPort, netmask,
         groupId, clawToken, clawPort, gnbMapPath, gnbCtlPath, ready,
         submittedAt, approvedAt, updatedAt, readyAt)
        VALUES
        (@id, @name, @tunAddr, @gnbNodeId, @status, @sshUser, @sshPort, @netmask,
         @groupId, @clawToken, @clawPort, @gnbMapPath, @gnbCtlPath, @ready,
         @submittedAt, @approvedAt, @updatedAt, @readyAt)
      `),
      remove: this.db.prepare('DELETE FROM nodes WHERE id = ?'),
      findByTunAddr: this.db.prepare('SELECT * FROM nodes WHERE tunAddr = ? AND id != ?'),
      allTunAddrs: this.db.prepare("SELECT tunAddr FROM nodes WHERE tunAddr != ''"),
      approvedWithGnb: this.db.prepare(
        "SELECT * FROM nodes WHERE status = 'approved' AND gnbNodeId != '' AND tunAddr != ''"
      ),
    };
  }

  /**
   * 从 JSON 数组迁移数据
   * @private
   */
  _migrateFromJson(nodes) {
    const insertMany = this.db.transaction((items) => {
      for (const n of items) {
        this._stmts.insert.run(this._toRow(n));
      }
    });
    insertMany(nodes);
    console.log(`[NodeStore] 已从 JSON 迁移 ${nodes.length} 个节点`);
  }

  /**
   * 将节点对象规范化为数据库行
   * @private
   */
  _toRow(node) {
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
  _fromRow(row) {
    if (!row) return null;
    return { ...row, ready: !!row.ready };
  }

  // ═══════════════════════════════════════
  // 查询接口
  // ═══════════════════════════════════════

  findById(id) {
    return this._fromRow(this._stmts.findById.get(id));
  }

  findByStatus(status) {
    return this._stmts.findByStatus.all(status).map(r => this._fromRow(r));
  }

  all() {
    return this._stmts.all.all().map(r => this._fromRow(r));
  }

  count() {
    return this._stmts.count.get().cnt;
  }

  countByStatus(status) {
    return this._stmts.countByStatus.get(status).cnt;
  }

  /**
   * 检查 tunAddr 是否已被其他节点占用
   */
  isTunAddrTaken(tunAddr, excludeNodeId = '') {
    const row = this._stmts.findByTunAddr.get(tunAddr, excludeNodeId);
    return row ? this._fromRow(row) : null;
  }

  /**
   * 获取所有已审批且有 GNB 配置的节点
   */
  approvedWithGnb() {
    return this._stmts.approvedWithGnb.all().map(r => this._fromRow(r));
  }

  /**
   * 按条件过滤节点（分页支持）
   */
  filter({ status, groupId, keyword, page = 1, pageSize = 0 } = {}) {
    let sql = 'SELECT * FROM nodes WHERE 1=1';
    const params = {};
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
    return this.db.prepare(sql).all(params).map(r => this._fromRow(r));
  }

  // ═══════════════════════════════════════
  // 写入接口
  // ═══════════════════════════════════════

  insert(node) {
    this._stmts.insert.run(this._toRow(node));
  }

  /**
   * 更新指定节点的字段
   * @param {string} id
   * @param {object} fields - 要更新的字段
   */
  update(id, fields) {
    const sets = [];
    const params = { id };
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'id') continue; // 不允许改 id
      if (key === 'ready') {
        sets.push(`${key} = @${key}`);
        params[key] = val ? 1 : 0;
      } else {
        sets.push(`${key} = @${key}`);
        params[key] = val;
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  remove(id) {
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
    return new Set(this._stmts.allTunAddrs.all().map(r => r.tunAddr));
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.db) this.db.close();
  }
}

module.exports = NodeStore;
