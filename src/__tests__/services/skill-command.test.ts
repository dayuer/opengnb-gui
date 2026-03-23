'use strict';

// @alpha: 技能命令策略模式测试 — 覆盖安装/卸载命令生成

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('services/skill-command', () => {
  // @alpha: 引入尚未存在的模块 — RED 阶段必然失败
  const { buildInstallCommand, buildUninstallCommand } = require('../../services/skill-command');

  // ═══════════════════════════════════════
  // 安装命令生成
  // ═══════════════════════════════════════

  describe('buildInstallCommand', () => {
    it('should generate openclaw enable for openclaw-bundled source', () => {
      const result = buildInstallCommand({ skillId: 'slack', source: 'openclaw-bundled' });
      assert.equal(result.command, 'openclaw plugins enable slack');
      assert.equal(result.skip, false);
    });

    it('should generate clawhub install for clawhub source', () => {
      const result = buildInstallCommand({ skillId: 'agent-browser', source: 'clawhub' });
      assert.equal(result.command, 'clawhub install agent-browser');
    });

    it('should generate openclaw install github: for github source', () => {
      const result = buildInstallCommand({ skillId: 'my-plugin', source: 'github', githubRepo: 'user/repo' });
      assert.equal(result.command, 'openclaw plugins install github:user/repo');
    });

    it('should fallback to skillId when githubRepo missing', () => {
      const result = buildInstallCommand({ skillId: 'my-plugin', source: 'github' });
      assert.equal(result.command, 'openclaw plugins install github:my-plugin');
    });

    it('should generate compound openclaw command for openclaw source', () => {
      const result = buildInstallCommand({ skillId: 'my-ext', source: 'openclaw' });
      assert.ok(result.command.includes('openclaw plugins install my-ext'));
      assert.ok(result.command.includes('openclaw config set plugins.allow'));
    });

    it('should generate npx skills add for skills.sh source', () => {
      const result = buildInstallCommand({ skillId: 'agent-tools', source: 'skills.sh', slug: 'inferen-sh/skills@agent-tools' });
      assert.equal(result.command, 'npx -y skills add inferen-sh/skills@agent-tools');
    });

    it('should fallback to skillId as slug for skills.sh', () => {
      const result = buildInstallCommand({ skillId: 'agent-tools', source: 'skills.sh' });
      assert.equal(result.command, 'npx -y skills add agent-tools');
    });

    it('should generate npm install -g for npm source', () => {
      const result = buildInstallCommand({ skillId: '@ollama/web-search', source: 'npm' });
      assert.ok(result.command.includes('npm install -g @ollama/web-search'));
    });

    it('should mark console source as skip (no remote install needed)', () => {
      const result = buildInstallCommand({ skillId: 'claude-code', source: 'console' });
      assert.equal(result.skip, true);
      assert.equal(result.command, '');
    });

    it('should generate curl | bash for HTTP URL source', () => {
      const result = buildInstallCommand({ skillId: 'custom', source: 'https://example.com/install.sh' });
      assert.ok(result.command.includes('curl -sSL https://example.com/install.sh | bash'));
    });

    it('should return error for unknown source', () => {
      const result = buildInstallCommand({ skillId: 'bad', source: 'ftp' });
      assert.equal(result.error, true);
    });
  });

  // ═══════════════════════════════════════
  // 卸载命令生成
  // ═══════════════════════════════════════

  describe('buildUninstallCommand', () => {
    it('should generate clawhub uninstall for clawhub source', () => {
      const cmd = buildUninstallCommand({ skillId: 'agent-browser', source: 'clawhub' });
      assert.equal(cmd, 'clawhub uninstall agent-browser');
    });

    it('should generate openclaw uninstall for github source', () => {
      const cmd = buildUninstallCommand({ skillId: 'my-plugin', source: 'github' });
      assert.equal(cmd, 'openclaw plugins uninstall my-plugin');
    });

    it('should generate compound openclaw uninstall for openclaw source', () => {
      const cmd = buildUninstallCommand({ skillId: 'my-ext', source: 'openclaw' });
      assert.ok(cmd.includes('openclaw plugins uninstall my-ext'));
      assert.ok(cmd.includes('openclaw config set plugins.allow'));
    });

    it('should generate openclaw disable for default/bundled source', () => {
      const cmd = buildUninstallCommand({ skillId: 'slack', source: 'openclaw-bundled' });
      assert.equal(cmd, 'openclaw plugins disable slack');
    });

    it('should generate openclaw disable for unknown source', () => {
      const cmd = buildUninstallCommand({ skillId: 'unknown', source: '' });
      assert.equal(cmd, 'openclaw plugins disable unknown');
    });
  });
});
