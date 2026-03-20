# SynonClaw Console — 节点管理中台

基于 Node.js 的 GNB P2P VPN 节点远程管理平台。通过 GNB 建立底层安全的内网隧道，节点 Agent 主动推送状态到 Console，由 Claude 作为"智能运维工程师"进行远程配置。

## 架构

```
Console Server (Node.js @ :3000)
  │
  ├── KeyManager: ED25519 密钥对 + 审批制注册 + ownerId 多租户隔离
  ├── SSHManager: SSH 连接池 (通过 GNB TUN 内网)
  ├── GnbMonitor: 推模式 — 被动接收节点 Agent 上报，60s 无上报判定离线
  ├── NodeAgent:  节点端 Agent (systemd timer 每 10s 推送 GNB/系统/OpenClaw 状态)
  ├── Provisioner: 审批后自动安装 OpenClaw（远程推送，不在 initnode 中安装）
  ├── AiOps: Claude 智能运维 (安全门控)
  └── Web Dashboard: 暗色主题 + WebSocket 实时 + 待审批 badge 可点击
```

## 快速开始

```bash
npm install
npm run dev
# 访问 http://localhost:3000
```

## 节点接入

在目标节点以 root 执行：

```bash
# 方式 1: ADMIN_TOKEN 自动获取 passcode（推荐）
curl -sSL https://api.synonclaw.com/api/enroll/init.sh | ADMIN_TOKEN=xxx bash

# 方式 2: 手动传入 passcode
curl -sSL https://api.synonclaw.com/api/enroll/init.sh | PASSCODE=xxx bash
```

### 初始化流程（10 步）

| 步骤 | 内容 | 说明 |
|------|------|------|
| 1 | 安装 GNB | 优先 Console 镜像，GitHub fallback |
| 2 | 注册 | 获取 passcode → 提交注册 → 返回 enrollToken |
| 3 | 等待审批 | 轮询（enrollToken + ADMIN_TOKEN 双认证） |
| 4 | 配置 GNB | Ed25519 密钥生成 + 公钥交换 + systemd |
| 5 | 启动 GNB | TUN 接口 + **隧道连通验证**（ping Console TUN） |
| 6 | 创建用户 | `synon` 用户 + sudo 免密 |
| 7 | 安装 Node.js | v22+（OpenClaw 由 Console 远程推送安装） |
| 8 | SSH 公钥 | 下载 Console 公钥 → `authorized_keys` |
| 9 | Agent 安装 | 监控 Agent（ADMIN_TOKEN 认证，每 10s 上报） |
| 10 | 通知就绪 | Console 触发 OpenClaw 远程安装 |

> **TUN 地址段**: 从 `10.1.0.2` 开始分配，跳过 `10.0.x.x` 避免与云厂商内网冲突。

### 节点审批

- **同意** → 自动分配 TUN 地址 + GNB 节点 ID → 脚本继续
- **拒绝** → 直接删除节点记录 + 同步 `address.conf` → 脚本退出

## 监控架构（推模式）

```
Node                          Console
┌──────────┐   POST /api/monitor/report   ┌──────────────┐
│ Agent.sh │ ──────────────────────────→   │ GnbMonitor   │
│ (10s)    │   ADMIN_TOKEN + nodeId       │  .ingest()   │
└──────────┘                              │  → latestState│
                                          │  → metricsStore│
                                          └──────────────┘
```

Agent 采集 3 类数据：GNB 状态（`gnb_ctl -s/-a`）、系统信息、OpenClaw 状态。

## 项目结构

```
opengnb-gui/
├── scripts/
│   ├── setup-console.sh           # Console 一键安装
│   ├── initnode.sh                # 节点初始化（10 步）
│   ├── node-agent.sh              # 节点监控 Agent（推模式）
│   ├── deploy.sh                  # 部署脚本
│   └── sync-mirror.sh             # 镜像同步
├── src/
│   ├── server.js                  # Express + WebSocket 入口
│   ├── services/
│   │   ├── node-store.js          # SQLite (nodes/groups/metrics/audit/users)
│   │   ├── key-manager.js         # 密钥管理 + 审批 + 分组 + ownerId 隔离
│   │   ├── gnb-monitor.js         # 推模式监控（被动接收上报）
│   │   ├── metrics-store.js       # 指标时序存储
│   │   ├── audit-logger.js        # 审计日志
│   │   ├── ssh-manager.js         # SSH 连接池
│   │   ├── provisioner.js         # 远程安装 OpenClaw
│   │   ├── data-paths.js          # 路径管理
│   │   └── ai-ops.js              # Claude AI 运维
│   └── routes/
│       ├── enroll.js              # 注册审批 API（flexAuth 双认证）
│       ├── nodes.js               # 节点管理 API
│       ├── mirror.js              # 镜像下载 API
│       └── ai.js                  # AI 运维 API
├── data/
│   ├── registry/nodes.db          # SQLite 主库
│   ├── security/ssh/              # Console ED25519 密钥对
│   ├── logs/ops/                  # 运维日志
│   └── mirror/                    # 软件镜像
└── public/                        # Web Dashboard
    ├── index.html
    ├── css/style.css
    └── js/app.js
```

## 认证机制

| 场景 | Token 类型 | 说明 |
|------|-----------|------|
| 管理员登录 | JWT | `/api/auth/login` 签发 |
| API 短 Token | apiToken (10 字符) | 管理员操作替代 JWT |
| 节点注册 | passcode (一次性) | TTL 有效期内单次使用 |
| 注册后操作 | enrollToken | 绑定 nodeId，服务器重启后失效 |
| Agent 上报 | ADMIN_TOKEN + nodeId | 持久稳定，不受重启影响 |
| WS 连接 | JWT / apiToken / ADMIN_TOKEN | 多策略认证 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | HTTP 端口 |
| `DATA_DIR` | ./data | 数据目录 |
| `ADMIN_TOKEN` | — | 管理员 token（必填） |
| `GNB_INDEX_NODES` | — | Index Node 地址 |
| `GNB_CONF_DIR` | /opt/gnb/conf/1001 | GNB 配置目录 |

## License

GPL-3.0
