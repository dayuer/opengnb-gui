// @alpha: skills 页面模块 (TS 迁移 — Alpha pass)
// V3: 模态框逻辑已提取到 skill-modals.ts
import { $, $$, L, refreshIcons, escHtml, showToast, formatBytes, formatUptime, pctColor, pctBg, safeAttr, cidrMatch, isValidCidr } from '../utils';
import { App } from '../core';
import { Modal } from '../modal';
import { SkillModals } from '../components/skill-modals';


// @alpha: 技能商店页面 — ClawHub 镜像 + 用户上传 + 明确安装方式
// 数据来源: /api/skills（SQLite 持久化，内置技能 + 用户上传）

export const Skills = {
  // --- 状态 ---
  _skills: [] as any[],
  _activeCategory: 'all',
  _searchKeyword: '',
  _loading: false,

  // --- 分类定义 ---
  _categories: [
    { id: 'all',         name: '全部',     icon: 'grid-3x3' },
    { id: 'ai',          name: 'AI 助手',  icon: 'sparkles' },
    { id: 'integration', name: '集成',     icon: 'plug' },
    { id: 'frontend',    name: '前端',     icon: 'layout' },
    { id: 'devops',      name: 'DevOps',   icon: 'git-branch' },
    { id: 'content',     name: '内容',     icon: 'pen-tool' },
    { id: 'monitor',     name: '监控',     icon: 'activity' },
    { id: 'security',    name: '安全',     icon: 'shield' },
    { id: 'network',     name: '网络',     icon: 'wifi' },
    { id: 'ops',         name: '运维',     icon: 'wrench' },
  ],

  _categoryLabels: {
    ai: 'AI 助手', integration: '集成', frontend: '前端', devops: 'DevOps',
    content: '内容', monitor: '监控', security: '安全', network: '网络', ops: '运维',
  } as Record<string, string>,

  // 来源标签
  _sourceLabels: {
    clawhub: 'ClawHub', 'openclaw-bundled': 'OpenClaw', openclaw: 'OpenClaw', github: 'GitHub',
    'skills.sh': 'skills.sh', npm: 'npm', console: 'Console', custom: '自定义',
  } as Record<string, string>,

  // 安装方式标签
  _installTypeLabels: {
    prompt: '📝 Prompt 注入',
    npm:    '📦 npm install',
    script: '🔧 远程脚本',
    archive:'📁 压缩包',
  } as Record<string, string>,

  _installTypeBadgeClass: {
    prompt:  'bg-indigo-50 text-indigo-700',
    npm:     'bg-red-50 text-red-700',
    script:  'bg-amber-50 text-amber-700',
    archive: 'bg-teal-50 text-teal-700',
  } as Record<string, string>,

  // --- 渲染入口 ---
  async render(container: any) {
    this._activeCategory = 'all';
    this._searchKeyword = '';
    this._loading = true;

    container.innerHTML = this._renderShell();
    this._bindEvents(container);
    refreshIcons();

    // 从 API 加载技能
    await this._fetchSkills(container);
  },

  _renderShell() {
    return `
      <!-- 页面头部 -->
      <div class="px-6 pt-6 pb-4">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 class="text-xl font-bold text-text-primary font-headline">技能商店</h2>
            <p class="text-sm text-text-muted mt-1">发现和安装 AI 技能，扩展节点管理能力</p>
          </div>
          <div class="flex items-center gap-3">
            <div class="relative">
              <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none"></i>
              <input id="skill-search" type="text" placeholder="搜索技能…"
                class="pl-9 pr-4 py-2 w-56 text-sm border border-border-default rounded-lg bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition" />
            </div>
            <button id="btn-publish-skill" class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-text-inverse bg-primary hover:bg-primary-dark rounded-lg transition cursor-pointer shadow-sm">
              <i data-lucide="upload" class="w-4 h-4"></i>
              <span>发布技能</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 分类筛选 -->
      <div class="px-6 pb-4">
        <div id="skill-categories" class="flex flex-wrap gap-2">
          ${this._categories.map(c => `
            <button class="skill-cat-btn inline-flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium rounded-full transition cursor-pointer
              ${c.id === 'all' ? 'bg-primary text-text-inverse shadow-sm' : 'bg-elevated text-text-secondary hover:bg-surface-container hover:text-text-primary'}"
              data-category="${c.id}">
              <i data-lucide="${c.icon}" class="w-3.5 h-3.5"></i>
              <span>${c.name}</span>
            </button>
          `).join('')}
        </div>
      </div>

      <!-- 统计栏 -->
      <div class="px-6 pb-4">
        <div id="skill-stats" class="flex items-center gap-4 text-sm text-text-muted">
          <span id="skill-count">加载中…</span>
        </div>
      </div>

      <!-- 技能卡片网格 -->
      <div id="skill-grid" class="px-6 pb-8">
        <div class="flex items-center justify-center py-20 text-text-muted">
          <i data-lucide="loader-2" class="w-6 h-6 animate-spin mr-2"></i>
          <span>加载技能列表…</span>
        </div>
      </div>
    `;
  },

  // --- 从 API 加载技能 ---
  async _fetchSkills(container: any) {
    try {
      const res = await App.authFetch('/api/skills');
      const data = await res.json();
      this._skills = data.skills || [];
      this._loading = false;
      this._filterAndRender(container);
    } catch (err: any) {
      console.error('[Skills] 加载失败:', err);
      this._loading = false;
      const grid = container.querySelector('#skill-grid');
      if (grid) {
        grid.innerHTML = `
          <div class="flex flex-col items-center justify-center py-20 text-text-muted">
            <i data-lucide="alert-circle" class="w-12 h-12 mb-3 opacity-40"></i>
            <p class="text-base font-medium">加载技能失败</p>
            <p class="text-sm mt-1">${escHtml(err.message)}</p>
          </div>`;
        refreshIcons();
      }
    }
  },

  // --- 渲染卡片网格 ---
  _renderGrid(skills: any[]) {
    if (skills.length === 0) {
      return `
        <div class="flex flex-col items-center justify-center py-20 text-text-muted">
          <i data-lucide="package-search" class="w-12 h-12 mb-3 opacity-40"></i>
          <p class="text-base font-medium">未找到匹配的技能</p>
          <p class="text-sm mt-1">尝试更换分类或搜索关键词</p>
        </div>`;
    }

    return `<div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      ${skills.map((s, i) => this._renderCard(s, i)).join('')}
    </div>`;
  },

  // --- 渲染单个卡片 ---
  _renderCard(skill: any, index: number) {
    const catLabel = this._categoryLabels[skill.category] || skill.category;
    const sourceLabel = this._sourceLabels[skill.source] || skill.source;
    const installLabel = this._installTypeLabels[skill.installType] || skill.installType;
    const installBadge = this._installTypeBadgeClass[skill.installType] || 'bg-elevated text-text-muted';
    const installText = skill.installs >= 1000
      ? `${(skill.installs / 1000).toFixed(1)}k`
      : `${skill.installs || 0}`;
    const delay = Math.min(index * 40, 400);
    const isCustom = !skill.isBuiltin;

    // 来源徽章颜色
    const sourceBadgeClass: Record<string, string> = {
      openclaw: 'bg-blue-50 text-blue-700',
      'skills.sh': 'bg-violet-50 text-violet-700',
      npm: 'bg-red-50 text-red-700',
      console: 'bg-emerald-50 text-emerald-700',
      custom: 'bg-orange-50 text-orange-700',
    };

    return `
      <div class="group bg-surface border border-border-default rounded-xl p-5 hover:shadow-ambient hover:border-primary/20 transition-[box-shadow,border-color] duration-200 cursor-pointer animate-fade-in-up"
           style="animation-delay: ${delay}ms" data-skill-id="${skill.id}">
        <!-- 头部: 图标 + 名称 + 版本 + 来源 -->
        <div class="flex items-start gap-3.5 mb-3">
          <div class="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 shadow-sm"
               style="background: ${skill.iconGradient}">
            <i data-lucide="${skill.icon}" class="w-5.5 h-5.5 text-white"></i>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="font-semibold text-text-primary text-sm truncate">${escHtml(skill.name)}</h3>
              <span class="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-medium rounded bg-elevated text-text-muted">${escHtml(skill.version)}</span>
              <span class="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded ${sourceBadgeClass[skill.source] || 'bg-elevated text-text-muted'}">${sourceLabel}</span>
              ${isCustom ? '<span class="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-orange-50 text-orange-700">自定义</span>' : ''}
            </div>
            <p class="text-xs text-text-muted mt-0.5">by ${escHtml(skill.author)}</p>
          </div>
        </div>

        <!-- 描述 -->
        <p class="text-sm text-text-secondary leading-relaxed mb-3 line-clamp-2">${escHtml(skill.description)}</p>

        <!-- 安装方式标识 -->
        <div class="mb-3">
          <span class="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded-full ${installBadge}">
            ${installLabel}
          </span>
        </div>

        <!-- 底部: 标签 + 评分 + 安装数 + 按钮 -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5 text-xs text-text-muted">
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-elevated font-medium">
              ${catLabel}
            </span>
            ${skill.rating ? `<span class="inline-flex items-center gap-0.5">
              <i data-lucide="star" class="w-3 h-3 text-amber-500 fill-amber-400"></i>
              ${skill.rating}
            </span>` : ''}
            <span class="inline-flex items-center gap-0.5">
              <i data-lucide="download" class="w-3 h-3"></i>
              ${installText}
            </span>
          </div>
          <div class="flex items-center gap-1.5">
            ${isCustom ? `<button class="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg text-danger bg-danger/5 hover:bg-danger/10 transition cursor-pointer border-none"
                onclick="event.stopPropagation(); Skills._deleteSkill('${skill.id}', '${escHtml(skill.name)}')"
                title="删除">
                <i data-lucide="trash-2" class="w-3 h-3"></i>
              </button>` : ''}
            <button class="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-lg bg-primary text-text-inverse hover:bg-primary-dark transition cursor-pointer shadow-sm border-none"
              onclick="event.stopPropagation(); Skills._installSkill('${skill.id}')">
              <i data-lucide="download" class="w-3 h-3"></i>安装</button>
          </div>
        </div>
      </div>`;
  },

  // --- 事件绑定 ---
  _bindEvents(container: any) {
    // 分类筛选
    container.querySelector('#skill-categories')?.addEventListener('click', (e: any) => {
      const btn = e.target.closest('.skill-cat-btn');
      if (!btn) return;
      this._activeCategory = btn.dataset.category;
      this._updateCategoryButtons(container);
      this._filterAndRender(container);
    });

    // 搜索
    const searchInput = container.querySelector('#skill-search');
    if (searchInput) {
      let timer: any = null;
      searchInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this._searchKeyword = searchInput.value.trim().toLowerCase();
          this._filterAndRender(container);
        }, 200);
      });
    }

    // 发布技能按钮
    container.querySelector('#btn-publish-skill')?.addEventListener('click', () => {
      this._showPublishModal(container);
    });
  },

  // --- 分类按钮样式更新 ---
  _updateCategoryButtons(container: any) {
    container.querySelectorAll('.skill-cat-btn').forEach((btn: any) => {
      const isActive = btn.dataset.category === this._activeCategory;
      btn.className = `skill-cat-btn inline-flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium rounded-full transition cursor-pointer ${
        isActive
          ? 'bg-primary text-text-inverse shadow-sm'
          : 'bg-elevated text-text-secondary hover:bg-surface-container hover:text-text-primary'
      }`;
    });
  },

  // --- 过滤 + 重新渲染 ---
  _filterAndRender(container: any) {
    let filtered = this._skills;

    // 分类过滤
    if (this._activeCategory !== 'all') {
      filtered = filtered.filter(s => s.category === this._activeCategory);
    }

    // 搜索过滤
    if (this._searchKeyword) {
      const kw = this._searchKeyword;
      filtered = filtered.filter(s =>
        s.name.toLowerCase().includes(kw) ||
        (s.description || '').toLowerCase().includes(kw) ||
        (this._categoryLabels[s.category] || '').includes(kw) ||
        (s.author || '').toLowerCase().includes(kw) ||
        (this._sourceLabels[s.source] || '').toLowerCase().includes(kw)
      );
    }

    // 更新网格
    const grid = container.querySelector('#skill-grid');
    if (grid) {
      grid.innerHTML = this._renderGrid(filtered);
      refreshIcons();
    }

    // 更新统计栏
    const statsEl = container.querySelector('#skill-stats');
    if (statsEl) {
      const builtinCount = this._skills.filter(s => s.isBuiltin).length;
      const customCount = this._skills.length - builtinCount;
      statsEl.innerHTML = `
        <span id="skill-count">${filtered.length} 个技能</span>
        <span class="text-border-default">·</span>
        <span>${builtinCount} 内置</span>
        ${customCount > 0 ? `<span class="text-border-default">·</span><span>${customCount} 自定义</span>` : ''}
        <span class="text-border-default">·</span>
        <span class="inline-flex items-center gap-1">
          <i data-lucide="database" class="w-3 h-3"></i>
          ${new Set(this._skills.map(s => s.source)).size} 个来源
        </span>
      `;
      refreshIcons();
    }
  },

  // --- 发布技能模态框（委托 SkillModals）---
  _showPublishModal(container: any) {
    SkillModals.showPublishModal(container, {
      fetchSkills: (c: any) => this._fetchSkills(c),
      parseFrontmatter: (content: string) => this._parseFrontmatter(content),
    });
  },

  // --- 解析 YAML frontmatter ---
  _parseFrontmatter(content: string): any {
    const meta: any = {};
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return meta;

    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.substring(0, idx).trim();
      const value = line.substring(idx + 1).trim();
      if (key && value) meta[key] = value;
    }
    return meta;
  },

  // --- 删除用户上传的技能 ---
  async _deleteSkill(skillId: string, skillName: string) {
    if (!confirm(`确定要删除技能「${skillName}」吗？`)) return;

    try {
      const res = await App.authFetch(`/api/skills/${skillId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `删除失败 (${res.status})`);
      }

      this._skills = this._skills.filter(s => s.id !== skillId);
      showToast(`技能「${skillName}」已删除`, 'success');

      const container = document.querySelector('#main-content') || document.body;
      this._filterAndRender(container);
    } catch (err: any) {
      showToast(err.message || '删除失败', 'error');
    }
  },

  // --- 安装技能（委托 SkillModals）---
  async _installSkill(skillId: string) {
    const skill = this._skills.find(s => s.id === skillId);
    if (!skill) return;
    await SkillModals.showInstallModal(skill, this._installTypeLabels);
  },
};
