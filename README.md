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

## 节点接入

在目标节点以 root 执行：

```bash
curl -sSL https://api.synonclaw.com/api/enroll/init.sh | bash
```

脚本将自动执行 8 步：
1. **安装 GNB**（优先从 Console 镜像下载，GitHub 作为 fallback）
2. **获取 passcode 并注册**（通过 API 获取一次性注册码，提交注册申请）
3. **等待管理员审批**（轮询，管理员在 Web UI 操作，分配 TUN 地址和 GNB 节点 ID）
4. **配置 GNB**（生成 Ed25519 密钥，与 Console 交换公钥，写入配置文件）
5. **启动 GNB**（创建 systemd 服务，`--crypto rc4` 安全模式，等待 TUN 接口就绪）
6. **创建 synon 用户**（审批通过后，sudo 免密）
7. **下载 Console SSH 公钥**（写入 `authorized_keys`）
8. **通知 Console 就绪**（Console 自动 SSH 远程管理此节点）

## 项目结构

```
opengnb-gui/
├── scripts/
│   ├── setup-console.sh           # Console 服务器一键安装
│   ├── initnode.sh                 # 节点初始化脚本
│   ├── deploy.sh                  # 部署脚本
│   └── sync-mirror.sh             # GNB/OpenClaw 镜像同步
├── src/
│   ├── server.js                  # Express 入口
│   ├── services/
│   │   ├── node-store.js          # SQLite 数据层 (nodes/groups/metrics/audit)
│   │   ├── key-manager.js         # 密钥管理 + 审批注册 + 分组
│   │   ├── metrics-store.js       # 指标时序存储 (委托 NodeStore)
│   │   ├── audit-logger.js        # 审计日志 (委托 NodeStore)
│   │   ├── data-paths.js          # 集中路径管理
│   │   ├── ssh-manager.js         # SSH 连接池
│   │   ├── gnb-monitor.js         # 推模式状态采集
│   │   ├── provisioner.js         # 远程安装配置
│   │   └── ai-ops.js              # Claude AI 运维
│   └── routes/
│       ├── nodes.js               # 节点管理 API
│       ├── enroll.js              # 注册审批 API
│       ├── mirror.js              # 软件镜像下载 API
│       └── ai.js                  # AI 运维 API
├── data/
│   ├── registry/nodes.db          # SQLite (nodes, groups, metrics, audit_logs)
│   ├── security/ssh/              # ED25519 密钥对
│   ├── logs/ops/                  # 运维终端日志
│   └── mirror/                    # 软件镜像
└── public/                        # Web Dashboard
    ├── index.html
    ├── css/style.css
    └── js/app.js
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | HTTP 端口 |
| `DATA_DIR` | ./data | 数据目录 |
| `POLL_INTERVAL_MS` | 10000 | 采集间隔 |
| `GNB_INDEX_NODES` | — | Index Node 地址 |

## License

GPL-3.0
