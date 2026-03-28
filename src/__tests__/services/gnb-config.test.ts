'use strict';

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

const GnbConfig = require('../../services/gnb-config');

/** 创建一个轻量的 mock store */
function mockStore(opts: { gnbNodes?: { gnbNodeId: string; tunAddr: string; netmask?: string }[]; tunAddrs?: string[] } = {}) {
  const nodes = opts.gnbNodes || [];
  const addrs = new Set(opts.tunAddrs || nodes.map(n => n.tunAddr));
  return {
    approvedWithGnb: () => nodes,
    all: () => nodes,
    allTunAddrs: () => addrs,
    findById: (_id: string) => undefined,
    update: (_id: string, _data: Record<string, unknown>) => {},
  };
}

describe('GnbConfig.nextAvailableIp', () => {

  it('无 remoteSubnets 时行为不变（向后兼容）', () => {
    const cfg = new GnbConfig({
      gnbNodeId: '1001',
      gnbConfDir: '/tmp/gnb-test',
      gnbTunAddr: '198.18.0.1',
      gnbIndexAddr: '0.0.0.0',
      gnbTunSubnet: '198.18.0.0/16',
      store: mockStore({ tunAddrs: ['198.18.0.1'] }),
    });
    // 应分配 198.18.0.2（跳过已用的 .1）
    const ip = cfg.nextAvailableIp();
    assert.equal(ip, '198.18.0.2');
  });

  it('传入 remoteSubnets 时应跳过冲突 IP', () => {
    const cfg = new GnbConfig({
      gnbNodeId: '1001',
      gnbConfDir: '/tmp/gnb-test',
      gnbTunAddr: '198.18.0.1',
      gnbIndexAddr: '0.0.0.0',
      gnbTunSubnet: '198.18.0.0/16',
      store: mockStore({ tunAddrs: ['198.18.0.1'] }),
    });
    // 节点本地网段恰好包含 198.18.0.0/24
    // 应跳过 198.18.0.x 段，从 198.18.1.1 开始
    const ip = cfg.nextAvailableIp(['198.18.0.0/24']);
    assert.equal(ip, '198.18.1.1');
  });

  it('remoteSubnets 为空数组时等同于不传', () => {
    const cfg = new GnbConfig({
      gnbNodeId: '1001',
      gnbConfDir: '/tmp/gnb-test',
      gnbTunAddr: '198.18.0.1',
      gnbIndexAddr: '0.0.0.0',
      gnbTunSubnet: '198.18.0.0/16',
      store: mockStore({ tunAddrs: ['198.18.0.1'] }),
    });
    const ip = cfg.nextAvailableIp([]);
    assert.equal(ip, '198.18.0.2');
  });

  it('多个 remoteSubnets 全部检查', () => {
    const cfg = new GnbConfig({
      gnbNodeId: '1001',
      gnbConfDir: '/tmp/gnb-test',
      gnbTunAddr: '198.18.0.1',
      gnbIndexAddr: '0.0.0.0',
      gnbTunSubnet: '198.18.0.0/16',
      store: mockStore({ tunAddrs: ['198.18.0.1'] }),
    });
    // 节点同时占用了两个段
    const ip = cfg.nextAvailableIp(['198.18.0.0/24', '198.18.1.0/24']);
    assert.equal(ip, '198.18.2.1');
  });

});
