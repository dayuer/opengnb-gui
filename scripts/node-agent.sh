#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# node-agent.sh — 节点监控 Agent（推模式）
#
# 功能：本地采集 GNB + OpenClaw + 系统信息 → POST 到 Console
# 部署：由 initnode.sh 安装到 /opt/gnb/bin/，systemd timer 每 10s 触发
# 依赖：jq, curl, bash, coreutils（无 Python）
# ═══════════════════════════════════════════════════════════════

# --- 任务日志（集中记录任务执行全过程） ---
TASK_LOG="/opt/gnb/log/agent-tasks.log"
mkdir -p "$(dirname "$TASK_LOG")" 2>/dev/null
task_log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$TASK_LOG"; }
# 日志轮转：超过 500 行时保留最新 300 行
if [ -f "$TASK_LOG" ] && [ "$(wc -l < "$TASK_LOG" 2>/dev/null)" -gt 500 ]; then
  tail -300 "$TASK_LOG" > "${TASK_LOG}.tmp" && mv "${TASK_LOG}.tmp" "$TASK_LOG"
fi

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

# --- jq 检查（必需依赖）---
if ! command -v jq &>/dev/null; then
  echo "[agent] jq 未安装，尝试安装..." >&2
  apt-get install -y -qq jq 2>/dev/null || yum install -y -q jq 2>/dev/null || apk add -q jq 2>/dev/null || true
  if ! command -v jq &>/dev/null; then
    echo "[agent] jq 安装失败，退出" >&2
    exit 1
  fi
fi

# --- 自更新机制：每 360 次运行（~1小时）自动拉取最新 agent ---
SELF_PATH="/opt/gnb/bin/node-agent.sh"
UPDATE_COUNTER="/tmp/.agent_update_counter"
COUNT=$(cat "$UPDATE_COUNTER" 2>/dev/null || echo 0)
COUNT=$((COUNT + 1))
echo "$COUNT" > "$UPDATE_COUNTER"
if [ $((COUNT % 360)) -eq 0 ]; then
  NEW_SCRIPT=$(curl -sf -m 5 "${CONSOLE_URL}/api/enroll/node-agent.sh" 2>/dev/null || true)
  if [ -n "$NEW_SCRIPT" ] && echo "$NEW_SCRIPT" | head -1 | grep -q "^#!/"; then
    echo "$NEW_SCRIPT" | sudo tee "$SELF_PATH" > /dev/null 2>&1
    sudo chmod +x "$SELF_PATH" 2>/dev/null
  fi
fi

START_MS=$(($(date +%s%N 2>/dev/null || echo "0") / 1000000))

# --- 1. GNB 状态 ---
GNB_STATUS=""
GNB_ADDRS=""
if command -v "$GNB_CTL" &>/dev/null && [ -e "$GNB_MAP_PATH" ]; then
  GNB_STATUS=$("$GNB_CTL" -b "$GNB_MAP_PATH" -s 2>/dev/null || true)
  GNB_ADDRS=$("$GNB_CTL" -b "$GNB_MAP_PATH" -a 2>/dev/null || true)
fi

# --- 2. 系统信息（::KEY::VALUE 格式，与 Console _parseSysInfo 兼容）---
SYS_INFO="::HOSTNAME::$(hostname 2>/dev/null)
::OS::$(grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"')
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
CLAW_RUNNING="false"
CLAW_PID=""
CLAW_CONFIG=""
CLAW_CONFIG_PATH=""
CLAW_RPC_OK="false"

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

for cfg_path in "$HOME/.openclaw/openclaw.json" "/root/.openclaw/openclaw.json" "/home/synon/.openclaw/openclaw.json" "/opt/openclaw/config.json"; do
  if [ -f "$cfg_path" ]; then
    CLAW_CONFIG=$(sudo cat "$cfg_path" 2>/dev/null || cat "$cfg_path" 2>/dev/null || true)
    if [ -n "$CLAW_CONFIG" ]; then
      CLAW_CONFIG_PATH="$cfg_path"
      break
    fi
  fi
done

if [ "$CLAW_RUNNING" = "true" ]; then
  CLAW_RPC_OK=$(curl -sf -m 2 "http://127.0.0.1:${CLAW_PORT}/api/status" >/dev/null 2>&1 && echo "true" || echo "false")
fi

# --- 采集 OpenClaw 已安装 skills（shell 解析 │ 分隔表格）---
INSTALLED_SKILLS="[]"
if command -v openclaw &>/dev/null; then
  SKILLS_RAW=$(openclaw skills list 2>/dev/null || true)
  if [ -n "$SKILLS_RAW" ]; then
    # 解析 │ 分隔表格：跳过表头和 missing 行，提取 skill 名称和 source
    INSTALLED_SKILLS=$(echo "$SKILLS_RAW" | awk -F'│' '
      NR <= 2 { next }
      NF < 4 { next }
      {
        gsub(/^[ \t]+|[ \t]+$/, "", $2)  # status
        gsub(/^[ \t]+|[ \t]+$/, "", $3)  # skill name
        gsub(/^[ \t]+|[ \t]+$/, "", $5)  # source
        if ($3 == "" || $3 == "Skill") next
        if (tolower($2) ~ /missing/) next
        # 去除 emoji 前缀（保留字母数字和连字符开头的部分）
        name = $3
        sub(/^[^a-zA-Z0-9]*/, "", name)
        if (name == "") name = $3
        src = ($5 != "") ? $5 : "openclaw"
        printf "{\"id\":\"%s\",\"name\":\"%s\",\"version\":\"installed\",\"source\":\"%s\"}\n", name, name, src
      }
    ' | jq -s '.' 2>/dev/null || echo "[]")
  fi
fi

END_MS=$(($(date +%s%N 2>/dev/null || echo "0") / 1000000))
COLLECT_MS=$(( END_MS - START_MS ))

# --- 4. 用 jq 组装 JSON payload ---
CLAW_CONFIG_JSON="${CLAW_CONFIG:-{}}"
# 确保 claw config 是合法 JSON
echo "$CLAW_CONFIG_JSON" | jq . >/dev/null 2>&1 || CLAW_CONFIG_JSON="{}"

PAYLOAD=$(jq -n \
  --arg gnbStatus "$GNB_STATUS" \
  --arg gnbAddresses "$GNB_ADDRS" \
  --arg sysInfo "$SYS_INFO" \
  --argjson clawRunning "$CLAW_RUNNING" \
  --arg clawPid "${CLAW_PID:-}" \
  --arg clawConfigPath "${CLAW_CONFIG_PATH:-}" \
  --argjson clawConfig "$CLAW_CONFIG_JSON" \
  --argjson clawRpcOk "$CLAW_RPC_OK" \
  --argjson installedSkills "$INSTALLED_SKILLS" \
  --argjson collectMs "$COLLECT_MS" \
  '{
    gnbStatus: $gnbStatus,
    gnbAddresses: $gnbAddresses,
    sysInfo: $sysInfo,
    openclaw: {
      running: $clawRunning,
      pid: (if $clawPid == "" then null else $clawPid end),
      configPath: (if $clawConfigPath == "" then null else $clawConfigPath end),
      config: $clawConfig,
      rpcOk: $clawRpcOk,
      installedSkills: $installedSkills
    },
    collectMs: $collectMs
  }')

if [ -z "$PAYLOAD" ]; then
  echo "[agent] JSON 组装失败" >&2
  exit 1
fi

# --- 注入上次执行的任务结果（如有）---
TASK_RESULTS_FILE="/tmp/.agent_task_results.json"
if [ -f "$TASK_RESULTS_FILE" ]; then
  TASK_RESULTS=$(cat "$TASK_RESULTS_FILE" 2>/dev/null || echo "[]")
  rm -f "$TASK_RESULTS_FILE"
  # 将 taskResults 注入 payload
  PAYLOAD=$(echo "$PAYLOAD" | jq --argjson results "$TASK_RESULTS" '. + {taskResults: $results}' 2>/dev/null || echo "$PAYLOAD")
fi

# --- 上报并读取响应（含待执行任务） ---
RESPONSE_FILE="/tmp/.agent_response.json"
HTTP_CODE=$(curl -s -w '%{http_code}' -o "$RESPONSE_FILE" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "$PAYLOAD" \
  "${CONSOLE_URL}/api/monitor/report?nodeId=${NODE_ID}" \
  -m 10 2>/dev/null || echo "000")

if [ "$HTTP_CODE" != "200" ]; then
  echo "[agent] 上报失败 HTTP ${HTTP_CODE}" >&2
  task_log "上报失败 HTTP ${HTTP_CODE}"
  rm -f "$RESPONSE_FILE"
  exit 0
fi

# --- 解析并执行下发的任务（纯 shell + jq） ---
if [ -f "$RESPONSE_FILE" ]; then
  TASK_COUNT=$(jq -r '.tasks | length' "$RESPONSE_FILE" 2>/dev/null || echo "0")

  if [ "$TASK_COUNT" -gt 0 ] 2>/dev/null; then
    echo "[agent] 收到 ${TASK_COUNT} 个待执行任务" >&2
    task_log "收到 ${TASK_COUNT} 个任务"

    RESULTS="[]"
    IDX=0
    while [ "$IDX" -lt "$TASK_COUNT" ]; do
      TASK_ID=$(jq -r ".tasks[$IDX].taskId" "$RESPONSE_FILE")
      TASK_CMD=$(jq -r ".tasks[$IDX].command" "$RESPONSE_FILE")
      TASK_TIMEOUT_MS=$(jq -r ".tasks[$IDX].timeoutMs // 60000" "$RESPONSE_FILE")
      TASK_TIMEOUT_S=$(( TASK_TIMEOUT_MS / 1000 ))
      [ "$TASK_TIMEOUT_S" -lt 5 ] && TASK_TIMEOUT_S=5

      echo "[agent] 执行任务 ${TASK_ID}: ${TASK_CMD}" >&2
      task_log "执行 ${TASK_ID}: ${TASK_CMD}"

      # 使用 timeout 命令执行（bash -lc 加载完整环境）
      STDOUT_FILE="/tmp/.agent_task_stdout_$$"
      STDERR_FILE="/tmp/.agent_task_stderr_$$"
      COMPLETED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%SZ')

      if timeout "${TASK_TIMEOUT_S}s" bash -lc "$TASK_CMD" >"$STDOUT_FILE" 2>"$STDERR_FILE"; then
        EXIT_CODE=0
        STATUS_TEXT="成功"
      else
        EXIT_CODE=$?
        if [ "$EXIT_CODE" -eq 124 ]; then
          STATUS_TEXT="超时(${TASK_TIMEOUT_S}s)"
        else
          STATUS_TEXT="失败(code:${EXIT_CODE})"
        fi
      fi
      COMPLETED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%SZ')

      # 截取输出（最多 2000 字节）
      STDOUT_CONTENT=$(head -c 2000 "$STDOUT_FILE" 2>/dev/null || true)
      STDERR_CONTENT=$(head -c 2000 "$STDERR_FILE" 2>/dev/null || true)
      rm -f "$STDOUT_FILE" "$STDERR_FILE"

      echo "[agent] 任务 ${TASK_ID} ${STATUS_TEXT}" >&2
      task_log "任务 ${TASK_ID} ${STATUS_TEXT}"

      # 追加结果到 RESULTS 数组
      RESULTS=$(echo "$RESULTS" | jq \
        --arg taskId "$TASK_ID" \
        --argjson code "$EXIT_CODE" \
        --arg stdout "$STDOUT_CONTENT" \
        --arg stderr "$STDERR_CONTENT" \
        --arg completedAt "$COMPLETED_AT" \
        '. + [{taskId: $taskId, code: $code, stdout: $stdout, stderr: $stderr, completedAt: $completedAt}]')

      IDX=$((IDX + 1))
    done

    # 保存结果供下次上报
    echo "$RESULTS" > "$TASK_RESULTS_FILE"
    task_log "已保存 ${TASK_COUNT} 个任务结果到 ${TASK_RESULTS_FILE}"
  fi

  rm -f "$RESPONSE_FILE"
fi
