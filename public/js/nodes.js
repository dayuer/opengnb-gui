'use strict';
// @alpha: 节点管理模块

let nodeTabStates = {};
let terminalLogs = {};

const Nodes = {
  render(container) {
    container.innerHTML = `<div class="flex gap-4 h-full">
      <div id="group-sidebar" class="w-48 shrink-0 hidden md:block"></div>
      <div class="flex-1 min-w-0 space-y-3">
        <div id="nodes-toolbar"></div>
        <div id="batch-toolbar" class="hidden"></div>
        <div id="nodes-table-wrap"></div>
        <div id="nodes-pagination"></div>
      </div>
    </div>`;
    this.renderSidebar();
    this.renderToolbar();
    this.renderTable();
    this.renderPagination();
  },

  renderSidebar() {
    const sb = $('#group-sidebar');
    if (!sb) return;
    const ungrouped = App.allNodesRaw.filter(n => !n.groupId).length;
    const f = App.nodeFilter;
    let html = `<div class="bg-surface rounded-xl border border-border-default p-3 space-y-1">
      <div class="text-xs font-medium text-text-muted mb-2 px-2">分组</div>
      <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm cursor-pointer transition ${!f.groupId ? 'bg-primary/10 text-primary' : 'text-text-secondary hover:bg-elevated'}" onclick="Nodes.filterByGroup(null)">
        ${L('layers')} <span>全部</span> <span class="ml-auto text-xs text-text-muted">${App.allNodesRaw.length}</span>
      </div>`;
    for (const g of App.nodeGroups) {
      const count = App.allNodesRaw.filter(n => n.groupId === g.id).length;
      html += `<div class="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm cursor-pointer transition ${f.groupId === g.id ? 'bg-primary/10 text-primary' : 'text-text-secondary hover:bg-elevated'}" onclick="Nodes.filterByGroup('${safeAttr(g.id)}')">
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${escHtml(g.color)}"></span>
        <span class="truncate">${escHtml(g.name)}</span>
        <span class="ml-auto text-xs text-text-muted">${count}</span>
      </div>`;
    }
    html += `<div class="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm cursor-pointer transition ${f.groupId === '__none' ? 'bg-primary/10 text-primary' : 'text-text-secondary hover:bg-elevated'}" onclick="Nodes.filterByGroup('__none')">
      ${L('circle-off')} <span>未分组</span> <span class="ml-auto text-xs text-text-muted">${ungrouped}</span>
    </div>`;
    html += `<div class="border-t border-border-subtle mt-2 pt-2">
      <button class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-text-muted hover:text-text-primary hover:bg-elevated transition cursor-pointer" onclick="Groups.showCreateModal()">${L('plus')} 新建分组</button>
    </div></div>`;
    sb.innerHTML = html;
    refreshIcons();
  },

  renderToolbar() {
    const tb = $('#nodes-toolbar');
    if (!tb) return;
    tb.innerHTML = `<div class="flex flex-wrap items-center gap-2">
      <input type="text" placeholder="搜索节点名称/IP..." class="bg-elevated border border-border-default rounded-lg px-3 py-1.5 text-sm text-text-primary placeholder:text-text-muted w-56 focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition" value="${escHtml(App.nodeFilter.keyword)}" oninput="Nodes.onSearch(this.value)">
      <select id="filter-status" class="bg-elevated border border-border-default rounded-lg px-3 py-1.5 text-sm text-text-secondary outline-none cursor-pointer focus:border-primary" onchange="Nodes.onStatusFilter(this.value)">
        <option value="">全部状态</option>
        <option value="online">在线</option>
        <option value="offline">离线</option>
        <option value="pending">待审批</option>
        <option value="rejected">已拒绝</option>
      </select>
      <div class="flex-1"></div>
      <span id="filtered-count" class="text-xs text-text-muted"></span>
    </div>`;
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
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    const pageNodes = all.slice(start, start + pageSize);

    const fc = $('#filtered-count');
    if (fc) fc.textContent = total < App.allNodesRaw.length ? `${total}/${App.allNodesRaw.length} 条` : `${total} 条`;

    const allChecked = pageNodes.length > 0 && pageNodes.every(n => App.selectedIds.has(n.id));

    let html = `<div class="bg-surface rounded-xl border border-border-default overflow-hidden">
    <table class="w-full text-sm">
      <thead><tr class="border-b border-border-default text-xs text-text-muted">
        <th class="w-8 px-3 py-2.5"><input type="checkbox" class="accent-primary cursor-pointer" ${allChecked ? 'checked' : ''} onchange="Nodes.toggleSelectAll(this.checked)"></th>
        <th class="text-left px-3 py-2.5 font-medium">名称</th>
        <th class="text-left px-3 py-2.5 font-medium">TUN 地址</th>
        <th class="text-left px-3 py-2.5 font-medium">状态</th>
        <th class="text-left px-3 py-2.5 font-medium">分组</th>
        <th class="text-left px-3 py-2.5 font-medium">操作</th>
      </tr></thead><tbody>`;

    for (const node of pageNodes) {
      const checked = App.selectedIds.has(node.id) ? 'checked' : '';
      const monitorNode = App.nodesData.find(n => n.id === node.id);
      const isOnline = monitorNode?.online;
      const isPending = node.status === 'pending';
      const isRejected = node.status === 'rejected';
      const isExpanded = App.selectedNodeId === node.id;
      const group = App.nodeGroups.find(g => g.id === node.groupId);

      let statusHtml;
      if (isPending) statusHtml = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-warning/15 text-warning">待审批</span>`;
      else if (isRejected) statusHtml = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-danger/15 text-danger">已拒绝</span>`;
      else if (isOnline) statusHtml = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-success/15 text-success">在线</span>`;
      else statusHtml = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-danger/15 text-danger">离线</span>`;

      let actions = '';
      if (isPending) {
        actions = `<button class="p-1 rounded text-success hover:bg-success/10 transition cursor-pointer" onclick="Nodes.approve('${safeAttr(node.id)}')" title="审批">${L('check')}</button>
          <button class="p-1 rounded text-danger hover:bg-danger/10 transition cursor-pointer" onclick="Nodes.reject('${safeAttr(node.id)}')" title="拒绝">${L('x')}</button>`;
      } else {
        actions = `<button class="p-1 rounded text-text-muted hover:text-text-primary hover:bg-elevated transition cursor-pointer" onclick="Nodes.showEditModal('${safeAttr(node.id)}')" title="编辑">${L('pencil')}</button>
          <button class="p-1 rounded text-text-muted hover:text-text-primary hover:bg-elevated transition cursor-pointer" onclick="Nodes.showMoveModal('${safeAttr(node.id)}')" title="移动">${L('folder-input')}</button>`;
      }

      html += `<tr class="border-b border-border-subtle hover:bg-elevated/50 transition cursor-pointer ${isExpanded ? 'bg-elevated/30' : ''}" onclick="Nodes.expandRow('${safeAttr(node.id)}')">
        <td class="px-3 py-2.5" onclick="event.stopPropagation()"><input type="checkbox" class="accent-primary cursor-pointer" ${checked} onchange="Nodes.toggleSelect('${safeAttr(node.id)}',this.checked)"></td>
        <td class="px-3 py-2.5 font-medium">${escHtml(node.name || node.id)}</td>
        <td class="px-3 py-2.5 font-mono text-xs text-text-secondary">${escHtml(node.tunAddr || '—')}</td>
        <td class="px-3 py-2.5">${statusHtml}</td>
        <td class="px-3 py-2.5">${group ? `<span class="inline-flex items-center gap-1 text-xs"><span class="w-2 h-2 rounded-full" style="background:${escHtml(group.color)}"></span>${escHtml(group.name)}</span>` : '<span class="text-text-muted text-xs">—</span>'}</td>
        <td class="px-3 py-2.5" onclick="event.stopPropagation()"><div class="flex gap-1">${actions}</div></td>
      </tr>`;

      if (isExpanded) {
        html += `<tr data-detail="${safeAttr(node.id)}"><td colspan="6" class="p-0"><div class="inline-panel bg-elevated/30 p-4 border-b border-border-default"></div></td></tr>`;
      }
    }

    if (pageNodes.length === 0) {
      html += `<tr><td colspan="6" class="text-center py-10 text-text-muted text-sm">无匹配数据</td></tr>`;
    }

    html += `</tbody></table></div>`;
    wrap.innerHTML = html;
    refreshIcons();

    // 批量操作栏
    this.updateBatchToolbar();

    // 渲染展开面板
    if (App.selectedNodeId) {
      const panel = document.querySelector(`tr[data-detail="${App.selectedNodeId}"] .inline-panel`);
      if (panel) {
        const monitorNode = App.nodesData.find(n => n.id === App.selectedNodeId);
        if (monitorNode) this.renderInlineDetail(panel, monitorNode);
        else panel.innerHTML = `<div class="text-sm text-text-muted">${L('zap')} 无监控数据</div>`;
        refreshIcons();
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
        ${tabs.map(t => `<button class="px-3 py-1.5 text-xs rounded-md transition cursor-pointer flex items-center gap-1.5 ${ts.tab === t.key ? 'bg-primary/10 text-primary font-medium' : 'text-text-secondary hover:text-text-primary hover:bg-elevated'}" onclick="Nodes.switchTab('${safeAttr(node.id)}','${t.key}')">${L(t.icon)} ${t.label}</button>`).join('')}
      </div>
      <div id="inline-tab-content-${safeAttr(node.id)}">`;

    if (ts.tab === 'overview') html += this._renderOverview(node);
    else if (ts.tab === 'terminal') html += this._renderTerminal(node);
    else html += `<div class="text-text-muted text-sm">${L('loader')} 加载中...</div>`;

    html += `</div></div>`;
    panel.innerHTML = html;
    refreshIcons();

    if (ts.tab === 'claw') this._loadClawTab(node.id, ts.clawSubTab);
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

    // 运行状态
    html += `<div><div class="text-xs font-medium text-primary mb-2">运行状态</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${this._statCard(L('activity'), '采集延迟', `${node.sshLatencyMs||0}ms`, node.sshLatencyMs > 500 ? 'text-danger' : 'text-success')}
        ${this._statCard(L('clock'), '运行时长', escHtml(si.uptime || '—'), '')}
        ${this._statCard(L('bot'), 'OpenClaw', clawRunning ? '运行中' : '未运行', clawRunning ? 'text-success' : 'text-warning')}
        ${this._statCard(L('monitor'), '系统', escHtml(si.hostname || '—'), 'text-primary', escHtml(si.os || '—'))}
      </div></div>`;

    // 资源使用
    html += `<div><div class="text-xs font-medium text-success mb-2">资源使用</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${this._gaugeCard(L('cpu'), 'CPU', `${cpuPct}%`, cpuPct, si.cpuCores ? `${si.cpuCores} 核` : '')}
        ${this._gaugeCard(L('memory-stick'), '内存', `${memPct}%`, memPct, si.memTotalMB > 0 ? `${si.memUsedMB}/${si.memTotalMB} MB` : '')}
        ${this._gaugeCard(L('hard-drive'), '磁盘', `${diskPct}%`, diskPct, si.diskTotal ? `${escHtml(si.diskUsed)}/${escHtml(si.diskTotal)}` : '')}
        ${this._statCard(L('wrench'), '内核', escHtml(si.kernel || '—'), '', escHtml(si.arch || '—'))}
      </div></div>`;

    // P2P 网络
    html += `<div><div class="text-xs font-medium text-info mb-2">P2P 网络</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${this._statCard(L('link'), '节点数', `${peers.length}`, 'text-primary', `直连 ${directP}`)}
        ${this._statCard(L('zap'), '直连率', peers.length > 0 ? `${Math.round(directP/peers.length*100)}%` : '—', directP >= peers.length * 0.8 ? 'text-success' : 'text-warning')}
        ${this._statCard(L('download'), '总流入', formatBytes(totalIn), 'text-primary')}
        ${this._statCard(L('upload'), '总流出', formatBytes(totalOut), 'text-warning')}
      </div></div>`;

    // 节点表
    if (peers.length) {
      html += `<div><div class="text-xs font-medium text-text-secondary mb-2">GNB 节点 (${peers.length})</div>
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
    return `<div class="bg-surface rounded-lg border border-border-subtle p-3">
      <div class="flex items-center gap-1.5 mb-1"><span class="[&_svg]:w-3.5 [&_svg]:h-3.5 text-text-muted">${icon}</span><span class="text-[11px] text-text-muted">${label}</span></div>
      <div class="text-sm font-semibold ${color}">${value}</div>
      ${sub ? `<div class="text-[10px] text-text-muted mt-0.5">${sub}</div>` : ''}
    </div>`;
  },

  _gaugeCard(icon, label, value, pct, sub) {
    const c = pctBg(pct);
    return `<div class="bg-surface rounded-lg border border-border-subtle p-3">
      <div class="flex items-center gap-1.5 mb-1"><span class="[&_svg]:w-3.5 [&_svg]:h-3.5 text-text-muted">${icon}</span><span class="text-[11px] text-text-muted">${label}</span></div>
      <div class="text-sm font-semibold ${pctColor(pct)}">${value}</div>
      ${pct > 0 ? `<div class="gauge-bar mt-1.5"><div class="gauge-fill ${c}" style="width:${Math.min(pct,100)}%"></div></div>` : ''}
      ${sub ? `<div class="text-[10px] text-text-muted mt-0.5">${sub}</div>` : ''}
    </div>`;
  },

  _renderTerminal(node) {
    const logs = terminalLogs[node.id] || [];
    let html = `<div class="bg-base rounded-lg border border-border-default overflow-hidden">
      <div class="max-h-60 overflow-y-auto p-3 font-mono text-xs space-y-1" id="terminal-output-${safeAttr(node.id)}">`;
    if (logs.length === 0) {
      html += `<div class="text-text-muted">输入运维指令，如：状态、重启 gnb、安装 openclaw、日志</div>`;
    } else {
      for (const log of logs) {
        const cls = log.role === 'user' ? 'text-primary' : log.role === 'error' ? 'text-danger' : 'text-text-secondary';
        html += `<div class="${cls}">${log.role === 'user' ? '❯ ' : ''}${escHtml(log.text)}</div>`;
      }
    }
    html += `</div>
      <div class="flex border-t border-border-default">
        <input type="text" class="flex-1 bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none font-mono" id="terminal-input-${safeAttr(node.id)}" placeholder="输入运维指令..." autocomplete="off" onkeydown="if(event.key==='Enter')Nodes.execCmd('${safeAttr(node.id)}')">
        <button class="px-4 text-xs text-primary hover:bg-primary/10 transition cursor-pointer" onclick="Nodes.execCmd('${safeAttr(node.id)}')">${L('send')} 执行</button>
      </div>
    </div>`;
    return html;
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
    let html = `<div class="flex gap-1 mb-3">${subTabs.map(st => `<button class="px-2.5 py-1 text-[11px] rounded transition cursor-pointer ${subTab === st.key ? 'bg-primary/10 text-primary' : 'text-text-muted hover:text-text-primary hover:bg-elevated'}" onclick="Nodes.switchClawSubTab('${safeAttr(nodeId)}','${st.key}')">${L(st.icon)} ${st.label}</button>`).join('')}</div>
    <div id="claw-content-${safeAttr(nodeId)}" class="text-sm text-text-muted">${L('loader')} 加载中...</div>`;
    container.innerHTML = html;
    refreshIcons();

    const nodeConfig = App.allNodesRaw.find(n => n.id === nodeId);
    const detail = document.getElementById(`claw-content-${nodeId}`);
    if (!nodeConfig?.clawToken) {
      const monNode = App.nodesData.find(n => n.id === nodeId);
      const oc = monNode?.openclaw;
      if (oc && oc.running && oc.config) {
        detail.innerHTML = `<pre class="text-xs bg-base rounded-lg p-3 overflow-x-auto">${escHtml(JSON.stringify(oc.config, null, 2))}</pre>`;
      } else {
        detail.innerHTML = `<div class="text-text-muted text-sm">${L('info')} 未配置 OpenClaw Token</div>`;
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
    const panel = document.querySelector(`tr[data-detail="${nodeId}"] .inline-panel`);
    if (panel && monitorNode) this.renderInlineDetail(panel, monitorNode);
  },

  switchClawSubTab(nodeId, subTab) {
    this._getTabState(nodeId).clawSubTab = subTab;
    this._loadClawTab(nodeId, subTab);
  },

  filterByGroup(gid) { App.nodeFilter.groupId = gid; App.nodePagination.page = 1; App.selectedIds.clear(); this.renderSidebar(); this.renderTable(); this.renderPagination(); },
  onSearch(v)  { App.nodeFilter.keyword = v; App.nodePagination.page = 1; this.renderTable(); this.renderPagination(); },
  onStatusFilter(v) { App.nodeFilter.status = v; App.nodePagination.page = 1; this.renderTable(); this.renderPagination(); },
  expandRow(id) { App.selectedNodeId = App.selectedNodeId === id ? null : id; this.renderTable(); },

  goPage(p)  { App.nodePagination.page = p; App.selectedIds.clear(); this.renderTable(); this.renderPagination(); },
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
    bar.innerHTML = `<div class="flex items-center gap-2 bg-surface rounded-lg border border-border-default p-2">
      <span class="text-xs text-text-secondary">已选 ${App.selectedIds.size} 个</span>
      <button class="px-3 py-1 text-xs rounded bg-success/15 text-success hover:bg-success/25 transition cursor-pointer" onclick="Nodes.batchAction('approve')">${L('check')} 审批</button>
      <button class="px-3 py-1 text-xs rounded bg-danger/15 text-danger hover:bg-danger/25 transition cursor-pointer" onclick="Nodes.batchAction('reject')">${L('x')} 拒绝</button>
      <button class="px-3 py-1 text-xs rounded bg-danger/15 text-danger hover:bg-danger/25 transition cursor-pointer" onclick="Nodes.batchAction('remove')">${L('trash-2')} 删除</button>
      <button class="px-3 py-1 text-xs rounded bg-elevated text-text-secondary hover:bg-border-default transition cursor-pointer" onclick="App.selectedIds.clear();Nodes.renderTable()">取消</button>
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
    let html = `<div class="flex items-center justify-between mt-3 text-xs text-text-muted">
      <span>第 ${page}/${totalPages} 页 · 共 ${total} 条</span><div class="flex gap-1">`;
    html += `<button class="px-2.5 py-1 rounded bg-elevated hover:bg-border-default transition cursor-pointer disabled:opacity-30" ${page <= 1 ? 'disabled' : ''} onclick="Nodes.goPage(${page-1})">${L('chevron-left')}</button>`;
    for (let p = Math.max(1, page-3); p <= Math.min(totalPages, page+3); p++) {
      html += `<button class="px-2.5 py-1 rounded transition cursor-pointer ${p === page ? 'bg-primary text-white' : 'bg-elevated hover:bg-border-default'}" onclick="Nodes.goPage(${p})">${p}</button>`;
    }
    html += `<button class="px-2.5 py-1 rounded bg-elevated hover:bg-border-default transition cursor-pointer disabled:opacity-30" ${page >= totalPages ? 'disabled' : ''} onclick="Nodes.goPage(${page+1})">${L('chevron-right')}</button>`;
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
        this.renderSidebar(); this.renderTable(); this.renderPagination();
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
        this.renderSidebar(); this.renderTable(); this.renderPagination();
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
      this.renderSidebar(); this.renderTable(); this.renderPagination();
      showToast(`${labels[action]}完成: ${data.succeeded?.length||0} 成功, ${data.failed?.length||0} 失败`);
    } catch (e) { showToast(`操作失败: ${e.message}`, 'error'); }
  },

  async provision(id) { /* placeholder */ },

  showEditModal(id) {
    const node = App.allNodesRaw.find(n => n.id === id);
    if (!node) return;
    Modal.show(`
      <h3 class="text-base font-semibold mb-4">编辑节点</h3>
      <form id="edit-node-form" onsubmit="Nodes.saveEdit(event,'${safeAttr(id)}')">
        <label class="block text-xs text-text-secondary mb-1">名称</label>
        <input class="w-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary mb-3 outline-none focus:border-primary" name="name" value="${escHtml(node.name||'')}" required maxlength="64">
        <label class="block text-xs text-text-secondary mb-1">TUN 地址</label>
        <input class="w-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary mb-3 outline-none focus:border-primary font-mono" name="tunAddr" value="${escHtml(node.tunAddr||'')}" required>
        <label class="block text-xs text-text-secondary mb-1">SSH 端口</label>
        <input class="w-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary mb-3 outline-none focus:border-primary" name="sshPort" type="number" value="${node.sshPort||22}" min="1" max="65535" required>
        <label class="block text-xs text-text-secondary mb-1">SSH 用户名</label>
        <input class="w-full bg-elevated border border-border-default rounded-lg px-3 py-2 text-sm text-text-primary mb-3 outline-none focus:border-primary" name="sshUser" value="${escHtml(node.sshUser||'synon')}" required>
        <div id="edit-node-error" class="hidden text-danger text-xs mb-2"></div>
        <div class="flex justify-end gap-2 mt-2">
          <button type="button" class="px-4 py-2 text-sm rounded-lg bg-elevated hover:bg-border-default text-text-secondary transition cursor-pointer" onclick="App.closeModal()">取消</button>
          <button type="submit" id="edit-node-save-btn" class="px-4 py-2 text-sm rounded-lg bg-primary hover:bg-primary-light text-white transition cursor-pointer">保存</button>
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
    let html = `<h3 class="text-base font-semibold mb-3">移动到分组</h3>
      <div class="space-y-1 mb-4">
        <div class="px-3 py-2 rounded-lg text-sm cursor-pointer hover:bg-elevated transition text-text-secondary" onclick="Nodes.moveTo('${safeAttr(id)}',null)">取消分组</div>
        ${App.nodeGroups.map(g => `<div class="px-3 py-2 rounded-lg text-sm cursor-pointer hover:bg-elevated transition text-text-secondary flex items-center gap-2" onclick="Nodes.moveTo('${safeAttr(id)}','${safeAttr(g.id)}')">
          <span class="w-2 h-2 rounded-full" style="background:${escHtml(g.color)}"></span>${escHtml(g.name)}</div>`).join('')}
      </div>
      <div class="flex justify-end"><button class="px-4 py-2 text-sm rounded-lg bg-elevated hover:bg-border-default text-text-secondary transition cursor-pointer" onclick="App.closeModal()">取消</button></div>`;
    Modal.show(html);
  },

  async moveTo(id, gid) {
    try { await App.authFetch(`/api/enroll/${encodeURIComponent(id)}/group`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ groupId: gid }) }); App.closeModal(); } catch (e) { showToast(`移动失败: ${e.message}`, 'error'); }
  },

  async execCmd(nodeId) {
    const input = document.getElementById(`terminal-input-${nodeId}`);
    const output = document.getElementById(`terminal-output-${nodeId}`);
    if (!input || !input.value.trim()) return;
    const cmd = input.value.trim();
    input.value = '';
    if (!terminalLogs[nodeId]) terminalLogs[nodeId] = [];
    terminalLogs[nodeId].push({ role: 'user', text: cmd });
    output.innerHTML += `<div class="text-primary">❯ ${escHtml(cmd)}</div><div class="text-text-muted" id="terminal-pending-${nodeId}">⏳ 执行中...</div>`;
    output.scrollTop = output.scrollHeight;
    try {
      const res = await App.authFetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: cmd, nodeId }) });
      const data = await res.json();
      const response = data.response || '(无响应)';
      terminalLogs[nodeId].push({ role: 'assistant', text: response });
      document.getElementById(`terminal-pending-${nodeId}`)?.remove();
      output.innerHTML += `<div class="text-text-secondary">${escHtml(response)}</div>`;
    } catch (e) {
      terminalLogs[nodeId].push({ role: 'error', text: `错误: ${e.message}` });
      document.getElementById(`terminal-pending-${nodeId}`)?.remove();
      output.innerHTML += `<div class="text-danger">❌ ${escHtml(e.message)}</div>`;
    }
    output.scrollTop = output.scrollHeight;
  },
};
