'use strict';
// @alpha: 用户管理 — Stitch "Identity & Access Management" 风格

const Users = {
  async render(container) {
    const usersRes = await App.authFetch('/api/auth/users').catch(() => null);
    const users = usersRes ? await usersRes.json() : [];

    container.innerHTML = `<div class="space-y-8">
      <!-- 页面标题 -->
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 class="text-3xl font-extrabold tracking-tight font-headline mb-2">用户与权限</h1>
          <p class="text-text-muted max-w-lg leading-relaxed">管理控制台用户账户和访问权限。</p>
        </div>
        <button class="px-5 py-2.5 signature-gradient text-white rounded-lg font-bold text-sm shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all flex items-center gap-2 cursor-pointer" onclick="Users.showCreateModal()">
          ${L('user-plus')}<span>创建用户</span>
        </button>
      </div>

      <!-- 8:4 网格布局 -->
      <div class="grid grid-cols-12 gap-8 items-start">
        <!-- 左侧: 用户表格 -->
        <div class="col-span-12 lg:col-span-8 space-y-6">
          <!-- 用户表格卡片 -->
          <div class="bg-surface rounded-xl shadow-ambient overflow-hidden border border-border-default">
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse">
                <thead class="bg-elevated/50">
                  <tr>
                    <th class="px-6 py-4 text-xs font-bold text-text-muted uppercase tracking-widest">用户</th>
                    <th class="px-6 py-4 text-xs font-bold text-text-muted uppercase tracking-widest">角色</th>
                    <th class="px-6 py-4 text-xs font-bold text-text-muted uppercase tracking-widest">创建时间</th>
                    <th class="px-6 py-4 text-xs font-bold text-text-muted uppercase tracking-widest text-right">操作</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border-subtle">
                  ${users.map(u => {
                    const initials = (u.username || '?').slice(0, 2).toUpperCase();
                    const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—';
                    const isAdmin = u.role === 'admin';
                    return `<tr class="hover:bg-elevated/50 transition-colors group">
                      <td class="px-6 py-5">
                        <div class="flex items-center gap-3">
                          <div class="w-10 h-10 rounded-lg ${isAdmin ? 'bg-primary/10 text-primary' : 'bg-elevated text-text-secondary'} flex items-center justify-center font-bold text-sm">${initials}</div>
                          <div>
                            <div class="font-bold font-headline">${escHtml(u.username)}</div>
                            <div class="text-xs text-text-muted">ID: ${escHtml(u.id?.slice(0, 8) || '—')}</div>
                          </div>
                        </div>
                      </td>
                      <td class="px-6 py-5">
                        <span class="px-3 py-1 ${isAdmin ? 'bg-secondary-container text-success' : 'bg-elevated text-text-secondary'} rounded-full text-xs font-bold flex items-center gap-1 w-fit">
                          <span class="w-1.5 h-1.5 rounded-full ${isAdmin ? 'bg-success' : 'bg-text-muted'}"></span>
                          ${escHtml(u.role)}
                        </span>
                      </td>
                      <td class="px-6 py-5">
                        <div class="text-sm font-medium">${created}</div>
                      </td>
                      <td class="px-6 py-5 text-right">
                        <button class="p-2 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 transition cursor-pointer [&_svg]:w-4 [&_svg]:h-4" onclick="Users.deleteUser('${safeAttr(u.id)}','${safeAttr(u.username)}')" title="删除用户">${L('trash-2')}</button>
                      </td>
                    </tr>`;
                  }).join('')}
                  ${users.length === 0 ? `<tr><td colspan="4" class="px-6 py-12 text-center text-text-muted text-sm">暂无用户</td></tr>` : ''}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 右侧: 统计 + 信息 -->
        <div class="col-span-12 lg:col-span-4 space-y-6">
          <!-- 统计卡片 -->
          <div class="grid grid-cols-2 gap-4">
            <div class="signature-gradient p-5 rounded-xl text-white flex flex-col justify-between h-32 shadow-lg shadow-primary/20">
              <span class="[&_svg]:w-5 [&_svg]:h-5 opacity-60">${L('users')}</span>
              <div>
                <div class="text-3xl font-extrabold font-headline">${users.length}</div>
                <div class="text-xs font-bold opacity-70 uppercase tracking-widest">总用户</div>
              </div>
            </div>
            <div class="bg-surface p-5 rounded-xl border border-border-default flex flex-col justify-between h-32">
              <span class="[&_svg]:w-5 [&_svg]:h-5 text-success">${L('shield')}</span>
              <div>
                <div class="text-3xl font-extrabold font-headline">${users.filter(u => u.role === 'admin').length}</div>
                <div class="text-xs font-bold text-text-muted uppercase tracking-widest">管理员</div>
              </div>
            </div>
          </div>

          <!-- 安全信息卡片 -->
          <div class="bg-surface p-6 rounded-xl shadow-ambient border border-border-default">
            <h3 class="font-headline font-extrabold tracking-tight mb-4">访问安全</h3>
            <div class="space-y-4">
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-secondary-container flex items-center justify-center [&_svg]:w-4 [&_svg]:h-4 text-success">${L('check-circle')}</div>
                <div class="flex-1">
                  <p class="text-sm font-bold">JWT 认证</p>
                  <p class="text-xs text-text-muted">基于 SSH 密钥哈希生成</p>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center [&_svg]:w-4 [&_svg]:h-4 text-primary">${L('key-round')}</div>
                <div class="flex-1">
                  <p class="text-sm font-bold">API Token</p>
                  <p class="text-xs text-text-muted">环境变量自动生成</p>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-elevated flex items-center justify-center [&_svg]:w-4 [&_svg]:h-4 text-text-muted">${L('lock')}</div>
                <div class="flex-1">
                  <p class="text-sm font-bold">密码加密</p>
                  <p class="text-xs text-text-muted">bcrypt 哈希存储</p>
                </div>
              </div>
            </div>
          </div>

          <!-- 快捷操作 -->
          <div class="relative p-6 rounded-xl overflow-hidden signature-gradient text-white cursor-pointer group" onclick="App.switchPage('settings');setTimeout(()=>switchSettingsTab('security'),100)">
            <div class="absolute top-[-20%] right-[-10%] w-32 h-32 bg-white/10 rounded-full blur-2xl group-hover:bg-white/20 transition-all"></div>
            <h4 class="font-headline font-bold text-lg relative z-10 mb-1">修改密码</h4>
            <p class="text-xs text-white/80 relative z-10 leading-relaxed">前往安全设置修改管理员密码。</p>
          </div>
        </div>
      </div>
    </div>`;
    refreshIcons();
  },

  showCreateModal() {
    Modal.show(`
      <h3 class="text-lg font-bold font-headline mb-6">创建用户</h3>
      <div class="space-y-4">
        <div class="space-y-2">
          <label class="block text-sm font-medium">用户名</label>
          <input type="text" id="new-username" placeholder="输入用户名" autofocus class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all">
        </div>
        <div class="space-y-2">
          <label class="block text-sm font-medium">密码（至少 8 位）</label>
          <input type="password" id="new-password" placeholder="输入密码" class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all">
        </div>
        <div id="create-user-error" class="hidden text-danger text-xs"></div>
      </div>
      <div class="flex justify-end gap-3 mt-6">
        <button class="px-5 py-2.5 text-sm font-semibold text-text-muted hover:bg-elevated rounded-lg transition cursor-pointer" onclick="App.closeModal()">取消</button>
        <button class="px-6 py-2.5 text-sm font-bold signature-gradient text-white rounded-lg shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all cursor-pointer" onclick="Users.createUser()">创建</button>
      </div>
    `);
  },

  async createUser() {
    const username = $('#new-username')?.value?.trim();
    const password = $('#new-password')?.value;
    const errEl = $('#create-user-error');
    if (!username || !password) return;
    try {
      const res = await App.authFetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await res.json();
      if (!res.ok) { if (errEl) { errEl.textContent = data.error || '创建失败'; errEl.classList.remove('hidden'); } return; }
      App.closeModal();
      await Users.render($('#main-content'));
    } catch (e) { if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); } }
  },

  async deleteUser(id, username) {
    if (!confirm(`确认删除用户 "${username}"？`)) return;
    try {
      const res = await App.authFetch(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 400) { const data = await res.json(); alert(data.error || '删除失败'); return; }
      await Users.render($('#main-content'));
    } catch (e) { alert(`删除失败: ${e.message}`); }
  },
};
