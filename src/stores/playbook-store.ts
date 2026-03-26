'use strict';

/**
 * Playbook 持久化 — NodeStore 的子模块
 *
 * 管理 playbooks + playbook_steps 两张表的 CRUD 操作。
 * 遵循 mixin 模式（prepareStatements + methods → Object.assign 到 NodeStore）。
 */

/** 准备 Playbook 相关的预编译语句 */
function preparePlaybookStatements(db: any) {
  return {
    // Playbook CRUD
    insertPlaybook: db.prepare(
      `INSERT INTO playbooks (id, name, description, status, targetNodeIds, createdAt)
       VALUES (@id, @name, @description, @status, @targetNodeIds, @createdAt)`
    ),
    findPlaybook: db.prepare('SELECT * FROM playbooks WHERE id = ?'),
    listPlaybooks: db.prepare('SELECT * FROM playbooks ORDER BY createdAt DESC LIMIT ? OFFSET ?'),
    updatePlaybookStatus: db.prepare(
      `UPDATE playbooks SET status = @status, startedAt = COALESCE(@startedAt, startedAt),
       completedAt = COALESCE(@completedAt, completedAt) WHERE id = @id`
    ),
    deletePlaybook: db.prepare('DELETE FROM playbooks WHERE id = ?'),

    // Playbook Steps CRUD
    insertStep: db.prepare(
      `INSERT INTO playbook_steps (id, playbookId, seq, name, command, targetScope, dependsOn, status)
       VALUES (@id, @playbookId, @seq, @name, @command, @targetScope, @dependsOn, @status)`
    ),
    findStep: db.prepare('SELECT * FROM playbook_steps WHERE id = ?'),
    stepsByPlaybook: db.prepare(
      'SELECT * FROM playbook_steps WHERE playbookId = ? ORDER BY seq ASC'
    ),
    updateStepStatus: db.prepare(
      `UPDATE playbook_steps SET status = @status, resultSummary = COALESCE(@resultSummary, resultSummary),
       startedAt = COALESCE(@startedAt, startedAt), completedAt = COALESCE(@completedAt, completedAt)
       WHERE id = @id`
    ),
    pendingStepsByPlaybook: db.prepare(
      `SELECT * FROM playbook_steps WHERE playbookId = ? AND status = 'pending' ORDER BY seq ASC`
    ),
    deleteStepsByPlaybook: db.prepare('DELETE FROM playbook_steps WHERE playbookId = ?'),
  };
}

/** 混入 NodeStore 的方法：Playbook CRUD */
const playbookMethods = {
  playbookInsert(playbook: any) {
    return this._stmts.insertPlaybook.run(playbook);
  },
  playbookFind(id: string) {
    return this._stmts.findPlaybook.get(id);
  },
  playbookList(limit = 50, offset = 0) {
    return this._stmts.listPlaybooks.all(limit, offset);
  },
  playbookUpdateStatus(params: any) {
    return this._stmts.updatePlaybookStatus.run(params);
  },
  playbookDelete(id: string) {
    // 级联删除 steps
    this._stmts.deleteStepsByPlaybook.run(id);
    return this._stmts.deletePlaybook.run(id);
  },

  // Steps
  playbookStepInsert(step: any) {
    return this._stmts.insertStep.run(step);
  },
  playbookStepFind(id: string) {
    return this._stmts.findStep.get(id);
  },
  playbookSteps(playbookId: string) {
    return this._stmts.stepsByPlaybook.all(playbookId);
  },
  playbookStepUpdateStatus(params: any) {
    return this._stmts.updateStepStatus.run(params);
  },
  playbookPendingSteps(playbookId: string) {
    return this._stmts.pendingStepsByPlaybook.all(playbookId);
  },
};

module.exports = { preparePlaybookStatements, playbookMethods };
export {}; // CJS 模块标记
