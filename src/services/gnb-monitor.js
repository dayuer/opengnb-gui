'use strict';

const EventEmitter = require('events');
const SSHManager = require('./ssh-manager');
const { parseGnbCtlStatus, parseGnbCtlAddressList } = require('./gnb-parser');

/**
 * GNB 节点监控服务
 * 定时通过 SSH 执行 gnb_ctl 采集各节点状态
 */
class GnbMonitor extends EventEmitter {
  /**
   * @param {Array} nodesConfig - 节点配置数组
   * @param {object} [options]
   * @param {number} [options.intervalMs=10000] - 采集间隔
   */
  constructor(nodesConfig, options = {}) {
    super();
    this.nodesConfig = nodesConfig;
    this.intervalMs = options.intervalMs || 10000;
    this.sshManager = new SSHManager();

    /** @type {Map<string, object>} 最新的节点状态快照 */
    this.latestState = new Map();

    /** @type {Map<string, number>} 节点连续 SSH 失败计数 */
    this._failCounts = new Map();
    /** @type {number} 上次 GNB 自动重启时间戳 */
    this._lastGnbRestart = 0;

    this._timer = null;
  }

  /**
   * 启动监控循环
   */
  start() {
    console.log(`[GnbMonitor] 启动，${this.nodesConfig.length} 个节点，间隔 ${this.intervalMs}ms`);
    this._poll();
    this._timer = setInterval(() => this._poll(), this.intervalMs);
  }

  /**
   * 停止监控
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.sshManager.closeAll();
    console.log('[GnbMonitor] 已停止');
  }

  /**
   * 获取所有节点最新状态
   * @returns {Array<object>}
   */
  getAllStatus() {
    const result = [];
    for (const [id, state] of this.latestState) {
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
  getNodeStatus(nodeId) {
    const state = this.latestState.get(nodeId);
    if (!state) return null;
    const config = this.nodesConfig.find(n => n.id === nodeId);
    return { id: nodeId, name: config?.name || nodeId, tunAddr: config?.tunAddr || '', ...state };
  }

  /**
   * 单次轮询所有节点
   * @private
   */
  async _poll() {
    const promises = this.nodesConfig.map(node => this._pollNode(node));
    await Promise.allSettled(promises);
    this.emit('update', this.getAllStatus());
  }

  /**
   * 采集单个节点状态
   * @private
   */
  async _pollNode(nodeConfig) {
    const startTime = Date.now();

    try {
      // 1) gnb_ctl 状态
      const statusCmd = `${nodeConfig.gnbCtlPath || 'gnb_ctl'} -b ${nodeConfig.gnbMapPath} -s`;
      const statusResult = await this.sshManager.exec(nodeConfig, statusCmd);

      // 2) gnb_ctl 地址列表
      const addrCmd = `${nodeConfig.gnbCtlPath || 'gnb_ctl'} -b ${nodeConfig.gnbMapPath} -a`;
      const addrResult = await this.sshManager.exec(nodeConfig, addrCmd);

      // 3) 系统信息 — 一条命令采集全部
      const sysCmd = [
        'echo "::HOSTNAME::$(hostname)"',
        'echo "::OS::$(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d \\")"',
        'echo "::KERNEL::$(uname -r)"',
        'echo "::ARCH::$(uname -m)"',
        'echo "::UPTIME::$(uptime -p 2>/dev/null || uptime)"',
        'echo "::LOAD::$(cat /proc/loadavg 2>/dev/null | cut -d" " -f1-3 || sysctl -n vm.loadavg 2>/dev/null)"',
        'echo "::CPU_MODEL::$(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs || sysctl -n machdep.cpu.brand_string 2>/dev/null)"',
        'echo "::CPU_CORES::$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"',
        'echo "::MEM::$(free -m 2>/dev/null | awk \'NR==2{printf "%s %s %s", $2, $3, $7}\' || echo "")"',
        'echo "::DISK::$(df -h / 2>/dev/null | awk \'NR==2{printf "%s %s %s %s", $2, $3, $4, $5}\')"',
      ].join(' && ');
      const sysResult = await this.sshManager.exec(nodeConfig, sysCmd);
      const sysInfo = this._parseSysInfo(sysResult.stdout);

      const statusData = parseGnbCtlStatus(statusResult.stdout);
      const addrData = parseGnbCtlAddressList(addrResult.stdout);
      const elapsed = Date.now() - startTime;

      // 连接恢复，重置失败计数
      this._failCounts.set(nodeConfig.id, 0);

      this.latestState.set(nodeConfig.id, {
        online: true,
        lastUpdate: new Date().toISOString(),
        sshLatencyMs: elapsed,
        core: statusData.core,
        nodes: statusData.nodes,
        addresses: addrData,
        sysInfo,
        error: null,
      });
    } catch (err) {
      // 递增连续失败计数
      const prevFails = this._failCounts.get(nodeConfig.id) || 0;
      this._failCounts.set(nodeConfig.id, prevFails + 1);

      this.latestState.set(nodeConfig.id, {
        online: false,
        lastUpdate: new Date().toISOString(),
        sshLatencyMs: -1,
        core: {},
        nodes: [],
        addresses: [],
        sysInfo: {},
        error: err.message,
      });

      // 连续失败 >= 3 次 (约 30s) → 自动重启 Console GNB 强制 P2P 重新发现
      if (prevFails + 1 >= 3) {
        this._tryRecoverGnb(nodeConfig.id, prevFails + 1);
      }
    }
  }

  /**
   * 尝试重启本地 GNB 以恢复 P2P 隧道
   * 根因: 终端重启/OOM 后 Console GNB 的 P2P 打洞状态失效，
   *       需要重启才能通过 index 节点重新发现对端
   * @private
   */
  async _tryRecoverGnb(nodeId, failCount) {
    // 防止频繁重启: 每 60s 最多一次
    const now = Date.now();
    if (now - this._lastGnbRestart < 60000) return;
    this._lastGnbRestart = now;

    console.log(`[GnbMonitor] 节点 ${nodeId} 连续 ${failCount} 次不可达，重启 GNB 尝试恢复 P2P 隧道...`);
    try {
      const { execSync } = require('child_process');
      execSync('sudo systemctl restart gnb 2>/dev/null || true', { timeout: 15000 });
      console.log('[GnbMonitor] GNB 已重启，等待 P2P 重新发现');
      // 重置该节点失败计数（给恢复留时间）
      this._failCounts.set(nodeId, 0);
    } catch (e) {
      console.error(`[GnbMonitor] GNB 重启失败: ${e.message}`);
    }
  }

  /**
   * 解析系统信息输出
   * @private
   */
  _parseSysInfo(stdout) {
    const info = {};
    const lines = (stdout || '').split('\n');
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
      }
    }
    return info;
  }
}

module.exports = GnbMonitor;
