'use strict';

const { execFile, spawn } = require('node:child_process');

/**
 * AI 运维服务 — 内置命令路由器
 *
 * 不依赖外部 AI API，通过关键词匹配将用户指令路由到
 * Provisioner（SSH 执行）或直接返回节点状态。
 *
 * 支持的指令：
 *   - 内置快捷：状态/重启/日志/磁盘/性能/安装 openclaw/配置下发
 *   - 直接执行 Linux 命令（经过危险指令黑名单过滤）
 *   - exec <nodeId> <cmd> — 指定节点执行
 */

// ——— 危险命令黑名单 ———
// 每个条目: { pattern: RegExp, reason: string }
// 注意：匹配前会将命令转小写，并去除变量展开等混淆手法
const BLOCKED_PATTERNS = [
  // 文件系统破坏
  { pattern: /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive|--no-preserve-root)/i, reason: '禁止强制/递归删除' },
  { pattern: /\brm\s+(-[a-z]*\s+)?\//,  reason: '禁止删除根目录' },
  { pattern: /\bmkfs\b/i,                reason: '禁止格式化磁盘' },
  { pattern: /\bdd\s+.*of\s*=\s*\/dev/i, reason: '禁止 dd 写入设备' },
  { pattern: /\bshred\b/i,               reason: '禁止安全擦除' },
  { pattern: /\bwipefs\b/i,              reason: '禁止擦除文件系统签名' },

  // 系统关机/重启
  { pattern: /\b(shutdown|poweroff|halt|init\s+0)\b/i, reason: '禁止关机' },
  { pattern: /\breboot\b/i,              reason: '禁止重启系统' },

  // 用户/权限操作
  { pattern: /\b(userdel|groupdel)\b/i,  reason: '禁止删除用户/组' },
  { pattern: /\bpasswd\b/i,              reason: '禁止修改密码' },
  { pattern: /\bchmod\s+(-[a-z]*\s+)?0?777\b/i, reason: '禁止全开权限' },
  { pattern: /\bchown\s+.*\s+\//i,       reason: '禁止根目录 chown' },
  { pattern: /\bvisudo\b/i,              reason: '禁止编辑 sudoers' },

  // 网络危险操作
  { pattern: /\biptables\s+(-[a-z]*\s+)*-F\b/i, reason: '禁止清空防火墙规则' },
  { pattern: /\bnft\s+flush\b/i,         reason: '禁止清空 nftables' },
  { pattern: /\bifconfig\s+.*\s+down\b/i, reason: '禁止关闭网卡' },
  { pattern: /\bip\s+link\s+.*\s+down\b/i, reason: '禁止关闭网卡' },

  // 包管理危险操作
  { pattern: /\b(yum|apt|dnf|rpm)\s+(remove|purge|erase)\b/i, reason: '禁止卸载软件包' },

  // 危险 shell 操作
  { pattern: /\>\s*\/dev\/sd[a-z]/i,     reason: '禁止覆写磁盘设备' },
  { pattern: /\|\s*bash\b/i,             reason: '禁止管道到 bash（远程代码执行风险）' },
  { pattern: /\bcurl\b.*\|\s*(sh|bash)/i, reason: '禁止 curl 管道执行' },
  { pattern: /\bwget\b.*\|\s*(sh|bash)/i, reason: '禁止 wget 管道执行' },
  { pattern: /:(\){\s*:|\(\)\{)/,        reason: '禁止 fork 炸弹' },
  { pattern: /\beval\b/i,                reason: '禁止 eval（代码注入风险）' },
  { pattern: /\bnohup\b/i,               reason: '禁止后台驻留进程' },
  
  // 内核/系统核心
  { pattern: /\binsmod\b|\brmmod\b|\bmodprobe\s+-r\b/i, reason: '禁止内核模块操作' },
  { pattern: /\/proc\/sys|sysctl\s+-w/i, reason: '禁止修改内核参数' },
  { pattern: /\bkill\s+(-9\s+)?(-1|1)\b/i, reason: '禁止杀死所有进程' },
  { pattern: /\bkillall\b/i,             reason: '禁止批量杀进程' },
];
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
    // @beta: 异步命令框架依赖
    this.jobManager = options.jobManager || null;
    this.callbackBaseUrl = options.callbackBaseUrl || '';
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

    // 磁盘
    if (/磁盘|disk|df/i.test(msg)) {
      return this._handleDisk(nodeId);
    }

    // 性能
    if (/性能|perf|performance|负载|load/i.test(msg)) {
      return this._handlePerformance(nodeId);
    }

    // Claude Code AI 助手: "@claude <prompt>" 或 "claude <prompt>"
    if (/^@?claude\s+/i.test(msg)) {
      const prompt = msg.replace(/^@?claude\s+/i, '').trim();
      return this._handleClaude(prompt, nodeId);
    }

    // 执行自定义命令: "exec <nodeId> <command>"
    if (/^(exec|run|执行)\s/i.test(msg)) {
      return this._handleExec(msg);
    }

    // @beta: 异步执行: "async exec <nodeId> <command>"
    if (/^async\s+(exec|run)\s/i.test(msg)) {
      return this._handleAsyncExec(msg);
    }

    // 帮助
    if (/^(help|帮助|\?)$/i.test(msg)) {
      return this._handleHelp();
    }

    // @security: 不再将未识别的文本作为 shell 命令自动执行（安全审计 C2 修复）
    return {
      response: `❓ 未识别的指令: \`${msg.substring(0, 80)}\`\n\n请使用以下方式:\n• 输入 **help** 查看内置指令\n• 使用 **exec \<节点ID\> \<命令\>** 执行远程命令\n• 使用 **@claude \<问题\>** 调用 AI 助手`,
      commands: [],
    };
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

  async _handleDisk(nodeId) {
    const nodeConfig = this._resolveNode(nodeId);
    if (!nodeConfig) return { response: this._nodeNotFoundMsg(nodeId), commands: [] };
    try {
      const result = await this.sshManager.exec(nodeConfig, 'df -h && echo "---" && du -sh /var/log/* 2>/dev/null | sort -rh | head -5');
      return { response: `💾 磁盘使用:\n\`\`\`\n${result.stdout.trim()}\n\`\`\``, commands: [], targetNodeId: nodeConfig.id };
    } catch (err) {
      return { response: `❌ 获取磁盘信息失败: ${err.message}`, commands: [], targetNodeId: nodeConfig.id };
    }
  }

  async _handlePerformance(nodeId) {
    const nodeConfig = this._resolveNode(nodeId);
    if (!nodeConfig) return { response: this._nodeNotFoundMsg(nodeId), commands: [] };
    try {
      const result = await this.sshManager.exec(nodeConfig, 'echo "=== 负载 ==="; uptime; echo "\\n=== CPU ==="; top -bn1 | head -5; echo "\\n=== 内存 ==="; free -h; echo "\\n=== IO ==="; iostat -x 1 1 2>/dev/null || echo "iostat 不可用"');
      return { response: `⚡ 性能概况:\n\`\`\`\n${result.stdout.trim()}\n\`\`\``, commands: [], targetNodeId: nodeConfig.id };
    } catch (err) {
      return { response: `❌ 获取性能信息失败: ${err.message}`, commands: [], targetNodeId: nodeConfig.id };
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

    const blocked = this._checkCommandSafety(command);
    if (blocked) return blocked;

    try {
      const result = await this.sshManager.exec(nodeConfig, command, 30000);
      let output = result.stdout.trim();
      if (result.stderr.trim()) output += `\n[STDERR] ${result.stderr.trim()}`;
      return { response: `\`\`\`\n${output || '(空输出)'}\n\`\`\``, commands: [] };
    } catch (err) {
      return { response: `❌ 执行失败: ${err.message}`, commands: [] };
    }
  }

  /**
   * 调用 Claude Code CLI
   */
  async _handleClaude(prompt, nodeId) {
    if (!prompt) return { response: '用法: @claude <你的问题或任务>', commands: [] };

    // 拼接节点上下文
    let systemCtx = '你是服务器运维 AI 助手。当前工作目录: /opt/gnb-console。';
    const nodeConfig = this._resolveNode(nodeId) || this._resolveNode(null);
    if (nodeConfig) {
      systemCtx += ` 当前节点: ${nodeConfig.name || nodeConfig.id} (${nodeConfig.host || 'unknown'})。`;
    }

    const args = [
      '-p', prompt,
      '--bare',
      '--append-system-prompt', systemCtx,
      '--allowedTools', 'Bash(ls:*) Bash(cat:*) Bash(grep:*) Bash(find:*) Bash(head:*) Bash(tail:*) Bash(wc:*) Bash(df:*) Bash(du:*) Bash(free:*) Bash(uptime:*) Bash(top:*) Bash(ps:*) Bash(netstat:*) Bash(ss:*) Bash(systemctl:*) Bash(journalctl:*) Bash(ip:*) Bash(ping:*) Bash(curl:*) Read',
    ];

    return new Promise((resolve) => {
      const nodeBin = process.execPath.replace(/\/[^/]+$/, ''); // 当前 node 路径的 bin 目录
      const extraPaths = [
        nodeBin,
        '/root/.nvm/versions/node/v24.14.0/bin',
        '/usr/local/bin',
      ].join(':');

      execFile('claude', args, {
        cwd: '/opt/gnb-console',
        timeout: 120_000,
        maxBuffer: 1024 * 512,
        env: { ...process.env, NO_COLOR: '1', PATH: `${extraPaths}:${process.env.PATH || ''}` },
      }, (err, stdout, stderr) => {
        if (err) {
          const msg = err.killed
            ? '❌ Claude 执行超时（2 分钟）'
            : `❌ Claude 执行失败: ${err.message}`;
          return resolve({ response: msg, commands: [] });
        }
        const output = (stdout || '').trim() || '(空输出)';
        resolve({
          response: `🤖 Claude:\n${output}`,
          commands: [],
          targetNodeId: nodeConfig?.id,
        });
      });
    });
  }

  // @alpha: 流式 Claude Code 调用 — 供 /ws/ai 使用
  streamChat(nodeConfig, prompt, onChunk) {
    const nodeBin = process.execPath.replace(/\/[^/]+$/, '');
    const extraPaths = [nodeBin, '/root/.nvm/versions/node/v24.14.0/bin', '/usr/local/bin'].join(':');

    const sshTarget = nodeConfig
      ? `${nodeConfig.sshUser || 'synon'}@${nodeConfig.tunAddr}`
      : null;
    const sshCmd = sshTarget
      ? `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${nodeConfig.sshPort || 22} ${sshTarget}`
      : null;
    const systemCtx = [
      '你是一个服务器运维 AI 助手。你运行在非交互式 headless 环境中——用户无法看到你的中间提问，也无法回答你的问题。',
      '【关键规则】',
      '1. 绝对不要向用户提问或等待确认。直接执行用户的请求。',
      '2. 绝对不要输出类似"请确认"、"你想要我..."、"是否继续"等交互性文字。',
      '3. 如果指令不明确，按最合理的默认方式直接执行，而非询问用户。',
      '4. 使用中文回答。简洁专业，直接给出结果和分析。',
      nodeConfig ? `当前管理节点: ${nodeConfig.name || nodeConfig.id}` : '',
      sshCmd ? `SSH 连接命令: ${sshCmd} "<命令>"` : '',
      sshCmd ? `所有远程命令必须通过上述 SSH 命令执行。直接调用 Bash 工具，命令格式: ${sshCmd} "<你要执行的命令>"` : '',
      '执行完命令后，简洁地分析结果并给出建议。不要重复执行相同的命令。',
    ].filter(Boolean).join('\n');

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--bare',
      '--append-system-prompt', systemCtx,
      '--allowedTools', 'Bash',
      '--permission-mode', 'auto',
      '--max-budget-usd', '0.5',
    ];

    const child = spawn('claude', args, {
      cwd: '/opt/gnb-console',
      env: { ...process.env, NO_COLOR: '1', PATH: `${extraPaths}:${process.env.PATH || ''}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 立即关闭 stdin — 避免 Claude 等待 3s stdin 超时
    child.stdin.end();

    let buf = '';
    child.stdout.on('data', (data) => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { onChunk(JSON.parse(line)); } catch (_) { /* 非 JSON 行忽略 */ }
      }
    });

    child.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) onChunk({ type: 'system', text: msg });
    });

    child.on('close', (code) => {
      // 处理缓冲区剩余
      if (buf.trim()) {
        try { onChunk(JSON.parse(buf)); } catch (_) {}
      }
      onChunk({ type: 'done', exitCode: code || 0 });
    });

    child.on('error', (err) => {
      onChunk({ type: 'error', text: `Claude 启动失败: ${err.message}` });
    });

    return { kill: () => { try { child.kill('SIGTERM'); } catch (_) {} } };
  }

  // @security: _handleDirectCmd 已移除（安全审计 C2 修复）
  // 未识别的命令不再自动作为 shell 命令执行

  // @beta: 异步执行命令
  async _handleAsyncExec(msg) {
    if (!this.jobManager) {
      return { response: '❌ 异步命令框架未初始化', commands: [] };
    }

    const parts = msg.replace(/^async\s+(exec|run)\s+/i, '').trim();
    const spaceIdx = parts.indexOf(' ');
    if (spaceIdx < 0) return { response: '格式: async exec <节点ID> <命令>', commands: [] };

    const nodeId = parts.substring(0, spaceIdx);
    const command = parts.substring(spaceIdx + 1);
    const nodeConfig = this._resolveNode(nodeId);
    if (!nodeConfig) return { response: this._nodeNotFoundMsg(nodeId), commands: [] };

    const blocked = this._checkCommandSafety(command);
    if (blocked) return blocked;

    const { jobId } = this.jobManager.create(nodeConfig.id, command);
    const callbackUrl = `${this.callbackBaseUrl}/api/jobs/${jobId}/callback`;

    try {
      await this.sshManager.execAsync(nodeConfig, command, jobId, callbackUrl);
      this.jobManager.markRunning(jobId);
      return {
        response: `✅ 命令已异步投递\nJob ID: \`${jobId}\`\n命令: \`${command}\`\n结果将通过 WebSocket 推送`,
        commands: [],
        targetNodeId: nodeConfig.id,
        jobId,
      };
    } catch (err) {
      this.jobManager.fail(jobId, err.message);
      return {
        response: `❌ 投递失败: ${err.message}\nJob ID: \`${jobId}\``,
        commands: [],
        targetNodeId: nodeConfig.id,
      };
    }
  }

  _handleHelp() {
    return {
      response: `📖 可用指令：
• 状态 — 查看节点状态
• 重启 gnb — 重启 GNB 服务
• 日志 — 查看最近日志
• 磁盘 — 查看磁盘使用
• 性能 — 查看 CPU/内存/负载
• 安装 openclaw — 在终端安装 OpenClaw
• 配置下发 — 完整配置下发
• help — 显示此帮助

💻 也可直接输入 Linux 命令（如 ls, cat, top, netstat 等）
🤖 @claude <问题> — 调用 AI 助手分析和执行运维任务
⚠️ 危险指令已被黑名单拦截（rm -rf, shutdown, reboot, mkfs 等）`,
      commands: [],
    };
  }

  // --- 工具方法 ---

  /**
   * 命令安全检查 — 匹配黑名单
   * @param {string} cmd - 待检查的命令
   * @returns {object|null} 拦截响应对象，安全时返回 null
   */
  _checkCommandSafety(cmd) {
    // 去掉变量展开、反引号等混淆手法
    const normalized = cmd
      .replace(/\$\{[^}]*\}/g, '')  // 去掉 ${...}
      .replace(/\$\([^)]*\)/g, '')  // 去掉 $(...)
      .replace(/`[^`]*`/g, '')      // 去掉 `...`
      .replace(/\\/g, '');           // 去掉反斜杠转义

    for (const { pattern, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(normalized) || pattern.test(cmd)) {
        return {
          response: `🚫 命令被拦截: ${reason}\n原始命令: \`${cmd}\`\n\n如确需执行，请登录服务器手动操作。`,
          commands: [],
          blocked: true,
        };
      }
    }
    return null;
  }

  _extractNodeId(msg) {
    // 尝试从消息中提取节点 ID
    // 支持格式: "安装 openclaw VM-0-16-debian", "安装 openclaw 到 VM-0-16-debian"
    const cleaned = msg.replace(/^(安装|配置下发|重启|日志|状态|磁盘|性能)\s*(openclaw|claw|gnb|服务)?\s*(到|on|for)?\s*/i, '').trim();
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
