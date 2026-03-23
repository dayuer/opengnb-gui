'use strict';

/**
 * 分组 CRUD — NodeStore 的子模块
 *
 * 负责 groups 表的所有读写操作。
 * 通过 mixin 模式混入 NodeStore，共享同一个 SQLite db 实例。
 */

/** 准备分组相关的预编译语句 */
function prepareGroupStatements(db: any) {
  return {
    allGroups: db.prepare('SELECT * FROM groups ORDER BY createdAt'),
    findGroupById: db.prepare('SELECT * FROM groups WHERE id = ?'),
    findGroupByName: db.prepare('SELECT * FROM groups WHERE name = ?'),
    insertGroup: db.prepare(
      'INSERT INTO groups (id, name, color, createdAt) VALUES (@id, @name, @color, @createdAt)'
    ),
    updateGroupStmt: db.prepare('UPDATE groups SET name = @name, color = @color WHERE id = @id'),
    removeGroupStmt: db.prepare('DELETE FROM groups WHERE id = ?'),
    clearGroupId: db.prepare("UPDATE nodes SET groupId = '' WHERE groupId = ?"),
    countNodesByGroup: db.prepare('SELECT COUNT(*) AS cnt FROM nodes WHERE groupId = ?'),
  };
}

/** 分组方法 mixin — 混入 NodeStore.prototype */
const groupMethods = {
  /** 获取所有分组 */
  allGroups(this: any) {
    return this._stmts.allGroups.all();
  },

  /** 按 ID 查找分组 */
  findGroupById(this: any, id: any) {
    return this._stmts.findGroupById.get(id) || null;
  },

  /** 按名称查找分组（唯一性检查） */
  findGroupByName(this: any, name: any) {
    return this._stmts.findGroupByName.get(name) || null;
  },

  /** 插入分组 */
  insertGroup(this: any, group: any) {
    this._stmts.insertGroup.run(group);
  },

  /** 更新分组 */
  updateGroupFields(this: any, id: any, { name, color }: any) {
    const existing = this.findGroupById(id);
    if (!existing) return false;
    this._stmts.updateGroupStmt.run({
      id,
      name: name !== undefined ? name : existing.name,
      color: color !== undefined ? color : existing.color,
    });
    return true;
  },

  /** 删除分组（事务：清空关联节点 groupId + 删除分组） */
  removeGroup(this: any, id: any) {
    const txn = this.db.transaction((groupId: any) => {
      this._stmts.clearGroupId.run(groupId);
      this._stmts.removeGroupStmt.run(groupId);
    });
    txn(id);
  },

  /** 获取分组内的节点数量 */
  countNodesByGroup(this: any, groupId: any) {
    return this._stmts.countNodesByGroup.get(groupId).cnt;
  },
};

module.exports = { prepareGroupStatements, groupMethods };
export {}; // CJS 模块标记
