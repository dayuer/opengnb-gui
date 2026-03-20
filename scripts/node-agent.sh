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
TOKEN="${TOKEN:-}"
NODE_ID="${NODE_ID:-}"
GNB_NODE_ID="${GNB_NODE_ID:-}"
GNB_MAP_PATH="${GNB_MAP_PATH:-/opt/gnb/conf/${GNB_NODE_ID}/gnb.map}"
GNB_CTL="${GNB_CTL:-gnb_ctl}"
CLAW_PORT="${CLAW_PORT:-18789}"

if [ -z "$CONSOLE_URL" ] || [ -z "$TOKEN" ]; then
  echo "[agent] 缺少 CONSOLE_URL 或 TOKEN" >&2
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

# --- 3. OpenClaw 状态（进程检测 + 配置文件读取） ---
CLAW_RUNNING="false"
CLAW_PID=""
CLAW_CONFIG=""

# 检测 openclaw 进程（gateway 进程名为 openclaw，不是 openclaw-gateway）
CLAW_PID=$(pgrep -f 'openclaw gateway' 2>/dev/null | head -1 || true)
if [ -z "$CLAW_PID" ]; then
  CLAW_PID=$(pgrep -x 'openclaw' 2>/dev/null | head -1 || true)
fi
if [ -z "$CLAW_PID" ] && systemctl is-active openclaw-gateway.service >/dev/null 2>&1; then
  CLAW_PID=$(systemctl show openclaw-gateway.service --property=MainPID --value 2>/dev/null || true)
fi
if [ -n "$CLAW_PID" ] && [ "$CLAW_PID" != "0" ]; then
  CLAW_RUNNING="true"
fi

# 读取 OpenClaw 配置文件（常见路径）
for cfg_path in "$HOME/.openclaw/openclaw.json" "/root/.openclaw/openclaw.json" "/opt/openclaw/config.json"; do
  if [ -f "$cfg_path" ]; then
    CLAW_CONFIG=$(cat "$cfg_path" 2>/dev/null || true)
    CLAW_CONFIG_PATH="$cfg_path"
    break
  fi
done

END_MS=$(($(date +%s%N 2>/dev/null || echo "0") / 1000000))
COLLECT_MS=$(( END_MS - START_MS ))

# --- 4. 组装 JSON 并推送 ---
# 写入临时文件避免 shell 变量中特殊字符破坏引号
_TMP="/tmp/.agent_$$"
echo "${GNB_STATUS}" > "${_TMP}_gnb"
echo "${GNB_ADDRS}" > "${_TMP}_addr"
echo "${SYS_INFO}" > "${_TMP}_sys"
echo "${CLAW_CONFIG}" > "${_TMP}_claw"

PAYLOAD=$(python3 << PYEOF
import json, os, sys
def read(p):
    try:
        with open(p) as f: return f.read().strip()
    except: return ''

claw_config = {}
try:
    raw = read("${_TMP}_claw")
    if raw.startswith('{'):
        claw_config = json.loads(raw)
except: pass

claw_obj = {
    'running': "$CLAW_RUNNING" == "true",
    'pid': "${CLAW_PID}" if "${CLAW_PID}" else None,
    'configPath': "${CLAW_CONFIG_PATH:-}" if "${CLAW_CONFIG_PATH:-}" else None,
    'config': claw_config
}

payload = {
    'gnbStatus': read("${_TMP}_gnb"),
    'gnbAddresses': read("${_TMP}_addr"),
    'sysInfo': read("${_TMP}_sys"),
    'openclaw': claw_obj,
    'collectMs': ${COLLECT_MS:-0}
}
print(json.dumps(payload))
PYEOF
)
rm -f "${_TMP}_gnb" "${_TMP}_addr" "${_TMP}_sys" "${_TMP}_claw"

if [ -z "$PAYLOAD" ]; then
  echo "[agent] JSON 组装失败" >&2
  exit 1
fi

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "$PAYLOAD" \
  "${CONSOLE_URL}/api/monitor/report?nodeId=${NODE_ID}" \
  -m 10 2>/dev/null || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  echo "[agent] 上报失败 HTTP ${HTTP_CODE}" >&2
fi
