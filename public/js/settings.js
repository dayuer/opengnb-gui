'use strict';
// @alpha: 系统设置 — 3-Tab 精简重构（通用 + 安全 + 监控）
// 已删除：网络/部署/高级 Tab（假功能、无后端 API）

let settingsTab = 'general';

function switchSettingsTab(tab) {
  settingsTab = tab;
  Settings.render($('#main-content'));
}

const Settings = {
  async render(container) {
    const tabs = [
      { id: 'general', icon: 'settings', label: '通用' },
      { id: 'security', icon: 'shield', label: '安全' },
      { id: 'monitor', icon: 'activity', label: '监控' },
    ];

    container.innerHTML = `<div class="space-y-8">
      <!-- 页面标题 -->
      <div class="mb-2">
        <h1 class="text-3xl font-extrabold tracking-tight font-headline mb-2">系统设置</h1>
        <p class="text-text-muted max-w-2xl leading-relaxed">查看系统运行状态、管理安全凭证。</p>
      </div>

      <!-- 水平标签栏 -->
      <div class="bg-surface rounded-xl shadow-ambient border border-border-default overflow-hidden">
        <div class="flex items-center overflow-x-auto border-b border-border-subtle px-2">
          ${tabs.map(t => {
            const active = settingsTab === t.id;
            return `<button class="flex items-center gap-2 px-5 py-4 text-sm whitespace-nowrap transition-all cursor-pointer relative ${active ? 'text-primary font-bold' : 'text-text-muted hover:text-text-primary'} [&_svg]:w-4 [&_svg]:h-4" onclick="switchSettingsTab('${t.id}')">
              ${L(t.icon)}<span>${t.label}</span>
              ${active ? `<div class="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 w-3/4 signature-gradient rounded-full"></div>` : ''}
            </button>`;
          }).join('')}
        </div>

        <!-- 内容区 -->
        <div class="p-8">
          ${settingsTab === 'general' ? this._generalSection() : ''}
          ${settingsTab === 'security' ? this._securitySection() : ''}
          ${settingsTab === 'monitor' ? this._monitorSection() : ''}
        </div>
      </div>
    </div>`;
    refreshIcons();
    if (settingsTab === 'general') await this.loadHealth();
  },

  // ── 通用 Tab ──
  _generalSection() {
    return `<div class="space-y-8">
      <div>
        <h2 class="text-xl font-bold font-headline mb-1">系统概览</h2>
        <p class="text-sm text-text-muted">系统运行状态和基础信息。</p>
      </div>
      <div id="settings-health" class="text-text-muted text-sm">加载中...</div>

      <!-- 平台信息 -->
      <div class="border-t border-border-subtle pt-8">
        <h3 class="text-sm font-bold uppercase tracking-widest text-text-muted mb-6">平台信息</h3>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          ${this._infoCard(L('monitor'), '平台', 'SynonClaw Console', 'text-primary')}
          ${this._infoCard(L('tag'), '版本', 'v0.1.0', '')}
          ${this._infoCard(L('database'), '存储引擎', 'SQLite', 'text-success')}
          ${this._infoCard(L('cpu'), '运行时', 'Node.js 20+', 'text-primary')}
        </div>
      </div>

      <!-- 节点注册 -->
      <div class="border-t border-border-subtle pt-8">
        <h3 class="text-sm font-bold uppercase tracking-widest text-text-muted mb-6">节点注册</h3>
        <div class="bg-elevated rounded-xl border border-border-default p-5 space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="h-10 w-10 signature-gradient rounded-xl flex items-center justify-center text-white [&_svg]:w-4 [&_svg]:h-4 shadow-lg shadow-primary/20">${L('terminal')}</div>
              <div>
                <h4 class="text-sm font-bold font-headline">注册命令</h4>
                <p class="text-xs text-text-muted">在目标节点上执行此命令自动注册</p>
              </div>
            </div>
            <button class="px-3 py-1.5 text-xs font-bold text-primary bg-primary/10 rounded-lg hover:bg-primary/20 transition cursor-pointer flex items-center gap-1 [&_svg]:w-3.5 [&_svg]:h-3.5" onclick="navigator.clipboard.writeText('curl -sSf https://api.synonclaw.com/api/enroll/node-agent.sh | sudo bash');showToast('已复制到剪贴板')">${L('copy')} 复制</button>
          </div>
          <pre class="px-4 py-3 bg-base rounded-lg text-xs font-mono text-text-secondary overflow-x-auto border border-border-subtle">curl -sSf https://api.synonclaw.com/api/enroll/node-agent.sh | sudo bash</pre>
        </div>
      </div>

      <!-- 安全凭证 -->
      <div class="border-t border-border-subtle pt-8">
        <h3 class="text-sm font-bold uppercase tracking-widest text-text-muted mb-6">安全凭证</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="bg-elevated rounded-xl border border-border-default p-5 flex items-center justify-between hover:shadow-sm transition-shadow">
            <div class="flex items-center gap-4">
              <div class="h-11 w-11 bg-primary/10 rounded-xl flex items-center justify-center text-primary [&_svg]:w-5 [&_svg]:h-5">${L('shield')}</div>
              <div>
                <h4 class="text-sm font-bold">Console SSH Key</h4>
                <p class="text-xs text-text-muted font-mono mt-0.5">ED25519 密钥对</p>
              </div>
            </div>
            <span class="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-success bg-secondary-container rounded-full">Active</span>
          </div>
          <div class="bg-elevated rounded-xl border border-border-default p-5 flex items-center justify-between hover:shadow-sm transition-shadow">
            <div class="flex items-center gap-4">
              <div class="h-11 w-11 bg-success/10 rounded-xl flex items-center justify-center text-success [&_svg]:w-5 [&_svg]:h-5">${L('lock')}</div>
              <div>
                <h4 class="text-sm font-bold">TLS 证书</h4>
                <p class="text-xs text-text-muted font-mono mt-0.5">Nginx HTTPS 反代</p>
              </div>
            </div>
            <span class="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-success bg-secondary-container rounded-full">Valid</span>
          </div>
        </div>
      </div>
    </div>`;
  },

  // ── 安全 Tab ──
  _securitySection() {
    return `<div class="space-y-8">
      <div>
        <h2 class="text-xl font-bold font-headline mb-1">安全设置</h2>
        <p class="text-sm text-text-muted">管理访问凭证和认证策略。</p>
      </div>

      <!-- 修改密码 -->
      <div class="border-t border-border-subtle pt-8">
        <h3 class="text-sm font-bold uppercase tracking-widest text-text-muted mb-6">修改密码</h3>
        <form id="change-pwd-form" class="space-y-6" onsubmit="Settings.changePwd(event)">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div class="space-y-2">
              <label class="block text-sm font-medium">当前密码</label>
              <input class="w-full px-4 py-3 bg-elevated border border-border-default rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all outline-none text-sm" type="password" id="pwd-old" required autocomplete="current-password" placeholder="输入当前密码">
            </div>
            <div></div>
            <div class="space-y-2">
              <label class="block text-sm font-medium">新密码（至少 8 位）</label>
              <input class="w-full px-4 py-3 bg-elevated border border-border-default rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all outline-none text-sm" type="password" id="pwd-new" required minlength="8" autocomplete="new-password" placeholder="输入新密码">
            </div>
            <div class="space-y-2">
              <label class="block text-sm font-medium">确认新密码</label>
              <input class="w-full px-4 py-3 bg-elevated border border-border-default rounded-xl focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all outline-none text-sm" type="password" id="pwd-confirm" required minlength="8" autocomplete="new-password" placeholder="再次输入新密码">
            </div>
          </div>
          <div id="pwd-error" class="hidden text-danger text-xs"></div>
          <button type="submit" id="pwd-submit-btn" class="px-6 py-3 text-sm font-bold signature-gradient text-white rounded-xl shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all cursor-pointer flex items-center gap-2 [&_svg]:w-4 [&_svg]:h-4">
            ${L('check')} <span>修改密码</span>
          </button>
        </form>
      </div>

      <!-- API 密钥 -->
      <div class="border-t border-border-subtle pt-8">
        <div class="flex items-center justify-between mb-6">
          <h3 class="text-sm font-bold uppercase tracking-widest text-text-muted">API 密钥</h3>
          <button class="text-xs font-bold text-primary flex items-center gap-1 hover:underline cursor-pointer [&_svg]:w-3.5 [&_svg]:h-3.5" onclick="App.showApiKey()">
            ${L('eye')} 查看 / 复制
          </button>
        </div>
        <div class="bg-elevated rounded-xl border border-border-default overflow-hidden">
          <div class="flex items-center justify-between p-5">
            <div class="flex items-center gap-4">
              <div class="h-12 w-12 signature-gradient rounded-xl flex items-center justify-center text-white [&_svg]:w-5 [&_svg]:h-5 shadow-lg shadow-primary/20">${L('key-round')}</div>
              <div>
                <h4 class="text-sm font-bold font-headline">Admin Token</h4>
                <p class="text-xs text-text-muted mt-0.5">用于 API 认证的管理令牌</p>
              </div>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-sm font-mono text-text-muted tracking-wider">••••••••••••</span>
              <span class="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-success bg-secondary-container rounded-full">Active</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  },

  // ── 监控 Tab ──
  _monitorSection() {
    const items = [
      { icon: 'timer', color: 'primary', label: '上报间隔', desc: 'Agent 每 10 秒向 Console 推送数据', value: '10s', valColor: 'text-primary' },
      { icon: 'alert-triangle', color: 'warning', label: '离线判定', desc: '超过 120 秒无上报即标记离线', value: '120s', valColor: 'text-warning' },
      { icon: 'refresh-cw', color: 'success', label: 'Agent 自更新', desc: 'Agent 定期从 Console 拉取最新脚本', value: '~1h', valColor: 'text-success' },
      { icon: 'bar-chart-3', color: 'primary', label: '历史保留', desc: '监控指标历史数据保留时长', value: '7 天', valColor: '' },
    ];
    return `<div class="space-y-8">
      <div>
        <h2 class="text-xl font-bold font-headline mb-1">监控配置</h2>
        <p class="text-sm text-text-muted">节点监控的运行参数。如需修改请更新服务端配置后重启。</p>
      </div>

      <div class="border-t border-border-subtle pt-8">
        <h3 class="text-sm font-bold uppercase tracking-widest text-text-muted mb-6">运行参数</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          ${items.map(item => `<div class="bg-elevated rounded-xl border border-border-default p-5 flex items-center justify-between hover:shadow-sm transition-shadow">
            <div class="flex items-center gap-4">
              <div class="h-11 w-11 bg-${item.color}/10 rounded-xl flex items-center justify-center text-${item.color} [&_svg]:w-5 [&_svg]:h-5">${L(item.icon)}</div>
              <div>
                <h4 class="text-sm font-bold">${item.label}</h4>
                <p class="text-xs text-text-muted mt-0.5">${item.desc}</p>
              </div>
            </div>
            <span class="text-sm font-bold font-mono ${item.valColor}">${item.value}</span>
          </div>`).join('')}
        </div>
      </div>

      <!-- 网络概览 -->
      <div class="border-t border-border-subtle pt-8">
        <h3 class="text-sm font-bold uppercase tracking-widest text-text-muted mb-6">网络参数</h3>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          ${this._infoCard(L('globe'), '子网', '10.1.0.0/16', 'text-primary')}
          ${this._infoCard(L('shield'), '加密', 'ED25519', 'text-success')}
          ${this._infoCard(L('server'), '端口', '3000', '')}
          ${this._infoCard(L('link'), '域名', 'api.synonclaw.com', 'text-primary')}
        </div>
      </div>
    </div>`;
  },

  async loadHealth() {
    const wrap = $('#settings-health');
    if (!wrap) return;
    try {
      const res = await App.authFetch('/api/health');
      const d = await res.json();
      wrap.innerHTML = `<div class="grid grid-cols-2 md:grid-cols-3 gap-4">
        ${this._infoCard(L('activity'), '运行状态', d.status === 'ok' ? '正常运行' : d.status, d.status === 'ok' ? 'text-success' : 'text-danger')}
        ${this._infoCard(L('clock'), '运行时间', formatUptime(d.uptime), '')}
        ${this._infoCard(L('globe'), '总节点数', String(d.nodesTotal), 'text-primary')}
        ${this._infoCard(L('check-circle'), '已审批', String(d.nodesApproved), 'text-success')}
        ${this._infoCard(L('clock'), '待审批', String(d.nodesPending), d.nodesPending > 0 ? 'text-warning' : '')}
        ${this._infoCard(L('server'), '版本', 'v0.1.0', '')}
      </div>`;
      refreshIcons();
    } catch (e) { wrap.innerHTML = `<div class="text-text-muted text-sm">加载失败: ${escHtml(e.message)}</div>`; }
  },

  _infoCard(icon, label, value, color) {
    return `<div class="bg-elevated rounded-xl border border-border-default p-4">
      <div class="flex items-center gap-2 text-text-muted mb-2">
        <span class="[&_svg]:w-4 [&_svg]:h-4">${icon}</span>
        <span class="text-xs font-bold uppercase tracking-wider">${escHtml(label)}</span>
      </div>
      <div class="text-lg font-bold font-headline ${color}">${value}</div>
    </div>`;
  },

  async changePwd(e) {
    e.preventDefault();
    const oldPwd = $('#pwd-old')?.value;
    const newPwd = $('#pwd-new')?.value;
    const confirmPwd = $('#pwd-confirm')?.value;
    const errEl = $('#pwd-error');
    const btn = $('#pwd-submit-btn');
    if (newPwd !== confirmPwd) { if (errEl) { errEl.textContent = '两次输入的新密码不一致'; errEl.classList.remove('hidden'); } return; }
    if (btn) { btn.disabled = true; btn.textContent = '提交中...'; }
    if (errEl) errEl.classList.add('hidden');
    try {
      const res = await App.authFetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }) });
      const data = await res.json();
      if (!res.ok) { if (errEl) { errEl.textContent = data.error || '修改失败'; errEl.classList.remove('hidden'); } }
      else { showToast('密码修改成功'); ['#pwd-old','#pwd-new','#pwd-confirm'].forEach(s => { if ($(s)) $(s).value = ''; }); }
    } catch (err) { if (errEl) { errEl.textContent = '网络错误: ' + err.message; errEl.classList.remove('hidden'); } }
    if (btn) { btn.disabled = false; btn.textContent = '修改密码'; }
  },
};
