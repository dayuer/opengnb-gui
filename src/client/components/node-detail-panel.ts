// @alpha: 节点详情展开面板 — 从 nodes.ts 提取
// 包含：概览/终端/技能/OpenClaw 四个 Tab 的渲染和交互逻辑
import { $, L, refreshIcons, escHtml, showToast, formatBytes, pctColor, pctBg, safeAttr } from '../utils';
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
      { key: 'claw', icon: 'bot', label: 'OpenClaw' },
      { key: 'terminal', icon: 'terminal', label: '终端' },
      { key: 'skills', icon: 'blocks', label: '技能' },
    ];

    let html = `<div>
      <div class="flex gap-1 mb-4 border-b border-border-subtle pb-2">
        ${tabs.map(t => `<button class="px-3 py-1.5 text-xs rounded-md transition cursor-pointer flex items-center gap-1.5 [&_svg]:w-3.5 [&_svg]:h-3.5 ${ts.tab === t.key ? 'bg-primary/10 text-primary font-medium' : 'text-text-secondary hover:text-text-primary hover:bg-elevated'}" onclick="Nodes.switchTab('${safeAttr(node.id)}','${t.key}')">${L(t.icon)} ${t.label}</button>`).join('')}
      </div>
      <div id="inline-tab-content-${safeAttr(node.id)}">`;

    if (ts.tab === 'overview') html += this.renderOverview(node);
    else if (ts.tab === 'terminal') html += this.renderTerminal(node);
    else if (ts.tab === 'skills') html += this.renderSkills(node);
    else html += `<div class="text-text-muted text-sm">${L('loader')} 加载中…</div>`;

    html += `</div></div>`;
    panel.innerHTML = html;
    refreshIcons();

    if (ts.tab === 'claw') this.loadClawTab(node.id, ts.clawSubTab);
    if (ts.tab === 'terminal') this.initChat(node.id);
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
    const clawRunning = oc.running === true;

    let html = `<div class="space-y-4">`;
    html += `<div><div class="text-xs font-bold text-primary uppercase tracking-widest mb-2">运行状态</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        ${this.statCard(L('activity'), '采集延迟', `${node.sshLatencyMs||0}ms`, node.sshLatencyMs > 500 ? 'text-danger' : 'text-success')}
        ${this.statCard(L('clock'), '运行时长', escHtml(si.uptime || '—'), '')}
        ${this.statCard(L('bot'), 'OpenClaw', clawRunning ? '运行中' : '未运行', clawRunning ? 'text-success' : 'text-warning')}
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

  renderSkills(node: any) {
    const rawNode = App.allNodesRaw.find((n: any) => n.id === node.id);
    const installedSkills = rawNode?.skills || node.skills || [];
    const nid = safeAttr(node.id);

    let html = `
    <div class="px-6 pb-8 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
      <div class="flex items-center justify-between mb-8 border-b border-border-default/20 pb-4">
        <h4 class="text-xl font-headline font-bold tracking-tight text-text-primary">Installed Skills</h4>
        <div class="flex gap-2">
          <button class="px-4 py-1.5 rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-white text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer" onclick="App.switchPage('skills')">
            <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('plus')}</span> 部署新技能
          </button>
        </div>
      </div>
    `;

    if (installedSkills.length === 0) {
      html += `
        <div class="flex flex-col items-center justify-center py-12 text-text-muted">
          <div class="w-16 h-16 rounded-full bg-surface mb-4 flex items-center justify-center border border-border-default/20">
            <span class="[&_svg]:w-8 [&_svg]:h-8 opacity-50">${L('box')}</span>
          </div>
          <p class="text-sm">此节点暂未安装任何技能</p>
          <button class="mt-4 px-4 py-1.5 rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-white text-xs font-bold uppercase transition-all cursor-pointer" onclick="App.switchPage('skills')">
            前往技能商店
          </button>
        </div>
      `;
    } else {
      html += `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">`;
      for (const skill of installedSkills) {
        html += `
          <div class="bg-elevated/40 border border-border-default/30 p-4 rounded-xl flex items-center justify-between group/chip transition-all hover:bg-elevated hover:border-primary/30">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-lg bg-surface flex items-center justify-center text-primary shadow-sm">
                <span class="[&_svg]:w-5 [&_svg]:h-5">${L(skill.icon || 'box')}</span>
              </div>
              <div>
                <p class="text-sm font-medium text-text-primary whitespace-nowrap overflow-hidden text-ellipsis w-24">${escHtml(skill.name || skill.id)}</p>
                <p class="text-[10px] text-text-muted font-mono">${escHtml(skill.version || 'v1.0.0')}</p>
              </div>
            </div>
            <button class="w-8 h-8 rounded-lg flex items-center justify-center text-danger opacity-0 group-hover/chip:opacity-100 hover:bg-danger/10 transition-all cursor-pointer" title="卸载" onclick="event.stopPropagation();Nodes.uninstallSkill('${nid}', '${safeAttr(skill.id)}')">
              <span class="[&_svg]:w-4 [&_svg]:h-4">${L('trash-2')}</span>
            </button>
          </div>
        `;
      }
      html += `</div>`;
    }
    html += `</div>`;
    return html;
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
    const subTabs = [
      { key: 'status', icon: 'activity', label: '状态' },
      { key: 'models', icon: 'cpu', label: '模型' },
      { key: 'config', icon: 'settings', label: '配置' },
      { key: 'sessions', icon: 'message-square', label: '会话' },
      { key: 'channels', icon: 'radio', label: '渠道' },
    ];
    let html = `<div class="flex gap-1 mb-3">${subTabs.map(st => `<button class="px-2.5 py-1 text-xs rounded transition cursor-pointer ${subTab === st.key ? 'bg-primary/10 text-primary' : 'text-text-muted hover:text-text-primary hover:bg-elevated'}" onclick="Nodes.switchClawSubTab('${safeAttr(nodeId)}','${st.key}')">${L(st.icon)} ${st.label}</button>`).join('')}</div>
    <div id="claw-content-${safeAttr(nodeId)}" class="text-sm text-text-muted">${L('loader')} 加载中…</div>`;
    container.innerHTML = html;
    refreshIcons();

    const nodeConfig = App.allNodesRaw.find((n: any) => n.id === nodeId);
    const detail = document.getElementById(`claw-content-${nodeId}`);
    if (!detail) return;

    if (!nodeConfig?.clawToken) {
      const monNode = App.nodesData.find((n: any) => n.id === nodeId);
      const oc = monNode?.openclaw;
      if (oc && oc.running && oc.config) {
        const gw = oc.config.gateway || {};
        const tokenPreview = gw.auth?.token ? gw.auth.token.substring(0, 12) + '…' : '无';
        detail.innerHTML = `
          <div class="space-y-3">
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
              ${this.statCard(L('activity'), '状态', oc.running ? '运行中' : '未运行', oc.running ? 'text-success' : 'text-warning')}
              ${this.statCard(L('hash'), 'PID', oc.pid || '-', '')}
              ${this.statCard(L('radio'), '端口', gw.port || '-', '')}
              ${this.statCard(L('key-round'), 'Token', tokenPreview, 'font-mono text-xs')}
              ${this.statCard(L('folder'), '配置路径', oc.configPath || '-', 'text-xs')}
              ${this.statCard(L('wifi'), 'RPC 健康', oc.rpcOk ? '正常' : '不可用', oc.rpcOk ? 'text-success' : 'text-warning')}
            </div>
            <details class="text-xs">
              <summary class="cursor-pointer text-text-muted hover:text-text-primary transition">查看完整配置 JSON</summary>
              <pre class="bg-base rounded-lg p-3 mt-2 overflow-x-auto">${escHtml(JSON.stringify(oc.config, null, 2))}</pre>
            </details>
            <div class="text-xs text-text-muted">${L('info')} Token 将在下次 Agent 上报时自动同步到配置表</div>
          </div>`;
      } else if (oc && !oc.running) {
        detail.innerHTML = `<div class="text-warning text-sm">${L('alert-triangle')} OpenClaw 未运行 (进程未检测到)</div>`;
      } else {
        detail.innerHTML = `<div class="text-text-muted text-sm">${L('info')} 未检测到 OpenClaw 信息，等待 Agent 上报…</div>`;
      }
      refreshIcons();
      return;
    }

    try {
      const res = await App.authFetch(`/api/claw/${encodeURIComponent(nodeId)}/${subTab}`);
      const data = await res.json();
      if (data.error) { detail.innerHTML = `<div class="text-danger text-sm">${escHtml(data.error)}</div>`; return; }
      detail.innerHTML = `<pre class="text-xs bg-base rounded-lg p-3 overflow-x-auto max-h-60">${escHtml(JSON.stringify(data, null, 2))}</pre>`;
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

  /** 技能卸载 */
  async uninstallSkill(nodeId: any, skillId: any) {
    if (!confirm(`确认要卸载技能 ${skillId} 吗？`)) return;
    try {
      await App.authFetch(`/api/nodes/${nodeId}/skills/${skillId}`, { method: 'DELETE' });
      showToast('技能卸载命令已下发', 'success');
      const node = App.allNodesRaw.find((n: any) => n.id === nodeId);
      if (node && node.skills) {
        node.skills = node.skills.filter((s: any) => s.id !== skillId);
      }
      const wrap = document.getElementById(`inline-tab-content-${nodeId}`);
      if (wrap) {
        wrap.innerHTML = this.renderSkills(node || { id: nodeId, skills: [] });
        refreshIcons();
      }
    } catch (e: any) {
      console.error(e);
      showToast(e.message || '技能卸载失败', 'error');
    }
  },
};
