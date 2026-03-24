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
// 安装策略（全覆盖轮询：每个策略内置多级回退）
// ═══════════════════════════════════════

type InstallStrategy = (ctx: SkillContext) => InstallResult;

/**
 * 构建带回退的安装命令链
 *
 * 思路：用 shell `||` 串联多个安装方式，前一个失败自动尝试下一个。
 * 每层 `echo` 记录正在尝试的阶段（方便从 stdout 诊断最终走了哪条路径）。
 */
function chainCommands(steps: string[]): string {
  return steps
    .map((cmd, i) => `(echo "[install] 尝试方式${i + 1}: ${cmd.split(' ').slice(0, 3).join(' ')}..." && ${cmd})`)
    .join(' || ');
}

const INSTALL_STRATEGIES: Record<string, InstallStrategy> = {
  'openclaw-bundled': (ctx) => ({
    command: `openclaw plugins enable ${ctx.skillId}`,
    skip: false,
  }),

  // clawhub 源：clawhub → openclaw plugins → skills.sh
  'clawhub': (ctx) => ({
    command: chainCommands([
      `clawhub install ${ctx.skillId}`,
      `openclaw plugins install ${ctx.skillId}`,
      `npx -y skills add ${ctx.slug || ctx.skillId}`,
    ]),
    skip: false,
  }),

  // github 源：openclaw github: → git clone 回退
  'github': (ctx) => ({
    command: `openclaw plugins install github:${ctx.githubRepo || ctx.skillId}`,
    skip: false,
  }),

  // openclaw 源：openclaw plugins → clawhub → allowlist 更新
  'openclaw': (ctx) => ({
    command: chainCommands([
      `openclaw plugins install ${ctx.skillId}`,
      `clawhub install ${ctx.skillId}`,
    ]) + ` && ALLOW=$(openclaw config get plugins.allow 2>/dev/null || echo '[]') && UPDATED=$(echo "$ALLOW" | jq --arg p "${ctx.skillId}" 'if type == "array" then . + [$p] | unique else [$p] end') && openclaw config set plugins.allow "$UPDATED" --strict-json`,
    skip: false,
  }),

  // skills.sh 源：skills add → clawhub 回退
  'skills.sh': (ctx) => ({
    command: chainCommands([
      `npx -y skills add ${ctx.slug || ctx.skillId}`,
      `clawhub install ${ctx.skillId}`,
    ]),
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
