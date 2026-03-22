// @alpha: groups 页面模块 (TS 迁移 — Alpha pass)
import { $, $$, L, refreshIcons, escHtml, showToast, formatBytes, formatUptime, pctColor, pctBg, safeAttr, cidrMatch, isValidCidr } from '../utils';
import { Modal } from '../modal';
import { App } from '../core';
import { Nodes } from './nodes';


// @alpha: 分组管理 — Stitch "Team & Member Management" 风格

export const Groups = {
  async render(container) {
    const res = await App.authFetch('/api/nodes/groups').catch(() => null);
    const data = res ? await res.json() : {};
    const groups = data.groups || [];
    App.nodeGroups = groups;

    const totalNodes = App.nodesData?.length || 0;
    const groupedNodes = groups.reduce((s, g) => s + (g.nodeCount ?? 0), 0);
    const ungrouped = Math.max(0, totalNodes - groupedNodes);

    container.innerHTML = `<div class="space-y-8">
      <!-- 页面标题 -->
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 class="text-3xl font-extrabold tracking-tight font-headline mb-2">节点分组</h1>
          <p class="text-text-muted max-w-lg leading-relaxed">按地域、职能或业务线组织你的节点，实现精细化管理。</p>
        </div>
        <button class="px-5 py-2.5 signature-gradient text-white rounded-lg font-bold text-sm shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all flex items-center gap-2 cursor-pointer" onclick="Groups.showCreateModal()">
          ${L('plus')}<span>创建分组</span>
        </button>
      </div>

      <!-- 8:4 网格布局 -->
      <div class="grid grid-cols-12 gap-8 items-start">
        <!-- 左侧: 分组卡片列表 -->
        <div class="col-span-12 lg:col-span-8 space-y-4" id="groups-list-wrap">
          ${groups.length > 0 ? groups.map(g => {
            const nodeCount = g.nodeCount ?? 0;
            const created = g.createdAt ? new Date(g.createdAt).toLocaleDateString() : '—';
            return `<div class="bg-surface rounded-xl shadow-ambient border border-border-default p-6 hover:shadow-md transition-all group">
              <div class="flex items-center justify-between">
                <div class="flex items-center gap-4">
                  <div class="w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-lg font-headline shadow-sm" style="background:${escHtml(g.color)}">
                    ${escHtml(g.name.charAt(0).toUpperCase())}
                  </div>
                  <div>
                    <div class="font-bold font-headline text-lg">${escHtml(g.name)}</div>
                    <div class="text-xs text-text-muted">创建于 ${created}</div>
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <span class="px-3 py-1 bg-primary/10 text-primary rounded-full text-xs font-bold">${nodeCount} 节点</span>
                  <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button class="p-2 rounded-lg text-text-muted hover:text-primary hover:bg-primary/10 transition cursor-pointer [&_svg]:w-4 [&_svg]:h-4" onclick="Groups.showEditModal('${safeAttr(g.id)}')" title="编辑">${L('pencil')}</button>
                    <button class="p-2 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 transition cursor-pointer [&_svg]:w-4 [&_svg]:h-4" onclick="Groups.deleteGroup('${safeAttr(g.id)}')" title="删除">${L('trash-2')}</button>
                  </div>
                </div>
              </div>
            </div>`;
          }).join('') : `<div class="bg-surface rounded-xl shadow-ambient border border-border-default p-12 text-center">
            <div class="[&_svg]:w-10 [&_svg]:h-10 text-text-muted mb-3 flex justify-center">${L('layers')}</div>
            <p class="text-text-muted text-sm">暂无分组，点击「创建分组」开始</p>
          </div>`}
        </div>

        <!-- 右侧: 统计 + 分布 -->
        <div class="col-span-12 lg:col-span-4 space-y-6">
          <!-- 统计卡片 -->
          <div class="grid grid-cols-2 gap-4">
            <div class="signature-gradient p-5 rounded-xl text-white flex flex-col justify-between h-32 shadow-lg shadow-primary/20">
              <span class="[&_svg]:w-5 [&_svg]:h-5 opacity-60">${L('layers')}</span>
              <div>
                <div class="text-3xl font-extrabold font-headline">${groups.length}</div>
                <div class="text-xs font-bold opacity-70 uppercase tracking-widest">分组</div>
              </div>
            </div>
            <div class="bg-surface p-5 rounded-xl border border-border-default flex flex-col justify-between h-32">
              <span class="[&_svg]:w-5 [&_svg]:h-5 text-text-muted">${L('inbox')}</span>
              <div>
                <div class="text-3xl font-extrabold font-headline">${ungrouped}</div>
                <div class="text-xs font-bold text-text-muted uppercase tracking-widest">未分组</div>
              </div>
            </div>
          </div>

          <!-- 节点分布列表 -->
          <div class="bg-surface p-6 rounded-xl shadow-ambient border border-border-default">
            <h3 class="font-headline font-extrabold tracking-tight mb-4">节点分布</h3>
            <div class="space-y-3">
              ${groups.map(g => {
                const pct = totalNodes > 0 ? Math.round((g.nodeCount ?? 0) / totalNodes * 100) : 0;
                return `<div>
                  <div class="flex items-center justify-between mb-1.5">
                    <div class="flex items-center gap-2">
                      <div class="w-2.5 h-2.5 rounded-full" style="background:${escHtml(g.color)}"></div>
                      <span class="text-xs font-medium">${escHtml(g.name)}</span>
                    </div>
                    <span class="text-xs font-bold">${pct}%</span>
                  </div>
                  <div class="h-1.5 w-full bg-elevated rounded-full overflow-hidden">
                    <div class="h-full rounded-full transition-all" style="width:${pct}%;background:${escHtml(g.color)}"></div>
                  </div>
                </div>`;
              }).join('')}
              ${ungrouped > 0 ? `<div>
                <div class="flex items-center justify-between mb-1.5">
                  <div class="flex items-center gap-2">
                    <div class="w-2.5 h-2.5 rounded-full bg-text-muted"></div>
                    <span class="text-xs font-medium">未分组</span>
                  </div>
                  <span class="text-xs font-bold">${totalNodes > 0 ? Math.round(ungrouped / totalNodes * 100) : 0}%</span>
                </div>
                <div class="h-1.5 w-full bg-elevated rounded-full overflow-hidden">
                  <div class="h-full rounded-full bg-text-muted transition-all" style="width:${totalNodes > 0 ? Math.round(ungrouped / totalNodes * 100) : 0}%"></div>
                </div>
              </div>` : ''}
            </div>
          </div>
        </div>
      </div>
    </div>`;
    refreshIcons();
  },

  showCreateModal() {
    Modal.show(`
      <h3 class="text-lg font-bold font-headline mb-6">新建分组</h3>
      <div class="space-y-4">
        <div class="space-y-2">
          <label class="block text-sm font-medium">分组名称</label>
          <input type="text" id="group-name-input" placeholder="例如：雅加达" autofocus class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all">
        </div>
        <div class="space-y-2">
          <label class="block text-sm font-medium">颜色</label>
          ${Modal.renderColorPicker()}
        </div>
      </div>
      <div class="flex justify-end gap-3 mt-6">
        <button class="px-5 py-2.5 text-sm font-semibold text-text-muted hover:bg-elevated rounded-lg transition cursor-pointer" onclick="App.closeModal()">取消</button>
        <button class="px-6 py-2.5 text-sm font-bold signature-gradient text-white rounded-lg shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all cursor-pointer" onclick="Groups.createGroup()">创建</button>
      </div>
    `);
  },

  async createGroup() {
    const name = ($('#group-name-input') as HTMLInputElement)?.value?.trim();
    if (!name) { alert('名称不能为空'); return; }
    try {
      const res = await App.authFetch('/api/nodes/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color: Modal.pickedColor }) });
      if (res.status === 409) { alert('同名分组已存在'); return; }
      if (!res.ok) { alert('创建失败'); return; }
      App.closeModal();
      // @alpha: 刷新分组数据后重新渲染节点页侧边栏
      const gRes = await App.authFetch('/api/nodes/groups').catch(() => null);
      if (gRes) { const d = await gRes.json(); App.nodeGroups = d.groups || []; }
      if (App.currentPage === 'nodes') Nodes.renderSidebar();
    } catch (e) { alert(`创建失败: ${e.message}`); }
  },

  showEditModal(groupId) {
    const group = App.nodeGroups.find(g => g.id === groupId);
    if (!group) return;
    Modal.show(`
      <h3 class="text-lg font-bold font-headline mb-6">编辑分组</h3>
      <div class="space-y-4">
        <div class="space-y-2">
          <label class="block text-sm font-medium">分组名称</label>
          <input type="text" id="edit-group-name" value="${escHtml(group.name)}" autofocus class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all">
        </div>
        <div class="space-y-2">
          <label class="block text-sm font-medium">颜色</label>
          ${Modal.renderColorPicker(group.color)}
        </div>
      </div>
      <div class="flex justify-end gap-3 mt-6">
        <button class="px-5 py-2.5 text-sm font-semibold text-text-muted hover:bg-elevated rounded-lg transition cursor-pointer" onclick="App.closeModal()">取消</button>
        <button class="px-6 py-2.5 text-sm font-bold signature-gradient text-white rounded-lg shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all cursor-pointer" onclick="Groups.updateGroup('${safeAttr(groupId)}')">保存</button>
      </div>
    `);
  },

  async updateGroup(groupId) {
    const name = ($('#edit-group-name') as HTMLInputElement)?.value?.trim();
    if (!name) { alert('名称不能为空'); return; }
    try {
      const res = await App.authFetch(`/api/nodes/groups/${encodeURIComponent(groupId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color: Modal.pickedColor }) });
      if (!res.ok) { const d = await res.json(); alert(d.message || d.error || '更新失败'); return; }
      App.closeModal();
      const gRes = await App.authFetch('/api/nodes/groups').catch(() => null);
      if (gRes) { const d = await gRes.json(); App.nodeGroups = d.groups || []; }
      if (App.currentPage === 'nodes') { Nodes.renderSidebar(); Nodes.renderTable(); }
    } catch (e) { alert(`更新失败: ${e.message}`); }
  },

  async deleteGroup(groupId) {
    if (!confirm('确认删除此分组？节点将回归未分组')) return;
    try {
      await App.authFetch(`/api/nodes/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
      if (App.nodeFilter?.groupId === groupId) App.nodeFilter.groupId = null;
      const gRes = await App.authFetch('/api/nodes/groups').catch(() => null);
      if (gRes) { const d = await gRes.json(); App.nodeGroups = d.groups || []; }
      if (App.currentPage === 'nodes') { Nodes.renderSidebar(); Nodes.renderTable(); }
    } catch (e) { alert(`删除失败: ${e.message}`); }
  },
};
