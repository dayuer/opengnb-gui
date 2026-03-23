#!/bin/bash
# SynonClaw Console — 部署脚本
# 将 opengnb-gui 部署到远程服务器
#
# 用法:
#   ./scripts/deploy.sh
#
# 前提:
#   - 本地 SSH 可连接 root@43.156.128.95
#   - 服务器已安装 git, node >= 20, npm, nginx

set -euo pipefail

# --- 配置（从环境变量读取，避免硬编码） ---
SERVER="${DEPLOY_SERVER:?'请设置 DEPLOY_SERVER 环境变量（目标服务器 IP）'}"
SSH_USER="${DEPLOY_SSH_USER:-root}"
DOMAIN="${DEPLOY_DOMAIN:?'请设置 DEPLOY_DOMAIN 环境变量（域名）'}"
APP_DIR="${DEPLOY_APP_DIR:-/opt/gnb-console}"
REPO_URL="$(git -C "$(dirname "$0")/.." remote get-url origin 2>/dev/null || echo 'https://github.com/user/opengnb-gui.git')"
BRANCH="${DEPLOY_BRANCH:-main}"
PORT="${DEPLOY_PORT:-3000}"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║  SynonClaw Console — 部署到 $DOMAIN  ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  Server: $SSH_USER@$SERVER"
echo "  AppDir: $APP_DIR"
echo "  Domain: $DOMAIN"
echo ""

# --- 1. 推送代码 ---
echo "[1/5] 推送代码到远程仓库..."
git -C "$(dirname "$0")/.." push origin "$BRANCH" 2>/dev/null || echo "      (跳过 push，手动推送或首次部署)"

# --- 2. 远程安装 Node.js (如需要) ---
echo "[2/5] 检查远程环境..."
ssh "$SSH_USER@$SERVER" << 'REMOTE_CHECK'
set -e
if ! command -v node &>/dev/null; then
    echo "      安装 Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
echo "      Node.js: $(node --version)"
echo "      npm: $(npm --version)"

# 安装 nginx (如需要)
if ! command -v nginx &>/dev/null; then
    echo "      安装 nginx..."
    apt-get install -y nginx
fi
REMOTE_CHECK

# --- 3. 部署代码 ---
echo "[3/5] 部署代码到 $APP_DIR ..."
ssh "$SSH_USER@$SERVER" << REMOTE_DEPLOY
set -e
if [ -d "$APP_DIR/.git" ]; then
    echo "      拉取最新代码..."
    cd $APP_DIR && git fetch origin $BRANCH && git reset --hard origin/$BRANCH
else
    echo "      克隆仓库..."
    rm -rf $APP_DIR
    git clone --branch $BRANCH --depth 1 $REPO_URL $APP_DIR
fi

cd $APP_DIR
npm install --include=dev  # Install vite to build
npm run build              # Build frontend static files
npm install --omit=dev     # Remove dev dependencies to save space
npm rebuild
mkdir -p data

# 数据库 schema 初始化/迁移（在服务启动前执行）
echo "      初始化数据库 schema..."
DATA_DIR=$APP_DIR/data npx tsx scripts/init-db.ts

# 清理生产环境不需要的文件
rm -rf src/__tests__ doc team
echo "      已清理测试/文档目录"

# 初始化 .env（如不存在则从 .env.example 复制）
if [ ! -f .env ]; then
    cp .env.example .env
    echo "      已创建 .env (请编辑填入实际值)"
fi
REMOTE_DEPLOY

# --- 4. 配置 systemd + nginx ---
echo "[4/5] 配置服务..."
ssh "$SSH_USER@$SERVER" << REMOTE_CONFIG
set -e

# 检测 Node.js 实际路径（兼容 nvm/fnm/系统安装）
NODE_BIN=\$(command -v node)
NODE_DIR=\$(dirname \$NODE_BIN)
echo "      使用 Node: \$NODE_BIN (\$(node -v))"

# systemd 服务
cat > /etc/systemd/system/gnb-console.service << EOF
[Unit]
Description=SynonClaw Console Management Platform
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=\$NODE_BIN $APP_DIR/node_modules/.bin/tsx $APP_DIR/src/server.ts
Restart=always
RestartSec=5
TimeoutStopSec=10
EnvironmentFile=-$APP_DIR/.env
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=DATA_DIR=$APP_DIR/data
Environment=PATH=\$NODE_DIR:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable gnb-console
systemctl restart gnb-console

echo "      gnb-console 服务: \$(systemctl is-active gnb-console)"

# nginx 反向代理 (stream SNI: 443 → 8443 SSL termination)
cat > /etc/nginx/sites-available/gnb-console << 'NGINX_EOF'
# HTTP → HTTPS redirect
server {
    listen 80;
    server_name $DOMAIN;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS: stream SNI routes 443 → 8443
server {
    listen 8443 ssl http2;
    listen [::]:8443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:GNB_SSL:10m;
    ssl_session_timeout 10m;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

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

ln -sf /etc/nginx/sites-available/gnb-console /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

echo "      nginx 配置完成"
REMOTE_CONFIG

# --- 5. 配置 HTTPS + 自动续期 ---
echo "[5/5] 配置 HTTPS + 自动续期..."
ssh "$SSH_USER@$SERVER" << REMOTE_SSL
set -e
if ! command -v certbot &>/dev/null; then
    apt-get install -y certbot python3-certbot-nginx
fi

# 获取证书（如已存在则跳过）
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email "${CERTBOT_EMAIL:?'请设置 CERTBOT_EMAIL 环境变量'}" || echo "      证书获取失败（请确保 DNS 已指向此服务器）"
else
    echo "      证书已存在"
fi

# 自动续期脚本
cat > /opt/ssl-renew.sh << 'RENEW_EOF'
#!/bin/bash
LOG="/var/log/ssl-renew.log"
echo "=== \$(date) ===" >> \$LOG
certbot renew --quiet --deploy-hook "systemctl reload nginx" >> \$LOG 2>&1
echo "退出码: \$?" >> \$LOG
RENEW_EOF
chmod +x /opt/ssl-renew.sh

# 写入 crontab（去重）
(crontab -l 2>/dev/null | grep -v "ssl-renew.sh"; echo "0 3 * * * /opt/ssl-renew.sh") | crontab -
echo "      自动续期 cron 已配置: 每天 03:00"
echo "      续期日志: /var/log/ssl-renew.log"
REMOTE_SSL

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║  ✅ 部署完成                          ║"
echo "  ║  https://$DOMAIN            ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
