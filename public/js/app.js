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

// --- 节点详情 ---
function renderNodeDetail(nodeId) {
  const node = nodesData.find(n => n.id === nodeId);
  if (!node) return;

  $('#detail-title').textContent = `${node.name || node.id} — ${node.tunAddr}`;
  const content = $('#detail-content');

  if (!node.online) {
    content.innerHTML = `
      <div class="section-title">连接状态</div>
      <div class="stat-row"><span class="stat-label">状态</span><span class="stat-value red">离线</span></div>
      <div class="stat-row"><span class="stat-label">错误</span><span class="stat-value red">${escHtml(node.error || '未知')}</span></div>
      <div class="stat-row"><span class="stat-label">最后更新</span><span class="stat-value">${node.lastUpdate ? new Date(node.lastUpdate).toLocaleString() : '—'}</span></div>
      <div style="padding:12px"><button class="confirm-btn" onclick="provisionNode('${nodeId}')">重新配置下发</button></div>
    `;
    return;
  }

  const si = node.sysInfo || {};

  // 内存使用率
  let memPct = 0, memColor = 'green';
  if (si.memTotalMB > 0) {
    memPct = Math.round((si.memUsedMB / si.memTotalMB) * 100);
    memColor = memPct > 90 ? 'red' : memPct > 70 ? 'yellow' : 'green';
  }

  // 磁盘使用率
  const diskPct = si.diskUsePct ? parseInt(si.diskUsePct) : 0;
  const diskColor = diskPct > 90 ? 'red' : diskPct > 70 ? 'yellow' : 'green';

  let html = `
    <div class="section-title">连接</div>
    <div class="stat-row"><span class="stat-label">SSH 延迟</span><span class="stat-value green">${node.sshLatencyMs}ms</span></div>
    <div class="stat-row"><span class="stat-label">最后更新</span><span class="stat-value">${node.lastUpdate ? new Date(node.lastUpdate).toLocaleString() : '—'}</span></div>
  `;

  // 系统信息
  if (Object.keys(si).length) {
    html += `<div class="section-title">系统</div>`;
    if (si.os)       html += `<div class="stat-row"><span class="stat-label">操作系统</span><span class="stat-value">${escHtml(si.os)}</span></div>`;
    if (si.kernel)   html += `<div class="stat-row"><span class="stat-label">内核</span><span class="stat-value">${escHtml(si.kernel)} ${escHtml(si.arch || '')}</span></div>`;
    if (si.hostname) html += `<div class="stat-row"><span class="stat-label">主机名</span><span class="stat-value">${escHtml(si.hostname)}</span></div>`;
    if (si.uptime)   html += `<div class="stat-row"><span class="stat-label">运行时长</span><span class="stat-value">${escHtml(si.uptime)}</span></div>`;

    if (si.cpuModel) {
      html += `<div class="section-title">CPU</div>`;
      html += `<div class="stat-row"><span class="stat-label">型号</span><span class="stat-value">${escHtml(si.cpuModel)}</span></div>`;
      if (si.cpuCores) html += `<div class="stat-row"><span class="stat-label">核心数</span><span class="stat-value">${si.cpuCores}</span></div>`;
      if (si.loadAvg) html += `<div class="stat-row"><span class="stat-label">负载</span><span class="stat-value">${escHtml(si.loadAvg)}</span></div>`;
    }

    if (si.memTotalMB > 0) {
      html += `<div class="section-title">内存</div>`;
      html += `<div class="stat-row"><span class="stat-label">已用 / 总计</span><span class="stat-value ${memColor}">${si.memUsedMB}MB / ${si.memTotalMB}MB (${memPct}%)</span></div>`;
      html += `<div class="usage-bar"><div class="usage-fill ${memColor}" style="width:${memPct}%"></div></div>`;
    }

    if (si.diskTotal) {
      html += `<div class="section-title">磁盘 /</div>`;
      html += `<div class="stat-row"><span class="stat-label">已用 / 总计</span><span class="stat-value ${diskColor}">${escHtml(si.diskUsed)} / ${escHtml(si.diskTotal)} (${escHtml(si.diskUsePct)})</span></div>`;
      html += `<div class="usage-bar"><div class="usage-fill ${diskColor}" style="width:${diskPct}%"></div></div>`;
    }
  }

  // OpenClaw 信息
  html += `<div class="section-title">OpenClaw</div>`;
  if (node.clawToken) {
    html += `<div class="stat-row"><span class="stat-label">Gateway</span><span class="stat-value green">端口 ${node.clawPort || 18789}</span></div>`;
    html += `<div class="stat-row"><span class="stat-label">Token</span><span class="stat-value">${escHtml(node.clawToken)}</span></div>`;
    html += `<div class="stat-row"><span class="stat-label">状态</span><span class="stat-value" id="claw-status-val">—</span></div>`;
    html += `<div style="padding:8px 0"><button class="confirm-btn" onclick="fetchClawStatus('${nodeId}')">查看状态</button></div>`;
  } else {
    html += `<div class="stat-row"><span class="stat-label">状态</span><span class="stat-value yellow">未安装</span></div>`;
    html += `<div style="padding:8px 0"><button class="confirm-btn" onclick="document.querySelector('#ai-input').value='安装 openclaw ${nodeId}';sendAiMessage()">安装 OpenClaw</button></div>`;
  }

  if (node.core && Object.keys(node.core).length) {
    html += `<div class="section-title">GNB</div>`;
    for (const [key, val] of Object.entries(node.core)) {
      html += `<div class="stat-row"><span class="stat-label">${escHtml(key)}</span><span class="stat-value">${escHtml(String(val))}</span></div>`;
    }
  }

  if (node.nodes && node.nodes.length) {
    html += `<div class="section-title">GNB 节点 (${node.nodes.length})</div>`;
    html += `<table class="sub-node-table"><thead><tr><th>UUID</th><th>TUN</th><th>状态</th><th>延迟</th><th>流入</th><th>流出</th></tr></thead><tbody>`;
    for (const sn of node.nodes) {
      const sc = sn.status === 'Direct' ? 'green' : sn.status === 'Detecting' ? 'yellow' : 'red';
      html += `<tr><td>${escHtml(sn.uuid64||'—')}</td><td>${escHtml(sn.tunAddr4||'—')}</td><td class="${sc}">${escHtml(sn.status||'—')}</td><td>${sn.latency4Usec ? `${(sn.latency4Usec/1000).toFixed(1)}ms` : '—'}</td><td>${formatBytes(sn.inBytes||0)}</td><td>${formatBytes(sn.outBytes||0)}</td></tr>`;
    }
    html += `</tbody></table>`;
  }

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
