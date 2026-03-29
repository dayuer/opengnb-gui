// @alpha: 前端入口 — ESM 模块聚合 + window 全局挂载
import './styles.css';
import { $, $$, L, refreshIcons, escHtml, showToast, formatBytes, formatUptime, pctColor, pctBg, safeAttr, cidrMatch, ipToInt, isValidCidr } from './utils';
import { App } from './core';
import { WS } from './ws';
import { Modal } from './modal';
import { Dashboard } from './pages/dashboard';
import { Nodes } from './pages/nodes';
import { Users } from './pages/users';
import { Groups } from './pages/groups';
import { Settings } from './pages/settings';
import { Skills } from './pages/skills';


import { NodeDetailPanel } from './components/node-detail-panel';

// --- window 全局挂载（兼容 HTML 内联 onclick 事件） ---
const w = window as any;
w.$ = $;
w.$$ = $$;
w.L = L;
w.refreshIcons = refreshIcons;
w.escHtml = escHtml;
w.showToast = showToast;
w.formatBytes = formatBytes;
w.formatUptime = formatUptime;
w.pctColor = pctColor;
w.pctBg = pctBg;
w.safeAttr = safeAttr;
w.cidrMatch = cidrMatch;
w.ipToInt = ipToInt;
w.isValidCidr = isValidCidr;

w.App = App;
w.WS = WS;
w.Modal = Modal;
w.Dashboard = Dashboard;
w.Nodes = Nodes;
w.Users = Users;
w.Groups = Groups;
w.Settings = Settings;
w.Skills = Skills;

w.NodeDetailPanel = NodeDetailPanel;

// --- 启动 ---
document.addEventListener('DOMContentLoaded', () => {
  // RU3: 注入 mobile 顶部 header（汉堡菜单 + Logo）
  const mobileHeader = document.createElement('div');
  mobileHeader.id = 'mobile-header';
  mobileHeader.innerHTML = `
    <button id="btn-hamburger" aria-label="打开菜单" onclick="App.toggleSidebar()">
      <span></span><span></span><span></span>
    </button>
    <span class="mobile-logo">SynonClaw</span>
  `;
  document.body.insertBefore(mobileHeader, document.body.firstChild);

  // 点击 backdrop 关闭 sidebar
  const backdrop = document.getElementById('sidebar-backdrop');
  backdrop?.addEventListener('click', () => App.closeSidebar());

  App.init();
});
