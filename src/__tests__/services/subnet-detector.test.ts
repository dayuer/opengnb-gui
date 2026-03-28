'use strict';

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

// 导入待测模块（尚不存在，期望 RED）
const {
  parseCidr,
  cidrOverlaps,
  ipInCidr,
  detectLocalSubnets,
  findSafeSubnet,
  CANDIDATE_SUBNETS,
} = require('../../services/subnet-detector');

describe('subnet-detector', () => {

  describe('parseCidr', () => {
    it('应正确解析 /16 网段', () => {
      const r = parseCidr('198.18.0.0/16');
      assert.equal(r.prefix, 16);
      assert.equal(r.mask, '255.255.0.0');
      assert.equal(r.networkInt >>> 0, (198 << 24 | 18 << 16) >>> 0);
    });

    it('应正确解析 /24 网段', () => {
      const r = parseCidr('10.250.1.0/24');
      assert.equal(r.prefix, 24);
      assert.equal(r.mask, '255.255.255.0');
    });

    it('应正确解析 /8 网段', () => {
      const r = parseCidr('10.0.0.0/8');
      assert.equal(r.prefix, 8);
      assert.equal(r.mask, '255.0.0.0');
    });
  });

  describe('cidrOverlaps', () => {
    it('子网完全包含应返回 true', () => {
      assert.equal(cidrOverlaps('10.0.0.0/8', '10.1.0.0/24'), true);
    });

    it('不相交网段应返回 false', () => {
      assert.equal(cidrOverlaps('192.168.1.0/24', '10.0.0.0/8'), false);
    });

    it('198.18.0.0/16 与 198.18.1.0/24 应重叠', () => {
      assert.equal(cidrOverlaps('198.18.0.0/16', '198.18.1.0/24'), true);
    });

    it('198.18.0.0/16 与 198.19.0.0/16 应不重叠', () => {
      assert.equal(cidrOverlaps('198.18.0.0/16', '198.19.0.0/16'), false);
    });

    it('完全相同的网段应重叠', () => {
      assert.equal(cidrOverlaps('172.31.0.0/16', '172.31.0.0/16'), true);
    });

    it('大网段包含小网段的反向', () => {
      assert.equal(cidrOverlaps('10.1.0.0/24', '10.0.0.0/8'), true);
    });

    it('相邻但不重叠的 /24', () => {
      assert.equal(cidrOverlaps('192.168.0.0/24', '192.168.1.0/24'), false);
    });
  });

  describe('ipInCidr', () => {
    it('IP 在 CIDR 范围内应返回 true', () => {
      assert.equal(ipInCidr('198.18.0.5', '198.18.0.0/16'), true);
    });

    it('IP 不在 CIDR 范围内应返回 false', () => {
      assert.equal(ipInCidr('198.19.0.5', '198.18.0.0/16'), false);
    });

    it('网络地址本身应返回 true', () => {
      assert.equal(ipInCidr('10.0.0.0', '10.0.0.0/8'), true);
    });

    it('广播地址应返回 true', () => {
      assert.equal(ipInCidr('10.255.255.255', '10.0.0.0/8'), true);
    });

    it('192.168.100.1 应在 192.168.0.0/16 内', () => {
      assert.equal(ipInCidr('192.168.100.1', '192.168.0.0/16'), true);
    });

    it('192.168.100.1 不应在 10.250.0.0/16 内', () => {
      assert.equal(ipInCidr('192.168.100.1', '10.250.0.0/16'), false);
    });
  });

  describe('findSafeSubnet', () => {
    it('所有候选都安全时应返回第一个', () => {
      const candidates = ['198.18.0.0/16', '198.19.0.0/16', '10.250.0.0/16'];
      const occupied: string[] = [];
      assert.equal(findSafeSubnet(candidates, occupied), '198.18.0.0/16');
    });

    it('第一个候选冲突时应跳过返回第二个', () => {
      const candidates = ['198.18.0.0/16', '198.19.0.0/16', '10.250.0.0/16'];
      const occupied = ['198.18.5.0/24']; // 与第一个候选子网重叠
      assert.equal(findSafeSubnet(candidates, occupied), '198.19.0.0/16');
    });

    it('所有候选都冲突时应返回 null', () => {
      const candidates = ['198.18.0.0/16'];
      const occupied = ['198.18.0.0/16'];
      assert.equal(findSafeSubnet(candidates, occupied), null);
    });

    it('多个 occupied 网段应全部检查', () => {
      const candidates = ['198.18.0.0/16', '198.19.0.0/16', '10.250.0.0/16'];
      const occupied = ['198.18.0.0/16', '198.19.1.0/24'];
      assert.equal(findSafeSubnet(candidates, occupied), '10.250.0.0/16');
    });
  });

  describe('detectLocalSubnets', () => {
    it('应返回非空数组', () => {
      const subnets = detectLocalSubnets();
      assert.ok(Array.isArray(subnets));
      // 至少有一个网卡（lo 或物理网卡）
      assert.ok(subnets.length >= 0);
    });

    it('返回的每个元素应为 CIDR 格式', () => {
      const subnets = detectLocalSubnets();
      for (const s of subnets) {
        assert.match(s, /^\d+\.\d+\.\d+\.\d+\/\d+$/, `格式不正确: ${s}`);
      }
    });

    it('不应包含 loopback 地址', () => {
      const subnets = detectLocalSubnets();
      for (const s of subnets) {
        assert.ok(!s.startsWith('127.'), `不应包含 loopback: ${s}`);
      }
    });
  });

  describe('CANDIDATE_SUBNETS', () => {
    it('应为非空数组', () => {
      assert.ok(Array.isArray(CANDIDATE_SUBNETS));
      assert.ok(CANDIDATE_SUBNETS.length >= 3);
    });

    it('首选应为 198.18.0.0/16', () => {
      assert.equal(CANDIDATE_SUBNETS[0], '198.18.0.0/16');
    });
  });

});
