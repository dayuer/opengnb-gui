# GNB Console — 节点管理中台

基于 Node.js 的 GNB P2P VPN 节点远程管理平台。通过 GNB 建立底层安全的内网隧道，再通过 SSH 远程执行 `gnb_ctl` 采集状态，由 Claude 作为"智能运维工程师"进行远程配置。

## 架构

```
Console Server (Node.js @ :3000)
  │
  ├── KeyManager: ED25519 密钥对自动生成 + 审批制注册
  ├── SSHManager: SSH 连接池 (通过 GNB TUN 内网)
  ├── GnbMonitor: 10s 定时采集 gnb_ctl 状态
  ├── Provisioner: 审批后自动安装 GNB + OpenClaw
  ├── AiOps: Claude 智能运维 (安全门控)
  └── Web Dashboard: 暗色主题 + WebSocket 实时
```

## 快速开始

```bash
npm install
npm run dev
# 访问 http://localhost:3000
```

## Console 服务器安装

在服务器上以 root 执行：

```bash
curl -sSL https://api.synonclaw.com/api/enroll/setup.sh | bash
```

## 节点接入

在目标节点以 root 执行：

```bash
curl -sSL https://api.synonclaw.com/api/enroll/init.sh | bash
```

脚本将自动执行 6 步：
1. **安装 GNB**（优先从 Console 镜像下载，GitHub 作为 fallback）
2. **获取 passcode 并注册**（通过 API 获取一次性注册码，提交注册申请）
3. **等待管理员审批**（轮询，管理员在 Web UI 操作）
4. **创建 synon 用户**（审批通过后，sudo 免密）
5. **下载 Console SSH 公钥**（写入 `authorized_keys`）
6. **通知 Console 就绪**（Console 自动 SSH 远程安装 OpenClaw）

## 项目结构

```
opengnb-gui/
├── config/nodes.json              # 节点配置模板
├── scripts/
│   ├── setup-console.sh           # Console 服务器一键安装
│   ├── init-node.sh               # 节点初始化脚本
│   ├── deploy.sh                  # 部署脚本
│   └── sync-mirror.sh             # GNB/OpenClaw 镜像同步
├── src/
│   ├── server.js                  # Express 入口
│   ├── services/
│   │   ├── ssh-manager.js         # SSH 连接池
│   │   ├── gnb-parser.js          # gnb_ctl 输出解析
│   │   ├── gnb-monitor.js         # 定时状态采集
│   │   ├── key-manager.js         # 密钥管理 + 审批注册 + 备份
│   │   ├── provisioner.js         # 远程安装配置
│   │   └── ai-ops.js              # Claude AI 运维
│   └── routes/
│       ├── nodes.js               # 节点管理 API
│       ├── enroll.js              # 注册审批 API
│       ├── mirror.js              # 软件镜像下载 API
│       └── ai.js                  # AI 运维 API
└── public/                        # Web Dashboard
    ├── index.html
    ├── css/style.css
    └── js/app.js
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/nodes` | 全部节点状态 |
| GET | `/api/nodes/:id` | 单节点详情 |
| POST | `/api/nodes/:id/exec` | 执行安全命令 |
| GET | `/api/enroll/init.sh` | 下载节点初始化脚本 |
| GET | `/api/enroll/setup.sh` | 下载 Console 安装脚本 |
| GET | `/api/enroll/pubkey` | 获取 Console SSH 公钥 |
| GET | `/api/enroll/passcode` | 获取一次性注册码 |
| POST | `/api/enroll` | 提交注册申请（需 passcode） |
| GET | `/api/enroll/status/:id` | 查询审批状态 |
| POST | `/api/enroll/:id/ready` | 节点通知就绪 |
| GET | `/api/enroll/pending` | 待审批列表 |
| POST | `/api/enroll/:id/approve` | 审批通过 |
| POST | `/api/enroll/:id/reject` | 审批拒绝 |
| GET | `/api/mirror/gnb` | GNB 镜像文件列表 |
| GET | `/api/mirror/gnb/:file` | 下载 GNB 文件 |
| GET | `/api/mirror/openclaw` | OpenClaw 镜像文件列表 |
| GET | `/api/mirror/openclaw/:file` | 下载 OpenClaw 文件 |
| POST | `/api/provision/:id` | 触发配置下发 |
| POST | `/api/ai/chat` | AI 运维对话 |
| POST | `/api/ai/confirm` | 确认执行 AI 建议命令 |
| WS | `/ws` | WebSocket 实时状态推送 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | HTTP 端口 |
| `DATA_DIR` | ./data | 数据目录 |
| `POLL_INTERVAL_MS` | 10000 | 采集间隔 |
| `GNB_INDEX_NODES` | — | Index Node 地址 |

## License

GPL-3.0
