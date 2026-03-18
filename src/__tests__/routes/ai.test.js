'use strict';

// @beta: AiOps 指令路由测试 — 覆盖 S9.1-S9.4

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const AiOps = require('../../services/ai-ops');

describe('services/ai-ops', () => {
  function createAiOps(nodes = []) {
    return new AiOps({
      nodesConfig: nodes,
      sshManager: { exec: async () => ({ stdout: '', stderr: '', code: 0 }) },
      getNodeStatus: () => [],
      provisioner: { provision: () => {} },
    });
  }

  // S9.1: 帮助
  it('S9.1 should return help for "help"', async () => {
    const ai = createAiOps();
    const result = await ai.chat('help');
    assert.ok(result.response.includes('可用指令'));
  });

  // S9.2: 状态查询 (无节点)
  it('S9.2 should report no nodes for "状态"', async () => {
    const ai = createAiOps();
    const result = await ai.chat('状态');
    assert.ok(result.response.includes('无已接入节点'));
  });

  // S9.3: 空消息
  it('S9.3 should prompt for input on empty message', async () => {
    const ai = createAiOps();
    const result = await ai.chat('');
    assert.ok(result.response.includes('请输入指令'));
  });

  // S9.4: 未知指令 → 返回帮助
  it('S9.4 should return help for unknown input', async () => {
    const ai = createAiOps();
    const result = await ai.chat('随便说一句');
    assert.ok(result.response.includes('可用指令'));
  });

  // 额外: 有节点时的状态查询
  it('should show node status when nodes exist', async () => {
    const ai = new AiOps({
      nodesConfig: [{ id: 'n1', name: 'TestNode' }],
      sshManager: { exec: async () => ({ stdout: '', stderr: '', code: 0 }) },
      getNodeStatus: () => [{ id: 'n1', name: 'TestNode', tunAddr: '10.0.0.1', online: true, sshLatencyMs: 5 }],
      provisioner: { provision: () => {} },
    });
    const result = await ai.chat('状态');
    assert.ok(result.response.includes('TestNode'));
    assert.ok(result.response.includes('🟢'));
  });

  // 额外: 指定节点的安装命令 — 无需 SSH，仅测试路由正确
  it('should route install command to provisioner', async () => {
    let provisionCalled = false;
    const ai = new AiOps({
      nodesConfig: [{ id: 'n1', name: 'TestNode' }],
      sshManager: { exec: async () => ({ stdout: '', stderr: '', code: 0 }) },
      getNodeStatus: () => [],
      provisioner: { provision: () => { provisionCalled = true; } },
    });
    const result = await ai.chat('安装 openclaw n1');
    assert.ok(result.response.includes('开始'));
    assert.ok(provisionCalled);
  });
});
