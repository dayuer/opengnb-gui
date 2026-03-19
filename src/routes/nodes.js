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
function createNodesRouter(monitor, sshManager, nodesConfig, keyManager, metricsStore) {
  const router = express.Router();

  // ═══════════════════════════════════════
  // @alpha: 指标时序 API — /api/nodes/metrics
  // ═══════════════════════════════════════
  if (metricsStore) {
    // GET /api/nodes/metrics/summary — 全局汇总
    router.get('/metrics/summary', (req, res) => {
      res.json(metricsStore.summary());
    });

    // GET /api/nodes/metrics?nodeId=xxx&range=1h
    router.get('/metrics', (req, res) => {
      const { nodeId, range } = req.query;
      if (!nodeId) {
        return res.status(400).json({ error: '缺少 nodeId 参数' });
      }
      const data = metricsStore.query(nodeId, range || '1h');
      res.json({ nodeId, range: range || '1h', points: data, alerts: metricsStore.getAlerts().filter(a => a.nodeId === nodeId) });
    });
  }  // ═══════════════════════════════════════
  // 分组管理子路由 — /api/nodes/groups
  // 必须放在 /:id 之前，避免 "groups" 被当作 nodeId
  // ═══════════════════════════════════════
  if (keyManager) {
    router.get('/groups', (req, res) => {
      res.json({ groups: keyManager.getGroups() });
    });

    router.post('/groups', (req, res) => {
      const { name, color } = req.body;
      try {
        const group = keyManager.createGroup({ name, color });
        res.status(201).json(group);
      } catch (err) {
        const status = err.message.includes('已存在') ? 409 : 400;
        res.status(status).json({ error: err.message });
      }
    });

    router.put('/groups/:id', (req, res) => {
      const result = keyManager.updateGroup(req.params.id, req.body);
      res.status(result.success ? 200 : 404).json(result);
    });

    router.delete('/groups/:id', (req, res) => {
      const result = keyManager.deleteGroup(req.params.id);
      res.status(result.success ? 200 : 404).json(result);
    });
  }

  // GET /api/nodes — 全部节点状态
  router.get('/', (req, res) => {
    res.json({
      timestamp: new Date().toISOString(),
      nodes: monitor.getAllStatus(),
    });
  });

  // GET /api/nodes/:id — 单节点详情
  router.get('/:id', (req, res) => {
    const status = monitor.getNodeStatus(req.params.id);
    if (!status) {
      return res.status(404).json({ error: `节点 ${req.params.id} 未找到` });
    }
    res.json(status);
  });

  // @alpha: PUT /api/nodes/:id — 编辑节点信息 + 远程 GNB 同步 (verify-then-save)
  if (keyManager) {
    const { exec: execCmd } = require('child_process');
    const pingCheck = (ip, tries = 3) => new Promise(resolve => {
      execCmd(`ping -c ${tries} -W 3 ${ip}`, err => resolve(!err));
    });

    router.put('/:id', async (req, res) => {
      const { name, tunAddr, sshPort, sshUser } = req.body;

      // 非 tunAddr 变更 → 直接保存（无需远程同步）
      const oldNode = tunAddr ? keyManager.getApprovedNodesConfig().find(n => n.id === req.params.id) : null;
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

      // ═══ tunAddr 变更：verify-then-save 流程 ═══
      const newIp = String(tunAddr).trim();
      const netmask = oldNode.netmask || '255.255.255.0';
      const gnbId = oldNode.gnbNodeId;
      const confPath = `/opt/gnb/conf/${gnbId}/address.conf`;
      const indexIp = '10.1.0.1'; // TODO: 从配置读取

      console.log(`[RemoteSync] 开始 verify-then-save: ${oldNode.tunAddr} → ${newIp}`);

      // Step 1: SSH 到节点 → 备份 + sed + 部署自愈重启脚本
      try {
        const setupCmd = [
          `sudo cp ${confPath} ${confPath}.bak`,
          `sudo sed -i 's/^${gnbId}|.*/${gnbId}|${newIp}|${netmask}/' ${confPath}`,
          'sync',
          // 自愈脚本：重启 GNB → 等待 → ping index → 失败则回滚
          `cat > /tmp/gnb-verify.sh << 'HEALEOF'\n` +
          `#!/bin/bash\n` +
          `sudo systemctl restart gnb\n` +
          `sleep 4\n` +
          `if ping -c 2 -W 3 ${indexIp} > /dev/null 2>&1; then\n` +
          `  sudo rm -f ${confPath}.bak\n` +
          `  echo SUCCESS > /tmp/gnb-verify-result\n` +
          `else\n` +
          `  sudo cp ${confPath}.bak ${confPath}\n` +
          `  sudo systemctl restart gnb\n` +
          `  echo ROLLBACK > /tmp/gnb-verify-result\n` +
          `fi\nHEALEOF`,
          'chmod +x /tmp/gnb-verify.sh',
          'nohup bash /tmp/gnb-verify.sh > /dev/null 2>&1 &',
        ].join(' && ');
        await sshManager.exec(oldNode, setupCmd, 15000);
        console.log(`[RemoteSync] 节点自愈脚本已部署并启动`);
      } catch (err) {
        console.error(`[RemoteSync] SSH 执行失败: ${err.message}`);
        return res.status(503).json({
          error: `远程同步失败: ${err.message}`,
          hint: '节点不可达，IP 未变更。请检查 SSH 连接后重试。',
        });
      }

      // Step 2: 更新 index address.conf（本地 fs）
      const indexConfPath = keyManager.gnbConfDir
        ? require('path').join(keyManager.gnbConfDir, 'address.conf') : null;
      let indexOldContent = null;
      if (indexConfPath && require('fs').existsSync(indexConfPath)) {
        indexOldContent = require('fs').readFileSync(indexConfPath, 'utf8');
        const regex = new RegExp(`^${gnbId}\\|.*$`, 'm');
        const newEntry = `${gnbId}|${newIp}|${netmask}`;
        let updated = regex.test(indexOldContent)
          ? indexOldContent.replace(regex, newEntry)
          : indexOldContent.trimEnd() + '\n' + newEntry;
        if (!updated.endsWith('\n')) updated += '\n';
        require('fs').writeFileSync(indexConfPath, updated);
        console.log(`[RemoteSync] Index address.conf 已更新: ${newEntry}`);
      }

      // Step 3: 重启 index GNB（使新路由生效）
      try {
        await new Promise((resolve, reject) => {
          execCmd('systemctl restart gnb', { timeout: 10000 }, (err) => err ? reject(err) : resolve());
        });
        console.log(`[RemoteSync] Index GNB 已重启`);
      } catch (err) {
        console.error(`[RemoteSync] Index GNB 重启失败: ${err.message}`);
      }

      // Step 4: 等待双方 P2P 重建 + ping 验证（GNB P2P 发现需 ~10s）
      await new Promise(r => setTimeout(r, 15000));
      const reachable = await pingCheck(newIp);

      if (reachable) {
        // Step 5a: 验证通过 → 保存本地
        console.log(`[RemoteSync] ✅ ${newIp} 验证通过，保存`);
        const result = keyManager.updateNode(req.params.id, { name, tunAddr, sshPort, sshUser });
        if (!result.success) return res.status(400).json({ error: result.message });
        result.remoteSync = 'verified';
        return res.json(result);
      }

      // Step 5b: 验证失败 → 回滚 index（节点侧由自愈脚本处理）
      console.error(`[RemoteSync] ❌ ${newIp} 不可达，回滚 index`);
      if (indexOldContent && indexConfPath) {
        require('fs').writeFileSync(indexConfPath, indexOldContent);
        try {
          await new Promise((resolve, reject) => {
            execCmd('systemctl restart gnb', { timeout: 10000 }, (err) => err ? reject(err) : resolve());
          });
        } catch (_) { /* best effort */ }
      }

      return res.status(503).json({
        error: `IP 切换验证失败`,
        hint: `${newIp} 不可达，已回滚。节点端自愈脚本将自动恢复 ${oldNode.tunAddr}。`,
        remoteSync: 'rollback',
      });
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

  router.post('/:id/exec', async (req, res) => {
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

    const nodeConfig = nodesConfig.find(n => n.id === req.params.id);
    if (!nodeConfig) {
      return res.status(404).json({ error: `节点 ${req.params.id} 未配置` });
    }

    try {
      const result = await sshManager.exec(nodeConfig, cmd);
      res.json(result);
    } catch (err) {
      const msg = process.env.NODE_ENV === 'production' ? '命令执行失败' : err.message;
      res.status(500).json({ error: msg });
    }
  });

  return router;
}

module.exports = createNodesRouter;
