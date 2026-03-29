'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createLogger } = require('./logger');
const { ipInCidr } = require('./subnet-detector');
const log = createLogger('GnbConfig');

/**
 * 解析 CIDR 字符串，返回网络地址、掩码、前缀位数
 * @example parseCidr('192.168.100.0/16') // {parts:[192,168,100,0], prefix:16, mask:'255.255.0.0'}
 */
function parseCidr(cidr: string): { parts: number[]; prefix: number; mask: string } {
  const [ip, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const parts = ip.split('.').map(Number);
  // 生成掩码
  const maskBits = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const mask = [
    (maskBits >>> 24) & 0xff,
    (maskBits >>> 16) & 0xff,
    (maskBits >>> 8) & 0xff,
    maskBits & 0xff,
  ].join('.');
  return { parts, prefix, mask };
}

/**
 * GNB 网络配置管理
 *
 * 职责：address.conf / route.conf 生成、GNB 节点 ID 分配、
 * TUN IP 分配、Console GNB 公钥管理、配置重写 + 服务重启。
 *
 * 从 KeyManager 提取，由 KeyManager 内部委托调用。
 */
/** GnbConfig 依赖的 Store 接口 */
interface GnbNodeStore {
  approvedWithGnb(): { gnbNodeId: string; tunAddr: string; netmask?: string }[];
  all(): { gnbNodeId?: string; tunAddr?: string }[];
  allTunAddrs(): Set<string>;
  findById(id: string): Record<string, unknown> | undefined;
  update(id: string, data: Record<string, unknown>): void;
}

class GnbConfig {
  gnbNodeId: string;
  gnbConfDir: string;
  gnbTunAddr: string;
  gnbIndexAddr: string;
  gnbTunSubnet: string;     // e.g. '192.168.100.0/16'
  _subnetMask: string;      // e.g. '255.255.0.0'
  _subnetParts: number[];   // e.g. [192, 168, 100, 0]
  _subnetPrefix: number;    // e.g. 16
  store: GnbNodeStore;

  constructor(options: {
    gnbNodeId: string;
    gnbConfDir: string;
    gnbTunAddr: string;
    gnbIndexAddr: string;
    gnbTunSubnet?: string;
    store: GnbNodeStore;
  }) {
    this.gnbNodeId = options.gnbNodeId;
    this.gnbConfDir = options.gnbConfDir;
    this.gnbTunAddr = options.gnbTunAddr;
    this.gnbIndexAddr = options.gnbIndexAddr;
    this.gnbTunSubnet = options.gnbTunSubnet || '192.168.100.0/16';
    const parsed = parseCidr(this.gnbTunSubnet);
    this._subnetMask = parsed.mask;
    this._subnetParts = parsed.parts;
    this._subnetPrefix = parsed.prefix;
    this.store = options.store;
  }

  /**
   * 生成全量 address.conf（index + Console TUN + Console WAN + 所有已审批节点）
   *
   * ★ Console TUN 条目（consoleNodeId|tunIp|mask）必须在 WAN 条目之前！
   *   OpenGNB 对同节点 ID 的多行解析中，首行 IP 被绑到 TUN 接口。
   *   若 WAN 行在前，GNB 会把公网 IP 绑到 TUN → 隧道完全不通。
   */
  /**
   * 从 Console 本地 gnb_ctl -s 解析所有节点的 WAN IP
   * 返回 Map<gnbNodeId, {ip, port}>
   *
   * 缓存 30s，避免频繁 fork 进程
   */
  private _wanCache: { ts: number; data: Map<string, { ip: string; port: string }> } = { ts: 0, data: new Map() };
  private _readNodeWanAddresses(): Map<string, { ip: string; port: string }> {
    const now = Date.now();
    if (now - this._wanCache.ts < 30000 && this._wanCache.data.size > 0) {
      return this._wanCache.data;
    }

    const result = new Map<string, { ip: string; port: string }>();
    const mapFile = path.join(this.gnbConfDir, 'gnb.map');
    if (!fs.existsSync(mapFile)) return result;

    try {
      const raw = execSync(`gnb_ctl -b "${mapFile}" -s`, { timeout: 3000, encoding: 'utf8' });
      // 解析格式：
      //   node 1002
      //   ...
      //   wan_ipv4 101.35.177.232:55126
      let currentNodeId = '';
      for (const line of raw.split('\n')) {
        const nodeMatch = line.match(/^node\s+(\d+)/);
        if (nodeMatch) {
          currentNodeId = nodeMatch[1];
          continue;
        }
        if (currentNodeId && currentNodeId !== this.gnbNodeId) {
          const wanMatch = line.match(/wan_ipv4\s+([\d.]+):(\d+)/);
          if (wanMatch) {
            result.set(currentNodeId, { ip: wanMatch[1], port: wanMatch[2] });
          }
        }
      }
      this._wanCache = { ts: now, data: result };
      log.debug(`读取到 ${result.size} 个节点 WAN 地址`);
    } catch (e: unknown) {
      log.debug(`gnb_ctl -s 读取失败（GNB 可能未运行）: ${e instanceof Error ? e.message : String(e)}`);
    }
    return result;
  }

  generateFullAddressConf(): string {
    const addressConfPath = path.join(this.gnbConfDir, 'address.conf');

    // 保留已有的 index 行（或使用 indexAddr 生成默认值）
    let indexLine = `i|0|${this.gnbIndexAddr || '0.0.0.0'}|9001`;
    try {
      if (fs.existsSync(addressConfPath)) {
        const existing = fs.readFileSync(addressConfPath, 'utf8');
        const match = existing.match(/^i\|.*$/m);
        if (match) indexLine = match[0];
      }
    } catch (_e) { log.debug('配置解析失败，使用默认值', (_e as Error)?.message); }

    // 读取 Console WAN IP + 端口（来自 .env）
    const consoleWanIp = process.env.CONSOLE_WAN_IP || '';
    const gnbWanPort = process.env.GNB_WAN_PORT || '9002';

    // ★ 从 Console 本地 gnb_ctl 读取所有节点的 WAN 地址
    const nodeWanAddrs = this._readNodeWanAddresses();

    const lines = [indexLine];

    // ★ Console TUN 路由条目（必须在 WAN 之前！OpenGNB 首行 IP 绑 TUN 接口）
    lines.push(`${this.gnbNodeId}|${this.gnbTunAddr}|${this._subnetMask}`);

    // Console WAN 静态地址（节点 GNB 依赖此条目 UDP 打洞到 Console）
    if (this.gnbNodeId && consoleWanIp) {
      lines.push(`${this.gnbNodeId}|${consoleWanIp}|${gnbWanPort}`);
    }

    // ★ Console 作为 forward 中继节点（if| 行）
    // 当两个终端节点之间 UDP 打洞失败时，通过 Console 中继，GNB 后台会持续尝试 P2P hole-punch
    if (this.gnbNodeId && consoleWanIp) {
      lines.push(`if|${this.gnbNodeId}|${consoleWanIp}|${gnbWanPort}`);
    }

    // ★ 全部已审批节点：TUN 路由行 + WAN 地址行（P2P 打洞所需）
    for (const node of this.store.approvedWithGnb()) {
      if (!node.tunAddr) continue;
      // TUN 路由行（必须在 WAN 之前，首行 IP 绑 TUN 接口）
      lines.push(`${node.gnbNodeId}|${node.tunAddr}|${node.netmask || this._subnetMask}`);
      // WAN 地址行 — 使节点间可相互发现并尝试 P2P 打洞
      const wan = nodeWanAddrs.get(node.gnbNodeId);
      if (wan) {
        lines.push(`${node.gnbNodeId}|${wan.ip}|${wan.port}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  /**
   * 审批后更新 Console 的 GNB 配置（全量重写）
   */
  updateGnbConfig(node: { id: string; tunAddr?: string; gnbNodeId?: string }): void {
    if (!node.tunAddr) return;
    if (!node.gnbNodeId) {
      const gnbNodeId = this.nextGnbNodeId();
      this.store.update(node.id, { gnbNodeId });
      node.gnbNodeId = gnbNodeId;
    }
    this.writeFullGnbConf();
  }

  /**
   * 全量重写 index 侧 route.conf + address.conf + 重启 GNB
   */
  writeFullGnbConf(): void {
    try {
      if (!fs.existsSync(this.gnbConfDir)) {
        log.warn(`配置目录不存在: ${this.gnbConfDir}，跳过`);
        return;
      }
      const fullConf = this.generateFullAddressConf();
      fs.writeFileSync(path.join(this.gnbConfDir, 'address.conf'), fullConf);
      const routeContent = fullConf.split('\n').filter((l: string) => !l.startsWith('i|')).join('\n');
      fs.writeFileSync(path.join(this.gnbConfDir, 'route.conf'), routeContent);
      log.info('GNB 配置已全量重写');

      try {
        execSync('systemctl restart gnb', { timeout: 10000 });
        log.info('GNB 服务已重启');
      } catch (e: unknown) {
        log.warn(`GNB 重启跳过: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (err: unknown) {
      log.error(`GNB 全量重写失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 自动分配下一个 GNB 节点 ID（从 1002 开始，Console 自身是 1001）
   */
  nextGnbNodeId(): string {
    const allNodes = this.store.all();
    const usedIds = allNodes
      .filter((n: { gnbNodeId?: string }) => n.gnbNodeId)
      .map((n: { gnbNodeId?: string }) => parseInt(n.gnbNodeId!, 10));
    const consoleId = parseInt(this.gnbNodeId, 10);
    usedIds.push(consoleId);
    return String(Math.max(...usedIds) + 1);
  }

  /**
   * 自动分配下一个可用 TUN IP 地址
   * 分配范围根据 GNB_TUN_SUBNET 配置自动派生，默认 192.168.100.0/16
   *
   * @param remoteSubnets 节点已上报的本地网段 CIDR 列表（可选），
   *        分配时检查候选 IP 不与这些网段冲突
   */
  nextAvailableIp(remoteSubnets?: string[]): string {
    const usedIps = this.store.allTunAddrs();
    if (this.gnbTunAddr) usedIps.add(this.gnbTunAddr);

    const [a, b, c0] = this._subnetParts;
    const prefix = this._subnetPrefix;

    /** 检查候选 IP 是否与节点本地网段冲突 */
    const conflictsWithRemote = (ip: string): boolean => {
      if (!remoteSubnets || remoteSubnets.length === 0) return false;
      return remoteSubnets.some(cidr => ipInCidr(ip, cidr));
    };

    // 对于 /24：只遍历 d；/16：遍历 c+d；/8：遍历 b+c+d
    if (prefix <= 8) {
      for (let bb = b; bb <= 255; bb++) {
        for (let cc = (bb === b ? c0 : 0); cc <= 255; cc++) {
          for (let d = 1; d <= 254; d++) {
            const candidate = `${a}.${bb}.${cc}.${d}`;
            if (!usedIps.has(candidate) && !conflictsWithRemote(candidate)) return candidate;
          }
        }
      }
    } else if (prefix <= 16) {
      for (let cc = c0; cc <= 255; cc++) {
        for (let d = 1; d <= 254; d++) {
          const candidate = `${a}.${b}.${cc}.${d}`;
          if (!usedIps.has(candidate) && !conflictsWithRemote(candidate)) return candidate;
        }
      }
    } else {
      // /24 及以下
      for (let d = 1; d <= 254; d++) {
        const candidate = `${a}.${b}.${c0}.${d}`;
        if (!usedIps.has(candidate) && !conflictsWithRemote(candidate)) return candidate;
      }
    }
    throw new Error('IP 地址池已耗尽');
  }

  /**
   * 获取 Console GNB 节点的 Ed25519 公钥
   */
  getGnbPublicKey(): string | null {
    const pubKeyPath = path.join(this.gnbConfDir, 'security', `${this.gnbNodeId}.public`);
    try {
      return fs.readFileSync(pubKeyPath, 'utf8').trim();
    } catch {
      return null;
    }
  }

  /**
   * 保存终端节点的 GNB 公钥到 Console 的 ed25519 目录
   */
  saveNodeGnbPubkey(nodeId: string, pubKey: string): { success: boolean; message: string } {
    const node = this.store.findById(nodeId);
    if (!node || !node.gnbNodeId) {
      return { success: false, message: '节点不存在或未分配 GNB ID' };
    }
    const ed25519Dir = path.join(this.gnbConfDir, 'ed25519');
    if (!fs.existsSync(ed25519Dir)) fs.mkdirSync(ed25519Dir, { recursive: true });
    const keyPath = path.join(ed25519Dir, `${node.gnbNodeId}.public`);
    fs.writeFileSync(keyPath, pubKey.trim());
    log.info(`已保存节点 ${nodeId} (gnb ${node.gnbNodeId}) 的公钥`);

    try {
      execSync('systemctl restart gnb', { timeout: 10000 });
    } catch (e: unknown) {
      log.warn(`GNB 重启服务跳过: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { success: true, message: '公钥已保存' };
  }

  /**
   * 编辑 tunAddr 时重写 GNB 配置（全量模式）
   */
  updateGnbAddressConf(node: { tunAddr?: string; gnbNodeId?: string }): void {
    if (!node.tunAddr || !node.gnbNodeId) return;
    this.writeFullGnbConf();
  }
}

module.exports = GnbConfig;
export {}; // CJS 模块标记
