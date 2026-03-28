'use strict';
import type { NodeConfig, AgentReport, GnbMonitorOptions, SysInfo, PeerNode } from '../types/interfaces';
import alertingGateway from './alerting-gateway';

const EventEmitter = require('events');
const { exec } = require('child_process');
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
  _sshManager: { getConnection(cfg: Record<string, unknown>): Promise<unknown> } | null;
  _probing: Set<string>;

  constructor(nodesConfig: NodeConfig[], options: GnbMonitorOptions = {}) {
    super();
    this.nodesConfig = nodesConfig;
    this.staleTimeoutMs = options.staleTimeoutMs ?? 60000;
    this.metricsStore = options.metricsStore ?? null;
    this.latestState = new Map();
    this._staleTimer = null;
    this._store = options.store ?? null;
    this._audit = options.audit ?? null;
    this._sshManager = null;
    this._probing = new Set();
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
   * 接收来自 synon-daemon WebSocket 的心跳帧
   * 取代 node-agent.sh + HTTP POST /api/monitor/report 的数据来源
   *
   * @param {string} nodeId - 节点 ID（已由 wssDaemon 鉴权验证）
   * @param {object} frame  - daemon 发送的 heartbeat 帧
   */
  ingestFromDaemon(nodeId: string, frame: Record<string, unknown>) {
    const now = new Date().toISOString();
    const sysInfo = frame.sysInfo as Record<string, unknown> | undefined;
    const gnbPeers = (frame.gnbPeers as unknown[]) ?? [];
    const clawRunning = Boolean(frame.clawRunning);
    const clawRpcOk  = Boolean(frame.clawRpcOk);

    // GNB 对等状态（gnb_ctl 原始输出，与 node-agent.sh 格式一致）
    const gnbStatus    = String(frame.gnbStatus ?? '');
    const gnbAddresses = String(frame.gnbAddresses ?? '');

    // 已安装 skills（/opt/gnb/cache/skills.json 读取结果）
    const installedSkills = Array.isArray(frame.installedSkills)
      ? frame.installedSkills as Record<string, unknown>[]
      : [];

    // OpenClaw CPU 占用（daemon 心跳采集的 /proc/{pid}/stat 双采结果）
    const clawCpuPercent = typeof frame.clawCpuPercent === 'number' ? frame.clawCpuPercent : 0;

    // load 从 sysInfo.load 读取（"1.23 0.45 0.67"）
    const loadAvgRaw = sysInfo?.load as string ?? sysInfo?.loadAvg as string ?? '0';

    // 映射到 GnbMonitor 内部状态格式
    const state = {
      online: true,
      lastUpdate: now,
      sshLatencyMs: 0,
      core: { tunAddr: frame.gnbTunAddr || '' },
      nodes: gnbPeers,
      addresses: gnbAddresses ? gnbAddresses.split('\n').filter(Boolean) : [],
      gnbStatus,     // 原始 gnb_ctl -s 输出，前端拓扑图解析用
      sysInfo: sysInfo ? {
        hostname:   sysInfo.hostname,
        os:         sysInfo.os,
        kernel:     sysInfo.kernel,
        arch:       sysInfo.arch,
        cpuModel:   sysInfo.cpuModel,
        cpuCores:   sysInfo.cpuCores,
        cpuUsage:   sysInfo.cpuPercent,
        memTotalMB: sysInfo.memTotalMb,
        memUsedMB:  sysInfo.memUsedMb,
        diskUsePct: sysInfo.diskPercent ? `${sysInfo.diskPercent}%` : '0%',
        uptime:     sysInfo.uptimeSec,
        loadAvg:    loadAvgRaw,
      } : {},
      openclaw: {
        status:         clawRunning ? 'running' : 'stopped',
        running:        clawRunning,
        rpcOk:          clawRpcOk,
        cpuPercent:     clawCpuPercent,       // ← 新增 CPU 占用
      },
      skills: installedSkills,      // ← 真实 skills 数据（取代空数组）
      daemonHeartbeat: true,
      error: null as string | null,
    };

    this.latestState.set(nodeId, state);

    // OpenClaw token 自动发现
    const clawToken = frame.clawToken as string | undefined;
    if (clawToken) {
      const nodeConfig = this.nodesConfig.find(n => n.id === nodeId);
      if (nodeConfig && (!nodeConfig.clawToken || nodeConfig.clawToken !== clawToken)) {
        this.emit('clawDiscovered', { nodeId, token: clawToken, port: frame.clawPort });
      }
    }

    // 记录指标（含真实 loadAvg）
    if (this.metricsStore && sysInfo) {
      (this.metricsStore as { record: (id: string, data: Record<string, unknown>) => void }).record(nodeId, {
        cpu:        sysInfo.cpuPercent ?? 0,
        memPct:     sysInfo.memPercent ?? 0,
        diskPct:    sysInfo.diskPercent ?? 0,
        sshLatency: 0,
        loadAvg:    loadAvgRaw,
        p2pDirect:  gnbPeers.filter((p: unknown) => (p as Record<string, unknown>).status === 'Direct').length,
        p2pTotal:   gnbPeers.length,
        memTotalMB: sysInfo.memTotalMb ?? 0,
        memUsedMB:  sysInfo.memUsedMb ?? 0,
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
   * 注入 SSH 管理器（延迟注入，避免循环依赖）
   */
  setSshManager(mgr: { getConnection(cfg: Record<string, unknown>): Promise<unknown> }) {
    this._sshManager = mgr;
  }

  /**
   * daemon WSS 断开时调用 — 先标记 probing 状态，主动探测后再决定是否离线
   *
   * 流程：probing → ping TUN IP → SSH 连接 → 全失败才标记 offline
   *
   * @param {string} nodeId - 节点 ID
   * @param {string} reason - 触发原因
   */
  markOffline(nodeId: string, reason = 'daemon WS 断开') {
    // 防重入：同一节点只允许一次探测
    if (this._probing.has(nodeId)) {
      log.debug(`probeNode 已在执行中，跳过: ${nodeId}`);
      return;
    }

    const state = this.latestState.get(nodeId);
    if (state) {
      state.wsConnected = false;
      state.pingMs = null;
      state.error = `${reason} — 探测中...`;
      // 保持 online: true，但标记 probing 状态让前端感知
      state.probing = true;
    } else {
      this.latestState.set(nodeId, {
        online: true,
        wsConnected: false,
        pingMs: null,
        probing: true,
        lastUpdate: new Date().toISOString(),
        error: `${reason} — 探测中...`,
      });
    }
    log.info(`WSS 断联，启动主动探测: ${nodeId}`);
    this.emit('update', this.getAllStatus());

    // 异步探测
    this._probeNode(nodeId, reason);
  }

  /**
   * 直接标记离线（探测失败时的最终动作）
   * @private
   */
  _forceOffline(nodeId: string, reason: string) {
    const state = this.latestState.get(nodeId);
    if (state) {
      state.online = false;
      state.wsConnected = false;
      state.probing = false;
      state.pingMs = null;
      state.error = reason;
    }
    log.info(`节点确认离线: ${nodeId} (${reason})`);
    this.emit('stale', nodeId);
    // 外部告警
    const cfg = this.nodesConfig.find((n: NodeConfig) => n.id === nodeId);
    alertingGateway.alertNodeOffline(nodeId, cfg?.name || nodeId);
    this.emit('update', this.getAllStatus());
  }

  /**
   * 主动探测节点可达性（ping TUN IP + SSH 连接）
   *
   * 逻辑：
   * 1. ping -c 2 -W 3 TUN_IP（3 秒超时）
   * 2. SSH 连接测试（getConnection，5 秒超时）
   * 3. 两项全失败 → 标记 offline
   * 4. 任一成功 → 恢复 online（daemon 自身可能崩溃但节点活着）
   *
   * @private
   */
  async _probeNode(nodeId: string, triggerReason: string) {
    this._probing.add(nodeId);
    const nodeConfig = this.nodesConfig.find(n => n.id === nodeId);
    const tunAddr = nodeConfig?.tunAddr;

    if (!tunAddr) {
      log.warn(`无 TUN 地址，直接标记离线: ${nodeId}`);
      this._probing.delete(nodeId);
      this._forceOffline(nodeId, `${triggerReason} — 无可探测地址`);
      return;
    }

    log.info(`探测 ${nodeId}: ping ${tunAddr} + SSH...`);

    // 并行执行 ping 和 SSH
    const [pingOk, sshOk] = await Promise.all([
      this._probePing(tunAddr),
      this._probeSsh(nodeConfig),
    ]);

    this._probing.delete(nodeId);

    if (pingOk || sshOk) {
      // 节点活着，daemon 可能崩溃了
      const state = this.latestState.get(nodeId);
      if (state) {
        state.online = true;
        state.probing = false;
        state.error = `daemon 断联，但节点可达 (ping=${pingOk ? '✓' : '✗'} ssh=${sshOk ? '✓' : '✗'})`;
      }
      log.info(`探测结果: ${nodeId} 可达 (ping=${pingOk}, ssh=${sshOk})，保持在线`);
      this.emit('update', this.getAllStatus());
    } else {
      // 全部失败，确认离线
      this._forceOffline(nodeId, `${triggerReason} — 探测失败 (ping=✗ ssh=✗)`);
    }
  }

  /**
   * Ping 探测
   * @private
   * @returns {Promise<boolean>} true=可达
   */
  _probePing(ip: string): Promise<boolean> {
    return new Promise(resolve => {
      // -c 2: 发两个包; -W 3: 每包 3 秒超时
      exec(`ping -c 2 -W 3 ${ip}`, { timeout: 8000 }, (err: Error | null) => {
        resolve(!err);
      });
    });
  }

  /**
   * SSH 连接探测
   * @private
   * @returns {Promise<boolean>} true=可连接
   */
  async _probeSsh(nodeConfig: NodeConfig | undefined): Promise<boolean> {
    if (!this._sshManager || !nodeConfig) return false;
    try {
      // getConnection 有 30s 内部超时，这里用 Promise.race 限制到 5s
      await Promise.race([
        this._sshManager.getConnection(nodeConfig as unknown as Record<string, unknown>),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SSH 探测超时')), 5000)),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查超时节点，标记为离线
   * @private
   */
  _checkStale() {
    const now = Date.now();
    for (const [nodeId, state] of this.latestState) {
      if (!state.online) continue;
      // daemon 节点由 WSS close 事件即时驱动离线，无需 stale 定时器介入
      if (state.daemonHeartbeat) continue;
      const lastMs = new Date(state.lastUpdate).getTime();
      if (now - lastMs > this.staleTimeoutMs) {
        state.online = false;
        state.error = `节点不可达 — 超过 ${Math.round(this.staleTimeoutMs / 1000)}s 无上报`;
        this.emit('stale', nodeId);
        // WH3: 节点离线外部告警
        const cfg = this.nodesConfig.find((n: NodeConfig) => n.id === nodeId);
        alertingGateway.alertNodeOffline(nodeId, cfg?.name || nodeId);
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
