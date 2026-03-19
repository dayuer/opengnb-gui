'use strict';

/**
 * @alpha: 监控仪表盘增强模块 — 时序趋势图 + 汇总卡 + 告警标记
 * 依赖: app.js 中的 authFetch, escHtml, safeAttr, pctColor, formatBytes, L, refreshIcons, $, $$
 */

// 指标缓存
let metricsCache = {};
let metricsRange = '1h';
let metricsSummary = null;

/**
 * 切换时段并重新渲染仪表盘
 */
function switchMetricsRange(range) {
  metricsRange = range;
  metricsCache = {};
  renderDashboardPage(document.querySelector('#main-content'));
}

/**
 * 加载指标数据并绘制 Canvas 迷你趋势图
 */
async function loadAndDrawSparklines(nodeId) {
  try {
    if (!metricsCache[nodeId] || metricsCache[nodeId].range !== metricsRange) {
      const res = await authFetch(`/api/nodes/metrics?nodeId=${encodeURIComponent(nodeId)}&range=${metricsRange}`);
      metricsCache[nodeId] = { range: metricsRange, ...(await res.json()) };
    }
    const pts = metricsCache[nodeId].points || [];
    if (pts.length < 2) return;
    drawSparkline(`spark-cpu-${nodeId}`, pts.map(p => p.cpu), { color: '#3b82f6', threshold: 90 });
    drawSparkline(`spark-mem-${nodeId}`, pts.map(p => p.memPct), { color: '#8b5cf6', threshold: 85 });
    drawSparkline(`spark-lat-${nodeId}`, pts.map(p => p.sshLatency), { color: '#06b6d4', threshold: 1000 });
  } catch (_) { /* 指标加载失败不影响主页面 */ }
}

/**
 * 纯 Canvas 迷你折线图
 */
function drawSparkline(id, vals, opts = {}) {
  const c = document.getElementById(id);
  if (!c || vals.length < 2) return;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height, pad = 2;
  ctx.clearRect(0, 0, w, h);

  const mx = Math.max(...vals, opts.threshold || 0) * 1.1 || 1;
  const step = (w - pad * 2) / (vals.length - 1);
  const yOf = v => h - pad - (v / mx) * (h - pad * 2);

  // 填充渐变
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, (opts.color || '#3b82f6') + '40');
  grad.addColorStop(1, (opts.color || '#3b82f6') + '05');
  ctx.beginPath();
  ctx.moveTo(pad, h - pad);
  for (let i = 0; i < vals.length; i++) ctx.lineTo(pad + i * step, yOf(vals[i]));
  ctx.lineTo(pad + (vals.length - 1) * step, h - pad);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // 折线
  ctx.beginPath();
  for (let i = 0; i < vals.length; i++) {
    const x = pad + i * step;
    i === 0 ? ctx.moveTo(x, yOf(vals[i])) : ctx.lineTo(x, yOf(vals[i]));
  }
  ctx.strokeStyle = opts.color || '#3b82f6';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 阈值线
  if (opts.threshold) {
    const ty = yOf(opts.threshold);
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(pad, ty);
    ctx.lineTo(w - pad, ty);
    ctx.strokeStyle = '#ef444480';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // @beta: 从 CSS 变量读取文字色，适配亮色/暗色主题
  ctx.font = '9px sans-serif';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#fff';
  ctx.textAlign = 'right';
  ctx.fillText(String(vals[vals.length - 1]), w - pad, 10);
}

/**
 * 生成告警汇总卡片 HTML
 */
function dashCardAlert(alerts, pending) {
  const color = alerts > 0 ? 'red' : pending > 0 ? 'yellow' : 'green';
  const sub = alerts > 0 ? alerts + ' 告警' : pending > 0 ? pending + ' 待审批' : '系统正常';
  return `<div class="dash-card ${alerts > 0 ? 'alert-glow' : ''}">
    <div class="dc-title">${L('bell')} 告警</div>
    <div class="dc-value ${color}">${alerts + pending}</div>
    <div class="dc-sub">${escHtml(sub)}</div>
  </div>`;
}

/**
 * 生成节点手风琴展开面板（含迷你趋势图）
 */
function renderNodeAccordionPanel(node) {
  const si = node.sysInfo || {};
  const memPct = si.memTotalMB > 0 ? Math.round(si.memUsedMB / si.memTotalMB * 100) : 0;
  const diskPct = si.diskUsePct ? parseInt(si.diskUsePct) : 0;
  const cpuPct = si.cpuUsage || 0;
  const peers = node.nodes || [];
  const totalP = peers.length;
  const directP = peers.filter(p => p.status === 'Direct').length;
  const directRate = totalP > 0 ? Math.round(directP / totalP * 100) : 0;
  const totalIn = peers.reduce((s, n) => s + (n.inBytes || 0), 0);
  const totalOut = peers.reduce((s, n) => s + (n.outBytes || 0), 0);

  // 告警检测
  const na = [];
  if (cpuPct > 90) na.push('CPU');
  if (memPct > 85) na.push('MEM');
  if (diskPct > 90) na.push('DISK');
  if (node.sshLatencyMs > 1000) na.push('延迟');
  const hasAlert = na.length > 0;

  let html = `<div class="accordion-item ${hasAlert ? 'has-alert' : ''}" data-node-id="${safeAttr(node.id)}">`;

  // 行头
  html += `<div class="accordion-header" onclick="toggleAccordion('${safeAttr(node.id)}')">
    <div class="acc-left">
      <span class="node-dot ${node.online ? 'online' : 'offline'}"></span>
      ${hasAlert ? '<span class="alert-pulse"></span>' : ''}
      <span class="acc-name">${escHtml(node.name || node.id)}</span>
      <span class="acc-addr">${escHtml(node.tunAddr)}</span>
      ${hasAlert ? `<span class="alert-badge">${na.join('·')}</span>` : ''}
    </div>
    <div class="acc-right">
      <span class="acc-stat ${pctColor(cpuPct)}">${cpuPct > 0 ? cpuPct + '%' : '—'}</span>
      <span class="acc-stat ${pctColor(memPct)}">${memPct > 0 ? memPct + '%' : '—'}</span>
      <span class="acc-stat ${pctColor(diskPct)}">${diskPct > 0 ? diskPct + '%' : '—'}</span>
      <span class="acc-stat">${node.online ? node.sshLatencyMs + 'ms' : '—'}</span>
      <span class="acc-chevron">${L('chevron-down')}</span>
    </div>
  </div>`;

  // 展开面板
  html += `<div class="accordion-panel" id="acc-panel-${safeAttr(node.id)}">`;
  if (node.online) {
    // 迷你趋势图
    html += `<div class="sparkline-row">
      <div class="sparkline-card"><div class="sl-label">CPU</div><canvas class="sparkline-canvas" id="spark-cpu-${safeAttr(node.id)}" width="200" height="40"></canvas></div>
      <div class="sparkline-card"><div class="sl-label">内存</div><canvas class="sparkline-canvas" id="spark-mem-${safeAttr(node.id)}" width="200" height="40"></canvas></div>
      <div class="sparkline-card"><div class="sl-label">延迟</div><canvas class="sparkline-canvas" id="spark-lat-${safeAttr(node.id)}" width="200" height="40"></canvas></div>
    </div>`;
    // 指标面板
    html += `<div class="acc-grid">`;
    html += `<div class="acc-metric">${L('cpu')} <b>CPU</b> <span class="${pctColor(cpuPct)}">${cpuPct}% · ${si.cpuCores || '—'}核 · ${escHtml(si.loadAvg || '—')}</span></div>`;
    html += `<div class="acc-metric">${L('activity')} <b>SSH</b> <span class="${node.sshLatencyMs > 500 ? 'red' : node.sshLatencyMs > 200 ? 'yellow' : 'green'}">${node.sshLatencyMs}ms</span></div>`;
    html += `<div class="acc-metric">${L('link')} <b>P2P</b> <span>${directP}/${totalP} <small>(${directRate}%)</small></span></div>`;
    html += `<div class="acc-metric">${L('download')} <b>流入</b> <span class="accent">${formatBytes(totalIn)}</span></div>`;
    html += `<div class="acc-metric">${L('upload')} <b>流出</b> <span class="accent">${formatBytes(totalOut)}</span></div>`;
    html += `<div class="acc-metric">${L('memory-stick')} <b>内存</b> <span class="${pctColor(memPct)}">${memPct}% <small>(${si.memUsedMB || 0}/${si.memTotalMB || 0}MB)</small></span></div>`;
    html += `<div class="acc-metric">${L('hard-drive')} <b>磁盘</b> <span class="${pctColor(diskPct)}">${diskPct}% <small>(${escHtml(si.diskUsed || '—')}/${escHtml(si.diskTotal || '—')})</small></span></div>`;
    html += `<div class="acc-metric">${L('monitor')} <b>系统</b> <span>${escHtml(si.hostname || '—')} · ${escHtml(si.os || '—')}</span></div>`;
    html += `<div class="acc-metric">${L('wrench')} <b>内核</b> <span>${escHtml(si.kernel || '—')} ${escHtml(si.arch || '')}</span></div>`;
    html += `<div class="acc-metric">${L('clock')} <b>运行</b> <span>${escHtml(si.uptime || '—')}</span></div>`;
    const clawText = node.clawToken ? `已配置 (端口 ${node.clawPort || 18789})` : '未安装';
    html += `<div class="acc-metric">${L('bot')} <b>Claw</b> <span class="${node.clawToken ? 'green' : 'yellow'}">${clawText}</span></div>`;
    html += `</div>`;
  } else {
    html += `<div class="acc-offline">${L('zap')} 节点不可达 — ${escHtml(node.error || 'SSH 连接超时')}</div>`;
  }
  html += `</div></div>`;
  return html;
}
