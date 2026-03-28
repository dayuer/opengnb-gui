'use strict';

const os = require('os');

/**
 * 子网探测与 CIDR 冲突检测模块
 *
 * 职责：
 * - 扫描宿主机 UP 状态网卡，返回已占用 CIDR 列表
 * - 判断两个 CIDR 是否存在地址空间重叠
 * - 从候选子网池中选出第一个与本地网段无冲突的安全子网
 *
 * 设计约束：
 * - 所有候选子网统一使用 /16 掩码（GNB B 类兼容）
 * - 首选 198.18.0.0/16（RFC 2544 测试保留段，实际路由器极少占用）
 */

/** 候选子网池（按优先级排序，统一 /16 掩码） */
const CANDIDATE_SUBNETS: string[] = [
  '198.18.0.0/16',   // RFC 2544 测试保留段
  '198.19.0.0/16',   // RFC 2544 备用段
  '10.250.0.0/16',   // 10.x 高位段
  '172.31.0.0/16',   // 172.16-31 末端
];

/** CIDR 解析结果 */
interface CidrInfo {
  networkInt: number;  // 网络地址（32 位无符号整数）
  prefix: number;      // 前缀长度
  mask: string;        // 掩码字符串，如 '255.255.0.0'
  maskInt: number;     // 掩码（32 位无符号整数）
}

/**
 * 将 IPv4 字符串转为 32 位无符号整数
 */
function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * 解析 CIDR 字符串
 * @example parseCidr('198.18.0.0/16')
 */
function parseCidr(cidr: string): CidrInfo {
  const [ip, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const maskInt = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const ipInt = ipToInt(ip);
  const networkInt = (ipInt & maskInt) >>> 0;
  const mask = [
    (maskInt >>> 24) & 0xff,
    (maskInt >>> 16) & 0xff,
    (maskInt >>> 8) & 0xff,
    maskInt & 0xff,
  ].join('.');
  return { networkInt, prefix, mask, maskInt };
}

/**
 * 检测两个 CIDR 是否存在地址空间重叠
 *
 * 算法：取两者中更短的前缀（更大的网络），
 * 用该掩码对比两个网络地址是否相同。
 */
function cidrOverlaps(cidrA: string, cidrB: string): boolean {
  const a = parseCidr(cidrA);
  const b = parseCidr(cidrB);
  // 取更短的前缀（更大的网络范围）
  const commonPrefix = Math.min(a.prefix, b.prefix);
  const commonMask = commonPrefix === 0 ? 0 : (0xffffffff << (32 - commonPrefix)) >>> 0;
  return (a.networkInt & commonMask) === (b.networkInt & commonMask);
}

/**
 * 检查单个 IP 是否落入 CIDR 范围
 */
function ipInCidr(ip: string, cidr: string): boolean {
  const ipInt = ipToInt(ip);
  const c = parseCidr(cidr);
  return ((ipInt & c.maskInt) >>> 0) === c.networkInt;
}

/**
 * 扫描宿主机所有 UP 状态网卡，返回已占用 CIDR 列表
 *
 * 排除规则：
 * - 跳过 loopback (127.x.x.x)
 * - 跳过 internal 接口
 * - 仅收集 IPv4 地址
 */
function detectLocalSubnets(): string[] {
  const interfaces = os.networkInterfaces();
  const subnets: string[] = [];

  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs as os.NetworkInterfaceInfo[]) {
      if (addr.family !== 'IPv4') continue;
      if (addr.internal) continue;
      if (addr.address.startsWith('127.')) continue;
      // 从 netmask 计算 prefix 长度
      const maskInt = ipToInt(addr.netmask);
      let prefix = 0;
      let m = maskInt;
      while (m & 0x80000000) {
        prefix++;
        m = (m << 1) >>> 0;
      }
      // 计算网络地址
      const ipInt = ipToInt(addr.address);
      const networkInt = (ipInt & maskInt) >>> 0;
      const network = [
        (networkInt >>> 24) & 0xff,
        (networkInt >>> 16) & 0xff,
        (networkInt >>> 8) & 0xff,
        networkInt & 0xff,
      ].join('.');
      subnets.push(`${network}/${prefix}`);
    }
  }
  return subnets;
}

/**
 * 从候选子网池中选出第一个与已占用网段无冲突的安全子网
 *
 * @returns 安全子网 CIDR 或 null（全部冲突）
 */
function findSafeSubnet(candidates: string[], occupied: string[]): string | null {
  for (const candidate of candidates) {
    const hasConflict = occupied.some(occ => cidrOverlaps(candidate, occ));
    if (!hasConflict) return candidate;
  }
  return null;
}

module.exports = {
  parseCidr,
  cidrOverlaps,
  ipInCidr,
  detectLocalSubnets,
  findSafeSubnet,
  CANDIDATE_SUBNETS,
  ipToInt,
};
export {};
