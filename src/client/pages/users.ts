// @alpha: users 页面模块 (TS 迁移 — Alpha pass)
import { $, $$, L, refreshIcons, escHtml, showToast, formatBytes, formatUptime, pctColor, pctBg, safeAttr, cidrMatch, isValidCidr } from '../utils';
import { Modal } from '../modal';


// @alpha: 团队设置 — Stitch "Team Settings" 风格 (水平标签: 成员/角色/团队/邀请)
// @alpha: _cachedUsers 缓存 + _renderSeq 渲染锁 — 消除 Tab 切换 429

let teamTab = 'members';
let _cachedUsers = null;
let _renderSeq = 0;

function switchTeamTab(tab) {
  if (tab === teamTab) return;
  teamTab = tab;
  if (_cachedUsers !== null) {
    Users._renderContent($('#main-content'), _cachedUsers);
  } else {
    Users.render($('#main-content'));
  }
}

export const Users = {
  async render(container) {
    const seq = ++_renderSeq;
    const usersRes = await App.authFetch('/api/auth/users').catch(() => null);
    if (seq !== _renderSeq) return; // 被更新的调用取代
    const users = usersRes ? await usersRes.json() : [];
    _cachedUsers = users;
    this._renderContent(container, users);
  },

  _renderContent(container, users) {

    const tabs = [
      { id: 'members', icon: 'users', label: '团队成员' },
      { id: 'roles', icon: 'shield', label: '角色权限' },
      { id: 'profile', icon: 'building', label: '团队信息' },
      { id: 'invitations', icon: 'mail', label: '邀请管理' },
    ];

    container.innerHTML = `<div class="space-y-8">
      <!-- 页面标题 -->
      <div class="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 class="text-3xl font-extrabold tracking-tight font-headline mb-2">团队设置</h1>
          <p class="text-text-muted max-w-lg leading-relaxed">管理团队成员、角色权限和组织信息。</p>
        </div>
        <button class="px-5 py-2.5 signature-gradient text-white rounded-xl font-bold text-sm shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all flex items-center gap-2 cursor-pointer [&_svg]:w-4 [&_svg]:h-4" onclick="Users.showCreateModal()">
          ${L('user-plus')}<span>邀请成员</span>
        </button>
      </div>

      <!-- 水平标签栏 -->
      <div class="bg-surface rounded-xl shadow-ambient border border-border-default overflow-hidden">
        <div class="flex items-center overflow-x-auto border-b border-border-subtle px-2">
          ${tabs.map(t => {
            const active = teamTab === t.id;
            return `<button class="flex items-center gap-2 px-5 py-4 text-sm whitespace-nowrap transition-all cursor-pointer relative ${active ? 'text-primary font-bold' : 'text-text-muted hover:text-text-primary'} [&_svg]:w-4 [&_svg]:h-4" onclick="switchTeamTab('${t.id}')">
              ${L(t.icon)}<span>${t.label}</span>
              ${active ? `<div class="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 w-3/4 signature-gradient rounded-full"></div>` : ''}
            </button>`;
          }).join('')}
        </div>

        <!-- 内容区 -->
        <div class="p-8">
          ${teamTab === 'members' ? this._membersSection(users) : ''}
          ${teamTab === 'roles' ? this._rolesSection(users) : ''}
          ${teamTab === 'profile' ? this._profileSection() : ''}
          ${teamTab === 'invitations' ? this._invitationsSection() : ''}
        </div>
      </div>
    </div>`;
    refreshIcons();
  },
  // ---- 以下为 _renderContent 的闭合，实际内容区在上方 ----

  // ── 团队成员 ──
  _membersSection(users) {
    const admins = users.filter(u => u.role === 'admin').length;
    const members = users.length - admins;
    return `<div class="space-y-8">
      <div class="flex flex-col md:flex-row md:items-start justify-between gap-6">
        <div>
          <h2 class="text-xl font-bold font-headline mb-1">成员列表</h2>
          <p class="text-sm text-text-muted">管理团队中的所有成员和角色分配。</p>
        </div>
        <div class="flex items-center gap-3">
          ${this._statPill('users', '总计', users.length, 'primary')}
          ${this._statPill('shield', '管理员', admins, 'success')}
          ${this._statPill('user', '成员', members, '')}
        </div>
      </div>

      <!-- 成员列表 -->
      <div class="space-y-3">
        ${users.map(u => {
          const initials = (u.username || '?').slice(0, 2).toUpperCase();
          const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—';
          const isAdmin = u.role === 'admin';
          const isOwner = u.username === 'admin';
          return `<div class="bg-elevated rounded-xl border border-border-default p-5 flex items-center justify-between hover:shadow-sm transition-shadow group">
            <div class="flex items-center gap-4">
              <div class="w-11 h-11 rounded-xl ${isOwner ? 'signature-gradient text-white shadow-lg shadow-primary/20' : isAdmin ? 'bg-primary/10 text-primary' : 'bg-elevated text-text-secondary border border-border-default'} flex items-center justify-center font-bold text-sm">${initials}</div>
              <div>
                <div class="flex items-center gap-2">
                  <span class="font-bold font-headline">${escHtml(u.username)}</span>
                  ${isOwner ? `<span class="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white bg-primary rounded-full">Owner</span>` : ''}
                </div>
                <div class="text-xs text-text-muted mt-0.5">ID: ${escHtml(u.id?.slice(0, 8) || '—')} · 加入于 ${created}</div>
              </div>
            </div>
            <div class="flex items-center gap-3">
              ${isOwner ? `<span class="px-3 py-1 bg-secondary-container text-success rounded-full text-xs font-bold flex items-center gap-1.5">
                <span class="w-1.5 h-1.5 rounded-full bg-success"></span>admin
              </span>` : `<select class="px-3 py-1.5 ${isAdmin ? 'bg-secondary-container text-success' : 'bg-elevated text-text-secondary border border-border-default'} rounded-full text-xs font-bold cursor-pointer outline-none appearance-none pr-6 bg-no-repeat bg-right" style="background-image: url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22currentColor%22 stroke-width=%222%22><polyline points=%226 9 12 15 18 9%22/></svg>'); background-position: right 8px center;" onchange="Users.changeRole('${safeAttr(u.id)}', this.value)">
                <option value="admin" ${isAdmin ? 'selected' : ''}>admin</option>
                <option value="member" ${!isAdmin ? 'selected' : ''}>member</option>
              </select>`}
              <span class="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-success bg-success/10 rounded-full">Active</span>
              ${!isOwner ? `<button class="p-2 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 transition cursor-pointer opacity-0 group-hover:opacity-100 [&_svg]:w-4 [&_svg]:h-4" onclick="Users.deleteUser('${safeAttr(u.id)}','${safeAttr(u.username)}')" title="移除成员">${L('trash-2')}</button>` : ''}
            </div>
          </div>`;
        }).join('')}
        ${users.length === 0 ? `<div class="text-center py-16 text-text-muted"><p class="text-sm">暂无团队成员</p></div>` : ''}
      </div>
    </div>`;
  },

  _statPill(icon, label, count, color) {
    return `<div class="flex items-center gap-2 px-4 py-2 bg-elevated rounded-xl border border-border-default">
      <span class="[&_svg]:w-4 [&_svg]:h-4 ${color ? `text-${color}` : 'text-text-muted'}">${L(icon)}</span>
      <div>
        <div class="text-lg font-extrabold font-headline ${color ? `text-${color}` : ''}">${count}</div>
        <div class="text-[10px] font-bold uppercase tracking-widest text-text-muted">${label}</div>
      </div>
    </div>`;
  },

  // ── 角色权限 ──
  _rolesSection(users) {
    const roles = [
      { name: 'Owner', icon: 'crown', desc: '团队所有者，拥有全部权限，可管理计费和团队设置', color: 'primary', perms: ['全部系统权限', '管理团队成员', '管理计费和订阅', '删除团队'] },
      { name: 'Admin', icon: 'shield', desc: '管理员，可管理节点、用户和分组', color: 'success', perms: ['管理节点和分组', '创建和删除用户', '查看和修改系统设置', '查看监控数据'] },
      { name: 'Member', icon: 'user', desc: '普通成员，可查看数据但无管理权限', color: 'warning', perms: ['查看节点状态', '查看监控数据', '查看分组信息', '修改个人密码'] },
    ];
    return `<div class="space-y-8">
      <div>
        <h2 class="text-xl font-bold font-headline mb-1">角色与权限</h2>
        <p class="text-sm text-text-muted">定义团队中不同角色的访问权限。</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        ${roles.map(r => `<div class="bg-elevated rounded-xl border border-border-default p-6 space-y-4 hover:shadow-sm transition-shadow">
          <div class="flex items-center gap-3">
            <div class="h-11 w-11 bg-${r.color}/10 rounded-xl flex items-center justify-center text-${r.color} [&_svg]:w-5 [&_svg]:h-5">${L(r.icon)}</div>
            <div>
              <h3 class="text-sm font-bold font-headline">${r.name}</h3>
              <p class="text-[10px] font-bold uppercase tracking-widest text-text-muted">${users.filter(u => r.name === 'Owner' ? u.username === 'admin' : r.name === 'Admin' ? (u.role === 'admin' && u.username !== 'admin') : u.role !== 'admin').length} 人</p>
            </div>
          </div>
          <p class="text-xs text-text-muted leading-relaxed">${r.desc}</p>
          <div class="border-t border-border-subtle pt-4 space-y-2">
            ${r.perms.map(p => `<div class="flex items-center gap-2 text-xs">
              <span class="w-1.5 h-1.5 rounded-full bg-${r.color}"></span>
              <span class="text-text-secondary">${p}</span>
            </div>`).join('')}
          </div>
        </div>`).join('')}
      </div>
    </div>`;
  },

  // ── 团队信息 ──
  _profileSection() {
    return `<div class="space-y-8">
      <div>
        <h2 class="text-xl font-bold font-headline mb-1">团队信息</h2>
        <p class="text-sm text-text-muted">编辑团队基本资料和配置。</p>
      </div>

      <div class="border-t border-border-subtle pt-8">
        <h3 class="text-sm font-bold uppercase tracking-widest text-text-muted mb-6">基本资料</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="space-y-2">
            <label class="block text-sm font-medium">团队名称</label>
            <input class="w-full px-4 py-3 bg-elevated border border-border-default rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" value="SynonClaw Team" placeholder="输入团队名称">
            <p class="text-xs text-text-muted">将显示在控制台标题和通知中</p>
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-medium">团队 ID</label>
            <input class="w-full px-4 py-3 bg-elevated border border-border-default rounded-xl text-sm outline-none font-mono" value="team_synonclaw" readonly>
            <p class="text-xs text-text-muted">唯一标识符，不可修改</p>
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-medium">管理员邮箱</label>
            <input class="w-full px-4 py-3 bg-elevated border border-border-default rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" placeholder="admin@example.com" type="email">
            <p class="text-xs text-text-muted">用于接收系统告警和通知</p>
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-medium">地区</label>
            <input class="w-full px-4 py-3 bg-elevated border border-border-default rounded-xl text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" value="Asia Pacific" placeholder="团队所在地区">
            <p class="text-xs text-text-muted">影响默认节点区域分配</p>
          </div>
        </div>
      </div>

      <div class="border-t border-border-subtle pt-8">
        <h3 class="text-sm font-bold uppercase tracking-widest text-text-muted mb-6">安全配置</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="bg-elevated rounded-xl border border-border-default p-5 flex items-center justify-between hover:shadow-sm transition-shadow">
            <div class="flex items-center gap-4">
              <div class="h-11 w-11 bg-primary/10 rounded-xl flex items-center justify-center text-primary [&_svg]:w-5 [&_svg]:h-5">${L('check-circle')}</div>
              <div>
                <h4 class="text-sm font-bold">JWT 认证</h4>
                <p class="text-xs text-text-muted mt-0.5">基于 SSH 密钥哈希生成</p>
              </div>
            </div>
            <span class="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-success bg-success/10 rounded-full">已启用</span>
          </div>
          <div class="bg-elevated rounded-xl border border-border-default p-5 flex items-center justify-between hover:shadow-sm transition-shadow">
            <div class="flex items-center gap-4">
              <div class="h-11 w-11 bg-success/10 rounded-xl flex items-center justify-center text-success [&_svg]:w-5 [&_svg]:h-5">${L('lock')}</div>
              <div>
                <h4 class="text-sm font-bold">bcrypt 密码加密</h4>
                <p class="text-xs text-text-muted mt-0.5">哈希存储，不可逆加密</p>
              </div>
            </div>
            <span class="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-success bg-success/10 rounded-full">已启用</span>
          </div>
        </div>
      </div>

      <div class="flex justify-end pt-4">
        <button class="px-8 py-3 text-sm font-bold signature-gradient text-white rounded-xl shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all cursor-pointer" onclick="showToast('团队信息已保存')">保存设置</button>
      </div>
    </div>`;
  },

  // ── 邀请管理 ──
  _invitationsSection() {
    return `<div class="space-y-8">
      <div>
        <h2 class="text-xl font-bold font-headline mb-1">邀请管理</h2>
        <p class="text-sm text-text-muted">管理团队邀请链接和待处理邀请。</p>
      </div>

      <!-- 邀请链接 -->
      <div class="border-t border-border-subtle pt-8">
        <h3 class="text-sm font-bold uppercase tracking-widest text-text-muted mb-6">邀请链接</h3>
        <div class="bg-elevated rounded-xl border border-border-default p-5 space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="h-10 w-10 signature-gradient rounded-xl flex items-center justify-center text-white [&_svg]:w-4 [&_svg]:h-4 shadow-lg shadow-primary/20">${L('link')}</div>
              <div>
                <h4 class="text-sm font-bold font-headline">团队邀请链接</h4>
                <p class="text-xs text-text-muted">分享此链接以邀请新成员加入团队</p>
              </div>
            </div>
            <button class="px-3 py-1.5 text-xs font-bold text-primary bg-primary/10 rounded-lg hover:bg-primary/20 transition cursor-pointer flex items-center gap-1 [&_svg]:w-3.5 [&_svg]:h-3.5" onclick="navigator.clipboard.writeText('${location.origin}/invite/team_synonclaw');showToast('已复制邀请链接')">${L('copy')} 复制</button>
          </div>
          <pre class="px-4 py-3 bg-base rounded-lg text-xs font-mono text-text-secondary overflow-x-auto border border-border-subtle">${location.origin}/invite/team_synonclaw</pre>
        </div>
      </div>

      <!-- 空状态 -->
      <div class="border-t border-border-subtle pt-8">
        <h3 class="text-sm font-bold uppercase tracking-widest text-text-muted mb-6">待处理邀请</h3>
        <div class="bg-elevated rounded-xl border border-border-default p-12 text-center">
          <div class="flex justify-center mb-4 [&_svg]:w-12 [&_svg]:h-12 text-text-muted/30">${L('inbox')}</div>
          <p class="text-sm font-bold font-headline text-text-secondary mb-1">暂无待处理邀请</p>
          <p class="text-xs text-text-muted">点击页面顶部「邀请成员」创建新的团队成员。</p>
        </div>
      </div>
    </div>`;
  },

  showCreateModal() {
    Modal.show(`
      <h3 class="text-lg font-bold font-headline mb-6">邀请团队成员</h3>
      <div class="space-y-4">
        <div class="space-y-2">
          <label class="block text-sm font-medium">用户名</label>
          <input type="text" id="new-username" placeholder="输入用户名" autofocus class="w-full bg-elevated border border-border-default rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all">
        </div>
        <div class="space-y-2">
          <label class="block text-sm font-medium">初始密码（至少 8 位）</label>
          <input type="password" id="new-password" placeholder="输入密码" class="w-full bg-elevated border border-border-default rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all">
        </div>
        <div class="space-y-2">
          <label class="block text-sm font-medium">角色权限</label>
          <select id="new-role" class="w-full bg-elevated border border-border-default rounded-xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all cursor-pointer">
            <option value="member">Member — 普通成员（只读权限）</option>
            <option value="admin">Admin — 管理员（管理权限）</option>
          </select>
          <p class="text-xs text-text-muted">成员加入后也可在成员列表中修改角色</p>
        </div>
        <div id="create-user-error" class="hidden text-danger text-xs"></div>
      </div>
      <div class="flex justify-end gap-3 mt-6">
        <button class="px-5 py-2.5 text-sm font-semibold text-text-muted hover:bg-elevated rounded-xl transition cursor-pointer" onclick="App.closeModal()">取消</button>
        <button class="px-6 py-2.5 text-sm font-bold signature-gradient text-white rounded-xl shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all cursor-pointer" onclick="Users.createUser()">邀请</button>
      </div>
    `);
  },

  async createUser() {
    const username = $('#new-username')?.value?.trim();
    const password = $('#new-password')?.value;
    const role = $('#new-role')?.value || 'member';
    const errEl = $('#create-user-error');
    if (!username || !password) return;
    try {
      const res = await App.authFetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, role }) });
      const data = await res.json();
      if (!res.ok) { if (errEl) { errEl.textContent = data.error || '邀请失败'; errEl.classList.remove('hidden'); } return; }
      App.closeModal();
      _cachedUsers = null;
      await Users.render($('#main-content'));
    } catch (e) { if (errEl) { errEl.textContent = e.message; errEl.classList.remove('hidden'); } }
  },

  async changeRole(id, newRole) {
    try {
      const res = await App.authFetch(`/api/auth/users/${encodeURIComponent(id)}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
      if (!res.ok) { const data = await res.json(); showToast(data.error || '角色修改失败', 'danger'); return; }
      showToast(`角色已更新为 ${newRole}`);
      _cachedUsers = null;
      await Users.render($('#main-content'));
    } catch (e) { showToast(`角色修改失败: ${e.message}`, 'danger'); }
  },

  async deleteUser(id, username) {
    if (!confirm(`确认移除团队成员 "${username}"？`)) return;
    try {
      const res = await App.authFetch(`/api/auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 400) { const data = await res.json(); alert(data.error || '移除失败'); return; }
      _cachedUsers = null;
      await Users.render($('#main-content'));
    } catch (e) { alert(`移除失败: ${e.message}`); }
  },
};
