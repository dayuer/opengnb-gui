'use strict';

const express = require('express');
const { createLogger } = require('../services/logger');
const log = createLogger('ClawHub');

/**
 * ClawHub 代理 API — 搜索/获取 ClawHub 技能详情
 *
 * GET  /api/clawhub/search?q=browser&page=1  — 搜索技能
 * GET  /api/clawhub/featured                  — 热门推荐
 * GET  /api/clawhub/skill/:id                 — 技能详情
 *
 * 后端代理 + 内存 LRU 缓存（5min TTL）。
 */

// ═══════════════════════════════════════════
//  内存 LRU 缓存
// ═══════════════════════════════════════════
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟
const CACHE_MAX = 100;

interface CacheEntry {
  data: any;
  ts: number;
}

const _cache = new Map<string, CacheEntry>();

function cacheGet(key: string): any | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key: string, data: any): void {
  // 简易 LRU：超限时删除最老的
  if (_cache.size >= CACHE_MAX) {
    const firstKey = _cache.keys().next().value;
    if (firstKey) _cache.delete(firstKey);
  }
  _cache.set(key, { data, ts: Date.now() });
}

// ═══════════════════════════════════════════
//  ClawHub API 调用
// ═══════════════════════════════════════════
const CLAWHUB_API = 'https://clawhub.com/api';

/**
 * 通过 ClawHub REST API 搜索技能
 * 回退：使用 clawhub CLI 的 --json 输出
 */
async function searchClawHub(query: string, page: number = 1): Promise<any> {
  const cacheKey = `search:${query}:${page}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    // 方案 A：直接调 ClawHub REST API
    const url = `${CLAWHUB_API}/skills/search?q=${encodeURIComponent(query)}&page=${page}&limit=20`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'SynonClaw-Console/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (resp.ok) {
      const data = await resp.json();
      const result = normalizeClawHubResults(data);
      cacheSet(cacheKey, result);
      return result;
    }

    // 方案 B：回退到 CLI（如果 REST API 不可用）
    log.warn(`ClawHub API 返回 ${resp.status}，回退到 CLI`);
    return await searchViaCLI(query);
  } catch (err: any) {
    log.warn(`ClawHub API 请求失败: ${err.message}，回退到 CLI`);
    return await searchViaCLI(query);
  }
}

/**
 * 通过 clawhub CLI 搜索（解析文本输出，格式：`slug  Name  (score)`）
 */
async function searchViaCLI(query: string): Promise<any> {
  const cacheKey = `cli-search:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const { execSync } = require('child_process');
  try {
    const output = execSync(`clawhub search "${query.replace(/"/g, '\\"')}" --limit 20 --no-input 2>&1`, {
      timeout: 15000,
      encoding: 'utf-8',
    });
    const skills = parseCLISearchOutput(output);
    const result = {
      skills,
      total: skills.length,
      source: 'cli',
    };
    cacheSet(cacheKey, result);
    return result;
  } catch (err: any) {
    log.error(`clawhub CLI 搜索失败: ${err.message}`);
    return { skills: [], total: 0, source: 'cli-error', error: err.message };
  }
}

/**
 * 解析 CLI search 文本输出
 * 格式示例：
 *   - Searching
 *   agent-browser-clawdbot  Agent Browser  (3.783)
 *   browser-automation  Browser Automation  (3.749)
 */
function parseCLISearchOutput(output: string): any[] {
  const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('-') && !l.startsWith('error'));
  return lines.map(line => {
    //  格式: slug\s\s+Name\s\s+(score)
    const match = line.match(/^(\S+)\s{2,}(.+?)\s+\((\d+\.\d+)\)\s*$/);
    if (!match) return null;
    const [, slug, name, score] = match;
    return {
      id: slug,
      name: name.trim(),
      version: 'latest',
      author: '',
      description: '',
      category: 'ai',
      icon: 'package',
      iconGradient: 'linear-gradient(135deg, #6366f1 0%, #a5b4fc 100%)',
      rating: parseFloat(score),
      installs: 0,
      source: 'clawhub',
      slug,
      installType: 'prompt',
    };
  }).filter(Boolean);
}

/**
 * 获取单个技能详情（解析 `clawhub inspect` 文本输出）
 */
async function getSkillDetail(skillId: string): Promise<any> {
  const cacheKey = `detail:${skillId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const url = `${CLAWHUB_API}/skills/${encodeURIComponent(skillId)}`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'SynonClaw-Console/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (resp.ok) {
      const data = await resp.json();
      const skill = normalizeSkill(data);
      cacheSet(cacheKey, skill);
      return skill;
    }

    // CLI 回退：解析 clawhub inspect 文本输出
    const { execSync } = require('child_process');
    const output = execSync(`clawhub inspect "${skillId.replace(/"/g, '\\"')}" --no-input 2>&1`, {
      timeout: 15000,
      encoding: 'utf-8',
    });
    const skill = parseCLIInspectOutput(output, skillId);
    if (skill) cacheSet(cacheKey, skill);
    return skill;
  } catch (err: any) {
    return null;
  }
}

/**
 * 解析 CLI inspect 文本输出
 * 格式示例：
 *   agent-browser-clawdbot  Agent Browser
 *   Summary: Headless browser automation CLI...
 *   Owner: matrixy
 *   Created: 2026-01-21...
 *   Latest: 0.1.0
 *   License: MIT-0
 */
function parseCLIInspectOutput(output: string, fallbackId: string): any {
  const lines = output.split('\n').filter(l => l.trim() && !l.startsWith('-'));
  if (lines.length === 0) return null;

  // 第一行：slug  Name
  const headerMatch = lines[0]?.match(/^(\S+)\s{2,}(.+)$/);
  const meta: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.substring(0, idx).trim().toLowerCase();
      const val = line.substring(idx + 1).trim();
      meta[key] = val;
    }
  }

  return {
    id: headerMatch?.[1] || fallbackId,
    name: headerMatch?.[2]?.trim() || meta['name'] || fallbackId,
    version: meta['latest'] || 'latest',
    author: meta['owner'] || '',
    description: meta['summary'] || '',
    category: 'ai',
    icon: 'package',
    iconGradient: 'linear-gradient(135deg, #6366f1 0%, #a5b4fc 100%)',
    rating: 0,
    installs: 0,
    source: 'clawhub',
    slug: headerMatch?.[1] || fallbackId,
    installType: 'prompt',
    license: meta['license'] || '',
    updatedAt: meta['updated'] || '',
  };
}

/**
 * 获取热门/推荐技能（优先 REST API，回退 `clawhub explore`）
 */
async function getFeatured(): Promise<any> {
  const cacheKey = 'featured';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const url = `${CLAWHUB_API}/skills/featured?limit=20`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'SynonClaw-Console/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (resp.ok) {
      const data = await resp.json();
      const result = normalizeClawHubResults(data);
      cacheSet(cacheKey, result);
      return result;
    }

    // 回退：用 clawhub explore 获取最新技能
    return await exploreViaCLI();
  } catch (err: any) {
    return await exploreViaCLI();
  }
}

/** 通过 `clawhub explore` 获取最新更新的技能 */
async function exploreViaCLI(): Promise<any> {
  const cacheKey = 'explore-cli';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const { execSync } = require('child_process');
  try {
    const output = execSync('clawhub explore --limit 20 --no-input 2>&1', {
      timeout: 15000,
      encoding: 'utf-8',
    });
    // explore 输出格式类似 search
    const skills = parseCLISearchOutput(output);
    const result = { skills, total: skills.length, source: 'cli' };
    cacheSet(cacheKey, result);
    return result;
  } catch {
    return { skills: [], total: 0, source: 'cli-error' };
  }
}

// ═══════════════════════════════════════════
//  数据标准化
// ═══════════════════════════════════════════

/** 标准化 ClawHub API 返回结果为统一格式 */
function normalizeClawHubResults(data: any): any {
  const skills = Array.isArray(data?.skills || data?.results || data)
    ? (data?.skills || data?.results || data).map(normalizeSkill)
    : [];
  return {
    skills,
    total: data?.total || data?.totalCount || skills.length,
    page: data?.page || 1,
    source: 'api',
  };
}

/** 标准化单个技能对象 */
function normalizeSkill(raw: any): any {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: raw.id || raw.name || raw.slug || '',
    name: raw.name || raw.displayName || raw.title || raw.id || '',
    version: raw.version || raw.latestVersion || 'latest',
    author: raw.author || raw.publisher || raw.maintainer || '',
    description: raw.description || raw.summary || '',
    category: raw.category || raw.tags?.[0] || 'ai',
    icon: raw.icon || 'package',
    iconGradient: raw.iconGradient || 'linear-gradient(135deg, #6366f1 0%, #a5b4fc 100%)',
    rating: Number(raw.rating || raw.stars || 0),
    installs: Number(raw.installs || raw.downloads || raw.installCount || 0),
    source: 'clawhub',
    slug: raw.slug || raw.id || '',
    installType: 'prompt',
    // ClawHub 特有字段
    readme: raw.readme || '',
    homepage: raw.homepage || raw.url || '',
    repository: raw.repository || raw.repo || '',
    tags: raw.tags || [],
    updatedAt: raw.updatedAt || raw.lastPublished || '',
  };
}

// ═══════════════════════════════════════════
//  Express 路由
// ═══════════════════════════════════════════

function createClawHubRouter() {
  const router = express.Router();

  // GET /api/clawhub/search?q=browser&page=1
  router.get('/search', async (req: any, res: any) => {
    try {
      const { q, page } = req.query;
      if (!q || String(q).trim().length === 0) {
        return res.status(400).json({ error: '搜索关键词不能为空' });
      }
      const result = await searchClawHub(String(q).trim(), parseInt(page) || 1);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/clawhub/featured
  router.get('/featured', async (_req: any, res: any) => {
    try {
      const result = await getFeatured();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/clawhub/skill/:id
  router.get('/skill/:id', async (req: any, res: any) => {
    try {
      const skill = await getSkillDetail(req.params.id);
      if (!skill) {
        return res.status(404).json({ error: '技能不存在' });
      }
      res.json({ skill });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/clawhub/cache-stats
  router.get('/cache-stats', (_req: any, res: any) => {
    res.json({
      size: _cache.size,
      max: CACHE_MAX,
      ttlMs: CACHE_TTL,
    });
  });

  return router;
}

module.exports = createClawHubRouter;
export {};
