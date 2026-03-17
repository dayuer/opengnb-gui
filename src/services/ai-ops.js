'use strict';

const SSHManager = require('./ssh-manager');

/**
 * AI 运维服务 — Claude 智能运维工程师
 * 接收自然语言指令，生成 SSH 命令，经人工确认后执行
 */
class AiOps {
  /**
   * @param {object} options
   * @param {Array} options.nodesConfig - 节点配置
   * @param {SSHManager} options.sshManager - SSH 管理器
   * @param {Function} options.getNodeStatus - 获取节点状态的回调
   * @param {string} [options.apiKey] - Anthropic API Key
   * @param {string} [options.apiUrl] - API URL (可通过 OpenClaw 中转)
   */
  constructor(options) {
    this.nodesConfig = options.nodesConfig;
    this.sshManager = options.sshManager;
    this.getNodeStatus = options.getNodeStatus;
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.apiUrl = options.apiUrl || process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages';

    /** @type {Map<string, object>} 待确认的命令 */
    this.pendingCommands = new Map();
  }

  /**
   * 处理用户的运维对话
   * @param {string} userMessage - 用户输入
   * @returns {Promise<object>} - {response, commands}
   */
  async chat(userMessage) {
    const statusContext = this.getNodeStatus();

    const systemPrompt = `你是一位资深的 GNB P2P VPN 网络运维工程师。你的任务是帮助管理员管理 GNB 节点网络。

当前网络中有以下节点：
${JSON.stringify(statusContext, null, 2)}

你可以建议执行的操作：
- 查看节点状态: gnb_ctl -b <gnb.map路径> -s
- 查看地址列表: gnb_ctl -b <gnb.map路径> -a
- 查看在线节点: gnb_ctl -b <gnb.map路径> -o
- 重启 GNB 服务: systemctl restart gnb
- 查看 GNB 日志: journalctl -u gnb --no-pager -n 50
- 检查网络连通: ping -c 3 <TUN地址>
- 修改配置文件: 编辑 /opt/gnb/conf/<nodeid>/ 下的文件

当你建议执行命令时，请用以下 JSON 格式返回：
{"commands": [{"nodeId": "<节点ID>", "command": "<命令>", "description": "<操作说明>"}]}

如果只是回答问题不需要执行命令，直接用文本回复。
对于任何可能修改系统状态的命令（重启、修改配置），必须明确标注风险等级。`;

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        return {
          response: `AI 服务调用失败 (${response.status}): ${errText}`,
          commands: [],
        };
      }

      const data = await response.json();
      const aiText = data.content?.[0]?.text || '无响应';

      // 尝试从响应中提取命令
      const commands = this._extractCommands(aiText);

      if (commands.length > 0) {
        const confirmId = `cmd_${Date.now()}`;
        this.pendingCommands.set(confirmId, commands);

        return {
          response: aiText,
          commands,
          confirmId,
          requireConfirm: true,
        };
      }

      return { response: aiText, commands: [], requireConfirm: false };
    } catch (err) {
      return {
        response: `AI 服务连接失败: ${err.message}`,
        commands: [],
      };
    }
  }

  /**
   * 确认并执行待定命令
   * @param {string} confirmId
   * @returns {Promise<Array<object>>} 各命令执行结果
   */
  async confirmAndExec(confirmId) {
    const commands = this.pendingCommands.get(confirmId);
    if (!commands) {
      return [{ error: '确认 ID 不存在或已过期' }];
    }
    this.pendingCommands.delete(confirmId);

    const results = [];

    for (const cmd of commands) {
      const nodeConfig = this.nodesConfig.find(n => n.id === cmd.nodeId);
      if (!nodeConfig) {
        results.push({ nodeId: cmd.nodeId, error: '节点未配置' });
        continue;
      }

      try {
        const execResult = await this.sshManager.exec(nodeConfig, cmd.command);
        results.push({
          nodeId: cmd.nodeId,
          command: cmd.command,
          stdout: execResult.stdout,
          stderr: execResult.stderr,
          code: execResult.code,
        });
      } catch (err) {
        results.push({
          nodeId: cmd.nodeId,
          command: cmd.command,
          error: err.message,
        });
      }
    }

    return results;
  }

  /**
   * 从 AI 响应中提取命令 JSON
   * @private
   */
  _extractCommands(text) {
    try {
      const match = text.match(/\{[\s\S]*"commands"[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        return Array.isArray(parsed.commands) ? parsed.commands : [];
      }
    } catch (_) {
      /* 解析失败视为无命令 */
    }
    return [];
  }
}

module.exports = AiOps;
