'use strict';

const EventEmitter = require('events');
const { createLogger } = require('./logger');
const log = createLogger('GnbMonitor');

/**
 * GNB 节点监控服务（V3 推模式）
 *
 * 节点通过 node-agent.sh 定时采集 GNB + OpenClaw + 系统信息，
 * POST 到 Console /api/monitor/report。GnbMonitor 被动接收并更新状态。
 *
 * 不再主动 SSH 轮询节点。
 */
class GnbMonitor extends EventEmitter {
  nodesConfig: any[];
  staleTimeoutMs: number;
  metricsStore: any;
  latestState: Map<string, any>;
  _staleTimer: any;
  _taskQueues: Map<string, any[]>;

  constructor(nodesConfig: any[], options: any = {}) {
    super();
    this.nodesConfig = nodesConfig;
    this.staleTimeoutMs = options.staleTimeoutMs || 60000;
    this.metricsStore = options.metricsStore || null;
    this.latestState = new Map();
    this._staleTimer = null;
    this._taskQueues = new Map();
  }

  /**
   * 启动超时检测循环
   */
  start() {
    log.info(`推模式已启动，${this.staleTimeoutMs / 1000}s 无上报判定离线`);
    this._staleTimer = setInterval(() => this._checkStale(), 10000);
  }

  /**
   * 停止监控
   */
  stop() {
    if (this._staleTimer) {
      clearInterval(this._staleTimer);
      this._staleTimer = null;
    }
    log.info('已停止');
  }

  /**
   * 接收节点上报数据
   * @param {string} nodeId - 节点 ID
   * @param {object} report - 上报的 JSON 数据
   */
  ingest(nodeId: any, report: any) {
    const now = new Date().toISOString();

    // 解析 GNB 状态
    const { parseGnbCtlStatus, parseGnbCtlAddressList } = require('./gnb-parser');
    const statusData = parseGnbCtlStatus(report.gnbStatus || '');
    const addrData = parseGnbCtlAddressList(report.gnbAddresses || '');
    const sysInfo = this._parseSysInfo(report.sysInfo || '');

    // 从 agent 上报提取实际安装的 skills（来源：npm 全局包 + openclaw 配置）
    const agentSkills = (report.openclaw?.installedSkills || []).map((s: any) => ({
      id: s.id || s.name,
      name: s.name || s.id,
      version: s.version || 'unknown',
      source: s.source || 'npm',
    }));

    const state = {
      online: true,
      lastUpdate: now,
      sshLatencyMs: report.collectMs || 0,
      core: statusData.core,
      nodes: statusData.nodes,
      addresses: addrData,
      sysInfo,
      openclaw: report.openclaw || null,
      skills: agentSkills,
      error: null as any,
    };

    this.latestState.set(nodeId, state);

    // @alpha: OpenClaw token/port 自动发现 — agent 上报 config 后同步到节点配置表
    const gw = report.openclaw?.config?.gateway;
    if (gw) {
      const discoveredToken = gw.auth?.token || null;
      const discoveredPort = gw.port || null;
      if (discoveredToken) {
        const nodeConfig = this.nodesConfig.find(n => n.id === nodeId);
        // 仅在首次发现或 token 变更时触发
        if (nodeConfig && (!nodeConfig.clawToken || nodeConfig.clawToken !== discoveredToken)) {
          this.emit('clawDiscovered', { nodeId, token: discoveredToken, port: discoveredPort });
        }
      }
    }

    // 记录指标到时序存储
    if (this.metricsStore) {
      const memPct = sysInfo.memTotalMB > 0 ? Math.round(sysInfo.memUsedMB / sysInfo.memTotalMB * 100) : 0;
      const diskPct = sysInfo.diskUsePct ? parseInt(sysInfo.diskUsePct) : 0;
      const peers = statusData.nodes || [];
      this.metricsStore.record(nodeId, {
        cpu: sysInfo.cpuUsage ?? 0,
        memPct,
        diskPct,
        sshLatency: report.collectMs || 0,
        loadAvg: sysInfo.loadAvg || '0',
        p2pDirect: peers.filter((p: any) => p.status === 'Direct').length,
        p2pTotal: peers.length,
        memTotalMB: sysInfo.memTotalMB || 0,
        memUsedMB: sysInfo.memUsedMB || 0,
      });
    }

    this.emit('update', this.getAllStatus());
  }

  /**
   * 获取所有节点最新状态
   * @returns {Array<object>}
   */
  getAllStatus() {
    const result = [];
    // @alpha: 已有配置的节点 ID 集合 — 过滤掉已删除/迁移的旧 key
    const validIds = new Set(this.nodesConfig.map(n => n.id));
    for (const [id, state] of this.latestState) {
      if (!validIds.has(id)) continue; // 跳过孤立缓存（已删除/已迁移节点）
      const config = this.nodesConfig.find(n => n.id === id);
      result.push({
        id,
        name: config?.name || id,
        tunAddr: config?.tunAddr || '',
        ...state,
      });
    }
    return result;
  }

  /**
   * 获取单个节点状态
   * @param {string} nodeId
   * @returns {object|null}
   */
  getNodeStatus(nodeId: any) {
    const state = this.latestState.get(nodeId);
    if (!state) return null;
    const config = this.nodesConfig.find(n => n.id === nodeId);
    return { id: nodeId, name: config?.name || nodeId, tunAddr: config?.tunAddr || '', ...state };
  }

  /**
   * 检查超时节点，标记为离线
   * @private
   */
  _checkStale() {
    const now = Date.now();
    for (const [nodeId, state] of this.latestState) {
      if (!state.online) continue;
      const lastMs = new Date(state.lastUpdate).getTime();
      if (now - lastMs > this.staleTimeoutMs) {
        state.online = false;
        state.error = `超过 ${Math.round(this.staleTimeoutMs / 1000)}s 无上报`;
        this.emit('stale', nodeId);
      }
    }
  }

  /**
   * 解析系统信息输出
   * @private
   */
  _parseSysInfo(stdout: any) {
    // 防御：如果已经是对象直接返回（兼容非 agent 来源）
    if (stdout && typeof stdout === 'object') return stdout;
    const info: Record<string, any> = {};
    const lines = String(stdout || '').split('\n');
    for (const line of lines) {
      const match = line.match(/^::(\w+)::(.*)$/);
      if (!match) continue;
      const [, key, val] = match;
      const v = val.trim();
      switch (key) {
        case 'HOSTNAME': info.hostname = v; break;
        case 'OS':       info.os = v; break;
        case 'KERNEL':   info.kernel = v; break;
        case 'ARCH':     info.arch = v; break;
        case 'UPTIME':   info.uptime = v; break;
        case 'LOAD':     info.loadAvg = v; break;
        case 'CPU_MODEL': info.cpuModel = v; break;
        case 'CPU_CORES': info.cpuCores = parseInt(v, 10) || 0; break;
        case 'MEM': {
          const parts = v.split(/\s+/);
          if (parts.length >= 3) {
            info.memTotalMB = parseInt(parts[0], 10) || 0;
            info.memUsedMB = parseInt(parts[1], 10) || 0;
            info.memAvailMB = parseInt(parts[2], 10) || 0;
          }
          break;
        }
        case 'DISK': {
          const parts = v.split(/\s+/);
          if (parts.length >= 4) {
            info.diskTotal = parts[0];
            info.diskUsed = parts[1];
            info.diskAvail = parts[2];
            info.diskUsePct = parts[3];
          }
          break;
        }
        case 'CPU_USAGE': info.cpuUsage = parseInt(v, 10) || 0; break;
      }
    }
    return info;
  }

  // ═══════════════════════════════════════
  //  Agent 任务队列
  // ═══════════════════════════════════════

  /**
   * 入队：将任务加入指定节点的待执行队列
   */
  enqueueTask(nodeId: string, task: any) {
    if (!this._taskQueues.has(nodeId)) {
      this._taskQueues.set(nodeId, []);
    }
    const entry = {
      ...task,
      status: 'queued',       // queued → dispatched → completed/failed/timeout
      queuedAt: new Date().toISOString(),
    };
    this._taskQueues.get(nodeId)!.push(entry);
    log.info(`任务入队 node=${nodeId} taskId=${task.taskId} type=${task.type} cmd=${task.command}`);
    this.emit('taskQueued', { nodeId, task: entry });
    return entry;
  }

  /**
   * 出队：返回指定节点的待执行任务（状态为 queued 的）
   * 返回后标记为 dispatched（已下发）
   */
  getPendingTasks(nodeId: string): any[] {
    const queue = this._taskQueues.get(nodeId) || [];
    const pending = queue.filter((t: any) => t.status === 'queued');
    // 标记为已下发
    for (const t of pending) {
      t.status = 'dispatched';
      t.dispatchedAt = new Date().toISOString();
    }
    return pending.map((t: any) => ({
      taskId: t.taskId,
      type: t.type,
      command: t.command,
      timeoutMs: t.timeoutMs || 60000,
    }));
  }

  /**
   * 处理 agent 上报的任务执行结果
   */
  processTaskResults(nodeId: string, results: any[]) {
    const queue = this._taskQueues.get(nodeId) || [];
    for (const result of results) {
      const task = queue.find((t: any) => t.taskId === result.taskId);
      if (!task) continue;
      task.status = result.code === 0 ? 'completed' : 'failed';
      task.result = result;
      task.completedAt = result.completedAt || new Date().toISOString();
      log.info(`任务${task.status} node=${nodeId} taskId=${result.taskId} code=${result.code}`);
      this.emit('taskCompleted', { nodeId, task });
    }
  }

  /**
   * 获取指定节点的任务列表（含所有状态）
   */
  getNodeTasks(nodeId: string): any[] {
    return this._taskQueues.get(nodeId) || [];
  }

  /**
   * 清理已完成超过 5 分钟的任务（避免内存泄漏）
   */
  _cleanOldTasks() {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [nodeId, queue] of this._taskQueues) {
      const filtered = queue.filter((t: any) => {
        if (t.status === 'completed' || t.status === 'failed') {
          return new Date(t.completedAt).getTime() > cutoff;
        }
        return true;
      });
      this._taskQueues.set(nodeId, filtered);
    }
  }
}

module.exports = GnbMonitor;
export {}; // CJS 模块标记
