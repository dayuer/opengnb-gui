'use strict';

/* SynonClaw Console — 前端应用逻辑（含页面路由） */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const L = (name) => `<i data-lucide="${name}"></i>`;
function refreshIcons() { if (window.lucide) lucide.createIcons(); }

/** @alpha: 轻量 Toast 通知 */
function showToast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  Object.assign(el.style, {
    position: 'fixed', top: '16px', right: '16px', zIndex: '9999',
    padding: '10px 20px', borderRadius: '8px', fontSize: '13px', fontWeight: '500',
    color: '#fff', background: type === 'error' ? '#f85149' : '#3fb950',
    boxShadow: '0 4px 12px rgba(0,0,0,.3)', opacity: '0', transition: 'opacity .3s',
  });
  document.body.appendChild(el);
  requestAnimationFrame(() => el.style.opacity = '1');
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

/** 安全转义字符串用于 HTML 属性中的 onclick 等场景，防止 XSS */
function safeAttr(str) { return String(str).replace(/[&'"<>]/g, c => ({'&':'&amp;',"'":'&#39;','"':'&quot;','<':'&lt;','>':'&gt;'}[c])); }

// --- 认证 ---
function getToken() { return localStorage.getItem('gnb_admin_token') || ''; }
function setToken(token) { localStorage.setItem('gnb_admin_token', token); }

function promptToken() {
  showLoginPage();
}

/** @beta: 显示独立登录页 */
function showLoginPage() {
  const lp = $('#login-page');
  const app = $('#app');
  if (lp) { lp.style.display = 'flex'; refreshIcons(); }
  if (app) app.style.display = 'none';
}

/** @beta: 隐藏登录页，显示主应用 */
function hideLoginPage() {
  const lp = $('#login-page');
  const app = $('#app');
  if (lp) lp.style.display = 'none';
  if (app) app.style.display = 'flex';
}

let _cachedApiToken = '';
async function doLogin(e) {
  if (e) e.preventDefault();
  const username = $('#login-username')?.value?.trim();
  const password = $('#login-password')?.value;
  if (!username || !password) return;
  const errEl = $('#login-error');
  const btn = $('#login-btn');
  const btnText = $('#login-btn-text');
  if (btn) btn.disabled = true;
  if (btnText) btnText.textContent = '登录中...';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (errEl) { errEl.textContent = data.error || '登录失败'; errEl.classList.add('show'); }
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = '登 录';
      return;
    }
    setToken(data.token);
    _cachedApiToken = data.apiToken || '';
    hideLoginPage();
    connectWS();
    switchPage('dashboard');
  } catch (e) {
    if (errEl) { errEl.textContent = '网络错误'; errEl.classList.add('show'); }
    if (btn) btn.disabled = false;
    if (btnText) btnText.textContent = '登 录';
  }
}

async function authFetch(url, options = {}) {
  const token = getToken();
  options.headers = { ...options.headers, ...(token ? { 'Authorization': `Bearer ${token}` } : {}) };
  const res = await fetch(url, options);
  if (res.status === 401) { showLoginPage(); throw new Error('认证失败'); }
  return res;
}

// --- 全局状态 ---
let nodesData = [];
let pendingNodes = [];
let selectedNodeId = null;
let currentPage = 'dashboard';
let ws = null;
let opsLogsCache = {};
// @alpha: 节点管理新状态
let nodeGroups = [];
let allNodesRaw = [];  // 全量节点（含 pending/rejected）
let nodeFilter = { groupId: null, subnet: '', keyword: '', status: '' };
let selectedIds = new Set();
let nodePagination = { page: 1, pageSize: 50 };

// ═══════════════════════════════════════
// 页面路由
// ═══════════════════════════════════════

const PAGE_TITLES = {
  dashboard: '仪表盘',
  nodes: '节点管理',
  users: '用户管理',
  groups: '分组管理',
  settings: '系统设置',
};

function switchPage(page) {
  currentPage = page;
  // 更新导航高亮
  $$('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });
  // 更新标题
  $('#page-title').textContent = PAGE_TITLES[page] || page;
  // 渲染页面
  renderPage(page);
  refreshIcons();
  // 移动端关闭侧边栏
  $('#sidebar').classList.remove('mobile-open');
}

function renderPage(page) {
  const container = $('#main-content');
  switch (page) {
    case 'dashboard': renderDashboardPage(container); break;
    case 'nodes':     renderNodesPage(container); break;
    case 'users':     renderUsersPage(container); break;
    case 'groups':    renderGroupsPage(container); break;
    case 'settings':  renderSettingsPage(container); break;
    default:          renderPlaceholder(container, L('lock'), '未知页面', ''); break;
  }
}

// --- 占位页面 ---
function renderPlaceholder(container, icon, title, desc) {
  container.innerHTML = `
    <div class="page-placeholder">
      <div class="placeholder-icon">${icon}</div>
      <div class="placeholder-title">${escHtml(title)}</div>
      <div class="placeholder-desc">${escHtml(desc)}</div>
    </div>
  `;
}

// ═══════════════════════════════════════
// 仪表盘页面 (@alpha: 增强版)
// ═══════════════════════════════════════

async function renderDashboardPage(container) {
  const online = nodesData.filter(n => n.online).length;
  const offline = nodesData.filter(n => !n.online).length;
  const total = nodesData.length;
  const pending = pendingNodes.length;

  let totalPeers = 0, directPeers = 0;
  for (const n of nodesData) {
    if (!n.nodes) continue;
    totalPeers += n.nodes.length;
    directPeers += n.nodes.filter(p => p.status === 'Direct').length;
  }

  // @alpha: 全局汇总指标
  try { const r = await authFetch('/api/nodes/metrics/summary'); metricsSummary = await r.json(); } catch (_) {}
  const ms = metricsSummary || {};
  const alerts = ms.alertCount || 0;

  let html = `<div class="page-dashboard">`;
  // 汇总卡片
  html += `<div class="dashboard-stats">`;
  html += dashCard(L('globe'), '节点', `${total}`, 'accent', `在线 ${online} / 离线 ${offline}`);
  html += dashCard(L('cpu'), 'CPU', ms.avgCpu != null ? `${ms.avgCpu}%` : '—', pctColor(ms.avgCpu || 0), '集群均值');
  html += dashCard(L('memory-stick'), '内存', ms.avgMemPct != null ? `${ms.avgMemPct}%` : '—', pctColor(ms.avgMemPct || 0), '集群均值');
  html += dashCard(L('hard-drive'), '磁盘', ms.avgDiskPct != null ? `${ms.avgDiskPct}%` : '—', pctColor(ms.avgDiskPct || 0), '集群均值');
  html += dashCard(L('activity'), '延迟', ms.avgLatency != null ? `${ms.avgLatency}ms` : '—', ms.avgLatency > 500 ? 'red' : ms.avgLatency > 200 ? 'yellow' : 'green', 'SSH 均值');
  html += dashCard(L('link'), 'P2P', `${directPeers}/${totalPeers}`, directPeers > 0 ? 'green' : 'red', totalPeers > 0 ? `${Math.round(directPeers/totalPeers*100)}% 直连` : '无连接');
  html += dashCardAlert(alerts, pending);
  html += `</div>`;

  // @alpha: 时段切换器
  html += `<div class="range-selector"><span class="rs-label">趋势:</span>`;
  for (const r of ['1h','6h','24h']) html += `<button class="rs-btn ${metricsRange===r?'active':''}" onclick="switchMetricsRange('${r}')">${r}</button>`;
  html += `</div>`;

  // 节点概览 — 按分组汇总
  if (total > 0) {
    // 按分组归类节点
    const groupMap = new Map();  // groupId -> [nodes]
    for (const node of nodesData) {
      const gid = node.groupId || '__none';
      if (!groupMap.has(gid)) groupMap.set(gid, []);
      groupMap.get(gid).push(node);
    }

    // 按分组顺序渲染（已有分组 → 未分组）
    const orderedGroupIds = nodeGroups.map(g => g.id);
    if (groupMap.has('__none')) orderedGroupIds.push('__none');

    for (const gid of orderedGroupIds) {
      const nodes = groupMap.get(gid);
      if (!nodes || nodes.length === 0) continue;
      const group = nodeGroups.find(g => g.id === gid);
      const gName = group ? group.name : '未分组';
      const gColor = group ? group.color : 'var(--text-muted)';
      const gOnline = nodes.filter(n => n.online).length;
      const gTotal = nodes.length;

      // 组内均值
      const onlineNodes = nodes.filter(n => n.online && n.sysInfo);
      let gCpu = 0, gMem = 0, gDisk = 0;
      if (onlineNodes.length > 0) {
        gCpu = Math.round(onlineNodes.reduce((s, n) => s + (n.sysInfo?.cpuUsage || 0), 0) / onlineNodes.length);
        gMem = Math.round(onlineNodes.reduce((s, n) => {
          const si = n.sysInfo || {};
          return s + (si.memTotalMB > 0 ? (si.memUsedMB / si.memTotalMB * 100) : 0);
        }, 0) / onlineNodes.length);
        gDisk = Math.round(onlineNodes.reduce((s, n) => s + (parseInt(n.sysInfo?.diskUsePct) || 0), 0) / onlineNodes.length);
      }

      html += `<div class="group-section">
        <div class="group-section-header" onclick="toggleGroupSection('${safeAttr(gid)}')">
          <div class="gsh-left">
            <span class="group-color-dot" style="background:${escHtml(gColor)}"></span>
            <span class="gsh-name">${escHtml(gName)}</span>
            <span class="gsh-count">${gOnline}/${gTotal} 在线</span>
          </div>
          <div class="gsh-right">
            <span class="gsh-stat ${pctColor(gCpu)}">CPU ${gCpu}%</span>
            <span class="gsh-stat ${pctColor(gMem)}">内存 ${gMem}%</span>
            <span class="gsh-stat ${pctColor(gDisk)}">磁盘 ${gDisk}%</span>
            <span class="gsh-chevron">${L('chevron-down')}</span>
          </div>
        </div>
        <div class="node-accordion group-accordion open" id="group-acc-${safeAttr(gid)}">`;
      for (const node of nodes) {
        html += renderNodeAccordionPanel(node);
      }
      html += `</div></div>`;
    }
  }

  html += `</div>`;
  container.innerHTML = html;
  refreshIcons();
  // @alpha: 绘制趋势图
  for (const node of nodesData) { if (node.online) loadAndDrawSparklines(node.id); }
}

/** 分组折叠/展开 */
function toggleGroupSection(groupId) {
  const acc = $(`#group-acc-${CSS.escape(groupId)}`);
  if (acc) acc.classList.toggle('open');
}

/** 手风琴展开/收起 */
function toggleAccordion(nodeId) {
  const items = document.querySelectorAll('.accordion-item');
  for (const item of items) {
    if (item.dataset.nodeId === nodeId) {
      item.classList.toggle('open');
    } else {
      item.classList.remove('open');
    }
  }
}

function dashCard(icon, title, value, color, sub) {
  return `
    <div class="dash-card">
      <div class="dc-title">${icon} ${escHtml(title)}</div>
      <div class="dc-value ${color}">${value}</div>
      <div class="dc-sub">${escHtml(sub)}</div>
    </div>
  `;
}



// ═══════════════════════════════════════
// @alpha: 节点管理页面（完整重构）
// ═══════════════════════════════════════

function renderNodesPage(container) {
  container.innerHTML = `
    <div class="nodes-layout">
      <aside class="group-sidebar" id="group-sidebar"></aside>
      <div class="nodes-main">
        <div class="nodes-toolbar" id="nodes-toolbar"></div>
        <div class="nodes-table-wrap" id="nodes-table-wrap"></div>
        <div class="nodes-pagination" id="nodes-pagination"></div>
      </div>
    </div>
    <div class="batch-toolbar" id="batch-toolbar" style="display:none"></div>
  `;
  renderGroupSidebar();
  renderNodesToolbar();
  renderNodesTable();
  renderPagination();
  refreshIcons();
}

// --- 分组侧栏 ---
function renderGroupSidebar() {
  const sb = $('#group-sidebar');
  if (!sb) return;
  const totalAll = allNodesRaw.length;
  const ungrouped = allNodesRaw.filter(n => !n.groupId).length;

  let html = `<div class="group-sidebar-header">
    <span class="group-sidebar-title">分组</span>
    <button class="group-add-btn" onclick="showGroupModal()" title="新建分组">${L('plus')}</button>
  </div>`;

  html += `<ul class="group-list">`;
  // 全部
  html += `<li class="group-item ${!nodeFilter.groupId ? 'active' : ''}" onclick="filterByGroup(null)">
    <span class="group-color-dot" style="background:var(--accent)"></span>
    <span class="group-name">全部</span>
    <span class="group-count">${totalAll}</span>
  </li>`;
  // 各分组
  for (const g of nodeGroups) {
    html += `<li class="group-item ${nodeFilter.groupId === g.id ? 'active' : ''}" onclick="filterByGroup('${safeAttr(g.id)}')">
      <span class="group-color-dot" style="background:${escHtml(g.color)}"></span>
      <span class="group-name">${escHtml(g.name)}</span>
      <span class="group-count">${g.nodeCount}</span>
      <button class="group-del-btn" onclick="event.stopPropagation();deleteGroupUI('${safeAttr(g.id)}')" title="删除">${L('trash-2')}</button>
    </li>`;
  }
  // 未分组
  html += `<li class="group-item ${nodeFilter.groupId === '__none' ? 'active' : ''}" onclick="filterByGroup('__none')">
    <span class="group-color-dot" style="background:var(--text-muted)"></span>
    <span class="group-name">未分组</span>
    <span class="group-count">${ungrouped}</span>
  </li>`;
  html += `</ul>`;
  sb.innerHTML = html;
  refreshIcons();
}

// --- 工具栏 ---
function renderNodesToolbar() {
  const tb = $('#nodes-toolbar');
  if (!tb) return;
  tb.innerHTML = `
    <div class="toolbar-left">
      <div class="toolbar-search">
        ${L('search')}
        <input type="text" id="node-search" placeholder="搜索节点名称/ID/IP..." value="${escHtml(nodeFilter.keyword)}" oninput="onNodeSearch(this.value)">
      </div>
      <div class="toolbar-search cidr-search">
        ${L('network')}
        <input type="text" id="cidr-input" placeholder="CIDR 如 10.1.0.0/24" value="${escHtml(nodeFilter.subnet)}" onkeydown="if(event.key==='Enter')onCidrFilter(this.value)">
        <button class="toolbar-btn sm" onclick="onCidrFilter($('#cidr-input').value)">筛选</button>
      </div>
      <select id="status-filter" class="toolbar-select" onchange="onStatusFilter(this.value)">
        <option value="">全部状态</option>
        <option value="approved" ${nodeFilter.status==='approved'?'selected':''}>已审批</option>
        <option value="pending" ${nodeFilter.status==='pending'?'selected':''}>待审批</option>
        <option value="rejected" ${nodeFilter.status==='rejected'?'selected':''}>已拒绝</option>
      </select>
    </div>
    <div class="toolbar-right">
      <span class="toolbar-count" id="filtered-count"></span>
    </div>
  `;
  refreshIcons();
}

// --- 数据表格 ---
function getFilteredNodesList() {
  let list = [...allNodesRaw];
  if (nodeFilter.groupId === '__none') list = list.filter(n => !n.groupId);
  else if (nodeFilter.groupId) list = list.filter(n => n.groupId === nodeFilter.groupId);
  if (nodeFilter.status) list = list.filter(n => n.status === nodeFilter.status);
  if (nodeFilter.keyword) {
    const kw = nodeFilter.keyword.toLowerCase();
    list = list.filter(n =>
      (n.name || '').toLowerCase().includes(kw) ||
      (n.id || '').toLowerCase().includes(kw) ||
      (n.tunAddr || '').toLowerCase().includes(kw)
    );
  }
  if (nodeFilter.subnet && isValidCidr(nodeFilter.subnet)) {
    list = list.filter(n => n.tunAddr && cidrMatch(n.tunAddr, nodeFilter.subnet));
  }
  return list;
}

function renderNodesTable() {
  const wrap = $('#nodes-table-wrap');
  if (!wrap) return;
  const all = getFilteredNodesList();
  const total = all.length;
  const { page, pageSize } = nodePagination;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  nodePagination.page = Math.min(page, totalPages);
  const start = (nodePagination.page - 1) * pageSize;
  const pageNodes = all.slice(start, start + pageSize);

  // 更新计数
  const fc = $('#filtered-count');
  if (fc) fc.textContent = `共 ${total} 个节点`;

  const allChecked = pageNodes.length > 0 && pageNodes.every(n => selectedIds.has(n.id));

  let html = `<table class="nodes-data-table">
    <thead><tr>
      <th class="col-check"><input type="checkbox" ${allChecked ? 'checked' : ''} onchange="toggleSelectAll(this.checked)"></th>
      <th class="col-status">状态</th>
      <th class="col-name">名称</th>
      <th class="col-addr">TUN 地址</th>
      <th class="col-group">分组</th>
      <th class="col-latency">延迟</th>
      <th class="col-actions">操作</th>
    </tr></thead><tbody>`;

  if (pageNodes.length === 0) {
    html += `<tr><td colspan="7" class="table-empty">无匹配节点</td></tr>`;
  }

  for (const node of pageNodes) {
    const checked = selectedIds.has(node.id) ? 'checked' : '';
    const monitorNode = nodesData.find(n => n.id === node.id);
    const online = monitorNode?.online;
    const latency = monitorNode?.sshLatencyMs;
    const statusIcon = node.status === 'approved'
      ? (online ? `<span class="node-dot online"></span>` : `<span class="node-dot offline"></span>`)
      : node.status === 'pending'
        ? `<span class="node-dot unknown"></span>`
        : `<span class="node-dot offline"></span>`;
    const statusLabel = node.status === 'approved'
      ? (online ? '在线' : '离线')
      : node.status === 'pending' ? '待审批' : '已拒绝';
    const group = nodeGroups.find(g => g.id === node.groupId);
    const groupTag = group
      ? `<span class="group-tag" style="border-color:${escHtml(group.color)};color:${escHtml(group.color)}">${escHtml(group.name)}</span>`
      : `<span class="group-tag none">未分组</span>`;
    const isExpanded = selectedNodeId === node.id;

    html += `<tr class="node-row ${isExpanded ? 'expanded' : ''}" data-id="${safeAttr(node.id)}">
      <td class="col-check"><input type="checkbox" ${checked} onchange="toggleSelectNode('${safeAttr(node.id)}', this.checked)"></td>
      <td class="col-status" onclick="expandNodeRow('${safeAttr(node.id)}')">${statusIcon} <span class="status-label">${statusLabel}</span></td>
      <td class="col-name" onclick="expandNodeRow('${safeAttr(node.id)}')">${escHtml(node.name || node.id)}</td>
      <td class="col-addr" onclick="expandNodeRow('${safeAttr(node.id)}')">${escHtml(node.tunAddr || '—')}</td>
      <td class="col-group">${groupTag}</td>
      <td class="col-latency">${online && latency ? latency + 'ms' : '—'}</td>
      <td class="col-actions">
        ${node.status === 'pending' ? `<button class="btn-approve-sm" onclick="approveNode('${safeAttr(node.id)}')">  ✓</button><button class="btn-reject-sm" onclick="rejectNode('${safeAttr(node.id)}')">  ✗</button>` : ''}
        ${node.status === 'approved' ? `<button class="btn-icon" onclick="showEditNodeModal('${safeAttr(node.id)}')" title="编辑节点">${L('pencil')}</button>` : ''}
        <button class="btn-icon" onclick="showMoveGroupModal('${safeAttr(node.id)}')" title="移动分组">${L('folder-input')}</button>
      </td>
    </tr>`;

    // 展开详情行
    if (isExpanded && monitorNode) {
      html += `<tr class="node-expand-row"><td colspan="7"><div class="node-expand-panel" id="expand-panel-${safeAttr(node.id)}"></div></td></tr>`;
    }
  }

  html += `</tbody></table>`;
  wrap.innerHTML = html;

  // 填充展开面板
  if (selectedNodeId) {
    const panel = $(`#expand-panel-${CSS.escape(selectedNodeId)}`);
    if (panel) {
      const monitorNode = nodesData.find(n => n.id === selectedNodeId);
      if (monitorNode) renderInlineDetail(panel, monitorNode);
    }
  }

  updateBatchToolbar();
  refreshIcons();
}

// --- 内联运维面板（1Panel 风格 Tab Dashboard） ---
let inlineTabState = {};  // per-node: { tab, clawSubTab }

function getNodeTabState(nodeId) {
  if (!inlineTabState[nodeId]) inlineTabState[nodeId] = { tab: 'overview', clawSubTab: 'status' };
  return inlineTabState[nodeId];
}

function renderInlineDetail(panel, node) {
  if (!node.online) {
    panel.innerHTML = `<div class="inline-offline">${L('zap')} 节点不可达 — ${escHtml(node.error || '无上报数据')}
      <button class="confirm-btn" style="margin-left:12px" onclick="provisionNode('${safeAttr(node.id)}')">重新配置</button>
    </div>`;
    refreshIcons();
    return;
  }
  const ts = getNodeTabState(node.id);

  const tabs = [
    { key: 'overview', icon: 'bar-chart-3', label: '概览' },
    { key: 'claw', icon: 'bot', label: 'OpenClaw' },
    { key: 'terminal', icon: 'terminal', label: '终端' },
  ];

  let html = `<div class="inline-ops-dashboard">`;
  // Tab 导航条
  html += `<div class="inline-tabs">`;
  for (const t of tabs) {
    html += `<button class="inline-tab-btn ${ts.tab === t.key ? 'active' : ''}" onclick="switchInlineTab('${safeAttr(node.id)}','${t.key}')">${L(t.icon)} ${t.label}</button>`;
  }
  html += `</div>`;
  // Tab 内容区
  html += `<div class="inline-tab-content" id="inline-tab-content-${safeAttr(node.id)}">`;
  switch (ts.tab) {
    case 'overview': html += renderOverviewTab(node); break;
    case 'claw':     html += `<div class="inline-claw-loading">${L('loader')} 加载中...</div>`; break;
    case 'terminal': html += renderTerminalTab(node); break;
  }
  html += `</div></div>`;
  panel.innerHTML = html;
  refreshIcons();

  // OpenClaw tab 需要异步加载
  if (ts.tab === 'claw') loadInlineClawTab(node.id, ts.clawSubTab);
}

function switchInlineTab(nodeId, tab) {
  const ts = getNodeTabState(nodeId);
  ts.tab = tab;
  // 重新渲染当前节点的面板
  const monitorNode = nodesData.find(n => n.id === nodeId);
  const panel = document.querySelector(`tr[data-detail="${nodeId}"] .inline-panel`);
  if (panel && monitorNode) renderInlineDetail(panel, monitorNode);
}

// --- Tab 1: 概览 ---
function renderOverviewTab(node) {
  const si = node.sysInfo || {};
  const memPct = si.memTotalMB > 0 ? Math.round(si.memUsedMB / si.memTotalMB * 100) : 0;
  const diskPct = si.diskUsePct ? parseInt(si.diskUsePct) : 0;
  const peers = node.nodes || [];
  const totalPeers = peers.length;
  const directP = peers.filter(p => p.status === 'Direct').length;
  const directRate = totalPeers > 0 ? Math.round(directP / totalPeers * 100) : 0;
  const totalIn = peers.reduce((s, n) => s + (n.inBytes || 0), 0);
  const totalOut = peers.reduce((s, n) => s + (n.outBytes || 0), 0);

  // OpenClaw 状态（从 agent 上报获取）
  const oc = node.openclaw || {};
  const clawRunning = oc.running === true;
  const clawColor = clawRunning ? 'green' : 'yellow';
  const clawLabel = clawRunning ? '运行中' : '未运行';

  let html = `<div class="inline-monitor">`;
  // 健康环 + 实时指标
  html += `<div class="inline-hero">`;
  html += renderHealthRing(true, node.sshLatencyMs);
  html += `<div class="inline-realtime">
    <div class="realtime-bar">
      <div class="realtime-item"><span class="ri-label">采集延迟</span><span class="ri-value ${node.sshLatencyMs > 500 ? 'red' : node.sshLatencyMs > 200 ? 'yellow' : 'green'}">${node.sshLatencyMs}ms</span></div>
      <div class="realtime-item"><span class="ri-label">P2P 节点</span><span class="ri-value accent">${totalPeers}</span></div>
      <div class="realtime-item"><span class="ri-label">直连率</span><span class="ri-value ${directRate >= 80 ? 'green' : directRate >= 50 ? 'yellow' : 'red'}">${directRate}%</span></div>
      <div class="realtime-item"><span class="ri-label">运行时长</span><span class="ri-value">${escHtml(si.uptime || '—')}</span></div>
    </div>
  </div>`;
  html += `</div>`;

  // 指标卡片
  html += `<div class="metric-grid">`;
  html += renderMetricCard(L('cpu'), 'CPU', si.cpuCores ? `${si.cpuUsage ?? 0}%` : '—', pctColor(si.cpuUsage || 0),
    si.cpuCores ? `${si.cpuCores} 核 · ${escHtml(si.loadAvg || '—')}` : '');
  html += renderMetricCard(L('memory-stick'), '内存', memPct > 0 ? `${memPct}%` : '—', pctColor(memPct),
    si.memTotalMB > 0 ? `${si.memUsedMB} / ${si.memTotalMB} MB` : '');
  html += renderMetricCard(L('hard-drive'), '磁盘', diskPct > 0 ? `${diskPct}%` : '—', pctColor(diskPct),
    si.diskTotal ? `${escHtml(si.diskUsed)} / ${escHtml(si.diskTotal)}` : '');
  html += renderMetricCard(L('bot'), 'OpenClaw', clawLabel, clawColor,
    clawRunning ? `PID ${oc.pid || '—'}` : '');
  html += renderMetricCard(L('link'), 'P2P', `${directP}/${totalPeers}`, directRate >= 80 ? 'green' : 'yellow',
    `流入 ${formatBytes(totalIn)} · 流出 ${formatBytes(totalOut)}`);
  html += renderMetricCard(L('monitor'), '系统', escHtml(si.hostname || '—'), 'accent',
    `${escHtml(si.os || '—')} · ${escHtml(si.kernel || '—')}`);
  html += `</div>`;

  // GNB 节点表
  if (peers.length) {
    html += `<div class="monitor-section-title">GNB 节点 (${peers.length})</div>`;
    html += `<table class="sub-node-table"><thead><tr><th>UUID</th><th>TUN</th><th>状态</th><th>延迟</th><th>流入</th><th>流出</th></tr></thead><tbody>`;
    for (const sn of peers) {
      const sc = sn.status === 'Direct' ? 'green' : sn.status === 'Detecting' ? 'yellow' : 'red';
      html += `<tr><td>${escHtml(sn.uuid64||'—')}</td><td>${escHtml(sn.tunAddr4||'—')}</td><td class="${sc}">${escHtml(sn.status||'—')}</td><td>${sn.latency4Usec ? `${(sn.latency4Usec/1000).toFixed(1)}ms` : '—'}</td><td>${formatBytes(sn.inBytes||0)}</td><td>${formatBytes(sn.outBytes||0)}</td></tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `</div>`;
  return html;
}

// --- Tab 2: OpenClaw (子 Tab) ---
async function loadInlineClawTab(nodeId, subTab) {
  const container = document.getElementById(`inline-tab-content-${nodeId}`);
  if (!container) return;

  const subTabs = [
    { key: 'status', icon: 'activity', label: '状态' },
    { key: 'models', icon: 'cpu', label: '模型' },
    { key: 'config', icon: 'settings', label: '配置' },
    { key: 'sessions', icon: 'message-square', label: '会话' },
    { key: 'channels', icon: 'radio', label: '渠道' },
  ];

  let html = `<div class="inline-claw-subtabs">`;
  for (const st of subTabs) {
    html += `<button class="claw-subtab-btn ${subTab === st.key ? 'active' : ''}" onclick="switchClawSubTab('${safeAttr(nodeId)}','${st.key}')">${L(st.icon)} ${st.label}</button>`;
  }
  html += `</div><div class="inline-claw-content" id="claw-content-${safeAttr(nodeId)}">${L('loader')} 加载中...</div>`;
  container.innerHTML = html;
  refreshIcons();

  // 检查 clawToken
  const nodeConfig = allNodesRaw.find(n => n.id === nodeId);
  if (!nodeConfig?.clawToken) {
    const detail = document.getElementById(`claw-content-${nodeId}`);
    if (detail) {
      // 尝试从 agent 上报的 openclaw 数据展示
      const monNode = nodesData.find(n => n.id === nodeId);
      const oc = monNode?.openclaw;
      if (oc && oc.running && oc.config) {
        renderAgentClawInfo(detail, oc, subTab);
      } else {
        detail.innerHTML = `<div class="claw-empty">${L('info')} 未配置 OpenClaw Token — 无法通过 RPC 查询。<br>请先通过终端执行「安装 openclaw」或手动配置 Token。</div>`;
      }
    }
    refreshIcons();
    return;
  }

  // 有 token，走 RPC 代理
  const detail = document.getElementById(`claw-content-${nodeId}`);
  try {
    const res = await authFetch(`/api/claw/${encodeURIComponent(nodeId)}/${subTab}`);
    const data = await res.json();
    if (data.error) {
      detail.innerHTML = `<div class="claw-error">${L('alert-circle')} ${escHtml(data.error)}</div>`;
      refreshIcons();
      return;
    }
    switch (subTab) {
      case 'status':   renderClawStatus(detail, data); break;
      case 'models':   renderClawModels(detail, data); break;
      case 'config':   renderClawConfig(detail, data); break;
      case 'sessions': renderClawSessions(detail, data); break;
      case 'channels': renderClawChannels(detail, data); break;
    }
  } catch (err) {
    detail.innerHTML = `<div class="claw-error">${L('alert-circle')} 请求失败: ${escHtml(err.message)}</div>`;
    refreshIcons();
  }
}

function renderAgentClawInfo(detail, oc, subTab) {
  const cfg = oc.config || {};
  if (subTab === 'status') {
    let html = `<div class="claw-status-grid">`;
    html += renderMetricCard(L('bot'), '状态', oc.running ? '运行中' : '停止', oc.running ? 'green' : 'red', `PID ${oc.pid || '—'}`);
    html += renderMetricCard(L('file-code'), '配置', oc.configPath || '—', 'accent', cfg.meta?.lastTouchedVersion || '—');
    const modelKey = cfg.agents?.defaults?.model?.primary || '—';
    html += renderMetricCard(L('cpu'), '默认模型', modelKey, 'accent', '');
    html += `</div>`;
    detail.innerHTML = html;
  } else if (subTab === 'config') {
    detail.innerHTML = `<div class="claw-config"><pre class="claw-config-view">${escHtml(JSON.stringify(cfg, null, 2))}</pre></div>`;
  } else {
    detail.innerHTML = `<div class="claw-empty">${L('info')} 需要配置 clawToken 才能查看此标签页数据</div>`;
  }
  refreshIcons();
}

function switchClawSubTab(nodeId, subTab) {
  const ts = getNodeTabState(nodeId);
  ts.clawSubTab = subTab;
  loadInlineClawTab(nodeId, subTab);
}

// --- Tab 3: 终端 ---
let terminalLogs = {};  // per-node command history

function renderTerminalTab(node) {
  const logs = terminalLogs[node.id] || [];
  let html = `<div class="inline-terminal">`;
  html += `<div class="terminal-output" id="terminal-output-${safeAttr(node.id)}">`;
  if (logs.length === 0) {
    html += `<div class="terminal-welcome">输入运维指令，如：状态、重启 gnb、安装 openclaw、日志</div>`;
  } else {
    for (const log of logs) {
      html += `<div class="terminal-line ${log.role}">${log.role === 'user' ? '❯ ' : ''}${escHtml(log.text)}</div>`;
    }
  }
  html += `</div>`;
  html += `<div class="terminal-input-row">
    <input type="text" class="terminal-input" id="terminal-input-${safeAttr(node.id)}" placeholder="输入运维指令..." autocomplete="off" onkeydown="if(event.key==='Enter')execTerminalCmd('${safeAttr(node.id)}')">
    <button class="terminal-send" onclick="execTerminalCmd('${safeAttr(node.id)}')">${L('send')} 执行</button>
  </div>`;
  html += `</div>`;
  return html;
}

async function execTerminalCmd(nodeId) {
  const input = document.getElementById(`terminal-input-${nodeId}`);
  const output = document.getElementById(`terminal-output-${nodeId}`);
  if (!input || !input.value.trim()) return;
  const cmd = input.value.trim();
  input.value = '';

  if (!terminalLogs[nodeId]) terminalLogs[nodeId] = [];
  terminalLogs[nodeId].push({ role: 'user', text: cmd });
  output.innerHTML += `<div class="terminal-line user">❯ ${escHtml(cmd)}</div>`;
  output.innerHTML += `<div class="terminal-line system" id="terminal-pending-${nodeId}">⏳ 执行中...</div>`;
  output.scrollTop = output.scrollHeight;

  try {
    const fullCmd = cmd.includes(nodeId) ? cmd : `${cmd} ${nodeId}`;
    const res = await authFetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: fullCmd, nodeId }),
    });
    const data = await res.json();
    const response = data.response || '(无响应)';
    terminalLogs[nodeId].push({ role: 'assistant', text: response });
    const pending = document.getElementById(`terminal-pending-${nodeId}`);
    if (pending) pending.remove();
    output.innerHTML += `<div class="terminal-line assistant">${escHtml(response)}</div>`;
  } catch (e) {
    terminalLogs[nodeId].push({ role: 'error', text: `错误: ${e.message}` });
    const pending = document.getElementById(`terminal-pending-${nodeId}`);
    if (pending) pending.remove();
    output.innerHTML += `<div class="terminal-line error">❌ ${escHtml(e.message)}</div>`;
  }
  output.scrollTop = output.scrollHeight;
}

/** 内联 AI 指令（兼容旧调用） */
async function inlineAiCmd(nodeId, cmd) {
  // 切换到终端 tab 并执行
  const ts = getNodeTabState(nodeId);
  ts.tab = 'terminal';
  if (!terminalLogs[nodeId]) terminalLogs[nodeId] = [];
  terminalLogs[nodeId].push({ role: 'user', text: `${cmd} ${nodeId}` });

  const monitorNode = nodesData.find(n => n.id === nodeId);
  const panel = document.querySelector(`tr[data-detail="${nodeId}"] .inline-panel`);
  if (panel && monitorNode) renderInlineDetail(panel, monitorNode);

  // 延迟执行命令
  setTimeout(() => execTerminalCmd(nodeId), 100);
}

// --- 分页 ---
function renderPagination() {
  const pg = $('#nodes-pagination');
  if (!pg) return;
  const all = getFilteredNodesList();
  const total = all.length;
  const { page, pageSize } = nodePagination;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  if (totalPages <= 1) { pg.innerHTML = ''; return; }

  let html = `<div class="pg-info">第 ${page}/${totalPages} 页 · 共 ${total} 条</div><div class="pg-btns">`;
  html += `<button class="pg-btn" ${page <= 1 ? 'disabled' : ''} onclick="goPage(${page - 1})">${L('chevron-left')}</button>`;
  const maxVisible = 7;
  let startP = Math.max(1, page - Math.floor(maxVisible / 2));
  let endP = Math.min(totalPages, startP + maxVisible - 1);
  if (endP - startP < maxVisible - 1) startP = Math.max(1, endP - maxVisible + 1);
  for (let p = startP; p <= endP; p++) {
    html += `<button class="pg-btn ${p === page ? 'active' : ''}" onclick="goPage(${p})">${p}</button>`;
  }
  html += `<button class="pg-btn" ${page >= totalPages ? 'disabled' : ''} onclick="goPage(${page + 1})">${L('chevron-right')}</button>`;
  html += `</div>`;
  pg.innerHTML = html;
  refreshIcons();
}

// --- 批量操作工具栏 ---
function updateBatchToolbar() {
  const bar = $('#batch-toolbar');
  if (!bar) return;
  if (selectedIds.size === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = `
    <span class="batch-count">已选 ${selectedIds.size} 个节点</span>
    <button class="batch-btn approve" onclick="batchAction('approve')">${L('check')} 批量审批</button>
    <button class="batch-btn reject" onclick="batchAction('reject')">${L('x')} 批量拒绝</button>
    <button class="batch-btn danger" onclick="batchAction('remove')">${L('trash-2')} 批量删除</button>
    <button class="batch-btn move" onclick="showBatchMoveModal()">${L('folder-input')} 移动分组</button>
    <button class="batch-btn cancel" onclick="clearSelection()">取消</button>
  `;
  refreshIcons();
}

// --- 交互函数 ---
function filterByGroup(groupId) {
  nodeFilter.groupId = groupId;
  nodePagination.page = 1;
  selectedIds.clear();
  renderGroupSidebar();
  renderNodesTable();
  renderPagination();
}

function onNodeSearch(value) {
  nodeFilter.keyword = value;
  nodePagination.page = 1;
  renderNodesTable();
  renderPagination();
}

function onCidrFilter(value) {
  if (value && !isValidCidr(value)) {
    alert('无效的 CIDR 格式，例: 10.1.0.0/24');
    return;
  }
  nodeFilter.subnet = value;
  nodePagination.page = 1;
  renderNodesTable();
  renderPagination();
}

function onStatusFilter(value) {
  nodeFilter.status = value;
  nodePagination.page = 1;
  renderNodesTable();
  renderPagination();
}

function goPage(p) {
  nodePagination.page = p;
  selectedIds.clear();
  renderNodesTable();
  renderPagination();
}

function toggleSelectAll(checked) {
  const all = getFilteredNodesList();
  const { page, pageSize } = nodePagination;
  const start = (page - 1) * pageSize;
  const pageNodes = all.slice(start, start + pageSize);
  for (const n of pageNodes) {
    if (checked) selectedIds.add(n.id); else selectedIds.delete(n.id);
  }
  renderNodesTable();
}

function toggleSelectNode(nodeId, checked) {
  if (checked) selectedIds.add(nodeId); else selectedIds.delete(nodeId);
  updateBatchToolbar();
  // 更新全选 checkbox
  const thCheck = $('.nodes-data-table thead input[type=checkbox]');
  if (thCheck) {
    const all = getFilteredNodesList();
    const { page, pageSize } = nodePagination;
    const start = (page - 1) * pageSize;
    const pageNodes = all.slice(start, start + pageSize);
    thCheck.checked = pageNodes.length > 0 && pageNodes.every(n => selectedIds.has(n.id));
  }
}

function clearSelection() {
  selectedIds.clear();
  renderNodesTable();
}

function expandNodeRow(nodeId) {
  selectedNodeId = selectedNodeId === nodeId ? null : nodeId;
  renderNodesTable();
}

// --- 批量操作 ---
async function batchAction(action) {
  const ids = [...selectedIds];
  const labels = { approve: '审批', reject: '拒绝', remove: '删除' };
  if (!confirm(`确认${labels[action]} ${ids.length} 个节点？`)) return;
  try {
    const res = await authFetch('/api/enroll/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ids }),
    });
    const data = await res.json();
    const msg = `${labels[action]}完成: ${data.succeeded?.length || 0} 成功, ${data.failed?.length || 0} 失败`;
    alert(msg);
    // @alpha: 立即刷新前端节点列表
    const succeeded = new Set(data.succeeded || []);
    if (action === 'remove') {
      allNodesRaw = allNodesRaw.filter(n => !succeeded.has(n.id));
      pendingNodes = pendingNodes.filter(n => !succeeded.has(n.id));
    } else {
      allNodesRaw.forEach(n => { if (succeeded.has(n.id)) n.status = action === 'approve' ? 'approved' : 'rejected'; });
    }
    selectedIds.clear();
    renderGroupSidebar();
    renderNodesTable();
    renderPagination();
  } catch (e) { alert(`操作失败: ${e.message}`); }
}

// --- 分组弹窗 ---
function showGroupModal() {
  const overlay = $('#modal-overlay');
  const content = $('#modal-content');
  overlay.style.display = 'flex';
  content.innerHTML = `
    <div class="modal-header">新建分组</div>
    <div class="modal-body">
      <label>分组名称</label>
      <input type="text" id="group-name-input" placeholder="输入分组名称..." autofocus>
      <label>颜色</label>
      <div class="color-picker" id="color-picker">
        ${['#388bfd','#3fb950','#f85149','#d29922','#a371f7','#f778ba','#79c0ff','#56d4dd'].map(c => `<span class="color-opt ${c === '#388bfd' ? 'active' : ''}" style="background:${c}" onclick="pickColor(this,'${c}')"></span>`).join('')}
      </div>
    </div>
    <div class="modal-footer">
      <button class="modal-btn cancel" onclick="closeModal()">取消</button>
      <button class="modal-btn primary" onclick="createGroupUI()">创建</button>
    </div>
  `;
}

let pickedColor = '#388bfd';
function pickColor(el, color) {
  pickedColor = color;
  $$('.color-opt').forEach(e => e.classList.remove('active'));
  el.classList.add('active');
}

async function createGroupUI() {
  const name = $('#group-name-input')?.value?.trim();
  if (!name) { alert('名称不能为空'); return; }
  try {
    const res = await authFetch('/api/nodes/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color: pickedColor }),
    });
    if (res.status === 409) { alert('同名分组已存在'); return; }
    if (!res.ok) { alert('创建失败'); return; }
    closeModal();
    // 强制刷新分组列表
    await refreshGroups();
    renderGroupSidebar();
  } catch (e) { alert(`创建失败: ${e.message}`); }
}

async function deleteGroupUI(groupId) {
  if (!confirm('确认删除此分组？节点将回归未分组')) return;
  try {
    await authFetch(`/api/nodes/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
    if (nodeFilter.groupId === groupId) nodeFilter.groupId = null;
    await refreshGroups();
    renderGroupSidebar();
    renderNodesTable();
  } catch (e) { alert(`删除失败: ${e.message}`); }
}

function showMoveGroupModal(nodeId) {
  const overlay = $('#modal-overlay');
  const content = $('#modal-content');
  overlay.style.display = 'flex';
  let html = `<div class="modal-header">移动到分组</div><div class="modal-body"><ul class="move-group-list">`;
  html += `<li class="move-group-item" onclick="moveToGroup('${safeAttr(nodeId)}', null)">取消分组</li>`;
  for (const g of nodeGroups) {
    html += `<li class="move-group-item" onclick="moveToGroup('${safeAttr(nodeId)}', '${safeAttr(g.id)}')">
      <span class="group-color-dot" style="background:${escHtml(g.color)}"></span>${escHtml(g.name)}
    </li>`;
  }
  html += `</ul></div><div class="modal-footer"><button class="modal-btn cancel" onclick="closeModal()">取消</button></div>`;
  content.innerHTML = html;
}

function showBatchMoveModal() {
  const ids = [...selectedIds];
  const overlay = $('#modal-overlay');
  const content = $('#modal-content');
  overlay.style.display = 'flex';
  let html = `<div class="modal-header">批量移动到分组 (${ids.length} 个节点)</div><div class="modal-body"><ul class="move-group-list">`;
  html += `<li class="move-group-item" onclick="batchMoveToGroup(null)">取消分组</li>`;
  for (const g of nodeGroups) {
    html += `<li class="move-group-item" onclick="batchMoveToGroup('${safeAttr(g.id)}')">
      <span class="group-color-dot" style="background:${escHtml(g.color)}"></span>${escHtml(g.name)}
    </li>`;
  }
  html += `</ul></div><div class="modal-footer"><button class="modal-btn cancel" onclick="closeModal()">取消</button></div>`;
  content.innerHTML = html;
}

async function moveToGroup(nodeId, groupId) {
  try {
    await authFetch(`/api/enroll/${encodeURIComponent(nodeId)}/group`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    });
    closeModal();
  } catch (e) { alert(`移动失败: ${e.message}`); }
}

async function batchMoveToGroup(groupId) {
  const ids = [...selectedIds];
  try {
    for (const id of ids) {
      await authFetch(`/api/enroll/${encodeURIComponent(id)}/group`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId }),
      });
    }
    closeModal();
    selectedIds.clear();
  } catch (e) { alert(`批量移动失败: ${e.message}`); }
}

function closeModal() {
  const overlay = $('#modal-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function refreshGroups() {
  try {
    const res = await authFetch('/api/nodes/groups');
    const data = await res.json();
    nodeGroups = data.groups || [];
  } catch (_) {}
}

// --- CIDR 工具 ---
function cidrMatch(ip, cidr) {
  const [range, bits] = cidr.split('/');
  if (!range || !bits) return false;
  const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function isValidCidr(cidr) {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/.test(cidr);
}

function selectNode(nodeId) {
  selectedNodeId = nodeId;
  if (currentPage === 'nodes') {
    renderNodesTable();
  }
}

// ═══════════════════════════════════════
// 节点详情（仪表盘风格）
// ═══════════════════════════════════════

function renderHealthRing(online, latencyMs) {
  const r = 32, c = 2 * Math.PI * r;
  const pct = online ? 1 : 0.2;
  const offset = c * (1 - pct);
  const cls = online ? 'online' : 'offline';
  const statusText = online ? '在线' : '离线';
  const subText = online ? (latencyMs > 0 ? `${latencyMs}ms` : '—') : '不可达';
  return `
    <div class="health-ring-box">
      <div class="health-ring-container">
        <svg class="health-ring-svg" viewBox="0 0 80 80">
          <circle class="health-ring-bg" cx="40" cy="40" r="${r}"/>
          <circle class="health-ring-fg ${cls}" cx="40" cy="40" r="${r}"
            stroke-dasharray="${c}" stroke-dashoffset="${offset}"/>
        </svg>
        <div class="health-ring-label">
          <div class="health-ring-status ${cls}">${statusText}</div>
          <div class="health-ring-sub">${subText}</div>
        </div>
      </div>
      <div class="health-meta"><span class="dot ${cls}"></span> 健康状况</div>
    </div>
  `;
}

function renderMetricCard(icon, title, value, color, detail, badge) {
  const badgeHtml = badge ? `<span class="mc-badge ${badge.color}">${escHtml(badge.text)}</span>` : '';
  return `
    <div class="metric-card">
      <div class="mc-header">
        <span class="mc-title"><span class="mc-icon">${icon}</span> ${escHtml(title)}</span>
        ${badgeHtml}
      </div>
      <div class="mc-value ${color}">${value}</div>
      <div class="mc-detail">${detail || ''}</div>
    </div>
  `;
}

function renderSysCard(icon, title, value, color, sub, barPct) {
  let barHtml = '';
  if (barPct !== undefined) {
    const barColor = barPct > 90 ? 'red' : barPct > 70 ? 'yellow' : 'green';
    barHtml = `<div class="sys-bar"><div class="sys-bar-fill ${barColor}" style="width:${barPct}%"></div></div>`;
  }
  return `
    <div class="sys-card">
      <div class="sys-header"><span class="sys-title">${icon} ${escHtml(title)}</span></div>
      <div class="sys-value ${color}">${value}</div>
      <div class="sys-sub">${sub}</div>
      ${barHtml}
    </div>
  `;
}

function pctColor(pct) { return pct > 90 ? 'red' : pct > 70 ? 'yellow' : 'green'; }



// ═══════════════════════════════════════
// OpenClaw 状态
// ═══════════════════════════════════════

async function fetchClawStatus(nodeId) {
  // 查询结果通过 AI 面板输出
  appendAiMsg('user', `查询 OpenClaw 状态: ${nodeId}`);
  try {
    const res = await authFetch(`/api/claw/${encodeURIComponent(nodeId)}/status`);
    const data = await res.json();
    if (data.runtimeVersion) {
      const info = [
        `v${data.runtimeVersion}`,
        data.heartbeat?.defaultAgentId ? `Agent: ${data.heartbeat.defaultAgentId}` : '',
        data.sessions?.count !== undefined ? `会话: ${data.sessions.count}` : '',
      ].filter(Boolean).join(' · ');
      appendAiMsg('assistant', `OpenClaw 状态: ${info}`);
    } else if (data.raw) {
      appendAiMsg('assistant', `OpenClaw: ${data.raw.substring(0, 120)}`);
    } else if (data.error) {
      appendAiMsg('assistant', `OpenClaw 错误: ${data.error.substring(0, 120)}`);
    } else {
      appendAiMsg('assistant', 'OpenClaw: 无数据返回');
    }
  } catch (e) {
    appendAiMsg('assistant', `OpenClaw 查询失败: ${e.message}`);
  }
}

// ═══════════════════════════════════════
// 审批操作
// ═══════════════════════════════════════

async function approveNode(nodeId) {
  // @alpha: 按钮即时反馈
  event?.target?.closest('button')?.setAttribute('disabled', '');
  try {
    const res = await authFetch(`/api/enroll/${encodeURIComponent(nodeId)}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.success) {
      // 即时更新前端数据
      const node = allNodesRaw.find(n => n.id === nodeId);
      if (node) {
        node.status = 'approved';
        node.tunAddr = data.tunAddr || node.tunAddr;
      }
      pendingNodes = pendingNodes.filter(n => n.id !== nodeId);
      renderGroupSidebar();
      renderNodesTable();
      renderPagination();
      showToast(`✅ 节点 ${nodeId} 已审批通过`);
    } else {
      showToast(`❌ 审批失败: ${data.message || '未知错误'}`, 'error');
    }
  } catch (e) {
    showToast(`❌ 审批失败: ${e.message}`, 'error');
  }
}

async function rejectNode(nodeId) {
  event?.target?.closest('button')?.setAttribute('disabled', '');
  try {
    const res = await authFetch(`/api/enroll/${encodeURIComponent(nodeId)}/reject`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      allNodesRaw = allNodesRaw.filter(n => n.id !== nodeId);
      pendingNodes = pendingNodes.filter(n => n.id !== nodeId);
      renderGroupSidebar();
      renderNodesTable();
      renderPagination();
      showToast(`节点 ${nodeId} 已拒绝并删除`);
    } else {
      showToast(`❌ 拒绝失败: ${data.message}`, 'error');
    }
  } catch (e) {
    showToast(`❌ 拒绝失败: ${e.message}`, 'error');
  }
}

async function provisionNode(nodeId) {
  appendAiMsg('user', `开始配置下发: ${escHtml(nodeId)}`);
  try {
    const res = await authFetch(`/api/provision/${encodeURIComponent(nodeId)}`, { method: 'POST' });
    const data = await res.json();
    appendAiMsg('assistant', data.message || '配置下发已启动，日志将实时推送');
  } catch (e) {
    appendAiMsg('assistant', `配置下发失败: ${e.message}`);
  }
}

// ═══════════════════════════════════════
// AI 对话
// ═══════════════════════════════════════

async function sendAiMessage() {
  const input = $('#ai-input');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  appendAiMsg('user', message);

  try {
    const res = await authFetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    let html = escHtml(data.response || '无响应');
    if (data.requireConfirm && data.commands?.length) {
      html += `<pre>${JSON.stringify(data.commands, null, 2)}</pre>`;
      html += `<button class="confirm-btn" onclick="confirmAiCmd('${data.confirmId}')">确认执行</button>`;
    }
    appendAiMsg('assistant', html, true);
  } catch (err) {
    appendAiMsg('assistant', `请求失败: ${err.message}`);
  }
}

async function confirmAiCmd(confirmId) {
  appendAiMsg('user', '✅ 确认执行');
  try {
    const res = await authFetch('/api/ai/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmId }) });
    const data = await res.json();
    appendAiMsg('assistant', `<pre>${JSON.stringify(data.results, null, 2)}</pre>`, true);
  } catch (err) {
    appendAiMsg('assistant', `执行失败: ${err.message}`);
  }
}

function appendAiMsg(role, content, isHtml = false, skipScroll = false) {
  const container = $('#ai-messages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;
  if (isHtml) { div.innerHTML = content; } else { div.textContent = content; }
  container.appendChild(div);
  if (!skipScroll) container.scrollTop = container.scrollHeight;
}

function loadNodeOpsLog(nodeId) {
  const container = $('#ai-messages');
  if (!container) return;
  container.innerHTML = '';
  const logs = opsLogsCache[nodeId] || [];
  for (const m of logs) appendAiMsg(m.role, m.content, false, true);
  container.scrollTop = container.scrollHeight;
}

// ═══════════════════════════════════════
// WebSocket
// ═══════════════════════════════════════

let wsRetryDelay = 1000;
const WS_MAX_RETRY_DELAY = 30000;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getToken();
  ws = new WebSocket(`${proto}//${location.host}/ws${token ? '?token=' + encodeURIComponent(token) : ''}`);

  ws.onopen = () => {
    wsRetryDelay = 1000; // 重连成功，重置退避
    $('#connection-status').className = 'status-badge online';
    $('#connection-status').textContent = '已连接';
    // @alpha: 发送首条消息认证（JWT token）
    const authToken = getToken();
    if (authToken) {
      ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    }
  };

  ws.onclose = () => {
    $('#connection-status').className = 'status-badge offline';
    $('#connection-status').textContent = '断开';
    setTimeout(connectWS, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 1.5, WS_MAX_RETRY_DELAY); // 指数退避
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'snapshot' || msg.type === 'update') {
        nodesData = msg.data || [];
        pendingNodes = msg.pending || [];
        nodeGroups = msg.groups || nodeGroups;
        allNodesRaw = msg.allNodes || allNodesRaw;
        $('#last-update').textContent = new Date(msg.timestamp).toLocaleTimeString();
        // 更新待审批 badge
        const hCount = $('#pending-count');
        const hBadge = $('#pending-badge');
        if (hCount) hCount.textContent = pendingNodes.length;
        if (hBadge) hBadge.style.display = pendingNodes.length > 0 ? '' : 'none';

        // 刷新当前页面
        if (currentPage === 'dashboard') renderDashboardPage($('#main-content'));
        if (currentPage === 'nodes') {
          renderGroupSidebar();
          renderNodesTable();
          renderPagination();
        }
      }
      if (msg.type === 'chat_history') {
        opsLogsCache = msg.logs || {};
      }
      if (msg.type === 'provision_log') {
        appendAiMsg('assistant', `[${msg.nodeId}] ${msg.message}`);
      }
    } catch (_) {}
  };
}

// ═══════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════

function escHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

function formatBytes(b) {
  if (!b) return '0B';
  if (b >= 1073741824) return `${(b/1073741824).toFixed(1)}G`;
  if (b >= 1048576) return `${(b/1048576).toFixed(1)}M`;
  if (b >= 1024) return `${(b/1024).toFixed(1)}K`;
  return `${b}B`;
}

// ═══════════════════════════════════════
// 初始化
// ═══════════════════════════════════════

// 导航事件
$$('.nav-item').forEach(item => {
  item.addEventListener('click', () => switchPage(item.dataset.page));
});

// 侧边栏折叠
$('#sidebar-toggle').addEventListener('click', () => {
  const sidebar = $('#sidebar');
  // 移动端：切换展开
  if (window.innerWidth <= 768) {
    sidebar.classList.toggle('mobile-open');
  } else {
    sidebar.classList.toggle('collapsed');
  }
});

// ═══════════════════════════════════════
// 用户菜单
// ═══════════════════════════════════════

function toggleUserMenu() {
  const menu = $('#user-menu');
  if (menu) {
    menu.classList.toggle('open');
    if (menu.classList.contains('open')) refreshIcons();
  }
}

function closeUserMenu() {
  const menu = $('#user-menu');
  if (menu) menu.classList.remove('open');
}

function logout() {
  closeUserMenu();
  localStorage.removeItem('gnb_admin_token');
  location.reload();
}

function showApiKey() {
  closeUserMenu();
  // @beta: 获取短 apiToken
  authFetch('/api/auth/token')
    .then(r => r.json())
    .then(data => {
      const apiToken = data.apiToken || _cachedApiToken || '';
      const overlay = $('#modal-overlay');
      const content = $('#modal-content');
      if (overlay && content) {
        overlay.style.display = 'flex';
        content.innerHTML = `
          <div class="modal-header">API Token（节点初始化用）</div>
          <div class="modal-body">
            <label>API Token（永久有效）</label>
            <div style="display:flex;align-items:center;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;cursor:pointer;transition:border-color .2s" onclick="navigator.clipboard.writeText('${escHtml(apiToken)}').then(()=>{const b=this.querySelector('.copy-icon');b.innerHTML='✓';b.style.color='#4caf50';setTimeout(()=>{b.innerHTML='<svg width=\\'14\\' height=\\'14\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\'><rect x=\\'9\\' y=\\'9\\' width=\\'13\\' height=\\'13\\' rx=\\'2\\'/><path d=\\'M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1\\'/></svg>';b.style.color=''},1500)})" onmouseenter="this.style.borderColor='var(--accent)'" onmouseleave="this.style.borderColor='var(--border)'">
              <code style="flex:1;display:block;font-size:14px;padding:10px 12px;font-family:var(--font-mono);letter-spacing:1px;color:var(--text-primary)">${escHtml(apiToken)}</code>
              <span class="copy-icon" style="padding:0 12px;color:var(--text-muted);flex-shrink:0;display:flex;align-items:center"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></span>
            </div>
            <div style="margin-top:12px">
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">节点初始化命令:</div>
              <div id="init-cmd-wrap" style="display:flex;align-items:center;gap:0;background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;padding:0;cursor:pointer;transition:border-color .2s" onclick="navigator.clipboard.writeText(this.querySelector('code').textContent.trim()).then(()=>{const b=this.querySelector('.copy-icon');b.innerHTML='✓';b.style.color='#4caf50';setTimeout(()=>{b.innerHTML='<svg width=\\'14\\' height=\\'14\\' viewBox=\\'0 0 24 24\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\'><rect x=\\'9\\' y=\\'9\\' width=\\'13\\' height=\\'13\\' rx=\\'2\\'/><path d=\\'M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1\\'/></svg>';b.style.color=''},1500)})" onmouseenter="this.style.borderColor='var(--accent)'" onmouseleave="this.style.borderColor='var(--border)'">
                <code style="flex:1;display:block;font-size:12px;padding:10px 12px;word-break:break-all;color:var(--text-primary);line-height:1.5">curl -sSL https://${location.host}/api/enroll/init.sh | TOKEN=${escHtml(apiToken)} bash</code>
                <span class="copy-icon" style="padding:0 12px;color:var(--text-muted);flex-shrink:0;display:flex;align-items:center"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></span>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="modal-btn cancel" onclick="closeModal()">关闭</button>
          </div>
        `;
      }
    })
    .catch(() => {});
}

function copyApiKey() {
  const input = $('#api-key-display');
  if (input && navigator.clipboard) {
    navigator.clipboard.writeText(input.value).then(() => {
      const btn = document.querySelector('#modal-content .toolbar-btn');
      if (btn) { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1500); }
    });
  }
}

// ═══════════════════════════════════════
// @beta: 用户管理页面
// ═══════════════════════════════════════

async function renderUsersPage(container) {
  container.innerHTML = `
    <div class="page-users">
      <div class="users-header">
        <h3>用户管理</h3>
        <button class="toolbar-btn primary" onclick="showCreateUserModal()">${L('user-plus')} 创建用户</button>
      </div>
      <div id="users-table-wrap">加载中...</div>
    </div>
  `;
  refreshIcons();
  await loadUsersTable();
}

async function loadUsersTable() {
  const wrap = $('#users-table-wrap');
  if (!wrap) return;
  try {
    const res = await authFetch('/api/auth/users');
    const users = await res.json();
    let html = `<table class="nodes-data-table">
      <thead><tr>
        <th>用户名</th>
        <th>角色</th>
        <th>创建时间</th>
        <th>操作</th>
      </tr></thead><tbody>`;
    for (const u of users) {
      const created = u.createdAt ? new Date(u.createdAt).toLocaleString() : '—';
      html += `<tr>
        <td><strong>${escHtml(u.username)}</strong></td>
        <td><span class="badge accent">${escHtml(u.role)}</span></td>
        <td>${created}</td>
        <td>
          <button class="btn-icon" onclick="deleteUserUI('${safeAttr(u.id)}', '${safeAttr(u.username)}')" title="删除">${L('trash-2')}</button>
        </td>
      </tr>`;
    }
    html += `</tbody></table>`;
    wrap.innerHTML = html;
    refreshIcons();
  } catch (e) {
    wrap.innerHTML = `<div class="table-empty">加载失败: ${escHtml(e.message)}</div>`;
  }
}

function showCreateUserModal() {
  const overlay = $('#modal-overlay');
  const content = $('#modal-content');
  overlay.style.display = 'flex';
  content.innerHTML = `
    <div class="modal-header">创建用户</div>
    <div class="modal-body">
      <label>用户名</label>
      <input type="text" id="new-username" placeholder="输入用户名" autofocus>
      <label>密码（至少 8 位）</label>
      <input type="password" id="new-password" placeholder="输入密码">
      <div id="create-user-error" style="color:var(--red);font-size:12px;margin-top:4px;display:none"></div>
    </div>
    <div class="modal-footer">
      <button class="modal-btn cancel" onclick="closeModal()">取消</button>
      <button class="modal-btn primary" onclick="createUserUI()">创建</button>
    </div>
  `;
}

async function createUserUI() {
  const username = $('#new-username')?.value?.trim();
  const password = $('#new-password')?.value;
  const errEl = $('#create-user-error');
  if (!username || !password) return;
  try {
    const res = await authFetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (errEl) { errEl.textContent = data.error || '创建失败'; errEl.style.display = 'block'; }
      return;
    }
    closeModal();
    await loadUsersTable();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
  }
}

async function deleteUserUI(id, username) {
  if (!confirm(`确认删除用户 "${username}"？`)) return;
  try {
    const res = await authFetch(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.status === 400) {
      const data = await res.json();
      alert(data.error || '删除失败');
      return;
    }
    await loadUsersTable();
  } catch (e) { alert(`删除失败: ${e.message}`); }
}

// ═══════════════════════════════════════
// @alpha: 节点编辑弹窗
// ═══════════════════════════════════════

function showEditNodeModal(nodeId) {
  const node = allNodesRaw.find(n => n.id === nodeId);
  if (!node) return;
  const overlay = $('#modal-overlay');
  const content = $('#modal-content');
  if (!overlay || !content) return;
  overlay.style.display = 'flex';
  content.innerHTML = `
    <h3 style="margin:0 0 16px;font-size:16px">编辑节点</h3>
    <form id="edit-node-form" onsubmit="saveNodeEdit(event,'${safeAttr(nodeId)}')">
      <label class="form-label">名称</label>
      <input class="form-input" name="name" value="${escHtml(node.name || '')}" required maxlength="64">
      <label class="form-label" style="margin-top:12px">TUN 地址</label>
      <input class="form-input" name="tunAddr" value="${escHtml(node.tunAddr || '')}" required
        pattern="^((25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.){3}(25[0-5]|2[0-4]\\d|[01]?\\d\\d?)$"
        title="请输入合法的 IPv4 地址">
      <label class="form-label" style="margin-top:12px">SSH 端口</label>
      <input class="form-input" name="sshPort" type="number" value="${node.sshPort || 22}" min="1" max="65535" required>
      <label class="form-label" style="margin-top:12px">SSH 用户名</label>
      <input class="form-input" name="sshUser" value="${escHtml(node.sshUser || 'synon')}" required>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end">
        <button type="button" class="toolbar-btn" onclick="$('#modal-overlay').style.display='none'">取消</button>
        <button type="submit" class="toolbar-btn primary" id="edit-node-save-btn">保存</button>
      </div>
      <div id="edit-node-error" style="color:var(--red);font-size:12px;margin-top:8px;display:none"></div>
    </form>
  `;
}

async function saveNodeEdit(e, nodeId) {
  e.preventDefault();
  const form = $('#edit-node-form');
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const btn = $('#edit-node-save-btn');
  btn.disabled = true; btn.textContent = '保存中…';
  const errEl = $('#edit-node-error');
  errEl.style.display = 'none';

  const body = {
    name: form.name.value.trim(),
    tunAddr: form.tunAddr.value.trim(),
    sshPort: parseInt(form.sshPort.value, 10),
    sshUser: form.sshUser.value.trim(),
  };

  try {
    const res = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      // @alpha: 503 = 远程同步失败（IP 未变更），其他错误照常显示
      const msg = data.hint || data.error || '保存失败';
      errEl.textContent = msg;
      errEl.style.display = 'block';
      btn.disabled = false; btn.textContent = '保存';
      return;
    }
    // 更新本地数据并关闭弹窗
    const node = allNodesRaw.find(n => n.id === nodeId);
    if (node) Object.assign(node, body);
    $('#modal-overlay').style.display = 'none';
    renderNodesTable();
    renderPagination();
    refreshIcons();
  } catch (err) {
    errEl.textContent = '网络错误: ' + err.message;
    errEl.style.display = 'block';
    btn.disabled = false; btn.textContent = '保存';
  }
}

// 点击外部关闭用户菜单
document.addEventListener('click', (e) => {
  const menu = $('#user-menu');
  if (menu && !menu.contains(e.target)) closeUserMenu();
});

// ═══════════════════════════════════════
// @alpha: 主题切换
// ═══════════════════════════════════════

function getTheme() {
  return localStorage.getItem('gnb_theme') || 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : '');
  // 同步按钮 UI
  const icon = $('#theme-icon');
  const label = $('#theme-label');
  if (icon) icon.setAttribute('data-lucide', theme === 'light' ? 'moon' : 'sun');
  if (label) label.textContent = theme === 'light' ? '深色模式' : '亮色模式';
  refreshIcons();
}

function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('gnb_theme', next);
  applyTheme(next);
}

function initTheme() {
  applyTheme(getTheme());
}

// ═══════════════════════════════════════
// @alpha: OpenClaw 管理页面
// ═══════════════════════════════════════

// OpenClaw 渲染器（被内联面板 Tab 2 复用）

function renderClawStatus(detail, data) {
  const version = data.runtimeVersion || data.version || '—';
  const agent = data.heartbeat?.defaultAgentId || data.defaultAgentId || '—';
  const sessions = data.sessions?.count ?? data.sessionCount ?? '—';
  const uptime = data.uptime || '—';
  const status = data.status || (data.runtimeVersion ? 'running' : '—');

  let html = `<div class="claw-status-grid">`;
  html += renderMetricCard(L('bot'), '版本', version, 'accent', '');
  html += renderMetricCard(L('play'), '状态', status, status === 'running' ? 'green' : 'yellow', '');
  html += renderMetricCard(L('user'), '默认 Agent', agent, 'accent', '');
  html += renderMetricCard(L('message-square'), '会话数', String(sessions), 'accent', '');
  html += renderMetricCard(L('clock'), '运行时长', String(uptime), '', '');
  html += `</div>`;

  // 原始数据
  html += `<div class="claw-raw"><details><summary>原始数据</summary><pre>${escHtml(JSON.stringify(data, null, 2))}</pre></details></div>`;
  detail.innerHTML = html;
  refreshIcons();
}

function renderClawModels(detail, data) {
  const models = data.data || data.models || (Array.isArray(data) ? data : []);
  if (models.length === 0) {
    detail.innerHTML = `<div class="claw-empty">${L('inbox')} 暂无模型数据</div>`;
    refreshIcons();
    return;
  }

  let html = `<table class="nodes-data-table"><thead><tr>
    <th>模型 ID</th><th>类型</th><th>拥有者</th>
  </tr></thead><tbody>`;
  for (const m of models) {
    html += `<tr>
      <td><strong>${escHtml(m.id || '—')}</strong></td>
      <td>${escHtml(m.object || m.type || '—')}</td>
      <td>${escHtml(m.owned_by || m.owner || '—')}</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  detail.innerHTML = html;
}

function renderClawConfig(detail, data) {
  const raw = data.raw || data;
  const jsonStr = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);

  detail.innerHTML = `
    <div class="claw-config">
      <div class="claw-config-toolbar">
        <span class="claw-config-label">${L('file-code')} 配置文件</span>
        <button class="toolbar-btn sm" id="claw-config-edit-btn" onclick="toggleClawConfigEdit()">${L('pencil')} 编辑</button>
      </div>
      <pre class="claw-config-view" id="claw-config-view">${escHtml(jsonStr)}</pre>
      <div class="claw-config-editor" id="claw-config-editor" style="display:none">
        <textarea id="claw-config-textarea" rows="20">${escHtml(jsonStr)}</textarea>
        <div class="claw-config-actions">
          <button class="toolbar-btn" onclick="cancelClawConfigEdit()">取消</button>
          <button class="toolbar-btn primary" onclick="saveClawConfig()">保存</button>
        </div>
      </div>
    </div>`;
  refreshIcons();
}

function toggleClawConfigEdit() {
  const view = $('#claw-config-view');
  const editor = $('#claw-config-editor');
  if (!view || !editor) return;
  view.style.display = view.style.display === 'none' ? '' : 'none';
  editor.style.display = editor.style.display === 'none' ? '' : 'none';
}

function cancelClawConfigEdit() {
  const view = $('#claw-config-view');
  const editor = $('#claw-config-editor');
  if (view) view.style.display = '';
  if (editor) editor.style.display = 'none';
}

async function saveClawConfig() {
  if (!selectedNodeId) return;
  const textarea = $('#claw-config-textarea');
  if (!textarea) return;
  const patch = textarea.value;

  try {
    const res = await authFetch(`/api/claw/${encodeURIComponent(selectedNodeId)}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch }),
    });
    const data = await res.json();
    if (data.error) {
      showToast(`配置保存失败: ${data.error}`, 'error');
    } else {
      showToast('配置已保存');
      cancelClawConfigEdit();
      // 重新加载 config sub-tab
      loadInlineClawTab(selectedNodeId, 'config');
    }
  } catch (err) {
    showToast(`保存失败: ${err.message}`, 'error');
  }
}

function renderClawSessions(detail, data) {
  const sessions = data.sessions || data.data || (Array.isArray(data) ? data : []);
  if (!sessions.length && !data.count) {
    detail.innerHTML = `<div class="claw-empty">${L('inbox')} 暂无会话数据</div>`;
    refreshIcons();
    return;
  }

  if (typeof data.count !== 'undefined' && !sessions.length) {
    detail.innerHTML = `<div class="claw-status-grid">${renderMetricCard(L('message-square'), '活跃会话', String(data.count), 'accent', '')}</div>
      <div class="claw-raw"><details><summary>原始数据</summary><pre>${escHtml(JSON.stringify(data, null, 2))}</pre></details></div>`;
    refreshIcons();
    return;
  }

  let html = `<table class="nodes-data-table"><thead><tr>
    <th>会话 Key</th><th>创建时间</th><th>消息数</th>
  </tr></thead><tbody>`;
  for (const s of sessions) {
    html += `<tr>
      <td><code>${escHtml(s.key || s.sessionKey || s.id || '—')}</code></td>
      <td>${s.createdAt ? new Date(s.createdAt).toLocaleString() : '—'}</td>
      <td>${s.messageCount ?? s.messages ?? '—'}</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  detail.innerHTML = html;
}

function renderClawChannels(detail, data) {
  const channels = data.channels || data.data || (Array.isArray(data) ? data : []);
  if (!channels.length) {
    // 可能是对象格式
    if (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0 && !data.error) {
      detail.innerHTML = `<div class="claw-raw"><pre>${escHtml(JSON.stringify(data, null, 2))}</pre></div>`;
      return;
    }
    detail.innerHTML = `<div class="claw-empty">${L('inbox')} 暂无渠道数据</div>`;
    refreshIcons();
    return;
  }

  let html = `<table class="nodes-data-table"><thead><tr>
    <th>渠道</th><th>类型</th><th>状态</th>
  </tr></thead><tbody>`;
  for (const c of channels) {
    const statusColor = c.status === 'active' || c.connected ? 'green' : 'yellow';
    html += `<tr>
      <td><strong>${escHtml(c.name || c.id || '—')}</strong></td>
      <td>${escHtml(c.type || '—')}</td>
      <td class="${statusColor}">${escHtml(c.status || (c.connected ? '连接' : '断开') || '—')}</td>
    </tr>`;
  }
  html += `</tbody></table>`;
  detail.innerHTML = html;
}

// ═══════════════════════════════════════
// @alpha: 分组管理页面
// ═══════════════════════════════════════

async function renderGroupsPage(container) {
  container.innerHTML = `
    <div class="page-users">
      <div class="users-header">
        <h3>分组管理</h3>
        <button class="toolbar-btn primary" onclick="showGroupModal()">${L('plus')} 创建分组</button>
      </div>
      <div id="groups-table-wrap">加载中...</div>
    </div>`;
  refreshIcons();
  await loadGroupsTable();
}

async function loadGroupsTable() {
  const wrap = $('#groups-table-wrap');
  if (!wrap) return;
  try {
    const res = await authFetch('/api/nodes/groups');
    const data = await res.json();
    const groups = data.groups || [];
    nodeGroups = groups;

    if (groups.length === 0) {
      wrap.innerHTML = `<div class="table-empty">暂无分组，点击「创建分组」开始</div>`;
      return;
    }

    let html = `<table class="nodes-data-table">
      <thead><tr>
        <th>颜色</th><th>名称</th><th>节点数</th><th>创建时间</th><th>操作</th>
      </tr></thead><tbody>`;
    for (const g of groups) {
      const created = g.createdAt ? new Date(g.createdAt).toLocaleString() : '—';
      html += `<tr>
        <td><span class="group-color-dot lg" style="background:${escHtml(g.color)}"></span></td>
        <td><strong>${escHtml(g.name)}</strong></td>
        <td>${g.nodeCount ?? 0}</td>
        <td>${created}</td>
        <td>
          <button class="btn-icon" onclick="showEditGroupModal('${safeAttr(g.id)}')" title="编辑">${L('pencil')}</button>
          <button class="btn-icon" onclick="deleteGroupUI('${safeAttr(g.id)}')" title="删除">${L('trash-2')}</button>
        </td>
      </tr>`;
    }
    html += `</tbody></table>`;
    wrap.innerHTML = html;
    refreshIcons();
  } catch (e) {
    wrap.innerHTML = `<div class="table-empty">加载失败: ${escHtml(e.message)}</div>`;
  }
}

function showEditGroupModal(groupId) {
  const group = nodeGroups.find(g => g.id === groupId);
  if (!group) return;
  const overlay = $('#modal-overlay');
  const content = $('#modal-content');
  overlay.style.display = 'flex';
  pickedColor = group.color || '#388bfd';
  content.innerHTML = `
    <div class="modal-header">编辑分组</div>
    <div class="modal-body">
      <label>分组名称</label>
      <input type="text" id="edit-group-name" value="${escHtml(group.name)}" autofocus>
      <label>颜色</label>
      <div class="color-picker" id="color-picker">
        ${['#388bfd','#3fb950','#f85149','#d29922','#a371f7','#f778ba','#79c0ff','#56d4dd'].map(c => `<span class="color-opt ${c === pickedColor ? 'active' : ''}" style="background:${c}" onclick="pickColor(this,'${c}')"></span>`).join('')}
      </div>
    </div>
    <div class="modal-footer">
      <button class="modal-btn cancel" onclick="closeModal()">取消</button>
      <button class="modal-btn primary" onclick="updateGroupUI('${safeAttr(groupId)}')">保存</button>
    </div>`;
}

async function updateGroupUI(groupId) {
  const name = $('#edit-group-name')?.value?.trim();
  if (!name) { alert('名称不能为空'); return; }
  try {
    const res = await authFetch(`/api/nodes/groups/${encodeURIComponent(groupId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color: pickedColor }),
    });
    if (!res.ok) {
      const d = await res.json();
      alert(d.message || d.error || '更新失败');
      return;
    }
    closeModal();
    await loadGroupsTable();
  } catch (e) { alert(`更新失败: ${e.message}`); }
}

// ═══════════════════════════════════════
// @alpha: 系统设置页面
// ═══════════════════════════════════════

async function renderSettingsPage(container) {
  container.innerHTML = `
    <div class="page-settings">
      <div class="settings-section">
        <h3>${L('info')} 系统信息</h3>
        <div id="settings-health" class="settings-cards">加载中...</div>
      </div>
      <div class="settings-section">
        <h3>${L('key-round')} 修改密码</h3>
        <form id="change-pwd-form" class="settings-form" onsubmit="doChangePwd(event)">
          <label class="form-label">当前密码</label>
          <input class="form-input" type="password" id="pwd-old" required autocomplete="current-password">
          <label class="form-label" style="margin-top:12px">新密码（至少 8 位）</label>
          <input class="form-input" type="password" id="pwd-new" required minlength="8" autocomplete="new-password">
          <label class="form-label" style="margin-top:12px">确认新密码</label>
          <input class="form-input" type="password" id="pwd-confirm" required minlength="8" autocomplete="new-password">
          <div id="pwd-error" style="color:var(--red);font-size:12px;margin-top:8px;display:none"></div>
          <button type="submit" class="toolbar-btn primary" style="margin-top:16px" id="pwd-submit-btn">${L('check')} 修改密码</button>
        </form>
      </div>
    </div>`;
  refreshIcons();
  await loadHealthInfo();
}

async function loadHealthInfo() {
  const wrap = $('#settings-health');
  if (!wrap) return;
  try {
    const res = await authFetch('/api/health');
    const d = await res.json();
    wrap.innerHTML = `<div class="settings-info-grid">
      ${settingsInfoCard(L('activity'), '状态', d.status === 'ok' ? '正常运行' : d.status, d.status === 'ok' ? 'green' : 'red')}
      ${settingsInfoCard(L('clock'), '运行时间', formatUptime(d.uptime), '')}
      ${settingsInfoCard(L('globe'), '总节点', String(d.nodesTotal), 'accent')}
      ${settingsInfoCard(L('check-circle'), '已审批', String(d.nodesApproved), 'green')}
      ${settingsInfoCard(L('clock'), '待审批', String(d.nodesPending), d.nodesPending > 0 ? 'yellow' : '')}
      ${settingsInfoCard(L('server'), '版本', 'v0.1.0', '')}
    </div>`;
    refreshIcons();
  } catch (e) {
    wrap.innerHTML = `<div class="table-empty">加载失败: ${escHtml(e.message)}</div>`;
  }
}

function settingsInfoCard(icon, label, value, color) {
  return `<div class="settings-info-card">
    <div class="sic-label">${icon} ${escHtml(label)}</div>
    <div class="sic-value ${color}">${value}</div>
  </div>`;
}

function formatUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

async function doChangePwd(e) {
  e.preventDefault();
  const oldPwd = $('#pwd-old')?.value;
  const newPwd = $('#pwd-new')?.value;
  const confirm = $('#pwd-confirm')?.value;
  const errEl = $('#pwd-error');
  const btn = $('#pwd-submit-btn');

  if (newPwd !== confirm) {
    if (errEl) { errEl.textContent = '两次输入的新密码不一致'; errEl.style.display = 'block'; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = '提交中...'; }
  if (errEl) errEl.style.display = 'none';

  try {
    const res = await authFetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (errEl) { errEl.textContent = data.error || '修改失败'; errEl.style.display = 'block'; }
    } else {
      showToast('密码修改成功');
      if ($('#pwd-old')) $('#pwd-old').value = '';
      if ($('#pwd-new')) $('#pwd-new').value = '';
      if ($('#pwd-confirm')) $('#pwd-confirm').value = '';
    }
  } catch (err) {
    if (errEl) { errEl.textContent = '网络错误: ' + err.message; errEl.style.display = 'block'; }
  }
  if (btn) { btn.disabled = false; btn.textContent = '修改密码'; }
}

// 启动
initTheme();
if (!getToken()) {
  showLoginPage();
} else {
  hideLoginPage();
  connectWS();
  switchPage('dashboard');
}
