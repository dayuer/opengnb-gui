'use strict';

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { createLogger } = require('./logger');
const log = createLogger('MirrorUpdater');

/**
 * OpenClaw 镜像自动更新服务
 *
 * 启动时检查一次，之后每 24h 检查 npm registry 是否有新版本。
 * 若有新版本，自动 `npm pack` 到 data/mirror/openclaw/。
 */
class MirrorUpdater {
  mirrorDir: string;
  intervalMs: number;
  _timer: any;

  constructor(dataDir: string, options: any = {}) {
    this.mirrorDir = path.join(dataDir, 'mirror', 'openclaw');
    this.intervalMs = options.intervalMs || 86400000;
    this._timer = null;
  }

  /**
   * 启动：立即检查一次 + 定时器
   */
  start() {
    fs.mkdirSync(this.mirrorDir, { recursive: true });
    // 延迟 30s 执行首次检查（不阻塞启动）
    setTimeout(() => this._check(), 30000);
    this._timer = setInterval(() => this._check(), this.intervalMs);
    log.info(`已启动，每 ${Math.round(this.intervalMs / 3600000)}h 检查 openclaw 更新`);
  }

  /**
   * 停止定时器
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * 检查并更新镜像
   * @private
   */
  async _check() {
    try {
      // 读取本地版本
      const versionFile = path.join(this.mirrorDir, '.version');
      const localVer = fs.existsSync(versionFile)
        ? fs.readFileSync(versionFile, 'utf-8').trim()
        : '';

      // 查询 npm registry 最新版本
      const remoteVer = await this._npmLatestVersion('openclaw');
      if (!remoteVer) {
        log.warn('无法获取 openclaw 最新版本（网络不通？），跳过');
        return;
      }

      if (remoteVer === localVer) {
        log.info(`openclaw@${localVer} 已是最新`);
        return;
      }

      log.info(`发现新版本 openclaw@${remoteVer} (本地: ${localVer || '无'})`);
      await this._pack(remoteVer);
    } catch (err: any) {
      log.error(`检查失败: ${err.message}`);
    }
  }

  /**
   * 查询 npm registry 最新版本
   * @private
   */
  _npmLatestVersion(pkgName: any) {
    return new Promise((resolve) => {
      execFile('npm', ['view', pkgName, 'version'], { timeout: 15000 }, (err: any, stdout: any) => {
        if (err) return resolve(null);
        resolve((stdout || '').trim());
      });
    });
  }

  /**
   * 执行 npm pack 并保存到镜像目录
   * @private
   */
  _pack(version: any) {
    return new Promise<void>((resolve, reject) => {
      const tmpDir = path.join('/tmp', `openclaw-pack-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      execFile('npm', ['pack', `openclaw@${version}`, '--quiet'], {
        cwd: tmpDir,
        timeout: 120000,
      }, (err: any) => {
        if (err) {
          this._cleanup(tmpDir);
          return reject(new Error(`npm pack 失败: ${err.message}`));
        }

        // 找到生成的 .tgz
        const files = fs.readdirSync(tmpDir).filter((f: any) => f.endsWith('.tgz'));
        if (!files.length) {
          this._cleanup(tmpDir);
          return reject(new Error('npm pack 未生成 .tgz'));
        }

        const src = path.join(tmpDir, files[0]);
        const dst = path.join(this.mirrorDir, `openclaw-${version}.tgz`);
        fs.copyFileSync(src, dst);
        fs.writeFileSync(path.join(this.mirrorDir, '.version'), version);

        // 清理旧版本（保留最近 3 个）
        const allTgz = fs.readdirSync(this.mirrorDir)
          .filter((f: any) => f.startsWith('openclaw-') && f.endsWith('.tgz'))
          .sort()
          .reverse();
        for (const old of allTgz.slice(3)) {
          fs.unlinkSync(path.join(this.mirrorDir, old));
        }

        const size = fs.statSync(dst).size;
        log.info(`✅ openclaw@${version} 已缓存 (${Math.round(size / 1024)}KB)`);
        this._cleanup(tmpDir);
        resolve();
      });
    });
  }

  /** @private */
  _cleanup(dir: string) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { log.debug('清理失败', (_e as Error)?.message); }
  }
}

module.exports = MirrorUpdater;
export {}; // CJS 模块标记
