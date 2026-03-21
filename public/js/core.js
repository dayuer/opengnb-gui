'use strict';
// @alpha: 核心模块 — 认证、路由、主题、全局状态

const App = {
  // --- 全局状态 ---
  nodesData: [],
  pendingNodes: [],
  selectedNodeId: null,
  currentPage: 'dashboard',
  nodeGroups: [],
  allNodesRaw: [],
  nodeFilter: { groupId: null, subnet: '', keyword: '', status: '' },
  selectedIds: new Set(),
  nodePagination: { page: 1, pageSize: 50 },
  opsLogsCache: {},
  _cachedApiToken: '',

  PAGE_TITLES: {
    dashboard: '仪表盘',
    nodes: '节点管理',
    users: '团队设置',
    groups: '分组管理',
    settings: '系统设置',
  },

  // --- 认证 ---
  getToken()  { return localStorage.getItem('gnb_admin_token') || ''; },
  setToken(t) { localStorage.setItem('gnb_admin_token', t); },

  async authFetch(url, options = {}) {
    const token = this.getToken();
    options.headers = { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await fetch(url, options);
    if (res.status === 401) { this.showLoginPage(); throw new Error('认证失败'); }
    return res;
  },

  showLoginPage() {
    const lp = $('#login-page');
    const app = $('#app');
    if (lp) { lp.classList.remove('hidden'); lp.classList.add('flex'); refreshIcons(); }
    if (app) { app.classList.add('hidden'); app.classList.remove('flex'); }
  },

  hideLoginPage() {
    const lp = $('#login-page');
    const app = $('#app');
    if (lp) { lp.classList.add('hidden'); lp.classList.remove('flex'); }
    if (app) { app.classList.remove('hidden'); app.classList.add('flex'); }
  },

  async doLogin(e) {
    if (e) e.preventDefault();
    const username = $('#login-username')?.value?.trim();
    const password = $('#login-password')?.value;
    if (!username || !password) return;
    const errEl = $('#login-error');
    const btn = $('#login-btn');
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
  switchPage(page) {
    this.currentPage = page;
    $$('.nav-item').forEach(item => {
      if (item.dataset.page === page) item.setAttribute('data-active', '');
      else item.removeAttribute('data-active');
    });
    $('#page-title').textContent = this.PAGE_TITLES[page] || page;
    this.renderPage(page);
    refreshIcons();
    // 移动端关闭侧边栏
    this.closeSidebar();
  },

  renderPage(page) {
    const container = $('#main-content');
    switch (page) {
      case 'dashboard': Dashboard.render(container); break;
      case 'nodes':     Nodes.render(container); break;
      case 'users':     Users.render(container); break;
      case 'groups':    Groups.render(container); break;
      case 'settings':  Settings.render(container); break;
      default:
        container.innerHTML = `<div class="flex flex-col items-center justify-center h-64 text-text-muted">
          <span class="text-4xl mb-2">${L('lock')}</span><span>未知页面</span></div>`;
    }
  },

  // --- 侧边栏 ---
  toggleSidebar() {
    const sb = $('#sidebar');
    const bd = $('#sidebar-backdrop');
    if (window.innerWidth <= 768) {
      sb.toggleAttribute('data-open');
      bd.classList.toggle('hidden');
    }
  },

  closeSidebar() {
    const sb = $('#sidebar');
    const bd = $('#sidebar-backdrop');
    sb?.removeAttribute('data-open');
    bd?.classList.add('hidden');
  },

  // --- 用户菜单 ---
  toggleUserMenu() {
    const dd = $('#user-dropdown');
    if (dd) dd.classList.toggle('hidden');
  },

  closeUserMenu() {
    const dd = $('#user-dropdown');
    if (dd) dd.classList.add('hidden');
  },

  logout() {
    this.closeUserMenu();
    localStorage.removeItem('gnb_admin_token');
    location.reload();
  },

  showApiKey() {
    this.closeUserMenu();
    this.authFetch('/api/auth/token')
      .then(r => r.json())
      .then(data => {
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

  closeModal() { Modal.close(); },

  // --- 主题 ---
  getTheme() { return localStorage.getItem('gnb_theme') || 'dark'; },

  applyTheme(theme) {
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

  toggleTheme() {
    const next = this.getTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('gnb_theme', next);
    this.applyTheme(next);
  },

  // --- 初始化 ---
  init() {
    // 导航事件
    $$('.nav-item').forEach(item => {
      item.addEventListener('click', () => this.switchPage(item.dataset.page));
    });
    // 侧边栏折叠
    $('#sidebar-toggle')?.addEventListener('click', () => this.toggleSidebar());
    // 点击外部关闭用户菜单
    document.addEventListener('click', (e) => {
      const menu = $('#user-menu');
      if (menu && !menu.contains(e.target)) this.closeUserMenu();
    });
    // 主题
    this.applyTheme(this.getTheme());
    // 认证检查
    if (!this.getToken()) {
      this.showLoginPage();
    } else {
      this.hideLoginPage();
      WS.connect();
      this.switchPage('dashboard');
    }
  },
};
