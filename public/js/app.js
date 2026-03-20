'use strict';

/* GNB Console — 前端应用逻辑（含页面路由） */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const L = (name) => `<i data-lucide="${name}"></i>`;
function refreshIcons() { if (window.lucide) lucide.createIcons(); }

/** 安全转义字符串用于 HTML 属性中的 onclick 等场景，防止 XSS */
function safeAttr(str) { return String(str).replace(/[&'"<>]/g, c => ({'&':'&amp;',"'":'&#39;','"':'&quot;','<':'&lt;','>':'&gt;'}[c])); }

// --- 认证 ---
function getToken() { return localStorage.getItem('gnb_admin_token') || ''; }
function setToken(token) { localStorage.setItem('gnb_admin_token', token); }

function promptToken() {
  showLoginModal();
}

/** @beta: 登录弹窗 */
function showLoginModal() {
  const overlay = $('#modal-overlay');
  const content = $('#modal-content');
  if (!overlay || !content) return;
  overlay.style.display = 'flex';
  content.innerHTML = `
    <div class="modal-header">登录 GNB Console</div>
    <div class="modal-body">
      <label>用户名</label>
      <input type="text" id="login-username" placeholder="admin" autofocus>
      <label>密码</label>
      <input type="password" id="login-password" placeholder="输入密码...">
      <div id="login-error" style="color:var(--red);font-size:12px;margin-top:4px;display:none"></div>
    </div>
    <div class="modal-footer">
      <button class="modal-btn primary" onclick="doLogin()">登录</button>
    </div>
  `;
  setTimeout(() => {
    const pwdInput = $('#login-password');
    if (pwdInput) pwdInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  }, 50);
}

async function doLogin() {
  const username = $('#login-username')?.value?.trim();
  const password = $('#login-password')?.value;
  if (!username || !password) return;
  const errEl = $('#login-error');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (errEl) { errEl.textContent = data.error || '登录失败'; errEl.style.display = 'block'; }
      return;
    }
    setToken(data.token);
    closeModal();
    location.reload();
  } catch (e) {
    if (errEl) { errEl.textContent = '网络错误'; errEl.style.display = 'block'; }
  }
}

async function authFetch(url, options = {}) {
  const token = getToken();
  options.headers = { ...options.headers, ...(token ? { 'Authorization': `Bearer ${token}` } : {}) };
  const res = await fetch(url, options);
  if (res.status === 401) { showLoginModal(); throw new Error('认证失败'); }
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
  monitor: '运维监控',
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
    case 'monitor':   renderMonitorPage(container); break;
    case 'nodes':     renderNodesPage(container); break;
    case 'users':     renderUsersPage(container); break;
    case 'groups':    renderPlaceholder(container, L('folder'), '分组管理', '管理节点分组和策略路由（开发中）'); break;
    case 'settings':  renderPlaceholder(container, L('settings'), '系统设置', '系统配置、证书管理和日志查看（开发中）'); break;
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

  // 节点概览 (@alpha: 含迷你趋势图 + 告警标记)
  if (total > 0) {
    html += `<div class="dashboard-section-title">节点状态概览</div>`;
    html += `<div class="node-accordion" id="node-accordion">`;
    for (const node of nodesData) {
      html += renderNodeAccordionPanel(node);
    }
    html += `</div>`;
  }

  html += `</div>`;
  container.innerHTML = html;
  refreshIcons();
  // @alpha: 绘制趋势图
  for (const node of nodesData) { if (node.online) loadAndDrawSparklines(node.id); }
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
// 运维监控页面（节点详情 + AI 面板）
// ═══════════════════════════════════════

function renderMonitorPage(container) {
  // 如果没有选中节点，选第一个在线节点
  if (!selectedNodeId && nodesData.length > 0) {
    const online = nodesData.find(n => n.online);
    selectedNodeId = online ? online.id : nodesData[0].id;
  }

  container.innerHTML = `
    <div class="page-monitor">
      <div class="monitor-main" id="monitor-detail"></div>
      <aside class="ai-panel">
        <div class="panel-header">
          <h2>运维控制台</h2>
          <span class="badge accent">指令</span>
        </div>
        <div class="ai-messages" id="ai-messages"></div>
        <div class="ai-quick-actions" id="ai-quick-actions">
          <button class="quick-btn" data-cmd="安装 openclaw">${L('package')} 安装 OpenClaw</button>
          <button class="quick-btn" data-cmd="状态">${L('bar-chart-3')} 状态</button>
          <button class="quick-btn" data-cmd="重启 gnb">${L('refresh-cw')} 重启 GNB</button>
          <button class="quick-btn" data-cmd="重启 openclaw">${L('refresh-cw')} 重启 Claw</button>
          <button class="quick-btn" data-cmd="日志">${L('file-text')} 日志</button>
        </div>
        <div class="ai-input-area">
          <input type="text" class="ai-input" id="ai-input" placeholder="输入运维指令..." autocomplete="off">
          <button class="ai-send-btn" id="ai-send">发送</button>
        </div>
      </aside>
    </div>
  `;

  // 绑定 AI 事件
  bindAiEvents();
  refreshIcons();

  // 渲染详情
  if (selectedNodeId) {
    renderNodeDetail(selectedNodeId);
    loadNodeOpsLog(selectedNodeId);
  }
}

function bindAiEvents() {
  const sendBtn = $('#ai-send');
  const input = $('#ai-input');
  if (sendBtn) sendBtn.addEventListener('click', sendAiMessage);
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAiMessage(); });

  // 快捷按钮
  $$('.quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      let cmd = btn.dataset.cmd;
      if (selectedNodeId && !cmd.includes(selectedNodeId)) cmd += ` ${selectedNodeId}`;
      $('#ai-input').value = cmd;
      sendAiMessage();
    });
  });
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

// --- 内联详情面板 ---
function renderInlineDetail(panel, node) {
  if (!node.online) {
    panel.innerHTML = `<div class="inline-offline">${L('zap')} 节点不可达 — ${escHtml(node.error || 'SSH 连接超时')}</div>`;
    refreshIcons();
    return;
  }
  const si = node.sysInfo || {};
  const memPct = si.memTotalMB > 0 ? Math.round(si.memUsedMB / si.memTotalMB * 100) : 0;
  const diskPct = si.diskUsePct ? parseInt(si.diskUsePct) : 0;
  const peers = node.nodes || [];
  const directP = peers.filter(p => p.status === 'Direct').length;
  const totalIn = peers.reduce((s, n) => s + (n.inBytes || 0), 0);
  const totalOut = peers.reduce((s, n) => s + (n.outBytes || 0), 0);

  panel.innerHTML = `<div class="inline-detail-grid">
    <div class="id-metric">${L('activity')} SSH <b class="${node.sshLatencyMs > 500 ? 'red' : node.sshLatencyMs > 200 ? 'yellow' : 'green'}">${node.sshLatencyMs}ms</b></div>
    <div class="id-metric">${L('link')} P2P <b>${directP}/${peers.length}</b></div>
    <div class="id-metric">${L('download')} 流入 <b class="accent">${formatBytes(totalIn)}</b></div>
    <div class="id-metric">${L('upload')} 流出 <b class="accent">${formatBytes(totalOut)}</b></div>
    <div class="id-metric">${L('cpu')} CPU <b>${si.cpuCores || '—'}核</b> · ${escHtml(si.loadAvg || '—')}</div>
    <div class="id-metric">${L('memory-stick')} 内存 <b class="${pctColor(memPct)}">${memPct}%</b> (${si.memUsedMB||0}/${si.memTotalMB||0}MB)</div>
    <div class="id-metric">${L('hard-drive')} 磁盘 <b class="${pctColor(diskPct)}">${diskPct}%</b> (${escHtml(si.diskUsed||'—')}/${escHtml(si.diskTotal||'—')})</div>
    <div class="id-metric">${L('monitor')} ${escHtml(si.hostname || '—')} · ${escHtml(si.os || '—')}</div>
  </div>`;
  refreshIcons();
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
    selectedIds.clear();
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
    renderNodeList();
    renderNodeDetail(nodeId);
  } else if (currentPage === 'monitor') {
    renderNodeDetail(nodeId);
    loadNodeOpsLog(nodeId);
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

function renderNodeDetail(nodeId) {
  const node = nodesData.find(n => n.id === nodeId);
  if (!node) return;

  const detailTitle = $('#detail-title');
  const content = currentPage === 'monitor' ? $('#monitor-detail') : $('#detail-content');
  if (!content) return;
  if (detailTitle) detailTitle.textContent = `${node.name || node.id} — ${node.tunAddr}`;

  if (!node.online) {
    content.innerHTML = `
      <div class="monitor-dashboard">
        <div class="monitor-topbar">
          <div class="monitor-title-area">
            <h3>◈ ${escHtml(node.name || node.id)}</h3>
            <span class="status-badge offline">离线</span>
          </div>
          <span class="monitor-time">${node.lastUpdate ? new Date(node.lastUpdate).toLocaleString() : '—'}</span>
        </div>
        <div class="monitor-hero">
          ${renderHealthRing(false, -1)}
          <div class="offline-placeholder">
            <div class="offline-icon">${L('zap')}</div>
            <div class="offline-title">节点不可达</div>
            <div class="offline-detail">${escHtml(node.error || 'SSH 连接超时，请检查 GNB 隧道状态')}</div>
            <button class="confirm-btn" onclick="provisionNode('${safeAttr(nodeId)}')">重新配置下发</button>
          </div>
        </div>
      </div>
    `;
    refreshIcons();
    return;
  }

  const si = node.sysInfo || {};
  const peers = node.nodes || [];
  let memPct = 0;
  if (si.memTotalMB > 0) memPct = Math.round((si.memUsedMB / si.memTotalMB) * 100);
  const diskPct = si.diskUsePct ? parseInt(si.diskUsePct) : 0;
  const totalPeers = peers.length;
  const directPeers = peers.filter(n => n.status === 'Direct').length;
  const directRate = totalPeers > 0 ? Math.round((directPeers / totalPeers) * 100) : 0;
  const totalIn = peers.reduce((s, n) => s + (n.inBytes || 0), 0);
  const totalOut = peers.reduce((s, n) => s + (n.outBytes || 0), 0);
  const clawStatus = node.clawToken ? '已配置' : '未安装';
  const clawColor = node.clawToken ? 'green' : 'yellow';

  let html = `<div class="monitor-dashboard">`;

  html += `
    <div class="monitor-topbar">
      <div class="monitor-title-area">
        <h3>◈ ${escHtml(node.name || node.id)}</h3>
        <span class="status-badge online">在线</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="monitor-time">刷新: ${node.lastUpdate ? new Date(node.lastUpdate).toLocaleTimeString() : '—'}</span>
        <div class="monitor-actions">
          <button onclick="fetchClawStatus('${safeAttr(nodeId)}')">${L('search')} OpenClaw</button>
        </div>
      </div>
    </div>
  `;

  html += `<div class="monitor-hero">`;
  html += renderHealthRing(true, node.sshLatencyMs);
  html += `<div class="monitor-realtime-area">`;

  html += `
    <div class="realtime-bar">
      <div class="realtime-item">
        <span class="ri-label">SSH 延迟</span>
        <span class="ri-value ${node.sshLatencyMs > 500 ? 'red' : node.sshLatencyMs > 200 ? 'yellow' : 'green'}">${node.sshLatencyMs}ms</span>
      </div>
      <div class="realtime-item">
        <span class="ri-label">P2P 节点</span>
        <span class="ri-value accent">${totalPeers}</span>
      </div>
      <div class="realtime-item">
        <span class="ri-label">直连率</span>
        <span class="ri-value ${directRate >= 80 ? 'green' : directRate >= 50 ? 'yellow' : 'red'}">${directRate}%</span>
      </div>
      <div class="realtime-item">
        <span class="ri-label">运行时长</span>
        <span class="ri-value">${escHtml(si.uptime || '—')}</span>
      </div>
    </div>
  `;

  html += `<div class="metric-grid">`;
  html += renderMetricCard(L('link'), 'P2P 直连', `${directPeers}/${totalPeers}`,
    directRate >= 80 ? 'green' : directRate >= 50 ? 'yellow' : 'red',
    `<div class="mc-detail-row"><span>直连率</span><span>${directRate}%</span></div>`,
    { text: directRate >= 80 ? '健康' : '注意', color: directRate >= 80 ? 'green' : 'yellow' });
  html += renderMetricCard(L('download'), '总流入', formatBytes(totalIn), 'accent',
    `<div class="mc-detail-row"><span>所有节点</span><span>累计</span></div>`);
  html += renderMetricCard(L('upload'), '总流出', formatBytes(totalOut), 'accent',
    `<div class="mc-detail-row"><span>所有节点</span><span>累计</span></div>`);
  html += renderMetricCard(L('bot'), 'OpenClaw', clawStatus, clawColor,
    node.clawToken
      ? `<div class="mc-detail-row"><span>端口</span><span>${node.clawPort || 18789}</span></div><div class="mc-detail-row"><span>Token</span><span>${escHtml(node.clawToken)}</span></div>`
      : `<button class="confirm-btn" style="margin-top:4px;font-size:11px" onclick="document.querySelector('#ai-input').value='安装 openclaw ${safeAttr(nodeId)}';sendAiMessage()">安装</button>`,
    { text: node.clawToken ? '正常' : '缺失', color: clawColor });
  const coreKeys = node.core ? Object.keys(node.core) : [];
  html += renderMetricCard(L('globe'), 'GNB 核心', coreKeys.length > 0 ? '运行中' : '—',
    coreKeys.length > 0 ? 'green' : 'red',
    coreKeys.slice(0, 3).map(k => `<div class="mc-detail-row"><span>${escHtml(k)}</span><span>${escHtml(String(node.core[k]))}</span></div>`).join(''));
  html += `</div></div></div>`;

  html += `<div class="sys-grid">`;
  html += renderSysCard(L('cpu'), 'CPU', si.cpuCores ? `${si.cpuCores} 核` : '—', 'accent', `负载 ${escHtml(si.loadAvg || '—')}`);
  html += renderSysCard(L('memory-stick'), '内存', memPct > 0 ? `${memPct}%` : '—', pctColor(memPct),
    si.memTotalMB > 0 ? `${si.memUsedMB} / ${si.memTotalMB} MB` : '—', memPct > 0 ? memPct : undefined);
  html += renderSysCard(L('hard-drive'), '磁盘', diskPct > 0 ? `${diskPct}%` : '—', pctColor(diskPct),
    si.diskTotal ? `${escHtml(si.diskUsed)} / ${escHtml(si.diskTotal)}` : '—', diskPct > 0 ? diskPct : undefined);
  html += renderSysCard(L('monitor'), '系统', escHtml(si.hostname || '—'), 'accent', escHtml(si.os || '—'));
  html += renderSysCard(L('wrench'), '内核', escHtml(si.kernel || '—'), '', escHtml(si.arch || '—'));
  html += `</div>`;

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
  content.innerHTML = html;
  refreshIcons();
}

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
  try {
    const res = await authFetch(`/api/enroll/${encodeURIComponent(nodeId)}/approve`, { method: 'POST' });
    const data = await res.json();
    appendAiMsg('assistant', `审批: ${data.message}`);
    if (data.success) {
      appendAiMsg('assistant',
        `节点 ${escHtml(nodeId)} 已通过审批。<button class="confirm-btn" onclick="provisionNode('${safeAttr(nodeId)}')">开始配置下发</button>`, true);
    }
  } catch (e) {
    appendAiMsg('assistant', `审批失败: ${e.message}`);
  }
}

async function rejectNode(nodeId) {
  try {
    await authFetch(`/api/enroll/${encodeURIComponent(nodeId)}/reject`, { method: 'POST' });
    appendAiMsg('assistant', `节点 ${escHtml(nodeId)} 已拒绝`);
  } catch (e) {
    appendAiMsg('assistant', `拒绝失败: ${e.message}`);
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
        if (currentPage === 'monitor' && selectedNodeId) renderNodeDetail(selectedNodeId);
      }
      if (msg.type === 'chat_history') {
        opsLogsCache = msg.logs || {};
        if (selectedNodeId && opsLogsCache[selectedNodeId] && currentPage === 'monitor') {
          loadNodeOpsLog(selectedNodeId);
        }
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
  // @beta: 从后端获取新 JWT
  authFetch('/api/auth/token')
    .then(r => r.json())
    .then(data => {
      const token = data.token || getToken();
      const overlay = $('#modal-overlay');
      const content = $('#modal-content');
      if (overlay && content) {
        overlay.style.display = 'flex';
        content.innerHTML = `
          <div class="modal-header">API Token（节点初始化用）</div>
          <div class="modal-body">
            <label>当前 Token（24h 有效）</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="text" id="api-key-display" value="${escHtml(token)}" readonly
                style="flex:1;font-family:var(--font-mono);font-size:12px">
              <button class="toolbar-btn" onclick="copyApiKey()">复制</button>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:8px">
              节点初始化命令:
            </div>
            <code style="display:block;font-size:11px;padding:8px;background:var(--bg-tertiary);border-radius:4px;word-break:break-all;margin-top:4px">
              curl -sSL https://${location.host}/api/enroll/init.sh | ADMIN_TOKEN=${escHtml(token)} bash
            </code>
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

// 启动
initTheme();
if (!getToken()) {
  promptToken();
} else {
  connectWS();
  switchPage('dashboard');
}
