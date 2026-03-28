/**
 * chat-tab.ts — AI Chat WebSocket 终端组件
 *
 * 职责：Chat 生命周期管理（connect/disconnect）+ 消息发送/渲染 + Markdown 解析
 */
import { L, refreshIcons, escHtml, safeAttr } from '../utils';
import { App } from '../core';

let _chatSessions: Record<string, { ws: WebSocket }> = {};
let _termMaximized = false;

// ——— UI 渲染 ———

export function renderTerminal(node: any): string {
  const shortcuts = [
    { prompt: '请检查 GNB 和 OpenClaw 服务状态', icon: 'activity', label: '状态检查' },
    { prompt: '请重启 GNB 服务', icon: 'refresh-cw', label: '重启 GNB' },
    { prompt: '请查看 GNB 和 OpenClaw 最近 30 条日志', icon: 'file-text', label: '查看日志' },
    { prompt: '请检查磁盘空间使用情况', icon: 'hard-drive', label: '磁盘用量' },
    { prompt: '请查看系统性能概况（CPU/负载/进程）', icon: 'gauge', label: '性能' },
    { prompt: '请查看内存使用情况', icon: 'memory-stick', label: '内存' },
  ];
  const hClass = _termMaximized ? 'h-[calc(100vh-280px)]' : 'h-80';
  const nid = safeAttr(node.id);

  return `<div class="rounded-xl border border-border-default overflow-hidden flex flex-col bg-surface shadow-md" id="terminal-wrap-${nid}">
    <!-- 深色头部栏 -->
    <div class="flex items-center gap-3 px-4 py-2.5 bg-[#1a1b2e]">
      <span class="text-white text-xs font-bold tracking-tight flex items-center gap-1.5 [&_svg]:w-3.5 [&_svg]:h-3.5">${L('terminal')} AI Ops Terminal</span>
      <span id="term-status-${nid}" class="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400 uppercase tracking-widest"><span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>连接中</span>
      <span class="px-2 py-0.5 rounded-md bg-white/10 text-white/80 text-[10px] font-mono">${escHtml(node.name || node.id)}</span>
      <div class="ml-auto flex items-center gap-1">
        <button class="p-1 rounded text-white/50 hover:text-white hover:bg-white/10 transition cursor-pointer [&_svg]:w-3.5 [&_svg]:h-3.5" onclick="Nodes.toggleTerminalSize('${nid}')" title="${_termMaximized ? '还原' : '最大化'}">${L(_termMaximized ? 'minimize-2' : 'maximize-2')}</button>
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
}

// ——— WebSocket 生命周期 ———

export function initChat(nodeId: string) {
  if (_chatSessions[nodeId]) return;
  const msgBox = document.getElementById(`chat-messages-${nodeId}`);
  if (!msgBox) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = App.getToken();
  const ws = new WebSocket(`${proto}://${location.host}/ws/ai`);

  let aiBuf = '';

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token, nodeId }));
    updateTermStatus(nodeId, true);
    appendMsg(nodeId, 'system', '✓ AI 助手已连接');
  };

  ws.onmessage = (e) => {
    let chunk: any;
    try { chunk = JSON.parse(e.data); } catch (_) { return; }

    if (chunk.type === 'ack') { aiBuf = ''; return; }
    if (chunk.type === 'busy') { appendMsg(nodeId, 'system', chunk.text); return; }
    if (chunk.type === 'error') { appendMsg(nodeId, 'system', `❌ ${chunk.text || '执行失败'}`); return; }
    if (chunk.type === 'done') { aiBuf = ''; return; }

    const bubble = getOrCreateAiBubble(nodeId);
    if (!bubble) return;

    if (chunk.type === 'assistant' && chunk.message?.content) {
      for (const block of chunk.message.content) {
        if (block.type === 'text') {
          aiBuf += block.text;
          bubble.innerHTML = renderMd(aiBuf);
        }
      }
    } else if (chunk.type === 'content_block_delta') {
      if (chunk.delta?.type === 'text_delta') {
        aiBuf += chunk.delta.text;
        bubble.innerHTML = renderMd(aiBuf);
      }
    } else if (chunk.type === 'result') {
      const text = chunk.result || '';
      if (text) {
        aiBuf = text;
        bubble.innerHTML = renderMd(aiBuf);
      }
      aiBuf = '';
    }

    msgBox.scrollTop = msgBox.scrollHeight;
  };

  ws.onerror = () => {
    updateTermStatus(nodeId, false);
    appendMsg(nodeId, 'system', '❌ 连接错误');
  };

  ws.onclose = (e) => {
    updateTermStatus(nodeId, false);
    appendMsg(nodeId, 'system', `连接已断开 (${e.code})`);
    delete _chatSessions[nodeId];
  };

  _chatSessions[nodeId] = { ws };
}

export function destroyChat(nodeId: string) {
  const s = _chatSessions[nodeId];
  if (!s) return;
  if (s.ws && s.ws.readyState <= 1) s.ws.close();
  delete _chatSessions[nodeId];
}

// ——— 消息操作 ———

export function sendChat(nodeId: string) {
  const input = document.getElementById(`chat-input-${nodeId}`);
  if (!input) return;
  const text = (input as HTMLInputElement).value.trim();
  if (!text) return;
  (input as HTMLInputElement).value = '';
  const s = _chatSessions[nodeId];
  if (!s || !s.ws || s.ws.readyState !== 1) {
    appendMsg(nodeId, 'system', '⚠️ 未连接，请稍候重试');
    return;
  }
  appendMsg(nodeId, 'user', text);
  s.ws.send(JSON.stringify({ type: 'chat', text }));
}

export function quickCmd(nodeId: string, prompt: string) {
  const s = _chatSessions[nodeId];
  if (!s || !s.ws || s.ws.readyState !== 1) {
    appendMsg(nodeId, 'system', '⚠️ AI 助手未连接');
    return;
  }
  appendMsg(nodeId, 'user', prompt);
  s.ws.send(JSON.stringify({ type: 'chat', text: prompt }));
}

export function toggleTerminalSize(nodeId: string) {
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
}

// ——— 内部辅助 ———

function appendMsg(nodeId: string, role: string, content: string): HTMLDivElement | undefined {
  const box = document.getElementById(`chat-messages-${nodeId}`);
  if (!box) return;
  const div = document.createElement('div');
  if (role === 'user') {
    div.className = 'flex justify-end';
    div.innerHTML = `<div class="px-3.5 py-2 rounded-xl rounded-tr-sm text-sm text-white max-w-[80%] signature-gradient shadow-sm">${_escHtml(content)}</div>`;
  } else if (role === 'ai') {
    div.className = 'flex gap-2.5 items-start ai-msg';
    div.innerHTML = `<div class="w-7 h-7 rounded-full signature-gradient flex items-center justify-center text-xs text-white flex-shrink-0 shadow-sm">AI</div><div class="bg-base border border-border-subtle rounded-xl rounded-tl-sm px-3.5 py-2.5 text-sm text-text-secondary leading-relaxed max-w-[85%] ai-text"></div>`;
  } else {
    div.className = 'flex justify-center';
    div.innerHTML = `<span class="text-[10px] px-3 py-1 rounded-full bg-elevated text-text-muted font-medium">${_escHtml(content)}</span>`;
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function getOrCreateAiBubble(nodeId: string): Element | null {
  const box = document.getElementById(`chat-messages-${nodeId}`);
  if (!box) return null;
  const last = box.querySelector('.ai-msg:last-child');
  if (last) return last.querySelector('.ai-text');
  const div = appendMsg(nodeId, 'ai', '');
  return div?.querySelector('.ai-text') || null;
}

function updateTermStatus(nodeId: string, connected: boolean) {
  const el = document.getElementById(`term-status-${nodeId}`);
  if (!el) return;
  if (connected) {
    el.className = 'flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400 uppercase tracking-widest';
    el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>已连接';
  } else {
    el.className = 'flex items-center gap-1.5 text-[10px] font-semibold text-red-400 uppercase tracking-widest';
    el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>已断开';
  }
}

function _escHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderMd(text: string): string {
  let html = _escHtml(text);
  html = html.replace(/```([\s\S]*?)```/g, '<pre class="bg-[#1e1e2e] text-emerald-300 px-3.5 py-3 rounded-lg text-xs overflow-x-auto my-2 font-mono leading-relaxed">$1</pre>');
  html = html.replace(/`([^`]+)`/g, '<code class="bg-elevated text-primary px-1.5 py-0.5 rounded text-xs font-mono">$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="text-text-primary font-semibold">$1</strong>');
  html = html.replace(/\n/g, '<br>');
  return html;
}
