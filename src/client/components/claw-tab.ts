/**
 * claw-tab.ts — OpenClaw 子 Tab 组件
 *
 * 职责：status/config/sessions 子 Tab 渲染 + 配置防脑裂保存 + models + channels
 */
import { L, refreshIcons, escHtml, showToast, safeAttr } from '../utils';
import { App } from '../core';
import { renderNode } from '../vdom';
import { Modal } from '../modal';
import {
  getNodeConfig, getMonitorNode, guardClawToken, fetchTabData,
  renderInfo, renderLoading, statCard, tabShell,
} from './panel-helpers';

// Config Tab 局部双向绑定状态树
const _configState: Record<string, { raw: string; original: string; hash: string; saving: boolean }> = {};

// ——— OpenClaw 主 Tab（status/config/sessions） ——————————————

export async function loadClawTab(nodeId: string, subTab?: string) {
  const container = document.getElementById(`inline-tab-content-${nodeId}`);
  if (!container) return;
  const nid = safeAttr(nodeId);

  const subTabs = [
    { key: 'status',   icon: 'activity',      label: '状态' },
    { key: 'config',   icon: 'settings',       label: '配置' },
    { key: 'sessions', icon: 'message-square', label: '会话' },
  ];
  const activeSubTab = subTab || 'status';

  container.innerHTML = `
  <div class="px-6 pb-8 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
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
    <div class="flex gap-1 mb-4">
      ${subTabs.map(st => `<button class="px-3 py-1.5 text-xs rounded-lg transition cursor-pointer flex items-center gap-1.5 [&_svg]:w-3.5 [&_svg]:h-3.5 ${activeSubTab === st.key ? 'bg-primary/10 text-primary font-medium' : 'text-text-muted hover:text-text-primary hover:bg-elevated'}" onclick="Nodes.switchClawSubTab('${nid}','${st.key}')">${L(st.icon)} ${st.label}</button>`).join('')}
    </div>
    <div id="claw-content-${nid}" class="text-sm text-text-muted flex items-center gap-2 py-4 justify-center">
      <span class="[&_svg]:w-4 [&_svg]:h-4 animate-spin">${L('loader-2')}</span> 加载中…
    </div>
  </div>`;
  refreshIcons();

  const nodeConfig = getNodeConfig(nodeId);
  const detail = document.getElementById(`claw-content-${nodeId}`);
  if (!detail) return;

  const monNode = getMonitorNode(nodeId);
  const oc = monNode?.openclaw;

  if (activeSubTab === 'status') {
    if (!oc) {
      detail.innerHTML = renderInfo('未检测到 OpenClaw 信息，等待终端上报…');
      refreshIcons();
      return;
    }

    const tokenPreview = nodeConfig?.clawToken ? nodeConfig.clawToken.substring(0, 12) + '…' : '无';
    detail.innerHTML = `
      <div class="space-y-3">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          ${statCard(L('activity'), '状态', oc.running ? '运行中' : '未运行', oc.running ? 'text-success' : 'text-warning')}
          ${statCard(L('tag'), '版本', escHtml(oc.version || '—'), '')}
          ${statCard(L('key'), 'Token', tokenPreview, nodeConfig?.clawToken ? 'text-primary' : 'text-text-muted')}
          ${statCard(L('clock'), '运行时长', oc.uptimeMs ? `${Math.round(oc.uptimeMs / 3600000)}h` : '—', '')}
        </div>
        ${!nodeConfig?.clawToken && oc.running ? `<div class="text-xs text-text-muted mt-2">${L('info')} Token 正在通过隧道自动协商中...</div>` : ''}
      </div>`;
    refreshIcons();
    return;
  }

  if (!guardClawToken(nodeId, detail)) return;

  const data = await fetchTabData(nodeId, activeSubTab, detail);
  if (!data) return;

  if (activeSubTab === 'config') {
    const configData = data.data || data;
    const hash = data.hash || '';
    const rawString = typeof configData === 'string' ? configData : JSON.stringify(configData, null, 2);

    _configState[nodeId] = { raw: rawString, original: rawString, hash, saving: false };
    renderConfigTab(nodeId);
  } else {
    detail.innerHTML = `<pre class="text-xs bg-base rounded-lg p-3 overflow-x-auto max-h-60">${escHtml(JSON.stringify(data, null, 2))}</pre>`;
  }
  refreshIcons();
}

// ——— Config Tab VDOM 渲染 ——————————————

export function renderConfigTab(nodeId: string) {
  const nid = safeAttr(nodeId);
  const detail = document.getElementById(`claw-content-${nid}`);
  if (!detail) return;
  const state = _configState[nodeId];
  if (!state) return;

  const changed = state.raw !== state.original;
  const html = `
    <div class="space-y-3">
      <div class="text-xs text-text-muted flex items-center gap-1.5">
        ${L('info')} 直接编辑下方配置，点击保存后将下发到节点并触发配置重载
      </div>
      <textarea
        id="claw-config-editor-${nid}"
        class="w-full font-mono text-xs bg-base border border-border-default/40 rounded-lg p-3 h-64 resize-y
               text-text-primary focus:outline-none focus:border-primary/60 transition"
        spellcheck="false"
        oninput="NodeDetailPanel.onConfigInput('${nid}')"
      >${escHtml(state.raw)}</textarea>
      <div class="flex items-center justify-between gap-3">
        <div class="text-xs flex-1 truncate ${changed ? 'text-amber-400' : 'text-text-muted'}">
          ${changed ? '⚡ 有未保存的修改' : ''}
        </div>
        <div class="flex gap-2">
          <button onclick="NodeDetailPanel.resetClawConfig('${nid}')"
            class="px-3 py-1.5 text-xs rounded-lg border border-border-default/40 text-text-muted
                   hover:text-text-primary hover:bg-elevated transition cursor-pointer">
            重置
          </button>
          <button onclick="NodeDetailPanel.saveClawConfig('${nid}')"
            ${state.saving ? 'disabled' : ''}
            class="px-4 py-1.5 text-xs rounded-lg bg-primary hover:bg-primary/90 text-white
                   font-medium transition cursor-pointer flex items-center gap-1.5">
            ${state.saving ? `<span class="[&_svg]:w-3.5 [&_svg]:h-3.5 animate-spin">${L('loader-2')}</span> 保存中…` : `${L('save')} 保存`}
          </button>
        </div>
      </div>
    </div>`;

  renderNode(detail, html);
  refreshIcons();
}

export function onConfigInput(nodeId: string) {
  const textarea = document.getElementById(`claw-config-editor-${nodeId}`) as HTMLTextAreaElement;
  if (!textarea || !_configState[nodeId]) return;
  _configState[nodeId].raw = textarea.value;
  renderConfigTab(nodeId);
}

export async function saveClawConfig(nodeId: string) {
  const state = _configState[nodeId];
  if (!state) return;

  if (state.raw === state.original) {
    showToast('配置无变化，无需保存', 'info');
    return;
  }

  state.saving = true;
  renderConfigTab(nodeId);

  try {
    const res = await App.authFetch(`/api/claw/${encodeURIComponent(nodeId)}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: state.raw, baseHash: state.hash }),
    });
    const json = await res.json();

    if (res.status === 409) {
      showToast('脑裂冲突：远程配置已被修改！请刷新重试', 'error');
      Modal.alert('配置过期防冲突机制', '另一个终端（或后台）已抢先修改了该节点的配置文件。为防止数据覆盖（脑裂），本次保存请求已被拦截。<br><br>请<b>刷新节点配置</b>合并最新修改。');
      return;
    }

    if (json.ok || res.ok) {
      showToast('配置已保存并下发', 'success');
      state.original = state.raw;
      if (json.hash) state.hash = json.hash;
    } else {
      showToast(`保存失败: ${json.error || '未知错误'}`, 'error');
    }
  } catch (err: any) {
    showToast(`保存失败: ${err.message}`, 'error');
  } finally {
    state.saving = false;
    renderConfigTab(nodeId);
  }
}

export function resetClawConfig(nodeId: string) {
  const state = _configState[nodeId];
  if (!state) return;
  state.raw = state.original;
  renderConfigTab(nodeId);
}

// ——— Models Tab ——————————————

export async function loadModelsTab(nodeId: string) {
  const container = document.getElementById(`inline-tab-content-${nodeId}`);
  if (!container) return;
  const nid = safeAttr(nodeId);

  container.innerHTML = tabShell({
    nid, icon: 'sparkles', title: 'AI 模型',
    contentId: `models-content-${nid}`,
    refreshFn: `NodeDetailPanel.loadModelsTab('${nid}')`,
    loadingText: '加载模型列表…',
  });
  refreshIcons();

  const detail = document.getElementById(`models-content-${nid}`);
  if (!detail) return;
  if (!guardClawToken(nodeId, detail)) return;

  const data = await fetchTabData(nodeId, 'models', detail);
  if (!data) return;

  const models: any[] = data.data || data.models || [];
  if (models.length === 0) {
    detail.innerHTML = `<div class="text-text-muted text-sm">${L('box')} 暂无可用模型</div>`;
    refreshIcons();
    return;
  }

  let html = `<div class="grid grid-cols-1 md:grid-cols-2 gap-3">`;
  for (const m of models) {
    const name = m.id || m.name || '';
    const ctx = m.context_length ? `上下文 ${m.context_length.toLocaleString()} tokens` : '';
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
            ${ctx ? `<p class="text-[10px] text-primary/70 mt-1 font-mono">${escHtml(ctx)}</p>` : ''}
          </div>
        </div>
      </div>`;
  }
  html += `</div>`;
  detail.innerHTML = html;
  refreshIcons();
}

// ——— Channels Tab ——————————————

export async function loadChannelsTab(nodeId: string) {
  const container = document.getElementById(`inline-tab-content-${nodeId}`);
  if (!container) return;
  const nid = safeAttr(nodeId);

  container.innerHTML = tabShell({
    nid, icon: 'radio', title: '渠道管理',
    contentId: `channels-content-${nid}`,
    refreshFn: `NodeDetailPanel.loadChannelsTab('${nid}')`,
    loadingText: '加载渠道状态…',
  });
  refreshIcons();

  const detail = document.getElementById(`channels-content-${nid}`);
  if (!detail) return;
  if (!guardClawToken(nodeId, detail)) return;

  const data = await fetchTabData(nodeId, 'channels', detail);
  if (!data) return;

  const channels: any[] = data.channels || (Array.isArray(data) ? data : []);
  if (channels.length === 0) {
    detail.innerHTML = `
      <div class="flex flex-col items-center gap-2 text-text-muted text-sm py-4">
        ${L('radio')}
        <span>暂无配置渠道</span>
        <pre class="text-xs bg-base rounded-lg p-3 mt-2 overflow-x-auto max-h-40 w-full">${escHtml(JSON.stringify(data, null, 2))}</pre>
      </div>`;
    refreshIcons();
    return;
  }

  let html = `<div class="space-y-2">`;
  for (const ch of channels) {
    const name = ch.name || ch.id || '未命名';
    const type = ch.type || ch.provider || '';
    const enabled = ch.enabled !== false;
    const health = ch.healthy ?? ch.connected ?? null;
    const statusColor = enabled ? (health === false ? 'text-danger' : 'text-success') : 'text-text-muted';
    const statusLabel = !enabled ? '禁用' : health === false ? '异常' : health === true ? '正常' : '在线';

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
  refreshIcons();
}

// ——— OpenClaw 操作 ——————————————

export async function restartOpenClaw(nodeId: string) {
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
    if (btn) {
      (btn as HTMLButtonElement).disabled = false;
      btn.innerHTML = `<span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${(window as any).lucide?.icons?.['refresh-cw']?.toSvg?.() || '⟳'}</span> 重启`;
    }
  }
}

export async function updateOpenClaw(nodeId: string) {
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
    if (btn) {
      (btn as HTMLButtonElement).disabled = false;
      btn.innerHTML = `<span class="[&_svg]:w-3.5 [&_svg]:h-3.5">⇧</span> 更新`;
    }
  }
}
