// @alpha: skills 页面模块 (TS 迁移 — Alpha pass)
import { $, $$, L, refreshIcons, escHtml, showToast, formatBytes, formatUptime, pctColor, pctBg, safeAttr, cidrMatch, isValidCidr } from '../utils';
import { App } from '../core';
import { Modal } from '../modal';


// @alpha: 技能商店页面 — 技能发现、分类浏览、安装状态展示
// 数据来源: OpenClaw SkillsHub 远端同步 + skills.sh 排行 + npm 生态 + Console 内置

export const Skills = {
  // --- 技能数据（多源聚合，经验证） ---
  _skills: [
    // ═══════════════════════════════════════════
    //  OpenClaw SkillsHub — 远端已安装/已验证
    // ═══════════════════════════════════════════
    {
      id: 'agent-browser',
      name: 'Agent Browser',
      version: 'v1.0',
      author: 'Vercel Labs / OpenClaw',
      description: '浏览器自动化 CLI — AI 代理驱动网页交互、表单填充、截图与数据提取。119K+ 安装。',
      category: 'ai',
      icon: 'globe',
      iconGradient: 'linear-gradient(135deg, #0ea5e9 0%, #38bdf8 100%)',
      rating: 4.9,
      installs: 119200,
      installed: false,
      source: 'openclaw',
      slug: 'vercel-labs/agent-browser@agent-browser',
    },
    {
      id: 'find-skills',
      name: 'Find Skills',
      version: 'v1.0',
      author: 'OpenClaw',
      description: '技能发现助手 — 搜索 skills.sh 开放生态，智能推荐并安装适合的 agent 技能',
      category: 'ai',
      icon: 'search',
      iconGradient: 'linear-gradient(135deg, #8b5cf6 0%, #c4b5fd 100%)',
      rating: 4.6,
      installs: 3200,
      installed: false,
      source: 'openclaw',
      slug: 'builtin/find-skills',
    },
    {
      id: 'feishu-doc',
      name: '飞书文档',
      version: 'v1.0',
      author: 'OpenClaw',
      description: '飞书文档协作集成 — 自动读写飞书云文档、表格与知识库',
      category: 'integration',
      icon: 'file-text',
      iconGradient: 'linear-gradient(135deg, #3b82f6 0%, #93c5fd 100%)',
      rating: 4.5,
      installs: 420,
      installed: false,
      source: 'openclaw',
    },
    {
      id: 'slack',
      name: 'Slack',
      version: 'v1.0',
      author: 'OpenClaw',
      description: 'Slack 消息通道集成 — 接收指令、推送告警与运维通知',
      category: 'integration',
      icon: 'hash',
      iconGradient: 'linear-gradient(135deg, #611f69 0%, #e01e5a 100%)',
      rating: 4.3,
      installs: 380,
      installed: false,
      source: 'openclaw',
    },
    {
      id: 'feishu-channel',
      name: '飞书消息通道',
      version: 'v1.0',
      author: 'OpenClaw / LarkSuite',
      description: '飞书 Bot 消息通道 — WebSocket 实时通信、群聊与私聊指令分发',
      category: 'integration',
      icon: 'message-circle',
      iconGradient: 'linear-gradient(135deg, #2563eb 0%, #60a5fa 100%)',
      rating: 4.6,
      installs: 510,
      installed: false,
      source: 'openclaw',
    },
    {
      id: 'qwen-portal-auth',
      name: '通义千问认证',
      version: 'v1.0',
      author: 'OpenClaw',
      description: '通义千问 Portal 免 API-Key 认证 — 自动 Cookie 刷新与会话保持',
      category: 'ai',
      icon: 'key-round',
      iconGradient: 'linear-gradient(135deg, #7c3aed 0%, #c084fc 100%)',
      rating: 4.2,
      installs: 290,
      installed: false,
      source: 'openclaw',
    },
    {
      id: 'blog-writer',
      name: 'Blog Writer',
      version: 'v1.0',
      author: 'SynonClaw',
      description: '博客写手 — 根据大纲自动生成 MDX 博文，构建并发布到站点',
      category: 'content',
      icon: 'pen-tool',
      iconGradient: 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)',
      rating: 4.4,
      installs: 180,
      installed: false,
      source: 'openclaw',
    },

    // ═══════════════════════════════════════════
    //  skills.sh 排行榜 — 经验证的热门 skills
    // ═══════════════════════════════════════════
    {
      id: 'agent-tools',
      name: 'Agent Tools',
      version: 'v1.2',
      author: 'Inferen',
      description: '通用 Agent 工具集 — 文件操作、代码执行、系统交互等基础能力扩展。93K+ 安装。',
      category: 'ai',
      icon: 'wrench',
      iconGradient: 'linear-gradient(135deg, #6366f1 0%, #a5b4fc 100%)',
      rating: 4.8,
      installs: 92700,
      installed: false,
      source: 'skills.sh',
      slug: 'inferen-sh/skills@agent-tools',
    },
    {
      id: 'web-design-guidelines',
      name: 'Web Design',
      version: 'v1.0',
      author: 'Vercel Labs',
      description: '前端设计规范 — 响应式布局、配色系统、组件设计最佳实践指南',
      category: 'frontend',
      icon: 'palette',
      iconGradient: 'linear-gradient(135deg, #ec4899 0%, #f9a8d4 100%)',
      rating: 4.7,
      installs: 28600,
      installed: false,
      source: 'skills.sh',
      slug: 'vercel-labs/agent-skills@web-design-guidelines',
    },
    {
      id: 'vercel-react',
      name: 'React 最佳实践',
      version: 'v1.1',
      author: 'Vercel Labs',
      description: 'React + Next.js 性能优化指南 — 来自 Vercel 工程团队的最佳实践',
      category: 'frontend',
      icon: 'atom',
      iconGradient: 'linear-gradient(135deg, #06b6d4 0%, #67e8f9 100%)',
      rating: 4.8,
      installs: 35200,
      installed: false,
      source: 'skills.sh',
      slug: 'vercel-labs/agent-skills@vercel-react-best-practices',
    },
    {
      id: 'agentic-eval',
      name: 'Agentic Eval',
      version: 'v1.0',
      author: 'GitHub',
      description: 'Agent 评估框架 — 自动化测试 Agent 输出质量与任务完成度',
      category: 'devops',
      icon: 'check-circle-2',
      iconGradient: 'linear-gradient(135deg, #16a34a 0%, #86efac 100%)',
      rating: 4.5,
      installs: 7700,
      installed: false,
      source: 'skills.sh',
      slug: 'github/awesome-copilot@agentic-eval',
    },
    {
      id: 'seo-audit',
      name: 'SEO Audit',
      version: 'v1.0',
      author: 'Community',
      description: 'SEO 审计 — 自动检测页面 SEO 问题、生成优化建议与结构化数据',
      category: 'content',
      icon: 'search',
      iconGradient: 'linear-gradient(135deg, #059669 0%, #6ee7b7 100%)',
      rating: 4.4,
      installs: 5800,
      installed: false,
      source: 'skills.sh',
      slug: 'skills@seo-audit',
    },
    {
      id: 'systematic-debugging',
      name: '系统化调试',
      version: 'v1.0',
      author: 'Community',
      description: '结构化调试流程 — 根因分析、日志定位、复现步骤生成',
      category: 'devops',
      icon: 'bug',
      iconGradient: 'linear-gradient(135deg, #dc2626 0%, #fca5a5 100%)',
      rating: 4.6,
      installs: 4200,
      installed: false,
      source: 'skills.sh',
      slug: 'skills@systematic-debugging',
    },
    {
      id: 'test-driven-dev',
      name: 'TDD 驱动开发',
      version: 'v1.0',
      author: 'Community',
      description: '测试驱动开发 — 自动生成测试用例、覆盖率分析与回归检测',
      category: 'devops',
      icon: 'test-tubes',
      iconGradient: 'linear-gradient(135deg, #0d9488 0%, #5eead4 100%)',
      rating: 4.5,
      installs: 3900,
      installed: false,
      source: 'skills.sh',
      slug: 'skills@test-driven-development',
    },
    {
      id: 'security-best',
      name: '安全最佳实践',
      version: 'v1.0',
      author: 'Community',
      description: '安全加固指南 — OWASP Top 10 检查、依赖漏洞扫描、安全配置审计',
      category: 'security',
      icon: 'shield-check',
      iconGradient: 'linear-gradient(135deg, #dc2626 0%, #f87171 100%)',
      rating: 4.6,
      installs: 3100,
      installed: false,
      source: 'skills.sh',
      slug: 'skills@security-best-practices',
    },
    {
      id: 'playwright-best',
      name: 'Playwright 测试',
      version: 'v1.0',
      author: 'Community',
      description: 'Playwright E2E 测试 — 自动生成页面测试、视觉对比与 CI 集成',
      category: 'devops',
      icon: 'play-circle',
      iconGradient: 'linear-gradient(135deg, #2563eb 0%, #93c5fd 100%)',
      rating: 4.5,
      installs: 2800,
      installed: false,
      source: 'skills.sh',
      slug: 'skills@playwright-best-practices',
    },
    {
      id: 'data-analysis',
      name: '数据分析',
      version: 'v1.0',
      author: 'Community',
      description: '数据分析 — CSV/JSON 数据处理、可视化图表生成与统计洞察',
      category: 'ai',
      icon: 'bar-chart-3',
      iconGradient: 'linear-gradient(135deg, #8b5cf6 0%, #c4b5fd 100%)',
      rating: 4.3,
      installs: 2400,
      installed: false,
      source: 'skills.sh',
      slug: 'skills@data-analysis',
    },
    {
      id: 'mcp-builder',
      name: 'MCP Builder',
      version: 'v1.0',
      author: 'Community',
      description: 'MCP Server 构建器 — 快速创建 Model Context Protocol 服务端工具',
      category: 'ai',
      icon: 'blocks',
      iconGradient: 'linear-gradient(135deg, #4338ca 0%, #818cf8 100%)',
      rating: 4.4,
      installs: 2100,
      installed: false,
      source: 'skills.sh',
      slug: 'skills@mcp-builder',
    },

    // ═══════════════════════════════════════════
    //  npm 生态 — OpenClaw 官方/认证插件
    // ═══════════════════════════════════════════
    {
      id: 'ollama-web-search',
      name: 'Ollama Web Search',
      version: 'v0.2',
      author: 'Ollama',
      description: 'Ollama 搜索引擎 — 为本地 LLM 提供实时网页搜索与知识增强能力',
      category: 'ai',
      icon: 'search',
      iconGradient: 'linear-gradient(135deg, #1e293b 0%, #475569 100%)',
      rating: 4.3,
      installs: 1600,
      installed: false,
      source: 'npm',
      slug: '@ollama/openclaw-web-search',
    },
    {
      id: 'stepfun-gateway',
      name: 'StepFun Gateway',
      version: 'v0.2',
      author: 'StepFun',
      description: 'StepFun WebSocket 网关通道 — 阶跃星辰大模型实时对话与流式推理',
      category: 'integration',
      icon: 'zap',
      iconGradient: 'linear-gradient(135deg, #ea580c 0%, #fb923c 100%)',
      rating: 4.1,
      installs: 420,
      installed: false,
      source: 'npm',
      slug: 'openclaw-stepfun',
    },
    {
      id: 'openutter',
      name: 'OpenUtter',
      version: 'v0.1',
      author: 'Community',
      description: '语音交互 — AI Agent 语音输入输出，支持 TTS 与 ASR 双向通信',
      category: 'ai',
      icon: 'mic',
      iconGradient: 'linear-gradient(135deg, #0891b2 0%, #22d3ee 100%)',
      rating: 4.0,
      installs: 310,
      installed: false,
      source: 'npm',
      slug: 'openutter',
    },

    // ═══════════════════════════════════════════
    //  Console 内置技能
    // ═══════════════════════════════════════════
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
      installed: false,
      source: 'console',
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
      installed: false,
      source: 'console',
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
      source: 'console',
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
      source: 'console',
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
      source: 'console',
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
      installed: false,
      source: 'console',
    },
  ],

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
  },

  // 来源标签
  _sourceLabels: {
    openclaw: 'OpenClaw', 'skills.sh': 'skills.sh', npm: 'npm', console: 'Console', community: 'Community',
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
              <input id="skill-search" type="text" placeholder="搜索技能…"
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
          <span class="text-border-default">·</span>
          <span class="inline-flex items-center gap-1">
            <i data-lucide="database" class="w-3 h-3"></i>
            4 个来源
          </span>
        </div>
      </div>

      <!-- 技能卡片网格 -->
      <div id="skill-grid" class="px-6 pb-8">
        ${this._renderGrid(this._skills)}
      </div>
    `;

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
    const sourceLabel = this._sourceLabels[skill.source] || skill.source;
    const installText = skill.installs >= 1000
      ? `${(skill.installs / 1000).toFixed(1)}k`
      : `${skill.installs}`;
    const delay = Math.min(index * 40, 400);

    // 来源徽章颜色
    const sourceBadgeClass = {
      openclaw: 'bg-blue-50 text-blue-700',
      'skills.sh': 'bg-violet-50 text-violet-700',
      npm: 'bg-red-50 text-red-700',
      console: 'bg-emerald-50 text-emerald-700',
      community: 'bg-amber-50 text-amber-700',
    }[skill.source] || 'bg-elevated text-text-muted';

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
              <span class="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded ${sourceBadgeClass}">${sourceLabel}</span>
            </div>
            <p class="text-xs text-text-muted mt-0.5">by ${escHtml(skill.author)}</p>
          </div>
        </div>

        <!-- 描述 -->
        <p class="text-sm text-text-secondary leading-relaxed mb-4 line-clamp-2">${escHtml(skill.description)}</p>

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
          <button class="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium rounded-lg bg-primary text-text-inverse hover:bg-primary-dark transition cursor-pointer shadow-sm"
              onclick="event.stopPropagation(); Skills._installSkill('${skill.id}')">
              <i data-lucide="download" class="w-3 h-3"></i>安装</button>
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

    // 搜索过滤（名称/描述/分类/作者/来源）
    if (this._searchKeyword) {
      const kw = this._searchKeyword;
      filtered = filtered.filter(s =>
        s.name.toLowerCase().includes(kw) ||
        s.description.toLowerCase().includes(kw) ||
        (this._categoryLabels[s.category] || '').includes(kw) ||
        s.author.toLowerCase().includes(kw) ||
        (this._sourceLabels[s.source] || '').toLowerCase().includes(kw)
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

  // --- 安装技能（交互流与 UI） ---
  async _installSkill(skillId) {
    const skill = this._skills.find(s => s.id === skillId);
    if (!skill) return;

    try {
      // 1. 抓取可用节点列表
      const res = await App.authFetch('/api/nodes');
      const data = await res.json();
      const allNodes = Array.isArray(data.nodes) ? data.nodes : (Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []));
      const nodes = allNodes.filter(n => n.online);

      // 2. 构建 Stitch "Kinetic Command" 风格的独立模态框
      const overlay = document.createElement('div');
      overlay.className = 'fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm transition-opacity duration-300 opacity-0';
      
      const nodeHtml = nodes.length > 0 ? nodes.map(node => {
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

      overlay.querySelectorAll('.modal-close').forEach(btn => btn.addEventListener('click', closeHandler));
      // Optional: close on backdrop click (might conflict with dialog inner clicks if not careful)
      overlay.addEventListener('mousedown', (e) => {
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
            // 调用后端的 Skill 安装 API (Phase 4 接口预留)
            const res = await App.authFetch(`/api/nodes/${targetNodeId}/skills`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                skillId: skill.id,
                source: skill.source,
                version: skill.version,
                name: skill.name
              })
            });
            if (!res.ok) {
              const errData = await res.json().catch(() => ({}));
              throw new Error(errData.error || `Server responded with ${res.status}`);
            }
            // 乐观更新 allNodesRaw — 确保技能面板立即可见
            const targetNode = App.allNodesRaw.find(n => n.id === targetNodeId);
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
