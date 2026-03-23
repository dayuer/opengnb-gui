// @alpha: 技能模态框 — 从 skills.ts 提取
// 包含：发布技能模态框 + 安装技能模态框（节点选择）
import { L, refreshIcons, escHtml, showToast, safeAttr } from '../utils';
import { App } from '../core';


/** 技能模态框模块 */
export const SkillModals = {

  // ═══════════════════════════════════════
  // 发布技能模态框
  // ═══════════════════════════════════════

  showPublishModal(container: any, opts: {
    fetchSkills: (container: any) => Promise<void>;
    parseFrontmatter: (content: string) => any;
  }) {
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

    // 动画进入
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
          const meta = opts.parseFrontmatter(fileContent);
          if (meta.name) (overlay.querySelector('#pub-name') as HTMLInputElement).value = meta.name;
          if (meta.description) (overlay.querySelector('#pub-desc') as HTMLTextAreaElement).value = meta.description;
        };
        reader.readAsText(file);
      } else if (file.name.endsWith('.zip')) {
        fileContent = '[zip file]';
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

        await res.json();
        showToast(`技能 "${name}" 发布成功`, 'success');
        closeHandler();

        // 重新加载技能列表
        await opts.fetchSkills(container);
      } catch (err: any) {
        showToast(err.message || '发布失败', 'error');
        submitBtn.removeAttribute('disabled');
        submitBtn.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i> 发布';
        refreshIcons();
      }
    });
  },

  // ═══════════════════════════════════════
  // 安装技能模态框（节点选择）
  // ═══════════════════════════════════════

  async showInstallModal(skill: any, installTypeLabels: Record<string, string>) {
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

      const installInfo = installTypeLabels[skill.installType] || skill.installType;

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

      // 动画进入
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
            // 乐观更新 allNodesRaw
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
