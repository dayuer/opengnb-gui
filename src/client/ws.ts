// @alpha: WebSocket 模块
import { $ } from './utils';

// 前向声明 — 运行时从 window 获取（避免循环依赖）
function getApp(): any { return (window as any).App; }
function getDashboard(): any { return (window as any).Dashboard; }
function getNodes(): any { return (window as any).Nodes; }

interface WSModule {
  ws: WebSocket | null;
  retryDelay: number;
  MAX_RETRY_DELAY: number;
  connect(): void;
}

export const WS: WSModule = {
  ws: null,
  retryDelay: 1000,
  MAX_RETRY_DELAY: 30000,

  connect() {
    const App = getApp();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // @security: token 不通过 URL 参数传递（避免日志泄露），仅通过首条消息认证
    this.ws = new WebSocket(`${proto}//${location.host}/ws`);

    this.ws!.onopen = () => {
      this.retryDelay = 1000;
      const badge = $('#connection-status');
      if (badge) {
        badge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-success/15 text-success';
        badge.textContent = '已连接';
      }
      const authToken = App.getToken();
      if (authToken) this.ws!.send(JSON.stringify({ type: 'auth', token: authToken }));
    };

    this.ws!.onclose = () => {
      const badge = $('#connection-status');
      if (badge) {
        badge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-danger/15 text-danger';
        badge.textContent = '断开';
      }
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 1.5, this.MAX_RETRY_DELAY);
    };

    this.ws!.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'snapshot' || msg.type === 'update') {
          App.nodesData = msg.data || [];
          App.pendingNodes = msg.pending || [];
          App.nodeGroups = msg.groups || App.nodeGroups;
          App.allNodesRaw = msg.allNodes || App.allNodesRaw;
          const updateEl = $('#last-update');
          if (updateEl) updateEl.textContent = new Date(msg.timestamp).toLocaleTimeString();
          // 更新待审批 badge
          const hCount = $('#pending-count');
          const hBadge = $('#pending-badge');
          if (hCount) hCount.textContent = String(App.pendingNodes.length);
          if (hBadge) hBadge.classList.toggle('hidden', App.pendingNodes.length === 0);
          // 刷新当前页面
          const Dashboard = getDashboard();
          const Nodes = getNodes();
          if (App.currentPage === 'dashboard') Dashboard.render($('#main-content'));
          if (App.currentPage === 'nodes') {
            const prevCount = App._prevNodeCount;
            const currCount = (msg.allNodes || App.allNodesRaw || []).length;
            if (prevCount !== undefined && prevCount === currCount) {
              Nodes.updateMetrics();
            } else {
              Nodes.renderSidebar();
              Nodes.renderTable();
              Nodes.renderPagination();
            }
            App._prevNodeCount = currCount;
          }
        }
        if (msg.type === 'chat_history') App.opsLogsCache = msg.logs || {};
        if (msg.type === 'provision_log') {
          // 追加到终端日志
        }
      } catch (_) {}
    };
  },
};
