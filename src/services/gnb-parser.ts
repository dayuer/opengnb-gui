'use strict';

/**
 * gnb_ctl 输出解析器
 * 将 gnb_ctl -b <path> -s 的文本输出解析为结构化 JSON
 *
 * gnb_ctl 的输出格式参考 gnb_vt 的 console_node_window.c 字段逻辑
 */

/**
 * 解析 gnb_ctl -s 的节点状态输出
 * @param {string} raw - gnb_ctl 原始输出文本
 * @returns {object} 解析后的结构化数据
 */
function parseGnbCtlStatus(raw: string) {
  const result: { core: Record<string, string>; nodes: Record<string, string | number>[] } = {
    core: {},
    nodes: [],
  };

  const lines = raw.split('\n').map((l: string) => l.trim()).filter(Boolean);

  let section = 'unknown';
  let currentNode: Record<string, string | number> | null = null;

  for (const line of lines) {
    // 检测段落标记
    if (line.startsWith('---') || line.startsWith('===')) {
      continue;
    }

    // 核心信息段
    if (line.includes('local_uuid') || line.includes('local uuid')) {
      const val = extractValue(line);
      if (val) result.core.localUuid = val;
      section = 'core';
      continue;
    }

    if (section === 'core') {
      const kvResult = parseKeyValue(line);
      if (kvResult) {
        result.core[kvResult.key] = kvResult.value;
      }
    }

    // 节点信息段 — 识别 nodeid 行作为新节点开始
    if (/^\s*\d+\s/.test(line) || line.match(/uuid64[\s:=]+(\d+)/i)) {
      const nodeMatch = line.match(/(\d{3,})/);
      if (nodeMatch) {
        if (currentNode) result.nodes.push(currentNode);
        currentNode = { uuid64: nodeMatch[1], raw: line };
        section = 'node';
        continue;
      }
    }

    if (section === 'node' && currentNode) {
      // 解析节点状态字段
      if (line.includes('tun_addr4') || line.includes('tun4')) {
        currentNode.tunAddr4 = extractIPv4(line);
      } else if (line.includes('wan4') || line.includes('udp_sockaddr4')) {
        currentNode.wanAddr4 = extractValue(line);
      } else if (line.includes('wan6') || line.includes('udp_sockaddr6')) {
        currentNode.wanAddr6 = extractValue(line);
      } else if (line.includes('in_bytes') || line.includes('in ')) {
        currentNode.inBytes = extractNumber(line);
      } else if (line.includes('out_bytes') || line.includes('out ')) {
        currentNode.outBytes = extractNumber(line);
      } else if (line.includes('ping_latency') || line.includes('latency')) {
        if (line.includes('addr6') || line.includes('ipv6')) {
          currentNode.latency6Usec = extractNumber(line);
        } else {
          currentNode.latency4Usec = extractNumber(line);
        }
      } else if (line.includes('status') || line.includes('reachable')) {
        currentNode.status = extractStatusLabel(line);
      } else if (line.includes('Direct')) {
        currentNode.status = 'Direct';
      } else if (line.includes('Indirect')) {
        currentNode.status = 'Indirect';
      }
    }
  }

  if (currentNode) result.nodes.push(currentNode);

  return result;
}

/**
 * 解析 gnb_ctl -a 的地址列表输出
 * @param {string} raw - gnb_ctl 地址输出
 * @returns {Array<{uuid: string, addresses: Array}>}
 */
function parseGnbCtlAddressList(raw: string) {
  const nodes: { uuid: string; addresses: { ip: string; port: number; type: string }[] }[] = [];
  const lines = raw.split('\n').filter(Boolean);
  let currentNode: { uuid: string; addresses: { ip: string; port: number; type: string }[] } | null = null;

  for (const line of lines) {
    const nodeMatch = line.match(/^(\d{3,})\s/);
    if (nodeMatch) {
      if (currentNode) nodes.push(currentNode);
      currentNode = { uuid: nodeMatch[1], addresses: [] };
    }

    const addrMatch = line.match(/(\d+\.\d+\.\d+\.\d+):(\d+)/);
    if (addrMatch && currentNode) {
      currentNode.addresses.push({
        ip: addrMatch[1],
        port: parseInt(addrMatch[2], 10),
        type: line.includes('static') ? 'static' :
              line.includes('dynamic') ? 'dynamic' :
              line.includes('resolv') ? 'resolv' :
              line.includes('push') ? 'push' : 'unknown',
      });
    }
  }

  if (currentNode) nodes.push(currentNode);
  return nodes;
}

// --- 辅助函数 ---

function extractValue(line: string) {
  const parts = line.split(/[\s:=]+/);
  return parts.length > 1 ? parts.slice(1).join(' ').trim() : '';
}

function extractIPv4(line: string) {
  const match = line.match(/(\d+\.\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

function extractNumber(line: string) {
  const match = line.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function extractStatusLabel(line: string) {
  if (line.includes('PONG') || line.includes('Direct')) return 'Direct';
  if (line.includes('PING') || line.includes('Detecting')) return 'Detecting';
  return 'Indirect';
}

function parseKeyValue(line: string) {
  const match = line.match(/^([a-zA-Z_]\w*)\s*[=:]\s*(.+)$/);
  if (!match) return null;
  return {
    key: match[1].replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase()),
    value: match[2].trim(),
  };
}

/**
 * 将字节数格式化为可读字符串（复用 gnb_vt console_node_window.c 的格式化逻辑）
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(3)}G`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(3)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(3)}K`;
  return `${bytes}B`;
}

module.exports = {
  parseGnbCtlStatus,
  parseGnbCtlAddressList,
  formatBytes,
};
export {}; // CJS 模块标记
