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
      // 执行 gnb_ctl -b <gnb.map> -s 获取节点状态
      const statusCmd = `${nodeConfig.gnbCtlPath || 'gnb_ctl'} -b ${nodeConfig.gnbMapPath} -s`;
      const statusResult = await this.sshManager.exec(nodeConfig, statusCmd);

      // 执行 gnb_ctl -b <gnb.map> -a 获取地址列表
      const addrCmd = `${nodeConfig.gnbCtlPath || 'gnb_ctl'} -b ${nodeConfig.gnbMapPath} -a`;
      const addrResult = await this.sshManager.exec(nodeConfig, addrCmd);

      const statusData = parseGnbCtlStatus(statusResult.stdout);
      const addrData = parseGnbCtlAddressList(addrResult.stdout);

      const elapsed = Date.now() - startTime;

      this.latestState.set(nodeConfig.id, {
        online: true,
        lastUpdate: new Date().toISOString(),
        sshLatencyMs: elapsed,
        core: statusData.core,
        nodes: statusData.nodes,
        addresses: addrData,
        error: null,
      });
    } catch (err) {
      this.latestState.set(nodeConfig.id, {
        online: false,
        lastUpdate: new Date().toISOString(),
        sshLatencyMs: -1,
        core: {},
        nodes: [],
        addresses: [],
        error: err.message,
      });
    }
  }
}

module.exports = GnbMonitor;
