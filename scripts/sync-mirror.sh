#!/bin/bash
# GNB Console — 软件镜像同步脚本
#
# 从 GitHub 下载 GNB 和 OpenClaw 发布包到本地 mirror 目录
# 供无法访问 GitHub 的终端节点通过 Console API 下载
#
# 用法:
#   ./scripts/sync-mirror.sh [--force]
#
# 定时执行（建议每天一次）:
#   0 5 * * * /opt/gnb-console/scripts/sync-mirror.sh >> /var/log/mirror-sync.log 2>&1

set -euo pipefail

MIRROR_DIR="${MIRROR_DIR:-$(dirname "$0")/../data/mirror}"
mkdir -p "$MIRROR_DIR/gnb" "$MIRROR_DIR/openclaw"

FORCE="${1:-}"

echo "[$(date)] 开始同步镜像..."

# --- GNB ---
echo "[GNB] 检查最新 release..."
GNB_API="https://api.github.com/repos/opengnb/opengnb/releases/latest"
GNB_META=$(curl -sSL "$GNB_API" 2>/dev/null || echo '{}')
GNB_TAG=$(echo "$GNB_META" | python3 -c "import sys,json;print(json.load(sys.stdin).get('tag_name',''))" 2>/dev/null || echo "")
GNB_VER_FILE="$MIRROR_DIR/gnb/.version"

if [ -z "$GNB_TAG" ]; then
    echo "[GNB] 无法获取版本信息（GitHub API 不可达？）"
    echo "[GNB] 尝试下载源码打包..."
    if [ ! -f "$MIRROR_DIR/gnb/opengnb-src.tar.gz" ] || [ "$FORCE" = "--force" ]; then
        curl -sSL "https://github.com/opengnb/opengnb/archive/refs/heads/master.tar.gz" \
            -o "$MIRROR_DIR/gnb/opengnb-src.tar.gz" 2>/dev/null || echo "[GNB] 源码下载也失败了"
    fi
else
    CURRENT_VER=$(cat "$GNB_VER_FILE" 2>/dev/null || echo "")
    if [ "$GNB_TAG" = "$CURRENT_VER" ] && [ "$FORCE" != "--force" ]; then
        echo "[GNB] 已是最新: $GNB_TAG"
    else
        echo "[GNB] 下载 $GNB_TAG ..."
        # 下载源码 tarball（通用，终端自行编译）
        curl -sSL "https://github.com/opengnb/opengnb/archive/refs/tags/${GNB_TAG}.tar.gz" \
            -o "$MIRROR_DIR/gnb/opengnb-src.tar.gz"

        # 下载预编译二进制（如有）
        ASSETS=$(echo "$GNB_META" | python3 -c "
import sys, json
assets = json.load(sys.stdin).get('assets', [])
for a in assets:
    print(a['name'] + '|' + a['browser_download_url'])
" 2>/dev/null || echo "")

        if [ -n "$ASSETS" ]; then
            echo "$ASSETS" | while IFS='|' read -r name url; do
                echo "  下载: $name"
                curl -sSL "$url" -o "$MIRROR_DIR/gnb/$name"
            done
        fi

        echo "$GNB_TAG" > "$GNB_VER_FILE"
        echo "[GNB] 同步完成: $GNB_TAG"
    fi
fi

# --- OpenClaw ---
echo "[OpenClaw] 检查最新 release..."
CLAW_API="https://api.github.com/repos/nicennnnnnnlee/OpenClaw/releases/latest"
CLAW_META=$(curl -sSL "$CLAW_API" 2>/dev/null || echo '{}')
CLAW_TAG=$(echo "$CLAW_META" | python3 -c "import sys,json;print(json.load(sys.stdin).get('tag_name',''))" 2>/dev/null || echo "")
CLAW_VER_FILE="$MIRROR_DIR/openclaw/.version"

if [ -z "$CLAW_TAG" ]; then
    echo "[OpenClaw] 无法获取版本信息"
else
    CURRENT_VER=$(cat "$CLAW_VER_FILE" 2>/dev/null || echo "")
    if [ "$CLAW_TAG" = "$CURRENT_VER" ] && [ "$FORCE" != "--force" ]; then
        echo "[OpenClaw] 已是最新: $CLAW_TAG"
    else
        echo "[OpenClaw] 下载 $CLAW_TAG ..."
        curl -sSL "https://github.com/nicennnnnnnlee/OpenClaw/archive/refs/tags/${CLAW_TAG}.tar.gz" \
            -o "$MIRROR_DIR/openclaw/openclaw-src.tar.gz"

        ASSETS=$(echo "$CLAW_META" | python3 -c "
import sys, json
assets = json.load(sys.stdin).get('assets', [])
for a in assets:
    print(a['name'] + '|' + a['browser_download_url'])
" 2>/dev/null || echo "")

        if [ -n "$ASSETS" ]; then
            echo "$ASSETS" | while IFS='|' read -r name url; do
                echo "  下载: $name"
                curl -sSL "$url" -o "$MIRROR_DIR/openclaw/$name"
            done
        fi

        echo "$CLAW_TAG" > "$CLAW_VER_FILE"
        echo "[OpenClaw] 同步完成: $CLAW_TAG"
    fi
fi

# --- 清单 ---
echo ""
echo "=== 镜像清单 ==="
echo "GNB:"
ls -lh "$MIRROR_DIR/gnb/" 2>/dev/null
echo ""
echo "OpenClaw:"
ls -lh "$MIRROR_DIR/openclaw/" 2>/dev/null
echo ""
echo "[$(date)] 同步完成"
