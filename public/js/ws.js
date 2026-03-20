'use strict';
// @alpha: WebSocket 模块

const WS = {
  ws: null,
  retryDelay: 1000,
  MAX_RETRY_DELAY: 30000,

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = App.getToken();
    this.ws = new WebSocket(`${proto}//${location.host}/ws${token ? '?token=' + encodeURIComponent(token) : ''}`);

    this.ws.onopen = () => {
      this.retryDelay = 1000;
      const badge = $('#connection-status');
      if (badge) {
        badge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-success/15 text-success';
        badge.textContent = '已连接';
      }
      const authToken = App.getToken();
      if (authToken) this.ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    };

    this.ws.onclose = () => {
      const badge = $('#connection-status');
      if (badge) {
        badge.className = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-danger/15 text-danger';
        badge.textContent = '断开';
      }
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 1.5, this.MAX_RETRY_DELAY);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'snapshot' || msg.type === 'update') {
          App.nodesData = msg.data || [];
          App.pendingNodes = msg.pending || [];
          App.nodeGroups = msg.groups || App.nodeGroups;
          App.allNodesRaw = msg.allNodes || App.allNodesRaw;
          $('#last-update').textContent = new Date(msg.timestamp).toLocaleTimeString();
          // 更新待审批 badge
          const hCount = $('#pending-count');
          const hBadge = $('#pending-badge');
          if (hCount) hCount.textContent = App.pendingNodes.length;
          if (hBadge) hBadge.classList.toggle('hidden', App.pendingNodes.length === 0);
          // 刷新当前页面
          if (App.currentPage === 'dashboard') Dashboard.render($('#main-content'));
          if (App.currentPage === 'nodes') {
            Nodes.renderSidebar();
            Nodes.renderTable();
            Nodes.renderPagination();
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
