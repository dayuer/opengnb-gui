// @alpha: nodes 页面模块 (TS 迁移 — Alpha pass)
// V3: 详情面板逻辑已提取到 node-detail-panel.ts
import { $, $$, L, refreshIcons, escHtml, showToast, formatBytes, formatUptime, pctColor, pctBg, safeAttr, cidrMatch, isValidCidr } from '../utils';
import { Modal } from '../modal';
import { App } from '../core';
import { NodeDetailPanel } from '../components/node-detail-panel';


// @alpha: 节点管理 — Stitch "Cluster Management" 风格

let nodeTabStates: Record<string, any> = {};

export const Nodes = {
  render(container: any) {
    const allNodes = App.allNodesRaw || [];
    const monData = App.nodesData || [];
    const online = monData.filter((n: any) => n.online).length;
    const offline = allNodes.filter((n: any) => n.status === 'approved').length - online;
    const pending = allNodes.filter((n: any) => n.status === 'pending').length;

    container.innerHTML = `<div class="space-y-8">
      <!-- 页面标题 -->
      <div class="flex items-end justify-between">
        <div>
          <h1 class="text-3xl font-extrabold tracking-tight font-headline mb-2">节点管理</h1>
          <p class="text-text-muted max-w-xl leading-relaxed">监控和管理全球节点集群，查看实时遥测数据。</p>
        </div>
      </div>

      <!-- 3列汇总卡片 -->
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div class="bg-surface p-6 rounded-xl shadow-ambient border border-border-default relative overflow-hidden group">
          <div class="relative z-10">
            <p class="text-xs font-bold text-text-muted uppercase tracking-widest mb-4">节点总数</p>
            <div class="flex items-baseline gap-3">
              <span id="summary-total" class="text-4xl font-extrabold font-headline">${allNodes.length}</span>
              <span id="summary-pending">${pending > 0 ? `<span class="text-warning text-sm font-bold flex items-center gap-1">${L('clock')} ${pending} 待审批</span>` : `<span class="text-success text-sm font-bold flex items-center gap-1">${L('check-circle')} 全部已审批</span>`}</span>
            </div>
          </div>
          <div class="absolute -right-4 -bottom-4 opacity-[0.04] group-hover:opacity-[0.08] transition-opacity [&_svg]:w-24 [&_svg]:h-24">${L('server')}</div>
        </div>
        <div class="bg-surface p-6 rounded-xl shadow-ambient border border-border-default relative overflow-hidden group">
          <div class="relative z-10">
            <p class="text-xs font-bold text-text-muted uppercase tracking-widest mb-4">在线率</p>
            <div class="flex items-baseline gap-3">
              <span id="summary-online-pct" class="text-4xl font-extrabold font-headline">${allNodes.length > 0 ? Math.round(online / Math.max(1, allNodes.filter((n: any) => n.status === 'approved').length) * 100) : 0}%</span>
              <span id="summary-online-count" class="text-text-muted text-sm">${online} 在线</span>
            </div>
          </div>
          <div class="absolute -right-4 -bottom-4 opacity-[0.04] group-hover:opacity-[0.08] transition-opacity [&_svg]:w-24 [&_svg]:h-24">${L('activity')}</div>
        </div>
        <div class="bg-surface p-6 rounded-xl shadow-ambient border border-border-default relative overflow-hidden group">
          <div class="relative z-10">
            <p class="text-xs font-bold text-text-muted uppercase tracking-widest mb-4">全局健康</p>
            <div class="flex items-center gap-3">
              <div class="flex -space-x-2">
                ${online > 0 ? `<div class="w-3 h-3 rounded-full bg-secondary-container ring-4 ring-surface"></div>` : ''}
                ${offline > 0 ? `<div class="w-3 h-3 rounded-full bg-danger/40 ring-4 ring-surface"></div>` : ''}
              </div>
              <span id="summary-health-label" class="text-lg font-bold">${offline === 0 && pending === 0 ? '全部健康' : '需关注'}</span>
            </div>
            <p id="summary-health-detail" class="text-xs text-text-muted mt-4">${online} 健康 / ${offline} 离线 / ${pending} 待审批</p>
          </div>
          <div class="absolute -right-4 -bottom-4 opacity-[0.04] group-hover:opacity-[0.08] transition-opacity [&_svg]:w-24 [&_svg]:h-24">${L('shield')}</div>
        </div>
      </div>

      <!-- 主内容: 侧边栏 + 节点列表 -->
      <div class="flex gap-6">
        <div id="group-sidebar" class="w-52 shrink-0 hidden md:block"></div>
        <div class="flex-1 min-w-0 space-y-4">
          <div id="nodes-toolbar"></div>
          <div id="batch-toolbar" class="hidden"></div>
          <div id="nodes-table-wrap"></div>
          <div id="nodes-pagination"></div>
        </div>
      </div>
    </div>`;
    refreshIcons();
    this.renderSidebar();
    this.renderToolbar();
    this.renderTable();
    this.renderPagination();
  },

  renderSidebar() {
    const sb = $('#group-sidebar');
    if (!sb) return;
    const ungrouped = App.allNodesRaw.filter((n: any) => !n.groupId).length;
    const totalNodes = App.allNodesRaw.length;
    const f = App.nodeFilter;
    let html = `<div class="bg-surface rounded-xl shadow-ambient border border-border-default p-4 space-y-1 sticky top-20">
      <div class="text-xs font-bold text-text-muted uppercase tracking-widest mb-3 px-2">分组筛选</div>
      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${!f.groupId ? 'bg-primary/10 text-primary font-bold' : 'text-text-secondary hover:bg-elevated'}" onclick="Nodes.filterByGroup(null)">
        <span class="[&_svg]:w-4 [&_svg]:h-4">${L('layers')}</span> <span>全部节点</span> <span class="ml-auto text-xs font-bold">${totalNodes}</span>
      </button>`;
    for (const g of App.nodeGroups) {
      const count = App.allNodesRaw.filter((n: any) => n.groupId === g.id).length;
      html += `<button type="button" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors group/g relative ${f.groupId === g.id ? 'bg-primary/10 text-primary font-bold' : 'text-text-secondary hover:bg-elevated'}" onclick="Nodes.filterByGroup('${safeAttr(g.id)}')">
        <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${escHtml(g.color)}"></span>
        <span class="truncate flex-1 text-left">${escHtml(g.name)}</span>
        <span class="text-xs font-bold shrink-0">${count}</span>
        <span class="hidden group-hover/g:flex items-center gap-0.5 absolute right-2 bg-elevated rounded-md shadow-sm" onclick="event.stopPropagation()">
          <button class="p-1 rounded text-text-muted hover:text-primary hover:bg-primary/10 transition-colors cursor-pointer [&_svg]:w-3 [&_svg]:h-3" onclick="Groups.showEditModal('${safeAttr(g.id)}')" title="编辑">${L('pencil')}</button>
          <button class="p-1 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition-colors cursor-pointer [&_svg]:w-3 [&_svg]:h-3" onclick="Groups.deleteGroup('${safeAttr(g.id)}')" title="删除">${L('trash-2')}</button>
        </span>
      </button>`;
    }
    html += `<button type="button" class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition-colors ${f.groupId === '__none' ? 'bg-primary/10 text-primary font-bold' : 'text-text-secondary hover:bg-elevated'}" onclick="Nodes.filterByGroup('__none')">
      <span class="[&_svg]:w-4 [&_svg]:h-4">${L('circle-off')}</span> <span>未分组</span> <span class="ml-auto text-xs font-bold">${ungrouped}</span>
    </button>`;
    html += `<div class="border-t border-border-subtle mt-3 pt-3">
      <button class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-text-muted hover:text-primary hover:bg-primary/10 transition cursor-pointer [&_svg]:w-3.5 [&_svg]:h-3.5" onclick="Groups.showCreateModal()">${L('plus')} 新建分组</button>
    </div>`;

    // 节点分布
    if (App.nodeGroups.length > 0) {
      html += `<div class="border-t border-border-subtle mt-3 pt-3">
        <div class="text-xs font-bold text-text-muted uppercase tracking-widest mb-2 px-2">节点分布</div>
        <div class="space-y-2 px-1">`;
      for (const g of App.nodeGroups) {
        const count = App.allNodesRaw.filter((n: any) => n.groupId === g.id).length;
        const pct = totalNodes > 0 ? Math.round(count / totalNodes * 100) : 0;
        html += `<div>
          <div class="flex items-center justify-between mb-1">
            <span class="text-[10px] text-text-muted truncate">${escHtml(g.name)}</span>
            <span class="text-[10px] font-bold">${pct}%</span>
          </div>
          <div class="h-1 w-full bg-elevated rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-[width]" style="width:${pct}%;background:${escHtml(g.color)}"></div>
          </div>
        </div>`;
      }
      if (ungrouped > 0) {
        const pct = totalNodes > 0 ? Math.round(ungrouped / totalNodes * 100) : 0;
        html += `<div>
          <div class="flex items-center justify-between mb-1">
            <span class="text-[10px] text-text-muted">未分组</span>
            <span class="text-[10px] font-bold">${pct}%</span>
          </div>
          <div class="h-1 w-full bg-elevated rounded-full overflow-hidden">
            <div class="h-full rounded-full bg-text-muted transition-[width]" style="width:${pct}%"></div>
          </div>
        </div>`;
      }
      html += `</div></div>`;
    }

    html += `</div>`;
    sb.innerHTML = html;
    refreshIcons();
  },

  renderToolbar() {
    const tb = $('#nodes-toolbar');
    if (!tb) return;
    tb.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-4 bg-surface p-4 rounded-xl shadow-ambient border border-border-default">
      <div class="flex items-center gap-2 bg-elevated px-4 py-2 rounded-lg w-full md:w-80">
        <span class="[&_svg]:w-4 [&_svg]:h-4 text-text-muted">${L('search')}</span>
        <input type="text" placeholder="搜索节点名称/IP…" class="bg-transparent border-none text-sm w-full outline-none placeholder:text-text-muted" value="${escHtml(App.nodeFilter.keyword)}" oninput="Nodes.onSearch(this.value)">
      </div>
      <div class="flex items-center gap-2 overflow-x-auto pb-1 md:pb-0">
        <span class="text-xs font-bold text-text-muted uppercase tracking-widest mr-2">状态:</span>
        ${(['', 'online', 'offline', 'pending'] as const).map(val => {
          const labels: Record<string, string> = { '': '全部', online: '在线', offline: '离线', pending: '待审批' };
          return `<button class="px-3 py-1 ${App.nodeFilter.status === val ? 'bg-primary/15 text-primary' : 'text-text-muted hover:bg-elevated'} rounded-full text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer" onclick="Nodes.onStatusFilter('${val}')">${labels[val]}</button>`;
        }).join('')}
      </div>
      <span id="filtered-count" class="text-xs text-text-muted"></span>
    </div>`;
    refreshIcons();
  },

  getFilteredList() {
    let list = [...App.allNodesRaw];
    const f = App.nodeFilter;
    if (f.groupId === '__none') list = list.filter((n: any) => !n.groupId);
    else if (f.groupId) list = list.filter((n: any) => n.groupId === f.groupId);
    if (f.keyword) {
      const kw = f.keyword.toLowerCase();
      list = list.filter((n: any) => (n.name||'').toLowerCase().includes(kw) || (n.tunAddr||'').includes(kw) || (n.id||'').toLowerCase().includes(kw));
    }
    if (f.status === 'online') list = list.filter((n: any) => n.status === 'approved' && App.nodesData.find((m: any) => m.id === n.id)?.online);
    else if (f.status === 'offline') list = list.filter((n: any) => n.status === 'approved' && !App.nodesData.find((m: any) => m.id === n.id)?.online);
    else if (f.status) list = list.filter((n: any) => n.status === f.status);
    if (f.subnet && isValidCidr(f.subnet)) list = list.filter((n: any) => n.tunAddr && cidrMatch(n.tunAddr, f.subnet));
    return list;
  },

  renderTable() {
    const wrap = $('#nodes-table-wrap');
    if (!wrap) return;
    const all = this.getFilteredList();
    const { page, pageSize } = App.nodePagination;
    const total = all.length;
    const start = (page - 1) * pageSize;
    const pageNodes = all.slice(start, start + pageSize);

    const fc = $('#filtered-count');
    if (fc) fc.textContent = total < App.allNodesRaw.length ? `${total}/${App.allNodesRaw.length} 条` : `${total} 条`;

    let html = `<div class="space-y-3">`;

    for (const node of pageNodes) {
      const checked = App.selectedIds.has(node.id) ? 'checked' : '';
      const monitorNode = App.nodesData.find((n: any) => n.id === node.id);
      const isOnline = monitorNode?.online;
      const isPending = node.status === 'pending';
      const isRejected = node.status === 'rejected';
      const isExpanded = App.selectedNodeId === node.id;
      const group = App.nodeGroups.find((g: any) => g.id === node.groupId);
      const si = monitorNode?.sysInfo || {};
      const cpuPct = si.cpuUsage ?? 0;
      const memPct = si.memTotalMB > 0 ? Math.round(si.memUsedMB / si.memTotalMB * 100) : 0;
      const isCritical = isRejected || (!isOnline && !isPending);

      // 状态徽章
      let statusBadge;
      if (isPending) statusBadge = `<span class="bg-warning/20 text-warning text-xs font-bold px-2.5 py-0.5 rounded-full uppercase tracking-tight">待审批</span>`;
      else if (isRejected) statusBadge = `<span class="bg-danger/20 text-danger text-xs font-bold px-2.5 py-0.5 rounded-full uppercase tracking-tight">已拒绝</span>`;
      else if (isOnline) statusBadge = `<span class="bg-secondary-container text-success text-xs font-bold px-2.5 py-0.5 rounded-full uppercase tracking-tight flex items-center gap-1"><span class="w-1.5 h-1.5 rounded-full bg-success"></span>在线</span>`;
      else statusBadge = `<span class="bg-danger/20 text-danger text-xs font-bold px-2.5 py-0.5 rounded-full uppercase tracking-tight">离线</span>`;

      // 操作按钮
      let actions = '';
      if (isPending) {
        actions = `<button class="p-2 rounded-lg hover:bg-success/10 text-success transition cursor-pointer [&_svg]:w-4 [&_svg]:h-4" onclick="event.stopPropagation();Nodes.approve('${safeAttr(node.id)}')" title="审批">${L('check')}</button>
          <button class="p-2 rounded-lg hover:bg-danger/10 text-danger transition cursor-pointer [&_svg]:w-4 [&_svg]:h-4" onclick="event.stopPropagation();Nodes.reject('${safeAttr(node.id)}')" title="拒绝">${L('x')}</button>`;
      } else {
        actions = `<button class="p-2 rounded-lg hover:bg-elevated text-text-muted hover:text-primary transition cursor-pointer [&_svg]:w-4 [&_svg]:h-4" onclick="event.stopPropagation();Nodes.showEditModal('${safeAttr(node.id)}')" title="编辑">${L('pencil')}</button>
          <button class="p-2 rounded-lg hover:bg-elevated text-text-muted hover:text-primary transition cursor-pointer [&_svg]:w-4 [&_svg]:h-4" onclick="event.stopPropagation();Nodes.showMoveModal('${safeAttr(node.id)}')" title="移动">${L('folder-input')}</button>`;
      }

      html += `<div class="bg-surface rounded-xl p-5 shadow-ambient border border-border-default hover:bg-elevated/40 transition-colors cursor-pointer group ${isCritical && !isPending ? 'border-l-4 border-l-danger/30' : ''} ${isExpanded ? 'ring-2 ring-primary/20' : ''}" data-node-id="${safeAttr(node.id)}" onclick="Nodes.expandRow('${safeAttr(node.id)}')">
        <div class="flex flex-wrap items-center gap-6">
          <!-- 选择 + 节点信息 -->
          <div class="flex items-center gap-4 w-56">
            <div class="flex items-center gap-3" onclick="event.stopPropagation()">
              <input type="checkbox" class="accent-primary cursor-pointer" ${checked} onchange="Nodes.toggleSelect('${safeAttr(node.id)}',this.checked)">
            </div>
            <div class="w-12 h-12 rounded-xl ${isPending ? 'bg-warning/10 text-warning' : isCritical ? 'bg-danger/10 text-danger' : 'bg-primary/10 text-primary'} flex items-center justify-center group-hover:${isPending ? 'bg-warning' : isCritical ? 'bg-danger' : 'bg-primary'} group-hover:text-white transition-colors [&_svg]:w-6 [&_svg]:h-6">
              ${L(isPending ? 'clock' : isCritical ? 'alert-triangle' : 'server')}
            </div>
            <div>
              <h3 class="font-bold font-headline text-sm">${escHtml(node.name || node.id)}</h3>
              <div class="flex items-center gap-2 mt-1">
                ${statusBadge}
                ${group ? `<span class="text-xs text-text-muted flex items-center gap-1"><span class="w-2 h-2 rounded-full" style="background:${escHtml(group.color)}"></span>${escHtml(group.name)}</span>` : ''}
              </div>
            </div>
          </div>

          <!-- 指标 -->
          <div class="flex-1 grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <p class="text-xs font-bold text-text-muted uppercase tracking-widest mb-1.5">TUN 地址</p>
              <span class="text-sm font-bold font-mono">${escHtml(node.tunAddr || '—')}</span>
            </div>
            ${isOnline ? `<div class="col-span-1 md:col-span-2 space-y-2">
              <div>
                <div class="flex justify-between text-xs font-bold text-text-muted uppercase tracking-widest mb-1">
                  <span>CPU</span><span data-cpu-pct>${cpuPct}%</span>
                </div>
                <div class="h-1.5 w-full bg-elevated rounded-full overflow-hidden">
                  <div data-cpu-bar class="h-full rounded-full transition-all ${cpuPct > 80 ? 'bg-warning' : 'bg-primary'}" style="width:${Math.min(cpuPct, 100)}%"></div>
                </div>
              </div>
              <div>
                <div class="flex justify-between text-xs font-bold text-text-muted uppercase tracking-widest mb-1">
                  <span>内存</span><span data-mem-pct>${memPct}%</span>
                </div>
                <div class="h-1.5 w-full bg-elevated rounded-full overflow-hidden">
                  <div data-mem-bar class="h-full rounded-full transition-all ${memPct > 80 ? 'bg-warning' : 'bg-primary'}" style="width:${Math.min(memPct, 100)}%"></div>
                </div>
              </div>
            </div>
            <div class="text-right">
              <p class="text-xs font-bold text-text-muted uppercase tracking-widest mb-1.5">延迟</p>
              <span data-latency class="text-sm font-bold ${(monitorNode?.sshLatencyMs || 0) > 500 ? 'text-danger' : ''}">${monitorNode?.sshLatencyMs || 0}ms</span>
            </div>` : `<div class="col-span-1 md:col-span-2 opacity-30 space-y-2">
              <div>
                <div class="flex justify-between text-xs font-bold text-text-muted uppercase tracking-widest mb-1"><span>CPU</span><span>--</span></div>
                <div class="h-1.5 w-full bg-elevated rounded-full overflow-hidden"></div>
              </div>
              <div>
                <div class="flex justify-between text-xs font-bold text-text-muted uppercase tracking-widest mb-1"><span>内存</span><span>--</span></div>
                <div class="h-1.5 w-full bg-elevated rounded-full overflow-hidden"></div>
              </div>
            </div>
            <div class="text-right">
              <p class="text-xs font-bold text-text-muted uppercase tracking-widest mb-1.5">运行</p>
              <span class="text-sm font-bold text-text-muted">${escHtml(si.uptime || '—')}</span>
            </div>`}
          </div>

          <!-- 操作按钮 -->
          <div class="flex items-center gap-1 pl-4 border-l border-border-subtle" onclick="event.stopPropagation()">
            ${actions}
          </div>
        </div>
        ${isExpanded ? `<div class="inline-panel mt-4 pt-4 border-t border-border-subtle" onclick="event.stopPropagation()"></div>` : ''}
      </div>`;
    }

    if (pageNodes.length === 0) {
      html += `<div class="bg-surface rounded-xl shadow-ambient border border-border-default p-12 text-center text-text-muted text-sm">无匹配数据</div>`;
    }

    html += `</div>`;

    // 保存已展开面板的 DOM，避免 innerHTML 销毁终端日志等有状态内容
    let savedPanel: any = null;
    if (App.selectedNodeId) {
      const existingPanel = wrap.querySelector('.inline-panel');
      if (existingPanel && existingPanel.children.length > 0) {
        savedPanel = existingPanel;
        existingPanel.remove();
      }
    }

    wrap.innerHTML = html;
    refreshIcons();
    this.updateBatchToolbar();

    // 渲染展开面板（委托 NodeDetailPanel）
    if (App.selectedNodeId) {
      const panel = wrap.querySelector('.inline-panel');
      if (panel) {
        if (savedPanel) {
          panel.replaceWith(savedPanel);
          const ts = this._getTabState(App.selectedNodeId);
          if (ts.tab === 'overview') {
            const monitorNode = App.nodesData.find((n: any) => n.id === App.selectedNodeId);
            if (monitorNode) {
              const contentEl = savedPanel.querySelector(`#inline-tab-content-${App.selectedNodeId}`);
              if (contentEl) { contentEl.innerHTML = NodeDetailPanel.renderOverview(monitorNode); refreshIcons(); }
            }
          }
        } else {
          const monitorNode = App.nodesData.find((n: any) => n.id === App.selectedNodeId);
          if (monitorNode) NodeDetailPanel.renderInlineDetail(panel, monitorNode, this._getTabState(App.selectedNodeId));
          else panel.innerHTML = `<div class="text-sm text-text-muted flex items-center gap-2">${L('zap')} 无监控数据</div>`;
          refreshIcons();
        }
      }
    }
  },

  /** 增量更新 — 只 patch 动态数值，不重建 DOM */
  updateMetrics() {
    const allNodes = App.allNodesRaw || [];
    const monData = App.nodesData || [];
    const online = monData.filter((n: any) => n.online).length;
    const approved = allNodes.filter((n: any) => n.status === 'approved').length;
    const offline = approved - online;
    const pending = allNodes.filter((n: any) => n.status === 'pending').length;

    // --- 顶部汇总卡片 ---
    const elTotal = $('#summary-total');
    if (elTotal) elTotal.textContent = String(allNodes.length);
    const elPending = $('#summary-pending');
    if (elPending) elPending.innerHTML = pending > 0
      ? `<span class="text-warning text-sm font-bold flex items-center gap-1">${L('clock')} ${pending} 待审批</span>`
      : `<span class="text-success text-sm font-bold flex items-center gap-1">${L('check-circle')} 全部已审批</span>`;
    const elOnlinePct = $('#summary-online-pct');
    if (elOnlinePct) elOnlinePct.textContent = `${approved > 0 ? Math.round(online / approved * 100) : 0}%`;
    const elOnlineCount = $('#summary-online-count');
    if (elOnlineCount) elOnlineCount.textContent = `${online} 在线`;
    const elHealthLabel = $('#summary-health-label');
    if (elHealthLabel) elHealthLabel.textContent = offline === 0 && pending === 0 ? '全部健康' : '需关注';
    const elHealthDetail = $('#summary-health-detail');
    if (elHealthDetail) elHealthDetail.textContent = `${online} 健康 / ${offline} 离线 / ${pending} 待审批`;
    if (elPending) refreshIcons();

    // --- 节点卡片内联指标 ---
    const wrap = $('#nodes-table-wrap');
    if (!wrap) return;
    for (const card of wrap.querySelectorAll('[data-node-id]')) {
      const nid = (card as HTMLElement).dataset.nodeId;
      const mon = monData.find((n: any) => n.id === nid);
      if (!mon) continue;
      const si = mon.sysInfo || {};
      const cpu = si.cpuUsage ?? 0;
      const mem = si.memTotalMB > 0 ? Math.round(si.memUsedMB / si.memTotalMB * 100) : 0;
      const lat = mon.sshLatencyMs || 0;

      const cpuEl = card.querySelector('[data-cpu-pct]');
      if (cpuEl) cpuEl.textContent = `${cpu}%`;
      const cpuBar = card.querySelector('[data-cpu-bar]');
      if (cpuBar) {
        (cpuBar as HTMLElement).style.width = `${Math.min(cpu, 100)}%`;
        cpuBar.className = `h-full rounded-full transition-all ${cpu > 80 ? 'bg-warning' : 'bg-primary'}`;
      }
      const memEl = card.querySelector('[data-mem-pct]');
      if (memEl) memEl.textContent = `${mem}%`;
      const memBar = card.querySelector('[data-mem-bar]');
      if (memBar) {
        (memBar as HTMLElement).style.width = `${Math.min(mem, 100)}%`;
        memBar.className = `h-full rounded-full transition-all ${mem > 80 ? 'bg-warning' : 'bg-primary'}`;
      }
      const latEl = card.querySelector('[data-latency]');
      if (latEl) {
        latEl.textContent = `${lat}ms`;
        latEl.className = `text-sm font-bold ${lat > 500 ? 'text-danger' : ''}`;
      }
    }

    // --- 概览 Tab 实时更新（如果展开中）---
    if (App.selectedNodeId) {
      const ts = this._getTabState(App.selectedNodeId);
      if (ts.tab === 'overview') {
        const mon = monData.find((n: any) => n.id === App.selectedNodeId);
        if (mon) {
          const contentEl = wrap.querySelector(`#inline-tab-content-${App.selectedNodeId}`);
          if (contentEl) { contentEl.innerHTML = NodeDetailPanel.renderOverview(mon); refreshIcons(); }
        }
      }
    }
  },

  // --- 交互（委托 NodeDetailPanel） ---
  _getTabState(nodeId: any) {
    if (!nodeTabStates[nodeId]) nodeTabStates[nodeId] = { tab: 'overview', clawSubTab: 'status' };
    return nodeTabStates[nodeId];
  },

  switchTab(nodeId: any, tab: any) {
    this._getTabState(nodeId).tab = tab;
    const monitorNode = App.nodesData.find((n: any) => n.id === nodeId);
    const panel = document.querySelector('.inline-panel');
    if (panel && monitorNode) NodeDetailPanel.renderInlineDetail(panel, monitorNode, this._getTabState(nodeId));
  },

  switchClawSubTab(nodeId: any, subTab: any) {
    this._getTabState(nodeId).clawSubTab = subTab;
    NodeDetailPanel.loadClawTab(nodeId, subTab);
  },

  // 委托 AI Chat / Terminal 到 NodeDetailPanel
  sendChat(nodeId: any) { NodeDetailPanel.sendChat(nodeId); },
  quickCmd(nodeId: any, prompt: any) { NodeDetailPanel.quickCmd(nodeId, prompt); },
  toggleTerminalSize(nodeId: any) { NodeDetailPanel.toggleTerminalSize(nodeId); },
  uninstallSkill(nodeId: any, skillId: any) { NodeDetailPanel.uninstallSkill(nodeId, skillId); },

  filterByGroup(gid: any) { App.nodeFilter.groupId = gid; App.nodePagination.page = 1; App.selectedIds.clear(); this.renderSidebar(); this.renderTable(); this.renderPagination(); },
  onSearch(v: any) { App.nodeFilter.keyword = v; App.nodePagination.page = 1; this.renderTable(); this.renderPagination(); },
  onStatusFilter(v: any) { App.nodeFilter.status = v; App.nodePagination.page = 1; this.renderToolbar(); this.renderTable(); this.renderPagination(); },
  expandRow(id: any) {
    const prev = App.selectedNodeId;
    App.selectedNodeId = prev === id ? null : id;
    if (prev && prev !== id) NodeDetailPanel.destroyChat(prev);
    if (prev === id) NodeDetailPanel.destroyChat(id);
    this.renderTable();
  },

  goPage(p: any) { App.nodePagination.page = p; App.selectedIds.clear(); this.renderTable(); this.renderPagination(); },
  toggleSelectAll(checked: any) {
    const all = this.getFilteredList();
    const { page, pageSize } = App.nodePagination;
    const pageNodes = all.slice((page-1)*pageSize, (page-1)*pageSize+pageSize);
    for (const n of pageNodes) { if (checked) App.selectedIds.add(n.id); else App.selectedIds.delete(n.id); }
    this.renderTable();
  },
  toggleSelect(id: any, checked: any) { if (checked) App.selectedIds.add(id); else App.selectedIds.delete(id); this.updateBatchToolbar(); },

  updateBatchToolbar() {
    const bar = $('#batch-toolbar');
    if (!bar) return;
    if (App.selectedIds.size === 0) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    bar.innerHTML = `<div class="flex items-center gap-2 bg-surface rounded-xl shadow-ambient border border-border-default p-3">
      <span class="text-xs text-text-secondary font-bold">已选 ${App.selectedIds.size} 个</span>
      <button class="px-3 py-1 text-xs rounded-lg bg-success/15 text-success hover:bg-success/25 transition cursor-pointer font-semibold" onclick="Nodes.batchAction('approve')">${L('check')} 审批</button>
      <button class="px-3 py-1 text-xs rounded-lg bg-danger/15 text-danger hover:bg-danger/25 transition cursor-pointer font-semibold" onclick="Nodes.batchAction('reject')">${L('x')} 拒绝</button>
      <button class="px-3 py-1 text-xs rounded-lg bg-danger/15 text-danger hover:bg-danger/25 transition cursor-pointer font-semibold" onclick="Nodes.batchAction('remove')">${L('trash-2')} 删除</button>
      <button class="px-3 py-1 text-xs rounded-lg bg-elevated text-text-secondary hover:bg-border-default transition cursor-pointer" onclick="App.selectedIds.clear();Nodes.renderTable()">取消</button>
    </div>`;
    refreshIcons();
  },

  renderPagination() {
    const pg = $('#nodes-pagination');
    if (!pg) return;
    const all = this.getFilteredList();
    const total = all.length;
    const { page, pageSize } = App.nodePagination;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (totalPages <= 1) { pg.innerHTML = ''; return; }
    let html = `<div class="flex items-center justify-between mt-6 border-t border-border-subtle pt-6">
      <p class="text-xs text-text-muted font-medium">第 ${page}/${totalPages} 页 · 共 ${total} 条</p>
      <div class="flex gap-2">`;
    html += `<button class="w-10 h-10 flex items-center justify-center rounded-lg border border-border-default text-text-muted hover:bg-elevated transition cursor-pointer disabled:opacity-30 [&_svg]:w-4 [&_svg]:h-4" ${page <= 1 ? 'disabled' : ''} onclick="Nodes.goPage(${page-1})">${L('chevron-left')}</button>`;
    for (let p = Math.max(1, page-3); p <= Math.min(totalPages, page+3); p++) {
      html += `<button class="w-10 h-10 flex items-center justify-center rounded-lg transition cursor-pointer text-sm font-bold ${p === page ? 'signature-gradient text-white shadow-md' : 'text-text-muted hover:bg-elevated'}" onclick="Nodes.goPage(${p})">${p}</button>`;
    }
    html += `<button class="w-10 h-10 flex items-center justify-center rounded-lg border border-border-default text-text-muted hover:bg-elevated transition cursor-pointer disabled:opacity-30 [&_svg]:w-4 [&_svg]:h-4" ${page >= totalPages ? 'disabled' : ''} onclick="Nodes.goPage(${page+1})">${L('chevron-right')}</button>`;
    html += `</div></div>`;
    pg.innerHTML = html;
    refreshIcons();
  },

  // --- API 操作 ---
  async approve(id: any) {
    (event?.target as HTMLElement)?.closest('button')?.setAttribute('disabled', '');
    try {
      const res = await App.authFetch(`/api/enroll/${encodeURIComponent(id)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (data.success) {
        const node = App.allNodesRaw.find((n: any) => n.id === id);
        if (node) { node.status = 'approved'; node.tunAddr = data.tunAddr || node.tunAddr; }
        App.pendingNodes = App.pendingNodes.filter((n: any) => n.id !== id);
        this.render($('#main-content'));
        showToast(`✅ 节点 ${id} 已审批通过`);
      } else showToast(`❌ 审批失败: ${data.message || '未知错误'}`, 'error');
    } catch (e: any) { showToast(`❌ 审批失败: ${e.message}`, 'error'); }
  },

  async reject(id: any) {
    (event?.target as HTMLElement)?.closest('button')?.setAttribute('disabled', '');
    try {
      const res = await App.authFetch(`/api/enroll/${encodeURIComponent(id)}/reject`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        App.allNodesRaw = App.allNodesRaw.filter((n: any) => n.id !== id);
        App.pendingNodes = App.pendingNodes.filter((n: any) => n.id !== id);
        this.render($('#main-content'));
        showToast(`节点 ${id} 已拒绝并删除`);
      } else showToast(`❌ 拒绝失败: ${data.message}`, 'error');
    } catch (e: any) { showToast(`❌ 拒绝失败: ${e.message}`, 'error'); }
  },

  async batchAction(action: any) {
    const ids = [...App.selectedIds];
    const labels: Record<string, string> = { approve: '审批', reject: '拒绝', remove: '删除' };
    if (!confirm(`确认${labels[action]} ${ids.length} 个节点？`)) return;
    try {
      const res = await App.authFetch('/api/enroll/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ids }) });
      const data = await res.json();
      const succeeded = new Set(data.succeeded || []);
      if (action === 'remove') {
        App.allNodesRaw = App.allNodesRaw.filter((n: any) => !succeeded.has(n.id));
        App.pendingNodes = App.pendingNodes.filter((n: any) => !succeeded.has(n.id));
      } else {
        App.allNodesRaw.forEach((n: any) => { if (succeeded.has(n.id)) n.status = action === 'approve' ? 'approved' : 'rejected'; });
      }
      App.selectedIds.clear();
      this.render($('#main-content'));
      showToast(`${labels[action]}完成: ${data.succeeded?.length||0} 成功, ${data.failed?.length||0} 失败`);
    } catch (e: any) { showToast(`操作失败: ${e.message}`, 'error'); }
  },

  async provision(id: any) { /* placeholder */ },

  showEditModal(id: any) {
    const node = App.allNodesRaw.find((n: any) => n.id === id);
    if (!node) return;
    Modal.show(`
      <h3 class="text-lg font-bold font-headline mb-6">编辑节点</h3>
      <form id="edit-node-form" onsubmit="Nodes.saveEdit(event,'${safeAttr(id)}')">
        <div class="space-y-4">
          <div class="space-y-2">
            <label class="block text-sm font-medium">名称</label>
            <input class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary transition-[box-shadow,border-color]" name="name" value="${escHtml(node.name||'')}" required maxlength="64">
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-medium">TUN 地址</label>
            <input class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary transition-[box-shadow,border-color] font-mono" name="tunAddr" value="${escHtml(node.tunAddr||'')}" required>
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-medium">SSH 端口</label>
            <input class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary transition-[box-shadow,border-color]" name="sshPort" type="number" value="${node.sshPort||22}" min="1" max="65535" required>
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-medium">SSH 用户名</label>
            <input class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:border-primary transition-[box-shadow,border-color]" name="sshUser" value="${escHtml(node.sshUser||'synon')}" required>
          </div>
          <div id="edit-node-error" class="hidden text-danger text-xs"></div>
        </div>
        <div class="flex justify-end gap-3 mt-6">
          <button type="button" class="px-5 py-2.5 text-sm font-semibold text-text-muted hover:bg-elevated rounded-lg transition cursor-pointer" onclick="App.closeModal()">取消</button>
          <button type="submit" id="edit-node-save-btn" class="px-6 py-2.5 text-sm font-bold signature-gradient text-white rounded-lg shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all cursor-pointer">保存</button>
        </div>
      </form>
    `);
  },

  async saveEdit(e: any, id: any) {
    e.preventDefault();
    const form = $('#edit-node-form');
    if (!(form as HTMLFormElement).checkValidity()) { (form as HTMLFormElement).reportValidity(); return; }
    const btn = $('#edit-node-save-btn');
    (btn as HTMLButtonElement).disabled = true; (btn as HTMLButtonElement).textContent = '保存中…';
    const errEl = $('#edit-node-error');
    errEl.classList.add('hidden');
    const f = form as any;
    const body = { name: f.name.value.trim(), tunAddr: f.tunAddr.value.trim(), sshPort: parseInt(f.sshPort.value,10), sshUser: f.sshUser.value.trim() };
    try {
      const res = await fetch(`/api/nodes/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + App.getToken() }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.hint || data.error || '保存失败'; errEl.classList.remove('hidden'); (btn as HTMLButtonElement).disabled = false; (btn as HTMLButtonElement).textContent = '保存'; return; }
      const node = App.allNodesRaw.find((n: any) => n.id === id);
      if (node) Object.assign(node, body);
      App.closeModal();
      this.renderTable(); this.renderPagination();
    } catch (err: any) { errEl.textContent = '网络错误: ' + err.message; errEl.classList.remove('hidden'); (btn as HTMLButtonElement).disabled = false; (btn as HTMLButtonElement).textContent = '保存'; }
  },

  showMoveModal(id: any) {
    let html = `<h3 class="text-lg font-bold font-headline mb-6">移动到分组</h3>
      <div class="space-y-1 mb-4">
        <div class="px-4 py-3 rounded-lg text-sm cursor-pointer hover:bg-elevated transition text-text-secondary" onclick="Nodes.moveTo('${safeAttr(id)}',null)">取消分组</div>
        ${App.nodeGroups.map((g: any) => `<div class="px-4 py-3 rounded-lg text-sm cursor-pointer hover:bg-elevated transition text-text-secondary flex items-center gap-2" onclick="Nodes.moveTo('${safeAttr(id)}','${safeAttr(g.id)}')">
          <span class="w-2.5 h-2.5 rounded-full" style="background:${escHtml(g.color)}"></span>${escHtml(g.name)}</div>`).join('')}
      </div>
      <div class="flex justify-end"><button class="px-5 py-2.5 text-sm font-semibold text-text-muted hover:bg-elevated rounded-lg transition cursor-pointer" onclick="App.closeModal()">取消</button></div>`;
    Modal.show(html);
  },

  async moveTo(id: any, gid: any) {
    try { await App.authFetch(`/api/enroll/${encodeURIComponent(id)}/group`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: gid }) }); App.closeModal(); } catch (e: any) { showToast(`移动失败: ${e.message}`, 'error'); }
  },
};
