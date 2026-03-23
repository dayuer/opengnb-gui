'use strict';

/**
 * 技能命令策略注册表
 *
 * 将 routes/nodes.ts 中的 7 层 if-else 安装/卸载命令生成
 * 重构为「以多态取代条件表达式」的策略 Map。
 *
 * 每个策略接收 SkillContext 返回命令字符串，
 * 路由层只做查表 + 分发，不再关心具体命令格式。
 */

interface SkillContext {
  skillId: string;
  source: string;
  slug?: string;
  githubRepo?: string;
  name?: string;
  version?: string;
}

interface InstallResult {
  command: string;
  skip?: boolean;
  error?: boolean;
  message?: string;
}

// ═══════════════════════════════════════
// 安装策略
// ═══════════════════════════════════════

type InstallStrategy = (ctx: SkillContext) => InstallResult;

const INSTALL_STRATEGIES: Record<string, InstallStrategy> = {
  'openclaw-bundled': (ctx) => ({
    command: `openclaw plugins enable ${ctx.skillId}`,
    skip: false,
  }),

  'clawhub': (ctx) => ({
    command: `clawhub install ${ctx.skillId}`,
    skip: false,
  }),

  'github': (ctx) => ({
    command: `openclaw plugins install github:${ctx.githubRepo || ctx.skillId}`,
    skip: false,
  }),

  'openclaw': (ctx) => ({
    command: [
      `openclaw plugins install ${ctx.skillId}`,
      `ALLOW=$(openclaw config get plugins.allow 2>/dev/null || echo '[]')`,
      `UPDATED=$(echo "$ALLOW" | jq --arg p "${ctx.skillId}" 'if type == "array" then . + [$p] | unique else [$p] end')`,
      `openclaw config set plugins.allow "$UPDATED" --strict-json`,
    ].join(' && '),
    skip: false,
  }),

  'skills.sh': (ctx) => ({
    command: `npx -y skills add ${ctx.slug || ctx.skillId}`,
    skip: false,
  }),

  'npm': (ctx) => ({
    command: `npm install -g ${ctx.skillId} --registry=https://registry.npmmirror.com`,
    skip: false,
  }),

  'console': (_ctx) => ({
    command: '',
    skip: true,
    message: '平台内置技能，无需远程安装',
  }),
};

/**
 * 生成安装命令
 *
 * @returns InstallResult — { command, skip?, error?, message? }
 */
function buildInstallCommand(ctx: SkillContext): InstallResult {
  const strategy = INSTALL_STRATEGIES[ctx.source];
  if (strategy) return strategy(ctx);

  // HTTP URL 源 — 动态匹配
  if (ctx.source.startsWith('http')) {
    return { command: `curl -sSL ${ctx.source} | bash`, skip: false };
  }

  return { command: '', error: true, message: `不支持的安装源: ${ctx.source}` };
}

// ═══════════════════════════════════════
// 卸载策略
// ═══════════════════════════════════════

type UninstallStrategy = (skillId: string) => string;

const UNINSTALL_STRATEGIES: Record<string, UninstallStrategy> = {
  'clawhub': (id) => `clawhub uninstall ${id}`,

  'github': (id) => `openclaw plugins uninstall ${id}`,

  'openclaw': (id) => [
    `openclaw plugins uninstall ${id}`,
    `ALLOW=$(openclaw config get plugins.allow 2>/dev/null || echo '[]')`,
    `UPDATED=$(echo "$ALLOW" | jq --arg p "${id}" 'if type == "array" then [.[] | select(. != $p)] else [] end')`,
    `openclaw config set plugins.allow "$UPDATED" --strict-json`,
  ].join(' && '),
};

/**
 * 生成卸载命令
 *
 * @param ctx - { skillId, source }
 * @returns 卸载命令字符串
 */
function buildUninstallCommand(ctx: { skillId: string; source: string }): string {
  const strategy = UNINSTALL_STRATEGIES[ctx.source];
  if (strategy) return strategy(ctx.skillId);

  // 默认（含 openclaw-bundled 和未知 source）用 disable
  return `openclaw plugins disable ${ctx.skillId}`;
}

module.exports = { buildInstallCommand, buildUninstallCommand };
export {};
