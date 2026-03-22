'use strict';

const express = require('express');
const crypto = require('crypto');

/**
 * 技能注册表 REST API
 *
 * GET  /api/skills          — 列表（支持 ?category= &search= 查询）
 * POST /api/skills          — 上传新技能（JSON body 或 SKILL.md 内容）
 * DELETE /api/skills/:id    — 删除用户上传的技能
 */
function createSkillsRouter(skillsStore: any) {
  const router = express.Router();

  // GET /api/skills — 列表
  router.get('/', (req: any, res: any) => {
    try {
      const { category, search } = req.query;

      let skills;
      if (search) {
        skills = skillsStore.search(search);
      } else {
        skills = skillsStore.all();
      }

      // 分类过滤
      if (category && category !== 'all') {
        skills = skills.filter((s: any) => s.category === category);
      }

      res.json({ skills, total: skills.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/skills — 上传新技能
  router.post('/', (req: any, res: any) => {
    try {
      const { name, description, category, version, author, icon, iconGradient, installType, skillContent, source } = req.body;

      if (!name) {
        return res.status(400).json({ error: '技能名称不能为空' });
      }

      // 解析 SKILL.md 内容的 YAML frontmatter（如有）
      let parsedMeta: any = {};
      if (skillContent) {
        parsedMeta = parseSkillMd(skillContent);
      }

      const skill = skillsStore.create({
        id: crypto.randomUUID(),
        name: parsedMeta.name || name,
        description: parsedMeta.description || description || '',
        category: category || 'ai',
        version: version || 'v1.0',
        author: author || 'User',
        icon: icon || 'package',
        iconGradient: iconGradient || 'linear-gradient(135deg, #6366f1 0%, #a5b4fc 100%)',
        installType: installType || 'prompt',
        skillContent: skillContent || '',
        source: source || 'custom',
        isBuiltin: false,
      });

      res.json({ skill });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/skills/:id — 删除用户上传的技能
  router.delete('/:id', (req: any, res: any) => {
    try {
      const skill = skillsStore.findById(req.params.id);
      if (!skill) {
        return res.status(404).json({ error: '技能不存在' });
      }
      if (skill.isBuiltin) {
        return res.status(403).json({ error: '内置技能不可删除' });
      }

      const deleted = skillsStore.delete(req.params.id);
      res.json({ deleted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * 解析 SKILL.md 的 YAML frontmatter
 * 格式：
 * ---
 * name: xxx
 * description: yyy
 * ---
 * # Body content...
 */
function parseSkillMd(content: string): any {
  const meta: any = {};
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return meta;

  const fmLines = fmMatch[1].split('\n');
  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.substring(0, colonIdx).trim();
    const value = line.substring(colonIdx + 1).trim();
    if (key && value) {
      meta[key] = value;
    }
  }

  return meta;
}

module.exports = createSkillsRouter;
export {};
