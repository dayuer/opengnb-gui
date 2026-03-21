'use strict';
// @alpha: 节点管理 — Stitch "Cluster Management" 风格

let nodeTabStates = {};
let _chatSessions = {}; // @alpha: nodeId → { ws, messages }

const Nodes = {
  render(container) {
    const allNodes = App.allNodesRaw || [];
    const monData = App.nodesData || [];
    const online = monData.filter(n => n.online).length;
    const offline = allNodes.filter(n => n.status === 'approved').length - online;
    const pending = allNodes.filter(n => n.status === 'pending').length;

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
              <span id="summary-online-pct" class="text-4xl font-extrabold font-headline">${allNodes.length > 0 ? Math.round(online / Math.max(1, allNodes.filter(n => n.status === 'approved').length) * 100) : 0}%</span>
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
    const ungrouped = App.allNodesRaw.filter(n => !n.groupId).length;
    const totalNodes = App.allNodesRaw.length;
    const f = App.nodeFilter;
    let html = `<div class="bg-surface rounded-xl shadow-ambient border border-border-default p-4 space-y-1 sticky top-20">
      <div class="text-xs font-bold text-text-muted uppercase tracking-widest mb-3 px-2">分组筛选</div>
      <div class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition ${!f.groupId ? 'bg-primary/10 text-primary font-bold' : 'text-text-secondary hover:bg-elevated'}" onclick="Nodes.filterByGroup(null)">
        <span class="[&_svg]:w-4 [&_svg]:h-4">${L('layers')}</span> <span>全部节点</span> <span class="ml-auto text-xs font-bold">${totalNodes}</span>
      </div>`;
    for (const g of App.nodeGroups) {
      const count = App.allNodesRaw.filter(n => n.groupId === g.id).length;
      html += `<div class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition group/g ${f.groupId === g.id ? 'bg-primary/10 text-primary font-bold' : 'text-text-secondary hover:bg-elevated'}" onclick="Nodes.filterByGroup('${safeAttr(g.id)}')">
        <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${escHtml(g.color)}"></span>
        <span class="truncate flex-1">${escHtml(g.name)}</span>
        <span class="text-xs font-bold">${count}</span>
        <span class="hidden group-hover/g:flex items-center gap-0.5 ml-1" onclick="event.stopPropagation()">
          <button class="p-1 rounded text-text-muted hover:text-primary hover:bg-primary/10 transition cursor-pointer [&_svg]:w-3 [&_svg]:h-3" onclick="Groups.showEditModal('${safeAttr(g.id)}')" title="编辑">${L('pencil')}</button>
          <button class="p-1 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition cursor-pointer [&_svg]:w-3 [&_svg]:h-3" onclick="Groups.deleteGroup('${safeAttr(g.id)}')" title="删除">${L('trash-2')}</button>
        </span>
      </div>`;
    }
    html += `<div class="flex items-center gap-2 px-3 py-2 rounded-lg text-sm cursor-pointer transition ${f.groupId === '__none' ? 'bg-primary/10 text-primary font-bold' : 'text-text-secondary hover:bg-elevated'}" onclick="Nodes.filterByGroup('__none')">
      <span class="[&_svg]:w-4 [&_svg]:h-4">${L('circle-off')}</span> <span>未分组</span> <span class="ml-auto text-xs font-bold">${ungrouped}</span>
    </div>`;
    html += `<div class="border-t border-border-subtle mt-3 pt-3">
      <button class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-text-muted hover:text-primary hover:bg-primary/10 transition cursor-pointer [&_svg]:w-3.5 [&_svg]:h-3.5" onclick="Groups.showCreateModal()">${L('plus')} 新建分组</button>
    </div>`;

    // 节点分布
    if (App.nodeGroups.length > 0) {
      html += `<div class="border-t border-border-subtle mt-3 pt-3">
        <div class="text-xs font-bold text-text-muted uppercase tracking-widest mb-2 px-2">节点分布</div>
        <div class="space-y-2 px-1">`;
      for (const g of App.nodeGroups) {
        const count = App.allNodesRaw.filter(n => n.groupId === g.id).length;
        const pct = totalNodes > 0 ? Math.round(count / totalNodes * 100) : 0;
        html += `<div>
          <div class="flex items-center justify-between mb-1">
            <span class="text-[10px] text-text-muted truncate">${escHtml(g.name)}</span>
            <span class="text-[10px] font-bold">${pct}%</span>
          </div>
          <div class="h-1 w-full bg-elevated rounded-full overflow-hidden">
            <div class="h-full rounded-full transition-all" style="width:${pct}%;background:${escHtml(g.color)}"></div>
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
            <div class="h-full rounded-full bg-text-muted transition-all" style="width:${pct}%"></div>
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
        <input type="text" placeholder="搜索节点名称/IP..." class="bg-transparent border-none text-sm w-full outline-none placeholder:text-text-muted" value="${escHtml(App.nodeFilter.keyword)}" oninput="Nodes.onSearch(this.value)">
      </div>
      <div class="flex items-center gap-2 overflow-x-auto pb-1 md:pb-0">
        <span class="text-xs font-bold text-text-muted uppercase tracking-widest mr-2">状态:</span>
        ${['', 'online', 'offline', 'pending'].map(val => {
          const labels = { '': '全部', online: '在线', offline: '离线', pending: '待审批' };
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
    if (f.groupId === '__none') list = list.filter(n => !n.groupId);
    else if (f.groupId) list = list.filter(n => n.groupId === f.groupId);
    if (f.keyword) {
      const kw = f.keyword.toLowerCase();
      list = list.filter(n => (n.name||'').toLowerCase().includes(kw) || (n.tunAddr||'').includes(kw) || (n.id||'').toLowerCase().includes(kw));
    }
    if (f.status === 'online') list = list.filter(n => n.status === 'approved' && App.nodesData.find(m => m.id === n.id)?.online);
    else if (f.status === 'offline') list = list.filter(n => n.status === 'approved' && !App.nodesData.find(m => m.id === n.id)?.online);
    else if (f.status) list = list.filter(n => n.status === f.status);
    if (f.subnet && isValidCidr(f.subnet)) list = list.filter(n => n.tunAddr && cidrMatch(n.tunAddr, f.subnet));
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
      const monitorNode = App.nodesData.find(n => n.id === node.id);
      const isOnline = monitorNode?.online;
      const isPending = node.status === 'pending';
      const isRejected = node.status === 'rejected';
      const isExpanded = App.selectedNodeId === node.id;
      const group = App.nodeGroups.find(g => g.id === node.groupId);
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
    let savedPanel = null;
    if (App.selectedNodeId) {
      const existingPanel = wrap.querySelector('.inline-panel');
      if (existingPanel && existingPanel.children.length > 0) {
        savedPanel = existingPanel;
        existingPanel.remove(); // 从 DOM 分离但保留引用
      }
    }

    wrap.innerHTML = html;
    refreshIcons();
    this.updateBatchToolbar();

    // 渲染展开面板
    if (App.selectedNodeId) {
      const panel = wrap.querySelector('.inline-panel');
      if (panel) {
        if (savedPanel) {
          // 复用已有面板 — 保留终端日志、OpenClaw 状态等
          panel.replaceWith(savedPanel);
          // 概览 Tab 需要实时更新 CPU/内存数据
          const ts = this._getTabState(App.selectedNodeId);
          if (ts.tab === 'overview') {
            const monitorNode = App.nodesData.find(n => n.id === App.selectedNodeId);
            if (monitorNode) {
              const contentEl = savedPanel.querySelector(`#inline-tab-content-${App.selectedNodeId}`);
              if (contentEl) { contentEl.innerHTML = this._renderOverview(monitorNode); refreshIcons(); }
            }
          }
        } else {
          // 首次展开 — 完整渲染
          const monitorNode = App.nodesData.find(n => n.id === App.selectedNodeId);
          if (monitorNode) this.renderInlineDetail(panel, monitorNode);
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
    const online = monData.filter(n => n.online).length;
    const approved = allNodes.filter(n => n.status === 'approved').length;
    const offline = approved - online;
    const pending = allNodes.filter(n => n.status === 'pending').length;

    // --- 顶部汇总卡片 ---
    const elTotal = $('#summary-total');
    if (elTotal) elTotal.textContent = allNodes.length;
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
      const nid = card.dataset.nodeId;
      const mon = monData.find(n => n.id === nid);
      if (!mon) continue;
      const si = mon.sysInfo || {};
      const cpu = si.cpuUsage ?? 0;
      const mem = si.memTotalMB > 0 ? Math.round(si.memUsedMB / si.memTotalMB * 100) : 0;
      const lat = mon.sshLatencyMs || 0;

      const cpuEl = card.querySelector('[data-cpu-pct]');
      if (cpuEl) cpuEl.textContent = `${cpu}%`;
      const cpuBar = card.querySelector('[data-cpu-bar]');
      if (cpuBar) {
        cpuBar.style.width = `${Math.min(cpu, 100)}%`;
        cpuBar.className = `h-full rounded-full transition-all ${cpu > 80 ? 'bg-warning' : 'bg-primary'}`;
      }
      const memEl = card.querySelector('[data-mem-pct]');
      if (memEl) memEl.textContent = `${mem}%`;
      const memBar = card.querySelector('[data-mem-bar]');
      if (memBar) {
        memBar.style.width = `${Math.min(mem, 100)}%`;
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
        const mon = monData.find(n => n.id === App.selectedNodeId);
        if (mon) {
          const contentEl = wrap.querySelector(`#inline-tab-content-${App.selectedNodeId}`);
          if (contentEl) { contentEl.innerHTML = this._renderOverview(mon); refreshIcons(); }
        }
      }
    }
  },

  renderInlineDetail(panel, node) {
    if (!node.online) {
      panel.innerHTML = `<div class="flex items-center gap-2 text-sm text-danger">${L('zap')} 节点不可达 — ${escHtml(node.error || '无上报数据')}
        <button class="ml-3 px-3 py-1 text-xs rounded-lg bg-primary hover:bg-primary-light text-white transition cursor-pointer" onclick="Nodes.provision('${safeAttr(node.id)}')">重新配置</button>
      </div>`;
      refreshIcons();
      return;
    }

    const ts = this._getTabState(node.id);
    const tabs = [
      { key: 'overview', icon: 'bar-chart-3', label: '概览' },
      { key: 'claw', icon: 'bot', label: 'OpenClaw' },
      { key: 'terminal', icon: 'terminal', label: '终端' },
    ];

    let html = `<div>
      <div class="flex gap-1 mb-4 border-b border-border-subtle pb-2">
        ${tabs.map(t => `<button class="px-3 py-1.5 text-xs rounded-md transition cursor-pointer flex items-center gap-1.5 [&_svg]:w-3.5 [&_svg]:h-3.5 ${ts.tab === t.key ? 'bg-primary/10 text-primary font-medium' : 'text-text-secondary hover:text-text-primary hover:bg-elevated'}" onclick="Nodes.switchTab('${safeAttr(node.id)}','${t.key}')">${L(t.icon)} ${t.label}</button>`).join('')}
      </div>
      <div id="inline-tab-content-${safeAttr(node.id)}">`;

    if (ts.tab === 'overview') html += this._renderOverview(node);
    else if (ts.tab === 'terminal') html += this._renderTerminal(node);
    else html += `<div class="text-text-muted text-sm">${L('loader')} 加载中...</div>`;

    html += `</div></div>`;
    panel.innerHTML = html;
    refreshIcons();

    if (ts.tab === 'claw') this._loadClawTab(node.id, ts.clawSubTab);
    if (ts.tab === 'terminal') this._initChat(node.id);
  },

  _renderOverview(node) {
    const si = node.sysInfo || {};
    const memPct = si.memTotalMB > 0 ? Math.round(si.memUsedMB / si.memTotalMB * 100) : 0;
    const diskPct = si.diskUsePct ? parseInt(si.diskUsePct) : 0;
    const cpuPct = si.cpuUsage ?? 0;
    const peers = node.nodes || [];
    const directP = peers.filter(p => p.status === 'Direct').length;
    const totalIn = peers.reduce((s, n) => s + (n.inBytes || 0), 0);
    const totalOut = peers.reduce((s, n) => s + (n.outBytes || 0), 0);
    const oc = node.openclaw || {};
    const clawRunning = oc.running === true;

    let html = `<div class="space-y-4">`;
    html += `<div><div class="text-xs font-bold text-primary uppercase tracking-widest mb-2">运行状态</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${this._statCard(L('activity'), '采集延迟', `${node.sshLatencyMs||0}ms`, node.sshLatencyMs > 500 ? 'text-danger' : 'text-success')}
        ${this._statCard(L('clock'), '运行时长', escHtml(si.uptime || '—'), '')}
        ${this._statCard(L('bot'), 'OpenClaw', clawRunning ? '运行中' : '未运行', clawRunning ? 'text-success' : 'text-warning')}
        ${this._statCard(L('monitor'), '系统', escHtml(si.hostname || '—'), 'text-primary', escHtml(si.os || '—'))}
      </div></div>`;

    html += `<div><div class="text-xs font-bold text-success uppercase tracking-widest mb-2">资源使用</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${this._gaugeCard(L('cpu'), 'CPU', `${cpuPct}%`, cpuPct, si.cpuCores ? `${si.cpuCores} 核` : '')}
        ${this._gaugeCard(L('memory-stick'), '内存', `${memPct}%`, memPct, si.memTotalMB > 0 ? `${si.memUsedMB}/${si.memTotalMB} MB` : '')}
        ${this._gaugeCard(L('hard-drive'), '磁盘', `${diskPct}%`, diskPct, si.diskTotal ? `${escHtml(si.diskUsed)}/${escHtml(si.diskTotal)}` : '')}
        ${this._statCard(L('wrench'), '内核', escHtml(si.kernel || '—'), '', escHtml(si.arch || '—'))}
      </div></div>`;

    html += `<div><div class="text-xs font-bold text-info uppercase tracking-widest mb-2">P2P 网络</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${this._statCard(L('link'), '节点数', `${peers.length}`, 'text-primary', `直连 ${directP}`)}
        ${this._statCard(L('zap'), '直连率', peers.length > 0 ? `${Math.round(directP/peers.length*100)}%` : '—', directP >= peers.length * 0.8 ? 'text-success' : 'text-warning')}
        ${this._statCard(L('download'), '总流入', formatBytes(totalIn), 'text-primary')}
        ${this._statCard(L('upload'), '总流出', formatBytes(totalOut), 'text-warning')}
      </div></div>`;

    if (peers.length) {
      html += `<div><div class="text-xs font-bold text-text-secondary uppercase tracking-widest mb-2">GNB 节点 (${peers.length})</div>
        <div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr class="text-text-muted border-b border-border-subtle">
          <th class="text-left py-1.5 px-2">UUID</th><th class="text-left py-1.5 px-2">TUN</th><th class="text-left py-1.5 px-2">状态</th><th class="text-left py-1.5 px-2">延迟</th><th class="text-left py-1.5 px-2">流入</th><th class="text-left py-1.5 px-2">流出</th>
        </tr></thead><tbody>`;
      for (const sn of peers) {
        const sc = sn.status === 'Direct' ? 'text-success' : sn.status === 'Detecting' ? 'text-warning' : 'text-danger';
        html += `<tr class="border-b border-border-subtle/50"><td class="py-1.5 px-2 font-mono">${escHtml(sn.uuid64||'—')}</td><td class="py-1.5 px-2">${escHtml(sn.tunAddr4||'—')}</td><td class="py-1.5 px-2 ${sc}">${escHtml(sn.status||'—')}</td><td class="py-1.5 px-2">${sn.latency4Usec ? `${(sn.latency4Usec/1000).toFixed(1)}ms` : '—'}</td><td class="py-1.5 px-2">${formatBytes(sn.inBytes||0)}</td><td class="py-1.5 px-2">${formatBytes(sn.outBytes||0)}</td></tr>`;
      }
      html += `</tbody></table></div></div>`;
    }

    html += `</div>`;
    return html;
  },

  _statCard(icon, label, value, color, sub) {
    return `<div class="bg-elevated rounded-lg border border-border-subtle p-3">
      <div class="flex items-center gap-1.5 mb-1"><span class="[&_svg]:w-3.5 [&_svg]:h-3.5 text-text-muted">${icon}</span><span class="text-xs text-text-muted">${label}</span></div>
      <div class="text-sm font-semibold ${color}">${value}</div>
      ${sub ? `<div class="text-xs text-text-muted mt-0.5">${sub}</div>` : ''}
    </div>`;
  },

  _gaugeCard(icon, label, value, pct, sub) {
    const c = pctBg(pct);
    return `<div class="bg-elevated rounded-lg border border-border-subtle p-3">
      <div class="flex items-center gap-1.5 mb-1"><span class="[&_svg]:w-3.5 [&_svg]:h-3.5 text-text-muted">${icon}</span><span class="text-xs text-text-muted">${label}</span></div>
      <div class="text-sm font-semibold ${pctColor(pct)}">${value}</div>
      ${pct > 0 ? `<div class="gauge-bar mt-1.5"><div class="gauge-fill ${c}" style="width:${Math.min(pct,100)}%"></div></div>` : ''}
      ${sub ? `<div class="text-xs text-text-muted mt-0.5">${sub}</div>` : ''}
    </div>`;
  },

  // @alpha: AI Ops Terminal — Stitch 设计对齐
  _renderTerminal(node) {
    const shortcuts = [
      { prompt: '请检查 GNB 和 OpenClaw 服务状态', icon: 'activity', label: '状态检查' },
      { prompt: '请重启 GNB 服务', icon: 'refresh-cw', label: '重启 GNB' },
      { prompt: '请查看 GNB 和 OpenClaw 最近 30 条日志', icon: 'file-text', label: '查看日志' },
      { prompt: '请检查磁盘空间使用情况', icon: 'hard-drive', label: '磁盘用量' },
      { prompt: '请查看系统性能概况（CPU/负载/进程）', icon: 'gauge', label: '性能' },
      { prompt: '请查看内存使用情况', icon: 'memory-stick', label: '内存' },
    ];
    const maximized = this._termMaximized;
    const hClass = maximized ? 'h-[calc(100vh-280px)]' : 'h-80';
    const nid = safeAttr(node.id);
    return `<div class="rounded-xl border border-border-default overflow-hidden flex flex-col bg-surface shadow-md" id="terminal-wrap-${nid}">
      <!-- 深色头部栏 -->
      <div class="flex items-center gap-3 px-4 py-2.5 bg-[#1a1b2e]">
        <span class="text-white text-xs font-bold tracking-tight flex items-center gap-1.5 [&_svg]:w-3.5 [&_svg]:h-3.5">${L('terminal')} AI Ops Terminal</span>
        <span id="term-status-${nid}" class="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400 uppercase tracking-widest"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>连接中</span>
        <span class="px-2 py-0.5 rounded-md bg-white/10 text-white/80 text-[10px] font-mono">${escHtml(node.name || node.id)}</span>
        <div class="ml-auto flex items-center gap-1">
          <button class="p-1 rounded text-white/50 hover:text-white hover:bg-white/10 transition cursor-pointer [&_svg]:w-3.5 [&_svg]:h-3.5" onclick="Nodes.toggleTerminalSize('${nid}')" title="${maximized ? '还原' : '最大化'}">${L(maximized ? 'minimize-2' : 'maximize-2')}</button>
        </div>
      </div>
      <!-- 快捷按钮栏 -->
      <div class="flex items-center gap-1.5 px-4 py-2 border-b border-border-subtle bg-base overflow-x-auto">
        ${shortcuts.map(s => `<button class="px-2.5 py-1 text-xs rounded-full border border-border-default hover:border-primary/40 hover:bg-primary/8 text-text-secondary hover:text-primary transition cursor-pointer flex items-center gap-1 whitespace-nowrap [&_svg]:w-3 [&_svg]:h-3" onclick="Nodes.quickCmd('${nid}','${safeAttr(s.prompt)}')">${L(s.icon)} ${s.label}</button>`).join('')}
      </div>
      <!-- 消息区域 -->
      <div id="chat-messages-${nid}" class="overflow-y-auto px-4 py-4 space-y-4 scroll-smooth bg-surface ${hClass}">
        <div class="flex gap-2.5 items-start"><div class="w-7 h-7 rounded-full signature-gradient flex items-center justify-center text-xs text-white flex-shrink-0 shadow-sm">AI</div><div class="bg-base border border-border-subtle rounded-xl rounded-tl-sm px-3.5 py-2.5 text-sm text-text-secondary leading-relaxed max-w-[85%]">你好！我是节点 <strong class="text-text-primary">${escHtml(node.name || node.id)}</strong> 的 AI 运维助手。用自然语言告诉我你需要做什么。</div></div>
      </div>
      <!-- 输入区域 -->
      <div class="px-4 py-3 border-t border-border-default bg-base flex gap-2.5 items-center">
        <input id="chat-input-${nid}" type="text" placeholder="用自然语言描述运维任务..." class="flex-1 px-4 py-2 text-sm rounded-xl bg-surface border border-border-default focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all placeholder:text-text-muted" onkeydown="if(event.key==='Enter'){Nodes.sendChat('${nid}');event.preventDefault()}" />
        <span class="hidden sm:flex items-center gap-1 px-2 py-1 rounded-md bg-elevated text-[10px] text-text-muted font-medium [&_svg]:w-3 [&_svg]:h-3">${L('bot')} Claude Code</span>
        <button onclick="Nodes.sendChat('${nid}')" class="px-4 py-2 text-xs font-semibold rounded-xl signature-gradient text-white cursor-pointer flex items-center gap-1.5 [&_svg]:w-3.5 [&_svg]:h-3.5 hover:scale-[1.02] active:scale-95 transition-all shadow-sm shadow-primary/20">${L('send')} 发送</button>
      </div>
      <!-- 页脚 -->
      <div class="px-4 py-1.5 text-center border-t border-border-subtle bg-base"><span class="text-[10px] text-text-muted font-medium">Powered by Claude Code · 命令通过 SSH 执行</span></div>
    </div>`;
  },

  _termMaximized: false,

  toggleTerminalSize(nodeId) {
    this._termMaximized = !this._termMaximized;
    const msgEl = document.getElementById(`chat-messages-${nodeId}`);
    if (msgEl) {
      msgEl.classList.toggle('h-80', !this._termMaximized);
      msgEl.classList.toggle('h-[calc(100vh-280px)]', this._termMaximized);
    }
    const wrap = document.getElementById(`terminal-wrap-${nodeId}`);
    if (wrap) {
      const btn = wrap.querySelector('[title="最大化"], [title="还原"]');
      if (btn) {
        btn.title = this._termMaximized ? '还原' : '最大化';
        btn.innerHTML = L(this._termMaximized ? 'minimize-2' : 'maximize-2');
        refreshIcons();
      }
    }
  },

  // @alpha: 发送聊天消息
  sendChat(nodeId) {
    const input = document.getElementById(`chat-input-${nodeId}`);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const s = _chatSessions[nodeId];
    if (!s || !s.ws || s.ws.readyState !== 1) {
      this._appendMsg(nodeId, 'system', '⚠️ 未连接，请稍候重试');
      return;
    }
    this._appendMsg(nodeId, 'user', text);
    s.ws.send(JSON.stringify({ type: 'chat', text }));
  },

  // @alpha: 追加消息到聊天区域 — 三种角色样式
  _appendMsg(nodeId, role, content) {
    const box = document.getElementById(`chat-messages-${nodeId}`);
    if (!box) return;
    const div = document.createElement('div');
    if (role === 'user') {
      div.className = 'flex justify-end';
      div.innerHTML = `<div class="px-3.5 py-2 rounded-xl rounded-tr-sm text-sm text-white max-w-[80%] signature-gradient shadow-sm">${this._escHtml(content)}</div>`;
    } else if (role === 'ai') {
      div.className = 'flex gap-2.5 items-start ai-msg';
      div.innerHTML = `<div class="w-7 h-7 rounded-full signature-gradient flex items-center justify-center text-xs text-white flex-shrink-0 shadow-sm">AI</div><div class="bg-base border border-border-subtle rounded-xl rounded-tl-sm px-3.5 py-2.5 text-sm text-text-secondary leading-relaxed max-w-[85%] ai-text"></div>`;
    } else {
      div.className = 'flex justify-center';
      div.innerHTML = `<span class="text-[10px] px-3 py-1 rounded-full bg-elevated text-text-muted font-medium">${this._escHtml(content)}</span>`;
    }
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  },

  // @alpha: 获取或创建当前 AI 响应气泡
  _getOrCreateAiBubble(nodeId) {
    const box = document.getElementById(`chat-messages-${nodeId}`);
    if (!box) return null;
    const last = box.querySelector('.ai-msg:last-child');
    if (last) return last.querySelector('.ai-text');
    const div = this._appendMsg(nodeId, 'ai', '');
    return div?.querySelector('.ai-text') || null;
  },

  _escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  },

  // @alpha: 更新头部连接状态指示
  _updateTermStatus(nodeId, connected) {
    const el = document.getElementById(`term-status-${nodeId}`);
    if (!el) return;
    if (connected) {
      el.className = 'flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400 uppercase tracking-widest';
      el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>已连接';
    } else {
      el.className = 'flex items-center gap-1.5 text-[10px] font-semibold text-red-400 uppercase tracking-widest';
      el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>已断开';
    }
  },

  // @alpha: 初始化 AI Chat WebSocket
  _initChat(nodeId) {
    if (_chatSessions[nodeId]) return;
    const msgBox = document.getElementById(`chat-messages-${nodeId}`);
    if (!msgBox) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = App.getToken();
    // @security: 首条消息认证，不再通过 URL 传递 token（安全审计 H1 适配）
    const ws = new WebSocket(`${proto}://${location.host}/ws/ai`);

    let aiBuf = ''; // 累积当前 AI 响应文本

    ws.onopen = () => {
      // 发送认证消息
      ws.send(JSON.stringify({ type: 'auth', token, nodeId }));
      this._updateTermStatus(nodeId, true);
      this._appendMsg(nodeId, 'system', '✓ AI 助手已连接');
    };

    ws.onmessage = (e) => {
      let chunk;
      try { chunk = JSON.parse(e.data); } catch (_) { return; }

      // @alpha: stream-json 事件处理
      if (chunk.type === 'ack') {
        aiBuf = '';
        return;
      }
      if (chunk.type === 'busy') {
        this._appendMsg(nodeId, 'system', chunk.text);
        return;
      }
      if (chunk.type === 'error') {
        this._appendMsg(nodeId, 'system', `❌ ${chunk.text || '执行失败'}`);
        return;
      }
      if (chunk.type === 'done') {
        aiBuf = '';
        return;
      }

      // Claude stream-json 事件：assistant（文本）、tool_use（命令执行）、tool_result
      const bubble = this._getOrCreateAiBubble(nodeId);
      if (!bubble) return;

      if (chunk.type === 'assistant' && chunk.message?.content) {
        for (const block of chunk.message.content) {
          if (block.type === 'text') {
            aiBuf += block.text;
            bubble.innerHTML = this._renderMd(aiBuf);
          }
        }
      } else if (chunk.type === 'content_block_delta') {
        if (chunk.delta?.type === 'text_delta') {
          aiBuf += chunk.delta.text;
          bubble.innerHTML = this._renderMd(aiBuf);
        }
      } else if (chunk.type === 'result') {
        // 最终结果 — 完整替换
        const text = chunk.result || '';
        if (text) {
          aiBuf = text;
          bubble.innerHTML = this._renderMd(aiBuf);
        }
        aiBuf = '';
        // 后续新消息需要新气泡
      }

      msgBox.scrollTop = msgBox.scrollHeight;
    };

    ws.onerror = () => {
      this._updateTermStatus(nodeId, false);
      this._appendMsg(nodeId, 'system', '❌ 连接错误');
    };

    ws.onclose = (e) => {
      this._updateTermStatus(nodeId, false);
      this._appendMsg(nodeId, 'system', `连接已断开 (${e.code})`);
      delete _chatSessions[nodeId];
    };

    _chatSessions[nodeId] = { ws };
  },

  // @alpha: Markdown → HTML — 深色代码块 + Tailwind 类名
  _renderMd(text) {
    let html = this._escHtml(text);
    // 代码块 — 深色背景
    html = html.replace(/```([\s\S]*?)```/g, '<pre class="bg-[#1e1e2e] text-emerald-300 px-3.5 py-3 rounded-lg text-xs overflow-x-auto my-2 font-mono leading-relaxed">$1</pre>');
    // 行内代码
    html = html.replace(/`([^`]+)`/g, '<code class="bg-elevated text-primary px-1.5 py-0.5 rounded text-xs font-mono">$1</code>');
    // 加粗
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-text-primary font-semibold">$1</strong>');
    // 换行
    html = html.replace(/\n/g, '<br>');
    return html;
  },

  _destroyChat(nodeId) {
    const s = _chatSessions[nodeId];
    if (!s) return;
    if (s.ws && s.ws.readyState <= 1) s.ws.close();
    delete _chatSessions[nodeId];
  },

  async _loadClawTab(nodeId, subTab) {
    const container = document.getElementById(`inline-tab-content-${nodeId}`);
    if (!container) return;
    const subTabs = [
      { key: 'status', icon: 'activity', label: '状态' },
      { key: 'models', icon: 'cpu', label: '模型' },
      { key: 'config', icon: 'settings', label: '配置' },
      { key: 'sessions', icon: 'message-square', label: '会话' },
      { key: 'channels', icon: 'radio', label: '渠道' },
    ];
    let html = `<div class="flex gap-1 mb-3">${subTabs.map(st => `<button class="px-2.5 py-1 text-xs rounded transition cursor-pointer ${subTab === st.key ? 'bg-primary/10 text-primary' : 'text-text-muted hover:text-text-primary hover:bg-elevated'}" onclick="Nodes.switchClawSubTab('${safeAttr(nodeId)}','${st.key}')">${L(st.icon)} ${st.label}</button>`).join('')}</div>
    <div id="claw-content-${safeAttr(nodeId)}" class="text-sm text-text-muted">${L('loader')} 加载中...</div>`;
    container.innerHTML = html;
    refreshIcons();

    const nodeConfig = App.allNodesRaw.find(n => n.id === nodeId);
    const detail = document.getElementById(`claw-content-${nodeId}`);
    if (!nodeConfig?.clawToken) {
      const monNode = App.nodesData.find(n => n.id === nodeId);
      const oc = monNode?.openclaw;
      if (oc && oc.running && oc.config) {
        const gw = oc.config.gateway || {};
        const tokenPreview = gw.auth?.token ? gw.auth.token.substring(0, 12) + '...' : '无';
        detail.innerHTML = `
          <div class="space-y-3">
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
              ${this._statCard(L('activity'), '状态', oc.running ? '运行中' : '未运行', oc.running ? 'text-success' : 'text-warning')}
              ${this._statCard(L('hash'), 'PID', oc.pid || '-', '')}
              ${this._statCard(L('radio'), '端口', gw.port || '-', '')}
              ${this._statCard(L('key-round'), 'Token', tokenPreview, 'font-mono text-xs')}
              ${this._statCard(L('folder'), '配置路径', oc.configPath || '-', 'text-xs')}
              ${this._statCard(L('wifi'), 'RPC 健康', oc.rpcOk ? '正常' : '不可用', oc.rpcOk ? 'text-success' : 'text-warning')}
            </div>
            <details class="text-xs">
              <summary class="cursor-pointer text-text-muted hover:text-text-primary transition">查看完整配置 JSON</summary>
              <pre class="bg-base rounded-lg p-3 mt-2 overflow-x-auto">${escHtml(JSON.stringify(oc.config, null, 2))}</pre>
            </details>
            <div class="text-xs text-text-muted">${L('info')} Token 将在下次 Agent 上报时自动同步到配置表</div>
          </div>`;
      } else if (oc && !oc.running) {
        detail.innerHTML = `<div class="text-warning text-sm">${L('alert-triangle')} OpenClaw 未运行 (进程未检测到)</div>`;
      } else {
        detail.innerHTML = `<div class="text-text-muted text-sm">${L('info')} 未检测到 OpenClaw 信息，等待 Agent 上报...</div>`;
      }
      refreshIcons();
      return;
    }

    try {
      const res = await App.authFetch(`/api/claw/${encodeURIComponent(nodeId)}/${subTab}`);
      const data = await res.json();
      if (data.error) { detail.innerHTML = `<div class="text-danger text-sm">${escHtml(data.error)}</div>`; return; }
      detail.innerHTML = `<pre class="text-xs bg-base rounded-lg p-3 overflow-x-auto max-h-60">${escHtml(JSON.stringify(data, null, 2))}</pre>`;
    } catch (err) {
      detail.innerHTML = `<div class="text-danger text-sm">请求失败: ${escHtml(err.message)}</div>`;
    }
    refreshIcons();
  },

  // --- 交互 ---
  _getTabState(nodeId) {
    if (!nodeTabStates[nodeId]) nodeTabStates[nodeId] = { tab: 'overview', clawSubTab: 'status' };
    return nodeTabStates[nodeId];
  },

  switchTab(nodeId, tab) {
    this._getTabState(nodeId).tab = tab;
    const monitorNode = App.nodesData.find(n => n.id === nodeId);
    const panel = document.querySelector('.inline-panel');
    if (panel && monitorNode) this.renderInlineDetail(panel, monitorNode);
  },

  switchClawSubTab(nodeId, subTab) {
    this._getTabState(nodeId).clawSubTab = subTab;
    this._loadClawTab(nodeId, subTab);
  },

  filterByGroup(gid) { App.nodeFilter.groupId = gid; App.nodePagination.page = 1; App.selectedIds.clear(); this.renderSidebar(); this.renderTable(); this.renderPagination(); },
  onSearch(v) { App.nodeFilter.keyword = v; App.nodePagination.page = 1; this.renderTable(); this.renderPagination(); },
  onStatusFilter(v) { App.nodeFilter.status = v; App.nodePagination.page = 1; this.renderToolbar(); this.renderTable(); this.renderPagination(); },
  expandRow(id) {
    const prev = App.selectedNodeId;
    App.selectedNodeId = prev === id ? null : id;
    // 收起旧节点的 xterm 会话
    if (prev && prev !== id) this._destroyChat(prev);
    if (prev === id) this._destroyChat(id);
    this.renderTable();
  },

  goPage(p) { App.nodePagination.page = p; App.selectedIds.clear(); this.renderTable(); this.renderPagination(); },
  toggleSelectAll(checked) {
    const all = this.getFilteredList();
    const { page, pageSize } = App.nodePagination;
    const pageNodes = all.slice((page-1)*pageSize, (page-1)*pageSize+pageSize);
    for (const n of pageNodes) { if (checked) App.selectedIds.add(n.id); else App.selectedIds.delete(n.id); }
    this.renderTable();
  },
  toggleSelect(id, checked) { if (checked) App.selectedIds.add(id); else App.selectedIds.delete(id); this.updateBatchToolbar(); },

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
  async approve(id) {
    event?.target?.closest('button')?.setAttribute('disabled', '');
    try {
      const res = await App.authFetch(`/api/enroll/${encodeURIComponent(id)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (data.success) {
        const node = App.allNodesRaw.find(n => n.id === id);
        if (node) { node.status = 'approved'; node.tunAddr = data.tunAddr || node.tunAddr; }
        App.pendingNodes = App.pendingNodes.filter(n => n.id !== id);
        this.render($('#main-content'));
        showToast(`✅ 节点 ${id} 已审批通过`);
      } else showToast(`❌ 审批失败: ${data.message || '未知错误'}`, 'error');
    } catch (e) { showToast(`❌ 审批失败: ${e.message}`, 'error'); }
  },

  async reject(id) {
    event?.target?.closest('button')?.setAttribute('disabled', '');
    try {
      const res = await App.authFetch(`/api/enroll/${encodeURIComponent(id)}/reject`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        App.allNodesRaw = App.allNodesRaw.filter(n => n.id !== id);
        App.pendingNodes = App.pendingNodes.filter(n => n.id !== id);
        this.render($('#main-content'));
        showToast(`节点 ${id} 已拒绝并删除`);
      } else showToast(`❌ 拒绝失败: ${data.message}`, 'error');
    } catch (e) { showToast(`❌ 拒绝失败: ${e.message}`, 'error'); }
  },

  async batchAction(action) {
    const ids = [...App.selectedIds];
    const labels = { approve: '审批', reject: '拒绝', remove: '删除' };
    if (!confirm(`确认${labels[action]} ${ids.length} 个节点？`)) return;
    try {
      const res = await App.authFetch('/api/enroll/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ids }) });
      const data = await res.json();
      const succeeded = new Set(data.succeeded || []);
      if (action === 'remove') {
        App.allNodesRaw = App.allNodesRaw.filter(n => !succeeded.has(n.id));
        App.pendingNodes = App.pendingNodes.filter(n => !succeeded.has(n.id));
      } else {
        App.allNodesRaw.forEach(n => { if (succeeded.has(n.id)) n.status = action === 'approve' ? 'approved' : 'rejected'; });
      }
      App.selectedIds.clear();
      this.render($('#main-content'));
      showToast(`${labels[action]}完成: ${data.succeeded?.length||0} 成功, ${data.failed?.length||0} 失败`);
    } catch (e) { showToast(`操作失败: ${e.message}`, 'error'); }
  },

  async provision(id) { /* placeholder */ },

  showEditModal(id) {
    const node = App.allNodesRaw.find(n => n.id === id);
    if (!node) return;
    Modal.show(`
      <h3 class="text-lg font-bold font-headline mb-6">编辑节点</h3>
      <form id="edit-node-form" onsubmit="Nodes.saveEdit(event,'${safeAttr(id)}')">
        <div class="space-y-4">
          <div class="space-y-2">
            <label class="block text-sm font-medium">名称</label>
            <input class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" name="name" value="${escHtml(node.name||'')}" required maxlength="64">
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-medium">TUN 地址</label>
            <input class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all font-mono" name="tunAddr" value="${escHtml(node.tunAddr||'')}" required>
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-medium">SSH 端口</label>
            <input class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" name="sshPort" type="number" value="${node.sshPort||22}" min="1" max="65535" required>
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-medium">SSH 用户名</label>
            <input class="w-full bg-elevated border border-border-default rounded-lg px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" name="sshUser" value="${escHtml(node.sshUser||'synon')}" required>
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

  async saveEdit(e, id) {
    e.preventDefault();
    const form = $('#edit-node-form');
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const btn = $('#edit-node-save-btn');
    btn.disabled = true; btn.textContent = '保存中…';
    const errEl = $('#edit-node-error');
    errEl.classList.add('hidden');
    const body = { name: form.name.value.trim(), tunAddr: form.tunAddr.value.trim(), sshPort: parseInt(form.sshPort.value,10), sshUser: form.sshUser.value.trim() };
    try {
      const res = await fetch(`/api/nodes/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + App.getToken() }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) { errEl.textContent = data.hint || data.error || '保存失败'; errEl.classList.remove('hidden'); btn.disabled = false; btn.textContent = '保存'; return; }
      const node = App.allNodesRaw.find(n => n.id === id);
      if (node) Object.assign(node, body);
      App.closeModal();
      this.renderTable(); this.renderPagination();
    } catch (err) { errEl.textContent = '网络错误: ' + err.message; errEl.classList.remove('hidden'); btn.disabled = false; btn.textContent = '保存'; }
  },

  showMoveModal(id) {
    let html = `<h3 class="text-lg font-bold font-headline mb-6">移动到分组</h3>
      <div class="space-y-1 mb-4">
        <div class="px-4 py-3 rounded-lg text-sm cursor-pointer hover:bg-elevated transition text-text-secondary" onclick="Nodes.moveTo('${safeAttr(id)}',null)">取消分组</div>
        ${App.nodeGroups.map(g => `<div class="px-4 py-3 rounded-lg text-sm cursor-pointer hover:bg-elevated transition text-text-secondary flex items-center gap-2" onclick="Nodes.moveTo('${safeAttr(id)}','${safeAttr(g.id)}')">
          <span class="w-2.5 h-2.5 rounded-full" style="background:${escHtml(g.color)}"></span>${escHtml(g.name)}</div>`).join('')}
      </div>
      <div class="flex justify-end"><button class="px-5 py-2.5 text-sm font-semibold text-text-muted hover:bg-elevated rounded-lg transition cursor-pointer" onclick="App.closeModal()">取消</button></div>`;
    Modal.show(html);
  },

  async moveTo(id, gid) {
    try { await App.authFetch(`/api/enroll/${encodeURIComponent(id)}/group`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: gid }) }); App.closeModal(); } catch (e) { showToast(`移动失败: ${e.message}`, 'error'); }
  },

  // @alpha: 快捷按钮 — 发送自然语言描述给 Claude
  quickCmd(nodeId, prompt) {
    const s = _chatSessions[nodeId];
    if (!s || !s.ws || s.ws.readyState !== 1) {
      this._appendMsg(nodeId, 'system', '⚠️ AI 助手未连接');
      return;
    }
    this._appendMsg(nodeId, 'user', prompt);
    s.ws.send(JSON.stringify({ type: 'chat', text: prompt }));
  },
};
