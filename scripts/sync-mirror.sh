#!/bin/bash
# SynonClaw Console — 软件镜像同步脚本 v2.0
#
# 同步内容：
#   1. GNB 源码 tarball（opengnb-src.tar.gz）
#   2. OpenClaw npm 包（通过 pack-openclaw.sh）
#   3. synon-daemon 预编译 musl 二进制（多架构）
#
# 用法:
#   ./scripts/sync-mirror.sh [--force]
#
# 定时执行（每天一次）:
#   0 5 * * * /opt/gnb-console/scripts/sync-mirror.sh >> /var/log/mirror-sync.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MIRROR_DIR="${MIRROR_DIR:-$PROJECT_DIR/data/mirror}"
mkdir -p "$MIRROR_DIR/gnb" "$MIRROR_DIR/openclaw" "$MIRROR_DIR/daemon"

FORCE="${1:-}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 开始同步镜像..."

# ─────────────────────────────────────────────
# 1. GNB 源码（GitHub releases → tarball）
# ─────────────────────────────────────────────
echo "[GNB] 检查最新版本..."
GNB_API="https://api.github.com/repos/opengnb/opengnb/releases/latest"
GNB_META=$(curl -sSL --max-time 15 "$GNB_API" 2>/dev/null || echo '{}')
GNB_TAG=$(echo "$GNB_META" | python3 -c "import sys,json;print(json.load(sys.stdin).get('tag_name',''))" 2>/dev/null || echo "")
GNB_VER_FILE="$MIRROR_DIR/gnb/.version"

if [ -z "$GNB_TAG" ]; then
    echo "[GNB] GitHub API 不可达，尝试下载 master 分支..."
    if [ ! -f "$MIRROR_DIR/gnb/opengnb-src.tar.gz" ] || [ "$FORCE" = "--force" ]; then
        curl -sSL --max-time 60 \
            "https://github.com/opengnb/opengnb/archive/refs/heads/master.tar.gz" \
            -o "$MIRROR_DIR/gnb/opengnb-src.tar.gz" \
            && echo "[GNB] master 分支源码已下载" \
            || echo "[GNB] ⚠️ 下载失败"
    else
        echo "[GNB] 已有缓存，跳过"
    fi
else
    CURRENT_VER=$(cat "$GNB_VER_FILE" 2>/dev/null || echo "")
    if [ "$GNB_TAG" = "$CURRENT_VER" ] && [ "$FORCE" != "--force" ]; then
        echo "[GNB] 已是最新: $GNB_TAG"
    else
        echo "[GNB] 下载 $GNB_TAG ..."
        curl -sSL --max-time 90 \
            "https://github.com/opengnb/opengnb/archive/refs/tags/${GNB_TAG}.tar.gz" \
            -o "$MIRROR_DIR/gnb/opengnb-src.tar.gz" \
            && echo "$GNB_TAG" > "$GNB_VER_FILE" \
            && echo "[GNB] ✅ 同步完成: $GNB_TAG" \
            || echo "[GNB] ⚠️ 下载失败"
    fi
fi

# ─────────────────────────────────────────────
# 2. OpenClaw（npm pack，调用 pack-openclaw.sh）
# ─────────────────────────────────────────────
echo "[OpenClaw] 使用 pack-openclaw.sh 打包..."
if bash "$SCRIPT_DIR/pack-openclaw.sh"; then
    echo "[OpenClaw] ✅ 打包完成"
else
    echo "[OpenClaw] ⚠️ 打包失败（npm 可能不可用）"
fi

# ─────────────────────────────────────────────
# 3. synon-daemon 预编译 musl 二进制
#    从 GitHub releases 下载多架构版本
# ─────────────────────────────────────────────
echo "[Daemon] 检查最新版本..."
DAEMON_API="https://api.github.com/repos/dayuer/synon-daemon/releases/latest"
DAEMON_META=$(curl -sSL --max-time 15 "$DAEMON_API" 2>/dev/null || echo '{}')
DAEMON_TAG=$(echo "$DAEMON_META" | python3 -c "import sys,json;print(json.load(sys.stdin).get('tag_name',''))" 2>/dev/null || echo "")
DAEMON_VER_FILE="$MIRROR_DIR/daemon/.version"

DAEMON_TARGETS=(
    "synon-daemon-x86_64-musl"
    "synon-daemon-aarch64-musl"
    "synon-daemon-armv7-musl"
    "synon-daemon-mips-musl"
)

if [ -z "$DAEMON_TAG" ]; then
    echo "[Daemon] ⚠️ GitHub releases 不可达或暂无 release，跳过"
else
    CURRENT_VER=$(cat "$DAEMON_VER_FILE" 2>/dev/null || echo "")
    if [ "$DAEMON_TAG" = "$CURRENT_VER" ] && [ "$FORCE" != "--force" ]; then
        echo "[Daemon] 已是最新: $DAEMON_TAG"
    else
        echo "[Daemon] 下载 $DAEMON_TAG 多架构二进制..."
        SUCCESS=0
        for TARGET in "${DAEMON_TARGETS[@]}"; do
            URL="https://github.com/dayuer/synon-daemon/releases/download/${DAEMON_TAG}/${TARGET}"
            OUT="$MIRROR_DIR/daemon/${TARGET}"
            if curl -sSLf --max-time 120 "$URL" -o "$OUT" 2>/dev/null; then
                chmod +x "$OUT"
                echo "  ✅ $TARGET ($(du -h "$OUT" | cut -f1))"
                SUCCESS=$((SUCCESS + 1))
            else
                echo "  ⚠️ $TARGET 下载失败（可能尚未发布）"
            fi
        done
        if [ "$SUCCESS" -gt 0 ]; then
            echo "$DAEMON_TAG" > "$DAEMON_VER_FILE"
            echo "[Daemon] ✅ 同步完成: $DAEMON_TAG ($SUCCESS 个架构)"
        fi
    fi
fi

# ─────────────────────────────────────────────
# 清单输出
# ─────────────────────────────────────────────
echo ""
echo "=== 镜像清单 ==="
echo "GNB ($(cat "$MIRROR_DIR/gnb/.version" 2>/dev/null || echo '?')):"
ls -lh "$MIRROR_DIR/gnb/"*.gz 2>/dev/null || echo "  (空)"
echo ""
echo "OpenClaw ($(cat "$MIRROR_DIR/openclaw/.version" 2>/dev/null || echo '?')):"
ls -lh "$MIRROR_DIR/openclaw/"*.tgz 2>/dev/null || echo "  (空)"
echo ""
echo "Daemon ($(cat "$MIRROR_DIR/daemon/.version" 2>/dev/null || echo '?')):"
ls -lh "$MIRROR_DIR/daemon/"synon-daemon-* 2>/dev/null || echo "  (空)"
echo ""
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 同步完成"
