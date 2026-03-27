'use strict';

// TDD RED → task-dispatcher 策略映射表测试

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

describe('services/task-dispatcher', () => {
  const { buildWsMessage, dispatchTask } = require('../../services/task-dispatcher');

  // ═══════════════════════════════════════
  // buildWsMessage — 策略映射
  // ═══════════════════════════════════════

  describe('buildWsMessage', () => {
    it('should map skill_install to daemon skill_install message', () => {
      const task = { taskId: 't1', type: 'skill_install', skillId: 'my-skill', command: 'clawhub install my-skill' };
      const msg = buildWsMessage(task);
      assert.equal(msg.type, 'skill_install');
      assert.equal(msg.skillId, 'my-skill');
      assert.ok(msg.reqId, 'should include reqId');
    });

    it('should map skill_uninstall to daemon skill_uninstall message', () => {
      const task = { taskId: 't2', type: 'skill_uninstall', skillId: 'old-skill', command: '' };
      const msg = buildWsMessage(task);
      assert.equal(msg.type, 'skill_uninstall');
      assert.equal(msg.skillId, 'old-skill');
    });

    it('should map claw_restart to daemon claw_restart message', () => {
      const task = { taskId: 't3', type: 'claw_restart', command: '' };
      const msg = buildWsMessage(task);
      assert.equal(msg.type, 'claw_restart');
    });

    it('should map claw_upgrade to daemon claw_upgrade message', () => {
      const task = { taskId: 't4', type: 'claw_upgrade', command: '' };
      const msg = buildWsMessage(task);
      assert.equal(msg.type, 'claw_upgrade');
    });

    it('should fallback unknown types to exec_cmd', () => {
      const task = { taskId: 't5', type: 'custom_cmd', command: 'echo hello' };
      const msg = buildWsMessage(task);
      assert.equal(msg.type, 'exec_cmd');
      assert.equal(msg.command, 'echo hello');
    });

    it('should pass version for claw_upgrade when present in task', () => {
      const task = { taskId: 't6', type: 'claw_upgrade', command: '', version: '2026.3.24' };
      const msg = buildWsMessage(task);
      assert.equal(msg.version, '2026.3.24');
    });
  });

  // ═══════════════════════════════════════
  // dispatchTask — 分发逻辑
  // ═══════════════════════════════════════

  describe('dispatchTask', () => {
    let sentMessages: any[];
    let mockSendFn: Function;

    beforeEach(() => {
      sentMessages = [];
      mockSendFn = (nodeId: string, msg: any) => {
        sentMessages.push({ nodeId, msg });
        return Promise.resolve({ ok: true });
      };
    });

    it('should send WS message to correct node', async () => {
      const task = { taskId: 't1', type: 'claw_restart', nodeId: 'node-abc', command: '' };
      await dispatchTask(task, mockSendFn);
      assert.equal(sentMessages.length, 1);
      assert.equal(sentMessages[0].nodeId, 'node-abc');
      assert.equal(sentMessages[0].msg.type, 'claw_restart');
    });

    it('should return result from sendFn', async () => {
      const task = { taskId: 't2', type: 'skill_install', nodeId: 'node-x', skillId: 'foo', command: '' };
      const result = await dispatchTask(task, mockSendFn);
      assert.equal(result.ok, true);
    });

    it('should propagate sendFn errors as rejected promise', async () => {
      const failSend = () => Promise.reject(new Error('daemon 离线'));
      const task = { taskId: 't3', type: 'claw_restart', nodeId: 'node-y', command: '' };
      await assert.rejects(() => dispatchTask(task, failSend), /daemon 离线/);
    });
  });
});
