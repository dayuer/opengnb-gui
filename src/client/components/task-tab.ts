/**
 * task-tab.ts — 任务队列组件
 *
 * 职责：任务列表加载/轮询/重试/删除 + 独立 Tab 和概览面板内的任务列队 UI
 */
import { L, refreshIcons, escHtml, showToast, safeAttr } from '../utils';
import { App } from '../core';
import { findNodeAny } from './panel-helpers';

// ——— 任务 Tab（独立全屏 Tab） ———

/** 任务类型 → 中文映射 */
function taskTypeLabel(type: string): string {
  const map: Record<string, string> = {
    skill_install: '安装技能',
    skill_uninstall: '卸载技能',
    claw_restart: '重启 OpenClaw',
    claw_upgrade: '更新 OpenClaw',
    exec_cmd: '执行命令',
  };
  return map[type] || type;
}

/** 任务类型 → 图标 */
function taskTypeIcon(type: string): string {
  const map: Record<string, string> = {
    skill_install: 'download',
    skill_uninstall: 'trash-2',
    claw_restart: 'refresh-cw',
    claw_upgrade: 'arrow-up-circle',
    exec_cmd: 'terminal',
  };
  return map[type] || 'circle';
}

/** 状态 → 徽章样式 */
function taskStatusBadge(status: string): string {
  const styles: Record<string, [string, string]> = {
    queued:     ['bg-text-muted/10 text-text-muted', '等待中'],
    dispatched: ['bg-info/10 text-info', '执行中'],
    completed:  ['bg-success/10 text-success', '成功'],
    failed:     ['bg-danger/10 text-danger', '失败'],
    timeout:    ['bg-warning/10 text-warning', '超时'],
  };
  const [cls, label] = styles[status] || ['bg-text-muted/10 text-text-muted', status];
  return `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${cls}">${label}</span>`;
}

/** 相对时间格式化 */
function relativeTime(iso: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

export async function loadTasksTab(nodeId: string) {
  const container = document.getElementById(`inline-tab-content-${nodeId}`);
  if (!container) return;
  const nid = safeAttr(nodeId);

  container.innerHTML = `
  <div class="px-6 pb-8 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
    <div class="flex items-center justify-between mb-6 border-b border-border-default/20 pb-4">
      <h4 class="text-xl font-headline font-bold tracking-tight text-text-primary flex items-center gap-2">
        <span class="[&_svg]:w-5 [&_svg]:h-5 text-primary">${L('list-todo')}</span> 任务队列
      </h4>
      <button class="px-4 py-1.5 rounded-full bg-primary/10 text-primary hover:bg-primary hover:text-white text-xs font-bold uppercase tracking-wider flex items-center gap-2 transition-all cursor-pointer" onclick="NodeDetailPanel.loadTasksTab('${nid}')">
        <span class="[&_svg]:w-3.5 [&_svg]:h-3.5">${L('refresh-cw')}</span> 刷新
      </button>
    </div>
    <div id="tasks-content-${nid}" class="space-y-3">
      <div class="flex items-center gap-2 text-text-muted text-sm py-8 justify-center">
        <span class="[&_svg]:w-4 [&_svg]:h-4 animate-spin">${L('loader-2')}</span> 加载任务列表…
      </div>
    </div>
  </div>`;
  refreshIcons();

  const content = document.getElementById(`tasks-content-${nid}`);
  if (!content) return;

  try {
    const res = await App.authFetch(`/api/nodes/${encodeURIComponent(nodeId)}/tasks`);
    const data = await res.json();
    const tasks: any[] = data.tasks || [];

    if (tasks.length === 0) {
      content.innerHTML = `<div class="text-center text-text-muted text-sm py-8">${L('inbox')} 暂无任务记录</div>`;
      refreshIcons();
      return;
    }

    let html = '';
    for (const task of tasks) {
      const icon = taskTypeIcon(task.type);
      const typeText = taskTypeLabel(task.type);
      const badge = taskStatusBadge(task.status);
      const time = relativeTime(task.completedAt || task.dispatchedAt || task.queuedAt);
      const hasResult = task.result && (task.result.stdout || task.result.stderr);
      const canDelete = task.status !== 'dispatched';

      html += `
      <div class="bg-elevated/40 border border-border-default/20 rounded-xl p-4 space-y-2">
        <div class="flex items-center gap-3">
          <span class="[&_svg]:w-4 [&_svg]:h-4 text-text-muted ${task.status === 'dispatched' ? 'animate-spin' : ''}">${L(icon)}</span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-semibold text-text-primary">${escHtml(typeText)}</span>
              ${badge}
              <span class="text-[10px] text-text-muted">${time}</span>
            </div>
            <p class="text-xs text-text-muted font-mono mt-1 truncate">${escHtml(task.command || task.skillName || task.skillId || '')}</p>
          </div>
          <div class="flex items-center gap-1.5">`;

      if (hasResult) {
        html += `<button onclick="document.getElementById('task-result-${task.taskId}')?.classList.toggle('hidden')"
          class="text-[10px] px-2 py-0.5 rounded bg-elevated text-text-muted hover:text-text-primary transition cursor-pointer">详情</button>`;
      }
      if (canDelete) {
        html += `<button onclick="NodeDetailPanel._deleteTask('${nid}','${safeAttr(task.taskId)}')"
          class="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition cursor-pointer">删除</button>`;
      }
      if (task.status === 'dispatched') {
        html += `<span class="text-[10px] text-info animate-pulse">执行中…</span>`;
      }

      html += `</div></div>`;

      if (hasResult) {
        html += `<div id="task-result-${task.taskId}" class="hidden ml-7 px-3 py-2 rounded bg-base border border-border-subtle text-[11px] font-mono text-text-secondary whitespace-pre-wrap break-all max-h-32 overflow-auto">${escHtml((task.result.stdout || '') + (task.result.stderr ? '\n--- stderr ---\n' + task.result.stderr : ''))}</div>`;
      }

      html += `</div>`;
    }

    content.innerHTML = html;
  } catch {
    content.innerHTML = `<div class="text-danger text-sm py-4">加载任务列表失败</div>`;
  }
  refreshIcons();
}

export async function deleteTask(nodeId: string, taskId: string) {
  try {
    const resp = await App.authFetch(`/api/nodes/${encodeURIComponent(nodeId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
    if (resp.ok) {
      showToast('任务已删除', 'success');
      loadTasksTab(nodeId);
    } else {
      const data = await resp.json();
      showToast(data.error || '删除失败', 'error');
    }
  } catch (e: any) {
    showToast('删除失败: ' + e.message, 'error');
  }
}

// ——— 概览面板内的任务队列（嵌入式） ———

const _taskPollTimers = new Map<string, number>();

export async function loadTaskQueue(nodeId: string) {
  const wrap = document.getElementById(`task-queue-${nodeId}`);
  if (!wrap) return;

  try {
    const res = await App.authFetch(`/api/nodes/${nodeId}/tasks`);
    if (!res.ok) { wrap.innerHTML = ''; return; }
    const { tasks } = await res.json();

    if (!tasks || tasks.length === 0) {
      wrap.innerHTML = '';
      stopTaskPoll(nodeId);
      return;
    }

    const statusMap: Record<string, { label: string; color: string; icon: string }> = {
      queued:     { label: '等待下发', color: 'text-amber-400',   icon: 'clock' },
      dispatched: { label: '执行中',   color: 'text-blue-400',    icon: 'loader-2' },
      completed:  { label: '已完成',   color: 'text-emerald-400', icon: 'check-circle' },
      failed:     { label: '失败',     color: 'text-red-400',     icon: 'x-circle' },
      timeout:    { label: '超时',     color: 'text-orange-400',  icon: 'alert-triangle' },
    };

    let html = `
    <div class="px-6 pb-6 pt-4 bg-surface/30 rounded-xl border border-border-default/20">
      <div class="flex items-center justify-between mb-4 border-b border-border-default/20 pb-3">
        <h4 class="text-lg font-headline font-bold tracking-tight text-text-primary flex items-center gap-2">
          <span class="[&_svg]:w-4 [&_svg]:h-4">${L('list-todo')}</span>
          任务队列
          <span class="text-xs font-normal text-text-muted">(${tasks.length})</span>
        </h4>
      </div>
      <div class="space-y-3">`;

    let hasPending = false;
    for (const task of tasks) {
      const st = statusMap[task.status] || statusMap.queued;
      if (task.status === 'queued' || task.status === 'dispatched') hasPending = true;
      const timeStr = task.completedAt
        ? new Date(task.completedAt).toLocaleTimeString()
        : task.dispatchedAt
          ? new Date(task.dispatchedAt).toLocaleTimeString()
          : new Date(task.queuedAt).toLocaleTimeString();
      const typeLabel = task.type === 'skill_install' ? '安装' : task.type === 'skill_uninstall' ? '卸载' : task.type;
      const animClass = task.status === 'dispatched' ? ' animate-spin' : '';

      let actionBtns = '';
      const canRetry = (task.status === 'failed' || task.status === 'completed') && task.type === 'skill_install' && task.skillId;
      const canDelete = task.status !== 'dispatched';
      if (canRetry || canDelete) {
        actionBtns = `<div class="flex items-center gap-1 mt-1">`;
        if (canRetry) {
          actionBtns += `<button onclick="Nodes.reinstallTask('${nodeId}','${safeAttr(task.skillId)}','${safeAttr(task.skillName || task.skillId)}')" class="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors duration-150" title="重新安装">重试</button>`;
        }
        if (canDelete) {
          actionBtns += `<button onclick="Nodes.deleteTask('${nodeId}','${task.taskId}')" class="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors duration-150" title="删除任务">删除</button>`;
        }
        actionBtns += `</div>`;
      }

      html += `
        <div class="flex items-center gap-3 px-4 py-3 rounded-lg bg-elevated/40 border border-border-default/20">
          <span class="[&_svg]:w-4 [&_svg]:h-4 ${st.color}${animClass}">${L(st.icon)}</span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-xs font-mono px-1.5 py-0.5 rounded bg-surface text-text-muted">${typeLabel}</span>
              <span class="text-sm text-text-primary font-medium truncate">${escHtml(task.skillName || task.skillId || '')}</span>
            </div>
            <p class="text-[10px] text-text-muted font-mono mt-1 truncate">${escHtml(task.command || '')}</p>
          </div>
          <div class="text-right shrink-0">
            <span class="text-xs font-medium ${st.color}">${st.label}</span>
            <p class="text-[10px] text-text-muted mt-0.5">${timeStr}</p>
            ${actionBtns}
          </div>
        </div>`;

      if (task.status === 'failed' && task.result?.stderr) {
        html += `
        <div class="ml-7 px-3 py-2 rounded bg-red-500/5 border border-red-500/10 text-[11px] font-mono text-red-300 whitespace-pre-wrap break-all max-h-20 overflow-auto">${escHtml(task.result.stderr.slice(0, 500))}</div>`;
      }
    }

    html += `</div></div>`;
    wrap.innerHTML = html;
    refreshIcons();

    if (hasPending) startTaskPoll(nodeId);
    else stopTaskPoll(nodeId);
  } catch {
    wrap.innerHTML = '';
  }
}

export async function reinstallTask(nodeId: string, skillId: string, skillName: string) {
  try {
    const res = await App.authFetch(`/api/nodes/${nodeId}/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId, source: 'openclaw', name: skillName }),
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`重新安装已入队: ${skillName}`, 'success');
    } else {
      showToast(data.error || '重新安装失败', 'error');
    }
    loadTaskQueue(nodeId);
  } catch (e: any) {
    showToast('重新安装失败: ' + e.message, 'error');
  }
}

function startTaskPoll(nodeId: string) {
  if (_taskPollTimers.has(nodeId)) return;
  const timer = window.setInterval(() => {
    if (!document.getElementById(`task-queue-${nodeId}`)) {
      stopTaskPoll(nodeId);
      return;
    }
    loadTaskQueue(nodeId);
  }, 10000);
  _taskPollTimers.set(nodeId, timer);
}

export function stopTaskPoll(nodeId: string) {
  const timer = _taskPollTimers.get(nodeId);
  if (timer) {
    clearInterval(timer);
    _taskPollTimers.delete(nodeId);
  }
}

// ——— 技能操作（与任务系统紧密耦合） ———

export async function uninstallSkill(nodeId: string, skillId: string) {
  if (!confirm(`确认要卸载技能 ${skillId} 吗？`)) return;
  try {
    await App.authFetch(`/api/nodes/${nodeId}/skills/${skillId}`, { method: 'DELETE' });
    showToast('技能卸载命令已下发', 'success');
    const node = findNodeAny(nodeId);
    // 需要通过主面板重新加载技能 Tab，这里通过全局调用
    (window as any).NodeDetailPanel?.loadSkillsTab?.(node);
  } catch (e: any) {
    console.error(e);
    showToast(e.message || '技能卸载失败', 'error');
  }
}

export async function deleteSkillFromStore(nodeId: string, storeSkillId: string, skillName: string) {
  if (!confirm(`确认要从技能商店删除「${skillName}」吗？\n此操作不会从节点卸载，但会将该技能从商店移除。`)) return;
  try {
    const res = await App.authFetch(`/api/skills/${encodeURIComponent(storeSkillId)}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        showToast('内置技能不可从商店删除', 'info');
        return;
      }
      showToast(data.error || '删除失败', 'error');
      return;
    }
    showToast(`「${skillName}」已从商店删除`, 'success');
    const node = findNodeAny(nodeId);
    (window as any).NodeDetailPanel?.loadSkillsTab?.(node);
  } catch (e: any) {
    showToast(e.message || '删除失败', 'error');
  }
}
