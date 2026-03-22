'use strict';

const express = require('express');

/**
 * 节点管理 API 路由（含分组 + 指标子路由）
 * @param {import('../services/gnb-monitor')} monitor
 * @param {import('../services/ssh-manager')} sshManager
 * @param {Array} nodesConfig
 * @param {import('../services/key-manager')} [keyManager]
 * @param {import('../services/metrics-store')} [metricsStore]
 */
function createNodesRouter(monitor: any, sshManager: any, nodesConfig: any, keyManager: any, metricsStore: any) {
  const router = express.Router();

  // ═══════════════════════════════════════
  // @alpha: 指标时序 API — /api/nodes/metrics
  // ═══════════════════════════════════════
  if (metricsStore) {
    // GET /api/nodes/metrics/summary — 全局汇总
    router.get('/metrics/summary', (req: any, res: any) => {
      res.json(metricsStore.summary());
    });

    // GET /api/nodes/metrics?nodeId=xxx&range=1h
    router.get('/metrics', (req: any, res: any) => {
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
    router.get('/groups', (req: any, res: any) => {
      res.json({ groups: keyManager.getGroups() });
    });

    router.post('/groups', (req: any, res: any) => {
      const { name, color } = req.body;
      try {
        const group = keyManager.createGroup({ name, color });
        res.status(201).json(group);
      } catch (err: any) {
        const status = err.message.includes('已存在') ? 409 : 400;
        res.status(status).json({ error: err.message });
      }
    });

    router.put('/groups/:id', (req: any, res: any) => {
      const result = keyManager.updateGroup(req.params.id, req.body);
      res.status(result.success ? 200 : 404).json(result);
    });

    router.delete('/groups/:id', (req: any, res: any) => {
      const result = keyManager.deleteGroup(req.params.id);
      res.status(result.success ? 200 : 404).json(result);
    });
  }

  // GET /api/nodes — 全部节点状态
  router.get('/', (req: any, res: any) => {
    res.json({
      timestamp: new Date().toISOString(),
      nodes: monitor.getAllStatus(),
    });
  });

  // GET /api/nodes/:id — 单节点详情
  router.get('/:id', (req: any, res: any) => {
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

    router.put('/:id', async (req: any, res: any) => {
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
      } catch (err: any) {
        console.error(`[RemoteSync] SSH 失败: ${err.message}`);
        return res.status(503).json({
          error: `远程同步失败: ${err.message}`,
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
  const SAFE_COMMANDS = {
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

  const SHELL_META = /[;|&`$(){}!><\n\r\\\\'\"]/;

  router.post('/:id/exec', async (req: any, res: any) => {
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

    const nodeConfig = nodesConfig.find((n: any) => n.id === req.params.id);
    if (!nodeConfig) {
      return res.status(404).json({ error: `节点 ${req.params.id} 未配置` });
    }

    try {
      const result = await sshManager.exec(nodeConfig, cmd);
      res.json(result);
    } catch (err: any) {
      const msg = process.env.NODE_ENV === 'production' ? '命令执行失败' : err.message;
      res.status(500).json({ error: msg });
    }
  });

  // ═══════════════════════════════════════
  // @alpha: 技能管理 (Skills)
  // ═══════════════════════════════════════

  // POST /api/nodes/:id/skills — 推送安装技能
  router.post('/:id/skills', async (req: any, res: any) => {
    const { skillId, source, version, name } = req.body;
    if (!skillId || !source) {
      return res.status(400).json({ error: '缺少 skillId 或 source 参数' });
    }

    const nodeConfig = nodesConfig.find((n: any) => n.id === req.params.id);
    if (!nodeConfig) {
      return res.status(404).json({ error: `节点 ${req.params.id} 未找到或暂离线` });
    }

    // @alpha: skills.sh / console / openclaw 类技能为 prompt 或平台能力，不需要 SSH 远程安装
    const isLocalOnly = source === 'skills.sh' || source === 'console' || source === 'openclaw';

    // 构造安装命令（仅远程源需要）
    // @fix: 用 bash -lc 包裹以加载 login profile（NVM/fnm 环境下 npm 不在默认 PATH）
    let cmd = '';
    if (!isLocalOnly) {
      let innerCmd = '';
      if (source.startsWith('http')) {
        innerCmd = `curl -sSL ${source} | sudo bash`;
      } else if (source === 'npm') {
        innerCmd = `sudo $(which npm) install -g ${skillId}`;
      } else if (source === 'openclaw') {
        innerCmd = `sudo $(which npm) install -g @openclaw/${skillId}`;
      } else {
        return res.status(400).json({ error: '不支持的安装源: ' + source });
      }
      // bash -lc 确保 .bashrc/.profile 被加载（NVM 等工具依赖此机制）
      cmd = `bash -lc '${innerCmd.replace(/'/g, "'\"'\"'")}'`;
    }

    try {
      let result: any = { code: 0, stdout: 'local-only skill registered', stderr: '' };

      // 远程源：SSH 执行安装命令
      if (!isLocalOnly) {
        result = await sshManager.exec(nodeConfig, cmd, 60000);
        if (result.code !== 0) {
          console.error(`[Skills] 安装失败 node=${req.params.id} cmd=${cmd} code=${result.code} stderr=${result.stderr}`);
          return res.status(500).json({ error: `安装执行失败(code:${result.code}): ${result.stderr || result.stdout || '未知错误'}`, stdout: result.stdout, stderr: result.stderr });
        }
      }

      // 更新持久化状态
      if (keyManager) {
        const node = keyManager.store.findById(req.params.id);
        const currentSkills = node.skills || [];
        if (!currentSkills.find((s: any) => s.id === skillId)) {
          currentSkills.push({
            id: skillId,
            name: name || skillId,
            version: version || 'latest',
            installedAt: new Date().toISOString()
          });
          keyManager.updateNodeSkills(req.params.id, currentSkills);
        }
        // 广播 WS 更新，确保所有已连接客户端同步
        if (keyManager.onChange) keyManager.onChange('skill_install', req.params.id);
      }

      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/nodes/:id/skills/:skillId — 卸载技能
  router.delete('/:id/skills/:skillId', async (req: any, res: any) => {
    const nodeConfig = nodesConfig.find((n: any) => n.id === req.params.id);
    if (!nodeConfig) {
      return res.status(404).json({ error: `节点 ${req.params.id} 未找到或不可达` });
    }

    const skillId = req.params.skillId;
    
    if (!/^[a-zA-Z0-9_@/.\\-]+$/.test(skillId)) {
      return res.status(400).json({ error: '技能 ID 格式包含非法符号' });
    }

    // fallback: 目前统一认为是全局 npm 包
    // @fix: bash -lc 确保 NVM 环境加载（与安装一致）
    const innerCmd = `sudo $(which npm) uninstall -g ${skillId} || echo "Skill likely not an NPM package"`;
    const cmd = `bash -lc '${innerCmd.replace(/'/g, "'\"'\"'")}'`;

    try {
      const result = await sshManager.exec(nodeConfig, cmd, 30000);
      
      // 无论命令执行成功与否，一律剔除本地记录以作乐观展示（假设物理已失效）
      if (keyManager) {
        const node = keyManager.store.findById(req.params.id);
        let currentSkills = node.skills || [];
        const originalLen = currentSkills.length;
        currentSkills = currentSkills.filter((s: any) => s.id !== skillId);
        
        if (currentSkills.length !== originalLen) {
          keyManager.updateNodeSkills(req.params.id, currentSkills);
          // 广播 WS 更新
          if (keyManager.onChange) keyManager.onChange('skill_uninstall', req.params.id);
        }
      }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createNodesRouter;
export {}; // CJS 模块标记
