'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');
const log = createLogger('OpsLog');

const MAX_OPS_LOG = 200;

/**
 * 运维日志持久化（按终端/节点分开存储 JSON 文件）
 *
 * @param {string} opsLogDir - 日志目录路径
 * @returns {{ loadOpsLog, saveOpsLog, loadAllOpsLogs }}
 */
function createOpsLog(opsLogDir: string) {
  function loadOpsLog(nodeId: string) {
    try {
      return JSON.parse(fs.readFileSync(path.join(opsLogDir, `${nodeId}.json`), 'utf-8'));
    } catch (_) { return []; }
  }

  function saveOpsLog(nodeId: string, role: string, content: string) {
    const logPath = path.join(opsLogDir, `${nodeId}.json`);
    let logs = loadOpsLog(nodeId);
    logs.push({ role, content, ts: new Date().toISOString() });
    if (logs.length > MAX_OPS_LOG) logs = logs.slice(-MAX_OPS_LOG);
    try { fs.writeFileSync(logPath, JSON.stringify(logs, null, 2)); } catch (_) {}
  }

  function loadAllOpsLogs() {
    try {
      const files = fs.readdirSync(opsLogDir).filter((f: string) => f.endsWith('.json'));
      const all: Record<string, any> = {};
      for (const f of files) {
        const nodeId = f.replace('.json', '');
        all[nodeId] = loadOpsLog(nodeId);
      }
      return all;
    } catch (_) { return {}; }
  }

  return { loadOpsLog, saveOpsLog, loadAllOpsLogs };
}

module.exports = { createOpsLog };
export {}; // CJS 模块标记
