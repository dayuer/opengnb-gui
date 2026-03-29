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
      
      const result = keyManager.updateNode(req.params.id, { name, tunAddr, sshPort, sshUser });
      if (!result.success) {
        const status = result.message.includes('不存在') ? 404
          : result.code === 'CONFLICT' ? 409 : 400;
        return res.status(status).json({ error: result.message });
      }

      // 无论是否修改 tunAddr，统一通过 updateNode 持久化
      // 当发生 tunAddr 变更时，keyManager 会自动触发 route_update 广播，
      // 并通过 WebSocket 交由 synon-daemon 应用全量新配置并重启 GNB
      if (oldNode && oldNode.tunAddr !== String(tunAddr || '').trim()) {
        console.log(`[RemoteSync] ${oldNode.tunAddr} → ${tunAddr} 已触发全局配置刷新`);
        result.remoteSync = 'verified'; // 伪装成 verified，前端展示打钩
      }

      return res.json(result);
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
