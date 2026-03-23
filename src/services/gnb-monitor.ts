'use strict';
import type { NodeConfig, AgentReport, GnbMonitorOptions, SysInfo, PeerNode } from '../types/interfaces';

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
  nodesConfig: NodeConfig[];
  staleTimeoutMs: number;
  metricsStore: unknown;
  latestState: Map<string, any>;
  _staleTimer: ReturnType<typeof setInterval> | null;
  _store: unknown;
  _audit: unknown;

  constructor(nodesConfig: NodeConfig[], options: GnbMonitorOptions = {}) {
    super();
    this.nodesConfig = nodesConfig;
    this.staleTimeoutMs = options.staleTimeoutMs ?? 60000;
    this.metricsStore = options.metricsStore ?? null;
    this.latestState = new Map();
    this._staleTimer = null;
    this._store = options.store ?? null;
    this._audit = options.audit ?? null;
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
  ingest(nodeId: string, report: AgentReport) {
    const now = new Date().toISOString();

    // 解析 GNB 状态
    const { parseGnbCtlStatus, parseGnbCtlAddressList } = require('./gnb-parser');
    const statusData = parseGnbCtlStatus(report.gnbStatus ?? '');
    const addrData = parseGnbCtlAddressList(report.gnbAddresses ?? '');
    const sysInfo = this._parseSysInfo(report.sysInfo ?? '');

    // 从 agent 上报提取实际安装的 skills（来源：npm 全局包 + openclaw 配置）
    const installedSkills = report.openclaw?.installedSkills ?? [];
    const agentSkills = installedSkills.map((s) => ({
      id: s.id ?? s.name,
      name: s.name ?? s.id,
      version: s.version ?? 'unknown',
      source: s.source ?? 'npm',
    }));

    const state = {
      online: true,
      lastUpdate: now,
      sshLatencyMs: report.collectMs ?? 0,
      core: statusData.core,
      nodes: statusData.nodes,
      addresses: addrData,
      sysInfo,
      openclaw: report.openclaw ?? null,
      skills: agentSkills,
      error: null as string | null,
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
      const memTotal = sysInfo.memTotalMB ?? 0;
      const memUsed = sysInfo.memUsedMB ?? 0;
      const memPct = memTotal > 0 ? Math.round(memUsed / memTotal * 100) : 0;
      const diskPct = sysInfo.diskUsePct ? parseInt(sysInfo.diskUsePct, 10) : 0;
      const peers = statusData.nodes || [];
      (this.metricsStore as { record: (id: string, data: Record<string, unknown>) => void }).record(nodeId, {
        cpu: sysInfo.cpuUsage ?? 0,
        memPct,
        diskPct,
        sshLatency: report.collectMs ?? 0,
        loadAvg: sysInfo.loadAvg || '0',
        p2pDirect: peers.filter((p: PeerNode) => p.status === 'Direct').length,
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
  getNodeStatus(nodeId: string) {
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
  _parseSysInfo(stdout: string | Record<string, unknown>): Partial<SysInfo> {
    // 防御：如果已经是对象直接返回（兼容非 agent 来源）
    if (stdout && typeof stdout === 'object') return stdout as Partial<SysInfo>;
    const info: Partial<SysInfo> = {};
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
}

module.exports = GnbMonitor;
export {}; // CJS 模块标记
