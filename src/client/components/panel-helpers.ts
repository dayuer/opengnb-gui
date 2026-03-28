/**
 * panel-helpers.ts — 节点面板通用工具层
 *
 * 职责：
 *   1. nodeConfig 查找（消除 `App.allNodesRaw.find(...)` 的重复散落）
 *   2. 通用错误/状态渲染原子（消除 `detail.innerHTML = \`<div class="text-danger ...` 的代码泥团）
 *   3. statCard / gaugeCard UI 原子
 */
import { L, refreshIcons, escHtml, pctColor, pctBg, safeAttr } from '../utils';
import { App } from '../core';

// ——— 数据查找 ———

/** 从全局状态获取节点原始配置（含 clawToken 等） */
export function getNodeConfig(nodeId: string): any | undefined {
  return App.allNodesRaw.find((n: any) => n.id === nodeId);
}

/** 从监控数据获取节点运行时信息（含 openclaw 等） */
export function getMonitorNode(nodeId: string): any | undefined {
  return App.nodesData.find((n: any) => n.id === nodeId);
}

/** 兜底查找节点（优先监控数据 → 原始配置 → 最小占位） */
export function findNodeAny(nodeId: string): any {
  return getMonitorNode(nodeId) || getNodeConfig(nodeId) || { id: nodeId };
}

// ——— 通用渲染原子 ———

/** 渲染加载中占位符 */
export function renderLoading(text = '加载中…'): string {
  return `<div class="flex items-center gap-2 text-text-muted text-sm py-8 justify-center">
    <span class="[&_svg]:w-4 [&_svg]:h-4 animate-spin">${L('loader-2')}</span> ${text}
  </div>`;
}

/** 渲染错误提示（统一红色文案样式） */
export function renderError(message: string): string {
  return `<div class="text-danger text-sm">${escHtml(message)}</div>`;
}

/** 渲染信息提示（灰色 info 图标 + 文案） */
export function renderInfo(message: string): string {
  return `<div class="text-text-muted text-sm flex items-center gap-2">${L('info')} ${message}</div>`;
}

/** 渲染警告提示 */
export function renderWarning(message: string): string {
  return `<div class="text-warning text-sm flex items-center gap-2">${L('alert-triangle')} ${message}</div>`;
}

/**
 * 通用 Claw Tab 守卫：检查 clawToken 是否可用
 * @returns true=可继续，false=已渲染守卫提示（调用者应 return）
 */
export function guardClawToken(nodeId: string, detail: HTMLElement): boolean {
  const nc = getNodeConfig(nodeId);
  if (!nc?.clawToken) {
    detail.innerHTML = renderWarning('等待 Token 协商完成才能查看详情');
    refreshIcons();
    return false;
  }
  return true;
}

/**
 * 通用异步 Tab 数据获取包装器
 * 处理 fetch → json → error/success 的标准流程
 */
export async function fetchTabData(
  nodeId: string,
  endpoint: string,
  detail: HTMLElement
): Promise<any | null> {
  try {
    const res = await App.authFetch(`/api/claw/${encodeURIComponent(nodeId)}/${endpoint}`);
    const data = await res.json();
    if (data.error) {
      detail.innerHTML = renderError(data.error);
      refreshIcons();
      return null;
    }
    return data;
  } catch (err: any) {
    detail.innerHTML = renderError(`请求失败: ${err.message}`);
    refreshIcons();
    return null;
  }
}

// ——— UI 卡片原子 ———

export function statCard(icon: string, label: string, value: string, color: string, sub?: string): string {
  return `<div class="bg-elevated rounded-lg border border-border-subtle p-3">
    <div class="flex items-center gap-1.5 mb-1"><span class="[&_svg]:w-3.5 [&_svg]:h-3.5 text-text-muted">${icon}</span><span class="text-xs text-text-muted">${label}</span></div>
    <div class="text-sm font-semibold ${color}">${value}</div>
    ${sub ? `<div class="text-xs text-text-muted mt-0.5">${sub}</div>` : ''}
  </div>`;
}

export function gaugeCard(icon: string, label: string, value: string, pct: number, sub: string): string {
  const c = pctBg(pct);
  return `<div class="bg-elevated rounded-lg border border-border-subtle p-3">
    <div class="flex items-center gap-1.5 mb-1"><span class="[&_svg]:w-3.5 [&_svg]:h-3.5 text-text-muted">${icon}</span><span class="text-xs text-text-muted">${label}</span></div>
    <div class="text-sm font-semibold ${pctColor(pct)}">${value}</div>
    ${pct > 0 ? `<div class="gauge-bar mt-1.5"><div class="gauge-fill ${c}" style="width:${Math.min(pct, 100)}%"></div></div>` : ''}
    ${sub ? `<div class="text-xs text-text-muted mt-0.5">${sub}</div>` : ''}
  </div>`;
}

/** Tab 容器骨架（标题 + 刷新按钮 + loading 内容区） */
export function tabShell(opts: {
  nid: string;
  icon: string;
  title: string;
  contentId: string;
  refreshFn: string;
  loadingText?: string;
}): string {
  return `
  <div class="px-6 pb-8 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
    <div class="flex items-center justify-between mb-6 border-b border-border-default/20 pb-4">
      <h4 class="text-xl font-headline font-bold tracking-tight text-text-primary flex items-center gap-2">
        <span class="[&_svg]:w-5 [&_svg]:h-5 text-primary">${L(opts.icon)}</span> ${opts.title}
      </h4>
      <button class="p-2 rounded-lg text-text-muted hover:text-primary hover:bg-primary/10 transition cursor-pointer [&_svg]:w-4 [&_svg]:h-4"
        title="刷新" onclick="${opts.refreshFn}">
        ${L('refresh-cw')}
      </button>
    </div>
    <div id="${opts.contentId}" class="flex items-center gap-2 text-text-muted text-sm py-8 justify-center">
      <span class="[&_svg]:w-4 [&_svg]:h-4 animate-spin">${L('loader-2')}</span> ${opts.loadingText || '加载中…'}
    </div>
  </div>`;
}
