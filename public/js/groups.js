'use strict';
// @alpha: 分组管理模块

const Groups = {
  async render(container) {
    container.innerHTML = `<div class="space-y-4">
      <div class="flex items-center justify-between">
        <h3 class="text-lg font-semibold">分组管理</h3>
        <button class="px-4 py-2 text-sm rounded-lg bg-primary hover:bg-primary-light text-white transition cursor-pointer flex items-center gap-1.5" onclick="Groups.showCreateModal()">${L('plus')} 创建分组</button>
      </div>
      <div id="groups-table-wrap" class="text-text-muted">加载中...</div>
    </div>`;
    refreshIcons();
    await this.loadTable();
  },

  async loadTable() {
    const wrap = $('#groups-table-wrap');
    if (!wrap) return;
    try {
      const res = await App.authFetch('/api/nodes/groups');
      const data = await res.json();
      const groups = data.groups || [];
      App.nodeGroups = groups;

      if (groups.length === 0) { wrap.innerHTML = `<div class="text-text-muted text-sm text-center py-10">暂无分组，点击「创建分组」开始</div>`; return; }

      let html = `<div class="bg-surface rounded-lg border border-border-default overflow-hidden">
        <table class="w-full text-sm"><thead><tr class="border-b border-border-default text-xs text-text-muted">
          <th class="text-left px-4 py-2.5 font-medium">颜色</th>
          <th class="text-left px-4 py-2.5 font-medium">名称</th>
          <th class="text-left px-4 py-2.5 font-medium">节点数</th>
          <th class="text-left px-4 py-2.5 font-medium">创建时间</th>
          <th class="text-left px-4 py-2.5 font-medium">操作</th>
        </tr></thead><tbody>`;
      for (const g of groups) {
        const created = g.createdAt ? new Date(g.createdAt).toLocaleString() : '—';
        html += `<tr class="border-b border-border-subtle hover:bg-elevated/50 transition">
          <td class="px-4 py-2.5"><span class="w-4 h-4 rounded-full inline-block" style="background:${escHtml(g.color)}"></span></td>
          <td class="px-4 py-2.5 font-medium">${escHtml(g.name)}</td>
          <td class="px-4 py-2.5 text-text-secondary">${g.nodeCount ?? 0}</td>
          <td class="px-4 py-2.5 text-text-secondary">${created}</td>
          <td class="px-4 py-2.5"><div class="flex gap-1">
            <button class="p-1 rounded text-text-muted hover:text-text-primary hover:bg-elevated transition cursor-pointer" onclick="Groups.showEditModal('${safeAttr(g.id)}')" title="编辑">${L('pencil')}</button>
            <button class="p-1 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition cursor-pointer" onclick="Groups.deleteGroup('${safeAttr(g.id)}')" title="删除">${L('trash-2')}</button>
          </div></td>
        </tr>`;
      }
      html += `</tbody></table></div>`;
      wrap.innerHTML = html;
      refreshIcons();
    } catch (e) { wrap.innerHTML = `<div class="text-text-muted text-sm">加载失败: ${escHtml(e.message)}</div>`; }
  },

  showCreateModal() {
    Modal.show(`
      <h3 class="text-base font-semibold mb-4">新建分组</h3>
      <label class="block text-xs text-text-secondary mb-1">分组名称</label>
      <input type="text" id="group-name-input" placeholder="输入分组名称..." autofocus class="w-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary mb-3 outline-none focus:border-primary">
      <label class="block text-xs text-text-secondary mb-1">颜色</label>
      ${Modal.renderColorPicker()}
      <div class="flex justify-end gap-2 mt-5">
        <button class="px-4 py-2 text-sm rounded-lg bg-elevated hover:bg-border-default text-text-secondary transition cursor-pointer" onclick="App.closeModal()">取消</button>
        <button class="px-4 py-2 text-sm rounded-lg bg-primary hover:bg-primary-light text-white transition cursor-pointer" onclick="Groups.createGroup()">创建</button>
      </div>
    `);
  },

  async createGroup() {
    const name = $('#group-name-input')?.value?.trim();
    if (!name) { alert('名称不能为空'); return; }
    try {
      const res = await App.authFetch('/api/nodes/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color: Modal.pickedColor }) });
      if (res.status === 409) { alert('同名分组已存在'); return; }
      if (!res.ok) { alert('创建失败'); return; }
      App.closeModal();
      await this.loadTable();
    } catch (e) { alert(`创建失败: ${e.message}`); }
  },

  showEditModal(groupId) {
    const group = App.nodeGroups.find(g => g.id === groupId);
    if (!group) return;
    Modal.show(`
      <h3 class="text-base font-semibold mb-4">编辑分组</h3>
      <label class="block text-xs text-text-secondary mb-1">分组名称</label>
      <input type="text" id="edit-group-name" value="${escHtml(group.name)}" autofocus class="w-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary mb-3 outline-none focus:border-primary">
      <label class="block text-xs text-text-secondary mb-1">颜色</label>
      ${Modal.renderColorPicker(group.color)}
      <div class="flex justify-end gap-2 mt-5">
        <button class="px-4 py-2 text-sm rounded-lg bg-elevated hover:bg-border-default text-text-secondary transition cursor-pointer" onclick="App.closeModal()">取消</button>
        <button class="px-4 py-2 text-sm rounded-lg bg-primary hover:bg-primary-light text-white transition cursor-pointer" onclick="Groups.updateGroup('${safeAttr(groupId)}')">保存</button>
      </div>
    `);
  },

  async updateGroup(groupId) {
    const name = $('#edit-group-name')?.value?.trim();
    if (!name) { alert('名称不能为空'); return; }
    try {
      const res = await App.authFetch(`/api/nodes/groups/${encodeURIComponent(groupId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color: Modal.pickedColor }) });
      if (!res.ok) { const d = await res.json(); alert(d.message || d.error || '更新失败'); return; }
      App.closeModal();
      await this.loadTable();
    } catch (e) { alert(`更新失败: ${e.message}`); }
  },

  async deleteGroup(groupId) {
    if (!confirm('确认删除此分组？节点将回归未分组')) return;
    try {
      await App.authFetch(`/api/nodes/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
      if (App.nodeFilter.groupId === groupId) App.nodeFilter.groupId = null;
      await this.loadTable();
    } catch (e) { alert(`删除失败: ${e.message}`); }
  },
};
