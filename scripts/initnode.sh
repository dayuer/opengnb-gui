#!/bin/bash
# SynonClaw Console — 节点初始化脚本
#
# 流程：
#   1. 安装 GNB（编译或已安装跳过）
#   2. 获取 passcode 并提交注册
#   3. 等待管理员审批（审批时分配 TUN 地址和 GNB 节点 ID）
#   4. 配置 GNB（密钥生成 + 公钥交换 + 配置文件 + systemd）
#   5. 启动 GNB 并验证 TUN 网络连通
#   6. 创建 synon 用户（sudo 免密）
#   7. 安装 Node.js v22
#   8. 下载 Console SSH 公钥
#   9. 安装 OpenClaw（Console 镜像优先 → npm 回退 + 配置 + systemd）
#  10. 提交 OpenClaw Token 到 Console
#  11. 安装监控 Agent（上报节点信息到 Console）
#  12. 通知 Console 已就绪
#
# 用法（在目标节点以 root 执行）：
#   curl -sSL https://api.synonclaw.com/api/enroll/init.sh | bash

set -euo pipefail

# --- 参数（全部可通过环境变量覆盖）---
CONSOLE="${CONSOLE:-api.synonclaw.com}"
NODE_NAME="${NODE_ID:-$(hostname -s)}"  # @alpha: 用户提交的名称（hostname）
SSH_USER="synon"

# 自动检测协议：域名用 https，IP 用 http
if echo "$CONSOLE" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]'; then
    API_BASE="http://$CONSOLE"
else
    API_BASE="https://$CONSOLE"
fi

# JSON 值提取工具函数（兼容无 jq 环境）
json_val() { python3 -c "import sys,json; print(json.load(sys.stdin).get('$1',''))" 2>/dev/null || echo ""; }

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║  SynonClaw Console — 节点初始化 v0.6.0     ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  Console:  $CONSOLE ($API_BASE)"
echo "  节点名:   $NODE_NAME"
echo ""

# ============================================
# Step 1: 安装 GNB
# ============================================
echo "[1/10] 安装 GNB..."

# 清理旧安装
if command -v gnb &>/dev/null || [ -d /opt/gnb ]; then
    echo "      检测到旧 GNB，清理中..."
    systemctl stop gnb 2>/dev/null || true
    killall gnb gnb_es 2>/dev/null || true
    ip link delete gnb_tun 2>/dev/null || true
    rm -rf /opt/gnb /usr/local/bin/gnb /usr/local/bin/gnb_ctl
fi

# 安装编译依赖（多 OS 适配）
if [ "$(uname)" = "Darwin" ]; then
    xcode-select --install 2>/dev/null || true
elif command -v apt-get &>/dev/null; then
    apt-get update -qq && apt-get install -y -qq build-essential curl git
elif command -v dnf &>/dev/null; then
    dnf install -y -q gcc make curl git
elif command -v yum &>/dev/null; then
    yum install -y -q gcc make curl git
elif command -v apk &>/dev/null; then
    apk add -q build-base curl bash git
elif command -v pacman &>/dev/null; then
    pacman -Sy --noconfirm base-devel curl git >/dev/null
elif command -v zypper &>/dev/null; then
    zypper install -y -n gcc make curl git
fi

cd /tmp && rm -rf opengnb

# 优先从 Console 镜像下载
if curl -sSf "$API_BASE/api/mirror/gnb/opengnb-src.tar.gz" -o /tmp/opengnb-src.tar.gz 2>/dev/null; then
    echo "      从 Console 镜像下载成功"
    mkdir -p /tmp/opengnb
    tar xzf /tmp/opengnb-src.tar.gz -C /tmp/opengnb --strip-components=1
else
    echo "      Console 镜像不可用，尝试 GitHub..."
    curl -sSL "https://github.com/opengnb/opengnb/archive/refs/heads/master.tar.gz" -o /tmp/opengnb-src.tar.gz
    mkdir -p /tmp/opengnb
    tar xzf /tmp/opengnb-src.tar.gz -C /tmp/opengnb --strip-components=1
fi

cd /tmp/opengnb

case "$(uname -s)" in
    Linux)   GNB_MAKEFILE="Makefile.linux" ;;
    Darwin)  GNB_MAKEFILE="Makefile.Darwin" ;;
    FreeBSD) GNB_MAKEFILE="Makefile.freebsd" ;;
    *)       GNB_MAKEFILE="Makefile.linux" ;;
esac

echo "      编译 GNB ($GNB_MAKEFILE)..."
make -f "$GNB_MAKEFILE" -j$(nproc 2>/dev/null || echo 2) 2>&1 | tail -1

mkdir -p /opt/gnb/bin
cp gnb gnb_ctl gnb_es gnb_crypto /opt/gnb/bin/ 2>/dev/null || true
ln -sf /opt/gnb/bin/gnb /usr/local/bin/gnb
ln -sf /opt/gnb/bin/gnb_ctl /usr/local/bin/gnb_ctl
echo "      GNB 编译安装完成"

# ============================================
# Step 2: 获取 passcode 并提交注册
# ============================================
echo "[2/10] 提交注册..."

TOKEN="${TOKEN:-}"

if [ -z "${PASSCODE:-}" ]; then
    if [ -z "$TOKEN" ]; then
        echo "      [失败] 未传入 TOKEN"
        echo "      用法: curl ... | TOKEN=<token> bash"
        exit 1
    fi
    echo "      自动获取 passcode..."
    PC_RESP=$(curl -sS "$API_BASE/api/enroll/passcode" \
      -H "Authorization: Bearer $TOKEN")
    PASSCODE=$(echo "$PC_RESP" | json_val passcode)
    if [ -z "$PASSCODE" ]; then
        echo "      [失败] 无法获取 passcode（Token 无效？）"
        echo "      响应: $PC_RESP"
        exit 1
    fi
    echo "      ✅ passcode 已自动生成"
fi

ENROLL_RESP=$(curl -sS -X POST "$API_BASE/api/enroll" \
  -H "Content-Type: application/json" \
  -d "{\"passcode\":\"$PASSCODE\",\"id\":\"$NODE_NAME\",\"name\":\"$NODE_NAME\"}")

STATUS=$(echo "$ENROLL_RESP" | json_val status)
ENROLL_TOKEN=$(echo "$ENROLL_RESP" | json_val enrollToken)
# @alpha: 提取平台分配的唯一 NodeID
PLATFORM_NODE_ID=$(echo "$ENROLL_RESP" | json_val nodeId)
echo "      $(echo "$ENROLL_RESP" | json_val message)"

if [ "$STATUS" = "error" ]; then
    echo "      [失败] 注册失败"
    exit 1
fi

if [ -z "$ENROLL_TOKEN" ]; then
    echo "      [失败] 未获取到 enrollToken"
    exit 1
fi

if [ -n "$PLATFORM_NODE_ID" ]; then
    echo "      平台分配 ID: $PLATFORM_NODE_ID"
fi

# @alpha: 后续 API 调用统一使用 enrollToken 认证
ENROLL_AUTH="Authorization: Bearer $ENROLL_TOKEN"

# ============================================
# Step 3: 等待管理员审批
# ============================================
TUN_ADDR=""
GNB_NODE_ID=""
CONSOLE_GNB_NODE_ID=""
CONSOLE_GNB_TUN_ADDR=""

fetch_status() {
    local resp
    # 优先用 enrollToken，失败时用 ADMIN_TOKEN fallback（服务器重启后 enrollToken 可能丢失）
    local use_id="${PLATFORM_NODE_ID:-$NODE_NAME}"
    resp=$(curl -sS -H "$ENROLL_AUTH" "$API_BASE/api/enroll/status/$use_id" 2>/dev/null || echo '{}')
    STATUS=$(echo "$resp" | json_val status)
    if [ -z "$STATUS" ] || [ "$STATUS" = "null" ]; then
        # enrollToken 可能失效，尝试 TOKEN
        if [ -n "${TOKEN:-}" ]; then
            resp=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API_BASE/api/enroll/status/$use_id" 2>/dev/null || echo '{}')
            STATUS=$(echo "$resp" | json_val status)
        fi
    fi
    TUN_ADDR=$(echo "$resp" | json_val tunAddr)
    GNB_NODE_ID=$(echo "$resp" | json_val gnbNodeId)
    CONSOLE_GNB_NODE_ID=$(echo "$resp" | json_val consoleGnbNodeId)
    CONSOLE_GNB_TUN_ADDR=$(echo "$resp" | json_val consoleGnbTunAddr)
}

if [ "$STATUS" = "approved" ]; then
    echo "      已审批（之前已注册）"
    fetch_status
else
    echo "[3/10] 等待管理员审批..."
    echo "      审批时将分配 GNB TUN 地址 (每 10 秒检查, Ctrl+C 退出)"
    echo ""
    while true; do
        sleep 10
        fetch_status
        case "$STATUS" in
            approved) echo "" && echo "      ✅ 审批通过！"; break ;;
            rejected|deleted) echo "" && echo "      ❌ 审批被拒绝"; exit 1 ;;
            pending)  printf "." ;;
            *)        printf "?" ;;  # 未知状态（如认证失败），继续重试
        esac
    done
fi

if [ -z "$TUN_ADDR" ] || [ -z "$GNB_NODE_ID" ]; then
    echo "      [错误] 审批未分配 TUN 地址或 GNB 节点 ID"
    exit 1
fi

echo "      GNB 节点 ID: $GNB_NODE_ID"
echo "      TUN 地址:    $TUN_ADDR"

# ============================================
# Step 4: 配置 GNB（密钥 + 公钥交换 + 配置文件）
# ============================================
echo "[4/10] 配置 GNB..."

GNB_CONF="/opt/gnb/conf/$GNB_NODE_ID"
mkdir -p "$GNB_CONF"/{security,ed25519,scripts}

# 生成 Ed25519 密钥
if [ ! -f "$GNB_CONF/security/${GNB_NODE_ID}.private" ]; then
    cd "$GNB_CONF/security"
    /opt/gnb/bin/gnb_crypto -c -p "${GNB_NODE_ID}.private" -k "${GNB_NODE_ID}.public"
    chmod 600 "${GNB_NODE_ID}.private"  # @alpha: 私钥权限加固
    cp "${GNB_NODE_ID}.public" "$GNB_CONF/ed25519/${GNB_NODE_ID}.public"
    echo "      Ed25519 密钥已生成"
fi

# 下载 Console 的 GNB 公钥
echo "      下载 Console GNB 公钥..."
CONSOLE_PUBKEY_RESP=$(curl -sS "$API_BASE/api/enroll/gnb-pubkey")
CONSOLE_PUBKEY=$(echo "$CONSOLE_PUBKEY_RESP" | json_val publicKey)

if [ -n "$CONSOLE_PUBKEY" ]; then
    echo -n "$CONSOLE_PUBKEY" > "$GNB_CONF/ed25519/${CONSOLE_GNB_NODE_ID}.public"
    echo "      Console 公钥已保存 (node $CONSOLE_GNB_NODE_ID)"
else
    echo "      ⚠️ 无法获取 Console 公钥，GNB 加密通信可能受影响"
fi

# 上传本节点公钥到 Console
LOCAL_PUBKEY=$(cat "$GNB_CONF/security/${GNB_NODE_ID}.public" 2>/dev/null || echo "")
if [ -n "$LOCAL_PUBKEY" ]; then
    curl -sS -X POST "$API_BASE/api/enroll/${PLATFORM_NODE_ID:-$NODE_NAME}/gnb-pubkey" \
      -H "$ENROLL_AUTH" \
      -H "Content-Type: application/json" \
      -d "{\"publicKey\":\"$LOCAL_PUBKEY\"}" > /dev/null
    echo "      本节点公钥已上传到 Console"
fi

# 获取 Console 公网 IP
CONSOLE_HOST=$(echo "$CONSOLE" | sed 's/:.*//') # 去掉端口
if echo "$CONSOLE_HOST" | grep -qE '^[0-9]+\.[0-9]+'; then
    CONSOLE_IP="$CONSOLE_HOST"
else
    CONSOLE_IP=$(dig +short "$CONSOLE_HOST" 2>/dev/null | head -1 || echo "$CONSOLE_HOST")
fi

# 写入配置文件
cat > "$GNB_CONF/node.conf" << GNBEOF
nodeid $GNB_NODE_ID
listen 9002
multi-socket on
unified-forwarding auto
GNBEOF

# address.conf — 从 Console API 拉取全量（包含所有已审批节点）
if curl -sSf -H "$ENROLL_AUTH" "$API_BASE/api/enroll/address-conf" -o "$GNB_CONF/address.conf" 2>/dev/null; then
    echo "      address.conf 已从 Console 拉取（含全部节点）"
else
    echo "      API 不可用，使用最小配置（仅 Console + 自身）"
    cat > "$GNB_CONF/address.conf" << GNBEOF
i|0|${CONSOLE_IP}|9001
${CONSOLE_GNB_NODE_ID}|${CONSOLE_GNB_TUN_ADDR}|255.0.0.0
${GNB_NODE_ID}|${TUN_ADDR}|255.0.0.0
GNBEOF
fi

# route.conf — 从 address.conf 生成（去掉 i| 行）
grep -v '^i|' "$GNB_CONF/address.conf" > "$GNB_CONF/route.conf"

echo "      GNB 配置文件已写入"

# ============================================
# Step 5: 启动 GNB 并等待 TUN 接口
# ============================================
echo "[5/10] 启动 GNB..."

if command -v systemctl &>/dev/null; then
    cat > /etc/systemd/system/gnb.service << SVCEOF
[Unit]
Description=GNB P2P VPN Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p /var/log/opengnb
ExecStart=/opt/gnb/bin/gnb -c ${GNB_CONF} \\
  -i gnb_tun \\
  --crypto chacha20 \\
  --crypto-key-update-interval hour \\
  --address-secure=on \\
  --console-log-level=3 \\
  --log-file-path=/var/log/opengnb
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
    systemctl daemon-reload
    systemctl enable gnb
    systemctl start gnb
else
    /opt/gnb/bin/gnb -c "$GNB_CONF" -i gnb_tun --crypto chacha20 --address-secure=on -d
fi

# 等待 TUN 接口出现
echo "      等待 TUN 接口 (最多 30 秒)..."
for i in $(seq 1 15); do
    if ip addr show gnb_tun 2>/dev/null | grep -q "inet "; then
        TUN_IP=$(ip addr show gnb_tun 2>/dev/null | grep 'inet ' | awk '{print $2}')
        echo "      ✅ TUN 接口已就绪: $TUN_IP"
        break
    fi
    sleep 2
done

if ! ip addr show gnb_tun 2>/dev/null | grep -q "inet "; then
    echo "      ⚠️ TUN 接口未就绪，请检查 GNB 日志: journalctl -u gnb"
else
    # GNB 网络连通验证 — ping Console TUN 地址
    echo "      验证 GNB 隧道连通性..."
    if [ -n "$CONSOLE_GNB_TUN_ADDR" ]; then
        if ping -c 3 -W 5 "$CONSOLE_GNB_TUN_ADDR" >/dev/null 2>&1; then
            echo "      ✅ GNB 隧道已连通 ($TUN_ADDR → $CONSOLE_GNB_TUN_ADDR)"
        else
            echo "      ⚠️ GNB 隧道 ping 不通 ($CONSOLE_GNB_TUN_ADDR)，可能需要等待 peer 发现"
        fi
    fi
fi

# ============================================
# Step 6: 创建 synon 用户
# ============================================
echo "[6/10] 创建运维用户 $SSH_USER..."

if id "$SSH_USER" &>/dev/null; then
    echo "      用户已存在"
else
    useradd -m -s /bin/bash "$SSH_USER"
    echo "      用户已创建"
fi

SUDOERS_FILE="/etc/sudoers.d/$SSH_USER"
if [ ! -f "$SUDOERS_FILE" ]; then
    echo "$SSH_USER ALL=(ALL) NOPASSWD: ALL" > "$SUDOERS_FILE"
    chmod 440 "$SUDOERS_FILE"
    echo "      sudo 免密已配置"
fi

# ============================================
# Step 7: 安装 Node.js v22（OpenClaw 由 Console 远程推送）
# ============================================
echo "[7/10] 安装 Node.js v22..."

# 检测当前 Node.js 版本
NODE_VER=$(node --version 2>/dev/null | sed 's/v//' || echo "0")
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
    echo "      Node.js ${NODE_VER:-未安装}, 需要 >= 22"
    export N_PREFIX=/usr/local
    export PATH="/usr/local/bin:$PATH"

    if ! command -v npm &>/dev/null; then
        # npm 不存在 — 先用 n 自举安装 Node.js 22（自带 npm）
        echo "      npm 未安装，通过 n 自举安装 Node.js 22..."
        curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s 22
        hash -r 2>/dev/null
    fi

    # 此时 npm 必定可用，用 npm 安装 n 版本管理器
    npm install -g n 2>/dev/null || true
    hash -r 2>/dev/null
    n 22 2>&1 | tail -3
    hash -r 2>/dev/null
    echo "      Node.js $(node --version) + npm $(npm --version) 已安装"
else
    echo "      Node.js v${NODE_VER} ✓"
fi

# ============================================
# Step 8: 下载 Console SSH 公钥
# ============================================
echo "[8/10] 下载 Console SSH 公钥..."

PUBKEY=$(curl -sS "$API_BASE/api/enroll/pubkey" | json_val publicKey)
if [ -z "$PUBKEY" ]; then
    echo "      [失败] 无法获取 SSH 公钥"
    exit 1
fi

SSH_DIR="/home/$SSH_USER/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"
mkdir -p "$SSH_DIR" && chmod 700 "$SSH_DIR"

if grep -qF "$PUBKEY" "$AUTH_KEYS" 2>/dev/null; then
    echo "      公钥已存在"
else
    echo "$PUBKEY" >> "$AUTH_KEYS"
    echo "      公钥已写入"
fi
chmod 600 "$AUTH_KEYS"
chown -R "$SSH_USER:$SSH_USER" "$SSH_DIR"

# ============================================
# Step 9: 安装 OpenClaw（版本检测 + Console 镜像优先 → npm 回退）
# ============================================
echo "[9/12] 安装 OpenClaw..."

# 查询 Console 镜像获取最新版本
MIRROR_LIST=$(curl -sf -m 5 "$API_BASE/api/mirror/openclaw" 2>/dev/null || echo "{}")
LATEST_VER=$(echo "$MIRROR_LIST" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(d.get('version','unknown'))
except: print('unknown')
" 2>/dev/null)
CLAW_TGZ=$(echo "$MIRROR_LIST" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    files=[f['name'] for f in d.get('files',[]) if f['name'].endswith('.tgz')]
    files.sort()
    print(files[-1] if files else '')
except: print('')
" 2>/dev/null)

# 检测本地已安装版本
CLAW_VER=$(openclaw --version 2>/dev/null | head -1 | awk '{print $2}' || echo "NOT_FOUND")
# 去掉可能的前导字符 (e.g. "OpenClaw 2026.3.13 (xxx)" → "2026.3.13")
CLAW_VER=$(echo "$CLAW_VER" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "NOT_FOUND")

NEED_INSTALL=false
if [ "$CLAW_VER" = "NOT_FOUND" ] || [ -z "$CLAW_VER" ]; then
    echo "      OpenClaw 未安装"
    NEED_INSTALL=true
elif [ "$LATEST_VER" != "unknown" ] && [ "$CLAW_VER" != "$LATEST_VER" ]; then
    echo "      本地版本 $CLAW_VER ≠ 最新 $LATEST_VER，升级中..."
    npm uninstall -g openclaw 2>/dev/null || true
    NEED_INSTALL=true
else
    echo "      OpenClaw $CLAW_VER 已是最新"
fi

CLAW_INSTALLED=false
if [ "$NEED_INSTALL" = "true" ]; then
    # 策略 A: 从 Console 镜像下载 tarball
    if [ -n "$CLAW_TGZ" ]; then
        echo "      从 Console 镜像下载: $CLAW_TGZ"
        if curl -sf -m 120 "$API_BASE/api/mirror/openclaw/$CLAW_TGZ" -o "/tmp/$CLAW_TGZ"; then
            npm install -g "/tmp/$CLAW_TGZ" > /tmp/openclaw-install.log 2>&1 && CLAW_INSTALLED=true
            rm -f "/tmp/$CLAW_TGZ"
        fi
    fi

    # 策略 B: npm 在线安装（含国内镜像）
    if [ "$CLAW_INSTALLED" != "true" ]; then
        echo "      从 npm 在线安装..."
        npm install -g openclaw@latest --registry=https://registry.npmmirror.com \
            > /tmp/openclaw-install.log 2>&1 && CLAW_INSTALLED=true
    fi

    if [ "$CLAW_INSTALLED" != "true" ]; then
        echo "      ⚠️ OpenClaw 安装失败，跳过（可稍后通过 Console 终端安装）"
    else
        echo "      ✅ OpenClaw $(openclaw --version 2>/dev/null | head -1) 已安装"
    fi
else
    CLAW_INSTALLED=true
fi

# 配置 OpenClaw + systemd + 生成 Token
CLAW_TOKEN=""
CLAW_PORT=18789
if [ "$CLAW_INSTALLED" = "true" ]; then
    # 生成随机 Token
    CLAW_TOKEN=$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null \
        || openssl rand -hex 32 2>/dev/null \
        || cat /dev/urandom | tr -dc 'a-f0-9' | head -c 64)

    # 创建配置文件
    CLAW_CONFIG_DIR="/root/.openclaw"
    mkdir -p "$CLAW_CONFIG_DIR"
    cat > "$CLAW_CONFIG_DIR/openclaw.json" << CLAWEOF
{
  "gateway": {
    "mode": "local",
    "port": $CLAW_PORT,
    "bind": "lan",
    "controlUi": {
      "allowedOrigins": [
        "http://localhost:$CLAW_PORT",
        "http://127.0.0.1:$CLAW_PORT",
        "http://$TUN_ADDR:$CLAW_PORT"
      ]
    },
    "auth": {
      "mode": "token",
      "token": "$CLAW_TOKEN"
    }
  }
}
CLAWEOF
    chmod 600 "$CLAW_CONFIG_DIR/openclaw.json"
    echo "      配置已写入 ($CLAW_CONFIG_DIR/openclaw.json)"

    # 创建 systemd 服务
    if command -v systemctl &>/dev/null; then
        cat > /etc/systemd/system/openclaw-gateway.service << SVCEOF
[Unit]
Description=OpenClaw Gateway
After=network.target gnb.service

[Service]
Type=simple
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/openclaw gateway
Restart=always
RestartSec=5
WorkingDirectory=/root

[Install]
WantedBy=multi-user.target
SVCEOF
        systemctl daemon-reload
        systemctl enable openclaw-gateway
        systemctl start openclaw-gateway
        sleep 3
        if systemctl is-active openclaw-gateway >/dev/null 2>&1; then
            echo "      ✅ OpenClaw Gateway 已启动"
        else
            echo "      ⚠️ OpenClaw Gateway 启动失败"
            journalctl -u openclaw-gateway --no-pager -n 5 2>/dev/null || true
        fi
    fi
fi

# ============================================
# Step 10: 提交 OpenClaw Token 到 Console
# ============================================
echo "[10/12] 提交 OpenClaw Token..."

if [ -n "$CLAW_TOKEN" ]; then
    TOKEN_RESP=$(curl -sS -X POST "$API_BASE/api/enroll/${PLATFORM_NODE_ID:-$NODE_NAME}/claw-token" \
      -H "$ENROLL_AUTH" \
      -H "Content-Type: application/json" \
      -d "{\"token\":\"$CLAW_TOKEN\",\"port\":$CLAW_PORT}")
    TOKEN_MSG=$(echo "$TOKEN_RESP" | json_val message)
    if [ -n "$TOKEN_MSG" ]; then
        echo "      ✅ $TOKEN_MSG"
    else
        echo "      ⚠️ Token 提交失败: $TOKEN_RESP"
    fi
else
    echo "      跳过（OpenClaw 未安装）"
fi

# ============================================
# Step 11: 安装监控 Agent（上报节点信息到 Console）
# ============================================
echo "[11/12] 安装监控 Agent..."

# 下载 agent 脚本
curl -sSf "$API_BASE/api/enroll/node-agent.sh" -o /opt/gnb/bin/node-agent.sh 2>/dev/null \
  || echo "      ⚠️ 从 Console 下载 agent 失败，跳过"
chmod +x /opt/gnb/bin/node-agent.sh 2>/dev/null || true

# 创建 agent 环境配置（TOKEN 统一认证）
cat > /opt/gnb/bin/agent.env << AGENTEOF
CONSOLE_URL=$API_BASE
TOKEN=$TOKEN
NODE_ID=${PLATFORM_NODE_ID:-$NODE_NAME}
GNB_NODE_ID=$GNB_NODE_ID
GNB_MAP_PATH=/opt/gnb/conf/$GNB_NODE_ID/gnb.map
GNB_CTL=gnb_ctl
CLAW_PORT=$CLAW_PORT
AGENTEOF
chmod 600 /opt/gnb/bin/agent.env

# 清理旧命名的 agent 服务（如果存在）
systemctl stop gnb-agent.timer 2>/dev/null || true
systemctl disable gnb-agent.timer 2>/dev/null || true
rm -f /etc/systemd/system/gnb-agent.{service,timer} 2>/dev/null || true

if command -v systemctl &>/dev/null; then
  cat > /etc/systemd/system/node-agent.service << SVCEOF
[Unit]
Description=GNB Node Monitor Agent
After=gnb.service

[Service]
Type=oneshot
EnvironmentFile=/opt/gnb/bin/agent.env
ExecStart=/opt/gnb/bin/node-agent.sh
SVCEOF

  cat > /etc/systemd/system/node-agent.timer << TMREOF
[Unit]
Description=GNB Agent Timer

[Timer]
OnBootSec=15s
OnUnitActiveSec=10s
AccuracySec=1s

[Install]
WantedBy=timers.target
TMREOF

  systemctl daemon-reload
  systemctl enable node-agent.timer
  systemctl start node-agent.timer
  echo "      ✅ Agent 已安装（systemd timer 每 10s）"
else
  (crontab -l 2>/dev/null; echo "* * * * * /opt/gnb/bin/node-agent.sh") | sort -u | crontab -
  echo "      ✅ Agent 已安装（cron 每分钟）"
fi

# ============================================
# Step 12: 通知 Console 已就绪
# ============================================
echo "[12/12] 通知 Console 节点已就绪..."

READY_RESP=$(curl -sS -X POST "$API_BASE/api/enroll/${PLATFORM_NODE_ID:-$NODE_NAME}/ready" \
  -H "$ENROLL_AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"sshUser\":\"$SSH_USER\",\"sshPort\":22,\"tunAddr\":\"$TUN_ADDR\"}")

echo "      $(echo "$READY_RESP" | json_val message)"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║  ✅ 初始化完成                        ║"
echo "  ║  GNB TUN: $TUN_ADDR                  ║"
echo "  ║  Agent: 推模式监控已启动              ║"
echo "  ║  OpenClaw: $([ "$CLAW_INSTALLED" = "true" ] && echo "已安装 + Token 已注册" || echo "未安装")          ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
