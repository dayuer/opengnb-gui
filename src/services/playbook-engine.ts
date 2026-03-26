'use strict';

/**
 * Playbook Engine — 多步骤依赖拓扑编排引擎
 *
 * 核心职责:
 * 1. 创建 Playbook（包含有序步骤和依赖关系）
 * 2. 启动执行 — 使用 Kahn 算法拓扑排序，分批分发步骤到 TaskQueue
 * 3. 步骤完成回调 — 更新状态，驱动下一批可执行步骤
 * 4. 取消 / 失败处理
 *
 * 与 TaskQueue 的关系:
 * PlaybookEngine 为每个 step × 每个目标节点创建 AgentTask，
 * 通过 TaskQueue 分发到 Agent 心跳流。
 */

const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');

const log = createLogger('PlaybookEngine');

interface StepDef {
  name: string;
  command: string;
  targetScope?: string; // 'all' | JSON数组
  dependsOn?: string[]; // 前置步骤名称
}

interface PlaybookCreateParams {
  name: string;
  description?: string;
  steps: StepDef[];
  targetNodeIds: string[];
}

class PlaybookEngine extends EventEmitter {
  private _store: any;
  private _taskQueue: any;

  constructor(store: any, taskQueue: any) {
    super();
    this._store = store;
    this._taskQueue = taskQueue;
  }

  /**
   * 创建 Playbook — 持久化到 DB
   */
  create(params: PlaybookCreateParams) {
    const playbookId = randomUUID().replace(/-/g, '').substring(0, 16);
    const now = new Date().toISOString();

    this._store.playbookInsert({
      id: playbookId,
      name: params.name,
      description: params.description || '',
      status: 'pending',
      targetNodeIds: JSON.stringify(params.targetNodeIds),
      createdAt: now,
    });

    // 步骤名到 ID 的映射（用于解析 dependsOn 引用）
    const nameToId = new Map<string, string>();
    const stepIds: string[] = [];

    for (let i = 0; i < params.steps.length; i++) {
      const s = params.steps[i];
      const stepId = randomUUID().replace(/-/g, '').substring(0, 16);
      nameToId.set(s.name, stepId);
      stepIds.push(stepId);
    }

    for (let i = 0; i < params.steps.length; i++) {
      const s = params.steps[i];
      const deps = (s.dependsOn || []).map(name => nameToId.get(name)).filter(Boolean);

      this._store.playbookStepInsert({
        id: stepIds[i],
        playbookId,
        seq: i,
        name: s.name,
        command: s.command,
        targetScope: s.targetScope || 'all',
        dependsOn: JSON.stringify(deps),
        status: 'pending',
      });
    }

    log.info(`Playbook 创建: ${playbookId} "${params.name}" (${params.steps.length} 步骤, ${params.targetNodeIds.length} 节点)`);
    return this.getPlaybookDetail(playbookId);
  }

  /**
   * 启动 Playbook 执行
   */
  start(playbookId: string) {
    const playbook = this._store.playbookFind(playbookId);
    if (!playbook) throw new Error(`Playbook 不存在: ${playbookId}`);
    if (playbook.status !== 'pending') throw new Error(`Playbook 状态非 pending: ${playbook.status}`);

    const now = new Date().toISOString();
    this._store.playbookUpdateStatus({ id: playbookId, status: 'running', startedAt: now, completedAt: null });

    log.info(`Playbook 启动: ${playbookId}`);
    this._dispatchReadySteps(playbookId);
  }

  /**
   * 步骤完成回调 — 外部调用推进状态
   */
  onStepComplete(stepId: string, result: { success: boolean; summary?: string }) {
    const step = this._store.playbookStepFind(stepId);
    if (!step) return;

    const now = new Date().toISOString();
    const newStatus = result.success ? 'completed' : 'failed';

    this._store.playbookStepUpdateStatus({
      id: stepId,
      status: newStatus,
      resultSummary: result.summary || '',
      startedAt: null,
      completedAt: now,
    });

    log.info(`步骤完成: ${stepId} => ${newStatus}`);

    if (!result.success) {
      // 步骤失败 → 整个 Playbook 标记失败
      this._store.playbookUpdateStatus({
        id: step.playbookId,
        status: 'failed',
        startedAt: null,
        completedAt: now,
      });
      this.emit('playbookFailed', { playbookId: step.playbookId, failedStep: stepId });
      log.warn(`Playbook 失败: ${step.playbookId} (步骤 ${stepId} 失败)`);
      return;
    }

    // 检查是否所有步骤完成
    const allSteps = this._store.playbookSteps(step.playbookId);
    const allDone = allSteps.every((s: any) => s.status === 'completed');

    if (allDone) {
      this._store.playbookUpdateStatus({
        id: step.playbookId,
        status: 'completed',
        startedAt: null,
        completedAt: now,
      });
      this.emit('playbookCompleted', { playbookId: step.playbookId });
      log.info(`Playbook 完成: ${step.playbookId}`);
    } else {
      // 分发下一批可执行步骤
      this._dispatchReadySteps(step.playbookId);
    }
  }

  /**
   * 取消 Playbook
   */
  cancel(playbookId: string) {
    const playbook = this._store.playbookFind(playbookId);
    if (!playbook) throw new Error(`Playbook 不存在: ${playbookId}`);
    if (playbook.status !== 'running' && playbook.status !== 'pending') {
      throw new Error(`Playbook 无法取消 (状态: ${playbook.status})`);
    }

    const now = new Date().toISOString();
    this._store.playbookUpdateStatus({ id: playbookId, status: 'cancelled', startedAt: null, completedAt: now });

    // 将所有 pending/running 步骤标记为 cancelled
    const steps = this._store.playbookSteps(playbookId);
    for (const s of steps) {
      if (s.status === 'pending' || s.status === 'running') {
        this._store.playbookStepUpdateStatus({
          id: s.id,
          status: 'cancelled',
          resultSummary: '已取消',
          startedAt: null,
          completedAt: now,
        });
      }
    }

    this.emit('playbookCancelled', { playbookId });
    log.info(`Playbook 取消: ${playbookId}`);
  }

  /**
   * 获取 Playbook 详情（含步骤列表）
   */
  getPlaybookDetail(playbookId: string) {
    const playbook = this._store.playbookFind(playbookId);
    if (!playbook) return null;
    const steps = this._store.playbookSteps(playbookId);
    return { ...playbook, steps };
  }

  /**
   * 列表
   */
  list(limit = 50, offset = 0) {
    return this._store.playbookList(limit, offset);
  }

  /**
   * 删除
   */
  delete(playbookId: string) {
    const playbook = this._store.playbookFind(playbookId);
    if (!playbook) throw new Error(`Playbook 不存在: ${playbookId}`);
    if (playbook.status === 'running') throw new Error('无法删除运行中的 Playbook');
    this._store.playbookDelete(playbookId);
    log.info(`Playbook 删除: ${playbookId}`);
  }

  /**
   * Kahn 算法 — 找出所有依赖已满足的 pending 步骤并分发
   */
  private _dispatchReadySteps(playbookId: string) {
    const allSteps = this._store.playbookSteps(playbookId);
    const completedIds = new Set(allSteps.filter((s: any) => s.status === 'completed').map((s: any) => s.id));
    const playbook = this._store.playbookFind(playbookId);
    const targetNodeIds: string[] = JSON.parse(playbook.targetNodeIds || '[]');

    let dispatched = 0;

    for (const step of allSteps) {
      if (step.status !== 'pending') continue;

      // 检查依赖是否全部 completed
      const deps: string[] = JSON.parse(step.dependsOn || '[]');
      const allDepsCompleted = deps.every((depId: string) => completedIds.has(depId));
      if (!allDepsCompleted) continue;

      // 标记为 running
      const now = new Date().toISOString();
      this._store.playbookStepUpdateStatus({
        id: step.id,
        status: 'running',
        resultSummary: null,
        startedAt: now,
        completedAt: null,
      });

      // 分发到目标节点的 TaskQueue
      const scope = step.targetScope === 'all' ? targetNodeIds : JSON.parse(step.targetScope || '[]');
      for (const nodeId of scope) {
        if (this._taskQueue) {
          this._taskQueue.enqueueTask({
            nodeId,
            type: 'playbook',
            command: step.command,
            skillId: `pb:${playbookId}`,
            skillName: step.name,
          });
        }
      }

      dispatched++;
      log.info(`步骤分发: ${step.id} "${step.name}" → ${scope.length} 节点`);
    }

    if (dispatched === 0) {
      // 没有可分发的步骤 — 可能有环或全部完成/失败
      const pending = allSteps.filter((s: any) => s.status === 'pending');
      if (pending.length > 0) {
        log.warn(`Playbook ${playbookId}: ${pending.length} 个 pending 步骤无法分发（依赖环？）`);
      }
    }
  }
}

module.exports = { PlaybookEngine };
export {}; // CJS 模块标记
