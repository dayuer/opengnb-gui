'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createLogger } = require('./logger');
const log = createLogger('SkillsStore');

/**
 * 技能注册表 — SQLite 持久化层
 *
 * 管理所有技能元数据（内置 + 用户上传），对外暴露 CRUD 接口。
 * 支持两种模式：
 *   1. 共享模式：传入已打开的 DB 实例（推荐，与 NodeStore 共用 nodes.db）
 *   2. 独立模式：传入路径（向后兼容，独立 skills.db）
 */
class SkillsStore {
  dbPath: string;
  db: any;
  _stmts: any;
  _shared: boolean;

  constructor(dbOrPath: any) {
    if (typeof dbOrPath === 'object' && dbOrPath !== null && typeof dbOrPath.prepare === 'function') {
      // 共享模式 — 接收已打开的 DB 实例
      this.db = dbOrPath;
      this.dbPath = '';
      this._shared = true;
    } else {
      // 独立模式 — 路径（向后兼容）
      this.dbPath = dbOrPath;
      this.db = null;
      this._shared = false;
    }
    this._stmts = {};
  }

  /**
   * 初始化数据库 + 预装内置技能
   */
  init() {
    if (!this._shared) {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
    }

    this._createTables();
    this._prepareStatements();

    // 首次启动：预装内置技能
    if (this.count() === 0) {
      this._seed();
    }
  }

  /** @private 建表 */
  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT DEFAULT 'v1.0',
        author TEXT DEFAULT '',
        description TEXT DEFAULT '',
        category TEXT DEFAULT 'ai',
        icon TEXT DEFAULT 'package',
        iconGradient TEXT DEFAULT 'linear-gradient(135deg, #6366f1 0%, #a5b4fc 100%)',
        rating REAL DEFAULT 0,
        installs INTEGER DEFAULT 0,
        source TEXT DEFAULT 'custom',
        slug TEXT DEFAULT '',
        installType TEXT DEFAULT 'prompt',
        skillContent TEXT DEFAULT '',
        isBuiltin INTEGER DEFAULT 0,
        createdAt TEXT,
        updatedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
      CREATE INDEX IF NOT EXISTS idx_skills_source ON skills(source);
      CREATE INDEX IF NOT EXISTS idx_skills_isBuiltin ON skills(isBuiltin);
    `);
  }

  /** @private 预编译语句 */
  _prepareStatements() {
    this._stmts = {
      all: this.db.prepare('SELECT * FROM skills ORDER BY isBuiltin DESC, installs DESC, name ASC'),
      findById: this.db.prepare('SELECT * FROM skills WHERE id = ?'),
      count: this.db.prepare('SELECT COUNT(*) as cnt FROM skills'),
      insert: this.db.prepare(`
        INSERT INTO skills (id, name, version, author, description, category, icon, iconGradient,
          rating, installs, source, slug, installType, skillContent, isBuiltin, createdAt, updatedAt)
        VALUES (@id, @name, @version, @author, @description, @category, @icon, @iconGradient,
          @rating, @installs, @source, @slug, @installType, @skillContent, @isBuiltin, @createdAt, @updatedAt)
      `),
      update: this.db.prepare(`
        UPDATE skills SET name=@name, version=@version, author=@author, description=@description,
          category=@category, icon=@icon, iconGradient=@iconGradient, installType=@installType,
          skillContent=@skillContent, updatedAt=@updatedAt WHERE id=@id
      `),
      delete: this.db.prepare('DELETE FROM skills WHERE id = ? AND isBuiltin = 0'),
      search: this.db.prepare(`
        SELECT * FROM skills
        WHERE (name LIKE @kw OR description LIKE @kw OR author LIKE @kw OR category LIKE @kw)
        ORDER BY isBuiltin DESC, installs DESC
      `),
    };
  }

  /** 总数 */
  count(): number {
    return this._stmts.count.get().cnt;
  }

  /** 全量列表 */
  all(): any[] {
    return this._stmts.all.all();
  }

  /** 按 ID 查找 */
  findById(id: string): any | null {
    return this._stmts.findById.get(id) || null;
  }

  /** 搜索 */
  search(keyword: string): any[] {
    return this._stmts.search.all({ kw: `%${keyword}%` });
  }

  /** 按分类过滤 */
  findByCategory(category: string): any[] {
    return this.all().filter(s => s.category === category);
  }

  /** 创建新技能（用户上传） */
  create(skill: any): any {
    const now = new Date().toISOString();
    // @fix: better-sqlite3 只接受 number|string|bigint|Buffer|null
    // 必须显式强转所有字段，杜绝 boolean/undefined 泄漏
    const row = {
      id: String(skill.id || crypto.randomUUID()),
      name: String(skill.name || 'Untitled Skill'),
      version: String(skill.version || 'v1.0'),
      author: String(skill.author || 'User'),
      description: String(skill.description || ''),
      category: String(skill.category || 'ai'),
      icon: String(skill.icon || 'package'),
      iconGradient: String(skill.iconGradient || 'linear-gradient(135deg, #6366f1 0%, #a5b4fc 100%)'),
      rating: Number(skill.rating) || 0,
      installs: Number(skill.installs) || 0,
      source: String(skill.source || 'custom'),
      slug: String(skill.slug || ''),
      installType: String(skill.installType || 'prompt'),
      skillContent: String(skill.skillContent || ''),
      isBuiltin: skill.isBuiltin ? 1 : 0,
      createdAt: now,
      updatedAt: now,
    };
    this._stmts.insert.run(row);
    return row;
  }

  /** 删除用户上传的技能（内置不可删） */
  delete(id: string): boolean {
    const result = this._stmts.delete.run(id);
    return result.changes > 0;
  }

  /** @private 预装内置技能 */
  _seed() {
    const builtins = SkillsStore.BUILTIN_SKILLS;
    const insertMany = this.db.transaction((skills: any[]) => {
      for (const s of skills) {
        this.create({ ...s, isBuiltin: true });
      }
    });
    insertMany(builtins);
    log.info(`预装 ${builtins.length} 个内置技能`);
  }

  /** 关闭数据库 */
  close() {
    if (this.db) this.db.close();
  }

  // ═══════════════════════════════════════════
  //  内置技能数据（从 skills.ts 迁移）
  // ═══════════════════════════════════════════
  static BUILTIN_SKILLS = [
    // --- OpenClaw SkillsHub ---
    { id: 'agent-browser', name: 'Agent Browser', version: 'v1.0', author: 'Vercel Labs / OpenClaw', description: '浏览器自动化 CLI — AI 代理驱动网页交互、表单填充、截图与数据提取。119K+ 安装。', category: 'ai', icon: 'globe', iconGradient: 'linear-gradient(135deg, #0ea5e9 0%, #38bdf8 100%)', rating: 4.9, installs: 119200, source: 'openclaw', slug: 'vercel-labs/agent-browser@agent-browser', installType: 'prompt' },
    { id: 'find-skills', name: 'Find Skills', version: 'v1.0', author: 'OpenClaw', description: '技能发现助手 — 搜索 skills.sh 开放生态，智能推荐并安装适合的 agent 技能', category: 'ai', icon: 'search', iconGradient: 'linear-gradient(135deg, #8b5cf6 0%, #c4b5fd 100%)', rating: 4.6, installs: 3200, source: 'openclaw', slug: 'builtin/find-skills', installType: 'prompt' },
    { id: 'feishu-doc', name: '飞书文档', version: 'v1.0', author: 'OpenClaw', description: '飞书文档协作集成 — 自动读写飞书云文档、表格与知识库', category: 'integration', icon: 'file-text', iconGradient: 'linear-gradient(135deg, #3b82f6 0%, #93c5fd 100%)', rating: 4.5, installs: 420, source: 'openclaw', installType: 'prompt' },
    { id: 'slack', name: 'Slack', version: 'v1.0', author: 'OpenClaw', description: 'Slack 消息通道集成 — 接收指令、推送告警与运维通知', category: 'integration', icon: 'hash', iconGradient: 'linear-gradient(135deg, #611f69 0%, #e01e5a 100%)', rating: 4.3, installs: 380, source: 'openclaw', installType: 'prompt' },
    { id: 'feishu-channel', name: '飞书消息通道', version: 'v1.0', author: 'OpenClaw / LarkSuite', description: '飞书 Bot 消息通道 — WebSocket 实时通信、群聊与私聊指令分发', category: 'integration', icon: 'message-circle', iconGradient: 'linear-gradient(135deg, #2563eb 0%, #60a5fa 100%)', rating: 4.6, installs: 510, source: 'openclaw', installType: 'prompt' },
    { id: 'qwen-portal-auth', name: '通义千问认证', version: 'v1.0', author: 'OpenClaw', description: '通义千问 Portal 免 API-Key 认证 — 自动 Cookie 刷新与会话保持', category: 'ai', icon: 'key-round', iconGradient: 'linear-gradient(135deg, #7c3aed 0%, #c084fc 100%)', rating: 4.2, installs: 290, source: 'openclaw', installType: 'prompt' },
    { id: 'blog-writer', name: 'Blog Writer', version: 'v1.0', author: 'SynonClaw', description: '博客写手 — 根据大纲自动生成 MDX 博文，构建并发布到站点', category: 'content', icon: 'pen-tool', iconGradient: 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)', rating: 4.4, installs: 180, source: 'openclaw', installType: 'prompt' },
    // --- skills.sh ---
    { id: 'agent-tools', name: 'Agent Tools', version: 'v1.2', author: 'Inferen', description: '通用 Agent 工具集 — 文件操作、代码执行、系统交互等基础能力扩展。93K+ 安装。', category: 'ai', icon: 'wrench', iconGradient: 'linear-gradient(135deg, #6366f1 0%, #a5b4fc 100%)', rating: 4.8, installs: 92700, source: 'skills.sh', slug: 'inferen-sh/skills@agent-tools', installType: 'prompt' },
    { id: 'web-design-guidelines', name: 'Web Design', version: 'v1.0', author: 'Vercel Labs', description: '前端设计规范 — 响应式布局、配色系统、组件设计最佳实践指南', category: 'frontend', icon: 'palette', iconGradient: 'linear-gradient(135deg, #ec4899 0%, #f9a8d4 100%)', rating: 4.7, installs: 28600, source: 'skills.sh', slug: 'vercel-labs/agent-skills@web-design-guidelines', installType: 'prompt' },
    { id: 'vercel-react', name: 'React 最佳实践', version: 'v1.1', author: 'Vercel Labs', description: 'React + Next.js 性能优化指南 — 来自 Vercel 工程团队的最佳实践', category: 'frontend', icon: 'atom', iconGradient: 'linear-gradient(135deg, #06b6d4 0%, #67e8f9 100%)', rating: 4.8, installs: 35200, source: 'skills.sh', slug: 'vercel-labs/agent-skills@vercel-react-best-practices', installType: 'prompt' },
    { id: 'agentic-eval', name: 'Agentic Eval', version: 'v1.0', author: 'GitHub', description: 'Agent 评估框架 — 自动化测试 Agent 输出质量与任务完成度', category: 'devops', icon: 'check-circle-2', iconGradient: 'linear-gradient(135deg, #16a34a 0%, #86efac 100%)', rating: 4.5, installs: 7700, source: 'skills.sh', slug: 'github/awesome-copilot@agentic-eval', installType: 'prompt' },
    { id: 'seo-audit', name: 'SEO Audit', version: 'v1.0', author: 'Community', description: 'SEO 审计 — 自动检测页面 SEO 问题、生成优化建议与结构化数据', category: 'content', icon: 'search', iconGradient: 'linear-gradient(135deg, #059669 0%, #6ee7b7 100%)', rating: 4.4, installs: 5800, source: 'skills.sh', slug: 'skills@seo-audit', installType: 'prompt' },
    { id: 'systematic-debugging', name: '系统化调试', version: 'v1.0', author: 'Community', description: '结构化调试流程 — 根因分析、日志定位、复现步骤生成', category: 'devops', icon: 'bug', iconGradient: 'linear-gradient(135deg, #dc2626 0%, #fca5a5 100%)', rating: 4.6, installs: 4200, source: 'skills.sh', slug: 'skills@systematic-debugging', installType: 'prompt' },
    { id: 'test-driven-dev', name: 'TDD 驱动开发', version: 'v1.0', author: 'Community', description: '测试驱动开发 — 自动生成测试用例、覆盖率分析与回归检测', category: 'devops', icon: 'test-tubes', iconGradient: 'linear-gradient(135deg, #0d9488 0%, #5eead4 100%)', rating: 4.5, installs: 3900, source: 'skills.sh', slug: 'skills@test-driven-development', installType: 'prompt' },
    { id: 'security-best', name: '安全最佳实践', version: 'v1.0', author: 'Community', description: '安全加固指南 — OWASP Top 10 检查、依赖漏洞扫描、安全配置审计', category: 'security', icon: 'shield-check', iconGradient: 'linear-gradient(135deg, #dc2626 0%, #f87171 100%)', rating: 4.6, installs: 3100, source: 'skills.sh', slug: 'skills@security-best-practices', installType: 'prompt' },
    { id: 'playwright-best', name: 'Playwright 测试', version: 'v1.0', author: 'Community', description: 'Playwright E2E 测试 — 自动生成页面测试、视觉对比与 CI 集成', category: 'devops', icon: 'play-circle', iconGradient: 'linear-gradient(135deg, #2563eb 0%, #93c5fd 100%)', rating: 4.5, installs: 2800, source: 'skills.sh', slug: 'skills@playwright-best-practices', installType: 'prompt' },
    { id: 'data-analysis', name: '数据分析', version: 'v1.0', author: 'Community', description: '数据分析 — CSV/JSON 数据处理、可视化图表生成与统计洞察', category: 'ai', icon: 'bar-chart-3', iconGradient: 'linear-gradient(135deg, #8b5cf6 0%, #c4b5fd 100%)', rating: 4.3, installs: 2400, source: 'skills.sh', slug: 'skills@data-analysis', installType: 'prompt' },
    { id: 'mcp-builder', name: 'MCP Builder', version: 'v1.0', author: 'Community', description: 'MCP Server 构建器 — 快速创建 Model Context Protocol 服务端工具', category: 'ai', icon: 'blocks', iconGradient: 'linear-gradient(135deg, #4338ca 0%, #818cf8 100%)', rating: 4.4, installs: 2100, source: 'skills.sh', slug: 'skills@mcp-builder', installType: 'prompt' },
    // --- npm ---
    { id: 'ollama-web-search', name: 'Ollama Web Search', version: 'v0.2', author: 'Ollama', description: 'Ollama 搜索引擎 — 为本地 LLM 提供实时网页搜索与知识增强能力', category: 'ai', icon: 'search', iconGradient: 'linear-gradient(135deg, #1e293b 0%, #475569 100%)', rating: 4.3, installs: 1600, source: 'npm', slug: '@ollama/openclaw-web-search', installType: 'npm' },
    { id: 'stepfun-gateway', name: 'StepFun Gateway', version: 'v0.2', author: 'StepFun', description: 'StepFun WebSocket 网关通道 — 阶跃星辰大模型实时对话与流式推理', category: 'integration', icon: 'zap', iconGradient: 'linear-gradient(135deg, #ea580c 0%, #fb923c 100%)', rating: 4.1, installs: 420, source: 'npm', slug: 'openclaw-stepfun', installType: 'npm' },
    { id: 'openutter', name: 'OpenUtter', version: 'v0.1', author: 'Community', description: '语音交互 — AI Agent 语音输入输出，支持 TTS 与 ASR 双向通信', category: 'ai', icon: 'mic', iconGradient: 'linear-gradient(135deg, #0891b2 0%, #22d3ee 100%)', rating: 4.0, installs: 310, source: 'npm', slug: 'openutter', installType: 'npm' },
    // --- Console 内置 ---
    { id: 'claude-code', name: 'Claude Code', version: 'v2.4', author: 'SynonClaw', description: 'AI 智能运维终端 — 自然语言驱动服务器管理', category: 'ai', icon: 'brain', iconGradient: 'linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%)', rating: 4.9, installs: 2400, source: 'console', installType: 'prompt' },
    { id: 'node-guardian', name: 'Node Guardian', version: 'v1.0', author: 'SynonClaw', description: '节点健康守护 — 自动故障检测与告警通知', category: 'monitor', icon: 'heart-pulse', iconGradient: 'linear-gradient(135deg, #059669 0%, #34d399 100%)', rating: 4.8, installs: 1200, source: 'console', installType: 'prompt' },
    { id: 'firewall-manager', name: 'Firewall Manager', version: 'v1.1', author: 'SynonClaw', description: '智能防火墙规则管理 — 自动安全策略推荐', category: 'security', icon: 'shield-check', iconGradient: 'linear-gradient(135deg, #dc2626 0%, #f87171 100%)', rating: 4.6, installs: 890, source: 'console', installType: 'prompt' },
    { id: 'gnb-optimizer', name: 'GNB Optimizer', version: 'v0.9', author: 'SynonClaw', description: 'GNB 隧道性能优化 — 智能路由与带宽调度', category: 'network', icon: 'route', iconGradient: 'linear-gradient(135deg, #2563eb 0%, #60a5fa 100%)', rating: 4.3, installs: 650, source: 'console', installType: 'prompt' },
    { id: 'log-analyzer', name: 'Log Analyzer', version: 'v1.3', author: 'SynonClaw', description: '日志智能分析 — 异常模式检测与根因定位', category: 'ops', icon: 'file-search', iconGradient: 'linear-gradient(135deg, #d97706 0%, #fbbf24 100%)', rating: 4.7, installs: 1050, source: 'console', installType: 'prompt' },
    { id: 'backup-agent', name: 'Backup Agent', version: 'v2.0', author: 'SynonClaw', description: '自动备份与恢复 — 增量快照 + 异地容灾', category: 'ops', icon: 'database-backup', iconGradient: 'linear-gradient(135deg, #0891b2 0%, #22d3ee 100%)', rating: 4.5, installs: 780, source: 'console', installType: 'prompt' },
  ];
}

module.exports = SkillsStore;
export {}; // CJS 模块标记
