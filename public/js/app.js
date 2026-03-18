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
  const token = prompt('请输入管理员 Token (ADMIN_TOKEN):');
  if (token && token.trim()) {
    setToken(token.trim());
    location.reload();
  }
}

async function authFetch(url, options = {}) {
  const token = getToken();
  options.headers = { ...options.headers, ...(token ? { 'Authorization': `Bearer ${token}` } : {}) };
  const res = await fetch(url, options);
  if (res.status === 401) { promptToken(); throw new Error('认证失败'); }
  return res;
}

// --- 全局状态 ---
let nodesData = [];
let pendingNodes = [];
let selectedNodeId = null;
let currentPage = 'dashboard';
let ws = null;
let opsLogsCache = {};

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
    case 'users':     renderPlaceholder(container, L('users'), '用户管理', '管理 VPN 用户账号和权限（开发中）'); break;
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
// 仪表盘页面
// ═══════════════════════════════════════

function renderDashboardPage(container) {
  const online = nodesData.filter(n => n.online).length;
  const offline = nodesData.filter(n => !n.online).length;
  const total = nodesData.length;
  const pending = pendingNodes.length;

  // 汇总所有节点的 P2P 对等节点数
  let totalPeers = 0, directPeers = 0;
  for (const n of nodesData) {
    if (!n.nodes) continue;
    totalPeers += n.nodes.length;
    directPeers += n.nodes.filter(p => p.status === 'Direct').length;
  }

  let html = `<div class="page-dashboard">`;

  // 统计卡片
  html += `<div class="dashboard-stats">`;
  html += dashCard(L('globe'), '托管节点', `${total}`, 'accent', `在线 ${online} / 离线 ${offline}`);
  html += dashCard(L('circle-check'), '在线节点', `${online}`, online > 0 ? 'green' : 'red', `${total > 0 ? Math.round(online/total*100) : 0}% 在线率`);
  html += dashCard(L('clock'), '待审批', `${pending}`, pending > 0 ? 'yellow' : 'green', pending > 0 ? '需要处理' : '无待办');
  html += dashCard(L('link'), 'P2P 连接', `${directPeers}/${totalPeers}`, directPeers > 0 ? 'green' : 'red',
    totalPeers > 0 ? `${Math.round(directPeers/totalPeers*100)}% 直连率` : '无连接');
  html += `</div>`;

  // 节点概览表格
  if (total > 0) {
    html += `<div class="dashboard-section-title">节点状态概览</div>`;
    html += `<table class="node-overview-table"><thead><tr>
      <th>节点</th><th>TUN</th><th>状态</th><th>SSH 延迟</th><th>CPU</th><th>内存</th><th>磁盘</th>
    </tr></thead><tbody>`;
    for (const node of nodesData) {
      const si = node.sysInfo || {};
      const memPct = si.memTotalMB > 0 ? Math.round(si.memUsedMB / si.memTotalMB * 100) : 0;
      const diskPct = si.diskUsePct ? parseInt(si.diskUsePct) : 0;
      html += `<tr style="cursor:pointer" onclick="switchPage('nodes');setTimeout(()=>selectNode('${safeAttr(node.id)}'),50)">`;
      html += `
        <td>${escHtml(node.name || node.id)}</td>
        <td>${escHtml(node.tunAddr)}</td>
        <td><span class="status-badge ${node.online ? 'online' : 'offline'}">${node.online ? '在线' : '离线'}</span></td>
        <td>${node.online ? node.sshLatencyMs + 'ms' : '—'}</td>
        <td>${si.loadAvg ? escHtml(si.loadAvg.split(' ')[0]) : '—'}</td>
        <td class="${pctColor(memPct)}">${memPct > 0 ? memPct + '%' : '—'}</td>
        <td class="${pctColor(diskPct)}">${diskPct > 0 ? diskPct + '%' : '—'}</td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }

  html += `</div>`;
  container.innerHTML = html;
  refreshIcons();
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
// 节点管理页面
// ═══════════════════════════════════════

function renderNodesPage(container) {
  container.innerHTML = `
    <div class="page-nodes">
      <div class="node-sidebar">
        <div class="panel-header">
          <h2>已接入节点</h2>
          <span id="node-count" class="badge">${nodesData.length}</span>
        </div>
        <ul class="node-list-scroll" id="node-list"></ul>
        <div class="pending-section">
          <div class="panel-header">
            <h2>待审批</h2>
            <span id="pending-count-inner" class="badge accent">${pendingNodes.length}</span>
          </div>
          <div id="pending-list"></div>
        </div>
      </div>
      <div class="node-detail-area">
        <div class="node-detail-header">
          <h2 id="detail-title">选择节点查看详情</h2>
        </div>
        <div class="node-detail-content" id="detail-content">
          <div class="detail-placeholder">
            <span class="placeholder-icon">◇</span>
            <p>从左侧选择一个节点</p>
          </div>
        </div>
      </div>
    </div>
  `;

  renderNodeList();
  renderPendingList();

  // 如果已选中节点，渲染详情
  if (selectedNodeId) {
    renderNodeDetail(selectedNodeId);
  }
}

// --- 节点列表 ---
function renderNodeList() {
  const list = $('#node-list');
  const count = $('#node-count');
  if (!list) return;
  if (count) count.textContent = nodesData.length;

  list.innerHTML = nodesData.map(node => {
    const dotClass = node.online ? 'online' : 'offline';
    const activeClass = node.id === selectedNodeId ? 'active' : '';
    const latency = node.sshLatencyMs > 0 ? `${node.sshLatencyMs}ms` : '—';
    return `
      <li class="node-item ${activeClass}" onclick="selectNode('${safeAttr(node.id)}')">
        <span class="node-dot ${dotClass}"></span>
        <div class="node-info">
          <div class="node-name">${escHtml(node.name || node.id)}</div>
          <div class="node-addr">${escHtml(node.tunAddr)} · ${latency}</div>
        </div>
      </li>
    `;
  }).join('');
}

// --- 待审批列表 ---
function renderPendingList() {
  const container = $('#pending-list');
  const badge = $('#pending-count-inner');
  const headerBadge = $('#pending-badge');
  const headerCount = $('#pending-count');
  if (!container) return;
  if (badge) badge.textContent = pendingNodes.length;
  if (headerCount) headerCount.textContent = pendingNodes.length;
  if (headerBadge) headerBadge.style.display = pendingNodes.length > 0 ? '' : 'none';

  if (!pendingNodes.length) {
    container.innerHTML = '<div class="detail-placeholder" style="padding:20px"><p>无待审批节点</p></div>';
    return;
  }

  container.innerHTML = pendingNodes.map(node => `
    <div class="pending-item">
      <div class="pending-info">
        <span class="node-dot unknown"></span>
        <div>
          <div class="node-name">${escHtml(node.name || node.id)}</div>
          <div class="node-addr">${escHtml(node.tunAddr)} · ${escHtml(node.sshUser || 'synon')}</div>
        </div>
      </div>
      <div class="pending-actions">
        <button class="btn-approve" onclick="approveNode('${safeAttr(node.id)}')">✓ 通过</button>
        <button class="btn-reject" onclick="rejectNode('${safeAttr(node.id)}')">✗ 拒绝</button>
      </div>
    </div>
  `).join('');
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
  const r = 48, c = 2 * Math.PI * r;
  const pct = online ? 1 : 0.2;
  const offset = c * (1 - pct);
  const cls = online ? 'online' : 'offline';
  const statusText = online ? '在线' : '离线';
  const subText = online ? (latencyMs > 0 ? `${latencyMs}ms` : '—') : '不可达';
  return `
    <div class="health-ring-box">
      <div class="health-ring-container">
        <svg class="health-ring-svg" viewBox="0 0 120 120">
          <circle class="health-ring-bg" cx="60" cy="60" r="${r}"/>
          <circle class="health-ring-fg ${cls}" cx="60" cy="60" r="${r}"
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
        $('#last-update').textContent = new Date(msg.timestamp).toLocaleTimeString();
        // 更新待审批 badge
        const hCount = $('#pending-count');
        const hBadge = $('#pending-badge');
        if (hCount) hCount.textContent = pendingNodes.length;
        if (hBadge) hBadge.style.display = pendingNodes.length > 0 ? '' : 'none';

        // 刷新当前页面
        if (currentPage === 'dashboard') renderDashboardPage($('#main-content'));
        if (currentPage === 'nodes') {
          renderNodeList();
          renderPendingList();
          if (selectedNodeId) renderNodeDetail(selectedNodeId);
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

// 启动
if (!getToken()) {
  promptToken();
} else {
  connectWS();
  switchPage('dashboard');
}
