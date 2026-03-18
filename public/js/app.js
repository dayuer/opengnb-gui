'use strict';

/* GNB Console — 前端应用逻辑 */

const $ = (sel) => document.querySelector(sel);

// --- 认证 ---
function getToken() {
  return localStorage.getItem('gnb_admin_token') || '';
}

function setToken(token) {
  localStorage.setItem('gnb_admin_token', token);
}

function promptToken() {
  const token = prompt('请输入管理员 Token (ADMIN_TOKEN):');
  if (token) { setToken(token.trim()); location.reload(); }
}

/** 带认证的 fetch 包装 */
async function authFetch(url, options = {}) {
  const token = getToken();
  options.headers = {
    ...options.headers,
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
  const res = await fetch(url, options);
  if (res.status === 401) {
    promptToken();
    throw new Error('认证失败');
  }
  return res;
}

// --- 状态 ---
let nodesData = [];
let pendingNodes = [];
let selectedNodeId = null;
let ws = null;
let opsLogsCache = {}; // { nodeId: [...messages] }

// --- WebSocket ---
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = getToken();
  ws = new WebSocket(`${proto}//${location.host}/ws${token ? '?token=' + encodeURIComponent(token) : ''}`);

  ws.onopen = () => {
    $('#connection-status').className = 'status-badge online';
    $('#connection-status').textContent = '已连接';
  };

  ws.onclose = () => {
    $('#connection-status').className = 'status-badge offline';
    $('#connection-status').textContent = '断开';
    setTimeout(connectWS, 3000);
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'snapshot' || msg.type === 'update') {
        nodesData = msg.data || [];
        pendingNodes = msg.pending || [];
        renderNodeList();
        renderPendingList();
        if (selectedNodeId) renderNodeDetail(selectedNodeId);
        $('#last-update').textContent = new Date(msg.timestamp).toLocaleTimeString();
      }
      if (msg.type === 'chat_history') {
        opsLogsCache = msg.logs || {};
        if (selectedNodeId && opsLogsCache[selectedNodeId]) {
          loadNodeOpsLog(selectedNodeId);
        }
      }
      if (msg.type === 'provision_log') {
        appendAiMsg('assistant', `[${msg.nodeId}] ${msg.message}`);
      }
    } catch (_) { /* 忽略 */ }
  };
}

// --- 节点列表 ---
function renderNodeList() {
  const list = $('#node-list');
  const count = $('#node-count');
  count.textContent = nodesData.length;

  list.innerHTML = nodesData.map(node => {
    const dotClass = node.online ? 'online' : 'offline';
    const activeClass = node.id === selectedNodeId ? 'active' : '';
    const latency = node.sshLatencyMs > 0 ? `${node.sshLatencyMs}ms` : '—';
    return `
      <li class="node-item ${activeClass}" onclick="selectNode('${node.id}')">
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
  const badge = $('#pending-count');
  badge.textContent = pendingNodes.length;

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
        <button class="btn-approve" onclick="approveNode('${node.id}')">✓ 通过</button>
        <button class="btn-reject" onclick="rejectNode('${node.id}')">✗ 拒绝</button>
      </div>
    </div>
  `).join('');
}

async function approveNode(nodeId) {
  const res = await authFetch(`/api/enroll/${nodeId}/approve`, { method: 'POST' });
  const data = await res.json();
  appendAiMsg('assistant', `审批: ${data.message}`);

  // 审批通过后提示是否配置下发
  if (data.success) {
    appendAiMsg('assistant',
      `节点 ${nodeId} 已通过审批。<button class="confirm-btn" onclick="provisionNode('${nodeId}')">开始配置下发</button>`,
      true
    );
  }
}

async function rejectNode(nodeId) {
  await authFetch(`/api/enroll/${nodeId}/reject`, { method: 'POST' });
  appendAiMsg('assistant', `节点 ${nodeId} 已拒绝`);
}

async function provisionNode(nodeId) {
  appendAiMsg('user', `开始配置下发: ${nodeId}`);
  const res = await authFetch(`/api/provision/${nodeId}`, { method: 'POST' });
  const data = await res.json();
  appendAiMsg('assistant', data.message || '配置下发已启动，日志将实时推送');
}

// --- 选择节点 ---
function selectNode(nodeId) {
  selectedNodeId = nodeId;
  renderNodeList();
  renderNodeDetail(nodeId);
  loadNodeOpsLog(nodeId);
}

// --- 节点详情（仪表盘风格）---

/** 生成 SVG 健康圆环 */
function renderHealthRing(online, latencyMs) {
  const r = 48, c = 2 * Math.PI * r;
  // 在线时圆环完整，离线时 20%
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

/** 生成指标卡片 */
function renderMetricCard(icon, title, value, color, detail, badge) {
  const badgeHtml = badge ? `<span class="mc-badge ${badge.color}">${escHtml(badge.text)}</span>` : '';
  const detailHtml = detail || '';
  return `
    <div class="metric-card">
      <div class="mc-header">
        <span class="mc-title"><span class="mc-icon">${icon}</span> ${escHtml(title)}</span>
        ${badgeHtml}
      </div>
      <div class="mc-value ${color}">${value}</div>
      <div class="mc-detail">${detailHtml}</div>
    </div>
  `;
}

/** 生成系统资源小卡片 */
function renderSysCard(icon, title, value, color, sub, barPct) {
  let barHtml = '';
  if (barPct !== undefined) {
    const barColor = barPct > 90 ? 'red' : barPct > 70 ? 'yellow' : 'green';
    barHtml = `<div class="sys-bar"><div class="sys-bar-fill ${barColor}" style="width:${barPct}%"></div></div>`;
  }
  return `
    <div class="sys-card">
      <div class="sys-header">
        <span class="sys-title">${icon} ${escHtml(title)}</span>
      </div>
      <div class="sys-value ${color}">${value}</div>
      <div class="sys-sub">${sub}</div>
      ${barHtml}
    </div>
  `;
}

/** 颜色阈值 */
function pctColor(pct) { return pct > 90 ? 'red' : pct > 70 ? 'yellow' : 'green'; }

function renderNodeDetail(nodeId) {
  const node = nodesData.find(n => n.id === nodeId);
  if (!node) return;

  $('#detail-title').textContent = `${node.name || node.id} — ${node.tunAddr}`;
  const content = $('#detail-content');

  // === 离线状态 ===
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
            <div class="offline-icon">⚡</div>
            <div class="offline-title">节点不可达</div>
            <div class="offline-detail">${escHtml(node.error || 'SSH 连接超时，请检查 GNB 隧道状态')}</div>
            <button class="confirm-btn" onclick="provisionNode('${nodeId}')">重新配置下发</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  // === 在线状态 — 数据聚合 ===
  const si = node.sysInfo || {};
  const peers = node.nodes || [];

  // 内存
  let memPct = 0;
  if (si.memTotalMB > 0) memPct = Math.round((si.memUsedMB / si.memTotalMB) * 100);

  // 磁盘
  const diskPct = si.diskUsePct ? parseInt(si.diskUsePct) : 0;

  // P2P 聚合
  const totalPeers = peers.length;
  const directPeers = peers.filter(n => n.status === 'Direct').length;
  const directRate = totalPeers > 0 ? Math.round((directPeers / totalPeers) * 100) : 0;
  const totalIn = peers.reduce((s, n) => s + (n.inBytes || 0), 0);
  const totalOut = peers.reduce((s, n) => s + (n.outBytes || 0), 0);

  // 平均延迟
  const latencies = peers.filter(n => n.latency4Usec > 0).map(n => n.latency4Usec / 1000);
  const avgLatency = latencies.length > 0 ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1) : '—';
  const maxLatency = latencies.length > 0 ? Math.max(...latencies).toFixed(1) : '—';
  const minLatency = latencies.length > 0 ? Math.min(...latencies).toFixed(1) : '—';

  // 负载
  const loadParts = (si.loadAvg || '').split(/\s+/);
  const load1 = loadParts[0] || '—';

  // 构建仪表盘 HTML
  let html = `<div class="monitor-dashboard">`;

  // --- 顶栏 ---
  html += `
    <div class="monitor-topbar">
      <div class="monitor-title-area">
        <h3>◈ ${escHtml(node.name || node.id)}</h3>
        <span class="status-badge online">在线</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="monitor-time">刷新: ${node.lastUpdate ? new Date(node.lastUpdate).toLocaleTimeString() : '—'}</span>
        <div class="monitor-actions">
          <button onclick="fetchClawStatus('${nodeId}')">🔍 OpenClaw</button>
        </div>
      </div>
    </div>
  `;

  // --- 主区域：健康圆环 + 右侧 ---
  html += `<div class="monitor-hero">`;

  // 左：圆环
  html += renderHealthRing(true, node.sshLatencyMs);

  // 右：实时数据 + 指标网格
  html += `<div class="monitor-realtime-area">`;

  // 实时数据条
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

  // --- 指标卡片网格 (2×3) ---
  html += `<div class="metric-grid">`;

  // 1. P2P 直连
  html += renderMetricCard('🔗', 'P2P 直连', `${directPeers}/${totalPeers}`,
    directRate >= 80 ? 'green' : directRate >= 50 ? 'yellow' : 'red',
    `<div class="mc-detail-row"><span>直连率</span><span>${directRate}%</span></div>`,
    { text: directRate >= 80 ? '健康' : '注意', color: directRate >= 80 ? 'green' : 'yellow' }
  );

  // 2. 总流入
  html += renderMetricCard('📥', '总流入', formatBytes(totalIn), 'accent',
    `<div class="mc-detail-row"><span>所有节点</span><span>累计</span></div>`
  );

  // 3. 总流出
  html += renderMetricCard('📤', '总流出', formatBytes(totalOut), 'accent',
    `<div class="mc-detail-row"><span>所有节点</span><span>累计</span></div>`
  );



  // 5. OpenClaw
  const clawStatus = node.clawToken ? '已配置' : '未安装';
  const clawColor = node.clawToken ? 'green' : 'yellow';
  html += renderMetricCard('🤖', 'OpenClaw', clawStatus, clawColor,
    node.clawToken
      ? `<div class="mc-detail-row"><span>端口</span><span>${node.clawPort || 18789}</span></div><div class="mc-detail-row"><span>Token</span><span>${escHtml(node.clawToken)}</span></div>`
      : `<button class="confirm-btn" style="margin-top:4px;font-size:11px" onclick="document.querySelector('#ai-input').value='安装 openclaw ${nodeId}';sendAiMessage()">安装</button>`,
    { text: node.clawToken ? '正常' : '缺失', color: clawColor }
  );

  // 6. GNB Core
  const coreKeys = node.core ? Object.keys(node.core) : [];
  html += renderMetricCard('🌐', 'GNB 核心', coreKeys.length > 0 ? '运行中' : '—',
    coreKeys.length > 0 ? 'green' : 'red',
    coreKeys.slice(0, 3).map(k => `<div class="mc-detail-row"><span>${escHtml(k)}</span><span>${escHtml(String(node.core[k]))}</span></div>`).join('')
  );

  html += `</div>`; // metric-grid
  html += `</div>`; // monitor-realtime-area
  html += `</div>`; // monitor-hero

  // --- 底部系统资源行 ---
  html += `<div class="sys-grid">`;

  // CPU
  html += renderSysCard('⚙️', 'CPU', si.cpuCores ? `${si.cpuCores} 核` : '—', 'accent',
    `负载 ${escHtml(si.loadAvg || '—')}`
  );

  // 内存
  html += renderSysCard('💾', '内存', memPct > 0 ? `${memPct}%` : '—', pctColor(memPct),
    si.memTotalMB > 0 ? `${si.memUsedMB} / ${si.memTotalMB} MB` : '—',
    memPct > 0 ? memPct : undefined
  );

  // 磁盘
  html += renderSysCard('💿', '磁盘', diskPct > 0 ? `${diskPct}%` : '—', pctColor(diskPct),
    si.diskTotal ? `${escHtml(si.diskUsed)} / ${escHtml(si.diskTotal)}` : '—',
    diskPct > 0 ? diskPct : undefined
  );

  // 系统
  html += renderSysCard('🖥', '系统', escHtml(si.hostname || '—'), 'accent',
    escHtml(si.os || '—')
  );

  // 内核
  html += renderSysCard('🔧', '内核', escHtml(si.kernel || '—'), '',
    escHtml(si.arch || '—')
  );



  html += `</div>`; // sys-grid

  // --- GNB 节点表格（如果有数据） ---
  if (peers.length) {
    html += `<div class="monitor-section-title">GNB 节点 (${peers.length})</div>`;
    html += `<table class="sub-node-table"><thead><tr><th>UUID</th><th>TUN</th><th>状态</th><th>延迟</th><th>流入</th><th>流出</th></tr></thead><tbody>`;
    for (const sn of peers) {
      const sc = sn.status === 'Direct' ? 'green' : sn.status === 'Detecting' ? 'yellow' : 'red';
      html += `<tr><td>${escHtml(sn.uuid64||'—')}</td><td>${escHtml(sn.tunAddr4||'—')}</td><td class="${sc}">${escHtml(sn.status||'—')}</td><td>${sn.latency4Usec ? `${(sn.latency4Usec/1000).toFixed(1)}ms` : '—'}</td><td>${formatBytes(sn.inBytes||0)}</td><td>${formatBytes(sn.outBytes||0)}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

  html += `</div>`; // monitor-dashboard
  content.innerHTML = html;
}

// --- OpenClaw 状态查询 ---
async function fetchClawStatus(nodeId) {
  const el = document.getElementById('claw-status-val');
  if (el) el.textContent = '查询中...';
  try {
    const res = await authFetch(`/api/claw/${nodeId}/status`);
    const data = await res.json();
    if (data.runtimeVersion) {
      const info = [
        `v${data.runtimeVersion}`,
        data.heartbeat?.defaultAgentId ? `Agent: ${data.heartbeat.defaultAgentId}` : '',
        data.sessions?.count !== undefined ? `会话: ${data.sessions.count}` : '',
      ].filter(Boolean).join(' · ');
      if (el) { el.textContent = info; el.className = 'stat-value green'; }
    } else if (data.raw) {
      if (el) { el.textContent = data.raw.substring(0, 60); el.className = 'stat-value yellow'; }
    } else if (data.error) {
      if (el) { el.textContent = data.error.substring(0, 60); el.className = 'stat-value red'; }
    }
  } catch (e) {
    if (el) { el.textContent = `错误: ${e.message}`; el.className = 'stat-value red'; }
  }
}

// --- AI 对话 ---
async function sendAiMessage() {
  const input = $('#ai-input');
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
  const div = document.createElement('div');
  div.className = `ai-msg ${role}`;
  if (isHtml) { div.innerHTML = content; } else { div.textContent = content; }
  container.appendChild(div);
  if (!skipScroll) container.scrollTop = container.scrollHeight;
}

function loadNodeOpsLog(nodeId) {
  const container = $('#ai-messages');
  container.innerHTML = '';
  const logs = opsLogsCache[nodeId] || [];
  for (const m of logs) {
    appendAiMsg(m.role, m.content, false, true);
  }
  container.scrollTop = container.scrollHeight;
}

// --- 工具 ---
function escHtml(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

function formatBytes(b) {
  if (!b) return '0B';
  if (b >= 1073741824) return `${(b/1073741824).toFixed(1)}G`;
  if (b >= 1048576) return `${(b/1048576).toFixed(1)}M`;
  if (b >= 1024) return `${(b/1024).toFixed(1)}K`;
  return `${b}B`;
}

// --- 事件 ---
$('#ai-send').addEventListener('click', sendAiMessage);
$('#ai-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAiMessage(); });

// 快捷按钮
document.querySelectorAll('.quick-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    let cmd = btn.dataset.cmd;
    // 自动追加当前选中的节点 ID
    if (selectedNodeId && !cmd.includes(selectedNodeId)) {
      cmd += ` ${selectedNodeId}`;
    }
    $('#ai-input').value = cmd;
    sendAiMessage();
  });
});

// --- 启动 ---
if (!getToken()) {
  promptToken();
} else {
  connectWS();
}
