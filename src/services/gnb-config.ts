'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createLogger } = require('./logger');
const log = createLogger('GnbConfig');

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
  store: GnbNodeStore;

  constructor(options: {
    gnbNodeId: string;
    gnbConfDir: string;
    gnbTunAddr: string;
    gnbIndexAddr: string;
    store: GnbNodeStore;
  }) {
    this.gnbNodeId = options.gnbNodeId;
    this.gnbConfDir = options.gnbConfDir;
    this.gnbTunAddr = options.gnbTunAddr;
    this.gnbIndexAddr = options.gnbIndexAddr;
    this.store = options.store;
  }

  /**
   * 生成全量 address.conf（index + 所有已审批节点）
   */
  generateFullAddressConf(): string {
    const addressConfPath = path.join(this.gnbConfDir, 'address.conf');
    let indexLine = `i|0|${this.gnbIndexAddr || '0.0.0.0'}|9001`;
    try {
      if (fs.existsSync(addressConfPath)) {
        const existing = fs.readFileSync(addressConfPath, 'utf8');
        const match = existing.match(/^i\|.*$/m);
        if (match) indexLine = match[0];
      }
    } catch (_e) { log.debug('配置解析失败，使用默认值', (_e as Error)?.message); }

    const lines = [indexLine];
    lines.push(`${this.gnbNodeId}|${this.gnbTunAddr}|255.0.0.0`);
    for (const node of this.store.approvedWithGnb()) {
      if (node.tunAddr) {
        lines.push(`${node.gnbNodeId}|${node.tunAddr}|${node.netmask || '255.0.0.0'}`);
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
   * 策略：10.1.0.x → 10.1.1.x → ... → 10.255.255.x 顺序填充
   */
  nextAvailableIp(): string {
    const usedIps = this.store.allTunAddrs();
    if (this.gnbTunAddr) usedIps.add(this.gnbTunAddr);

    for (let b = 1; b <= 255; b++) {
      for (let c = 0; c <= 255; c++) {
        const start = (b === 1 && c === 0) ? 2 : 1;
        for (let d = start; d <= 254; d++) {
          const candidate = `10.${b}.${c}.${d}`;
          if (!usedIps.has(candidate)) return candidate;
        }
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
