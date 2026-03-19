#!/usr/bin/env node
'use strict';

/**
 * 数据目录迁移脚本
 * @alpha: 从旧扁平结构迁移到新分层结构
 *
 * 旧:  data/{nodes.json, groups.json, ssh/, backups/, ops-logs/, audit.log, audit-archive/}
 * 新:  data/{registry/, security/, logs/, mirror/}
 *
 * 使用方式:  node scripts/migrate-data.js [data目录路径]
 */

const fs = require('fs');
const path = require('path');
const { resolvePaths, ensureDataDirs } = require('../src/services/data-paths');

const DATA_DIR = process.argv[2] || path.resolve(__dirname, '../data');
const paths = resolvePaths(DATA_DIR);

// 定义迁移映射：[旧路径, 新路径]
const MIGRATIONS = [
  // 业务数据 → registry/
  ['nodes.json', paths.registry.nodes],
  ['groups.json', paths.registry.groups],
  // SSH 密钥 → security/ssh/
  ['ssh', paths.security.sshDir],
  // 备份 → security/backups/
  ['backups', paths.security.backupDir],
  // 审计日志 → logs/audit/
  ['audit.log', paths.logs.auditLog],
  ['audit-archive', paths.logs.auditArchive],
  // 运维日志 → logs/ops/
  ['ops-logs', paths.logs.opsDir],
];

function migrate() {
  console.log(`[迁移] 数据目录: ${DATA_DIR}`);
  console.log(`[迁移] 检查旧结构...`);

  // 创建新目录结构
  ensureDataDirs(paths);

  let migrated = 0;
  let skipped = 0;

  for (const [oldRel, newPath] of MIGRATIONS) {
    const oldPath = path.join(DATA_DIR, oldRel);

    // 如果旧路径不存在，跳过
    if (!fs.existsSync(oldPath)) { skipped++; continue; }

    // 如果新路径已存在且有内容，跳过（避免覆盖）
    if (fs.existsSync(newPath)) {
      const stat = fs.statSync(newPath);
      if (stat.isDirectory()) {
        const children = fs.readdirSync(newPath);
        if (children.length > 0) {
          console.log(`  ⏭ ${oldRel} → 目标已存在且非空，跳过`);
          skipped++;
          continue;
        }
      } else if (stat.size > 0) {
        console.log(`  ⏭ ${oldRel} → 目标文件已存在，跳过`);
        skipped++;
        continue;
      }
    }

    // 旧路径和新路径相同（mirror 保持不变），跳过
    if (path.resolve(oldPath) === path.resolve(newPath)) {
      skipped++;
      continue;
    }

    // 执行迁移
    const stat = fs.statSync(oldPath);
    if (stat.isDirectory()) {
      // 目录：逐文件复制到新位置
      const files = fs.readdirSync(oldPath);
      fs.mkdirSync(newPath, { recursive: true });
      for (const f of files) {
        const src = path.join(oldPath, f);
        const dst = path.join(newPath, f);
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
        }
      }
      console.log(`  ✅ ${oldRel}/ → ${path.relative(DATA_DIR, newPath)}/ (${files.length} 文件)`);
    } else {
      // 文件：复制
      fs.mkdirSync(path.dirname(newPath), { recursive: true });
      fs.copyFileSync(oldPath, newPath);
      console.log(`  ✅ ${oldRel} → ${path.relative(DATA_DIR, newPath)}`);
    }
    migrated++;
  }

  console.log(`\n[迁移] 完成: ${migrated} 迁移, ${skipped} 跳过`);

  if (migrated > 0) {
    console.log(`\n[提示] 迁移成功后，确认服务正常启动再手动删除旧文件:`);
    for (const [oldRel] of MIGRATIONS) {
      const oldPath = path.join(DATA_DIR, oldRel);
      if (fs.existsSync(oldPath)) {
        console.log(`  rm -rf ${oldPath}`);
      }
    }
  }
}

migrate();
