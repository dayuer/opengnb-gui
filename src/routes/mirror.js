'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');

/**
 * 软件镜像下载 API
 * 为无法访问 GitHub 的终端节点提供 GNB / OpenClaw 下载
 *
 * GET /api/mirror/gnb          → 文件列表
 * GET /api/mirror/gnb/:file    → 下载文件
 * GET /api/mirror/openclaw     → 文件列表
 * GET /api/mirror/openclaw/:file → 下载文件
 */
function createMirrorRouter(dataDir) {
  const router = express.Router();
  const mirrorDir = path.join(dataDir, 'mirror');

  /** 列出目录下的文件 */
  function listFiles(subDir) {
    const dir = path.join(mirrorDir, subDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f));
        return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
      });
  }

  // GET /api/mirror/gnb — GNB 文件列表
  router.get('/gnb', (req, res) => {
    const verFile = path.join(mirrorDir, 'gnb', '.version');
    const version = fs.existsSync(verFile) ? fs.readFileSync(verFile, 'utf-8').trim() : 'unknown';
    res.json({ software: 'gnb', version, files: listFiles('gnb') });
  });

  // GET /api/mirror/gnb/:file — 下载 GNB 文件
  router.get('/gnb/:file', (req, res) => {
    const filePath = path.join(mirrorDir, 'gnb', path.basename(req.params.file));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    res.download(filePath);
  });

  // GET /api/mirror/openclaw — OpenClaw 文件列表
  router.get('/openclaw', (req, res) => {
    const verFile = path.join(mirrorDir, 'openclaw', '.version');
    const version = fs.existsSync(verFile) ? fs.readFileSync(verFile, 'utf-8').trim() : 'unknown';
    res.json({ software: 'openclaw', version, files: listFiles('openclaw') });
  });

  // GET /api/mirror/openclaw/:file — 下载 OpenClaw 文件
  router.get('/openclaw/:file', (req, res) => {
    const filePath = path.join(mirrorDir, 'openclaw', path.basename(req.params.file));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: '文件不存在' });
    res.download(filePath);
  });

  return router;
}

module.exports = createMirrorRouter;
