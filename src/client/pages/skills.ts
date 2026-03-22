// @alpha: skills 页面模块 (TS 迁移 — Alpha pass)
import { $, $$, L, refreshIcons, escHtml, showToast, formatBytes, formatUptime, pctColor, pctBg, safeAttr, cidrMatch, isValidCidr } from '../utils';
import { App } from '../core';
import { Modal } from '../modal';


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
    openclaw: 'ClawHub', 'skills.sh': 'skills.sh', npm: 'npm', console: 'Console', custom: '自定义',
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

  // --- 发布技能模态框 ---
  _showPublishModal(container: any) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300 opacity-0';

    overlay.innerHTML = `
      <div class="w-full max-w-lg bg-surface border border-border-default/30 rounded-xl overflow-hidden shadow-ambient transform scale-95 transition-transform duration-300">
        <div class="px-8 py-6 flex flex-col gap-1 bg-elevated/30 border-b border-border-default/20">
          <div class="flex justify-between items-start">
            <h2 class="text-xl font-bold text-text-primary tracking-tight" style="font-family: 'Space Grotesk', sans-serif">发布技能</h2>
            <button class="modal-close text-text-muted hover:text-primary transition-colors cursor-pointer border-none bg-transparent">
              <i data-lucide="x" class="w-5 h-5"></i>
            </button>
          </div>
          <p class="text-text-secondary text-sm">上传 SKILL.md 或 zip 文件，发布到技能商店</p>
        </div>
        <div class="px-8 py-6 space-y-4">
          <!-- 文件拖拽区 -->
          <div id="skill-dropzone" class="border-2 border-dashed border-border-default rounded-lg p-6 text-center hover:border-primary/50 transition-colors cursor-pointer">
            <i data-lucide="upload-cloud" class="w-10 h-10 mx-auto mb-2 text-text-muted opacity-50"></i>
            <p class="text-sm font-medium text-text-secondary">拖拽 SKILL.md 或 .zip 文件到此处</p>
            <p class="text-xs text-text-muted mt-1">或点击选择文件</p>
            <input id="skill-file-input" type="file" accept=".md,.zip" class="hidden" />
          </div>
          <div id="skill-file-name" class="text-sm text-primary font-medium hidden"></div>

          <!-- 表单 -->
          <div class="space-y-3">
            <div>
              <label class="block text-xs font-medium text-text-secondary mb-1">技能名称 <span class="text-danger">*</span></label>
              <input id="pub-name" type="text" placeholder="例如：My Custom Skill"
                class="w-full px-3 py-2 text-sm border border-border-default rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition" />
            </div>
            <div>
              <label class="block text-xs font-medium text-text-secondary mb-1">描述</label>
              <textarea id="pub-desc" rows="2" placeholder="技能功能描述…"
                class="w-full px-3 py-2 text-sm border border-border-default rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition resize-none"></textarea>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1">分类</label>
                <select id="pub-category" class="w-full px-3 py-2 text-sm border border-border-default rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 transition">
                  <option value="ai">AI 助手</option>
                  <option value="integration">集成</option>
                  <option value="frontend">前端</option>
                  <option value="devops">DevOps</option>
                  <option value="content">内容</option>
                  <option value="monitor">监控</option>
                  <option value="security">安全</option>
                  <option value="network">网络</option>
                  <option value="ops">运维</option>
                </select>
              </div>
              <div>
                <label class="block text-xs font-medium text-text-secondary mb-1">安装方式</label>
                <select id="pub-install-type" class="w-full px-3 py-2 text-sm border border-border-default rounded-lg bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 transition">
                  <option value="prompt">📝 Prompt 注入</option>
                  <option value="npm">📦 npm install</option>
                  <option value="script">🔧 远程脚本</option>
                  <option value="archive">📁 压缩包</option>
                </select>
              </div>
            </div>
          </div>
        </div>
        <div class="px-8 py-4 bg-elevated/30 border-t border-border-default/20 flex items-center justify-end gap-3">
          <button class="modal-close px-5 py-2.5 rounded-full text-text-secondary font-semibold hover:bg-elevated border-none bg-transparent transition-all duration-200 cursor-pointer text-sm">取消</button>
          <button id="btn-submit-skill" class="px-6 py-2.5 rounded-full signature-gradient text-white font-bold shadow-lg shadow-primary/20 hover:shadow-primary/40 border-none active:scale-95 transition-all duration-200 flex items-center gap-2 cursor-pointer text-sm">
            <i data-lucide="check" class="w-4 h-4"></i> 发布
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    refreshIcons();

    // Animate In
    requestAnimationFrame(() => {
      overlay.classList.remove('opacity-0');
      const modalBody = overlay.querySelector('div');
      if (modalBody) {
        modalBody.classList.remove('scale-95');
        modalBody.classList.add('scale-100');
      }
    });

    const closeHandler = () => {
      overlay.classList.add('opacity-0');
      const modalBody = overlay.querySelector('div');
      if (modalBody) modalBody.classList.add('scale-95');
      setTimeout(() => overlay.remove(), 300);
    };

    overlay.querySelectorAll('.modal-close').forEach((btn: any) => btn.addEventListener('click', closeHandler));
    overlay.addEventListener('mousedown', (e: any) => {
      if (e.target === overlay) closeHandler();
    });

    let fileContent = '';
    const fileInput = overlay.querySelector('#skill-file-input') as HTMLInputElement;
    const dropzone = overlay.querySelector('#skill-dropzone') as HTMLDivElement;
    const fileNameEl = overlay.querySelector('#skill-file-name') as HTMLDivElement;

    const handleFile = (file: File) => {
      fileNameEl.textContent = `📎 ${file.name}`;
      fileNameEl.classList.remove('hidden');

      if (file.name.endsWith('.md')) {
        const reader = new FileReader();
        reader.onload = (e) => {
          fileContent = e.target?.result as string;
          // 尝试解析 YAML frontmatter 填充表单
          const meta = this._parseFrontmatter(fileContent);
          if (meta.name) (overlay.querySelector('#pub-name') as HTMLInputElement).value = meta.name;
          if (meta.description) (overlay.querySelector('#pub-desc') as HTMLTextAreaElement).value = meta.description;
        };
        reader.readAsText(file);
      } else if (file.name.endsWith('.zip')) {
        fileContent = '[zip file]';
        // zip 文件暂时标记为 archive installType
        (overlay.querySelector('#pub-install-type') as HTMLSelectElement).value = 'archive';
      }
    };

    // 点击选择
    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
    });

    // 拖拽
    dropzone.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      dropzone.classList.add('border-primary', 'bg-primary/5');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('border-primary', 'bg-primary/5');
    });
    dropzone.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      dropzone.classList.remove('border-primary', 'bg-primary/5');
      const file = e.dataTransfer?.files[0];
      if (file) handleFile(file);
    });

    // 提交
    overlay.querySelector('#btn-submit-skill')?.addEventListener('click', async () => {
      const name = (overlay.querySelector('#pub-name') as HTMLInputElement).value.trim();
      if (!name) {
        showToast('请输入技能名称', 'info');
        return;
      }

      const submitBtn = overlay.querySelector('#btn-submit-skill') as HTMLButtonElement;
      submitBtn.setAttribute('disabled', 'true');
      submitBtn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> 发布中...';
      refreshIcons();

      try {
        const res = await App.authFetch('/api/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            description: (overlay.querySelector('#pub-desc') as HTMLTextAreaElement).value.trim(),
            category: (overlay.querySelector('#pub-category') as HTMLSelectElement).value,
            installType: (overlay.querySelector('#pub-install-type') as HTMLSelectElement).value,
            skillContent: fileContent,
            source: 'custom',
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Server responded with ${res.status}`);
        }

        const data = await res.json();
        showToast(`技能 "${name}" 发布成功`, 'success');
        closeHandler();

        // 重新加载技能列表
        await this._fetchSkills(container);
      } catch (err: any) {
        showToast(err.message || '发布失败', 'error');
        submitBtn.removeAttribute('disabled');
        submitBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i> 发布';
        refreshIcons();
      }
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

      // 从本地列表移除
      this._skills = this._skills.filter(s => s.id !== skillId);
      showToast(`技能「${skillName}」已删除`, 'success');

      // 重新渲染
      const container = document.querySelector('#main-content') || document.body;
      this._filterAndRender(container);
    } catch (err: any) {
      showToast(err.message || '删除失败', 'error');
    }
  },

  // --- 安装技能（交互流与 UI） ---
  async _installSkill(skillId: string) {
    const skill = this._skills.find(s => s.id === skillId);
    if (!skill) return;

    try {
      // 1. 抓取可用节点列表
      const res = await App.authFetch('/api/nodes');
      const data = await res.json();
      const allNodes = Array.isArray(data.nodes) ? data.nodes : (Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []));
      const nodes = allNodes.filter((n: any) => n.online);

      // 2. 构建节点选择模态框
      const overlay = document.createElement('div');
      overlay.className = 'fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300 opacity-0';
      
      const nodeHtml = nodes.length > 0 ? nodes.map((node: any) => {
        const isOnline = !!node.online;
        const statusColor = isOnline ? 'bg-primary shadow-[0_0_8px_#b2a1ff]' : 'bg-danger shadow-[0_0_8px_#ff6e84]';
        const statusText = isOnline ? 'Online' : 'Offline';
        const textColor = isOnline ? 'text-primary' : 'text-danger';
        
        return `
          <label class="group relative flex items-center justify-between p-4 rounded-lg bg-surface hover:bg-elevated cursor-pointer transition-all duration-200 border-l-2 border-transparent active:scale-[0.98] mb-2 last:mb-0">
            <input class="peer hidden" name="node-select" type="radio" value="${escHtml(node.id || node.name)}"/>
            <div class="flex items-center gap-4">
              <div class="w-10 h-10 rounded-lg bg-elevated flex items-center justify-center text-text-secondary group-hover:scale-110 transition-transform">
                <i data-lucide="dns" class="w-5 h-5"></i>
              </div>
              <div>
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold text-text-primary">${escHtml(node.name || 'Unknown')}</span>
                  <span class="flex h-2 w-2 rounded-full ${statusColor}"></span>
                  <span class="text-[10px] uppercase tracking-widest ${textColor} font-bold">${statusText}</span>
                </div>
                <span class="text-xs font-mono text-text-muted">${escHtml(node.ip || node.id || 'N/A')}</span>
              </div>
            </div>
            <div class="peer-checked:flex hidden h-6 w-6 items-center justify-center rounded-full bg-primary text-text-inverse">
              <i data-lucide="check" class="w-3.5 h-3.5 font-bold"></i>
            </div>
            <div class="peer-checked:border-primary peer-checked:bg-primary/5 absolute inset-0 rounded-lg pointer-events-none transition-all"></div>
          </label>
        `;
      }).join('') : `
        <div class="py-8 text-center text-text-muted">
          <i data-lucide="server-off" class="w-10 h-10 mx-auto mb-3 opacity-40"></i>
          <p class="text-sm font-medium">当前没有可用的节点</p>
        </div>
      `;

      // 安装方式提示
      const installInfo = this._installTypeLabels[skill.installType] || skill.installType;

      overlay.innerHTML = `
        <div class="w-full max-w-lg bg-surface border border-border-default/30 rounded-xl overflow-hidden shadow-ambient transform scale-95 transition-transform duration-300">
          <div class="px-8 py-6 flex flex-col gap-1 bg-elevated/30 border-b border-border-default/20">
            <div class="flex justify-between items-start">
              <h2 class="text-xl font-bold text-text-primary tracking-tight" style="font-family: 'Space Grotesk', sans-serif">Install Skill to Node</h2>
              <button class="modal-close text-text-muted hover:text-primary transition-colors cursor-pointer border-none bg-transparent">
                <i data-lucide="x" class="w-5 h-5"></i>
              </button>
            </div>
            <p class="text-text-secondary text-sm">选择目标节点来部署 <span class="text-primary font-medium">${escHtml(skill.name)}</span></p>
            <p class="text-xs text-text-muted mt-1">安装方式: ${installInfo}</p>
          </div>
          <div class="px-8 py-6 max-h-[400px] overflow-y-auto">
            ${nodeHtml}
          </div>
          <div class="px-8 py-4 bg-elevated/30 border-t border-border-default/20 flex items-center justify-end gap-3">
            <button class="modal-close px-5 py-2.5 rounded-full text-text-secondary font-semibold hover:bg-elevated border-none bg-transparent transition-all duration-200 cursor-pointer text-sm">取消</button>
            <button class="modal-install px-6 py-2.5 rounded-full signature-gradient text-white font-bold shadow-lg shadow-primary/20 hover:shadow-primary/40 border-none active:scale-95 transition-all duration-200 flex items-center gap-2 cursor-pointer text-sm disabled:opacity-50">
              <i data-lucide="zap" class="w-4 h-4"></i> 部署并安装
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);
      refreshIcons();

      // Animate In
      requestAnimationFrame(() => {
        overlay.classList.remove('opacity-0');
        const modalBody = overlay.querySelector('div');
        if (modalBody) {
          modalBody.classList.remove('scale-95');
          modalBody.classList.add('scale-100');
        }
      });

      const closeHandler = () => {
        overlay.classList.add('opacity-0');
        const modalBody = overlay.querySelector('div');
        if (modalBody) modalBody.classList.add('scale-95');
        setTimeout(() => overlay.remove(), 300);
      };

      overlay.querySelectorAll('.modal-close').forEach((btn: any) => btn.addEventListener('click', closeHandler));
      overlay.addEventListener('mousedown', (e: any) => {
        if (e.target === overlay) closeHandler();
      });

      // Submit handler
      const installBtn = overlay.querySelector('.modal-install');
      if (installBtn) {
        installBtn.addEventListener('click', async () => {
          const selected = overlay.querySelector('input[name="node-select"]:checked') as HTMLInputElement;
          if (!selected) {
            showToast('请先选择一个目标节点', 'info');
            return;
          }
          const targetNodeId = selected.value;
          
          installBtn.setAttribute('disabled', 'true');
          installBtn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> 部署中...';
          refreshIcons();
          
          try {
            const res = await App.authFetch(`/api/nodes/${targetNodeId}/skills`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                skillId: skill.id,
                source: skill.source,
                installType: skill.installType,
                version: skill.version,
                name: skill.name
              })
            });
            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData.error || `Server responded with ${res.status}`);
            }
            // 乐观更新 allNodesRaw — 确保技能面板立即可见
            const targetNode = App.allNodesRaw.find((n: any) => n.id === targetNodeId);
            if (targetNode) {
              if (!targetNode.skills) targetNode.skills = [];
              if (!targetNode.skills.find((s: any) => s.id === skill.id)) {
                targetNode.skills.push({
                  id: skill.id,
                  name: skill.name,
                  version: skill.version,
                  icon: skill.icon,
                  installedAt: new Date().toISOString(),
                });
              }
            }
            showToast(`技能 ${skill.name} 已成功安装到节点`, 'success');
            closeHandler();
          } catch (err: any) {
            console.error('Install failed:', err);
            showToast(err.message || '部署请求失败', 'error');
            installBtn.removeAttribute('disabled');
            installBtn.innerHTML = '<i data-lucide="zap" class="w-4 h-4"></i> 部署并安装';
            refreshIcons();
          }
        });
      }

    } catch (e) {
      console.error(e);
      showToast('无法调取节点信息', 'error');
    }
  },
};
