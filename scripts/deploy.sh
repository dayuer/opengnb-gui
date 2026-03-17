#!/bin/bash
# GNB Console — 部署脚本
# 将 opengnb-gui 部署到远程服务器
#
# 用法:
#   ./scripts/deploy.sh
#
# 前提:
#   - 本地 SSH 可连接 root@43.156.128.95
#   - 服务器已安装 git, node >= 20, npm, nginx

set -euo pipefail

# --- 配置 ---
SERVER="43.156.128.95"
SSH_USER="root"
DOMAIN="api.synonclaw.com"
APP_DIR="/opt/gnb-console"
REPO_URL="$(git -C "$(dirname "$0")/.." remote get-url origin 2>/dev/null || echo 'https://github.com/user/opengnb-gui.git')"
BRANCH="main"
PORT=3000

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║  GNB Console — 部署到 $DOMAIN  ║"
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
npm install --production
mkdir -p data
REMOTE_DEPLOY

# --- 4. 配置 systemd + nginx ---
echo "[4/5] 配置服务..."
ssh "$SSH_USER@$SERVER" << REMOTE_CONFIG
set -e

# systemd 服务
cat > /etc/systemd/system/gnb-console.service << 'EOF'
[Unit]
Description=GNB Console Management Platform
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/src/server.js
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

echo "      gnb-console 服务: \$(systemctl is-active gnb-console)"

# nginx 反向代理 (HTTPS 由 certbot 配置)
cat > /etc/nginx/sites-available/gnb-console << 'NGINX_EOF'
server {
    listen 80;
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
    certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@synonclaw.com || echo "      证书获取失败（请确保 DNS 已指向此服务器）"
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
