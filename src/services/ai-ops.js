'use strict';

/**
 * AI 运维服务 — 内置命令路由器
 *
 * 不依赖外部 AI API，通过关键词匹配将用户指令路由到
 * Provisioner（SSH 执行）或直接返回节点状态。
 *
 * 支持的指令：
 *   - "安装 openclaw [节点ID]" → provisioner.provision(node, {installGnb:false})
 *   - "配置下发 [节点ID]"      → provisioner.provision(node)
 *   - "状态"                   → 返回所有节点状态
 *   - "重启 gnb [节点ID]"      → SSH 执行 systemctl restart gnb
 *   - "日志 [节点ID]"          → SSH 获取 journalctl 日志
 *   - 其他                     → 返回帮助信息
 */
class AiOps {
  /**
   * @param {object} options
   * @param {Array} options.nodesConfig - 节点配置
   * @param {import('./ssh-manager')} options.sshManager
   * @param {Function} options.getNodeStatus - 获取节点状态的回调
   * @param {import('./provisioner')} options.provisioner
   */
  constructor(options) {
    this.nodesConfig = options.nodesConfig;
    this.sshManager = options.sshManager;
    this.getNodeStatus = options.getNodeStatus;
    this.provisioner = options.provisioner;
  }

  /**
   * 处理用户指令
   * @param {string} userMessage
   * @returns {Promise<object>}
   */
  async chat(userMessage) {
    const msg = (userMessage || '').trim();
    if (!msg) return { response: '请输入指令', commands: [] };

    // 解析节点 ID（可能在消息末尾或消息中）
    const nodeId = this._extractNodeId(msg);

    // --- 指令路由 ---

    // 安装 OpenClaw
    if (/安装\s*(openclaw|claw)/i.test(msg)) {
      return this._handleInstallClaw(nodeId);
    }

    // 完整配置下发
    if (/配置下发|provision|部署/i.test(msg)) {
      return this._handleProvision(nodeId);
    }

    // 查看状态
    if (/状态|status|info/i.test(msg)) {
      return this._handleStatus(nodeId);
    }

    // 重启 GNB
    if (/重启\s*(gnb|服务)|restart/i.test(msg)) {
      return this._handleRestart(nodeId, 'gnb');
    }

    // 重启 OpenClaw
    if (/重启\s*(openclaw|claw)/i.test(msg)) {
      return this._handleRestart(nodeId, 'openclaw-gateway');
    }

    // 查看日志
    if (/日志|log|journal/i.test(msg)) {
      return this._handleLogs(nodeId);
    }

    // 执行自定义命令: "exec <nodeId> <command>"
    if (/^(exec|run|执行)\s/i.test(msg)) {
      return this._handleExec(msg);
    }

    // 帮助
    return this._handleHelp();
  }

  // --- 指令处理 ---

  async _handleInstallClaw(nodeId) {
    const nodeConfig = this._resolveNode(nodeId);
    if (!nodeConfig) return { response: this._nodeNotFoundMsg(nodeId), commands: [] };

    this.provisioner.provision(nodeConfig, { installGnb: false, installClaw: true });
    return {
      response: `🚀 开始在 ${nodeConfig.name || nodeConfig.id} 上安装 OpenClaw...\n安装进度将实时推送到此面板。`,
      commands: [],
      targetNodeId: nodeConfig.id,
    };
  }

  async _handleProvision(nodeId) {
    const nodeConfig = this._resolveNode(nodeId);
    if (!nodeConfig) return { response: this._nodeNotFoundMsg(nodeId), commands: [] };

    this.provisioner.provision(nodeConfig);
    return {
      response: `🚀 开始对 ${nodeConfig.name || nodeConfig.id} 执行完整配置下发...\n包含：系统准备 → GNB → OpenClaw → 验证`,
      commands: [],
      targetNodeId: nodeConfig.id,
    };
  }

  async _handleStatus(nodeId) {
    const allStatus = this.getNodeStatus();
    if (nodeId) {
      const node = allStatus.find(n => n.id === nodeId);
      if (!node) return { response: this._nodeNotFoundMsg(nodeId), commands: [] };
      return { response: this._formatNodeStatus(node), commands: [] };
    }
    if (!allStatus.length) return { response: '当前无已接入节点', commands: [] };
    const lines = allStatus.map(n => {
      const dot = n.online ? '🟢' : '🔴';
      return `${dot} ${n.name || n.id} (${n.tunAddr}) — ${n.online ? `${n.sshLatencyMs}ms` : '离线'}`;
    });
    return { response: `节点状态：\n${lines.join('\n')}`, commands: [] };
  }

  async _handleRestart(nodeId, service) {
    const nodeConfig = this._resolveNode(nodeId);
    if (!nodeConfig) return { response: this._nodeNotFoundMsg(nodeId), commands: [] };

    try {
      const result = await this.sshManager.exec(nodeConfig, `systemctl restart ${service} && sleep 1 && systemctl is-active ${service}`);
      return { response: `✅ ${service} 已重启: ${result.stdout.trim()}`, commands: [], targetNodeId: nodeConfig.id };
    } catch (err) {
      return { response: `❌ 重启失败: ${err.message}`, commands: [], targetNodeId: nodeConfig.id };
    }
  }

  async _handleLogs(nodeId) {
    const nodeConfig = this._resolveNode(nodeId);
    if (!nodeConfig) return { response: this._nodeNotFoundMsg(nodeId), commands: [] };

    try {
      const result = await this.sshManager.exec(nodeConfig, 'journalctl -u gnb -u openclaw-gateway --no-pager -n 20 --output short-iso');
      return { response: `📋 最近日志:\n\`\`\`\n${result.stdout.trim()}\n\`\`\``, commands: [], targetNodeId: nodeConfig.id };
    } catch (err) {
      return { response: `❌ 获取日志失败: ${err.message}`, commands: [], targetNodeId: nodeConfig.id };
    }
  }

  async _handleExec(msg) {
    // 格式: exec <nodeId> <command>
    const parts = msg.replace(/^(exec|run|执行)\s+/i, '').trim();
    const spaceIdx = parts.indexOf(' ');
    if (spaceIdx < 0) return { response: '格式: exec <节点ID> <命令>', commands: [] };

    const nodeId = parts.substring(0, spaceIdx);
    const command = parts.substring(spaceIdx + 1);
    const nodeConfig = this._resolveNode(nodeId);
    if (!nodeConfig) return { response: this._nodeNotFoundMsg(nodeId), commands: [] };

    try {
      const result = await this.sshManager.exec(nodeConfig, command, 30000);
      let output = result.stdout.trim();
      if (result.stderr.trim()) output += `\n[STDERR] ${result.stderr.trim()}`;
      return { response: `\`\`\`\n${output || '(空输出)'}\n\`\`\``, commands: [] };
    } catch (err) {
      return { response: `❌ 执行失败: ${err.message}`, commands: [] };
    }
  }

  _handleHelp() {
    return {
      response: `📖 可用指令：
• 安装 openclaw <节点ID> — 在终端安装 OpenClaw
• 配置下发 <节点ID> — 完整配置下发（GNB + OpenClaw）
• 状态 [节点ID] — 查看节点状态
• 重启 gnb <节点ID> — 重启 GNB 服务
• 重启 openclaw <节点ID> — 重启 OpenClaw
• 日志 <节点ID> — 查看最近日志
• exec <节点ID> <命令> — 执行自定义命令`,
      commands: [],
    };
  }

  // --- 工具方法 ---

  _extractNodeId(msg) {
    // 尝试从消息中提取节点 ID
    // 支持格式: "安装 openclaw VM-0-16-debian", "安装 openclaw 到 VM-0-16-debian"
    const cleaned = msg.replace(/^(安装|配置下发|重启|日志|状态)\s*(openclaw|claw|gnb|服务)?\s*(到|on|for)?\s*/i, '').trim();
    if (cleaned && !cleaned.includes(' ')) return cleaned;

    // 如果只有一个节点，直接使用
    if (this.nodesConfig.length === 1) return this.nodesConfig[0].id;

    return null;
  }

  _resolveNode(nodeId) {
    if (!nodeId) {
      // 如果只有一个节点，自动选择
      if (this.nodesConfig.length === 1) return this.nodesConfig[0];
      return null;
    }
    return this.nodesConfig.find(n => n.id === nodeId || n.name === nodeId);
  }

  _nodeNotFoundMsg(nodeId) {
    if (!nodeId) {
      const ids = this.nodesConfig.map(n => n.id).join(', ');
      return `请指定节点 ID。可用节点: ${ids || '无'}`;
    }
    return `节点 "${nodeId}" 未找到`;
  }

  _formatNodeStatus(node) {
    const lines = [
      `${node.online ? '🟢' : '🔴'} ${node.name || node.id}`,
      `TUN: ${node.tunAddr}`,
      `SSH: ${node.sshLatencyMs > 0 ? node.sshLatencyMs + 'ms' : '不可达'}`,
    ];
    if (node.sysInfo) {
      const si = node.sysInfo;
      if (si.os) lines.push(`OS: ${si.os}`);
      if (si.cpuModel) lines.push(`CPU: ${si.cpuModel} (${si.cpuCores}核)`);
      if (si.memTotalMB) lines.push(`内存: ${si.memUsedMB}/${si.memTotalMB}MB`);
      if (si.diskTotal) lines.push(`磁盘: ${si.diskUsed}/${si.diskTotal} (${si.diskUsePct})`);
      if (si.loadAvg) lines.push(`负载: ${si.loadAvg}`);
      if (si.uptime) lines.push(`运行: ${si.uptime}`);
    }
    return lines.join('\n');
  }

  /**
   * 兼容旧 API — 确认执行（不再需要，保留空实现）
   */
  async confirmAndExec() {
    return [{ error: '此版本无需确认，指令直接执行' }];
  }
}

module.exports = AiOps;
