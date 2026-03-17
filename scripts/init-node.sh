#!/bin/bash
# GNB Console — 节点初始化脚本
#
# 流程：
#   1. 自动安装 GNB（编译或已安装跳过）
#   2. 通过 API 获取注册 passcode，安装完成后提交注册申请
#   3. 等待管理员在 Web UI 审批
#   4. 审批通过后，创建 synon 用户（sudo 免密）
#   5. 下载 Console 的 SSH 公钥并写入 authorized_keys
#   6. 通知 Console 已就绪（Console 将 SSH 远程安装 OpenClaw）
#
# 用法（在目标节点以 root 执行）：
#   curl -sSL https://api.synonclaw.com/api/enroll/init.sh | bash

set -euo pipefail

# --- 参数（全部可通过环境变量覆盖）---
CONSOLE="${CONSOLE:-api.synonclaw.com}"
NODE_ID="${NODE_ID:-$(hostname -s)}"
NODE_NAME="${NODE_NAME:-$NODE_ID}"
TUN_ADDR="${TUN_ADDR:-auto}"
GNB_MAP="${GNB_MAP:-/opt/gnb/conf/$NODE_ID/gnb.map}"
GNB_CTL="${GNB_CTL:-gnb_ctl}"
SSH_USER="synon"

# 自动检测协议：域名用 https，IP 用 http
if echo "$CONSOLE" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]'; then
    API_BASE="http://$CONSOLE"
else
    API_BASE="https://$CONSOLE"
fi

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║  GNB Console — 节点初始化 v0.2.0     ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  Console:  $CONSOLE ($API_BASE)"
echo "  Node ID:  $NODE_ID"
echo "  TUN Addr: $TUN_ADDR"
echo ""

# ============================================
# Step 1: 安装 GNB
# ============================================
echo "[1/6] 安装 GNB..."

if command -v gnb &>/dev/null; then
    echo "      GNB 已安装: $(which gnb)"
else
    echo "      从 Console 镜像下载源码..."

    # 安装编译依赖（多 OS 适配）
    if [ "$(uname)" = "Darwin" ]; then
        xcode-select --install 2>/dev/null || true
        command -v brew &>/dev/null && brew install -q curl 2>/dev/null || true
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

    # 优先从 Console 镜像下载（终端可能无法访问 GitHub）
    if curl -sSf "$API_BASE/api/mirror/gnb/opengnb-src.tar.gz" -o /tmp/opengnb-src.tar.gz 2>/dev/null; then
        echo "      从 Console 镜像下载成功"
        mkdir -p /tmp/opengnb
        tar xzf /tmp/opengnb-src.tar.gz -C /tmp/opengnb --strip-components=1
    else
        echo "      Console 镜像不可用，尝试 GitHub..."
        if command -v git &>/dev/null; then
            git clone --depth 1 https://github.com/opengnb/opengnb.git /tmp/opengnb
        else
            curl -sSL "https://github.com/opengnb/opengnb/archive/refs/heads/master.tar.gz" -o /tmp/opengnb-src.tar.gz
            mkdir -p /tmp/opengnb
            tar xzf /tmp/opengnb-src.tar.gz -C /tmp/opengnb --strip-components=1
        fi
    fi

    cd /tmp/opengnb && make -j$(nproc)

    # 安装
    mkdir -p /opt/gnb/bin
    cp /tmp/opengnb/bin/* /opt/gnb/bin/
    ln -sf /opt/gnb/bin/gnb /usr/local/bin/gnb
    ln -sf /opt/gnb/bin/gnb_ctl /usr/local/bin/gnb_ctl

    echo "      GNB 编译安装完成"
fi

# 确保配置目录存在
GNB_CONF_DIR="/opt/gnb/conf/$NODE_ID"
mkdir -p "$GNB_CONF_DIR"

# 生成 ED25519 密钥（如果不存在）
if [ ! -f "$GNB_CONF_DIR/ed25519_private.key" ]; then
    gnb -c "$GNB_CONF_DIR" --setup-node 2>/dev/null || true
    echo "      已生成节点密钥"
fi

# ============================================
# Step 2: 获取 passcode 并提交注册
# ============================================
echo "[2/6] 获取注册 passcode 并提交注册..."

# 从 Console 获取一次性 passcode
PASSCODE_RESP=$(curl -sS "$API_BASE/api/enroll/passcode?nodeId=$NODE_ID")
PASSCODE=$(echo "$PASSCODE_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('passcode',''))" 2>/dev/null || echo "")

if [ -z "$PASSCODE" ]; then
    echo "      [失败] 无法获取 passcode: $PASSCODE_RESP"
    exit 1
fi

echo "      Passcode: ${PASSCODE:0:8}..."

# 提交注册申请
ENROLL_RESP=$(curl -sS -X POST "$API_BASE/api/enroll" \
  -H "Content-Type: application/json" \
  -d "{\"passcode\":\"$PASSCODE\",\"id\":\"$NODE_ID\",\"name\":\"$NODE_NAME\",\"tunAddr\":\"$TUN_ADDR\",\"gnbMapPath\":\"$GNB_MAP\",\"gnbCtlPath\":\"$GNB_CTL\"}")

STATUS=$(echo "$ENROLL_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null || echo "error")
MSG=$(echo "$ENROLL_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))" 2>/dev/null || echo "$ENROLL_RESP")

echo "      $MSG"

if [ "$STATUS" = "error" ]; then
    echo "      [失败] 注册失败"
    exit 1
fi

if [ "$STATUS" = "approved" ]; then
    echo "      节点已通过审批（之前已注册）"
    # 跳到 Step 4
else
    # ============================================
    # Step 3: 等待管理员审批
    # ============================================
    echo "[3/6] 等待管理员审批..."
    echo "      请登录 Console Web UI 审批此节点"
    echo "      (每 10 秒检查一次, Ctrl+C 退出)"
    echo ""

    while true; do
        sleep 10
        CHECK=$(curl -sS "$API_BASE/api/enroll/status/$NODE_ID" 2>/dev/null || echo '{"status":"error"}')
        CUR_STATUS=$(echo "$CHECK" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','error'))" 2>/dev/null || echo "error")

        case "$CUR_STATUS" in
            approved)
                echo ""
                echo "      ✅ 审批通过！"
                break
                ;;
            rejected)
                echo ""
                echo "      ❌ 审批被拒绝"
                exit 1
                ;;
            pending)
                printf "."
                ;;
        esac
    done
fi

# ============================================
# Step 4: 创建 synon 用户 (审批通过后)
# ============================================
echo "[4/6] 创建运维用户 $SSH_USER ..."

if id "$SSH_USER" &>/dev/null; then
    echo "      用户已存在"
else
    useradd -m -s /bin/bash "$SSH_USER"
    echo "      用户已创建"
fi

# sudo 免密
SUDOERS_FILE="/etc/sudoers.d/$SSH_USER"
if [ ! -f "$SUDOERS_FILE" ]; then
    echo "$SSH_USER ALL=(ALL) NOPASSWD: ALL" > "$SUDOERS_FILE"
    chmod 440 "$SUDOERS_FILE"
    echo "      sudo 免密已配置"
fi

# ============================================
# Step 5: 下载 Console SSH 公钥
# ============================================
echo "[5/6] 下载 Console SSH 公钥..."

PUBKEY_JSON=$(curl -sS "$API_BASE/api/enroll/pubkey")
PUBKEY=$(echo "$PUBKEY_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['publicKey'])" 2>/dev/null || echo "")

if [ -z "$PUBKEY" ]; then
    echo "      [失败] 无法获取公钥: $PUBKEY_JSON"
    exit 1
fi

SSH_DIR="/home/$SSH_USER/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

if grep -qF "$PUBKEY" "$AUTH_KEYS" 2>/dev/null; then
    echo "      公钥已存在"
else
    echo "$PUBKEY" >> "$AUTH_KEYS"
    echo "      公钥已写入"
fi
chmod 600 "$AUTH_KEYS"
chown -R "$SSH_USER:$SSH_USER" "$SSH_DIR"

# ============================================
# Step 6: 通知 Console 节点已就绪
# ============================================
echo "[6/6] 通知 Console 节点已就绪..."

READY_RESP=$(curl -sS -X POST "$API_BASE/api/enroll/$NODE_ID/ready" \
  -H "Content-Type: application/json" \
  -d "{\"sshUser\":\"$SSH_USER\",\"sshPort\":22}")

echo "      $(echo "$READY_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','就绪'))" 2>/dev/null || echo "已通知")"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║  ✅ 初始化完成                        ║"
echo "  ║  Console 将通过 SSH 远程安装 OpenClaw  ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
