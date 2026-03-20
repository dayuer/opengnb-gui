#!/bin/bash
# SynonClaw Console — 节点初始化脚本
#
# 流程：
#   1. 安装 GNB（编译或已安装跳过）
#   2. 获取 passcode 并提交注册
#   3. 等待管理员审批（审批时分配 TUN 地址和 GNB 节点 ID）
#   4. 配置 GNB（密钥生成 + 公钥交换 + 配置文件 + systemd）
#   5. 启动 GNB 并等待 TUN 接口
#   6. 创建 synon 用户（sudo 免密）
#   7. 安装 Node.js v22 + OpenClaw
#   8. 下载 Console SSH 公钥
#   9. 通知 Console 已就绪
#
# 用法（在目标节点以 root 执行）：
#   curl -sSL https://api.synonclaw.com/api/enroll/init.sh | bash

set -euo pipefail

# --- 参数（全部可通过环境变量覆盖）---
CONSOLE="${CONSOLE:-api.synonclaw.com}"
NODE_ID="${NODE_ID:-$(hostname -s)}"
NODE_NAME="${NODE_NAME:-$NODE_ID}"
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
echo "  ║  SynonClaw Console — 节点初始化 v0.5.0     ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  Console:  $CONSOLE ($API_BASE)"
echo "  Node ID:  $NODE_ID"
echo ""

# ============================================
# Step 1: 安装 GNB
# ============================================
echo "[1/9] 安装 GNB..."

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
    apt-get update -qq && apt-get install -y -qq build-essential curl
elif command -v dnf &>/dev/null; then
    dnf install -y -q gcc make curl
elif command -v yum &>/dev/null; then
    yum install -y -q gcc make curl
elif command -v apk &>/dev/null; then
    apk add -q build-base curl bash
elif command -v pacman &>/dev/null; then
    pacman -Sy --noconfirm base-devel curl >/dev/null
elif command -v zypper &>/dev/null; then
    zypper install -y -n gcc make curl
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
echo "[2/9] 提交注册..."

if [ -z "${PASSCODE:-}" ]; then
    # 未传入 PASSCODE → 使用 ADMIN_TOKEN 自动获取
    if [ -z "${ADMIN_TOKEN:-}" ]; then
        echo "      [失败] 未传入 PASSCODE 或 ADMIN_TOKEN"
        echo "      用法: curl ... | ADMIN_TOKEN=<token> bash"
        exit 1
    fi
    echo "      自动获取 passcode..."
    PC_RESP=$(curl -sS "$API_BASE/api/enroll/passcode" \
      -H "Authorization: Bearer $ADMIN_TOKEN")
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
  -d "{\"passcode\":\"$PASSCODE\",\"id\":\"$NODE_ID\",\"name\":\"$NODE_NAME\"}")

STATUS=$(echo "$ENROLL_RESP" | json_val status)
ENROLL_TOKEN=$(echo "$ENROLL_RESP" | json_val enrollToken)
echo "      $(echo "$ENROLL_RESP" | json_val message)"

if [ "$STATUS" = "error" ]; then
    echo "      [失败] 注册失败"
    exit 1
fi

if [ -z "$ENROLL_TOKEN" ]; then
    echo "      [失败] 未获取到 enrollToken"
    exit 1
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
    resp=$(curl -sS -H "$ENROLL_AUTH" "$API_BASE/api/enroll/status/$NODE_ID" 2>/dev/null || echo '{}')
    STATUS=$(echo "$resp" | json_val status)
    TUN_ADDR=$(echo "$resp" | json_val tunAddr)
    GNB_NODE_ID=$(echo "$resp" | json_val gnbNodeId)
    CONSOLE_GNB_NODE_ID=$(echo "$resp" | json_val consoleGnbNodeId)
    CONSOLE_GNB_TUN_ADDR=$(echo "$resp" | json_val consoleGnbTunAddr)
}

if [ "$STATUS" = "approved" ]; then
    echo "      已审批（之前已注册）"
    fetch_status
else
    echo "[3/9] 等待管理员审批..."
    echo "      审批时将分配 GNB TUN 地址 (每 10 秒检查, Ctrl+C 退出)"
    echo ""
    while true; do
        sleep 10
        fetch_status
        case "$STATUS" in
            approved) echo "" && echo "      ✅ 审批通过！"; break ;;
            rejected) echo "" && echo "      ❌ 审批被拒绝"; exit 1 ;;
            pending)  printf "." ;;
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
echo "[4/9] 配置 GNB..."

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
    curl -sS -X POST "$API_BASE/api/enroll/$NODE_ID/gnb-pubkey" \
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
echo "[5/9] 启动 GNB..."

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
  --crypto rc4 \\
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
    /opt/gnb/bin/gnb -c "$GNB_CONF" -i gnb_tun --crypto rc4 --address-secure=on -d
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
fi

# ============================================
# Step 6: 创建 synon 用户
# ============================================
echo "[6/9] 创建运维用户 $SSH_USER..."

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
# Step 7: 安装 Node.js v22 + OpenClaw
# ============================================
echo "[7/9] 安装 Node.js v22 + OpenClaw..."

# 检测当前 Node.js 版本
NODE_VER=$(node --version 2>/dev/null | sed 's/v//' || echo "0")
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
    echo "      Node.js ${NODE_VER:-未安装}, 需要 >= 22"
    # 安装 n 版本管理器并升级到 v22
    if command -v npm &>/dev/null; then
        npm install -g n 2>/dev/null || true
    else
        curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s 22
    fi
    n 22 2>&1 | tail -3
    hash -r 2>/dev/null
    echo "      Node.js $(node --version) 已安装"
else
    echo "      Node.js v${NODE_VER} ✓"
fi

# 安装 OpenClaw
if ! command -v openclaw &>/dev/null || openclaw --version 2>/dev/null | grep -q "0.0.1"; then
    echo "      安装 openclaw@latest ..."
    npm uninstall -g openclaw 2>/dev/null || true
    npm install -g openclaw@latest 2>&1 | tail -3
else
    echo "      OpenClaw $(openclaw --version 2>/dev/null) ✓"
fi

# ============================================
# Step 8: 下载 Console SSH 公钥
# ============================================
echo "[8/9] 下载 Console SSH 公钥..."

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
# Step 8: 通知 Console 已就绪
# ============================================
echo "[9/9] 通知 Console 节点已就绪..."

READY_RESP=$(curl -sS -X POST "$API_BASE/api/enroll/$NODE_ID/ready" \
  -H "$ENROLL_AUTH" \
  -H "Content-Type: application/json" \
  -d "{\"sshUser\":\"$SSH_USER\",\"sshPort\":22,\"tunAddr\":\"$TUN_ADDR\"}")

echo "      $(echo "$READY_RESP" | json_val message)"

# ============================================
# Step 10: 安装监控 Agent（推模式）
# ============================================
echo "[10/10] 安装监控 Agent..."

# 下载 agent 脚本
curl -sSf "$API_BASE/api/enroll/node-agent.sh" -o /opt/gnb/bin/node-agent.sh 2>/dev/null \
  || echo "      ⚠️ 从 Console 下载 agent 失败，跳过"
chmod +x /opt/gnb/bin/node-agent.sh 2>/dev/null || true

# 获取节点 token（OpenClaw 的 token 会在 provisioning 后分配，先用 passcode 占位）
NODE_TOKEN="${PASSCODE}"

# 创建 agent 环境配置
cat > /opt/gnb/bin/agent.env << AGENTEOF
CONSOLE_URL=$API_BASE
NODE_TOKEN=$NODE_TOKEN
GNB_NODE_ID=$GNB_NODE_ID
GNB_MAP_PATH=/opt/gnb/conf/$GNB_NODE_ID/gnb.map
GNB_CTL=gnb_ctl
CLAW_PORT=18789
AGENTEOF
chmod 600 /opt/gnb/bin/agent.env  # @alpha: 敏感信息权限加固

if command -v systemctl &>/dev/null; then
  # systemd service
  cat > /etc/systemd/system/gnb-agent.service << SVCEOF
[Unit]
Description=GNB Node Monitor Agent
After=gnb.service

[Service]
Type=oneshot
EnvironmentFile=/opt/gnb/bin/agent.env
ExecStart=/opt/gnb/bin/node-agent.sh
SVCEOF

  # systemd timer（每 10s 触发）
  cat > /etc/systemd/system/gnb-agent.timer << TMREOF
[Unit]
Description=GNB Agent Timer

[Timer]
OnBootSec=15
OnUnitActiveSec=10

[Install]
WantedBy=timers.target
TMREOF

  systemctl daemon-reload
  systemctl enable gnb-agent.timer
  systemctl start gnb-agent.timer
  echo "      ✅ Agent 已安装（systemd timer 每 10s）"
else
  # 降级：crontab
  (crontab -l 2>/dev/null; echo "* * * * * /opt/gnb/bin/node-agent.sh") | sort -u | crontab -
  echo "      ✅ Agent 已安装（cron 每分钟）"
fi

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║  ✅ 初始化完成                        ║"
echo "  ║  GNB TUN: $TUN_ADDR                  ║"
echo "  ║  Agent: 推模式监控已启动              ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
