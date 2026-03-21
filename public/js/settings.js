'use strict';
// @alpha: 系统设置 — Stitch "System Settings" 风格

let settingsTab = 'general';

function switchSettingsTab(tab) {
  settingsTab = tab;
  Settings.render($('#main-content'));
}

const Settings = {
  async render(container) {
    container.innerHTML = `<div class="space-y-8">
      <!-- 页面标题 -->
      <div class="mb-2">
        <h1 class="text-3xl font-extrabold tracking-tight font-headline mb-2">系统设置</h1>
        <p class="text-text-muted max-w-2xl leading-relaxed">配置节点管理平台的安全策略、部署参数和监控选项。</p>
      </div>

      <!-- 3:9 网格布局 -->
      <div class="grid grid-cols-1 md:grid-cols-12 gap-8">
        <!-- 左侧纵向标签 -->
        <div class="md:col-span-3">
          <nav class="flex flex-col gap-1 sticky top-20">
            ${this._tab('general', 'settings', '通用设置')}
            ${this._tab('security', 'shield', '安全与密码')}
            ${this._tab('monitor', 'activity', '监控配置')}
            ${this._tab('deploy', 'cloud', '部署信息')}
          </nav>
        </div>

        <!-- 右侧内容 -->
        <div class="md:col-span-9 space-y-8">
          ${settingsTab === 'general' ? this._generalSection() : ''}
          ${settingsTab === 'security' ? this._securitySection() : ''}
          ${settingsTab === 'monitor' ? this._monitorSection() : ''}
          ${settingsTab === 'deploy' ? this._deploySection() : ''}

          <!-- 操作按钮 -->
          <div class="flex items-center justify-end gap-3 pt-2">
            <button class="px-6 py-2.5 text-sm font-semibold text-text-muted hover:bg-elevated rounded-lg transition-all cursor-pointer" onclick="Settings.render($('#main-content'))">放弃更改</button>
            <button class="px-8 py-2.5 text-sm font-bold signature-gradient text-white rounded-lg shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all cursor-pointer" onclick="showToast('设置已保存')">保存更改</button>
          </div>
        </div>
      </div>
    </div>`;
    refreshIcons();
    if (settingsTab === 'general') await this.loadHealth();
  },

  _tab(id, icon, label) {
    const active = settingsTab === id;
    return `<button class="flex items-center gap-3 px-4 py-3 text-sm ${active ? 'font-semibold text-primary bg-primary/10' : 'font-medium text-text-muted hover:bg-elevated'} rounded-lg text-left transition-all cursor-pointer [&_svg]:w-5 [&_svg]:h-5" onclick="switchSettingsTab('${id}')">
      ${L(icon)}<span>${label}</span>
    </button>`;
  },

  // ── 通用设置 ──
  _generalSection() {
    return `<section class="bg-surface p-8 rounded-xl shadow-ambient border border-border-default space-y-8">
      <div>
        <h2 class="text-xl font-bold font-headline mb-1">通用设置</h2>
        <p class="text-sm text-text-muted">平台基本信息和运行状态。</p>
      </div>
      <div id="settings-health" class="text-text-muted text-sm">加载中...</div>
    </section>`;
  },

  // ── 安全与密码 ──
  _securitySection() {
    return `<section class="bg-surface p-8 rounded-xl shadow-ambient border border-border-default space-y-8">
      <div class="flex justify-between items-start">
        <div>
          <h2 class="text-xl font-bold font-headline mb-1">安全与密码</h2>
          <p class="text-sm text-text-muted">管理访问凭证和认证策略。</p>
        </div>
      </div>

      <!-- 修改密码表单 -->
      <form id="change-pwd-form" class="space-y-6 max-w-xl" onsubmit="Settings.changePwd(event)">
        <div class="space-y-2">
          <label class="block text-sm font-medium">当前密码</label>
          <input class="w-full px-4 py-2.5 bg-elevated border border-border-default rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all outline-none text-sm" type="password" id="pwd-old" required autocomplete="current-password" placeholder="输入当前密码">
        </div>
        <div class="space-y-2">
          <label class="block text-sm font-medium">新密码（至少 8 位）</label>
          <input class="w-full px-4 py-2.5 bg-elevated border border-border-default rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all outline-none text-sm" type="password" id="pwd-new" required minlength="8" autocomplete="new-password" placeholder="输入新密码">
        </div>
        <div class="space-y-2">
          <label class="block text-sm font-medium">确认新密码</label>
          <input class="w-full px-4 py-2.5 bg-elevated border border-border-default rounded-lg focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all outline-none text-sm" type="password" id="pwd-confirm" required minlength="8" autocomplete="new-password" placeholder="再次输入新密码">
        </div>
        <div id="pwd-error" class="hidden text-danger text-xs"></div>
        <button type="submit" id="pwd-submit-btn" class="px-6 py-2.5 text-sm font-bold signature-gradient text-white rounded-lg shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all cursor-pointer flex items-center gap-2">
          ${L('check')} <span>修改密码</span>
        </button>
      </form>

      <!-- API Key 展示 -->
      <div class="space-y-4 pt-4 border-t border-border-subtle">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-bold uppercase tracking-tight">API 密钥</h3>
          <button class="text-xs font-semibold text-primary flex items-center gap-1 hover:underline cursor-pointer" onclick="App.showApiKey()">
            ${L('plus')} 查看 / 复制
          </button>
        </div>
        <div class="flex items-center justify-between p-4 bg-elevated rounded-lg border border-border-default">
          <div class="flex items-center gap-4">
            <div class="h-10 w-10 bg-primary/10 rounded-full flex items-center justify-center text-primary [&_svg]:w-5 [&_svg]:h-5">${L('key-round')}</div>
            <div>
              <h4 class="text-sm font-bold">Admin Token</h4>
              <p class="text-xs text-text-muted">用于 API 认证的管理令牌</p>
            </div>
          </div>
          <span class="text-xs font-mono text-text-muted">••••••••</span>
        </div>
      </div>
    </section>`;
  },

  // ── 监控配置 ──
  _monitorSection() {
    return `<section class="bg-surface p-8 rounded-xl shadow-ambient border border-border-default space-y-8">
      <div>
        <h2 class="text-xl font-bold font-headline mb-1">监控配置</h2>
        <p class="text-sm text-text-muted">设置节点轮询频率和超时阈值。</p>
      </div>
      <div class="grid grid-cols-1 gap-6 max-w-xl">
        <div class="flex items-center justify-between p-4 bg-elevated rounded-lg border border-border-default">
          <div class="flex items-center gap-4">
            <div class="h-10 w-10 bg-primary/10 rounded-full flex items-center justify-center text-primary [&_svg]:w-5 [&_svg]:h-5">${L('timer')}</div>
            <div>
              <h4 class="text-sm font-bold">轮询间隔</h4>
              <p class="text-xs text-text-muted">Agent 数据上报间隔（秒）</p>
            </div>
          </div>
          <span class="text-sm font-bold font-mono text-primary">10s</span>
        </div>
        <div class="flex items-center justify-between p-4 bg-elevated rounded-lg border border-border-default">
          <div class="flex items-center gap-4">
            <div class="h-10 w-10 bg-warning/10 rounded-full flex items-center justify-center text-warning [&_svg]:w-5 [&_svg]:h-5">${L('alert-triangle')}</div>
            <div>
              <h4 class="text-sm font-bold">离线超时</h4>
              <p class="text-xs text-text-muted">超过此时间未上报判定离线</p>
            </div>
          </div>
          <span class="text-sm font-bold font-mono text-warning">120s</span>
        </div>
        <div class="flex items-center justify-between p-4 bg-elevated rounded-lg border border-border-default">
          <div class="flex items-center gap-4">
            <div class="h-10 w-10 bg-success/10 rounded-full flex items-center justify-center text-success [&_svg]:w-5 [&_svg]:h-5">${L('refresh-cw')}</div>
            <div>
              <h4 class="text-sm font-bold">Agent 自更新</h4>
              <p class="text-xs text-text-muted">Agent 从 Console 自动拉取最新脚本</p>
            </div>
          </div>
          <span class="text-sm font-bold font-mono text-success">~1h</span>
        </div>
      </div>
    </section>`;
  },

  // ── 部署信息 ──
  _deploySection() {
    return `<section class="bg-surface p-8 rounded-xl shadow-ambient border border-border-default space-y-8">
      <div>
        <h2 class="text-xl font-bold font-headline mb-1">部署信息</h2>
        <p class="text-sm text-text-muted">当前 Console 实例的部署配置。</p>
      </div>
      <div class="grid grid-cols-1 gap-6 max-w-xl">
        <div class="space-y-2">
          <label class="block text-sm font-medium">节点注册命令</label>
          <div class="relative">
            <pre class="w-full px-4 py-3 bg-elevated border border-border-default rounded-lg text-xs font-mono text-text-secondary overflow-x-auto">curl -sSf https://api.synonclaw.com/api/enroll/node-agent.sh | sudo bash</pre>
          </div>
          <p class="text-xs text-text-muted italic">在目标节点上执行此命令即可自动注册。</p>
        </div>
        <div class="space-y-2">
          <label class="block text-sm font-medium">SSH 密钥</label>
          <div class="flex items-center justify-between p-4 bg-elevated rounded-lg border border-border-default">
            <div class="flex items-center gap-4">
              <div class="h-10 w-10 bg-primary/10 rounded-full flex items-center justify-center text-primary [&_svg]:w-5 [&_svg]:h-5">${L('shield')}</div>
              <div>
                <h4 class="text-sm font-bold">Console SSH Key</h4>
                <p class="text-xs text-text-muted font-mono">data/security/ssh/console_ed25519</p>
              </div>
            </div>
            <span class="px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-success bg-secondary-container rounded-full">Active</span>
          </div>
        </div>
        <div class="space-y-2">
          <label class="block text-sm font-medium">数据目录</label>
          <div class="p-4 bg-elevated rounded-lg border border-border-default text-xs font-mono text-text-secondary space-y-1">
            <div>data/registry/    — 节点注册数据库</div>
            <div>data/security/ssh/ — SSH 密钥对</div>
            <div>data/logs/        — 运行日志</div>
          </div>
        </div>
      </div>
    </section>`;
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
    return `<div class="bg-elevated rounded-lg border border-border-default p-4">
      <div class="flex items-center gap-2 text-text-muted mb-2">
        <span class="[&_svg]:w-4 [&_svg]:h-4">${icon}</span>
        <span class="text-xs font-medium uppercase tracking-wider">${escHtml(label)}</span>
      </div>
      <div class="text-lg font-bold ${color}">${value}</div>
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
