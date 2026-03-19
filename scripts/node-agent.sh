#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# node-agent.sh — 节点监控 Agent（推模式）
#
# 功能：本地采集 GNB + OpenClaw + 系统信息 → POST 到 Console
# 部署：由 initnode.sh 安装到 /opt/gnb/bin/，systemd timer 每 10s 触发
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# --- 配置（由 systemd EnvironmentFile 注入） ---
CONSOLE_URL="${CONSOLE_URL:-}"
NODE_TOKEN="${NODE_TOKEN:-}"
GNB_NODE_ID="${GNB_NODE_ID:-}"
GNB_MAP_PATH="${GNB_MAP_PATH:-/opt/gnb/conf/${GNB_NODE_ID}/gnb.map}"
GNB_CTL="${GNB_CTL:-gnb_ctl}"
CLAW_PORT="${CLAW_PORT:-18789}"

if [ -z "$CONSOLE_URL" ] || [ -z "$NODE_TOKEN" ]; then
  echo "[agent] 缺少 CONSOLE_URL 或 NODE_TOKEN" >&2
  exit 1
fi

START_MS=$(($(date +%s%N) / 1000000))

# --- 1. GNB 状态 ---
GNB_STATUS=""
GNB_ADDRS=""
if command -v "$GNB_CTL" &>/dev/null && [ -e "$GNB_MAP_PATH" ]; then
  GNB_STATUS=$("$GNB_CTL" -b "$GNB_MAP_PATH" -s 2>/dev/null || echo "")
  GNB_ADDRS=$("$GNB_CTL" -b "$GNB_MAP_PATH" -a 2>/dev/null || echo "")
fi

# --- 2. 系统信息 ---
SYS_INFO=$(cat <<'SYSEOF'
::HOSTNAME::$(hostname)
::OS::$(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '"')
::KERNEL::$(uname -r)
::ARCH::$(uname -m)
::UPTIME::$(uptime -p 2>/dev/null || uptime)
::LOAD::$(cat /proc/loadavg 2>/dev/null | cut -d" " -f1-3 || sysctl -n vm.loadavg 2>/dev/null)
::CPU_MODEL::$(grep "model name" /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs || sysctl -n machdep.cpu.brand_string 2>/dev/null)
::CPU_CORES::$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)
::MEM::$(free -m 2>/dev/null | awk 'NR==2{printf "%s %s %s", $2, $3, $7}' || echo "")
::DISK::$(df -h / 2>/dev/null | awk 'NR==2{printf "%s %s %s %s", $2, $3, $4, $5}')
::CPU_USAGE::$(grep 'cpu ' /proc/stat 2>/dev/null | awk '{u=$2+$4; t=$2+$4+$5; if(t>0) printf "%d", u*100/t; else print "0"}' || echo "0")
SYSEOF
)
# 执行嵌入的命令
SYS_INFO=$(eval "echo \"$SYS_INFO\"")

# --- 3. OpenClaw 状态 ---
CLAW_STATUS="{}"
if curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${CLAW_PORT}/status" | grep -q 200 2>/dev/null; then
  CLAW_STATUS=$(curl -s -m 5 -H "Authorization: Bearer ${NODE_TOKEN}" "http://127.0.0.1:${CLAW_PORT}/status" 2>/dev/null || echo '{}')
fi

END_MS=$(($(date +%s%N) / 1000000))
COLLECT_MS=$(( END_MS - START_MS ))

# --- 4. 组装 JSON 并推送 ---
# 使用 printf 安全转义 JSON 字符串
json_escape() {
  printf '%s' "$1" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null \
    || printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g; s/\t/\\t/g')"
}

PAYLOAD=$(cat <<JSONEOF
{
  "gnbStatus": $(json_escape "$GNB_STATUS"),
  "gnbAddresses": $(json_escape "$GNB_ADDRS"),
  "sysInfo": $(json_escape "$SYS_INFO"),
  "openclaw": ${CLAW_STATUS},
  "collectMs": ${COLLECT_MS}
}
JSONEOF
)

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${NODE_TOKEN}" \
  -d "$PAYLOAD" \
  "${CONSOLE_URL}/api/monitor/report" \
  -m 10 2>/dev/null || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  echo "[agent] 上报失败 HTTP ${HTTP_CODE}" >&2
fi
