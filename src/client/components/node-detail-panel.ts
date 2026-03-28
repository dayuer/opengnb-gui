/**
 * node-detail-panel.ts — 节点详情面板（主路由 + 概览 + 技能）
 *
 * 架构：主面板仅保留 Tab 路由调度、概览和技能两个同步渲染模块。
 * OpenClaw / Chat / Tasks 等异步加载模块已提取为独立组件：
 *   - claw-tab.ts    （status/config/sessions/models/channels + 防脑裂）
 *   - chat-tab.ts    （AI Chat WebSocket 终端）
 *   - task-tab.ts    （任务队列 + 技能操作）
 *   - panel-helpers.ts（nodeConfig 查找 + 错误渲染 + UI 原子）
 */
import { L, refreshIcons, escHtml, showToast, formatBytes, formatUptime, safeAttr } from '../utils';
import { App } from '../core';
import { getMonitorNode, statCard, gaugeCard } from './panel-helpers';
import { skillChip, storeSkillChip, skillSection } from './skill-card';

// ——— 子模块 re-export（保持 window.NodeDetailPanel 全局接口不变） ———
import * as ClawTab from './claw-tab';
import * as ChatTab from './chat-tab';
import * as TaskTab from './task-tab';

/** 节点详情面板模块 */
export const NodeDetailPanel = {

  // ═══════════════════════════════════════
  // Tab 路由调度
  // ═══════════════════════════════════════

  /** 渲染展开面板的完整内容（7 个 Tab） */
  renderInlineDetail(panel: any, node: any, tabState: any) {
    if (!node.online) {
      panel.innerHTML = `<div class="flex items-center gap-2 text-sm text-danger">${L('zap')} 节点不可达 — ${escHtml(node.error || '无上报数据')}
        <button class="ml-3 px-3 py-1 text-xs rounded-lg bg-primary hover:bg-primary-light text-white transition cursor-pointer" onclick="Nodes.provision('${safeAttr(node.id)}')">重新配置</button>
      </div>`;
      refreshIcons();
      return;
    }

    const ts = tabState;
    const tabs = [
      { key: 'overview', icon: 'bar-chart-3', label: '概览' },
      { key: 'tasks',    icon: 'list-todo',    label: '任务' },
      { key: 'claw',     icon: 'bot',          label: 'OpenClaw' },
      { key: 'models',   icon: 'sparkles',      label: 'AI 模型' },
      { key: 'channels', icon: 'radio',         label: '渠道' },
      { key: 'terminal', icon: 'terminal',      label: '终端' },
      { key: 'skills',   icon: 'blocks',        label: '技能' },
    ];

    let html = `<div>
      <div class="flex gap-1 mb-4 border-b border-border-subtle pb-2">
        ${tabs.map(t => `<button class="px-3 py-1.5 text-xs rounded-md transition cursor-pointer flex items-center gap-1.5 [&_svg]:w-3.5 [&_svg]:h-3.5 ${ts.tab === t.key ? 'bg-primary/10 text-primary font-medium' : 'text-text-secondary hover:text-text-primary hover:bg-elevated'}" onclick="Nodes.switchTab('${safeAttr(node.id)}','${t.key}')">${L(t.icon)} ${t.label}</button>`).join('')}
      </div>
      <div id="inline-tab-content-${safeAttr(node.id)}">`;

    if (ts.tab === 'overview') html += this.renderOverview(node);
    else if (ts.tab === 'terminal') html += ChatTab.renderTerminal(node);
    else if (ts.tab === 'skills') html += this.renderSkillsSkeleton(node.id);
    else html += `<div class="flex items-center gap-2 text-text-muted text-sm py-8 justify-center"><span class="[&_svg]:w-4 [&_svg]:h-4 animate-spin">${L('loader-2')}</span> 加载中…</div>`;

    html += `</div></div>`;
    panel.innerHTML = html;
    refreshIcons();

    // 异步 Tab 加载
    if (ts.tab === 'claw')     ClawTab.loadClawTab(node.id, ts.clawSubTab);
    if (ts.tab === 'models')   ClawTab.loadModelsTab(node.id);
    if (ts.tab === 'channels') ClawTab.loadChannelsTab(node.id);
    if (ts.tab === 'tasks')    TaskTab.loadTasksTab(node.id);
    if (ts.tab === 'terminal') ChatTab.initChat(node.id);
    if (ts.tab === 'skills')   this.loadSkillsTab(node);
  },

  // ═══════════════════════════════════════
  // 概览 Tab
  // ═══════════════════════════════════════

  renderOverview(node: any) {
    const si = node.sysInfo || {};
    const memPct = si.memTotalMB > 0 ? Math.round(si.memUsedMB / si.memTotalMB * 100) : 0;
    const diskPct = si.diskUsePct ? parseInt(si.diskUsePct) : 0;
    const cpuPct = si.cpuUsage ?? 0;
    const peers = node.nodes || [];
    const directP = peers.filter((p: any) => p.status === 'Direct').length;
    const totalIn = peers.reduce((s: any, n: any) => s + (n.inBytes || 0), 0);
    const totalOut = peers.reduce((s: any, n: any) => s + (n.outBytes || 0), 0);
    const oc = node.openclaw || {};
    const clawRunning = oc.running === true || oc.status === 'running';
    const clawCpuPct  = typeof oc.cpuPercent === 'number' ? oc.cpuPercent : null;

    let html = `<div class="space-y-4">`;
    html += `<div><div class="text-xs font-bold text-primary uppercase tracking-widest mb-2">运行状态</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${statCard(L('activity'), '采集延迟', `${node.sshLatencyMs||0}ms`, node.sshLatencyMs > 500 ? 'text-danger' : 'text-success')}
        ${statCard(L('clock'), '运行时长', si.uptime ? formatUptime(parseFloat(si.uptime)) : '—', '')}
        ${statCard(L('bot'), 'OpenClaw', clawRunning ? '运行中' : '未运行', clawRunning ? 'text-success' : 'text-warning',
          clawRunning && clawCpuPct !== null ? `CPU ${clawCpuPct}%` : '')}
        ${statCard(L('monitor'), '系统', escHtml(si.hostname || '—'), 'text-primary', escHtml(si.os || '—'))}
      </div></div>`;

    html += `<div><div class="text-xs font-bold text-success uppercase tracking-widest mb-2">资源使用</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${gaugeCard(L('cpu'), 'CPU', `${cpuPct}%`, cpuPct, si.cpuCores ? `${si.cpuCores} 核` : '')}
        ${gaugeCard(L('memory-stick'), '内存', `${memPct}%`, memPct, si.memTotalMB > 0 ? `${si.memUsedMB}/${si.memTotalMB} MB` : '')}
        ${gaugeCard(L('hard-drive'), '磁盘', `${diskPct}%`, diskPct, si.diskTotal ? `${escHtml(si.diskUsed)}/${escHtml(si.diskTotal)}` : '')}
        ${statCard(L('wrench'), '内核', escHtml(si.kernel || '—'), '', escHtml(si.arch || '—'))}
      </div></div>`;

    html += `<div><div class="text-xs font-bold text-info uppercase tracking-widest mb-2">P2P 网络</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${statCard(L('link'), '节点数', `${peers.length}`, 'text-primary', `直连 ${directP}`)}
        ${statCard(L('zap'), '直连率', peers.length > 0 ? `${Math.round(directP/peers.length*100)}%` : '—', directP >= peers.length * 0.8 ? 'text-success' : 'text-warning')}
        ${statCard(L('download'), '总流入', formatBytes(totalIn), 'text-primary')}
        ${statCard(L('upload'), '总流出', formatBytes(totalOut), 'text-warning')}
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

  // ═══════════════════════════════════════
  // 技能 Tab
  // ═══════════════════════════════════════

  renderSkillsSkeleton(nodeId: string) {
    const nid = safeAttr(nodeId);
    return `
    <div id="skills-panel-${nid}" class="px-6 pb-8 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
      <div class="flex items-center justify-between mb-6 border-b border-border-default/20 pb-4">
        <h4 class="text-xl font-headline font-bold tracking-tight text-text-primary">技能管理</h4>
        <button class="px-4 py-1.5 rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-white text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer" onclick="App.switchPage('skills')">
          <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('plus')}</span> 技能商店
        </button>
      </div>
      <div class="flex items-center gap-2 text-text-muted text-sm py-8 justify-center">
        <span class="[&_svg]:w-4 [&_svg]:h-4 animate-spin">${L('loader-2')}</span> 加载技能列表…
      </div>
    </div>`;
  },

  async loadSkillsTab(node: any) {
    const nid = node.id;
    const panel = document.getElementById(`skills-panel-${safeAttr(nid)}`);
    if (!panel) return;

    let storeSkills: any[] = [];
    try {
      const res = await App.authFetch('/api/skills');
      if (res.ok) {
        const data = await res.json();
        storeSkills = data.skills || [];
      }
    } catch (_) { /* 商店不可用时降级 */ }

    const monNode = getMonitorNode(nid);
    const installedSkills: any[] = monNode?.skills || node.skills || [];
    const readySkills: any[] = installedSkills.filter((s: any) => s.status === 'ready');
    const installedKeys = new Set(readySkills.flatMap((s: any) => [s.id, s.name].filter(Boolean)));

    const builtinInstalled   = readySkills.filter((s: any) => s.bundled === true);
    const customInstalled    = readySkills.filter((s: any) => s.bundled !== true);
    const builtinUninstalled = storeSkills.filter((s: any) => s.isBuiltin && !installedKeys.has(s.id) && !installedKeys.has(s.name));
    const customUninstalled  = storeSkills.filter((s: any) => !s.isBuiltin && !installedKeys.has(s.id) && !installedKeys.has(s.name));

    const skillsHtml = this._renderSkillsContent(nid, builtinInstalled, builtinUninstalled, customInstalled, customUninstalled);

    panel.innerHTML = `
      <div class="flex items-center justify-between mb-6 border-b border-border-default/20 pb-4">
        <h4 class="text-xl font-headline font-bold tracking-tight text-text-primary">技能管理</h4>
        <button class="px-4 py-1.5 rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-white text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer" onclick="App.switchPage('skills')">
          <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('plus')}</span> 技能商店
        </button>
      </div>
      ${skillsHtml}
    `;
    refreshIcons();
  },

  _renderSkillsContent(nodeId: string, builtinInstalled: any[], builtinUninstalled: any[], customInstalled: any[], customUninstalled: any[]) {
    const nid = safeAttr(nodeId);

    const builtinSection = skillSection({
      icon: 'cpu', iconColor: 'text-primary', title: '内置技能',
      count: builtinInstalled.length,
      installedHtml: builtinInstalled.map(s => skillChip(nid, s, true)).join(''),
      uninstalledHtml: builtinUninstalled.map(s => storeSkillChip(nid, s, true)).join(''),
      uninstalledCount: builtinUninstalled.length,
      emptyText: '暂无内置技能数据',
    });

    const customSection = skillSection({
      icon: 'blocks', iconColor: 'text-amber-400', title: '自定义技能',
      count: customInstalled.length,
      installedHtml: customInstalled.map(s => skillChip(nid, s, false)).join(''),
      uninstalledHtml: customUninstalled.map(s => storeSkillChip(nid, s, false)).join(''),
      uninstalledCount: customUninstalled.length,
      emptyText: '暂无自定义技能，前往技能商店添加',
    });

    return builtinSection + customSection;
  },

  // ═══════════════════════════════════════
  // 子模块代理（保持 window.NodeDetailPanel 全局 API 不变）
  // ═══════════════════════════════════════

  // Claw Tab
  loadClawTab: ClawTab.loadClawTab,
  renderConfigTab: ClawTab.renderConfigTab,
  onConfigInput: ClawTab.onConfigInput,
  saveClawConfig: ClawTab.saveClawConfig,
  resetClawConfig: ClawTab.resetClawConfig,
  loadModelsTab: ClawTab.loadModelsTab,
  loadChannelsTab: ClawTab.loadChannelsTab,
  restartOpenClaw: ClawTab.restartOpenClaw,
  updateOpenClaw: ClawTab.updateOpenClaw,

  // Chat Tab
  renderTerminal: ChatTab.renderTerminal,
  initChat: ChatTab.initChat,
  destroyChat: ChatTab.destroyChat,
  sendChat: ChatTab.sendChat,
  quickCmd: ChatTab.quickCmd,
  toggleTerminalSize: ChatTab.toggleTerminalSize,

  // Task Tab
  loadTasksTab: TaskTab.loadTasksTab,
  _deleteTask: TaskTab.deleteTask,
  loadTaskQueue: TaskTab.loadTaskQueue,
  _startTaskPoll: TaskTab.loadTaskQueue, // 兼容旧调用
  _stopTaskPoll: TaskTab.stopTaskPoll,
  reinstallTask: TaskTab.reinstallTask,
  deleteTask: TaskTab.deleteTask,
  uninstallSkill: TaskTab.uninstallSkill,
  deleteSkillFromStore: TaskTab.deleteSkillFromStore,

  // 兼容旧 UI 原子调用
  statCard,
  gaugeCard,
};
