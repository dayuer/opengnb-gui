#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# pack-openclaw.sh — 打包 OpenClaw 到 Console 镜像目录
#
# 在 Console 服务器上执行，生成 .tgz 供节点离线安装：
#   bash scripts/pack-openclaw.sh
#
# 节点安装时，provisioner 自动从 /api/mirror/openclaw/ 下载
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MIRROR_DIR="${PROJECT_DIR}/data/mirror/openclaw"

mkdir -p "$MIRROR_DIR"

echo "═══════════════════════════════════════"
echo " OpenClaw 镜像打包工具"
echo "═══════════════════════════════════════"
echo ""

# 检查 npm 是否可用
if ! command -v npm &>/dev/null; then
    echo "[错误] npm 未安装"
    exit 1
fi

# 获取最新版本号
echo "[1/3] 获取 openclaw 最新版本..."
VERSION=$(npm view openclaw version 2>/dev/null || echo "")
if [ -z "$VERSION" ]; then
    echo "[错误] 无法获取 openclaw 版本信息"
    echo "       确保网络可访问 npm registry"
    exit 1
fi
echo "      版本: $VERSION"

# 检查是否已有相同版本
TARGET_FILE="${MIRROR_DIR}/openclaw-${VERSION}.tgz"
if [ -f "$TARGET_FILE" ]; then
    echo "      ✅ 镜像已存在: $(basename "$TARGET_FILE") ($(du -h "$TARGET_FILE" | cut -f1))"
    echo "$VERSION" > "${MIRROR_DIR}/.version"
    exit 0
fi

# 打包下载
echo "[2/3] 下载并打包 openclaw@${VERSION}..."
cd /tmp
rm -rf openclaw-pack && mkdir openclaw-pack && cd openclaw-pack

npm pack "openclaw@${VERSION}" --quiet 2>/dev/null
PACK_FILE=$(ls *.tgz 2>/dev/null | head -1)

if [ -z "$PACK_FILE" ]; then
    echo "[错误] npm pack 失败"
    exit 1
fi

# 复制到镜像目录
echo "[3/3] 复制到镜像目录..."
cp "$PACK_FILE" "$TARGET_FILE"
echo "$VERSION" > "${MIRROR_DIR}/.version"

# 清理旧版本（保留最新 3 个）
cd "$MIRROR_DIR"
ls -t openclaw-*.tgz 2>/dev/null | tail -n +4 | xargs rm -f 2>/dev/null || true

# 清理临时文件
rm -rf /tmp/openclaw-pack

SIZE=$(du -h "$TARGET_FILE" | cut -f1)
echo ""
echo "═══════════════════════════════════════"
echo " ✅ 打包完成"
echo " 文件: $TARGET_FILE"
echo " 大小: $SIZE"
echo " 版本: $VERSION"
echo ""
echo " 节点将从以下地址下载:"
echo " GET /api/mirror/openclaw/openclaw-${VERSION}.tgz"
echo "═══════════════════════════════════════"
