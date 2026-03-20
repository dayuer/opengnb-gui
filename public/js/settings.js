'use strict';
// @alpha: 系统设置模块

const Settings = {
  async render(container) {
    container.innerHTML = `<div class="space-y-6 max-w-2xl">
      <div>
        <h3 class="flex items-center gap-2 text-base font-semibold mb-3">${L('info')} 系统信息</h3>
        <div id="settings-health" class="text-text-muted text-sm">加载中...</div>
      </div>
      <div>
        <h3 class="flex items-center gap-2 text-base font-semibold mb-3">${L('key-round')} 修改密码</h3>
        <form id="change-pwd-form" class="space-y-3" onsubmit="Settings.changePwd(event)">
          <div>
            <label class="block text-xs text-text-secondary mb-1">当前密码</label>
            <input class="w-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-primary" type="password" id="pwd-old" required autocomplete="current-password">
          </div>
          <div>
            <label class="block text-xs text-text-secondary mb-1">新密码（至少 8 位）</label>
            <input class="w-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-primary" type="password" id="pwd-new" required minlength="8" autocomplete="new-password">
          </div>
          <div>
            <label class="block text-xs text-text-secondary mb-1">确认新密码</label>
            <input class="w-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-primary" type="password" id="pwd-confirm" required minlength="8" autocomplete="new-password">
          </div>
          <div id="pwd-error" class="hidden text-danger text-xs"></div>
          <button type="submit" id="pwd-submit-btn" class="px-4 py-2 text-sm rounded-lg bg-primary hover:bg-primary-light text-white transition cursor-pointer flex items-center gap-1.5">${L('check')} 修改密码</button>
        </form>
      </div>
    </div>`;
    refreshIcons();
    await this.loadHealth();
  },

  async loadHealth() {
    const wrap = $('#settings-health');
    if (!wrap) return;
    try {
      const res = await App.authFetch('/api/health');
      const d = await res.json();
      wrap.innerHTML = `<div class="grid grid-cols-2 md:grid-cols-3 gap-3">
        ${this._infoCard(L('activity'), '状态', d.status === 'ok' ? '正常运行' : d.status, d.status === 'ok' ? 'text-success' : 'text-danger')}
        ${this._infoCard(L('clock'), '运行时间', formatUptime(d.uptime), '')}
        ${this._infoCard(L('globe'), '总节点', String(d.nodesTotal), 'text-primary')}
        ${this._infoCard(L('check-circle'), '已审批', String(d.nodesApproved), 'text-success')}
        ${this._infoCard(L('clock'), '待审批', String(d.nodesPending), d.nodesPending > 0 ? 'text-warning' : '')}
        ${this._infoCard(L('server'), '版本', 'v0.1.0', '')}
      </div>`;
      refreshIcons();
    } catch (e) { wrap.innerHTML = `<div class="text-text-muted text-sm">加载失败: ${escHtml(e.message)}</div>`; }
  },

  _infoCard(icon, label, value, color) {
    return `<div class="bg-surface rounded-xl border border-border-default p-4">
      <div class="flex items-center gap-1.5 text-text-muted mb-1.5"><span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${icon}</span><span class="text-xs">${escHtml(label)}</span></div>
      <div class="text-sm font-semibold ${color}">${value}</div>
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
