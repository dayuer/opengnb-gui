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

    // 使用 heredoc 避免 shell 注入
    await this._exec(nodeConfig, `sudo tee ${confDir}/node.conf > /dev/null << 'NODECONF'
${nodeConf}
NODECONF`, log);

    // systemd 服务 — 使用 heredoc 消除命令注入风险
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
    ].join('\n');

    await this._exec(nodeConfig, `sudo tee /etc/systemd/system/gnb.service > /dev/null << 'SVCUNIT'
${serviceUnit}
SVCUNIT`, log);
    await this._exec(nodeConfig, 'sudo systemctl daemon-reload && sudo systemctl enable gnb && sudo systemctl restart gnb', log);
  }

  /**
   * 安装 OpenClaw Agent
   * 流程: 升级 Node → npm install -g openclaw → 手动创建 config + systemd → 提取 token
   * @private
   */
  async _installClaw(nodeConfig, log) {
    // @alpha: 统一 PATH — sudo 默认 secure_path 不含 /usr/local/bin
    const envPath = 'export PATH=/usr/local/bin:$PATH;';
    const sudoEnv = 'sudo env PATH=/usr/local/bin:$PATH';

    // Step 1: 确保 Node.js >= 22
    const nodeVer = (await this._execQuiet(nodeConfig, `${envPath} node --version 2>/dev/null || echo "NOT_FOUND"`)).trim();
    const majorVer = nodeVer.startsWith('v') ? parseInt(nodeVer.slice(1), 10) : 0;

    if (majorVer < 22) {
      log(`      Node.js ${nodeVer || '未安装'}, 需要 >= 22，升级中...`);
      await this._exec(nodeConfig, `${sudoEnv} npm install -g n 2>/dev/null || (curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | sudo bash -s 22)`, log);
      await this._exec(nodeConfig, `${sudoEnv} n 22`, log);
      await this._exec(nodeConfig, 'hash -r 2>/dev/null; node --version', log);
    } else {
      log(`      Node.js ${nodeVer} ✓`);
    }

    // Step 2: 安装 OpenClaw（Console 镜像优先 → npm 回退）
    const clawVer = (await this._execQuiet(nodeConfig, `${envPath} openclaw --version 2>/dev/null || echo "NOT_FOUND"`)).trim();
    if (clawVer.includes('NOT_FOUND') || clawVer === '0.0.1') {
      log('      安装 openclaw@latest ...');
      await this._exec(nodeConfig, `${sudoEnv} npm uninstall -g openclaw 2>/dev/null || true`, log);

      // --- 策略 A: Console 镜像分发（适合防火墙内节点）---
      let installed = false;
      const consoleTunAddr = nodeConfig.tunAddr
        ? this._getConsoleApiBase(nodeConfig)
        : null;

      if (consoleTunAddr) {
        log('      尝试从 Console 镜像下载...');
        try {
          // 查询可用 tarball 列表
          const listResp = await this._execQuiet(nodeConfig,
            `curl -sf -m 5 "${consoleTunAddr}/api/mirror/openclaw" 2>/dev/null || echo "{}"`
          );
          const listData = JSON.parse(listResp || '{}');
          const tgzFile = (listData.files || [])
            .map(f => f.name)
            .filter(n => n.endsWith('.tgz'))
            .sort()
            .pop(); // 取最新

          if (tgzFile) {
            log(`      镜像文件: ${tgzFile}`);
            await this._exec(nodeConfig,
              `curl -sf -m 120 "${consoleTunAddr}/api/mirror/openclaw/${tgzFile}" -o /tmp/${tgzFile}`,
              log
            );
            await this._exec(nodeConfig,
              `${sudoEnv} npm install -g /tmp/${tgzFile} > /tmp/openclaw-install.log 2>&1`,
              log
            );
            installed = true;
            log('      Console 镜像安装完成');
          } else {
            log('      Console 镜像无 openclaw 包，回退到 npm');
          }
        } catch (e) {
          log(`      Console 镜像安装失败 (${e.message})，回退到 npm`);
        }
      }

      // --- 策略 B: npm 在线安装（含国内镜像回退）---
      if (!installed) {
        log('      通过 npm 在线安装 (后台轮询)...');
        await this._execQuiet(nodeConfig,
          `sudo nohup bash -c '${envPath} npm install -g openclaw@latest --registry=https://registry.npmmirror.com > /tmp/openclaw-install.log 2>&1 && echo INSTALL_DONE >> /tmp/openclaw-install.log || echo INSTALL_FAIL >> /tmp/openclaw-install.log' &`
        );

        const maxWait = 600000;
        const pollInterval = 15000;
        const startTime = Date.now();

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
          log(`      安装中... (${Math.round((Date.now() - startTime) / 1000)}s)`);
        }

        if (!installed) throw new Error('openclaw 安装超时 (10分钟)');
      }
    } else {
      log(`      OpenClaw ${clawVer} ✓`);
    }

    // 验证安装
    const verCheck = (await this._execQuiet(nodeConfig, `${envPath} openclaw --version 2>/dev/null || echo "FAIL"`)).trim();
    if (verCheck === 'FAIL') throw new Error('openclaw 安装失败，命令不可用');
    log(`      openclaw ${verCheck} 安装成功`);

    // Step 3: 手动创建 config + systemd (绕过交互式 onboard TUI)
    // @alpha: onboard 有不可跳过的交互式安全确认 TUI，无法通过 SSH 自动化
    log('      创建 OpenClaw 配置 ...');
    const token = (await this._execQuiet(nodeConfig,
      `python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || openssl rand -hex 32`
    )).trim();

    const clawConfig = JSON.stringify({
      gateway: {
        port: 18789, bind: 'lan',
        auth: { mode: 'token', token },
      },
    }, null, 2);

    await this._exec(nodeConfig, `sudo mkdir -p /root/.openclaw && echo '${clawConfig}' | sudo tee /root/.openclaw/openclaw.json > /dev/null`, log);
    log(`      配置已写入 (/root/.openclaw/openclaw.json)`);

    // Step 4: 创建 systemd 服务
    log('      创建 systemd 服务 ...');
    const svcUnit = [
      '[Unit]', 'Description=OpenClaw Gateway', 'After=network.target', '',
      '[Service]', 'Type=simple', 'Environment=PATH=/usr/local/bin:/usr/bin:/bin',
      'ExecStart=/usr/local/bin/openclaw gateway', 'Restart=always', 'RestartSec=5',
      'WorkingDirectory=/root', '',
      '[Install]', 'WantedBy=multi-user.target',
    ].join('\\n');

    await this._exec(nodeConfig, `printf '${svcUnit}' | sudo tee /etc/systemd/system/openclaw-gateway.service > /dev/null`, log);
    await this._exec(nodeConfig, 'sudo systemctl daemon-reload && sudo systemctl enable openclaw-gateway && sudo systemctl start openclaw-gateway', log);
    await this._exec(nodeConfig, 'sleep 3 && sudo systemctl is-active openclaw-gateway', log);

    // Step 5: 提取 Token + 触发保存
    log(`      Token: ${token.substring(0, 8)}...`);
    this.emit('claw_ready', {
      nodeId: nodeConfig.id,
      token,
      port: 18789,
      tunAddr: nodeConfig.tunAddr,
    });

    // Step 6: 验证 RPC 可达
    await this._verifyClawRPC(nodeConfig, token, log);

    log('      ✅ OpenClaw 安装完成');
    return { token, port: 18789 };
  }

  /**
   * 从终端提取 OpenClaw Gateway Token
   * @private
   */
  async _extractClawToken(nodeConfig, log) {
    // OpenClaw 2026.x 将 token 存储在 openclaw.json → gateway.auth.token
    const tokenPaths = [
      // 优先: 从 config 文件直接提取 token
      `sudo python3 -c "import json; c=json.load(open('/root/.openclaw/openclaw.json')); print(c.get('gateway',{}).get('auth',{}).get('token',''))" 2>/dev/null`,
      `sudo python3 -c "import json; c=json.load(open('/home/synon/.openclaw/openclaw.json')); print(c.get('gateway',{}).get('auth',{}).get('token',''))" 2>/dev/null`,
      // 备选: 旧版 token 文件
      'sudo cat /root/.openclaw/.gateway-token 2>/dev/null',
    ];

    let token = '';
    for (const cmd of tokenPaths) {
      const result = (await this._execQuiet(nodeConfig, `${cmd} || true`)).trim();
      if (result && result.length > 10 && !result.includes('No such file') && !result.includes('Error')) {
        token = result;
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
   * 验证终端 OpenClaw Gateway 是否运行
   * 注意: Gateway 没有 /status JSON 端点，通过进程检测 + 端口可达性验证
   * @private
   */
  async _verifyClawRPC(nodeConfig, token, log) {
    try {
      // 检查进程是否运行
      const proc = (await this._execQuiet(nodeConfig, 'pgrep -f openclaw-gateway >/dev/null 2>&1 && echo RUNNING || echo STOPPED')).trim();
      if (proc === 'RUNNING') {
        log('      Gateway 进程运行中 ✓');
      } else {
        log('      ⚠️ Gateway 进程未检测到');
        return false;
      }
      // 检查端口可达（Gateway 返回 HTML 即表示正常）
      const portCheck = (await this._execQuiet(nodeConfig,
        `curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:18789/ 2>/dev/null || echo 000`
      )).trim();
      if (portCheck === '200') {
        log('      Gateway 端口可达 ✓');
        return true;
      }
      log(`      Gateway 端口响应: ${portCheck}`);
      return false;
    } catch (err) {
      log(`      RPC 验证失败: ${err.message}`);
      return false;
    }
  }

  /**
   * 获取 Console API 基础地址（通过 TUN 网络可达）
   * @private
   * @returns {string|null}
   */
  _getConsoleApiBase(_nodeConfig) {
    return this.config.consoleApiBase || null;
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
