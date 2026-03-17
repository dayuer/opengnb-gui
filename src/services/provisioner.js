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
   * @private
   */
  async _installClaw(nodeConfig, log) {
    // Step 1: 确保 Node.js 可用
    const nodeCheck = await this._execQuiet(nodeConfig, 'node --version 2>/dev/null || echo "NOT_FOUND"');
    if (nodeCheck.includes('NOT_FOUND')) {
      log('      安装 Node.js...');
      // 尝试 nvm （以当前用户安装）
      await this._exec(nodeConfig, 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash', log);
      await this._exec(nodeConfig, 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm install 22', log);
    } else {
      log(`      Node.js 已安装: ${nodeCheck.trim()}`);
    }

    // 构建环境前缀：优先用 PATH 中的 node，如果不在 PATH 中则尝试加载 nvm
    const envPrefix = 'export PATH="/usr/local/bin:/usr/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:$PATH" 2>/dev/null;';

    // Step 2: 安装 OpenClaw
    const clawCheck = await this._execQuiet(nodeConfig, `${envPrefix} openclaw --version 2>/dev/null || echo "NOT_FOUND"`);
    if (clawCheck.includes('NOT_FOUND')) {
      log('      sudo npm install -g openclaw ...');
      await this._exec(nodeConfig, `${envPrefix} sudo npm install -g openclaw`, log);
    } else {
      log(`      OpenClaw 已安装: ${clawCheck.trim()}`);
    }

    // Step 3: 获取实际路径
    const nodePath = (await this._execQuiet(nodeConfig, `${envPrefix} which node`)).trim();
    const clawPath = (await this._execQuiet(nodeConfig, `${envPrefix} which openclaw`)).trim();
    const binDir = (await this._execQuiet(nodeConfig, `${envPrefix} dirname $(which node)`)).trim();

    if (!nodePath || !clawPath) {
      throw new Error(`无法定位 node(${nodePath}) 或 openclaw(${clawPath})`);
    }
    log(`      node: ${nodePath}, openclaw: ${clawPath}`);

    // Step 4: 创建 systemd 服务
    log('      配置 openclaw-gateway 服务...');
    const serviceContent = [
      '[Unit]',
      'Description=OpenClaw Gateway',
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'User=root',
      'WorkingDirectory=/root/.openclaw',
      `Environment=PATH=${binDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      'Environment=HOME=/root',
      `ExecStart=${nodePath} ${clawPath} gateway --bind loopback --port 18789`,
      'Restart=always',
      'RestartSec=5',
      'StandardOutput=append:/var/log/openclaw-gateway.log',
      'StandardError=append:/var/log/openclaw-gateway.log',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
    ].join('\n');

    await this._exec(nodeConfig, `sudo bash -c 'mkdir -p /root/.openclaw && cat > /etc/systemd/system/openclaw-gateway.service << SVCEOF\n${serviceContent}\nSVCEOF'`, log);
    await this._exec(nodeConfig, 'sudo systemctl daemon-reload && sudo systemctl enable openclaw-gateway', log);
    await this._exec(nodeConfig, 'sudo systemctl restart openclaw-gateway', log);

    // Step 5: 等待启动
    log('      等待 OpenClaw 启动...');
    await this._exec(nodeConfig, 'sleep 3 && sudo systemctl is-active openclaw-gateway', log);
    log('      ✅ OpenClaw 安装完成');
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
  async _exec(nodeConfig, command, log) {
    try {
      const result = await this.sshManager.exec(nodeConfig, command, 300000);
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
