#!/usr/bin/env tsx
/**
 * init-db.ts — 数据库初始化/迁移脚本
 *
 * 用途：确保 registry/nodes.db 中所有表（含 skills、agent_tasks）已创建。
 * 调用：npx tsx scripts/init-db.ts
 *
 * deploy.sh 在 systemctl restart 之前调用此脚本，
 * 确保 schema 迁移先于应用启动完成（避免 tsx 运行时建表竞态）。
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { resolvePaths, ensureDataDirs } = require('../src/services/data-paths');

const DATA_DIR = process.env.DATA_DIR || './data';
const paths = resolvePaths(DATA_DIR);
ensureDataDirs(paths);
const DB_PATH = paths.registry.nodesDb;  // data/registry/nodes.db

console.log(`[init-db] 数据库路径: ${DB_PATH}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ═══════════════════════════════════════
// 全量建表（IF NOT EXISTS 幂等执行）
// ═══════════════════════════════════════

db.exec(`
  -- 节点
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
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tunAddr ON nodes(tunAddr) WHERE tunAddr != '';
  CREATE INDEX IF NOT EXISTS idx_status ON nodes(status);
  CREATE INDEX IF NOT EXISTS idx_groupId ON nodes(groupId);

  -- 分组
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT DEFAULT '#388bfd',
    createdAt TEXT
  );

  -- 指标
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

  -- 审计日志
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT DEFAULT 'system',
    detail_json TEXT DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_audit_ts_action ON audit_logs(ts, action);

  -- 用户
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    apiToken TEXT DEFAULT '',
    createdAt TEXT
  );

  -- 异步 Job
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

  -- Agent 任务队列
  CREATE TABLE IF NOT EXISTS agent_tasks (
    taskId TEXT PRIMARY KEY,
    nodeId TEXT NOT NULL,
    type TEXT NOT NULL,
    command TEXT NOT NULL,
    skillId TEXT DEFAULT '',
    skillName TEXT DEFAULT '',
    status TEXT DEFAULT 'queued',
    timeoutMs INTEGER DEFAULT 60000,
    resultCode INTEGER,
    resultStdout TEXT,
    resultStderr TEXT,
    queuedAt TEXT NOT NULL,
    dispatchedAt TEXT,
    completedAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_node_status ON agent_tasks(nodeId, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_queued ON agent_tasks(queuedAt);

  -- 技能注册表（原 skills.db，已合并）
  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT DEFAULT 'v1.0',
    author TEXT DEFAULT '',
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'ai',
    icon TEXT DEFAULT 'package',
    iconGradient TEXT DEFAULT 'linear-gradient(135deg, #6366f1 0%, #a5b4fc 100%)',
    rating REAL DEFAULT 0,
    installs INTEGER DEFAULT 0,
    source TEXT DEFAULT 'custom',
    slug TEXT DEFAULT '',
    installType TEXT DEFAULT 'prompt',
    skillContent TEXT DEFAULT '',
    isBuiltin INTEGER DEFAULT 0,
    createdAt TEXT,
    updatedAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
  CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
  CREATE INDEX IF NOT EXISTS idx_skills_isBuiltin ON skills(isBuiltin);

  -- Playbook 编排
  CREATE TABLE IF NOT EXISTS playbooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    targetNodeIds TEXT DEFAULT '[]',
    createdAt TEXT,
    startedAt TEXT,
    completedAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_playbooks_status ON playbooks(status);
  CREATE INDEX IF NOT EXISTS idx_playbooks_created ON playbooks(createdAt);

  -- Playbook 步骤
  CREATE TABLE IF NOT EXISTS playbook_steps (
    id TEXT PRIMARY KEY,
    playbookId TEXT NOT NULL,
    seq INTEGER NOT NULL,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    targetScope TEXT DEFAULT 'all',
    dependsOn TEXT DEFAULT '[]',
    status TEXT DEFAULT 'pending',
    resultSummary TEXT DEFAULT '',
    startedAt TEXT,
    completedAt TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pb_steps_playbook ON playbook_steps(playbookId);
  CREATE INDEX IF NOT EXISTS idx_pb_steps_status ON playbook_steps(playbookId, status);
`);

// ═══════════════════════════════════════
// 向后兼容列迁移（ALTER TABLE 不支持 IF NOT EXISTS）
// ═══════════════════════════════════════
const migrations = [
  `ALTER TABLE users ADD COLUMN apiToken TEXT DEFAULT ''`,
  `ALTER TABLE nodes ADD COLUMN ownerId TEXT DEFAULT ''`,
  `ALTER TABLE nodes ADD COLUMN skills TEXT DEFAULT '[]'`,
  // 密钥滚动：0=已同步；1=待同步新公钥（daemon 重连后补发）
  `ALTER TABLE nodes ADD COLUMN pubkeyRotationPending INTEGER DEFAULT 0`,
  // 弹性 TUN：存储节点上报的本地网段 CIDR JSON 数组
  `ALTER TABLE nodes ADD COLUMN localSubnets TEXT DEFAULT '[]'`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch { /* 列已存在 */ }
}

// 把存量节点的 sshUser 统一刷成 synon（对齐新的隔离账户安全模型）
try {
  const info = db.prepare(`UPDATE nodes SET sshUser = 'synon' WHERE sshUser != 'synon' OR sshUser IS NULL`).run();
  if (info.changes > 0) {
    console.log(`[init-db] 已将 ${info.changes} 个存量节点的 sshUser 迁移为 'synon'`);
  }
} catch (e: any) {
  console.warn(`[init-db] 迁移 sshUser 失败: ${e.message}`);
}

// ═══════════════════════════════════════
// 数据迁移：旧 skills.db → nodes.db
// ═══════════════════════════════════════
const OLD_SKILLS_DB = path.join(DATA_DIR, 'skills.db');
if (fs.existsSync(OLD_SKILLS_DB)) {
  try {
    const oldDb = new Database(OLD_SKILLS_DB, { readonly: true });
    const oldSkills = oldDb.prepare('SELECT * FROM skills').all();
    oldDb.close();

    if (oldSkills.length > 0) {
      const existing = db.prepare('SELECT COUNT(*) as c FROM skills').get().c;
      if (existing === 0) {
        const insert = db.prepare(`
          INSERT OR IGNORE INTO skills (id, name, version, author, description, category, icon, iconGradient,
            rating, installs, source, slug, installType, skillContent, isBuiltin, createdAt, updatedAt)
          VALUES (@id, @name, @version, @author, @description, @category, @icon, @iconGradient,
            @rating, @installs, @source, @slug, @installType, @skillContent, @isBuiltin, @createdAt, @updatedAt)
        `);
        const tx = db.transaction((rows: any[]) => {
          for (const r of rows) insert.run(r);
        });
        tx(oldSkills);
        console.log(`[init-db] 已迁移 ${oldSkills.length} 条技能从 skills.db`);
      }
    }

    // 迁移完成后重命名旧 DB（不删除，留备份）
    fs.renameSync(OLD_SKILLS_DB, OLD_SKILLS_DB + '.migrated');
    console.log(`[init-db] 旧 skills.db 已重命名为 skills.db.migrated`);
  } catch (e: any) {
    console.warn(`[init-db] skills.db 迁移跳过: ${e.message}`);
  }
}

// 验证
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(`[init-db] ✅ 完成，共 ${tables.length} 个表: ${tables.map((t: any) => t.name).join(', ')}`);

db.close();
