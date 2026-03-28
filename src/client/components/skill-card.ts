/**
 * skill-card.ts — 技能卡片复用组件库
 *
 * 导出三种形态，按使用场景选择：
 *
 *  ┌─────────────────────────────────────────────────────────────┐
 *  │ skillChip(nodeId, skill, isBuiltin)                         │
 *  │   节点详情面板 - 已安装技能卡片（紧凑 chip）                    │
 *  │   带状态指示点 + 卸载/删商店按钮                               │
 *  ├─────────────────────────────────────────────────────────────┤
 *  │ storeSkillChip(nodeId, skill, isBuiltin)                    │
 *  │   节点详情面板 - 未安装技能贴片（dimmed）                       │
 *  │   点击「安装」跳转商店                                         │
 *  ├─────────────────────────────────────────────────────────────┤
 *  │ skillListItem(skill, actions?)                              │
 *  │   商店页面 / 列表视图 - 插件市场行式布局                         │
 *  │   图标 + 名称/徽章 + 描述 + 版本/时间 + 操作按钮                │
 *  └─────────────────────────────────────────────────────────────┘
 */
import { L, escHtml, safeAttr } from '../utils';

// ──────────────────────────────────────────────
// 内部共享工具
// ──────────────────────────────────────────────

/** 技能图标渲染：优先 emoji > 渐变图标 > lucide */
function iconBlock(skill: any, size: 'sm' | 'md' | 'lg' = 'md'): string {
  const sizeMap = { sm: 'w-8 h-8', md: 'w-10 h-10', lg: 'w-12 h-12' };
  const iconSizeMap = { sm: '[&_svg]:w-4 [&_svg]:h-4', md: '[&_svg]:w-5 [&_svg]:h-5', lg: '[&_svg]:w-6 [&_svg]:h-6' };
  const cls = sizeMap[size];
  const iconCls = iconSizeMap[size];

  if (skill.emoji) {
    return `<div class="${cls} rounded-xl bg-surface flex items-center justify-center shrink-0 shadow-sm">
      <span class="text-${size === 'lg' ? 'xl' : 'lg'} leading-none">${escHtml(skill.emoji)}</span>
    </div>`;
  }

  if (skill.iconGradient) {
    return `<div class="${cls} rounded-xl flex items-center justify-center shrink-0 shadow-sm ${iconCls} text-white"
         style="background:${escHtml(skill.iconGradient)}">
      ${L(skill.icon || 'box')}
    </div>`;
  }

  return `<div class="${cls} rounded-xl bg-surface flex items-center justify-center text-primary shrink-0 shadow-sm ${iconCls}">
    ${L(skill.icon || 'box')}
  </div>`;
}

/** 来源徽章 CSS 颜色映射 */
const SOURCE_BADGE: Record<string, string> = {
  clawhub:           'bg-blue-500/10 text-blue-400',
  'openclaw-bundled':'bg-cyan-500/10 text-cyan-400',
  openclaw:          'bg-blue-500/10 text-blue-400',
  github:            'bg-text-muted/10 text-text-muted',
  'skills.sh':       'bg-violet-500/10 text-violet-400',
  npm:               'bg-red-500/10 text-red-400',
  console:           'bg-emerald-500/10 text-emerald-400',
  custom:            'bg-amber-500/10 text-amber-400',
};

function sourceBadge(source: string, label: string): string {
  const cls = SOURCE_BADGE[source] || 'bg-text-muted/10 text-text-muted';
  return `<span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full ${cls} uppercase tracking-wide">${escHtml(label)}</span>`;
}

// ──────────────────────────────────────────────
// 形态一：节点面板 — 已安装技能 Chip
// ──────────────────────────────────────────────

/**
 * 节点详情面板中的已安装技能卡片（紧凑 chip 样式）
 *
 * @param nodeId  节点 ID（已 safeAttr 处理）
 * @param skill   技能数据（含 name/id/eligible/emoji/icon）
 * @param isBuiltin  true=内置技能，false=自定义技能
 */
export function skillChip(nodeId: string, skill: any, isBuiltin: boolean): string {
  const nid       = safeAttr(nodeId);
  const skillName = skill.name || skill.id || '';
  const skillId   = skill.name || skill.id || '';  // openclaw 用 name 作为 ID
  const storeId   = skill.storeId || skill.id || '';
  const isReady   = skill.eligible === true;

  const badgeColor = isBuiltin ? 'bg-primary/20 text-primary' : 'bg-amber-400/20 text-amber-300';
  const badgeLabel = isBuiltin ? '内置' : '自定义';
  const border     = isReady ? 'border-emerald-500/30' : 'border-border-default/30';
  const dot        = isReady
    ? 'bg-emerald-500" title="Ready — 依赖已就绪'
    : 'bg-amber-400/80" title="Not ready — 依赖未满足';

  return `
    <div class="bg-elevated/40 border ${border} p-4 rounded-xl flex flex-col gap-3
                transition-all hover:bg-elevated hover:border-primary/30">
      <div class="flex items-center gap-3">
        <div class="relative shrink-0">
          ${iconBlock(skill, 'md')}
          <span class="absolute -top-1 -right-1 w-3 h-3 rounded-full ${dot} border-2 border-surface"></span>
        </div>
        <div class="min-w-0">
          <p class="text-sm font-medium text-text-primary truncate max-w-[110px]">${escHtml(skillName)}</p>
          <span class="inline-block text-[9px] font-bold px-1.5 py-0.5 rounded-full ${badgeColor} uppercase tracking-wide mt-0.5">
            ${badgeLabel}
          </span>
        </div>
      </div>
      <div class="flex items-center gap-1.5 justify-end">
        <button class="px-2.5 py-1 text-xs rounded-lg text-danger hover:bg-danger/10 border border-danger/20
                       hover:border-danger/40 transition-all cursor-pointer flex items-center gap-1"
          title="卸载" onclick="event.stopPropagation();Nodes.uninstallSkill('${nid}','${safeAttr(skillId)}')">
          <span class="[&_svg]:w-3 [&_svg]:h-3">${L('power-off')}</span> 卸载
        </button>
        ${!isBuiltin && storeId ? `
        <button class="p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 border border-border-default/20
                       hover:border-danger/30 transition-all cursor-pointer"
          title="从商店删除" onclick="event.stopPropagation();Nodes.deleteSkillFromStore('${nid}','${safeAttr(storeId)}','${safeAttr(skillName)}')">
          <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('trash-2')}</span>
        </button>` : ''}
      </div>
    </div>`;
}

// ──────────────────────────────────────────────
// 形态二：节点面板 — 未安装技能贴片
// ──────────────────────────────────────────────

/**
 * 节点详情面板中的未安装技能卡片（半透明 dimmed 样式，点击跳商店）
 *
 * @param nodeId    节点 ID（已 safeAttr 处理）
 * @param skill     商店技能数据（含 name/id/category/iconGradient/icon）
 * @param isBuiltin true=内置，false=自定义
 */
export function storeSkillChip(nodeId: string, skill: any, isBuiltin: boolean): string {
  const nid       = safeAttr(nodeId);
  const skillName = skill.name || '';
  const cat       = skill.category || '';
  const badgeColor = isBuiltin ? 'bg-primary/10 text-primary/60' : 'bg-amber-400/10 text-amber-300/70';

  return `
    <div class="bg-surface/50 border border-border-default/20 p-3 rounded-xl flex flex-col gap-2
                opacity-70 hover:opacity-100 transition-opacity">
      <div class="flex items-center gap-2.5">
        ${iconBlock(skill, 'sm')}
        <div class="min-w-0">
          <p class="text-xs font-medium text-text-secondary truncate max-w-[90px]">${escHtml(skillName)}</p>
          <span class="inline-block text-[9px] px-1 py-0.5 rounded-full ${badgeColor} uppercase tracking-wide">
            ${escHtml(cat)}
          </span>
        </div>
      </div>
      <div class="flex items-center gap-1.5 justify-end">
        <button class="px-2 py-0.5 text-[10px] rounded text-primary hover:bg-primary/10 border border-primary/20
                       hover:border-primary/40 transition-all cursor-pointer"
          onclick="App.switchPage('skills')">
          安装
        </button>
        ${!isBuiltin ? `
        <button class="p-1 rounded text-text-muted hover:text-danger hover:bg-danger/10 border border-border-default/20
                       hover:border-danger/30 transition-all cursor-pointer"
          title="从商店删除"
          onclick="event.stopPropagation();Nodes.deleteSkillFromStore('${nid}','${safeAttr(skill.id)}','${safeAttr(skillName)}')">
          <span class="[&_svg]:w-3 [&_svg]:h-3">${L('trash-2')}</span>
        </button>` : ''}
      </div>
    </div>`;
}

// ──────────────────────────────────────────────
// 形态三：商店 / 列表视图 — 插件市场行式布局
// ──────────────────────────────────────────────

export interface SkillListItemActions {
  /** 安装按钮点击回调表达式（直接拼入 onclick，需 safeAttr） */
  onInstall?: string;
  /** 删除按钮点击回调表达式（undefined=不显示删除按钮） */
  onDelete?: string;
  /** 自定义额外操作按钮 HTML */
  extraBtns?: string;
}

export interface SkillListItemMeta {
  /** 来源标签文字，如 'ClawHub' / 'OpenClaw' / '自定义' */
  sourceLabel?: string;
  /** 安装方式标签，如 '📝 Prompt 注入' */
  installLabel?: string;
  installBadgeClass?: string;
  /** 版本号，如 '1.0.0' */
  version?: string;
  /** 发布/更新时间（ISO 或格式化字符串） */
  publishedAt?: string;
  /** 分类标签文字 */
  categoryLabel?: string;
}

/**
 * 商店列表行式技能卡片（参考插件市场 UI）
 *
 * 布局：[图标 12×12] [名称+徽章+描述+版本/时间] [操作按钮]
 * 适用于：技能商店页面列表视图、ClawHub 结果列表等
 *
 * @param skill    技能数据
 * @param meta     显示元数据（标签、版本、时间等）
 * @param actions  按钮行为（onclick 表达式字符串）
 */
export function skillListItem(
  skill: any,
  meta: SkillListItemMeta = {},
  actions: SkillListItemActions = {}
): string {
  const name        = skill.name || skill.id || '未命名技能';
  const description = skill.description || '';
  const version     = meta.version || skill.version || '';
  const published   = meta.publishedAt || skill.publishedAt || '';
  const catLabel    = meta.categoryLabel || skill.category || '';
  const sourceLabel = meta.sourceLabel || skill.source || '';
  const isCustom    = skill.source === 'custom';

  // 时间格式化：如果是 ISO string 转为本地日期
  const publishedStr = published
    ? (() => { try { return new Date(published).toLocaleDateString('zh-CN'); } catch { return published; } })()
    : '';

  // 徽章列表
  const badges: string[] = [];
  if (sourceLabel)             badges.push(sourceBadge(skill.source || '', sourceLabel));
  if (isCustom)                badges.push(`<span class="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 uppercase tracking-wide">自定义</span>`);
  if (meta.installLabel)       badges.push(`<span class="text-[9px] px-1.5 py-0.5 rounded-full ${meta.installBadgeClass || 'bg-text-muted/10 text-text-muted'}">${escHtml(meta.installLabel)}</span>`);
  if (catLabel)                badges.push(`<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-elevated text-text-muted">${escHtml(catLabel)}</span>`);

  return `
    <div class="group flex items-center gap-4 px-4 py-3.5
                border-b border-border-subtle last:border-b-0
                hover:bg-elevated/60 transition-colors duration-150"
         data-skill-id="${escHtml(skill.id || '')}">

      <!-- 图标 -->
      <div class="shrink-0">
        ${iconBlock(skill, 'lg')}
      </div>

      <!-- 主体信息 -->
      <div class="flex-1 min-w-0">
        <!-- 第一行：名称 + 徽章 -->
        <div class="flex items-center gap-2 flex-wrap mb-0.5">
          <span class="text-sm font-semibold text-text-primary">${escHtml(name)}</span>
          ${badges.join('')}
        </div>

        <!-- 第二行：描述 -->
        ${description ? `
        <p class="text-xs text-text-muted leading-relaxed line-clamp-1 mb-1">
          ${escHtml(description)}
        </p>` : ''}

        <!-- 第三行：版本 + 时间 -->
        <div class="flex items-center gap-3 text-[10px] text-text-muted font-mono">
          ${version     ? `<span>版本：${escHtml(version)}</span>` : ''}
          ${publishedStr ? `<span>发布时间：${publishedStr}</span>` : ''}
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="shrink-0 flex items-center gap-2">
        ${actions.extraBtns || ''}
        ${actions.onDelete ? `
        <button class="p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10
                       border border-border-default/20 hover:border-danger/30 transition-all cursor-pointer
                       [&_svg]:w-3.5 [&_svg]:h-3.5 opacity-0 group-hover:opacity-100"
          title="删除" onclick="${actions.onDelete}">
          ${L('trash-2')}
        </button>` : ''}
        ${actions.onInstall ? `
        <button class="px-4 py-1.5 text-xs font-medium rounded-lg border border-border-default
                       text-text-primary hover:border-primary/40 hover:bg-primary/10 hover:text-primary
                       transition-all cursor-pointer whitespace-nowrap"
          onclick="${actions.onInstall}">
          安装
        </button>` : ''}
        ${actions.extraBtns || ''}
      </div>
    </div>`;
}

// ──────────────────────────────────────────────
// 布局容器辅助
// ──────────────────────────────────────────────

/** 技能列表容器（带分组标题，供 node-detail-panel 的技能区使用） */
export function skillSection(opts: {
  icon: string;
  iconColor: string;
  title: string;
  count: number;
  installedHtml: string;
  uninstalledHtml?: string;
  uninstalledCount?: number;
  emptyText?: string;
  gridCols?: string;
}): string {
  const grid = opts.gridCols || 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4';
  const installed = opts.count > 0
    ? `<div class="grid ${grid} gap-3 mb-3">${opts.installedHtml}</div>`
    : '';
  const uninstalled = opts.uninstalledCount && opts.uninstalledHtml ? `
    <details class="group">
      <summary class="cursor-pointer flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors py-1.5 select-none list-none">
        <span class="[&_svg]:w-3 [&_svg]:h-3 group-open:rotate-90 transition-transform">${L('chevron-right')}</span>
        未安装 (${opts.uninstalledCount})
      </summary>
      <div class="grid ${grid} gap-3 mt-2">${opts.uninstalledHtml}</div>
    </details>` : '';
  const empty = opts.count === 0 && !opts.uninstalledCount
    ? `<p class="text-xs text-text-muted py-2">${opts.emptyText || '暂无数据'}</p>`
    : '';

  return `
    <div class="mb-8">
      <div class="flex items-center gap-2 mb-3">
        <span class="[&_svg]:w-3.5 [&_svg]:h-3.5 ${opts.iconColor}">${L(opts.icon)}</span>
        <span class="text-xs font-bold ${opts.iconColor} uppercase tracking-widest">${opts.title}</span>
        <span class="text-xs text-text-muted">(${opts.count} 已安装)</span>
      </div>
      ${installed}${uninstalled}${empty}
    </div>`;
}

/** 商店列表视图容器（白底卡片包裹，供 skills.ts 列表模式使用） */
export function skillListContainer(itemsHtml: string, emptyText = '未找到匹配的技能'): string {
  if (!itemsHtml) {
    return `
      <div class="flex flex-col items-center justify-center py-16 text-text-muted">
        <span class="[&_svg]:w-12 [&_svg]:h-12 mb-3 opacity-30">${L('package-search')}</span>
        <p class="text-base font-medium">${emptyText}</p>
      </div>`;
  }
  return `
    <div class="bg-surface/60 border border-border-default/30 rounded-xl overflow-hidden divide-y divide-border-subtle/50">
      ${itemsHtml}
    </div>`;
}
