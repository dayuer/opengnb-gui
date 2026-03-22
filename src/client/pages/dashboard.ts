// @alpha: dashboard 页面模块 (TS 迁移 — Alpha pass)
import { $, $$, L, refreshIcons, escHtml, showToast, formatBytes, formatUptime, pctColor, pctBg, safeAttr, cidrMatch, isValidCidr } from '../utils';
import { Modal } from '../modal';
import { App } from '../core';


// @alpha: 仪表盘 — Stitch "Global Management Dashboard" 风格

let metricsRange = '1h';
let metricsSummary = null;

function switchMetricsRange(range) {
  metricsRange = range;
  Dashboard.render($('#main-content'));
}

export const Dashboard = {
  async render(container) {
    const { nodesData, pendingNodes, nodeGroups } = App;
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

    try { const r = await App.authFetch('/api/nodes/metrics/summary'); metricsSummary = await r.json(); } catch (_) {}
    const ms = metricsSummary || {};
    const alerts = ms.alertCount || 0;

    // 计算集群指标
    const cpuPct = ms.avgCpu ?? 0;
    const memPct = ms.avgMemPct ?? 0;
    const diskPct = ms.avgDiskPct ?? 0;
    const latency = ms.avgLatency ?? 0;

    let html = `<div class="space-y-8">`;

    // ── 页面标题区域（Stitch 风格） ──
    html += `<div class="flex items-end justify-between">
      <div>
        <h1 class="text-3xl font-extrabold tracking-tight font-headline mb-2">节点管理仪表盘</h1>
        <p class="text-text-muted max-w-xl leading-relaxed">P2P VPN 集群总览 — 实时监控节点健康、资源使用和网络连接状态。</p>
      </div>
      <button class="signature-gradient text-white px-5 py-2.5 rounded-lg font-bold text-sm shadow-ambient flex items-center gap-2 hover:scale-[1.02] active:scale-95 transition-transform cursor-pointer" onclick="App.switchPage('settings')">
        ${L('plus')}<span>注册节点</span>
      </button>
    </div>`;

    // ── 4 列汇总卡片（Stitch Metric Cards Grid） ──
    html += `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">`;

    // 活跃节点
    const onlinePct = total > 0 ? Math.round(online / total * 100) : 0;
    html += this._metricCard({
      icon: 'globe', iconBg: 'bg-primary/10', iconColor: 'text-primary',
      label: '活跃节点', value: `${online}/${total}`,
      badge: total > 0 ? `${onlinePct}%` : null,
      badgeClass: onlinePct > 80 ? 'text-success bg-secondary-container' : 'text-warning bg-error-container',
      footer: `<div class="mt-4 w-full bg-surface-container rounded-full h-1.5 overflow-hidden"><div class="signature-gradient h-full rounded-full" style="width:${onlinePct}%"></div></div>`
    });

    // CPU
    html += this._metricCard({
      icon: 'cpu', iconBg: cpuPct > 80 ? 'bg-danger/10' : 'bg-primary/10',
      iconColor: cpuPct > 80 ? 'text-danger' : 'text-primary',
      label: 'CPU 使用率', value: cpuPct > 0 ? `${cpuPct}%` : '—',
      badge: cpuPct > 80 ? 'High' : null,
      badgeClass: 'text-danger bg-error-container',
      footer: cpuPct > 0 ? `<div class="mt-4 w-full bg-surface-container rounded-full h-1.5 overflow-hidden"><div class="${cpuPct > 80 ? 'bg-danger' : 'signature-gradient'} h-full rounded-full" style="width:${cpuPct}%"></div></div>` : ''
    });

    // 内存
    html += this._metricCard({
      icon: 'memory-stick', iconBg: 'bg-secondary/10', iconColor: 'text-secondary',
      label: '内存使用率', value: memPct > 0 ? `${memPct}%` : '—',
      badge: memPct > 80 ? 'High' : null,
      badgeClass: 'text-danger bg-error-container',
      footer: memPct > 0 ? `<div class="mt-4 w-full bg-surface-container rounded-full h-1.5 overflow-hidden"><div class="bg-secondary h-full rounded-full" style="width:${memPct}%"></div></div>` : ''
    });

    // P2P / 告警
    const hasAlert = alerts > 0 || pending > 0;
    html += this._metricCard({
      icon: 'link', iconBg: hasAlert ? 'bg-warning/10' : 'bg-primary/10',
      iconColor: hasAlert ? 'text-warning' : 'text-primary',
      label: 'P2P 连接', value: `${directPeers}/${totalPeers}`,
      badge: hasAlert ? `${alerts + pending} 告警` : null,
      badgeClass: 'text-danger bg-error-container',
      footer: `<div class="mt-4 flex gap-1 items-end h-8">
        ${[40,60,80,50,70,90,65].map(h => `<div class="w-1.5 rounded-full bg-primary/${20+h/3|0}" style="height:${h}%"></div>`).join('')}
      </div>`
    });

    html += `</div>`;

    // ── 时段切换 + 趋势图区域  ──
    html += `<div class="bg-surface p-8 rounded-lg shadow-ambient relative overflow-hidden border border-border-default">
      <div class="flex justify-between items-center mb-8">
        <div>
          <h2 class="text-xl font-bold font-headline">集群趋势（最近 ${metricsRange === '1h' ? '1 小时' : metricsRange === '6h' ? '6 小时' : '24 小时'}）</h2>
          <p class="text-sm text-text-muted mt-1">跨节点聚合 CPU、内存、延迟数据</p>
        </div>
        <div class="flex gap-2">
          ${['1h','6h','24h'].map(r => `<button class="px-4 py-2 rounded-lg text-xs font-medium transition cursor-pointer ${metricsRange === r ? 'signature-gradient text-white' : 'bg-elevated text-text-secondary hover:bg-surface-container'}" onclick="switchMetricsRange('${r}')">${r}</button>`).join('')}
        </div>
      </div>
      <div class="h-48 w-full relative">
        <svg class="w-full h-full" viewBox="0 0 1000 200" preserveAspectRatio="none">
          <defs>
            <linearGradient id="cpuGrad" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stop-color="#4b41e1" stop-opacity="0.15"/>
              <stop offset="100%" stop-color="#4b41e1" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <path d="M0,150 Q100,120 200,160 T400,100 T600,140 T800,80 T1000,120 L1000,200 L0,200 Z" fill="url(#cpuGrad)"/>
          <path d="M0,150 Q100,120 200,160 T400,100 T600,140 T800,80 T1000,120" fill="none" stroke="#4b41e1" stroke-width="3" stroke-linecap="round"/>
          <path d="M0,120 Q150,80 300,110 T600,50 T900,90 T1000,70" fill="none" stroke="#645efb" stroke-width="2" stroke-dasharray="8 4" stroke-opacity="0.5"/>
        </svg>
        <div class="absolute bottom-0 left-0 right-0 flex justify-between pt-3 text-xs font-bold text-text-muted uppercase tracking-widest border-t border-border-subtle">
          <span>00:00</span><span>04:00</span><span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span><span>23:59</span>
        </div>
      </div>
    </div>`;

    // ── 底部 2:1 网格: 节点概览(分组) + 资源分配 ──
    html += `<div class="grid grid-cols-1 lg:grid-cols-3 gap-8">`;

    // 左 2/3: 节点分组列表
    html += `<div class="lg:col-span-2 bg-surface p-8 rounded-lg shadow-ambient border border-border-default">
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-xl font-bold font-headline">节点列表</h2>
        <button class="text-primary text-xs font-bold flex items-center gap-1 hover:underline cursor-pointer" onclick="App.switchPage('nodes')">
          查看全部 ${L('chevron-right')}
        </button>
      </div>
      <div class="space-y-1">`;

    if (total > 0) {
      // 按分组聚合
      const groupMap = new Map();
      for (const node of nodesData) {
        const gid = node.groupId || '__none';
        if (!groupMap.has(gid)) groupMap.set(gid, []);
        groupMap.get(gid).push(node);
      }
      const orderedGroupIds = nodeGroups.map(g => g.id);
      if (groupMap.has('__none')) orderedGroupIds.push('__none');

      for (const gid of orderedGroupIds) {
        const nodes = groupMap.get(gid);
        if (!nodes || nodes.length === 0) continue;
        const group = nodeGroups.find(g => g.id === gid);
        const gName = group ? group.name : '未分组';
        const gOnline = nodes.filter(n => n.online).length;

        // 分组行（Stitch event style）
        html += `<button type="button" class="w-full group flex items-center justify-between p-4 rounded-lg hover:bg-elevated transition-colors cursor-pointer" onclick="Dashboard.toggleGroup('${safeAttr(gid)}')">
          <div class="flex items-center gap-4">
            <div class="w-10 h-10 rounded-full ${gOnline === nodes.length ? 'bg-secondary-container text-success' : 'bg-surface-container text-text-muted'} flex items-center justify-center [&_svg]:w-5 [&_svg]:h-5">
              ${L(gOnline === nodes.length ? 'check-circle-2' : 'layers')}
            </div>
            <div>
              <p class="text-sm font-bold text-left">${escHtml(gName)}</p>
              <p class="text-xs text-text-muted">${gOnline}/${nodes.length} 在线</p>
            </div>
          </div>
          <span class="text-xs font-bold text-text-muted uppercase tracking-widest" aria-hidden="true">${L('chevron-down')}</span>
        </button>`;

        // 展开的节点列表
        html += `<div id="group-acc-${safeAttr(gid)}" class="ml-14 space-y-0.5 mb-2">`;
        for (const node of nodes) {
          const si = node.sysInfo || {};
          const nCpu = si.cpuUsage ?? 0;
          const nMem = si.memTotalMB > 0 ? Math.round(si.memUsedMB / si.memTotalMB * 100) : 0;
          html += `<button type="button" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-elevated/50 transition-colors cursor-pointer" onclick="App.switchPage('nodes');setTimeout(()=>Nodes.expandRow('${safeAttr(node.id)}'),200)">
            <span class="w-2 h-2 rounded-full shrink-0 ${node.online ? 'bg-success' : 'bg-danger'}" aria-hidden="true"></span>
            <span class="text-sm font-medium min-w-[100px] text-left">${escHtml(node.name || node.id)}</span>
            <span class="text-xs text-text-muted font-mono">${escHtml(node.tunAddr || '—')}</span>
            <div class="flex-1"></div>
            ${node.online ? `<span class="text-xs ${pctColor(nCpu)}">CPU ${nCpu}%</span><span class="text-xs ${pctColor(nMem)}">MEM ${nMem}%</span>` : '<span class="text-xs text-danger">离线</span>'}
          </button>`;
        }
        html += `</div>`;
      }
    } else {
      html += `<div class="flex flex-col items-center justify-center h-32 text-text-muted">
        ${L('inbox')}<span class="mt-2 text-sm">暂无节点数据</span>
      </div>`;
    }

    html += `</div></div>`;

    // 右 1/3: 资源分配甜甜圈图
    const onlineCount = online;
    const offlineCount = offline;
    const pendingCount = pending;
    const totalSlice = onlineCount + offlineCount + pendingCount || 1;
    const onlineArc = Math.round(onlineCount / totalSlice * 251);
    const offlineArc = Math.round(offlineCount / totalSlice * 251);
    const pendingArc = Math.round(pendingCount / totalSlice * 251);

    html += `<div class="bg-surface p-8 rounded-lg shadow-ambient border border-border-default">
      <h2 class="text-xl font-bold font-headline mb-6">节点分布</h2>
      <div class="relative w-48 h-48 mx-auto mb-8">
        <svg class="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="40" fill="transparent" stroke="#eceef0" stroke-width="12"/>
          <circle cx="50" cy="50" r="40" fill="transparent" stroke="#4b41e1" stroke-width="12" stroke-dasharray="${onlineArc} 251"/>
          <circle cx="50" cy="50" r="40" fill="transparent" stroke="#82f5c1" stroke-width="12" stroke-dasharray="${offlineArc} 251" stroke-dashoffset="-${onlineArc}"/>
          ${pendingArc > 0 ? `<circle cx="50" cy="50" r="40" fill="transparent" stroke="#ffb4ab" stroke-width="12" stroke-dasharray="${pendingArc} 251" stroke-dashoffset="-${onlineArc + offlineArc}"/>` : ''}
        </svg>
        <div class="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span class="text-2xl font-extrabold font-headline tabular-nums">${total}</span>
          <span class="text-xs text-text-muted uppercase font-bold tracking-widest">节点</span>
        </div>
      </div>
      <div class="space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 rounded-full bg-primary"></div>
            <span class="text-xs font-medium">在线</span>
          </div>
          <span class="text-xs font-bold">${onlineCount}</span>
        </div>
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 rounded-full bg-secondary-container"></div>
            <span class="text-xs font-medium">离线</span>
          </div>
          <span class="text-xs font-bold">${offlineCount}</span>
        </div>
        ${pendingCount > 0 ? `<div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <div class="w-2 h-2 rounded-full bg-error-container"></div>
            <span class="text-xs font-medium">待审批</span>
          </div>
          <span class="text-xs font-bold">${pendingCount}</span>
        </div>` : ''}
      </div>
    </div>`;

    html += `</div></div>`;
    container.innerHTML = html;
    refreshIcons();
  },

  // @alpha: Stitch 风格 Metric Card
  _metricCard({ icon, iconBg, iconColor, label, value, badge, badgeClass, footer }) {
    return `<div class="bg-surface p-6 rounded-lg shadow-ambient border border-border-default">
      <div class="flex justify-between items-start mb-4">
        <div class="w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center ${iconColor} [&_svg]:w-5 [&_svg]:h-5">
          ${L(icon)}
        </div>
        ${badge ? `<span class="text-xs font-bold uppercase tracking-widest ${badgeClass} px-2 py-0.5 rounded-full">${badge}</span>` : ''}
      </div>
      <p class="text-xs font-medium text-text-muted uppercase tracking-wider mb-1">${label}</p>
      <h3 class="text-2xl font-bold tabular-nums">${value}</h3>
      ${footer || ''}
    </div>`;
  },

  toggleGroup(gid) {
    const el = $(`#group-acc-${CSS.escape(gid)}`);
    if (el) el.classList.toggle('hidden');
  },
};
