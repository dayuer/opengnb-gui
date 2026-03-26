'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { tmpDataDir } = require('../helpers');

describe('services/playbook-engine', () => {
  let store: any;
  let engine: any;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = tmpDataDir();
    cleanup = tmp.cleanup;

    const NodeStore = require('../../services/node-store');
    store = new NodeStore(require('path').join(tmp.dir, 'test.db'));
    store.init();

    // Mock TaskQueue（不需要真正分发任务）
    const mockTaskQueue = {
      enqueueTask: () => {},
    };

    const { PlaybookEngine } = require('../../services/playbook-engine');
    engine = new PlaybookEngine(store, mockTaskQueue);
  });

  it('创建 playbook + 步骤', () => {
    const pb = engine.create({
      name: '测试部署',
      description: '测试用途',
      steps: [
        { name: '步骤1_检查环境', command: 'uname -a' },
        { name: '步骤2_安装', command: 'apt install gnb', dependsOn: ['步骤1_检查环境'] },
      ],
      targetNodeIds: ['node-1', 'node-2'],
    });

    assert.ok(pb);
    assert.equal(pb.name, '测试部署');
    assert.equal(pb.status, 'pending');
    assert.equal(pb.steps.length, 2);
    assert.equal(pb.steps[0].name, '步骤1_检查环境');
    assert.equal(pb.steps[1].name, '步骤2_安装');

    cleanup();
  });

  it('启动执行 → 无依赖步骤标记 running', () => {
    const pb = engine.create({
      name: '启动测试',
      steps: [
        { name: '检查', command: 'uptime' },
        { name: '安装', command: 'install', dependsOn: ['检查'] },
      ],
      targetNodeIds: ['node-1'],
    });

    engine.start(pb.id);

    const detail = engine.getPlaybookDetail(pb.id);
    assert.equal(detail.status, 'running');
    // 步骤1 无依赖 → running
    assert.equal(detail.steps[0].status, 'running');
    // 步骤2 依赖步骤1 → 仍然 pending
    assert.equal(detail.steps[1].status, 'pending');

    cleanup();
  });

  it('步骤完成 → 驱动下一步', () => {
    const pb = engine.create({
      name: '链式测试',
      steps: [
        { name: 'A', command: 'echo A' },
        { name: 'B', command: 'echo B', dependsOn: ['A'] },
      ],
      targetNodeIds: ['node-1'],
    });

    engine.start(pb.id);
    const stepA = engine.getPlaybookDetail(pb.id).steps[0];

    // 完成步骤 A
    engine.onStepComplete(stepA.id, { success: true, summary: 'done' });

    const detail = engine.getPlaybookDetail(pb.id);
    assert.equal(detail.steps[0].status, 'completed');
    // 步骤 B 依赖已满足 → running
    assert.equal(detail.steps[1].status, 'running');

    cleanup();
  });

  it('所有步骤完成 → playbook completed', () => {
    const pb = engine.create({
      name: '完成测试',
      steps: [{ name: 'only', command: 'echo ok' }],
      targetNodeIds: ['node-1'],
    });

    engine.start(pb.id);
    const step = engine.getPlaybookDetail(pb.id).steps[0];
    engine.onStepComplete(step.id, { success: true });

    const detail = engine.getPlaybookDetail(pb.id);
    assert.equal(detail.status, 'completed');

    cleanup();
  });

  it('步骤失败 → playbook failed', () => {
    const pb = engine.create({
      name: '失败测试',
      steps: [{ name: 'fail', command: 'false' }],
      targetNodeIds: ['node-1'],
    });

    engine.start(pb.id);
    const step = engine.getPlaybookDetail(pb.id).steps[0];
    engine.onStepComplete(step.id, { success: false, summary: 'exit 1' });

    const detail = engine.getPlaybookDetail(pb.id);
    assert.equal(detail.status, 'failed');
    assert.equal(detail.steps[0].status, 'failed');

    cleanup();
  });

  it('取消 → pending/running 步骤标记 cancelled', () => {
    const pb = engine.create({
      name: '取消测试',
      steps: [
        { name: 'A', command: 'echo A' },
        { name: 'B', command: 'echo B', dependsOn: ['A'] },
      ],
      targetNodeIds: ['node-1'],
    });

    engine.start(pb.id);
    engine.cancel(pb.id);

    const detail = engine.getPlaybookDetail(pb.id);
    assert.equal(detail.status, 'cancelled');
    // A was running, B was pending → both cancelled
    assert.equal(detail.steps[0].status, 'cancelled');
    assert.equal(detail.steps[1].status, 'cancelled');

    cleanup();
  });

  it('列表 + 删除', () => {
    engine.create({ name: 'pb1', steps: [{ name: 's', command: 'ls' }], targetNodeIds: ['n1'] });
    engine.create({ name: 'pb2', steps: [{ name: 's', command: 'ls' }], targetNodeIds: ['n1'] });

    const list = engine.list();
    assert.equal(list.length, 2);

    engine.delete(list[0].id);
    assert.equal(engine.list().length, 1);

    cleanup();
  });
});
