'use strict';

const EventEmitter = require('events');

/**
 * 节点配置下发服务 (Provisioning)
 *
 * 审批通过后，Console 通过 SSH 登录节点执行安装和配置：
 *   1. 安装 GNB（编译或下载二进制）
 *   2. 生成 GNB 节点配置（node.conf, address.conf, route.conf, ED25519 密钥）
 *   3. 配置 systemd 服务并启动
 *   4. 安装 OpenClaw Agent（Node.js + 配置）
 *   5. 验证服务运行状态
 */
class Provisioner extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./ssh-manager')} options.sshManager
   * @param {object} options.provisionConfig - 全局配置下发参数
   */
  constructor(options) {
    super();
    this.sshManager = options.sshManager;
    this.config = options.provisionConfig || {};

    /** @type {Map<string, {status: string, logs: string[], startedAt: string}>} */
    this.tasks = new Map();
  }

  /**
   * 对已审批节点执行完整配置下发
   * @param {object} nodeConfig - 节点配置（含 SSH 信息）
   * @param {object} [options] - 下发选项
   * @param {boolean} [options.installGnb=true] - 是否安装 GNB
   * @param {boolean} [options.installClaw=true] - 是否安装 OpenClaw
   * @param {object} [options.gnbConf] - GNB 配置参数
   * @returns {Promise<{success: boolean, logs: string[]}>}
   */
  async provision(nodeConfig, options = {}) {
    const taskId = nodeConfig.id;
    const logs = [];
    const log = (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}`;
      logs.push(line);
      this.emit('log', { nodeId: taskId, message: line });
    };

    this.tasks.set(taskId, { status: 'running', logs, startedAt: new Date().toISOString() });

    try {
      log(`开始配置下发: ${nodeConfig.name} (${nodeConfig.tunAddr})`);

      // --- Step 1: 系统准备 ---
      log('[1/5] 系统准备...');
      await this._exec(nodeConfig, 'sudo apt-get update -qq || sudo yum check-update -q || true', log);
      await this._exec(nodeConfig, 'sudo apt-get install -y -qq build-essential git || sudo yum install -y -q gcc make git || true', log);

      // --- Step 2: 安装 GNB ---
      if (options.installGnb !== false) {
        log('[2/5] 安装 GNB...');
        await this._installGnb(nodeConfig, options.gnbConf || {}, log);
      } else {
        log('[2/5] 跳过 GNB 安装');
      }

      // --- Step 3: 配置 GNB ---
      if (options.installGnb !== false) {
        log('[3/5] 配置 GNB...');
        await this._configureGnb(nodeConfig, options.gnbConf || {}, log);
      } else {
        log('[3/5] 跳过 GNB 配置');
      }

      // --- Step 4: 安装 OpenClaw ---
      if (options.installClaw !== false) {
        log('[4/5] 安装 OpenClaw Agent...');
        await this._installClaw(nodeConfig, log);
      } else {
        log('[4/5] 跳过 OpenClaw 安装');
      }

      // --- Step 5: 验证 ---
      log('[5/5] 验证服务状态...');
      await this._verify(nodeConfig, log);

      log('✅ 配置下发完成');
      this.tasks.set(taskId, { status: 'done', logs, finishedAt: new Date().toISOString() });
      return { success: true, logs };
    } catch (err) {
      log(`❌ 配置下发失败: ${err.message}`);
      this.tasks.set(taskId, { status: 'failed', logs, error: err.message });
      return { success: false, logs };
    }
  }

  /**
   * 安装 GNB
   * @private
   */
  async _installGnb(nodeConfig, gnbConf, log) {
    // 检查是否已安装
    const check = await this._execQuiet(nodeConfig, 'which gnb 2>/dev/null || echo "NOT_FOUND"');
    if (!check.includes('NOT_FOUND')) {
      log('      GNB 已安装: ' + check.trim());
      return;
    }

    // 从源码编译安装
    const cmds = [
      'cd /tmp && rm -rf opengnb',
      'git clone --depth 1 https://github.com/opengnb/opengnb.git /tmp/opengnb',
      'cd /tmp/opengnb && make -j$(nproc) install',
      'sudo mkdir -p /opt/gnb/bin && sudo cp /tmp/opengnb/bin/* /opt/gnb/bin/',
      'sudo ln -sf /opt/gnb/bin/gnb /usr/local/bin/gnb',
      'sudo ln -sf /opt/gnb/bin/gnb_ctl /usr/local/bin/gnb_ctl',
    ];

    for (const cmd of cmds) {
      await this._exec(nodeConfig, cmd, log);
    }
  }

  /**
   * 生成 GNB 配置并配置 systemd
   * @private
   */
  async _configureGnb(nodeConfig, gnbConf, log) {
    const nodeId = nodeConfig.id;
    const confDir = `/opt/gnb/conf/${nodeId}`;

    // 创建配置目录
    await this._exec(nodeConfig, `sudo mkdir -p ${confDir}`, log);

    // 生成 ED25519 密钥对（如果不存在）
    await this._exec(nodeConfig, `test -f ${confDir}/ed25519_private.key || sudo gnb -c ${confDir} --setup-node`, log);

    // node.conf（如果有自定义配置通过 gnbConf 传入）
    const indexNodes = gnbConf.indexNodes || this.config.indexNodes || '101.43.39.130:9001';
    const listenPort = gnbConf.listenPort || '9001';

    const nodeConf = [
      `nodeid ${nodeId}`,
      `listen ${listenPort}`,
      `index-address ${indexNodes}`,
      `es-argv --upnp`,
    ].join('\n');

    await this._exec(nodeConfig, `echo '${nodeConf}' | sudo tee ${confDir}/node.conf`, log);

    // systemd 服务
    const serviceUnit = [
      '[Unit]',
      'Description=GNB P2P VPN',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=/opt/gnb/bin/gnb -c ${confDir} -d`,
      'Restart=always',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
    ].join('\\n');

    await this._exec(nodeConfig, `echo -e '${serviceUnit}' | sudo tee /etc/systemd/system/gnb.service`, log);
    await this._exec(nodeConfig, 'sudo systemctl daemon-reload && sudo systemctl enable gnb && sudo systemctl restart gnb', log);
  }

  /**
   * 安装 OpenClaw Agent
   * 流程: 升级 Node 到 v22 → npm install -g openclaw@latest → onboard → 提取 token
   * @private
   */
  async _installClaw(nodeConfig, log) {
    // Step 1: 确保 Node.js >= 22
    const nodeVer = (await this._execQuiet(nodeConfig, 'node --version 2>/dev/null || echo "NOT_FOUND"')).trim();
    const majorVer = nodeVer.startsWith('v') ? parseInt(nodeVer.slice(1), 10) : 0;

    if (majorVer < 22) {
      log(`      Node.js ${nodeVer || '未安装'}, 需要 >= 22，升级中...`);
      // 用 n 版本管理器升级
      await this._exec(nodeConfig, 'sudo npm install -g n 2>/dev/null || (curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | sudo bash -s 22)', log);
      await this._exec(nodeConfig, 'sudo n 22', log);
      // 刷新 hash 表
      await this._exec(nodeConfig, 'hash -r 2>/dev/null; node --version', log);
    } else {
      log(`      Node.js ${nodeVer} ✓`);
    }

    // Step 2: 安装 OpenClaw
    // 注意: n 22 后 node/npm 在 /usr/local/bin，SSH 新会话可能还用旧 PATH
    const envPath = 'export PATH=/usr/local/bin:$PATH;';
    const clawVer = (await this._execQuiet(nodeConfig, `${envPath} openclaw --version 2>/dev/null || echo "NOT_FOUND"`)).trim();
    if (clawVer.includes('NOT_FOUND') || clawVer === '0.0.1') {
      log('      安装 openclaw@latest (后台安装，轮询检查)...');
      await this._exec(nodeConfig, `${envPath} sudo npm uninstall -g openclaw 2>/dev/null || true`, log);

      // 用 nohup 后台安装，避免 SSH 超时
      await this._execQuiet(nodeConfig,
        `sudo nohup bash -c '${envPath} npm install -g openclaw@latest > /tmp/openclaw-install.log 2>&1 && echo INSTALL_DONE >> /tmp/openclaw-install.log || echo INSTALL_FAIL >> /tmp/openclaw-install.log' &`
      );

      // 轮询等待安装完成 (最长 10 分钟)
      const maxWait = 600000; // 10min
      const pollInterval = 15000; // 15s
      const startTime = Date.now();
      let installed = false;

      while (Date.now() - startTime < maxWait) {
        await new Promise(r => setTimeout(r, pollInterval));
        const logTail = await this._execQuiet(nodeConfig, 'tail -3 /tmp/openclaw-install.log 2>/dev/null || echo PENDING');
        if (logTail.includes('INSTALL_DONE')) {
          installed = true;
          log('      npm install 完成');
          break;
        }
        if (logTail.includes('INSTALL_FAIL')) {
          const errLog = await this._execQuiet(nodeConfig, 'tail -10 /tmp/openclaw-install.log 2>/dev/null');
          log(`      npm install 失败: ${errLog.substring(0, 200)}`);
          throw new Error('openclaw npm install 失败');
        }
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        log(`      安装中... (${elapsed}s)`);
      }

      if (!installed) {
        throw new Error('openclaw 安装超时 (10分钟)');
      }
    } else {
      log(`      OpenClaw ${clawVer} ✓`);
    }

    // 验证安装
    const verCheck = (await this._execQuiet(nodeConfig, `${envPath} openclaw --version 2>/dev/null || echo "FAIL"`)).trim();
    if (verCheck === 'FAIL') {
      throw new Error('openclaw 安装失败，命令不可用');
    }
    log(`      openclaw ${verCheck} 安装成功`);

    // Step 3: 执行 onboard（自动创建 systemd 服务 + 生成 token）
    log('      执行 openclaw onboard ...');
    // onboard 需要以实际运行用户身份执行（创建 ~/.openclaw 目录）
    // 用 root 运行以便 systemd 服务以 root 身份运行
    await this._exec(nodeConfig, `${envPath} sudo openclaw onboard --install-daemon --yes 2>&1 || sudo openclaw onboard --install-daemon 2>&1 || true`, log);

    // Step 4: 确保 Gateway 服务运行
    log('      启动 Gateway ...');
    // onboard 可能创建了 openclaw-gateway 或 openclaw 服务
    const svcName = (await this._execQuiet(nodeConfig,
      'systemctl list-unit-files | grep -o "openclaw[^ ]*\\.service" | head -1 || echo "openclaw-gateway.service"'
    )).trim();
    log(`      服务名: ${svcName}`);
    await this._exec(nodeConfig, `sudo systemctl enable ${svcName} && sudo systemctl restart ${svcName}`, log);
    await this._exec(nodeConfig, `sleep 5 && sudo systemctl is-active ${svcName}`, log);

    // Step 5: 提取 Gateway Token
    log('      提取 Gateway Token ...');
    const tokenResult = await this._extractClawToken(nodeConfig, log);

    // Step 6: 验证 RPC 可达
    if (tokenResult.token) {
      await this._verifyClawRPC(nodeConfig, tokenResult.token, log);
    }

    log('      ✅ OpenClaw 安装完成');
    return tokenResult;
  }

  /**
   * 从终端提取 OpenClaw Gateway Token
   * @private
   */
  async _extractClawToken(nodeConfig, log) {
    // Token 可能在多个位置
    const tokenPaths = [
      'sudo cat /root/.openclaw/.gateway-token',
      'sudo cat /root/.openclaw/gateway-token',
      'sudo cat /home/synon/.openclaw/.gateway-token',
      // 从 config 中提取
      'sudo openclaw gateway call status --json 2>/dev/null | grep -o \'"token":"[^"]*"\' | head -1',
    ];

    let token = '';
    for (const cmd of tokenPaths) {
      const result = (await this._execQuiet(nodeConfig, `${cmd} 2>/dev/null || true`)).trim();
      if (result && result.length > 10 && !result.includes('No such file')) {
        token = result.replace(/.*"token":"/, '').replace(/".*/, '');
        log(`      Token 获取成功 (${token.substring(0, 8)}...)`);
        break;
      }
    }

    if (!token) {
      log('      ⚠️ 未找到 Token，尝试从 Gateway 日志提取...');
      const logOutput = (await this._execQuiet(nodeConfig,
        'sudo journalctl -u openclaw* --no-pager -n 50 2>/dev/null | grep -i token | tail -1 || true'
      )).trim();
      if (logOutput) log(`      日志: ${logOutput.substring(0, 100)}`);
    }

    // 获取 Gateway 端口
    const port = 18789;

    // 触发事件，让 server.js 保存到节点配置
    this.emit('claw_ready', {
      nodeId: nodeConfig.id,
      token,
      port,
      tunAddr: nodeConfig.tunAddr,
    });

    return { token, port };
  }

  /**
   * 通过 SSH 代理验证终端 OpenClaw RPC 可达
   * @private
   */
  async _verifyClawRPC(nodeConfig, token, log) {
    try {
      const result = await this._execQuiet(nodeConfig,
        `curl -s -m 5 -H "Authorization: Bearer ${token}" http://127.0.0.1:18789/status`
      );
      if (result.includes('ok') || result.includes('"status"')) {
        log(`      RPC 验证通过 ✓`);
        return true;
      }
      log(`      RPC 响应: ${result.substring(0, 100)}`);
      return false;
    } catch (err) {
      log(`      RPC 验证失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 验证服务状态
   * @private
   */
  async _verify(nodeConfig, log) {
    const gnbStatus = await this._execQuiet(nodeConfig, 'sudo systemctl is-active gnb 2>/dev/null || echo "inactive"');
    log(`      GNB 服务: ${gnbStatus.trim()}`);

    const tunCheck = await this._execQuiet(nodeConfig, 'ip addr show tun0 2>/dev/null | grep inet || echo "NO_TUN"');
    log(`      TUN 接口: ${tunCheck.trim()}`);
  }

  /**
   * 执行远程命令并记录日志
   * @private
   */
  async _exec(nodeConfig, command, log, timeout = 600000) {
    try {
      const result = await this.sshManager.exec(nodeConfig, command, timeout);
      if (result.stdout.trim()) log(`      ${result.stdout.trim().substring(0, 200)}`);
      if (result.stderr.trim() && result.code !== 0) log(`      [STDERR] ${result.stderr.trim().substring(0, 200)}`);
      return result;
    } catch (err) {
      log(`      [ERROR] ${command}: ${err.message}`);
      throw err;
    }
  }

  /**
   * 静默执行（不抛异常）
   * @private
   */
  async _execQuiet(nodeConfig, command) {
    try {
      const result = await this.sshManager.exec(nodeConfig, command, 15000);
      return result.stdout;
    } catch (_) {
      return '';
    }
  }

  /**
   * 获取配置下发任务状态
   * @param {string} nodeId
   */
  getTaskStatus(nodeId) {
    return this.tasks.get(nodeId) || null;
  }
}

module.exports = Provisioner;
