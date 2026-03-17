#!/bin/bash
# GNB Console — 一键安装脚本 (多 OS 适配)
#
# 支持: Debian/Ubuntu, CentOS/RHEL/Rocky/Alma, Fedora, Alpine, openSUSE, Arch, macOS
#
# 用法:
#   curl -sSL https://api.synonclaw.com/api/enroll/setup.sh | \
#     DOMAIN=api.synonclaw.com EMAIL=admin@synonclaw.com bash

set -euo pipefail

DOMAIN="${DOMAIN:-api.synonclaw.com}"
EMAIL="${EMAIL:-admin@synonclaw.com}"
REPO_URL="${REPO_URL:-https://github.com/dayuer/opengnb-gui.git}"
IS_MAC=false
if [ "$(uname)" = "Darwin" ]; then IS_MAC=true; fi
APP_DIR="${APP_DIR:-$($IS_MAC && echo "$HOME/gnb-console" || echo "/opt/gnb-console")}"
PORT="${PORT:-3000}"
NODE_VER="${NODE_VER:-20}"

# ============================================
# OS 检测
# ============================================
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_ID="${ID:-unknown}"
        OS_LIKE="${ID_LIKE:-$OS_ID}"
        OS_VER="${VERSION_ID:-0}"
        OS_NAME="${PRETTY_NAME:-$OS_ID}"
    elif [ -f /etc/redhat-release ]; then
        OS_ID="centos"
        OS_LIKE="rhel"
        OS_NAME=$(cat /etc/redhat-release)
    elif [ -f /etc/alpine-release ]; then
        OS_ID="alpine"
        OS_LIKE="alpine"
        OS_NAME="Alpine $(cat /etc/alpine-release)"
    elif [ "$(uname)" = "Darwin" ]; then
        OS_ID="darwin"
        OS_LIKE="darwin"
        OS_NAME="macOS $(sw_vers -productVersion 2>/dev/null || echo '')"
    else
        OS_ID="unknown"
        OS_LIKE="unknown"
        OS_NAME="Unknown"
    fi

    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  ARCH_ALT="amd64" ;;
        aarch64) ARCH_ALT="arm64" ;;
        armv7l)  ARCH_ALT="armv7" ;;
        arm64)   ARCH_ALT="arm64" ;;
        *)       ARCH_ALT="$ARCH" ;;
    esac
}

# ============================================
# 包管理器抽象层
# ============================================
pkg_update() {
    case "$OS_ID" in
        debian|ubuntu|linuxmint|pop)
            apt-get update -qq ;;
        centos|rhel|rocky|almalinux|ol)
            yum makecache -q 2>/dev/null || true ;;
        fedora)
            dnf makecache -q 2>/dev/null || true ;;
        alpine)
            apk update -q ;;
        opensuse*|sles)
            zypper refresh -q ;;
        arch|manjaro)
            pacman -Sy --noconfirm >/dev/null ;;
        darwin)
            brew update -q 2>/dev/null || true ;;
        *)
            echo "⚠️ 未知包管理器，请手动安装依赖" ;;
    esac
}

pkg_install() {
    case "$OS_ID" in
        debian|ubuntu|linuxmint|pop)
            DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
        centos|rhel|rocky|almalinux|ol)
            yum install -y -q "$@" ;;
        fedora)
            dnf install -y -q "$@" ;;
        alpine)
            apk add -q "$@" ;;
        opensuse*|sles)
            zypper install -y -n "$@" ;;
        arch|manjaro)
            pacman -S --noconfirm --needed "$@" >/dev/null ;;
        darwin)
            brew install -q "$@" 2>/dev/null || true ;;
    esac
}

# 各 OS 的依赖包名映射
install_base_deps() {
    case "$OS_ID" in
        debian|ubuntu|linuxmint|pop)
            pkg_install curl git build-essential ;;
        centos|rhel|rocky|almalinux|ol)
            pkg_install curl git gcc make ;;
        fedora)
            pkg_install curl git gcc make ;;
        alpine)
            pkg_install curl git build-base bash ;;
        opensuse*|sles)
            pkg_install curl git gcc make ;;
        arch|manjaro)
            pkg_install curl git base-devel ;;
        darwin)
            # Xcode CLI Tools 提供编译工具
            xcode-select --install 2>/dev/null || true
            pkg_install git ;;
    esac
}

install_nginx() {
    case "$OS_ID" in
        debian|ubuntu|linuxmint|pop)
            pkg_install nginx certbot python3-certbot-nginx ;;
        centos|rhel|rocky|almalinux|ol)
            pkg_install epel-release 2>/dev/null || true
            pkg_install nginx certbot python3-certbot-nginx ;;
        fedora)
            pkg_install nginx certbot python3-certbot-nginx ;;
        alpine)
            pkg_install nginx certbot certbot-nginx ;;
        opensuse*|sles)
            pkg_install nginx certbot python3-certbot-nginx ;;
        arch|manjaro)
            pkg_install nginx certbot certbot-nginx ;;
        darwin)
            pkg_install nginx
            echo "      macOS: 建议用 mkcert 生成本地证书或手动配置" ;;
    esac
}

install_nodejs() {
    if command -v node &>/dev/null; then
        echo "      Node.js 已安装: $(node --version)"
        return
    fi

    case "$OS_ID" in
        debian|ubuntu|linuxmint|pop)
            curl -fsSL "https://deb.nodesource.com/setup_${NODE_VER}.x" | bash -
            pkg_install nodejs ;;
        centos|rhel|rocky|almalinux|ol|fedora)
            curl -fsSL "https://rpm.nodesource.com/setup_${NODE_VER}.x" | bash -
            pkg_install nodejs ;;
        alpine)
            pkg_install "nodejs~${NODE_VER}" npm ;;
        opensuse*|sles)
            pkg_install nodejs${NODE_VER} npm${NODE_VER} ;;
        arch|manjaro)
            pkg_install nodejs npm ;;
        darwin)
            pkg_install node@${NODE_VER}
            brew link --overwrite node@${NODE_VER} 2>/dev/null || true ;;
        *)
            echo "⚠️ 请手动安装 Node.js >= ${NODE_VER}"
            exit 1 ;;
    esac
    echo "      Node.js $(node --version) 安装完成"
}

# nginx 配置目录检测
get_nginx_conf_dir() {
    if [ "$OS_ID" = "darwin" ]; then
        NGINX_PREFIX=$(brew --prefix nginx 2>/dev/null || echo "/opt/homebrew/etc/nginx")
        NGINX_CONF="${NGINX_PREFIX}/servers/gnb-console.conf"
        NGINX_LINK=""
        mkdir -p "${NGINX_PREFIX}/servers"
    elif [ -d /etc/nginx/sites-available ]; then
        NGINX_CONF="/etc/nginx/sites-available/gnb-console"
        NGINX_LINK="/etc/nginx/sites-enabled/gnb-console"
    else
        NGINX_CONF="/etc/nginx/conf.d/gnb-console.conf"
        NGINX_LINK=""
    fi
}

# systemd / OpenRC 服务管理
setup_service() {
    if command -v systemctl &>/dev/null; then
        cat > /etc/systemd/system/gnb-console.service << EOF
[Unit]
Description=GNB Console Management Platform
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=$(which node) $APP_DIR/src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=DATA_DIR=$APP_DIR/data

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable gnb-console
        systemctl restart gnb-console
        echo "      服务状态: $(systemctl is-active gnb-console)"

    elif command -v rc-update &>/dev/null; then
        # Alpine OpenRC
        cat > /etc/init.d/gnb-console << 'INITEOF'
#!/sbin/openrc-run
name="gnb-console"
description="GNB Console Management Platform"
command="/usr/bin/node"
command_args="APP_DIR_PLACEHOLDER/src/server.js"
command_background=true
pidfile="/run/${RC_SVCNAME}.pid"
directory="APP_DIR_PLACEHOLDER"
export NODE_ENV=production
export PORT=PORT_PLACEHOLDER
export DATA_DIR=APP_DIR_PLACEHOLDER/data
INITEOF
        sed -i "s|APP_DIR_PLACEHOLDER|$APP_DIR|g; s|PORT_PLACEHOLDER|$PORT|g" /etc/init.d/gnb-console
        chmod +x /etc/init.d/gnb-console
        rc-update add gnb-console default
        rc-service gnb-console restart
        echo "      服务已启动 (OpenRC)"
    elif [ "$OS_ID" = "darwin" ]; then
        # macOS launchd
        PLIST="$HOME/Library/LaunchAgents/com.synonclaw.gnb-console.plist"
        mkdir -p "$HOME/Library/LaunchAgents"
        cat > "$PLIST" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.synonclaw.gnb-console</string>
    <key>ProgramArguments</key><array>
        <string>$(which node)</string>
        <string>$APP_DIR/src/server.js</string>
    </array>
    <key>WorkingDirectory</key><string>$APP_DIR</string>
    <key>EnvironmentVariables</key><dict>
        <key>NODE_ENV</key><string>production</string>
        <key>PORT</key><string>$PORT</string>
        <key>DATA_DIR</key><string>$APP_DIR/data</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$APP_DIR/data/console.log</string>
    <key>StandardErrorPath</key><string>$APP_DIR/data/console.err</string>
</dict>
</plist>
PLISTEOF
        launchctl unload "$PLIST" 2>/dev/null || true
        launchctl load "$PLIST"
        echo "      服务已启动 (launchd)"
    else
        echo "      ⚠️ 未检测到 systemd/OpenRC/launchd，请手动配置服务"
    fi
}

# ============================================
# 主流程
# ============================================
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║  GNB Console — 一键安装 v0.2.0           ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

detect_os

echo "  系统:   $OS_NAME ($ARCH)"
echo "  域名:   $DOMAIN"
echo "  目录:   $APP_DIR"
echo ""

# [1/7] 系统依赖
echo "[1/7] 安装系统依赖..."
pkg_update
install_base_deps

# [2/7] Node.js
echo "[2/7] 安装 Node.js..."
install_nodejs

# [3/7] 部署代码
echo "[3/7] 部署代码到 $APP_DIR ..."
if [ -d "$APP_DIR/.git" ]; then
    cd "$APP_DIR" && git pull origin main
else
    rm -rf "$APP_DIR"
    git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
npm install --omit=dev
mkdir -p data/mirror/gnb data/mirror/openclaw

# [4/7] 服务
echo "[4/7] 配置系统服务..."
setup_service

# [5/7] nginx
echo "[5/7] 配置 nginx..."
install_nginx
get_nginx_conf_dir

# 检测 stream SNI
LISTEN_PORT="443 ssl"
if [ "$OS_ID" != "darwin" ] && grep -rq "ssl_preread" /etc/nginx/ 2>/dev/null; then
    LISTEN_PORT="8443 ssl"
    echo "      检测到 stream SNI 路由，使用 8443 端口"
    STREAM_CONF=$(grep -rl "ssl_preread" /etc/nginx/ 2>/dev/null | head -1)
    if [ -n "$STREAM_CONF" ] && ! grep -q "$DOMAIN" "$STREAM_CONF"; then
        sed -i "/default/i\\        $DOMAIN  127.0.0.1:8443;" "$STREAM_CONF"
        echo "      已添加 SNI 映射"
    fi
fi

cat > "$NGINX_CONF" << NGINX_EOF
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen $LISTEN_PORT;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
NGINX_EOF

# sites-enabled 软链接（Debian 系）
if [ -n "${NGINX_LINK:-}" ]; then
    ln -sf "$NGINX_CONF" "$NGINX_LINK"
fi

nginx -t && (systemctl reload nginx 2>/dev/null || rc-service nginx reload 2>/dev/null || brew services restart nginx 2>/dev/null || nginx -s reload)
echo "      nginx 配置完成"

# [6/7] SSL
echo "[6/7] 配置 HTTPS..."
if [ "$OS_ID" = "darwin" ]; then
    echo "      macOS: 建议使用 mkcert 生成本地开发证书"
    echo "      brew install mkcert && mkcert -install && mkcert $DOMAIN"
elif [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL" \
        || echo "      ⚠️ 证书获取失败（检查 DNS）"
else
    echo "      证书已存在"
fi

# 自动续期
if command -v crontab &>/dev/null; then
    (crontab -l 2>/dev/null | grep -v "ssl-renew\|certbot renew"; echo "0 3 * * * certbot renew --quiet --deploy-hook 'nginx -s reload'") | crontab -
    echo "      自动续期已配置"
fi

# [7/7] 镜像同步
echo "[7/7] 同步软件镜像..."
chmod +x "$APP_DIR/scripts/sync-mirror.sh"
bash "$APP_DIR/scripts/sync-mirror.sh" 2>&1 || echo "      镜像同步可稍后重试"

if command -v crontab &>/dev/null; then
    (crontab -l 2>/dev/null | grep -v "sync-mirror"; echo "0 5 * * * $APP_DIR/scripts/sync-mirror.sh >> /var/log/mirror-sync.log 2>&1") | crontab -
fi

# 完成
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║  ✅ GNB Console 安装完成                  ║"
echo "  ╠══════════════════════════════════════════╣"
echo "  ║  Dashboard: https://$DOMAIN              ║"
echo "  ║  Health:    https://$DOMAIN/api/health   ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""
