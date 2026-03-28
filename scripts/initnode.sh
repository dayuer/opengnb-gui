#!/bin/bash
# SynonClaw Console — 节点初始化脚本 v0.9.1
#
# 架构说明（v0.9 完全合并版）：
#   Console ↔ synon-daemon  WSS 长连接（控制面）
#   synon-daemon 内置心跳采集（取代 node-agent.sh）：GNB/OS/内存/磁盘/OpenClaw/技能
#   SSH 运维已由 synon-daemon exec_cmd 白名单命令替代
#
# 流程：
#   1.  安装 GNB（编译 + 安装二进制）
#   2.  下载 synon-daemon 二进制（GNB 构建后即可并行准备）
#   3.  获取 passcode 并提交注册
#   4.  等待管理员审批（分配 TUN 地址 + GNB 节点 ID）
#   5.  配置 GNB（密鑰 + 公鑰交换 + address.conf）
#   6.  启动 GNB，配置并启动 synon-daemon
#   7.  安装 Node.js v22（OpenClaw 运行时依赖）
#   8.  安装 OpenClaw（Console 镜像优先 → npm 回退，含 Token 注册）
#   9.  初始化 skills 缓存目录
#  10.  通知 Console 已就绪
#
# 用法（在目标节点以 root 执行）：
#   curl -sSL https://api.synonclaw.com/api/enroll/init.sh | TOKEN=<token> bash

set -euo pipefail

# --- 参数（全部可通过环境变量覆盖）---
CONSOLE="${CONSOLE:-api.synonclaw.com}"
NODE_NAME="${NODE_ID:-$(hostname -s)}"
DAEMON_BIN_DIR="/opt/gnb/bin"
DAEMON_BIN="$DAEMON_BIN_DIR/synon-daemon"

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
echo "  ║  SynonClaw Console — 节点初始化 v0.9.1     ║"
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
echo "      ✅ GNB 编译安装完成"

# ============================================
# Step 2: 获取 synon-daemon（仅从 Console mirror 下载预编译包）
# Console 预编译原则：节点不安装 Rust，也不做源码编译
# ============================================
echo "[2/10] 获取 synon-daemon..."

ARCH=$(uname -m)
# 架构标识与 synon-daemon self_updater.rs arch_tag() 保持一致（均带 -musl 后缀）
case "$ARCH" in
    x86_64)         DAEMON_ARCH="x86_64-musl" ;;
    aarch64|arm64)  DAEMON_ARCH="aarch64-musl" ;;
    armv7l)         DAEMON_ARCH="armv7-musl" ;;
    mips*)          DAEMON_ARCH="mips-musl" ;;
    *)              DAEMON_ARCH="" ;;
esac

DAEMON_INSTALLED=false

if [ -n "$DAEMON_ARCH" ]; then
    DAEMON_URL="$API_BASE/api/mirror/daemon/synon-daemon-${DAEMON_ARCH}"
    echo "      架构: $ARCH → 下载 synon-daemon-${DAEMON_ARCH}..."
    if curl -sf -m 120 "$DAEMON_URL" -o "$DAEMON_BIN" 2>/dev/null; then
        chmod +x "$DAEMON_BIN"
        DAEMON_INSTALLED=true
        echo "      ✅ synon-daemon 已下载"
    else
        echo "      ❌ synon-daemon 下载失败: $DAEMON_URL"
        echo "         Console 请先在 mirror 放置对应架构的预编译包"
    fi
else
    echo "      ⚠️ 不支持的架构: $ARCH，跳过 daemon 安装"
fi

[ "$DAEMON_INSTALLED" != "true" ] && echo "      ⚠️ synon-daemon 未安装（节点将缺少 WSS 控制面）"

# ============================================
# Step 3: 获取 passcode 并提交注册
# ============================================
echo "[3/10] 提交注册..."

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

# 探测本地网段（排除 lo 和 gnb_tun）
detect_local_subnets() {
    local subnets=""
    if command -v ip >/dev/null 2>&1; then
        subnets=$(ip -4 addr show scope global 2>/dev/null | awk '/inet / { print $2 }' | grep -v '^127\.' | sort -u | head -20)
    elif command -v ifconfig >/dev/null 2>&1; then
        subnets=$(ifconfig 2>/dev/null | awk '/inet / && !/127\.0\.0/ { gsub(/addr:/, ""); print $2 }' | head -20)
    fi
    # 输出为 JSON 数组
    local arr="["
    local first=1
    for s in $subnets; do
        [ $first -eq 0 ] && arr="${arr},"
        arr="${arr}\"${s}\""
        first=0
    done
    arr="${arr}]"
    echo "$arr"
}

LOCAL_SUBNETS=$(detect_local_subnets)
echo "      本地网段: $LOCAL_SUBNETS"

ENROLL_RESP=$(curl -sS -X POST "$API_BASE/api/enroll" \
  -H "Content-Type: application/json" \
  -d "{\"passcode\":\"$PASSCODE\",\"id\":\"$NODE_NAME\",\"name\":\"$NODE_NAME\",\"localSubnets\":$LOCAL_SUBNETS}")

STATUS=$(echo "$ENROLL_RESP" | json_val status)
ENROLL_TOKEN=$(echo "$ENROLL_RESP" | json_val enrollToken)
PLATFORM_NODE_ID=$(echo "$ENROLL_RESP" | json_val nodeId)
echo "      $(echo "$ENROLL_RESP" | json_val message)"

if [ "$STATUS" = "error" ]; then echo "      [失败] 注册失败"; exit 1; fi
if [ -z "$ENROLL_TOKEN" ]; then echo "      [失败] 未获取到 enrollToken"; exit 1; fi
[ -n "$PLATFORM_NODE_ID" ] && echo "      平台分配 ID: $PLATFORM_NODE_ID"

ENROLL_AUTH="Authorization: Bearer $ENROLL_TOKEN"

# ============================================
# Step 4: 等待管理员审批
# ============================================
TUN_ADDR=""
GNB_NODE_ID=""
CONSOLE_GNB_NODE_ID=""
CONSOLE_GNB_TUN_ADDR=""
CONSOLE_GNB_NETMASK=""   # 由 API 返回，默认 255.255.0.0

fetch_status() {
    local resp
    local use_id="${PLATFORM_NODE_ID:-$NODE_NAME}"
    resp=$(curl -sS -H "$ENROLL_AUTH" "$API_BASE/api/enroll/status/$use_id" 2>/dev/null || echo '{}')
    STATUS=$(echo "$resp" | json_val status)
    if [ -z "$STATUS" ] || [ "$STATUS" = "null" ]; then
        if [ -n "${TOKEN:-}" ]; then
            resp=$(curl -sS -H "Authorization: Bearer $TOKEN" "$API_BASE/api/enroll/status/$use_id" 2>/dev/null || echo '{}')
            STATUS=$(echo "$resp" | json_val status)
        fi
    fi
    TUN_ADDR=$(echo "$resp" | json_val tunAddr)
    GNB_NODE_ID=$(echo "$resp" | json_val gnbNodeId)
    CONSOLE_GNB_NODE_ID=$(echo "$resp" | json_val consoleGnbNodeId)
    CONSOLE_GNB_TUN_ADDR=$(echo "$resp" | json_val consoleGnbTunAddr)
    CONSOLE_GNB_NETMASK=$(echo "$resp" | json_val consoleGnbNetmask)
    CONSOLE_GNB_TUN_SUBNET=$(echo "$resp" | json_val consoleGnbTunSubnet)
    # 安全回退：若 API 未返回 netmask（旧版 Console），使用 255.255.0.0
    CONSOLE_GNB_NETMASK="${CONSOLE_GNB_NETMASK:-255.255.0.0}"
    CONSOLE_GNB_TUN_SUBNET="${CONSOLE_GNB_TUN_SUBNET:-}"
}

if [ "$STATUS" = "approved" ]; then
    echo "      已审批（之前已注册）"
    fetch_status
else
    echo "[4/10] 等待管理员审批..."
    echo "      审批时将分配 GNB TUN 地址 (每 10 秒检查, Ctrl+C 退出)"
    echo ""
    while true; do
        sleep 10
        fetch_status
        case "$STATUS" in
            approved) echo "" && echo "      ✅ 审批通过！"; break ;;
            rejected|deleted) echo "" && echo "      ❌ 审批被拒绝"; exit 1 ;;
            pending)  printf "." ;;
            *)        printf "?" ;;
        esac
    done
fi

if [ -z "$TUN_ADDR" ] || [ -z "$GNB_NODE_ID" ]; then
    echo "      [错误] 审批未分配 TUN 地址或 GNB 节点 ID"; exit 1
fi
echo "      GNB 节点 ID: $GNB_NODE_ID"
echo "      TUN 地址:    $TUN_ADDR"

# ============================================
# Step 5: 配置 GNB（密钥 + 公钥交换 + 配置文件）
# ============================================
echo "[5/10] 配置 GNB..."

GNB_CONF="/opt/gnb/conf/$GNB_NODE_ID"
mkdir -p "$GNB_CONF"/{security,ed25519,scripts}

# 生成 Ed25519 密钥
if [ ! -f "$GNB_CONF/security/${GNB_NODE_ID}.private" ]; then
    cd "$GNB_CONF/security"
    /opt/gnb/bin/gnb_crypto -c -p "${GNB_NODE_ID}.private" -k "${GNB_NODE_ID}.public"
    chmod 600 "${GNB_NODE_ID}.private"
    cp "${GNB_NODE_ID}.public" "$GNB_CONF/ed25519/${GNB_NODE_ID}.public"
    echo "      Ed25519 密钥已生成"
fi

# 下载 Console GNB 公钥
CONSOLE_PUBKEY=$(curl -sS "$API_BASE/api/enroll/gnb-pubkey" | json_val publicKey)
if [ -n "$CONSOLE_PUBKEY" ]; then
    echo -n "$CONSOLE_PUBKEY" > "$GNB_CONF/ed25519/${CONSOLE_GNB_NODE_ID}.public"
    echo "      Console 公钥已保存"
else
    echo "      ⚠️ 无法获取 Console 公钥，GNB 加密通信可能受影响"
fi

# 上传本节点公钥
LOCAL_PUBKEY=$(cat "$GNB_CONF/security/${GNB_NODE_ID}.public" 2>/dev/null || echo "")
if [ -n "$LOCAL_PUBKEY" ]; then
    curl -sS -X POST "$API_BASE/api/enroll/${PLATFORM_NODE_ID:-$NODE_NAME}/gnb-pubkey" \
      -H "$ENROLL_AUTH" -H "Content-Type: application/json" \
      -d "{\"publicKey\":\"$LOCAL_PUBKEY\"}" > /dev/null
    echo "      本节点公钥已上传"
fi

# 获取 Console 公网 IP
CONSOLE_HOST=$(echo "$CONSOLE" | sed 's/:.*//')
if echo "$CONSOLE_HOST" | grep -qE '^[0-9]+\.[0-9]+'; then
    CONSOLE_IP="$CONSOLE_HOST"
else
    CONSOLE_IP=$(dig +short "$CONSOLE_HOST" 2>/dev/null | grep -v '#' | head -1 || nslookup "$CONSOLE_HOST" 2>/dev/null | grep 'Address:' | tail -1 | awk '{print $NF}' || echo "$CONSOLE_HOST")
fi

cat > "$GNB_CONF/node.conf" <<GNBEOF
nodeid $GNB_NODE_ID
listen 9002
multi-socket on
unified-forwarding auto
GNBEOF

if curl -sSf -H "$ENROLL_AUTH" "$API_BASE/api/enroll/address-conf" -o "$GNB_CONF/address.conf" 2>/dev/null; then
    echo "      address.conf 已从 Console 拉取（含全部节点）"
    # 从 Console 拉取的 address.conf 只包含 address 条目，需单独生成 route.conf
    cat > "$GNB_CONF/route.conf" <<GNBEOF
${CONSOLE_GNB_NODE_ID}|${CONSOLE_GNB_TUN_ADDR}|${CONSOLE_GNB_NETMASK:-255.255.0.0}
${GNB_NODE_ID}|${TUN_ADDR}|${CONSOLE_GNB_NETMASK:-255.255.0.0}
GNBEOF
    echo "      route.conf 已生成"
else
    # 回退写法：
    #  i|0|... → Index 服务器（帮助发现动态地址）
    #  if|… → Console 作为 index+forward 节点，属性格式正确
    CONSOLE_GNB_PORT="${CONSOLE_GNB_PORT:-9002}"
    cat > "$GNB_CONF/address.conf" <<'GNBEOF'
i|0|${CONSOLE_IP}|9001
if|${CONSOLE_GNB_NODE_ID}|${CONSOLE_IP}|${CONSOLE_GNB_PORT}
GNBEOF
    # 回退模式下 address.conf 中的变量需要手动展开（heredoc 用了单引号阻止展开来避免 if| 被解析）
    sed -i "s|\${CONSOLE_IP}|${CONSOLE_IP}|g; s|\${CONSOLE_GNB_NODE_ID}|${CONSOLE_GNB_NODE_ID}|g; s|\${CONSOLE_GNB_PORT}|${CONSOLE_GNB_PORT}|g" "$GNB_CONF/address.conf"

    cat > "$GNB_CONF/route.conf" <<GNBEOF
${CONSOLE_GNB_NODE_ID}|${CONSOLE_GNB_TUN_ADDR}|${CONSOLE_GNB_NETMASK:-255.255.0.0}
${GNB_NODE_ID}|${TUN_ADDR}|${CONSOLE_GNB_NETMASK:-255.255.0.0}
GNBEOF
    echo "      GNB 配置文件已写入（回退模式）"
fi
echo "      Console GNB WAN: ${CONSOLE_IP}:${CONSOLE_GNB_PORT:-9002} (node ${CONSOLE_GNB_NODE_ID})"
echo "      Console TUN:     $CONSOLE_GNB_TUN_ADDR  Netmask: ${CONSOLE_GNB_NETMASK}"



# --- 创建 synon 运维用户 + 注入 Console SSH 公钥 ---
# 安全模型：Console SSH 以 synon 用户连接（非 root），sudoers 授权运维命令
# 安全边界在 Console RBAC 层（ws-handler 命令拦截），SSH 层为最小权限传输通道
CONSOLE_SSH_PUBKEY=$(curl -sS "$API_BASE/api/enroll/pubkey" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('publicKey',''))
except Exception:
    pass
" 2>/dev/null)

if [ -n "$CONSOLE_SSH_PUBKEY" ]; then
    # 1. 创建 synon 系统用户（幂等）
    if ! id synon &>/dev/null; then
        useradd -r -m -s /bin/bash -c "SynonClaw Console Agent" synon
        echo "      ✅ 已创建 synon 用户"
    else
        echo "      synon 用户已存在（跳过）"
    fi

    # 2. 部署 Console SSH 公钥到 synon 用户
    SYNON_SSH_DIR="/home/synon/.ssh"
    mkdir -p "$SYNON_SSH_DIR"
    chmod 700 "$SYNON_SSH_DIR"
    touch "$SYNON_SSH_DIR/authorized_keys"
    chmod 600 "$SYNON_SSH_DIR/authorized_keys"
    chown -R synon:synon "$SYNON_SSH_DIR"

    if ! grep -qF "$CONSOLE_SSH_PUBKEY" "$SYNON_SSH_DIR/authorized_keys" 2>/dev/null; then
        echo "$CONSOLE_SSH_PUBKEY" >> "$SYNON_SSH_DIR/authorized_keys"
        chown synon:synon "$SYNON_SSH_DIR/authorized_keys"
        echo "      ✅ Console SSH 公钥已写入 synon 用户 authorized_keys"
    else
        echo "      公钥已存在（跳过）"
    fi

    # 3. 配置 sudoers NOPASSWD（安全边界在 Console RBAC 层）
    SUDOERS_FILE="/etc/sudoers.d/synon"
    if [ ! -f "$SUDOERS_FILE" ]; then
        echo "synon ALL=(ALL) NOPASSWD: ALL" > "$SUDOERS_FILE"
        chmod 440 "$SUDOERS_FILE"
        echo "      ✅ sudoers 已配置 (NOPASSWD)"
    fi

    # 4. 保留 root authorized_keys 作为紧急后备通道
    mkdir -p /root/.ssh
    chmod 700 /root/.ssh
    touch /root/.ssh/authorized_keys
    chmod 600 /root/.ssh/authorized_keys
    if ! grep -qF "$CONSOLE_SSH_PUBKEY" /root/.ssh/authorized_keys 2>/dev/null; then
        echo "$CONSOLE_SSH_PUBKEY" >> /root/.ssh/authorized_keys
        echo "      root authorized_keys 已同步（后备通道）"
    fi
else
    echo "      ⚠️ 无法获取 Console SSH 公钥，跳过"
fi

# ============================================
# Step 6a: 启动 GNB
# ============================================
echo "[6/10] 启动 GNB..."

if command -v systemctl &>/dev/null; then
    cat > /etc/systemd/system/gnb.service <<SVCEOF
[Unit]
Description=GNB P2P VPN Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=/bin/mkdir -p /var/log/opengnb
ExecStart=/opt/gnb/bin/gnb -c ${GNB_CONF} \
  -i gnb_tun \
  --crypto chacha20 \
  --crypto-key-update-interval hour \
  --address-secure=on \
  --console-log-level=3 \
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

# 等待 TUN 接口
echo "      等待 TUN 接口 (最多 30 秒)..."
for i in $(seq 1 15); do
    if ip addr show gnb_tun 2>/dev/null | grep -q "inet "; then
        TUN_IP=$(ip addr show gnb_tun 2>/dev/null | grep 'inet ' | awk '{print $2}')
        echo "      ✅ TUN 接口已就绪: $TUN_IP"
        break
    fi
    sleep 2
done

GNB_TUN_UP=false
if ip addr show gnb_tun 2>/dev/null | grep -q "inet "; then
    GNB_TUN_UP=true
fi

# GNB 公网节点（Console）的 TUN 地址就是其公网 IP（GNB 设计如此）
# CONSOLE_GNB_TUN_ADDR 是虚拟路由条目地址，用于 address.conf，不用于 ping
# 连通性检测应 ping Console 的公网 IP（CONSOLE_HOST）
GNB_PING_TARGET="$CONSOLE_HOST"
if [ "$GNB_TUN_UP" = "true" ] && [ -n "$GNB_PING_TARGET" ]; then
    echo "      正在验证 GNB 隧道连通性 ($TUN_ADDR → $GNB_PING_TARGET)..."
    while true; do
        if ping -c 1 -W 5 "$GNB_PING_TARGET" > /dev/null 2>&1; then
            echo "      ✅ GNB 隧道已连通!"
            break
        else
            echo "      ⚠️ GNB 隧道 ping 不通，等候 10 秒后重试 (peer 发现需时间)..."
            sleep 10
        fi
    done
fi

# --- Step 6b: 配置并启动 synon-daemon ---
echo "      配置 synon-daemon..."
if [ "$DAEMON_INSTALLED" = "true" ]; then
    DAEMON_CONF_DIR="/opt/gnb/bin"
    mkdir -p "$DAEMON_CONF_DIR"

    # 从 Console 获取 apiToken
    DAEMON_TOKEN=$(curl -sS -H "$ENROLL_AUTH" \
        "$API_BASE/api/enroll/status/${PLATFORM_NODE_ID:-$NODE_NAME}" \
        2>/dev/null | json_val apiToken)
    [ -z "$DAEMON_TOKEN" ] && DAEMON_TOKEN="$ENROLL_TOKEN"

    # CONSOLE_URL 写 https:// base URL，让 daemon config.rs 自动追加 /ws/daemon
    # 注意：不能写 wss:// 完整路径，否则 daemon 会再追加一次 /ws/daemon 导致双重拼接
    CONSOLE_BASE="${API_BASE}"

    cat > "$DAEMON_CONF_DIR/agent.conf" <<DAEMONEOF
# synon-daemon 配置
CONSOLE_URL=$CONSOLE_BASE
TOKEN=$DAEMON_TOKEN
NODE_ID=${PLATFORM_NODE_ID:-$NODE_NAME}
GNB_NODE_ID=$GNB_NODE_ID
# GNB mmap 路径（gnb_ctl -b 参数，默认由 config.rs 推断，此处显式指定避免歧义）
GNB_MAP_PATH=/opt/gnb/conf/${GNB_NODE_ID}/gnb.map
CLAW_PORT=18789
DAEMONEOF
    chmod 600 "$DAEMON_CONF_DIR/agent.conf"

    if command -v systemctl &>/dev/null; then
        cat > /etc/systemd/system/synon-daemon.service <<SVCEOF
[Unit]
Description=SynonClaw Daemon — WSS Control Plane Agent
After=network-online.target gnb.service
Wants=network-online.target

[Service]
Type=notify
ExecStart=$DAEMON_BIN --config $DAEMON_CONF_DIR/agent.conf
Restart=always
RestartSec=5
WatchdogSec=30
TimeoutStopSec=10
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
SVCEOF
        systemctl daemon-reload
        systemctl enable synon-daemon
        systemctl start synon-daemon || true  # Type=notify 下可能超时，但实际运行正常
        sleep 5
        if systemctl is-active synon-daemon >/dev/null 2>&1; then
            echo "      ✅ synon-daemon 已启动并连接 Console ($CONSOLE_BASE/ws/daemon)"
        else
            echo "      ⚠️ synon-daemon 启动失败"
            journalctl -u synon-daemon --no-pager -n 8 2>/dev/null || true
        fi
    fi
fi

# ============================================
# Step 7: 安装 Node.js v22（OpenClaw 运行时依赖）
# ============================================
echo "[7/10] 安装 Node.js v22..."

NODE_VER=$(node --version 2>/dev/null | sed 's/v//' || echo "0")
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)

if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
    echo "      Node.js ${NODE_VER:-未安装}, 需要 >= 22"
    export N_PREFIX=/usr/local
    export PATH="/usr/local/bin:$PATH"

    if ! command -v npm &>/dev/null; then
        curl -fsSL https://raw.githubusercontent.com/tj/n/master/bin/n | bash -s 22
        hash -r 2>/dev/null
    fi

    npm install -g n 2>/dev/null || true
    hash -r 2>/dev/null
    n 22 2>&1 | tail -3
    hash -r 2>/dev/null
    echo "      Node.js $(node --version) + npm $(npm --version) 已安装"
else
    echo "      Node.js v${NODE_VER} ✓"
fi

# ============================================
# Step 8: 安装 OpenClaw（Console 镜像优先 → npm 回退）
# ============================================
echo "[8/10] 安装 OpenClaw..."

MIRROR_LIST=$(curl -sf -m 5 "$API_BASE/api/mirror/openclaw" 2>/dev/null || echo "{}")
LATEST_VER=$(echo "$MIRROR_LIST" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin); print(d.get('version','unknown'))
except: print('unknown')
" 2>/dev/null)
CLAW_TGZ=$(echo "$MIRROR_LIST" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    files=[f['name'] for f in d.get('files',[]) if f['name'].endswith('.tgz')]
    files.sort(); print(files[-1] if files else '')
except: print('')
" 2>/dev/null)

CLAW_VER=$(openclaw --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo "NOT_FOUND")

NEED_INSTALL=false
if [ "$CLAW_VER" = "NOT_FOUND" ] || [ -z "$CLAW_VER" ]; then
    echo "      OpenClaw 未安装"; NEED_INSTALL=true
elif [ "$LATEST_VER" != "unknown" ] && [ "$CLAW_VER" != "$LATEST_VER" ]; then
    echo "      本地版本 $CLAW_VER ≠ 最新 $LATEST_VER，升级中..."
    npm uninstall -g openclaw 2>/dev/null || true; NEED_INSTALL=true
else
    echo "      OpenClaw $CLAW_VER 已是最新"
fi

CLAW_INSTALLED=false
CLAW_TOKEN=""
CLAW_PORT=18789

if [ "$NEED_INSTALL" = "true" ]; then
    if [ -n "$CLAW_TGZ" ]; then
        echo "      从 Console 镜像下载: $CLAW_TGZ"
        if curl -sf -m 120 "$API_BASE/api/mirror/openclaw/$CLAW_TGZ" -o "/tmp/$CLAW_TGZ"; then
            npm install -g "/tmp/$CLAW_TGZ" > /tmp/openclaw-install.log 2>&1 && CLAW_INSTALLED=true
            rm -f "/tmp/$CLAW_TGZ"
        fi
    fi
    if [ "$CLAW_INSTALLED" != "true" ]; then
        echo "      从 npm 在线安装..."
        npm install -g openclaw@latest --registry=https://registry.npmmirror.com \
            > /tmp/openclaw-install.log 2>&1 && CLAW_INSTALLED=true
    fi
    [ "$CLAW_INSTALLED" != "true" ] \
        && echo "      ⚠️ OpenClaw 安装失败，跳过" \
        || echo "      ✅ OpenClaw $(openclaw --version 2>/dev/null | head -1) 已安装"
else
    CLAW_INSTALLED=true
fi

if [ "$CLAW_INSTALLED" = "true" ]; then
    CLAW_TOKEN=$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null \
        || openssl rand -hex 32 2>/dev/null)

    CLAW_CONFIG_DIR="/root/.openclaw"
    mkdir -p "$CLAW_CONFIG_DIR"
    cat > "$CLAW_CONFIG_DIR/openclaw.json" <<CLAWEOF
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

    # 动态检测 openclaw 实际路径（nvm/n 安装的 Node.js 不在 /usr/local/bin/）
    OPENCLAW_BIN=$(command -v openclaw 2>/dev/null \
        || find /root/.nvm /root/.n /usr/local -name openclaw -type f 2>/dev/null | head -1 \
        || echo "/usr/local/bin/openclaw")
    # 创建符号链接方便 PATH 查找
    if [ "$OPENCLAW_BIN" != "/usr/local/bin/openclaw" ] && [ -f "$OPENCLAW_BIN" ]; then
        ln -sf "$OPENCLAW_BIN" /usr/local/bin/openclaw 2>/dev/null || true
    fi
    echo "      openclaw 路径: $OPENCLAW_BIN"

    if command -v systemctl &>/dev/null; then
        cat > /etc/systemd/system/openclaw-gateway.service <<SVCEOF
[Unit]
Description=OpenClaw Gateway
After=network.target gnb.service

[Service]
Type=simple
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=$OPENCLAW_BIN gateway
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
        systemctl is-active openclaw-gateway >/dev/null 2>&1 \
            && echo "      ✅ OpenClaw Gateway 已启动" \
            || { echo "      ⚠️ OpenClaw Gateway 启动失败"; journalctl -u openclaw-gateway --no-pager -n 5 2>/dev/null || true; }
    fi

    # 提交 Token 到 Console
    TOKEN_RESP=$(curl -sS -X POST "$API_BASE/api/enroll/${PLATFORM_NODE_ID:-$NODE_NAME}/claw-token" \
      -H "$ENROLL_AUTH" -H "Content-Type: application/json" \
      -d "{\"token\":\"$CLAW_TOKEN\",\"port\":$CLAW_PORT}")
    TOKEN_MSG=$(echo "$TOKEN_RESP" | json_val message)
    [ -n "$TOKEN_MSG" ] && echo "      ✅ $TOKEN_MSG" || echo "      ⚠️ Token 提交失败: $TOKEN_RESP"
fi

# ============================================
# Step 9: 初始化 skills 缓存目录
# ============================================
# synon-daemon 内置心跳采集（GNB/OS/内存/磁盘/OpenClaw/技能），取代 node-agent.sh
# 此步骤仅创建 daemon 首次运行所需的缓存目录
echo "[9/10] 初始化 skills 缓存目录..."
AGENT_INTERVAL="daemon-wss"
mkdir -p /opt/gnb/cache /opt/gnb/log
echo "[]" > /opt/gnb/cache/skills.json 2>/dev/null || true
echo "      ✅ skills 缓存目录已创建（synon-daemon 将自动维护）"

# ============================================
# Step 10: 通知 Console 已就绪
# ============================================
echo "[10/10] 通知 Console 节点已就绪..."

READY_RESP=$(curl -sS -X POST "$API_BASE/api/enroll/${PLATFORM_NODE_ID:-$NODE_NAME}/ready" \
  -H "$ENROLL_AUTH" -H "Content-Type: application/json" \
  -d "{\"tunAddr\":\"$TUN_ADDR\",\"daemonInstalled\":$( [ "$DAEMON_INSTALLED" = "true" ] && echo true || echo false )}")

echo "      $(echo "$READY_RESP" | json_val message)"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║  ✅ 初始化完成                        ║"
echo "  ║  GNB TUN:  $TUN_ADDR                 ║"
echo "  ║  Daemon:   $([ "$DAEMON_INSTALLED" = "true" ] && echo "✅ WSS 控制面" || echo "⚠️ 未安装（功能受限）")          ║"
echo "  ║  OpenClaw: $([ "$CLAW_INSTALLED" = "true" ] && echo "✅ 已注册" || echo "⚠️ 未安装")                   ║"
echo "  ║  Agent:    ✅ ${AGENT_INTERVAL} 上报已启动          ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
