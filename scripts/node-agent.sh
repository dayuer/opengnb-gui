#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# node-agent.sh — 节点监控 Agent（推模式）
#
# 功能：本地采集 GNB + OpenClaw + 系统信息 → POST 到 Console
# 部署：由 initnode.sh 安装到 /opt/gnb/bin/，systemd timer 每 10s 触发
# ═══════════════════════════════════════════════════════════════

# --- 配置（systemd EnvironmentFile 或手动 source） ---
AGENT_ENV="/opt/gnb/bin/agent.env"
if [ -z "${CONSOLE_URL:-}" ] && [ -f "$AGENT_ENV" ]; then
  set -a  # 自动 export
  . "$AGENT_ENV"
  set +a
fi

CONSOLE_URL="${CONSOLE_URL:-}"
NODE_TOKEN="${NODE_TOKEN:-}"
NODE_ID="${NODE_ID:-}"
GNB_NODE_ID="${GNB_NODE_ID:-}"
GNB_MAP_PATH="${GNB_MAP_PATH:-/opt/gnb/conf/${GNB_NODE_ID}/gnb.map}"
GNB_CTL="${GNB_CTL:-gnb_ctl}"
CLAW_PORT="${CLAW_PORT:-18789}"

if [ -z "$CONSOLE_URL" ] || [ -z "$NODE_TOKEN" ]; then
  echo "[agent] 缺少 CONSOLE_URL 或 NODE_TOKEN" >&2
  exit 1
fi

START_MS=$(($(date +%s%N 2>/dev/null || echo "0") / 1000000))

# --- 1. GNB 状态 ---
GNB_STATUS=""
GNB_ADDRS=""
if command -v "$GNB_CTL" &>/dev/null && [ -e "$GNB_MAP_PATH" ]; then
  GNB_STATUS=$("$GNB_CTL" -b "$GNB_MAP_PATH" -s 2>/dev/null || true)
  GNB_ADDRS=$("$GNB_CTL" -b "$GNB_MAP_PATH" -a 2>/dev/null || true)
fi

# --- 2. 系统信息（直接拼接，保持与 Console _parseSysInfo 兼容的 ::KEY::VALUE 格式） ---
SYS_INFO="::HOSTNAME::$(hostname 2>/dev/null)
::OS::$(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '"')
::KERNEL::$(uname -r 2>/dev/null)
::ARCH::$(uname -m 2>/dev/null)
::UPTIME::$(uptime -p 2>/dev/null || uptime 2>/dev/null)
::LOAD::$(cat /proc/loadavg 2>/dev/null | cut -d' ' -f1-3 || sysctl -n vm.loadavg 2>/dev/null)
::CPU_MODEL::$(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | xargs || sysctl -n machdep.cpu.brand_string 2>/dev/null)
::CPU_CORES::$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)
::MEM::$(free -m 2>/dev/null | awk 'NR==2{printf "%s %s %s", $2, $3, $7}')
::DISK::$(df -h / 2>/dev/null | awk 'NR==2{printf "%s %s %s %s", $2, $3, $4, $5}')
::CPU_USAGE::$(grep 'cpu ' /proc/stat 2>/dev/null | awk '{u=$2+$4; t=$2+$4+$5; if(t>0) printf "%d", u*100/t; else print "0"}' || echo '0')"

# --- 3. OpenClaw 状态 ---
CLAW_JSON="{}"
if command -v curl &>/dev/null; then
  CLAW_HTTP=$(curl -s -m 3 -o /tmp/.claw_status -w '%{http_code}' \
    -H "Authorization: Bearer ${NODE_TOKEN}" \
    "http://127.0.0.1:${CLAW_PORT}/status" 2>/dev/null || echo "000")
  if [ "$CLAW_HTTP" = "200" ]; then
    CLAW_JSON=$(cat /tmp/.claw_status 2>/dev/null || echo '{}')
  fi
  rm -f /tmp/.claw_status
fi

END_MS=$(($(date +%s%N 2>/dev/null || echo "0") / 1000000))
COLLECT_MS=$(( END_MS - START_MS ))

# --- 4. 组装 JSON 并推送 ---
# 使用 python3 安全构建 JSON
PAYLOAD=$(python3 -c "
import json, sys
payload = {
    'gnbStatus': '''${GNB_STATUS}''',
    'gnbAddresses': '''${GNB_ADDRS}''',
    'sysInfo': '''${SYS_INFO}''',
    'openclaw': json.loads('''${CLAW_JSON}''') if '''${CLAW_JSON}'''.strip().startswith('{') else {},
    'collectMs': ${COLLECT_MS:-0}
}
print(json.dumps(payload))
" 2>/dev/null)

if [ -z "$PAYLOAD" ]; then
  echo "[agent] JSON 组装失败" >&2
  exit 1
fi

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${NODE_TOKEN}" \
  -d "$PAYLOAD" \
  "${CONSOLE_URL}/api/monitor/report?nodeId=${NODE_ID}" \
  -m 10 2>/dev/null || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  echo "[agent] 上报失败 HTTP ${HTTP_CODE}" >&2
fi
