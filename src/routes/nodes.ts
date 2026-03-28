'use strict';
import type { Request, Response, NextFunction } from 'express';

const express = require('express');
const crypto = require('crypto');
const { buildInstallCommand, buildUninstallCommand } = require('../services/skill-command');

/**
 * 节点管理 API 路由（含分组 + 指标子路由）
 * @param {import('../services/gnb-monitor')} monitor
 * @param {import('../services/ssh-manager')} sshManager
 * @param {import('../services/key-manager')} [keyManager]
 * @param {import('../services/metrics-store')} [metricsStore]
 * @param {import('../services/task-queue')} [taskQueue]
 */
function createNodesRouter(monitor: any, sshManager: any, keyManager: any, metricsStore: any, taskQueue?: any) {
  const router = express.Router();

  // ═══════════════════════════════════════
  // @alpha: 指标时序 API — /api/nodes/metrics
  // ═══════════════════════════════════════
  if (metricsStore) {
    // GET /api/nodes/metrics/summary — 全局汇总
    router.get('/metrics/summary', (req: Request, res: Response) => {
      res.json(metricsStore.summary());
    });

    // GET /api/nodes/metrics?nodeId=xxx&range=1h
    router.get('/metrics', (req: Request, res: Response) => {
      const { nodeId, range } = req.query;
      if (!nodeId) {
        return res.status(400).json({ error: '缺少 nodeId 参数' });
      }
      const data = metricsStore.query(nodeId, range || '1h');
      res.json({ nodeId, range: range || '1h', points: data, alerts: metricsStore.getAlerts().filter((a: any) => a.nodeId === nodeId) });
    });
  }  // ═══════════════════════════════════════
  // 分组管理子路由 — /api/nodes/groups
  // 必须放在 /:id 之前，避免 "groups" 被当作 nodeId
  // ═══════════════════════════════════════
  if (keyManager) {
    router.get('/groups', (req: Request, res: Response) => {
      res.json({ groups: keyManager.getGroups() });
    });

    router.post('/groups', (req: Request, res: Response) => {
      const { name, color } = req.body;
      try {
        const group = keyManager.createGroup({ name, color });
        res.status(201).json(group);
      } catch (err: unknown) {
        const errMsg = (err as Error).message ?? String(err);
        const status = errMsg.includes('已存在') ? 409 : 400;
        res.status(status).json({ error: errMsg });
      }
    });

    router.put('/groups/:id', (req: Request, res: Response) => {
      const result = keyManager.updateGroup(req.params.id, req.body);
      res.status(result.success ? 200 : 404).json(result);
    });

    router.delete('/groups/:id', (req: Request, res: Response) => {
      const result = keyManager.deleteGroup(req.params.id);
      res.status(result.success ? 200 : 404).json(result);
    });
  }

  // GET /api/nodes — 全部节点状态
  router.get('/', (req: Request, res: Response) => {
    res.json({
      timestamp: new Date().toISOString(),
      nodes: monitor.getAllStatus(),
    });
  });

  // GET /api/nodes/:id — 单节点详情
  router.get('/:id', (req: Request, res: Response) => {
    const status = monitor.getNodeStatus(req.params.id);
    if (!status) {
      return res.status(404).json({ error: `节点 ${req.params.id} 未找到` });
    }
    res.json(status);
  });

  // @alpha: PUT /api/nodes/:id — 编辑节点信息 + 远程 GNB 同步
  // 流程：SSH 修改 conf → 读回验证 → 更新 index conf → 保存 → 异步重启双方 GNB
  if (keyManager) {
    const { exec: execCmd } = require('child_process');

    router.put('/:id', async (req: Request, res: Response) => {
      const { name, tunAddr, sshPort, sshUser } = req.body;

      // 非 tunAddr 变更 → 直接保存
      const oldNode = tunAddr ? keyManager.getApprovedNodesConfig().find((n: any) => n.id === req.params.id) : null;
      const needRemoteSync = oldNode && oldNode.gnbNodeId && oldNode.tunAddr
        && oldNode.tunAddr !== String(tunAddr || '').trim();

      if (!needRemoteSync) {
        const result = keyManager.updateNode(req.params.id, { name, tunAddr, sshPort, sshUser });
        if (!result.success) {
          const status = result.message.includes('不存在') ? 404
            : result.code === 'CONFLICT' ? 409 : 400;
          return res.status(status).json({ error: result.message });
        }
        return res.json(result);
      }

      // ═══ tunAddr 变更：modify → verify → save → restart ═══
      const newIp = String(tunAddr).trim();
      const netmask = oldNode.netmask || '255.0.0.0';
      const gnbId = oldNode.gnbNodeId;
      // @security: gnbId 必须是纯数字，防止 sed 注入（安全审计 L3 修复）
      if (!/^\d+$/.test(gnbId)) {
        return res.status(400).json({ error: 'GNB 节点 ID 格式异常，拒绝执行远程操作' });
      }
      const confPath = `/opt/gnb/conf/${gnbId}/address.conf`;
      const expectedLine = `${gnbId}|${newIp}|${netmask}`;

      console.log(`[RemoteSync] ${oldNode.tunAddr} → ${newIp}`);

      // Step 1: SSH 修改节点 address.conf + 读回验证
      let verified = false;
      try {
        // 修改 + sync + 读回
        const sedCmd = `sudo sed -i 's/^${gnbId}|.*/${expectedLine}/' ${confPath} && sync`;
        await sshManager.exec(oldNode, sedCmd, 10000);
        // 读回验证
        const { stdout } = await sshManager.exec(oldNode, `grep '^${gnbId}|' ${confPath}`, 5000);
        const actual = (stdout || '').trim();
        verified = actual === expectedLine;
        if (!verified) {
          console.error(`[RemoteSync] 读回验证失败: 期望 '${expectedLine}', 实际 '${actual}'`);
          return res.status(500).json({
            error: '远程配置写入验证失败',
            hint: `节点 address.conf 写入不一致，请手动检查。`,
          });
        }
        console.log(`[RemoteSync] ✅ 节点 address.conf 已验证: ${expectedLine}`);
      } catch (err: unknown) {
        const errMsg = (err as Error).message ?? String(err);
        console.error(`[RemoteSync] SSH 失败: ${errMsg}`);
        return res.status(503).json({
          error: `远程同步失败: ${errMsg}`,
          hint: '节点不可达，IP 未变更。请检查 SSH 连接后重试。',
        });
      }

      // Step 2: 更新 index address.conf
      const indexConfPath = keyManager.gnbConfDir
        ? require('path').join(keyManager.gnbConfDir, 'address.conf') : null;
      if (indexConfPath && require('fs').existsSync(indexConfPath)) {
        const content = require('fs').readFileSync(indexConfPath, 'utf8');
        const regex = new RegExp(`^${gnbId}\\|.*$`, 'm');
        let updated = regex.test(content)
          ? content.replace(regex, expectedLine)
          : content.trimEnd() + '\n' + expectedLine;
        if (!updated.endsWith('\n')) updated += '\n';
        require('fs').writeFileSync(indexConfPath, updated);
        console.log(`[RemoteSync] Index address.conf 已更新: ${expectedLine}`);
      }

      // Step 3: 保存到 SQLite
      const result = keyManager.updateNode(req.params.id, { name, tunAddr, sshPort, sshUser });
      if (!result.success) return res.status(400).json({ error: result.message });
      result.remoteSync = 'verified';

      // Step 4: 异步重启双方 GNB（不阻塞响应）
      // 节点端
      sshManager.exec(oldNode, `nohup bash -c 'sleep 1 && sudo systemctl restart gnb' >/dev/null 2>&1 &`, 5000)
        .catch((err: any) => console.error(`[RemoteSync] 节点 GNB 重启失败: ${err.message}`));
      // Index 端
      execCmd('bash -c "sleep 2 && systemctl restart gnb" &', (err: any) => {
        if (err) console.error(`[RemoteSync] Index GNB 重启失败: ${err.message}`);
        else console.log(`[RemoteSync] Index GNB 已重启`);
      });

      console.log(`[RemoteSync] ✅ 完成: ${oldNode.tunAddr} → ${newIp}`);
      res.json(result);
    });
  }

  // POST /api/nodes/:id/exec — 执行远程命令（仅允许安全命令）

  // 精确命令白名单
  const SAFE_COMMANDS: Record<string, RegExp> = {
    'gnb_ctl':     /^gnb_ctl(\s+[\w-]+)*$/,
    'ping':        /^ping(\s+-c\s+\d{1,3})?\s+[\w.:/-]+$/,
    'traceroute':  /^traceroute\s+[\w.:/-]+$/,
    'ip addr':     /^ip\s+addr(\s+show(\s+[\w]+)?)?$/,
    'ip route':    /^ip\s+route(\s+show)?$/,
    'uname':       /^uname(\s+-[a-z]+)?$/i,
    'uptime':      /^uptime$/,
    'free':        /^free(\s+-[a-z]+)?$/i,
    'df':          /^df(\s+-[a-z]+)?(\s+\/[\w/]*)?$/i,
  };

  const SHELL_META = /[;&`$(){}!><\n\r\\'"]/;

  router.post('/:id/exec', async (req: Request, res: Response) => {
    const { command } = req.body;
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: '缺少 command 参数' });
    }

    const cmd = command.trim();

    if (SHELL_META.test(cmd)) {
      return res.status(403).json({ error: '命令包含禁止的特殊字符' });
    }

    const matched = Object.entries(SAFE_COMMANDS).some(([, regex]) => regex.test(cmd));
    if (!matched) {
      return res.status(403).json({
        error: '命令未在安全白名单中，或参数格式不合法。请使用 AI 运维接口执行需审批的操作。',
        allowed: Object.keys(SAFE_COMMANDS),
      });
    }

    const nodeConfig = monitor.nodesConfig.find((n: any) => n.id === req.params.id);
    if (!nodeConfig) {
      return res.status(404).json({ error: `节点 ${req.params.id} 未配置` });
    }

    try {
      const result = await sshManager.exec(nodeConfig, cmd);
      res.json(result);
    } catch (err: unknown) {
      const errMsg = (err as Error).message ?? String(err);
      const msg = process.env.NODE_ENV === 'production' ? '命令执行失败' : errMsg;
      res.status(500).json({ error: msg });
    }
  });

  // ═══════════════════════════════════════
  // Agent 任务队列版技能管理
  // ═══════════════════════════════════════

  // POST /api/nodes/:id/skills — 下发安装技能（入队 Agent 任务队列）
  router.post('/:id/skills', async (req: Request, res: Response) => {
    const { skillId, source, version, name } = req.body;
    if (!skillId || !source) {
      return res.status(400).json({ error: '缺少 skillId 或 source 参数' });
    }

    const nodeId = req.params.id;
    const nodeConfig = monitor.nodesConfig.find((n: any) => n.id === nodeId);
    if (!nodeConfig) {
      return res.status(404).json({ error: `节点 ${nodeId} 未找到或暂离线` });
    }

    // 语义字段校验：console 源无需远程安装
    if (source === 'console') {
      return res.json({ taskId: 'local', status: 'completed', message: '平台内置技能，无需远程安装' });
    }

    // 将语义化字段入队，Daemon 端自决策安装策略（不传 Shell 命令字符串）
    const task = {
      taskId: crypto.randomUUID(),
      type: 'skill_install',
      skillId,
      skillName: name || skillId,
      source,
      slug: req.body.slug,
      githubRepo: req.body.githubRepo,
      timeoutMs: 120000,
    };

    taskQueue.enqueueTask(nodeId, task);
    res.json({ taskId: task.taskId, status: 'queued', message: '安装任务已入队，等待节点执行' });
  });

  // DELETE /api/nodes/:id/skills/:skillId — 下发卸载技能
  router.delete('/:id/skills/:skillId', async (req: Request, res: Response) => {
    const nodeId = req.params.id;
    const nodeConfig = monitor.nodesConfig.find((n: any) => n.id === nodeId);
    if (!nodeConfig) {
      return res.status(404).json({ error: `节点 ${nodeId} 未找到或不可达` });
    }

    const skillId = req.params.skillId;
    if (!/^[a-zA-Z0-9_@/.\-]+$/.test(skillId)) {
      return res.status(400).json({ error: '技能 ID 格式包含非法符号' });
    }

    const crypto = require('crypto');
    const uninstallSource = req.body?.source || req.query?.source || '';
    // 将语义化字段入队，Daemon 端自决策卸载策略（不传 Shell 命令字符串）
    const task = {
      taskId: crypto.randomUUID(),
      type: 'skill_uninstall',
      skillId,
      source: uninstallSource,
      timeoutMs: 60000,
    };

    taskQueue.enqueueTask(nodeId, task);
    res.json({ taskId: task.taskId, status: 'queued', message: '卸载任务已入队' });
  });

  // GET /api/nodes/:id/tasks — 查询节点任务队列状态
  router.get('/:id/tasks', (req: Request, res: Response) => {
    const tasks = taskQueue.getNodeTasks(req.params.id);
    res.json({ tasks });
  });

  // DELETE /api/nodes/:id/tasks/:taskId — 删除指定任务
  router.delete('/:id/tasks/:taskId', (req: Request, res: Response) => {
    const ok = taskQueue.deleteTask(req.params.taskId, req);
    if (!ok) return res.status(404).json({ error: '任务不存在' });
    res.json({ message: '任务已删除' });
  });

  return router;
}

module.exports = createNodesRouter;
export {}; // CJS 模块标记
