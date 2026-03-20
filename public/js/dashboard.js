'use strict';
// @alpha: 仪表盘模块

let metricsRange = '1h';
let metricsSummary = null;

function switchMetricsRange(range) {
  metricsRange = range;
  Dashboard.render($('#main-content'));
}

const Dashboard = {
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

    let html = `<div class="space-y-6">`;

    // 汇总卡片
    html += `<div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">`;
    html += this._card(L('globe'), '节点', `${total}`, 'text-primary', `在线 ${online} / 离线 ${offline}`);
    html += this._card(L('cpu'), 'CPU', ms.avgCpu != null ? `${ms.avgCpu}%` : '—', pctColor(ms.avgCpu || 0), '集群均值');
    html += this._card(L('memory-stick'), '内存', ms.avgMemPct != null ? `${ms.avgMemPct}%` : '—', pctColor(ms.avgMemPct || 0), '集群均值');
    html += this._card(L('hard-drive'), '磁盘', ms.avgDiskPct != null ? `${ms.avgDiskPct}%` : '—', pctColor(ms.avgDiskPct || 0), '集群均值');
    html += this._card(L('activity'), '延迟', ms.avgLatency != null ? `${ms.avgLatency}ms` : '—', ms.avgLatency > 500 ? 'text-danger' : ms.avgLatency > 200 ? 'text-warning' : 'text-success', 'SSH 均值');
    html += this._card(L('link'), 'P2P', `${directPeers}/${totalPeers}`, directPeers > 0 ? 'text-success' : 'text-danger', totalPeers > 0 ? `${Math.round(directPeers/totalPeers*100)}% 直连` : '无连接');
    html += this._alertCard(alerts, pending);
    html += `</div>`;

    // 时段切换器
    html += `<div class="flex items-center gap-2">
      <span class="text-xs text-text-muted">趋势:</span>
      ${['1h','6h','24h'].map(r => `<button class="px-3 py-1 text-xs rounded-md transition cursor-pointer ${metricsRange===r ? 'bg-primary text-white' : 'bg-elevated text-text-secondary hover:text-text-primary'}" onclick="switchMetricsRange('${r}')">${r}</button>`).join('')}
    </div>`;

    // 节点概览 — 按分组汇总
    if (total > 0) {
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
        const gColor = group ? group.color : '#5c5c6e';
        const gOnline = nodes.filter(n => n.online).length;
        const gTotal = nodes.length;

        const onlineNodes = nodes.filter(n => n.online && n.sysInfo);
        let gCpu = 0, gMem = 0, gDisk = 0;
        if (onlineNodes.length > 0) {
          gCpu = Math.round(onlineNodes.reduce((s, n) => s + (n.sysInfo?.cpuUsage || 0), 0) / onlineNodes.length);
          gMem = Math.round(onlineNodes.reduce((s, n) => { const si = n.sysInfo || {}; return s + (si.memTotalMB > 0 ? (si.memUsedMB / si.memTotalMB * 100) : 0); }, 0) / onlineNodes.length);
          gDisk = Math.round(onlineNodes.reduce((s, n) => s + (parseInt(n.sysInfo?.diskUsePct) || 0), 0) / onlineNodes.length);
        }

        html += `<div class="bg-surface rounded-lg border border-border-default overflow-hidden">
          <div class="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-elevated transition" onclick="Dashboard.toggleGroup('${safeAttr(gid)}')">
            <div class="flex items-center gap-2">
              <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${escHtml(gColor)}"></span>
              <span class="font-medium text-sm">${escHtml(gName)}</span>
              <span class="text-xs text-text-muted">${gOnline}/${gTotal} 在线</span>
            </div>
            <div class="flex items-center gap-4 text-xs">
              <span class="${pctColor(gCpu)}">CPU ${gCpu}%</span>
              <span class="${pctColor(gMem)}">内存 ${gMem}%</span>
              <span class="${pctColor(gDisk)}">磁盘 ${gDisk}%</span>
              <span class="text-text-muted">${L('chevron-down')}</span>
            </div>
          </div>
          <div id="group-acc-${safeAttr(gid)}" class="border-t border-border-subtle">`;

        for (const node of nodes) {
          const si = node.sysInfo || {};
          const cpuPct = si.cpuUsage ?? 0;
          const memPct = si.memTotalMB > 0 ? Math.round(si.memUsedMB / si.memTotalMB * 100) : 0;
          html += `<div class="flex items-center gap-3 px-4 py-2.5 border-b border-border-subtle last:border-0 hover:bg-elevated/50 transition cursor-pointer" onclick="App.switchPage('nodes');setTimeout(()=>Nodes.expandRow('${safeAttr(node.id)}'),200)">
            <span class="w-2 h-2 rounded-full shrink-0 ${node.online ? 'bg-success' : 'bg-danger'}"></span>
            <span class="text-sm font-medium min-w-[120px]">${escHtml(node.name || node.id)}</span>
            <span class="text-xs text-text-muted font-mono">${escHtml(node.tunAddr || '—')}</span>
            <div class="flex-1"></div>
            ${node.online ? `
              <span class="text-xs ${pctColor(cpuPct)}">CPU ${cpuPct}%</span>
              <span class="text-xs ${pctColor(memPct)}">内存 ${memPct}%</span>
              <span class="text-xs text-text-muted">${node.sshLatencyMs || 0}ms</span>
            ` : `<span class="text-xs text-danger">离线</span>`}
          </div>`;
        }
        html += `</div></div>`;
      }
    } else {
      html += `<div class="flex flex-col items-center justify-center h-40 text-text-muted">
        ${L('inbox')}<span class="mt-2 text-sm">暂无节点数据</span></div>`;
    }

    html += `</div>`;
    container.innerHTML = html;
    refreshIcons();
  },

  _card(icon, title, value, color, sub) {
    return `<div class="bg-surface rounded-lg border border-border-default p-4">
      <div class="flex items-center gap-2 text-text-muted mb-2"><span class="[&_svg]:w-4 [&_svg]:h-4">${icon}</span><span class="text-xs">${title}</span></div>
      <div class="text-2xl font-bold ${color}">${value}</div>
      ${sub ? `<div class="text-xs text-text-muted mt-0.5">${sub}</div>` : ''}
    </div>`;
  },

  _alertCard(alerts, pending) {
    const hasAlert = alerts > 0 || pending > 0;
    return `<div class="bg-surface rounded-lg border ${hasAlert ? 'border-warning/30' : 'border-border-default'} p-4">
      <div class="flex items-center gap-2 text-text-muted mb-2"><span class="[&_svg]:w-4 [&_svg]:h-4">${L('bell')}</span><span class="text-xs">告警</span></div>
      <div class="text-2xl font-bold ${hasAlert ? 'text-warning' : 'text-success'}">${alerts > 0 ? alerts : '—'}</div>
      <div class="text-xs text-text-muted mt-0.5">${pending > 0 ? `${pending} 待审批` : '无告警'}</div>
    </div>`;
  },

  toggleGroup(gid) {
    const el = $(`#group-acc-${CSS.escape(gid)}`);
    if (el) el.classList.toggle('hidden');
  },
};
