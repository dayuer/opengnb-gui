'use strict';

/**
 * 用户认证 CRUD — NodeStore 的子模块
 *
 * 负责 users 表的所有读写操作。
 */

/** 准备用户相关的预编译语句 */
function prepareUserStatements(db: any) {
  return {
    insertUser: db.prepare(
      'INSERT INTO users (id, username, passwordHash, role, createdAt) VALUES (@id, @username, @passwordHash, @role, @createdAt)'
    ),
    findUserByName: db.prepare('SELECT * FROM users WHERE username = ?'),
    findUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
    findUserByApiToken: db.prepare('SELECT * FROM users WHERE apiToken = ?'),
    allUsers: db.prepare('SELECT id, username, role, apiToken, createdAt FROM users ORDER BY createdAt'),
    removeUser: db.prepare('DELETE FROM users WHERE id = ?'),
    userCount: db.prepare('SELECT COUNT(*) AS cnt FROM users'),
    updateApiToken: db.prepare('UPDATE users SET apiToken = ? WHERE id = ?'),
    updatePassword: db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?'),
    updateUserRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  };
}

/** 用户方法 mixin */
const userMethods = {
  /** 插入用户 */
  insertUser(this: any, { id, username, passwordHash, role = 'admin' }: any) {
    this._stmts.insertUser.run({ id, username, passwordHash, role, createdAt: new Date().toISOString() });
  },

  /** 按用户名查找 */
  findUserByName(this: any, username: any) {
    return this._stmts.findUserByName.get(username) || null;
  },

  /** 按 ID 查找 */
  findUserById(this: any, id: any) {
    return this._stmts.findUserById.get(id) || null;
  },

  /** 全部用户（脱敏） */
  allUsers(this: any) {
    return this._stmts.allUsers.all();
  },

  /** 删除用户 */
  deleteUser(this: any, id: any) {
    return this._stmts.removeUser.run(id);
  },

  /** 更新用户角色 */
  updateUserRole(this: any, id: any, role: any) {
    return this._stmts.updateUserRole.run(role, id);
  },

  /** 用户总数 */
  userCount(this: any) {
    return this._stmts.userCount.get().cnt;
  },
};

module.exports = { prepareUserStatements, userMethods };
export {}; // CJS 模块标记
