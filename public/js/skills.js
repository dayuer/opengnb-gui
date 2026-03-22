'use strict';
// @alpha: 技能商店页面 — 技能发现、分类浏览、安装状态展示

const Skills = {
  // --- 技能数据（v1 静态，后续迁移到 API） ---
  _skills: [
    {
      id: 'claude-code',
      name: 'Claude Code',
      version: 'v2.4',
      author: 'SynonClaw',
      description: 'AI 智能运维终端 — 自然语言驱动服务器管理',
      category: 'ai',
      icon: 'brain',
      iconGradient: 'linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%)',
      rating: 4.9,
      installs: 2400,
      installed: true,
    },
    {
      id: 'node-guardian',
      name: 'Node Guardian',
      version: 'v1.0',
      author: 'SynonClaw',
      description: '节点健康守护 — 自动故障检测与告警通知',
      category: 'monitor',
      icon: 'heart-pulse',
      iconGradient: 'linear-gradient(135deg, #059669 0%, #34d399 100%)',
      rating: 4.8,
      installs: 1200,
      installed: true,
    },
    {
      id: 'firewall-manager',
      name: 'Firewall Manager',
      version: 'v1.1',
      author: 'SynonClaw',
      description: '智能防火墙规则管理 — 自动安全策略推荐',
      category: 'security',
      icon: 'shield-check',
      iconGradient: 'linear-gradient(135deg, #dc2626 0%, #f87171 100%)',
      rating: 4.6,
      installs: 890,
      installed: false,
    },
    {
      id: 'gnb-optimizer',
      name: 'GNB Optimizer',
      version: 'v0.9',
      author: 'SynonClaw',
      description: 'GNB 隧道性能优化 — 智能路由与带宽调度',
      category: 'network',
      icon: 'route',
      iconGradient: 'linear-gradient(135deg, #2563eb 0%, #60a5fa 100%)',
      rating: 4.3,
      installs: 650,
      installed: false,
    },
    {
      id: 'log-analyzer',
      name: 'Log Analyzer',
      version: 'v1.3',
      author: 'SynonClaw',
      description: '日志智能分析 — 异常模式检测与根因定位',
      category: 'ops',
      icon: 'file-search',
      iconGradient: 'linear-gradient(135deg, #d97706 0%, #fbbf24 100%)',
      rating: 4.7,
      installs: 1050,
      installed: false,
    },
    {
      id: 'backup-agent',
      name: 'Backup Agent',
      version: 'v2.0',
      author: 'SynonClaw',
      description: '自动备份与恢复 — 增量快照 + 异地容灾',
      category: 'ops',
      icon: 'database-backup',
      iconGradient: 'linear-gradient(135deg, #0891b2 0%, #22d3ee 100%)',
      rating: 4.5,
      installs: 780,
      installed: true,
    },
    {
      id: 'ssh-guard',
      name: 'SSH Guard',
      version: 'v1.2',
      author: 'SynonClaw',
      description: 'SSH 暴力破解防护 — 智能封锁 + 白名单管理',
      category: 'security',
      icon: 'key-round',
      iconGradient: 'linear-gradient(135deg, #be185d 0%, #f472b6 100%)',
      rating: 4.4,
      installs: 920,
      installed: false,
    },
    {
      id: 'dns-manager',
      name: 'DNS Manager',
      version: 'v1.0',
      author: 'Community',
      description: 'DNS 解析管理 — 批量域名配置与健康检查',
      category: 'network',
      icon: 'globe',
      iconGradient: 'linear-gradient(135deg, #4338ca 0%, #818cf8 100%)',
      rating: 4.1,
      installs: 340,
      installed: false,
    },
    {
      id: 'cron-master',
      name: 'Cron Master',
      version: 'v1.5',
      author: 'Community',
      description: '定时任务管理 — 可视化调度 + 执行历史追溯',
      category: 'ops',
      icon: 'timer',
      iconGradient: 'linear-gradient(135deg, #7c2d12 0%, #fb923c 100%)',
      rating: 4.6,
      installs: 560,
      installed: false,
    },
  ],

  // --- 分类定义 ---
  _categories: [
    { id: 'all',      name: '全部',    icon: 'grid-3x3' },
    { id: 'monitor',  name: '监控',    icon: 'activity' },
    { id: 'security', name: '安全',    icon: 'shield' },
    { id: 'network',  name: '网络',    icon: 'wifi' },
    { id: 'ops',      name: '运维',    icon: 'wrench' },
    { id: 'ai',       name: 'AI 助手', icon: 'sparkles' },
  ],

  _categoryLabels: {
    ai: 'AI 助手', monitor: '监控', security: '安全', network: '网络', ops: '运维',
  },

  // --- 状态 ---
  _activeCategory: 'all',
  _searchKeyword: '',

  // --- 渲染入口 ---
  render(container) {
    this._activeCategory = 'all';
    this._searchKeyword = '';

    container.innerHTML = `
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
              <input id="skill-search" type="text" placeholder="搜索技能..."
                class="pl-9 pr-4 py-2 w-56 text-sm border border-border-default rounded-lg bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition" />
            </div>
            <button class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-text-inverse bg-primary hover:bg-primary-dark rounded-lg transition cursor-pointer shadow-sm">
              <i data-lucide="plus" class="w-4 h-4"></i>
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
        <div class="flex items-center gap-4 text-sm text-text-muted">
          <span id="skill-count">${this._skills.length} 个技能</span>
          <span class="text-border-default">·</span>
          <span>${this._skills.filter(s => s.installed).length} 已安装</span>
        </div>
      </div>

      <!-- 技能卡片网格 -->
      <div id="skill-grid" class="px-6 pb-8">
        ${this._renderGrid(this._skills)}
      </div>
    `;

    // 绑定事件
    this._bindEvents(container);
    refreshIcons();
  },

  // --- 渲染卡片网格 ---
  _renderGrid(skills) {
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
  _renderCard(skill, index) {
    const catLabel = this._categoryLabels[skill.category] || skill.category;
    const installText = skill.installs >= 1000
      ? `${(skill.installs / 1000).toFixed(1)}k`
      : `${skill.installs}`;
    const delay = Math.min(index * 50, 300);

    return `
      <div class="group bg-surface border border-border-default rounded-xl p-5 hover:shadow-ambient hover:border-primary/20 transition-all duration-200 cursor-pointer animate-fade-in-up"
           style="animation-delay: ${delay}ms" data-skill-id="${skill.id}">
        <!-- 头部: 图标 + 名称 + 版本 -->
        <div class="flex items-start gap-3.5 mb-3">
          <div class="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 shadow-sm"
               style="background: ${skill.iconGradient}">
            <i data-lucide="${skill.icon}" class="w-5.5 h-5.5 text-white"></i>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <h3 class="font-semibold text-text-primary text-sm truncate">${escHtml(skill.name)}</h3>
              <span class="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-medium rounded bg-elevated text-text-muted">${escHtml(skill.version)}</span>
            </div>
            <p class="text-xs text-text-muted mt-0.5">by ${escHtml(skill.author)}</p>
          </div>
        </div>

        <!-- 描述 -->
        <p class="text-sm text-text-secondary leading-relaxed mb-4">${escHtml(skill.description)}</p>

        <!-- 底部: 标签 + 评分 + 安装数 + 按钮 -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5 text-xs text-text-muted">
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-elevated font-medium">
              ${catLabel}
            </span>
            <span class="inline-flex items-center gap-0.5">
              <i data-lucide="star" class="w-3 h-3 text-amber-500 fill-amber-400"></i>
              ${skill.rating}
            </span>
            <span class="inline-flex items-center gap-0.5">
              <i data-lucide="download" class="w-3 h-3"></i>
              ${installText}
            </span>
          </div>
          ${skill.installed
            ? `<span class="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg bg-success/10 text-success">
                <i data-lucide="check-circle-2" class="w-3 h-3"></i>已安装</span>`
            : `<button class="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-lg bg-primary text-text-inverse hover:bg-primary-dark transition cursor-pointer shadow-sm"
                onclick="event.stopPropagation(); Skills._installSkill('${skill.id}')">
                <i data-lucide="download" class="w-3 h-3"></i>安装</button>`
          }
        </div>
      </div>`;
  },

  // --- 事件绑定 ---
  _bindEvents(container) {
    // 分类筛选
    container.querySelector('#skill-categories')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.skill-cat-btn');
      if (!btn) return;
      this._activeCategory = btn.dataset.category;
      this._updateCategoryButtons(container);
      this._filterAndRender(container);
    });

    // 搜索
    const searchInput = container.querySelector('#skill-search');
    if (searchInput) {
      let timer = null;
      searchInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          this._searchKeyword = searchInput.value.trim().toLowerCase();
          this._filterAndRender(container);
        }, 200);
      });
    }
  },

  // --- 分类按钮样式更新 ---
  _updateCategoryButtons(container) {
    container.querySelectorAll('.skill-cat-btn').forEach(btn => {
      const isActive = btn.dataset.category === this._activeCategory;
      btn.className = `skill-cat-btn inline-flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium rounded-full transition cursor-pointer ${
        isActive
          ? 'bg-primary text-text-inverse shadow-sm'
          : 'bg-elevated text-text-secondary hover:bg-surface-container hover:text-text-primary'
      }`;
    });
  },

  // --- 过滤 + 重新渲染 ---
  _filterAndRender(container) {
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
        s.description.toLowerCase().includes(kw) ||
        (this._categoryLabels[s.category] || '').includes(kw)
      );
    }

    // 更新网格
    const grid = container.querySelector('#skill-grid');
    if (grid) {
      grid.innerHTML = this._renderGrid(filtered);
      refreshIcons();
    }

    // 更新计数
    const countEl = container.querySelector('#skill-count');
    if (countEl) countEl.textContent = `${filtered.length} 个技能`;
  },

  // --- 安装技能（占位） ---
  _installSkill(skillId) {
    const skill = this._skills.find(s => s.id === skillId);
    if (!skill) return;
    showToast(`${skill.name} 安装功能开发中`, 'info');
  },
};
