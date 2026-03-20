'use strict';
// @beta: 用户管理模块

const Users = {
  async render(container) {
    container.innerHTML = `<div class="space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold">用户管理</h3>
        <button class="px-4 py-2 text-sm rounded-lg bg-primary hover:bg-primary-light text-white transition cursor-pointer flex items-center gap-1.5" onclick="Users.showCreateModal()">${L('user-plus')} 创建用户</button>
      </div>
      <div id="users-table-wrap" class="text-text-muted">加载中...</div>
    </div>`;
    refreshIcons();
    await this.loadTable();
  },

  async loadTable() {
    const wrap = $('#users-table-wrap');
    if (!wrap) return;
    try {
      const res = await App.authFetch('/api/auth/users');
      const users = await res.json();
      let html = `<div class="bg-surface rounded-xl border border-border-default overflow-hidden">
        <table class="w-full text-sm"><thead><tr class="border-b border-border-default text-xs text-text-muted">
          <th class="text-left px-4 py-2.5 font-medium">用户名</th>
          <th class="text-left px-4 py-2.5 font-medium">角色</th>
          <th class="text-left px-4 py-2.5 font-medium">创建时间</th>
          <th class="text-left px-4 py-2.5 font-medium">操作</th>
        </tr></thead><tbody>`;
      for (const u of users) {
        const created = u.createdAt ? new Date(u.createdAt).toLocaleString() : '—';
        html += `<tr class="border-b border-border-subtle hover:bg-elevated/50 transition">
          <td class="px-4 py-2.5 font-medium">${escHtml(u.username)}</td>
          <td class="px-4 py-2.5"><span class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-primary/15 text-primary">${escHtml(u.role)}</span></td>
          <td class="px-4 py-2.5 text-text-secondary">${created}</td>
          <td class="px-4 py-2.5">
            <button class="p-1 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition cursor-pointer" onclick="Users.deleteUser('${safeAttr(u.id)}','${safeAttr(u.username)}')" title="删除">${L('trash-2')}</button>
          </td>
        </tr>`;
      }
      html += `</tbody></table></div>`;
      wrap.innerHTML = html;
      refreshIcons();
    } catch (e) { wrap.innerHTML = `<div class="text-text-muted text-sm">加载失败: ${escHtml(e.message)}</div>`; }
  },

  showCreateModal() {
    Modal.show(`
      <h3 class="text-base font-semibold mb-4">创建用户</h3>
      <label class="block text-xs text-text-secondary mb-1">用户名</label>
      <input type="text" id="new-username" placeholder="输入用户名" autofocus class="w-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary mb-3 outline-none focus:border-primary">
      <label class="block text-xs text-text-secondary mb-1">密码（至少 8 位）</label>
      <input type="password" id="new-password" placeholder="输入密码" class="w-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary mb-3 outline-none focus:border-primary">
      <div id="create-user-error" class="hidden text-danger text-xs mb-2"></div>
      <div class="flex justify-end gap-2 mt-2">
        <button class="px-4 py-2 text-sm rounded-lg bg-elevated hover:bg-border-default text-text-secondary transition cursor-pointer" onclick="App.closeModal()">取消</button>
        <button class="px-4 py-2 text-sm rounded-lg bg-primary hover:bg-primary-light text-white transition cursor-pointer" onclick="Users.createUser()">创建</button>
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
      await this.loadTable();
    } catch (e) { if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); } }
  },

  async deleteUser(id, username) {
    if (!confirm(`确认删除用户 "${username}"？`)) return;
    try {
      const res = await App.authFetch(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 400) { const data = await res.json(); alert(data.error || '删除失败'); return; }
      await this.loadTable();
    } catch (e) { alert(`删除失败: ${e.message}`); }
  },
};
