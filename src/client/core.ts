// @alpha: 核心模块 — 认证、路由、主题、全局状态
import { $, $$, L, refreshIcons, escHtml, showToast } from './utils';
import { Modal } from './modal';
import { WS } from './ws';

// 页面模块前向声明 — 避免循环依赖，运行时从 window 获取
function getDashboard(): any { return (window as any).Dashboard; }
function getNodes(): any { return (window as any).Nodes; }
function getUsers(): any { return (window as any).Users; }
function getSettings(): any { return (window as any).Settings; }
function getSkills(): any { return (window as any).Skills; }

interface NodeFilter {
  groupId: string | null;
  subnet: string;
  keyword: string;
  status: string;
}

interface PageTitles {
  [key: string]: string;
}

export const App = {
  // --- 全局状态 ---
  nodesData: [] as any[],
  pendingNodes: [] as any[],
  selectedNodeId: null as string | null,
  currentPage: 'dashboard',
  nodeGroups: [] as any[],
  allNodesRaw: [] as any[],
  nodeFilter: { groupId: null, subnet: '', keyword: '', status: '' } as NodeFilter,
  selectedIds: new Set<string>(),
  nodePagination: { page: 1, pageSize: 50 },
  opsLogsCache: {} as Record<string, any>,
  _cachedApiToken: '',
  _prevNodeCount: undefined as number | undefined,

  PAGE_TITLES: {
    dashboard: '仪表盘',
    nodes: '节点管理',
    users: '团队设置',
    settings: '系统设置',
    skills: '技能商店',
  } as PageTitles,

  // --- 认证 ---
  getToken(): string { return localStorage.getItem('gnb_admin_token') || ''; },
  setToken(t: string): void { localStorage.setItem('gnb_admin_token', t); },

  async authFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const token = this.getToken();
    options.headers = { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await fetch(url, options);
    if (res.status === 401) { this.showLoginPage(); throw new Error('认证失败'); }
    return res;
  },

  showLoginPage(): void {
    const lp = $('#login-page');
    const app = $('#app');
    if (lp) { lp.classList.remove('hidden'); lp.classList.add('flex'); refreshIcons(); }
    if (app) { app.classList.add('hidden'); app.classList.remove('flex'); }
  },

  hideLoginPage(): void {
    const lp = $('#login-page');
    const app = $('#app');
    if (lp) { lp.classList.add('hidden'); lp.classList.remove('flex'); }
    if (app) { app.classList.remove('hidden'); app.classList.add('flex'); }
  },

  async doLogin(e?: Event): Promise<void> {
    if (e) e.preventDefault();
    const username = ($('#login-username') as HTMLInputElement)?.value?.trim();
    const password = ($('#login-password') as HTMLInputElement)?.value;
    if (!username || !password) return;
    const errEl = $('#login-error');
    const btn = $('#login-btn') as HTMLButtonElement | null;
    const btnText = $('#login-btn-text');
    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = '登录中...';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (errEl) { errEl.textContent = data.error || '登录失败'; errEl.classList.remove('hidden'); }
        if (btn) btn.disabled = false;
        if (btnText) btnText.textContent = '登 录';
        return;
      }
      this.setToken(data.token);
      this._cachedApiToken = data.apiToken || '';
      this.hideLoginPage();
      WS.connect();
      this.switchPage('dashboard');
    } catch (_) {
      if (errEl) { errEl.textContent = '网络错误'; errEl.classList.remove('hidden'); }
      if (btn) btn.disabled = false;
      if (btnText) btnText.textContent = '登 录';
    }
  },

  // --- 路由 ---
  switchPage(page: string): void {
    this.currentPage = page;
    $$('.nav-item').forEach((item) => {
      if ((item as HTMLElement).dataset.page === page) item.setAttribute('data-active', '');
      else item.removeAttribute('data-active');
    });
    const titleEl = $('#page-title');
    if (titleEl) titleEl.textContent = this.PAGE_TITLES[page] || page;
    this.renderPage(page);
    refreshIcons();
    this.closeSidebar();
  },

  renderPage(page: string): void {
    const container = $('#main-content');
    if (!container) return;
    switch (page) {
      case 'dashboard': getDashboard().render(container); break;
      case 'nodes':     getNodes().render(container); break;
      case 'users':     getUsers().render(container); break;
      case 'groups':    this.switchPage('nodes'); return;
      case 'settings':  getSettings().render(container); break;
      case 'skills':    getSkills().render(container); break;
      default:
        container.innerHTML = `<div class="flex flex-col items-center justify-center h-64 text-text-muted">
          <span class="text-4xl mb-2">${L('lock')}</span><span>未知页面</span></div>`;
    }
  },

  // --- 侧边栏 ---
  toggleSidebar(): void {
    const sb = $('#sidebar');
    const bd = $('#sidebar-backdrop');
    if (window.innerWidth <= 768 && sb && bd) {
      sb.toggleAttribute('data-open');
      bd.classList.toggle('hidden');
    }
  },

  closeSidebar(): void {
    const sb = $('#sidebar');
    const bd = $('#sidebar-backdrop');
    sb?.removeAttribute('data-open');
    bd?.classList.add('hidden');
  },

  // --- 用户菜单 ---
  toggleUserMenu(): void {
    const dd = $('#user-dropdown');
    if (dd) dd.classList.toggle('hidden');
  },

  closeUserMenu(): void {
    const dd = $('#user-dropdown');
    if (dd) dd.classList.add('hidden');
  },

  logout(): void {
    this.closeUserMenu();
    localStorage.removeItem('gnb_admin_token');
    location.reload();
  },

  showApiKey(): void {
    this.closeUserMenu();
    this.authFetch('/api/auth/token')
      .then((r) => r.json())
      .then((data) => {
        const apiToken = data.apiToken || this._cachedApiToken || '';
        Modal.show(`
          <h3 class="text-base font-semibold mb-4">API Token（节点初始化用）</h3>
          <label class="text-xs text-text-secondary block mb-1">API Token（永久有效）</label>
          <div class="flex items-center bg-elevated border border-border-default rounded-lg cursor-pointer hover:border-primary transition group" onclick="navigator.clipboard.writeText('${escHtml(apiToken)}');showToast('已复制')">
            <code class="flex-1 text-sm px-3 py-2.5 font-mono text-text-primary tracking-wide">${escHtml(apiToken)}</code>
            <span class="px-3 text-text-muted group-hover:text-primary">${L('copy')}</span>
          </div>
          <div class="mt-4">
            <div class="text-xs text-text-muted mb-1">节点初始化命令:</div>
            <div class="flex items-center bg-elevated border border-border-default rounded-lg cursor-pointer hover:border-primary transition group" onclick="navigator.clipboard.writeText(this.querySelector('code').textContent.trim());showToast('已复制')">
              <code class="flex-1 text-xs px-3 py-2.5 text-text-primary break-all leading-relaxed">curl -sSL https://${location.host}/api/enroll/init.sh | TOKEN=${escHtml(apiToken)} bash</code>
              <span class="px-3 text-text-muted group-hover:text-primary">${L('copy')}</span>
            </div>
          </div>
          <div class="flex justify-end mt-5">
            <button class="px-4 py-2 text-sm rounded-lg bg-elevated hover:bg-border-default text-text-secondary transition cursor-pointer" onclick="App.closeModal()">关闭</button>
          </div>
        `);
      }).catch(() => {});
  },

  closeModal(): void { Modal.close(); },

  // --- 主题 ---
  getTheme(): string { return localStorage.getItem('gnb_theme') || 'dark'; },

  applyTheme(theme: string): void {
    if (theme === 'light') {
      document.documentElement.classList.remove('dark');
    } else {
      document.documentElement.classList.add('dark');
    }
    const icon = $('#theme-icon');
    const label = $('#theme-label');
    if (icon) icon.setAttribute('data-lucide', theme === 'light' ? 'moon' : 'sun');
    if (label) label.textContent = theme === 'light' ? '深色模式' : '亮色模式';
    refreshIcons();
  },

  toggleTheme(): void {
    const next = this.getTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('gnb_theme', next);
    this.applyTheme(next);
  },

  // --- 初始化 ---
  init(): void {
    $$('.nav-item').forEach((item) => {
      item.addEventListener('click', () => this.switchPage((item as HTMLElement).dataset.page || 'dashboard'));
    });
    $('#sidebar-toggle')?.addEventListener('click', () => this.toggleSidebar());
    document.addEventListener('click', (e) => {
      const menu = $('#user-menu');
      if (menu && !menu.contains(e.target as Node)) this.closeUserMenu();
    });
    this.applyTheme(this.getTheme());
    if (!this.getToken()) {
      this.showLoginPage();
    } else {
      this.hideLoginPage();
      WS.connect();
      this.switchPage('dashboard');
    }
  },
};
