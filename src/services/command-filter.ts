'use strict';

/**
 * 命令安全过滤器 (Command Filter)
 *
 * 从 ai-ops.ts 提取的共享模块 — 用于 AiOps 和 SSH 终端的命令安全检查。
 * 包含约 30 条正则黑名单规则，覆盖文件系统破坏、系统关机、用户权限
 * 操作、网络危险操作、包管理、危险 shell 操作和内核操作。
 *
 * 匹配前会对命令进行反混淆处理（去除变量展开、反引号等）。
 */

// 危险命令黑名单
// 每个条目: { pattern: RegExp, reason: string }
const BLOCKED_PATTERNS = [
  // 文件系统破坏
  { pattern: /\brm\s+(-[a-z]*f|-[a-z]*r|--force|--recursive|--no-preserve-root)/i, reason: '禁止强制/递归删除' },
  { pattern: /\brm\s+(-[a-z]*\s+)?\//,  reason: '禁止删除根目录' },
  { pattern: /\bmkfs\b/i,                reason: '禁止格式化磁盘' },
  { pattern: /\bdd\s+.*of\s*=\s*\/dev/i, reason: '禁止 dd 写入设备' },
  { pattern: /\bshred\b/i,               reason: '禁止安全擦除' },
  { pattern: /\bwipefs\b/i,              reason: '禁止擦除文件系统签名' },

  // 系统关机/重启
  { pattern: /\b(shutdown|poweroff|halt|init\s+0)\b/i, reason: '禁止关机' },
  { pattern: /\breboot\b/i,              reason: '禁止重启系统' },

  // 用户/权限操作
  { pattern: /\b(userdel|groupdel)\b/i,  reason: '禁止删除用户/组' },
  { pattern: /\bpasswd\b/i,              reason: '禁止修改密码' },
  { pattern: /\bchmod\s+(-[a-z]*\s+)?0?777\b/i, reason: '禁止全开权限' },
  { pattern: /\bchown\s+.*\s+\//i,       reason: '禁止根目录 chown' },
  { pattern: /\bvisudo\b/i,              reason: '禁止编辑 sudoers' },

  // 网络危险操作
  { pattern: /\biptables\s+(-[a-z]*\s+)*-F\b/i, reason: '禁止清空防火墙规则' },
  { pattern: /\bnft\s+flush\b/i,         reason: '禁止清空 nftables' },
  { pattern: /\bifconfig\s+.*\s+down\b/i, reason: '禁止关闭网卡' },
  { pattern: /\bip\s+link\s+.*\s+down\b/i, reason: '禁止关闭网卡' },

  // 包管理危险操作
  { pattern: /\b(yum|apt|dnf|rpm)\s+(remove|purge|erase)\b/i, reason: '禁止卸载软件包' },

  // 危险 shell 操作
  { pattern: />\s*\/dev\/sd[a-z]/i,     reason: '禁止覆写磁盘设备' },
  { pattern: /\|\s*bash\b/i,             reason: '禁止管道到 bash（远程代码执行风险）' },
  { pattern: /\bcurl\b.*\|\s*(sh|bash)/i, reason: '禁止 curl 管道执行' },
  { pattern: /\bwget\b.*\|\s*(sh|bash)/i, reason: '禁止 wget 管道执行' },
  { pattern: /:(\\){\s*:|\\(\)\{)/,        reason: '禁止 fork 炸弹' },
  { pattern: /\beval\b/i,                reason: '禁止 eval（代码注入风险）' },
  { pattern: /\bnohup\b/i,               reason: '禁止后台驻留进程' },

  // 内核/系统核心
  { pattern: /\binsmod\b|\brmmod\b|\bmodprobe\s+-r\b/i, reason: '禁止内核模块操作' },
  { pattern: /\/proc\/sys|sysctl\s+-w/i, reason: '禁止修改内核参数' },
  { pattern: /\bkill\s+(-9\s+)?(-1|1)\b/i, reason: '禁止杀死所有进程' },
  { pattern: /\bkillall\b/i,             reason: '禁止批量杀进程' },
];

/**
 * 反混淆预处理 — 去除变量展开、反引号等包裹
 */
function normalize(cmd: string): string {
  return cmd
    .replace(/\$\{[^}]*\}/g, '')   // 去掉 ${...}
    .replace(/\$\([^)]*\)/g, '')   // 去掉 $(...)
    .replace(/`[^`]*`/g, '')       // 去掉 `...`
    .replace(/\\/g, '');            // 去掉反斜杠转义
}

/**
 * 命令安全检查 — 匹配黑名单
 * @param cmd 待检查的命令字符串
 * @returns 拦截时返回 { blocked: true, reason: string }，安全时返回 null
 */
function checkCommandSafety(cmd: string): { blocked: boolean; reason: string } | null {
  const normalized = normalize(cmd);

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(normalized) || pattern.test(cmd)) {
      return { blocked: true, reason };
    }
  }
  return null;
}

module.exports = { BLOCKED_PATTERNS, checkCommandSafety, normalize };
export {}; // CJS 模块标记
