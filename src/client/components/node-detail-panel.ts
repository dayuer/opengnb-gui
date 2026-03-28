// @alpha: 节点详情展开面板 — 从 nodes.ts 提取
// 包含：概览/终端/技能/OpenClaw 四个 Tab 的渲染和交互逻辑
import { $, L, refreshIcons, escHtml, showToast, formatBytes, formatUptime, pctColor, pctBg, safeAttr } from '../utils';
import { App } from '../core';

let _chatSessions: Record<string, any> = {};
let _termMaximized = false;

/** 节点详情面板模块 */
export const NodeDetailPanel = {

  /** 渲染展开面板的完整内容（4 个 Tab） */
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
    else if (ts.tab === 'terminal') html += this.renderTerminal(node);
    else if (ts.tab === 'skills') html += this.renderSkillsSkeleton(node.id);
    else html += `<div class="flex items-center gap-2 text-text-muted text-sm py-8 justify-center"><span class="[&_svg]:w-4 [&_svg]:h-4 animate-spin">${L('loader-2')}</span> 加载中…</div>`;

    html += `</div></div>`;
    panel.innerHTML = html;
    refreshIcons();

    if (ts.tab === 'claw')     this.loadClawTab(node.id, ts.clawSubTab);
    if (ts.tab === 'models')   this.loadModelsTab(node.id);
    if (ts.tab === 'channels') this.loadChannelsTab(node.id);
    if (ts.tab === 'tasks')    this.loadTasksTab(node.id);
    if (ts.tab === 'terminal') this.initChat(node.id);
    if (ts.tab === 'skills')   this.loadSkillsTab(node);
  },

  // ═══════════════════════════════════════
  // Tab 渲染
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
        ${this.statCard(L('activity'), '采集延迟', `${node.sshLatencyMs||0}ms`, node.sshLatencyMs > 500 ? 'text-danger' : 'text-success')}
        ${this.statCard(L('clock'), '运行时长', si.uptime ? formatUptime(parseFloat(si.uptime)) : '—', '')}
        ${this.statCard(L('bot'), 'OpenClaw', clawRunning ? '运行中' : '未运行', clawRunning ? 'text-success' : 'text-warning',
          clawRunning && clawCpuPct !== null ? `CPU ${clawCpuPct}%` : '')}
        ${this.statCard(L('monitor'), '系统', escHtml(si.hostname || '—'), 'text-primary', escHtml(si.os || '—'))}
      </div></div>`;

    html += `<div><div class="text-xs font-bold text-success uppercase tracking-widest mb-2">资源使用</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${this.gaugeCard(L('cpu'), 'CPU', `${cpuPct}%`, cpuPct, si.cpuCores ? `${si.cpuCores} 核` : '')}
        ${this.gaugeCard(L('memory-stick'), '内存', `${memPct}%`, memPct, si.memTotalMB > 0 ? `${si.memUsedMB}/${si.memTotalMB} MB` : '')}
        ${this.gaugeCard(L('hard-drive'), '磁盘', `${diskPct}%`, diskPct, si.diskTotal ? `${escHtml(si.diskUsed)}/${escHtml(si.diskTotal)}` : '')}
        ${this.statCard(L('wrench'), '内核', escHtml(si.kernel || '—'), '', escHtml(si.arch || '—'))}
      </div></div>`;

    html += `<div><div class="text-xs font-bold text-info uppercase tracking-widest mb-2">P2P 网络</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${this.statCard(L('link'), '节点数', `${peers.length}`, 'text-primary', `直连 ${directP}`)}
        ${this.statCard(L('zap'), '直连率', peers.length > 0 ? `${Math.round(directP/peers.length*100)}%` : '—', directP >= peers.length * 0.8 ? 'text-success' : 'text-warning')}
        ${this.statCard(L('download'), '总流入', formatBytes(totalIn), 'text-primary')}
        ${this.statCard(L('upload'), '总流出', formatBytes(totalOut), 'text-warning')}
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
  // 任务队列 Tab — 与技能平级的独立管理界面
  // ═══════════════════════════════════════

  /** 任务类型 → 中文映射 */
  _taskTypeLabel(type: string): string {
    const map: Record<string, string> = {
      skill_install: '安装技能',
      skill_uninstall: '卸载技能',
      claw_restart: '重启 OpenClaw',
      claw_upgrade: '更新 OpenClaw',
      exec_cmd: '执行命令',
    };
    return map[type] || type;
  },

  /** 任务类型 → 图标 */
  _taskTypeIcon(type: string): string {
    const map: Record<string, string> = {
      skill_install: 'download',
      skill_uninstall: 'trash-2',
      claw_restart: 'refresh-cw',
      claw_upgrade: 'arrow-up-circle',
      exec_cmd: 'terminal',
    };
    return map[type] || 'circle';
  },

  /** 状态 → 徽章样式 */
  _taskStatusBadge(status: string): string {
    const styles: Record<string, [string, string]> = {
      queued:     ['bg-text-muted/10 text-text-muted', '等待中'],
      dispatched: ['bg-info/10 text-info', '执行中'],
      completed:  ['bg-success/10 text-success', '成功'],
      failed:     ['bg-danger/10 text-danger', '失败'],
      timeout:    ['bg-warning/10 text-warning', '超时'],
    };
    const [cls, label] = styles[status] || ['bg-text-muted/10 text-text-muted', status];
    return `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${cls}">${label}</span>`;
  },

  /** 相对时间格式化 */
  _relativeTime(iso: string): string {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  },

  /** 加载任务 Tab */
  async loadTasksTab(nodeId: string) {
    const nid = safeAttr(nodeId);
    const container = document.getElementById(`inline-tab-content-${nid}`);
    if (!container) return;

    // 展示 loading
    container.innerHTML = `<div class="px-6 pb-8 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
      <div class="flex items-center justify-between mb-6 border-b border-border-default/20 pb-4">
        <h4 class="text-xl font-headline font-bold tracking-tight text-text-primary">任务队列</h4>
        <button class="px-4 py-1.5 rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-white text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer" onclick="NodeDetailPanel.loadTasksTab('${nid}')">
          <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('refresh-cw')}</span> 刷新
        </button>
      </div>
      <div class="flex items-center gap-2 text-text-muted text-sm py-8 justify-center">
        <span class="[&_svg]:w-4 [&_svg]:h-4 animate-spin">${L('loader-2')}</span> 加载任务列表…
      </div>
    </div>`;
    refreshIcons();

    // 拉取任务数据
    let tasks: any[] = [];
    try {
      const resp = await App.authFetch(`/api/nodes/${encodeURIComponent(nodeId)}/tasks`);
      const data = await resp.json();
      tasks = data.tasks || [];
    } catch (err) {
      container.innerHTML = `<div class="text-danger text-sm py-4">加载任务列表失败</div>`;
      return;
    }

    // 按入队时间倒序
    tasks.sort((a: any, b: any) => new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime());

    let html = `<div class="px-6 pb-8 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
      <div class="flex items-center justify-between mb-6 border-b border-border-default/20 pb-4">
        <div class="flex items-center gap-3">
          <h4 class="text-xl font-headline font-bold tracking-tight text-text-primary">任务队列</h4>
          <span class="text-xs text-text-muted">${tasks.length} 条记录</span>
        </div>
        <button class="px-4 py-1.5 rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-white text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer" onclick="NodeDetailPanel.loadTasksTab('${nid}')">
          <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('refresh-cw')}</span> 刷新
        </button>
      </div>`;

    if (tasks.length === 0) {
      html += `<div class="flex flex-col items-center gap-3 py-12 text-text-muted">
        <span class="[&_svg]:w-10 [&_svg]:h-10 opacity-30">${L('inbox')}</span>
        <p class="text-sm">暂无任务</p>
        <p class="text-xs opacity-60">安装技能或管理 OpenClaw 时，任务会自动出现在这里</p>
      </div>`;
    } else {
      html += `<div class="space-y-2">`;
      for (const task of tasks) {
        const icon = this._taskTypeIcon(task.type);
        const label = this._taskTypeLabel(task.type);
        const badge = this._taskStatusBadge(task.status);
        const time = this._relativeTime(task.queuedAt);
        const canDelete = ['completed', 'failed', 'timeout'].includes(task.status);
        const hasResult = task.result && task.result.code != null;
        const taskNid = safeAttr(task.taskId);

        html += `<div class="bg-elevated/50 rounded-lg border border-border-subtle/50 overflow-hidden">
          <div class="flex items-center gap-3 px-4 py-3">
            <span class="[&_svg]:w-4 [&_svg]:h-4 text-text-muted shrink-0">${L(icon)}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium text-text-primary truncate">${escHtml(task.skillName || label)}</span>
                ${badge}
              </div>
              <div class="text-[10px] text-text-muted mt-0.5">${escHtml(label)} · ${time}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">`;

        if (hasResult) {
          html += `<button class="p-1.5 rounded-md hover:bg-surface text-text-muted hover:text-text-primary transition cursor-pointer" onclick="NodeDetailPanel._toggleTaskResult('${taskNid}')" title="查看结果">
            <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('chevron-down')}</span>
          </button>`;
        }
        if (canDelete) {
          html += `<button class="p-1.5 rounded-md hover:bg-danger/10 text-text-muted hover:text-danger transition cursor-pointer" onclick="NodeDetailPanel._deleteTask('${nid}','${taskNid}')" title="删除">
            <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('x')}</span>
          </button>`;
        }
        if (task.status === 'dispatched') {
          html += `<span class="[&_svg]:w-3.5 [&_svg]:h-3.5 text-info animate-spin">${L('loader-2')}</span>`;
        }

        html += `</div></div>`;

        // 可展开的结果面板
        if (hasResult) {
          const isErr = task.result.code !== 0;
          const output = task.result.stdout || task.result.stderr || '(无输出)';
          html += `<div id="task-result-${taskNid}" class="hidden border-t border-border-subtle/50 px-4 py-3 bg-surface/50">
            <div class="flex items-center gap-2 mb-2">
              <span class="text-[10px] font-mono ${isErr ? 'text-danger' : 'text-success'}">exit code: ${task.result.code}</span>
            </div>
            <pre class="text-[11px] font-mono text-text-secondary bg-elevated rounded-md p-3 max-h-32 overflow-auto whitespace-pre-wrap break-all">${escHtml(output)}</pre>
          </div>`;
        }

        html += `</div>`;
      }
      html += `</div>`;
    }

    html += `</div>`;
    container.innerHTML = html;
    refreshIcons();
  },

  /** 展开/折叠任务结果 */
  _toggleTaskResult(taskId: string) {
    const el = document.getElementById(`task-result-${taskId}`);
    if (el) el.classList.toggle('hidden');
  },

  /** 删除指定任务 */
  async _deleteTask(nodeId: string, taskId: string) {
    try {
      const resp = await App.authFetch(`/api/nodes/${encodeURIComponent(nodeId)}/tasks/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
      });
      if (resp.ok) {
        showToast('任务已删除', 'success');
        this.loadTasksTab(nodeId);
      } else {
        showToast('删除失败', 'error');
      }
    } catch {
      showToast('网络错误', 'error');
    }
  },

  /** 技能 Tab 骨架（同步，立即展示 loading 状态） */
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

  /** 技能 Tab 异步渲染入口：拉商店数据 + 分类渲染 */
  async loadSkillsTab(node: any) {
    const nid = node.id;
    const panel = document.getElementById(`skills-panel-${safeAttr(nid)}`);
    if (!panel) return;

    // 拉商店全量技能
    let storeSkills: any[] = [];
    try {
      const res = await App.authFetch('/api/skills');
      if (res.ok) {
        const data = await res.json();
        storeSkills = data.skills || [];
      }
    } catch (_) { /* 商店不可用时降级 */ }

    // 已安装：优先 agent 上报，降级 DB 记录
    const monNode = App.nodesData.find((n: any) => n.id === nid);
    const installedSkills: any[] = monNode?.skills || node.skills || [];

    // 已安装：status === 'ready' 的才算真正安装
    const readySkills: any[]    = installedSkills.filter((s: any) => s.status === 'ready');
    // 已安装 key 集合（用于从 store 中排除）
    const installedKeys = new Set(
      readySkills.flatMap((s: any) => [s.id, s.name].filter(Boolean))
    );

    // 非 ready 的 Agent 上报技能 → 照样当「未安装」处理（status 可能是 installing/error 等）
    // 这里不把它们单独展示，直接让它们落入 storeSkills 的未安装 bucket

    // 分内置 / 自定义 × 已安装 / 未安装
    const builtinInstalled   = readySkills.filter((s: any) => s.bundled === true);
    const customInstalled    = readySkills.filter((s: any) => s.bundled !== true);
    const builtinUninstalled = storeSkills.filter(
      (s: any) => s.isBuiltin && !installedKeys.has(s.id) && !installedKeys.has(s.name)
    );
    const customUninstalled  = storeSkills.filter(
      (s: any) => !s.isBuiltin && !installedKeys.has(s.id) && !installedKeys.has(s.name)
    );

    const skillsHtml = this._renderSkillsContent(
      nid, builtinInstalled, builtinUninstalled, customInstalled, customUninstalled
    );

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

  /** @private 渲染分类技能内容 */
  _renderSkillsContent(
    nodeId: string,
    builtinInstalled: any[],
    builtinUninstalled: any[],
    customInstalled: any[],
    customUninstalled: any[]
  ) {
    const nid = safeAttr(nodeId);
    let html = '';

    // ── 内置技能区 ──────────────────────────
    html += `<div class="mb-8">
      <div class="flex items-center gap-2 mb-3">
        <span class="[&_svg]:w-3.5 [&_svg]:h-3.5 text-primary">${L('cpu')}</span>
        <span class="text-xs font-bold text-primary uppercase tracking-widest">内置技能</span>
        <span class="text-xs text-text-muted">(${builtinInstalled.length} 已安装)</span>
      </div>`;

    if (builtinInstalled.length > 0) {
      html += `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">`;
      for (const skill of builtinInstalled) {
        html += this._skillChip(nid, skill, true);
      }
      html += `</div>`;
    }

    if (builtinUninstalled.length > 0) {
      html += `
      <details class="group">
        <summary class="cursor-pointer flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors py-1.5 select-none list-none">
          <span class="[&_svg]:w-3 [&_svg]:h-3 group-open:rotate-90 transition-transform">${L('chevron-right')}</span>
          未安装 (${builtinUninstalled.length})
        </summary>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-2">`;
      for (const skill of builtinUninstalled) {
        html += this._storeSkillChip(nid, skill, true);
      }
      html += `</div></details>`;
    }

    if (builtinInstalled.length === 0 && builtinUninstalled.length === 0) {
      html += `<p class="text-xs text-text-muted py-2">暂无内置技能数据</p>`;
    }
    html += `</div>`;

    // ── 自定义技能区 ────────────────────────
    html += `<div>
      <div class="flex items-center gap-2 mb-3">
        <span class="[&_svg]:w-3.5 [&_svg]:h-3.5 text-amber-400">${L('blocks')}</span>
        <span class="text-xs font-bold text-amber-400 uppercase tracking-widest">自定义技能</span>
        <span class="text-xs text-text-muted">(${customInstalled.length} 已安装)</span>
      </div>`;

    if (customInstalled.length > 0) {
      html += `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">`;
      for (const skill of customInstalled) {
        html += this._skillChip(nid, skill, false);
      }
      html += `</div>`;
    }

    if (customUninstalled.length > 0) {
      html += `
      <details class="group">
        <summary class="cursor-pointer flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors py-1.5 select-none list-none">
          <span class="[&_svg]:w-3 [&_svg]:h-3 group-open:rotate-90 transition-transform">${L('chevron-right')}</span>
          未安装 (${customUninstalled.length})
        </summary>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 mt-2">`;
      for (const skill of customUninstalled) {
        html += this._storeSkillChip(nid, skill, false);
      }
      html += `</div></details>`;
    }

    if (customInstalled.length === 0 && customUninstalled.length === 0) {
      html += `<p class="text-xs text-text-muted py-2">暂无自定义技能，前往技能商店添加</p>`;
    }
    html += `</div>`;

    return html;
  },

  /**
   * @private 已安装技能卡片
   * isBuiltin=true → 内置，禁止删除商店，只能 卸载
   * isBuiltin=false → 自定义，可 卸载 + 删除商店
   */
  _skillChip(nid: string, skill: any, isBuiltin: boolean) {
    const skillName   = skill.name || skill.id || '';
    const skillId     = skill.name || skill.id || '';  // openclaw 用 name 作 ID
    const storeId     = skill.storeId || skill.id || '';
    const isReady     = skill.eligible === true;
    const emoji       = skill.emoji || '';
    const badgeColor  = isBuiltin
      ? 'bg-primary/20 text-primary'
      : 'bg-amber-400/20 text-amber-300';
    const badgeLabel  = isBuiltin ? '内置' : '自定义';
    const border      = isReady ? 'border-emerald-500/30' : 'border-border-default/30';
    const dot         = isReady
      ? 'bg-emerald-500" title="Ready — 依赖已就绪'
      : 'bg-amber-400/80" title="Not ready — 依赖未满足';

    return `
      <div class="bg-elevated/40 border ${border} p-4 rounded-xl flex flex-col gap-3 transition-all hover:bg-elevated hover:border-primary/30">
        <div class="flex items-center gap-3">
          <div class="relative w-10 h-10 rounded-lg bg-surface flex items-center justify-center text-primary shadow-sm shrink-0">
            ${emoji
              ? `<span class="text-lg leading-none">${escHtml(emoji)}</span>`
              : `<span class="[&_svg]:w-5 [&_svg]:h-5">${L(skill.icon || 'box')}</span>`
            }
            <span class="absolute -top-1 -right-1 w-3 h-3 rounded-full ${dot} border-2 border-surface"></span>
          </div>
          <div class="min-w-0">
            <p class="text-sm font-medium text-text-primary truncate max-w-[110px]">${escHtml(skillName)}</p>
            <span class="inline-block text-[9px] font-bold px-1.5 py-0.5 rounded-full ${badgeColor} uppercase tracking-wide mt-0.5">${badgeLabel}</span>
          </div>
        </div>
        <div class="flex items-center gap-1.5 justify-end">
          <button class="px-2.5 py-1 text-xs rounded-lg text-danger hover:bg-danger/10 border border-danger/20 hover:border-danger/40 transition-all cursor-pointer flex items-center gap-1"
            title="卸载" onclick="event.stopPropagation();Nodes.uninstallSkill('${nid}','${safeAttr(skillId)}')">
            <span class="[&_svg]:w-3 [&_svg]:h-3">${L('power-off')}</span> 卸载
          </button>
          ${!isBuiltin && storeId ? `
          <button class="p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 border border-border-default/20 hover:border-danger/30 transition-all cursor-pointer"
            title="从商店删除" onclick="event.stopPropagation();Nodes.deleteSkillFromStore('${nid}','${safeAttr(storeId)}','${safeAttr(skillName)}')">
            <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('trash-2')}</span>
          </button>` : ''}
        </div>
      </div>
    `;
  },

  /**
   * @private 商店技能卡片（未安装状态）
   * isBuiltin=true → 内置，点安装跳商店，无删除按钮
   * isBuiltin=false → 自定义，可以从商店删除
   */
  _storeSkillChip(nid: string, skill: any, isBuiltin: boolean) {
    const skillName  = skill.name || '';
    const iconGrad   = skill.iconGradient || 'linear-gradient(135deg,#6366f1 0%,#a5b4fc 100%)';
    const cat        = skill.category || '';
    const badgeColor = isBuiltin
      ? 'bg-primary/10 text-primary/60'
      : 'bg-amber-400/10 text-amber-300/70';

    return `
      <div class="bg-surface/50 border border-border-default/20 p-3 rounded-xl flex flex-col gap-2 opacity-70 hover:opacity-100 transition-opacity">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style="background:${escHtml(iconGrad)}">
            <span class="[&_svg]:w-4 [&_svg]:h-4 text-white">${L(skill.icon || 'box')}</span>
          </div>
          <div class="min-w-0">
            <p class="text-xs font-medium text-text-secondary truncate max-w-[90px]">${escHtml(skillName)}</p>
            <span class="inline-block text-[9px] px-1 py-0.5 rounded-full ${badgeColor} uppercase tracking-wide">${escHtml(cat)}</span>
          </div>
        </div>
        <div class="flex items-center gap-1.5 justify-end">
          <button class="px-2 py-0.5 text-[10px] rounded text-primary hover:bg-primary/10 border border-primary/20 hover:border-primary/40 transition-all cursor-pointer"
            onclick="App.switchPage('skills')">
            安装
          </button>
          ${!isBuiltin ? `
          <button class="p-1 rounded text-text-muted hover:text-danger hover:bg-danger/10 border border-border-default/20 hover:border-danger/30 transition-all cursor-pointer"
            title="从商店删除" onclick="event.stopPropagation();Nodes.deleteSkillFromStore('${nid}','${safeAttr(skill.id)}','${safeAttr(skillName)}')">
            <span class="[&_svg]:w-3 [&_svg]:h-3">${L('trash-2')}</span>
          </button>` : ''}
        </div>
      </div>
    `;
  },

  renderTerminal(node: any) {
    const shortcuts = [
      { prompt: '请检查 GNB 和 OpenClaw 服务状态', icon: 'activity', label: '状态检查' },
      { prompt: '请重启 GNB 服务', icon: 'refresh-cw', label: '重启 GNB' },
      { prompt: '请查看 GNB 和 OpenClaw 最近 30 条日志', icon: 'file-text', label: '查看日志' },
      { prompt: '请检查磁盘空间使用情况', icon: 'hard-drive', label: '磁盘用量' },
      { prompt: '请查看系统性能概况（CPU/负载/进程）', icon: 'gauge', label: '性能' },
      { prompt: '请查看内存使用情况', icon: 'memory-stick', label: '内存' },
    ];
    const maximized = _termMaximized;
    const hClass = maximized ? 'h-[calc(100vh-280px)]' : 'h-80';
    const nid = safeAttr(node.id);
    return `<div class="rounded-xl border border-border-default overflow-hidden flex flex-col bg-surface shadow-md" id="terminal-wrap-${nid}">
      <!-- 深色头部栏 -->
      <div class="flex items-center gap-3 px-4 py-2.5 bg-[#1a1b2e]">
        <span class="text-white text-xs font-bold tracking-tight flex items-center gap-1.5 [&_svg]:w-3.5 [&_svg]:h-3.5">${L('terminal')} AI Ops Terminal</span>
        <span id="term-status-${nid}" class="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400 uppercase tracking-widest"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>连接中</span>
        <span class="px-2 py-0.5 rounded-md bg-white/10 text-white/80 text-[10px] font-mono">${escHtml(node.name || node.id)}</span>
        <div class="ml-auto flex items-center gap-1">
          <button class="p-1 rounded text-white/50 hover:text-white hover:bg-white/10 transition cursor-pointer [&_svg]:w-3.5 [&_svg]:h-3.5" onclick="Nodes.toggleTerminalSize('${nid}')" title="${maximized ? '还原' : '最大化'}">${L(maximized ? 'minimize-2' : 'maximize-2')}</button>
        </div>
      </div>
      <!-- 快捷按钮栏 -->
      <div class="flex items-center gap-1.5 px-4 py-2 border-b border-border-subtle bg-base overflow-x-auto">
        ${shortcuts.map(s => `<button class="px-2.5 py-1 text-xs rounded-full border border-border-default hover:border-primary/40 hover:bg-primary/8 text-text-secondary hover:text-primary transition cursor-pointer flex items-center gap-1 whitespace-nowrap [&_svg]:w-3 [&_svg]:h-3" onclick="Nodes.quickCmd('${nid}','${safeAttr(s.prompt)}')">${L(s.icon)} ${s.label}</button>`).join('')}
      </div>
      <!-- 消息区域 -->
      <div id="chat-messages-${nid}" class="overflow-y-auto px-4 py-4 space-y-4 scroll-smooth bg-surface ${hClass}">
        <div class="flex gap-2.5 items-start"><div class="w-7 h-7 rounded-full signature-gradient flex items-center justify-center text-xs text-white flex-shrink-0 shadow-sm">AI</div><div class="bg-base border border-border-subtle rounded-xl rounded-tl-sm px-3.5 py-2.5 text-sm text-text-secondary leading-relaxed max-w-[85%]">你好！我是节点 <strong class="text-text-primary">${escHtml(node.name || node.id)}</strong> 的 AI 运维助手。用自然语言告诉我你需要做什么。</div></div>
      </div>
      <!-- 输入区域 -->
      <div class="px-4 py-3 border-t border-border-default bg-base flex gap-2.5 items-center">
        <input id="chat-input-${nid}" type="text" placeholder="用自然语言描述运维任务…" class="flex-1 px-4 py-2 text-sm rounded-xl bg-surface border border-border-default focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-[box-shadow,border-color] placeholder:text-text-muted" onkeydown="if(event.key==='Enter'){Nodes.sendChat('${nid}');event.preventDefault()}" />
        <span class="hidden sm:flex items-center gap-1 px-2 py-1 rounded-md bg-elevated text-[10px] text-text-muted font-medium [&_svg]:w-3 [&_svg]:h-3">${L('bot')} Claude Code</span>
        <button onclick="Nodes.sendChat('${nid}')" class="px-4 py-2 text-xs font-semibold rounded-xl signature-gradient text-white cursor-pointer flex items-center gap-1.5 [&_svg]:w-3.5 [&_svg]:h-3.5 hover:scale-[1.02] active:scale-95 transition-all shadow-sm shadow-primary/20">${L('send')} 发送</button>
      </div>
      <!-- 页脚 -->
      <div class="px-4 py-1.5 text-center border-t border-border-subtle bg-base"><span class="text-[10px] text-text-muted font-medium">Powered by Claude Code · 命令通过 SSH 执行</span></div>
    </div>`;
  },

  // ═══════════════════════════════════════
  // OpenClaw Tab
  // ═══════════════════════════════════════

  async loadClawTab(nodeId: any, subTab: any) {
    const container = document.getElementById(`inline-tab-content-${nodeId}`);
    if (!container) return;
    const nid = safeAttr(nodeId);

    // 子 Tab：仅保留 status / config / sessions（models/channels 提升为主 Tab）
    const subTabs = [
      { key: 'status',   icon: 'activity',       label: '状态' },
      { key: 'config',   icon: 'settings',        label: '配置' },
      { key: 'sessions', icon: 'message-square',  label: '会话' },
    ];
    const activeSubTab = subTab || 'status';

    let html = `
    <div class="px-6 pb-8 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
      <!-- 标题栏 + 操作按钮 -->
      <div class="flex items-center justify-between mb-4 border-b border-border-default/20 pb-4">
        <h4 class="text-xl font-headline font-bold tracking-tight text-text-primary flex items-center gap-2">
          <span class="[&_svg]:w-5 [&_svg]:h-5 text-primary">${L('bot')}</span> OpenClaw Gateway
        </h4>
        <div class="flex items-center gap-2">
          <button id="claw-restart-btn-${nid}"
            class="px-3 py-1.5 text-xs font-bold rounded-lg border border-primary/30 text-primary hover:bg-primary hover:text-white hover:border-primary transition-all cursor-pointer flex items-center gap-1.5"
            onclick="Nodes.restartOpenClaw('${nid}')">
            <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('refresh-cw')}</span> 重启
          </button>
          <button id="claw-update-btn-${nid}"
            class="px-3 py-1.5 text-xs font-bold rounded-lg border border-amber-400/30 text-amber-400 hover:bg-amber-400 hover:text-white hover:border-amber-400 transition-all cursor-pointer flex items-center gap-1.5"
            onclick="Nodes.updateOpenClaw('${nid}')">
            <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('arrow-up-circle')}</span> 更新
          </button>
        </div>
      </div>
      <!-- 子 Tab 导航 -->
      <div class="flex gap-1 mb-4">
        ${subTabs.map(st => `<button class="px-3 py-1.5 text-xs rounded-lg transition cursor-pointer flex items-center gap-1.5 [&_svg]:w-3.5 [&_svg]:h-3.5 ${activeSubTab === st.key ? 'bg-primary/10 text-primary font-medium' : 'text-text-muted hover:text-text-primary hover:bg-elevated'}" onclick="Nodes.switchClawSubTab('${nid}','${st.key}')">${L(st.icon)} ${st.label}</button>`).join('')}
      </div>
      <div id="claw-content-${nid}" class="text-sm text-text-muted flex items-center gap-2 py-4 justify-center">
        <span class="[&_svg]:w-4 [&_svg]:h-4 animate-spin">${L('loader-2')}</span> 加载中…
      </div>
    </div>`;

    container.innerHTML = html;
    refreshIcons();

    const nodeConfig = App.allNodesRaw.find((n: any) => n.id === nodeId);
    const detail = document.getElementById(`claw-content-${nodeId}`);
    if (!detail) return;

    const monNode = App.nodesData.find((n: any) => n.id === nodeId);
    const oc = monNode?.openclaw;

    if (activeSubTab === 'status') {
      if (!oc) {
        detail.innerHTML = `<div class="text-text-muted text-sm">${L('info')} 未检测到 OpenClaw 信息，等待终端上报…</div>`;
        refreshIcons();
        return;
      }
      
      const tokenPreview = nodeConfig?.clawToken ? nodeConfig.clawToken.substring(0, 12) + '…' : '无';
      detail.innerHTML = `
        <div class="space-y-3">
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            ${this.statCard(L('activity'), '状态', oc.running ? '运行中' : '未运行', oc.running ? 'text-success' : 'text-warning')}
            ${this.statCard(L('info'), '版本', oc.version || '未知', '')}
            ${this.statCard(L('cpu'), 'CPU占用', typeof oc.cpuPercent === 'number' ? oc.cpuPercent.toFixed(1) + '%' : '-', '')}
            ${this.statCard(L('wifi'), 'RPC 可用性', oc.rpcOk ? '正常' : '不可用', oc.rpcOk ? 'text-success' : 'text-warning')}
          </div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            ${this.statCard(L('key-round'), 'Token', tokenPreview, 'font-mono text-xs')}
            ${this.statCard(L('radio'), 'RPC 端口', nodeConfig?.clawPort || 18789, '')}
            ${oc.hasUpdate ? this.statCard(L('arrow-up-circle'), '更新可用', '有新版本', 'text-amber-400') : ''}
          </div>
          ${!nodeConfig?.clawToken && oc.running ? `<div class="text-xs text-text-muted mt-2">${L('info')} Token 正在通过隧道自动协商中...</div>` : ''}
        </div>`;
      refreshIcons();
      return;
    }

    if (!nodeConfig?.clawToken) {
      detail.innerHTML = `<div class="text-warning text-sm">${L('alert-triangle')} 等待 Token 协商完成才能查看详情</div>`;
      refreshIcons();
      return;
    }

    try {
      const res = await App.authFetch(`/api/claw/${encodeURIComponent(nodeId)}/${activeSubTab}`);
      const data = await res.json();
      if (data.error) { detail.innerHTML = `<div class="text-danger text-sm">${escHtml(data.error)}</div>`; return; }
      detail.innerHTML = `<pre class="text-xs bg-base rounded-lg p-3 overflow-x-auto max-h-60">${escHtml(JSON.stringify(data, null, 2))}</pre>`;
    } catch (err: any) {
      detail.innerHTML = `<div class="text-danger text-sm">请求失败: ${escHtml(err.message)}</div>`;
    }
    refreshIcons();
  },

  /** AI 模型 Tab — 展示 /api/claw/:nodeId/models */
  async loadModelsTab(nodeId: any) {
    const container = document.getElementById(`inline-tab-content-${nodeId}`);
    if (!container) return;
    const nid = safeAttr(nodeId);

    container.innerHTML = `
    <div class="px-6 pb-8 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
      <div class="flex items-center justify-between mb-6 border-b border-border-default/20 pb-4">
        <h4 class="text-xl font-headline font-bold tracking-tight text-text-primary flex items-center gap-2">
          <span class="[&_svg]:w-5 [&_svg]:h-5 text-primary">${L('sparkles')}</span> AI 模型
        </h4>
        <button class="p-2 rounded-lg text-text-muted hover:text-primary hover:bg-primary/10 transition cursor-pointer [&_svg]:w-4 [&_svg]:h-4"
          title="刷新" onclick="NodeDetailPanel.loadModelsTab('${nid}')">
          ${L('refresh-cw')}
        </button>
      </div>
      <div id="models-content-${nid}" class="flex items-center gap-2 text-text-muted text-sm py-8 justify-center">
        <span class="[&_svg]:w-4 [&_svg]:h-4 animate-spin">${L('loader-2')}</span> 加载模型列表…
      </div>
    </div>`;
    refreshIcons();

    const detail = document.getElementById(`models-content-${nid}`);
    if (!detail) return;

    const nodeConfig = App.allNodesRaw.find((n: any) => n.id === nodeId);
    if (!nodeConfig?.clawToken) {
      detail.innerHTML = `<div class="text-text-muted text-sm flex items-center gap-2">${L('info')} 节点未配置 OpenClaw Token，无法查看模型列表</div>`;
      refreshIcons();
      return;
    }

    try {
      const res = await App.authFetch(`/api/claw/${encodeURIComponent(nodeId)}/models`);
      const data = await res.json();
      if (data.error) { detail.innerHTML = `<div class="text-danger text-sm">${escHtml(data.error)}</div>`; refreshIcons(); return; }

      const models: any[] = data.data || data.models || [];
      if (models.length === 0) {
        detail.innerHTML = `<div class="text-text-muted text-sm">${L('box')} 暂无可用模型</div>`;
        refreshIcons(); return;
      }

      let html = `<div class="grid grid-cols-1 md:grid-cols-2 gap-3">`;
      for (const m of models) {
        const name = m.id || m.name || '';
        const ctx  = m.context_length ? `上下文 ${m.context_length.toLocaleString()} tokens` : '';
        const owned = m.owned_by || m.provider || '';
        html += `
          <div class="bg-elevated/50 border border-border-default/30 rounded-xl p-4 hover:bg-elevated transition-colors">
            <div class="flex items-start gap-3">
              <div class="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 [&_svg]:w-4 [&_svg]:h-4 text-primary">
                ${L('brain-circuit')}
              </div>
              <div class="min-w-0">
                <p class="text-sm font-semibold text-text-primary truncate">${escHtml(name)}</p>
                ${owned ? `<p class="text-[10px] text-text-muted mt-0.5">${escHtml(owned)}</p>` : ''}
                ${ctx   ? `<p class="text-[10px] text-primary/70 mt-1 font-mono">${escHtml(ctx)}</p>` : ''}
              </div>
            </div>
          </div>`;
      }
      html += `</div>`;
      detail.innerHTML = html;
    } catch (err: any) {
      detail.innerHTML = `<div class="text-danger text-sm">请求失败: ${escHtml(err.message)}</div>`;
    }
    refreshIcons();
  },

  /** 渠道 Tab — 展示 /api/claw/:nodeId/channels */
  async loadChannelsTab(nodeId: any) {
    const container = document.getElementById(`inline-tab-content-${nodeId}`);
    if (!container) return;
    const nid = safeAttr(nodeId);

    container.innerHTML = `
    <div class="px-6 pb-8 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
      <div class="flex items-center justify-between mb-6 border-b border-border-default/20 pb-4">
        <h4 class="text-xl font-headline font-bold tracking-tight text-text-primary flex items-center gap-2">
          <span class="[&_svg]:w-5 [&_svg]:h-5 text-primary">${L('radio')}</span> 渠道管理
        </h4>
        <button class="p-2 rounded-lg text-text-muted hover:text-primary hover:bg-primary/10 transition cursor-pointer [&_svg]:w-4 [&_svg]:h-4"
          title="刷新" onclick="NodeDetailPanel.loadChannelsTab('${nid}')">
          ${L('refresh-cw')}
        </button>
      </div>
      <div id="channels-content-${nid}" class="flex items-center gap-2 text-text-muted text-sm py-8 justify-center">
        <span class="[&_svg]:w-4 [&_svg]:h-4 animate-spin">${L('loader-2')}</span> 加载渠道状态…
      </div>
    </div>`;
    refreshIcons();

    const detail = document.getElementById(`channels-content-${nid}`);
    if (!detail) return;

    const nodeConfig = App.allNodesRaw.find((n: any) => n.id === nodeId);
    if (!nodeConfig?.clawToken) {
      detail.innerHTML = `<div class="text-text-muted text-sm flex items-center gap-2">${L('info')} 节点未配置 OpenClaw Token，无法查看渠道信息</div>`;
      refreshIcons();
      return;
    }

    try {
      const res = await App.authFetch(`/api/claw/${encodeURIComponent(nodeId)}/channels`);
      const data = await res.json();
      if (data.error) { detail.innerHTML = `<div class="text-danger text-sm">${escHtml(data.error)}</div>`; refreshIcons(); return; }

      // channels 结构可能是 { channels: [...] } 或直接数组或 RPC 原始返回
      const channels: any[] = data.channels || (Array.isArray(data) ? data : []);
      if (channels.length === 0) {
        detail.innerHTML = `
          <div class="flex flex-col items-center gap-2 text-text-muted text-sm py-4">
            ${L('radio')}
            <span>暂无配置渠道</span>
            <pre class="text-xs bg-base rounded-lg p-3 mt-2 overflow-x-auto max-h-40 w-full">${escHtml(JSON.stringify(data, null, 2))}</pre>
          </div>`;
        refreshIcons(); return;
      }

      let html = `<div class="space-y-2">`;
      for (const ch of channels) {
        const name    = ch.name || ch.id || '未命名';
        const type    = ch.type || ch.provider || '';
        const enabled = ch.enabled !== false;
        const health  = ch.healthy ?? ch.connected ?? null;
        const statusColor = enabled
          ? (health === false ? 'text-danger' : 'text-success')
          : 'text-text-muted';
        const statusLabel = !enabled ? '禁用'
          : health === false ? '异常'
          : health === true  ? '正常'
          : '在线';

        html += `
          <div class="bg-elevated/50 border border-border-default/30 rounded-xl p-4 flex items-center justify-between hover:bg-elevated transition-colors">
            <div class="flex items-center gap-3">
              <span class="[&_svg]:w-4 [&_svg]:h-4 ${statusColor}">${L('radio')}</span>
              <div>
                <p class="text-sm font-semibold text-text-primary">${escHtml(name)}</p>
                ${type ? `<p class="text-[10px] text-text-muted font-mono">${escHtml(type)}</p>` : ''}
              </div>
            </div>
            <span class="text-xs font-bold px-2 py-0.5 rounded-full ${enabled ? 'bg-success/10 text-success' : 'bg-elevated text-text-muted'} border border-current/20">${statusLabel}</span>
          </div>`;
      }
      html += `</div>`;
      detail.innerHTML = html;
    } catch (err: any) {
      detail.innerHTML = `<div class="text-danger text-sm">请求失败: ${escHtml(err.message)}</div>`;
    }
    refreshIcons();
  },

  // ═══════════════════════════════════════
  // UI 组件
  // ═══════════════════════════════════════

  statCard(icon: any, label: any, value: any, color: any, sub?: any) {
    return `<div class="bg-elevated rounded-lg border border-border-subtle p-3">
      <div class="flex items-center gap-1.5 mb-1"><span class="[&_svg]:w-3.5 [&_svg]:h-3.5 text-text-muted">${icon}</span><span class="text-xs text-text-muted">${label}</span></div>
      <div class="text-sm font-semibold ${color}">${value}</div>
      ${sub ? `<div class="text-xs text-text-muted mt-0.5">${sub}</div>` : ''}
    </div>`;
  },

  gaugeCard(icon: any, label: any, value: any, pct: any, sub: any) {
    const c = pctBg(pct);
    return `<div class="bg-elevated rounded-lg border border-border-subtle p-3">
      <div class="flex items-center gap-1.5 mb-1"><span class="[&_svg]:w-3.5 [&_svg]:h-3.5 text-text-muted">${icon}</span><span class="text-xs text-text-muted">${label}</span></div>
      <div class="text-sm font-semibold ${pctColor(pct)}">${value}</div>
      ${pct > 0 ? `<div class="gauge-bar mt-1.5"><div class="gauge-fill ${c}" style="width:${Math.min(pct,100)}%"></div></div>` : ''}
      ${sub ? `<div class="text-xs text-text-muted mt-0.5">${sub}</div>` : ''}
    </div>`;
  },

  // ═══════════════════════════════════════
  // AI Chat WebSocket
  // ═══════════════════════════════════════

  toggleTerminalSize(nodeId: any) {
    _termMaximized = !_termMaximized;
    const msgEl = document.getElementById(`chat-messages-${nodeId}`);
    if (msgEl) {
      msgEl.classList.toggle('h-80', !_termMaximized);
      msgEl.classList.toggle('h-[calc(100vh-280px)]', _termMaximized);
    }
    const wrap = document.getElementById(`terminal-wrap-${nodeId}`);
    if (wrap) {
      const btn = wrap.querySelector('[title="最大化"], [title="还原"]');
      if (btn) {
        (btn as HTMLElement).title = _termMaximized ? '还原' : '最大化';
        btn.innerHTML = L(_termMaximized ? 'minimize-2' : 'maximize-2');
        refreshIcons();
      }
    }
  },

  sendChat(nodeId: any) {
    const input = document.getElementById(`chat-input-${nodeId}`);
    if (!input) return;
    const text = (input as HTMLInputElement).value.trim();
    if (!text) return;
    (input as HTMLInputElement).value = '';
    const s = _chatSessions[nodeId];
    if (!s || !s.ws || s.ws.readyState !== 1) {
      this.appendMsg(nodeId, 'system', '⚠️ 未连接，请稍候重试');
      return;
    }
    this.appendMsg(nodeId, 'user', text);
    s.ws.send(JSON.stringify({ type: 'chat', text }));
  },

  quickCmd(nodeId: any, prompt: any) {
    const s = _chatSessions[nodeId];
    if (!s || !s.ws || s.ws.readyState !== 1) {
      this.appendMsg(nodeId, 'system', '⚠️ AI 助手未连接');
      return;
    }
    this.appendMsg(nodeId, 'user', prompt);
    s.ws.send(JSON.stringify({ type: 'chat', text: prompt }));
  },

  appendMsg(nodeId: any, role: any, content: any) {
    const box = document.getElementById(`chat-messages-${nodeId}`);
    if (!box) return;
    const div = document.createElement('div');
    if (role === 'user') {
      div.className = 'flex justify-end';
      div.innerHTML = `<div class="px-3.5 py-2 rounded-xl rounded-tr-sm text-sm text-white max-w-[80%] signature-gradient shadow-sm">${this._escHtml(content)}</div>`;
    } else if (role === 'ai') {
      div.className = 'flex gap-2.5 items-start ai-msg';
      div.innerHTML = `<div class="w-7 h-7 rounded-full signature-gradient flex items-center justify-center text-xs text-white flex-shrink-0 shadow-sm">AI</div><div class="bg-base border border-border-subtle rounded-xl rounded-tl-sm px-3.5 py-2.5 text-sm text-text-secondary leading-relaxed max-w-[85%] ai-text"></div>`;
    } else {
      div.className = 'flex justify-center';
      div.innerHTML = `<span class="text-[10px] px-3 py-1 rounded-full bg-elevated text-text-muted font-medium">${this._escHtml(content)}</span>`;
    }
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  },

  getOrCreateAiBubble(nodeId: any) {
    const box = document.getElementById(`chat-messages-${nodeId}`);
    if (!box) return null;
    const last = box.querySelector('.ai-msg:last-child');
    if (last) return last.querySelector('.ai-text');
    const div = this.appendMsg(nodeId, 'ai', '');
    return div?.querySelector('.ai-text') || null;
  },

  _escHtml(s: any) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  },

  updateTermStatus(nodeId: any, connected: any) {
    const el = document.getElementById(`term-status-${nodeId}`);
    if (!el) return;
    if (connected) {
      el.className = 'flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400 uppercase tracking-widest';
      el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>已连接';
    } else {
      el.className = 'flex items-center gap-1.5 text-[10px] font-semibold text-red-400 uppercase tracking-widest';
      el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>已断开';
    }
  },

  initChat(nodeId: any) {
    if (_chatSessions[nodeId]) return;
    const msgBox = document.getElementById(`chat-messages-${nodeId}`);
    if (!msgBox) return;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const token = App.getToken();
    const ws = new WebSocket(`${proto}://${location.host}/ws/ai`);

    let aiBuf = '';

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token, nodeId }));
      this.updateTermStatus(nodeId, true);
      this.appendMsg(nodeId, 'system', '✓ AI 助手已连接');
    };

    ws.onmessage = (e) => {
      let chunk: any;
      try { chunk = JSON.parse(e.data); } catch (_) { return; }

      if (chunk.type === 'ack') { aiBuf = ''; return; }
      if (chunk.type === 'busy') { this.appendMsg(nodeId, 'system', chunk.text); return; }
      if (chunk.type === 'error') { this.appendMsg(nodeId, 'system', `❌ ${chunk.text || '执行失败'}`); return; }
      if (chunk.type === 'done') { aiBuf = ''; return; }

      const bubble = this.getOrCreateAiBubble(nodeId);
      if (!bubble) return;

      if (chunk.type === 'assistant' && chunk.message?.content) {
        for (const block of chunk.message.content) {
          if (block.type === 'text') {
            aiBuf += block.text;
            bubble.innerHTML = this.renderMd(aiBuf);
          }
        }
      } else if (chunk.type === 'content_block_delta') {
        if (chunk.delta?.type === 'text_delta') {
          aiBuf += chunk.delta.text;
          bubble.innerHTML = this.renderMd(aiBuf);
        }
      } else if (chunk.type === 'result') {
        const text = chunk.result || '';
        if (text) {
          aiBuf = text;
          bubble.innerHTML = this.renderMd(aiBuf);
        }
        aiBuf = '';
      }

      msgBox.scrollTop = msgBox.scrollHeight;
    };

    ws.onerror = () => {
      this.updateTermStatus(nodeId, false);
      this.appendMsg(nodeId, 'system', '❌ 连接错误');
    };

    ws.onclose = (e) => {
      this.updateTermStatus(nodeId, false);
      this.appendMsg(nodeId, 'system', `连接已断开 (${e.code})`);
      delete _chatSessions[nodeId];
    };

    _chatSessions[nodeId] = { ws };
  },

  destroyChat(nodeId: any) {
    const s = _chatSessions[nodeId];
    if (!s) return;
    if (s.ws && s.ws.readyState <= 1) s.ws.close();
    delete _chatSessions[nodeId];
  },

  renderMd(text: any) {
    let html = this._escHtml(text);
    html = html.replace(/```([\s\S]*?)```/g, '<pre class="bg-[#1e1e2e] text-emerald-300 px-3.5 py-3 rounded-lg text-xs overflow-x-auto my-2 font-mono leading-relaxed">$1</pre>');
    html = html.replace(/`([^`]+)`/g, '<code class="bg-elevated text-primary px-1.5 py-0.5 rounded text-xs font-mono">$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-text-primary font-semibold">$1</strong>');
    html = html.replace(/\n/g, '<br>');
    return html;
  },

  /** 任务队列轮询定时器（per-node） */
  _taskPollTimers: new Map<string, number>(),

  /** 异步加载并渲染任务队列（有 pending 任务时自动轮询） */
  async loadTaskQueue(nodeId: string) {
    const wrap = document.getElementById(`task-queue-${nodeId}`);
    if (!wrap) return;

    try {
      const res = await App.authFetch(`/api/nodes/${nodeId}/tasks`);
      if (!res.ok) { wrap.innerHTML = ''; return; }
      const { tasks } = await res.json();

      if (!tasks || tasks.length === 0) {
        wrap.innerHTML = '';
        this._stopTaskPoll(nodeId);
        return;
      }

      const statusMap: Record<string, { label: string; color: string; icon: string }> = {
        queued:     { label: '等待下发', color: 'text-amber-400',   icon: 'clock' },
        dispatched: { label: '执行中',   color: 'text-blue-400',    icon: 'loader-2' },
        completed:  { label: '已完成',   color: 'text-emerald-400', icon: 'check-circle' },
        failed:     { label: '失败',     color: 'text-red-400',     icon: 'x-circle' },
        timeout:    { label: '超时',     color: 'text-orange-400',  icon: 'alert-triangle' },
      };

      let html = `
      <div class="px-6 pb-6 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
        <div class="flex items-center justify-between mb-4 border-b border-border-default/20 pb-3">
          <h4 class="text-lg font-headline font-bold tracking-tight text-text-primary flex items-center gap-2">
            <span class="[&_svg]:w-4 [&_svg]:h-4">${L('list-todo')}</span>
            任务队列
            <span class="text-xs font-normal text-text-muted">(${tasks.length})</span>
          </h4>
        </div>
        <div class="space-y-3">`;

      let hasPending = false;
      for (const task of tasks) {
        const st = statusMap[task.status] || statusMap.queued;
        if (task.status === 'queued' || task.status === 'dispatched') hasPending = true;
        const timeStr = task.completedAt
          ? new Date(task.completedAt).toLocaleTimeString()
          : task.dispatchedAt
            ? new Date(task.dispatchedAt).toLocaleTimeString()
            : new Date(task.queuedAt).toLocaleTimeString();
        const typeLabel = task.type === 'skill_install' ? '安装' : task.type === 'skill_uninstall' ? '卸载' : task.type;
        const animClass = task.status === 'dispatched' ? ' animate-spin' : '';

        // 操作按钮（失败/已完成可重试 + 非 dispatched 可删除）
        let actionBtns = '';
        const canRetry = (task.status === 'failed' || task.status === 'completed') && task.type === 'skill_install' && task.skillId;
        const canDelete = task.status !== 'dispatched';
        if (canRetry || canDelete) {
          actionBtns = `<div class="flex items-center gap-1 mt-1">`;
          if (canRetry) {
            actionBtns += `<button onclick="Nodes.reinstallTask('${nodeId}','${safeAttr(task.skillId)}','${safeAttr(task.skillName || task.skillId)}')" class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors duration-150" title="重新安装">重试</button>`;
          }
          if (canDelete) {
            actionBtns += `<button onclick="Nodes.deleteTask('${nodeId}','${task.taskId}')" class="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors duration-150" title="删除任务">删除</button>`;
          }
          actionBtns += `</div>`;
        }

        html += `
          <div class="flex items-center gap-3 px-4 py-3 rounded-lg bg-elevated/40 border border-border-default/20">
            <span class="[&_svg]:w-4 [&_svg]:h-4 ${st.color}${animClass}">${L(st.icon)}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-xs font-mono px-1.5 py-0.5 rounded bg-surface text-text-muted">${typeLabel}</span>
                <span class="text-sm text-text-primary font-medium truncate">${escHtml(task.skillName || task.skillId || '')}</span>
              </div>
              <p class="text-[10px] text-text-muted font-mono mt-1 truncate">${escHtml(task.command || '')}</p>
            </div>
            <div class="text-right shrink-0">
              <span class="text-xs font-medium ${st.color}">${st.label}</span>
              <p class="text-[10px] text-text-muted mt-0.5">${timeStr}</p>
              ${actionBtns}
            </div>
          </div>`;

        // 失败任务显示错误详情
        if (task.status === 'failed' && task.result?.stderr) {
          html += `
          <div class="ml-7 px-3 py-2 rounded bg-red-500/5 border border-red-500/10 text-[11px] font-mono text-red-300 whitespace-pre-wrap break-all max-h-20 overflow-auto">${escHtml(task.result.stderr.slice(0, 500))}</div>`;
        }
      }

      html += `</div></div>`;
      wrap.innerHTML = html;
      refreshIcons();

      // 有 pending 任务时启动轮询，否则停止
      if (hasPending) {
        this._startTaskPoll(nodeId);
      } else {
        this._stopTaskPoll(nodeId);
      }
    } catch {
      wrap.innerHTML = '';
    }
  },

  /** 启动任务队列轮询（10s 间隔） */
  _startTaskPoll(nodeId: string) {
    if (this._taskPollTimers.has(nodeId)) return; // 已在轮询
    const timer = window.setInterval(() => {
      // 面板已关闭则停止
      if (!document.getElementById(`task-queue-${nodeId}`)) {
        this._stopTaskPoll(nodeId);
        return;
      }
      this.loadTaskQueue(nodeId);
    }, 10000);
    this._taskPollTimers.set(nodeId, timer);
  },

  /** 停止任务队列轮询 */
  _stopTaskPoll(nodeId: string) {
    const timer = this._taskPollTimers.get(nodeId);
    if (timer) {
      clearInterval(timer);
      this._taskPollTimers.delete(nodeId);
    }
  },

  /** 重新安装（下发新任务） */
  async reinstallTask(nodeId: string, skillId: string, skillName: string) {
    try {
      const res = await App.authFetch(`/api/nodes/${nodeId}/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId, source: 'openclaw', name: skillName }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`重新安装已入队: ${skillName}`, 'success');
      } else {
        showToast(data.error || '重新安装失败', 'error');
      }
      this.loadTaskQueue(nodeId);
    } catch (e: any) {
      showToast('重新安装失败: ' + e.message, 'error');
    }
  },

  /** 删除任务记录 */
  async deleteTask(nodeId: string, taskId: string) {
    try {
      const res = await App.authFetch(`/api/nodes/${nodeId}/tasks/${taskId}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('任务已删除', 'success');
      } else {
        const data = await res.json();
        showToast(data.error || '删除失败', 'error');
      }
      this.loadTaskQueue(nodeId);
    } catch (e: any) {
      showToast('删除失败: ' + e.message, 'error');
    }
  },

  /** 技能卸载 */
  async uninstallSkill(nodeId: any, skillId: any) {
    if (!confirm(`确认要卸载技能 ${skillId} 吗？`)) return;
    try {
      await App.authFetch(`/api/nodes/${nodeId}/skills/${skillId}`, { method: 'DELETE' });
      showToast('技能卸载命令已下发', 'success');
      // 刷新技能面板（异步重新拉取商店数据 + 重渲染）
      const node = App.nodesData.find((n: any) => n.id === nodeId) || App.allNodesRaw.find((n: any) => n.id === nodeId) || { id: nodeId };
      this.loadSkillsTab(node);
    } catch (e: any) {
      console.error(e);
      showToast(e.message || '技能卸载失败', 'error');
    }
  },

  /** 从技能商店删除自定义技能（内置技能服务端已拦截 403） */
  async deleteSkillFromStore(nodeId: any, storeSkillId: any, skillName: any) {
    if (!confirm(`确认要从技能商店删除「${skillName}」吗？\n此操作不会从节点卸载，但会将该技能从商店移除。`)) return;
    try {
      const res = await App.authFetch(`/api/skills/${encodeURIComponent(storeSkillId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // 内置技能服务端返回 403，给出友好提示
        if (res.status === 403) {
          showToast('内置技能不可从商店删除', 'info');
          return;
        }
      showToast(data.error || '删除失败', 'error');
      return;
    }
    showToast(`「${skillName}」已从商店删除`, 'success');
    // 刷新技能面板
    const node = App.nodesData.find((n: any) => n.id === nodeId) || App.allNodesRaw.find((n: any) => n.id === nodeId) || { id: nodeId };
    this.loadSkillsTab(node);
  } catch (e: any) {
    showToast(e.message || '删除失败', 'error');
  }
},

  /** 重启 OpenClaw（通过 Agent 任务队列） */
  async restartOpenClaw(nodeId: any) {
    const btn = document.getElementById(`claw-restart-btn-${nodeId}`);
    if (!confirm('确认重启此节点上的 OpenClaw Gateway？服务将短暂中断。')) return;
    if (btn) { (btn as HTMLButtonElement).disabled = true; btn.textContent = '下发中…'; }
    try {
      const res = await App.authFetch(`/api/claw/${encodeURIComponent(nodeId)}/restart`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || '下发失败', 'error'); }
      else { showToast('重启命令已入队，请稍后刷新状态', 'success'); }
    } catch (e: any) {
      showToast(e.message || '下发失败', 'error');
    } finally {
      if (btn) { (btn as HTMLButtonElement).disabled = false; btn.innerHTML = `<span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${(window as any).lucide?.icons?.['refresh-cw']?.toSvg?.() || '⟳'}</span> 重启`; }
    }
  },

  /** 更新 OpenClaw（通过 Agent 任务队列，超时 3min） */
  async updateOpenClaw(nodeId: any) {
    const btn = document.getElementById(`claw-update-btn-${nodeId}`);
    if (!confirm('确认更新此节点上的 OpenClaw？更新期间服务将重启，可能需要 1~3 分钟。')) return;
    if (btn) { (btn as HTMLButtonElement).disabled = true; btn.textContent = '下发中…'; }
    try {
      const res = await App.authFetch(`/api/claw/${encodeURIComponent(nodeId)}/update`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || '下发失败', 'error'); }
      else { showToast('更新任务已入队，请在任务队列中查看进度', 'success'); }
    } catch (e: any) {
      showToast(e.message || '下发失败', 'error');
    } finally {
      if (btn) { (btn as HTMLButtonElement).disabled = false; btn.innerHTML = `<span class="[&_svg]:w-3.5 [&_svg]:h-3.5">⇧</span> 更新`; }
    }
  },
};

