# SynonClaw Console — 节点管理中台

基于 Node.js 的 GNB P2P VPN 节点远程管理平台。通过 GNB 建立底层安全的内网隧道，节点 Agent 主动推送状态到 Console，支持 Claude 智能运维。

## 架构

```
                    ┌─────────────────────────────────────────────┐
                    │        Console Server (Node.js :3000)       │
                    │                                             │
                    │  ┌─────────────┐    ┌──────────────┐        │
                    │  │ KeyManager  │    │  SSHManager   │        │
                    │  │ 密钥+审批   │    │  SSH 连接池   │        │
                    │  └──────┬──────┘    └──────┬───────┘        │
                    │         │                  │                │
                    │  ┌──────┴──────┐    ┌──────┴───────┐        │
                    │  │ GnbMonitor  │    │ Provisioner   │        │
                    │  │ 推模式监控  │    │ 远程部署      │        │
                    │  └─────────────┘    └──────────────┘        │
                    │                                             │
                    │  ┌─────────────┐    ┌──────────────┐        │
                    │  │   AiOps     │    │  JobManager   │        │
                    │  │ Claude 运维 │    │  异步任务     │        │
                    │  └─────────────┘    └──────────────┘        │
                    │                                             │
                    │  ┌─────────────────────────────────┐        │
                    │  │  Web Dashboard (暗色/亮色 + WS)  │        │
                    │  └─────────────────────────────────┘        │
                    └───────────────┬─────────────────────────────┘
                                   │ GNB TUN (10.1.0.0/8)
                    ┌──────────────┬┴──────────────┐
                    │              │               │
               ┌────┴────┐  ┌────┴────┐    ┌────┴────┐
               │ Node A  │  │ Node B  │    │ Node N  │
               │ Agent   │  │ Agent   │    │ Agent   │
               │ 10s 上报│  │ 10s 上报│    │ 10s 上报│
               └─────────┘  └─────────┘    └─────────┘
```

## 功能特性

### 节点管理
- **审批制注册** — passcode 一次性码 + enrollToken 认证 + 管理员审批
- **在线编辑** — 修改节点 name/tunAddr/sshPort/sshUser，支持远程 GNB 同步
- **分组管理** — 创建/编辑/删除分组，颜色标记，CIDR 网段过滤
- **批量操作** — 多选节点批量审批/拒绝/删除/移组
- **分页系统** — 每页 50 条，支持大规模节点管理

### 监控（推模式）
- **Agent 推送** — 节点每 10s 主动上报 GNB/系统/OpenClaw 状态
- **离线检测** — 60s 无上报自动判定离线
- **指标存储** — 时序数据持久化 + 趋势聚合
- **实时仪表盘** — WebSocket 推送 + sparkline 趋势图

### 安全
- **enrollToken** — 注册成功签发，绑定 nodeId，防跨节点访问
- **passcode TTL** — 30 分钟有效期，过期自动失效
- **文件权限** — agent.env / 私钥 chmod 600
- **命令白名单** — SSH 命令安全门控

### AI 运维 (AI Ops Terminal)
- **自然语言运维** — 用中文描述运维意图，Claude Code 自动理解并执行 SSH 命令
- **流式执行** — Console 本地调用 Claude CLI → `stream-json` → WebSocket 实时推送
- **安全门控** — 63 条危险命令黑名单拦截（rm -rf、shutdown、reboot 等）
- **快捷指令** — 一键状态检查、日志查看、性能分析、服务重启
- **Premium UI** — Stitch 设计语言、深色终端头部、实时连接状态脉冲、深色代码块
- **异步命令框架** — SSH 投递 + nohup 后台执行 + HTTP 回调
- **远程部署** — 审批通过后自动推送 OpenClaw
- **主题切换** — 深色 ↔ 亮色模式，`localStorage` 持久化

## 快速开始

```bash
# 开发环境
npm install && npm run dev    # Express + tsx --watch → http://localhost:3000
npm run dev:vite               # 前端 Vite HMR → http://localhost:5173

# 类型检查
npm run typecheck              # tsc --noEmit (strict: true)

# 生产构建
npm run build                  # vite build → dist/
npm start                      # tsx src/server.ts (Express 服务 dist/)

# 生产部署（一键安装）
curl -sSL https://api.synonclaw.com/api/enroll/setup-console.sh | bash
```

## 节点接入

```bash
curl -sSL https://api.synonclaw.com/api/enroll/init.sh | TOKEN=xxx bash
```

> TOKEN 在 Console Web UI →「API Token」弹窗中获取，点击 📋 复制。

### 初始化流程（10 步）

```
TOKEN=xxx bash initnode.sh
  │
  ├─ [1]  安装 GNB         Console 镜像优先，GitHub fallback
  ├─ [2]  注册              TOKEN → passcode → enrollToken
  ├─ [3]  等待审批          管理员在 Web UI 操作
  ├─ [4]  配置 GNB          Ed25519 密钥生成 + 公钥交换
  ├─ [5]  启动 GNB          TUN 接口 + ping 隧道连通验证
  ├─ [6]  创建 synon 用户   sudo 免密
  ├─ [7]  安装 Node.js      v22+
  ├─ [8]  SSH 公钥          Console 公钥 → authorized_keys
  ├─ [9]  Agent 安装        systemd timer 每 10s 上报
  └─ [10] 通知就绪          Console 远程安装 OpenClaw
```

- **TUN 地址段**: `10.1.0.x`（跳过 `10.0.x.x` 避免云厂商内网冲突）
- **审批通过** → 分配 TUN + GNB ID → 脚本继续
- **审批拒绝** → 删除节点 + 同步 address.conf → 脚本退出

## 监控架构

```
  Node                                           Console
  ┌────────────────┐                              ┌──────────────────┐
  │  node-agent.sh │──── POST /api/monitor/report ──→ GnbMonitor     │
  │  每 10s        │     TOKEN + nodeId            │   .ingest()     │
  │                │                               │   → latestState │
  │  采集:         │                               │   → metricsStore│
  │  · gnb_ctl -s  │     60s 无上报 → 判定离线      │   → WebSocket   │
  │  · 系统信息    │                               │   → alerting    │
  │  · OpenClaw    │                               │                 │
  └────────────────┘                              └──────────────────┘
```

## 项目结构

```
opengnb-gui/
├── scripts/
│   ├── initnode.sh                 # 节点初始化（10 步）
│   ├── node-agent.sh               # 节点监控 Agent（推模式）
│   ├── setup-console.sh            # Console 一键部署
│   ├── deploy.sh                   # 增量部署
│   └── sync-mirror.sh              # GNB/OpenClaw 镜像同步
│
├── src/
│   ├── server.ts                   # Express + WebSocket 入口
│   ├── services/
│   │   ├── node-store.ts           # SQLite (nodes/groups/metrics/audit/users)
│   │   ├── key-manager.ts          # 密钥 + 审批 + 分组 + address.conf 同步
│   │   ├── gnb-monitor.ts          # 推模式监控（被动接收 Agent 上报）
│   │   ├── gnb-parser.ts           # GNB 状态解析器
│   │   ├── metrics-store.ts        # 指标时序存储 + 趋势聚合
│   │   ├── ssh-manager.ts          # SSH 连接池（通过 GNB TUN）
│   │   ├── provisioner.ts          # 远程部署 OpenClaw
│   │   ├── job-manager.ts          # 异步任务（投递+回调+超时）
│   │   ├── claw-rpc.ts             # OpenClaw RPC 客户端
│   │   ├── ai-ops.ts               # Claude 智能运维（安全门控）
│   │   ├── audit-logger.ts         # 操作审计日志
│   │   └── data-paths.ts           # 集中路径管理
│   ├── routes/
│   │   ├── enroll.ts               # 注册审批（enrollToken + flexAuth）
│   │   ├── nodes.ts                # 节点管理（编辑 + 远程 TUN 同步）
│   │   ├── auth.ts                 # 登录认证
│   │   ├── jobs.ts                 # 异步 Job（回调 + clawToken 校验）
│   │   ├── claw.ts                 # OpenClaw 管理
│   │   ├── groups.ts               # 节点分组 CRUD
│   │   ├── mirror.ts               # 软件镜像下载
│   │   └── ai.ts                   # AI 运维 API
│   ├── client/                     # 前端 TypeScript (Vite ESM)
│   │   ├── main.ts                 # 入口 + window 全局挂载
│   │   ├── core.ts                 # 核心状态管理 + 路由
│   │   ├── ws.ts                   # WebSocket 客户端
│   │   ├── modal.ts                # 弹窗组件
│   │   ├── utils.ts                # DOM/格式工具函数
│   │   └── pages/
│   │       ├── dashboard.ts        # 仪表盘
│   │       ├── nodes.ts            # 节点管理 + AI Ops Terminal
│   │       ├── users.ts            # 团队管理
│   │       ├── settings.ts         # 系统设置
│   │       ├── groups.ts           # 分组管理
│   │       └── skills.ts           # 技能商店
│   ├── types/
│   │   ├── global.d.ts             # 全局类型声明 ($, $$, L 等)
│   │   └── interfaces.ts           # 核心数据结构接口
│   └── __tests__/                  # 174 个测试用例
│
├── data/
│   ├── registry/nodes.db           # SQLite 主库
│   ├── security/ssh/               # Console ED25519 密钥对
│   ├── logs/ops/                   # 运维终端日志
│   └── mirror/                     # GNB/OpenClaw 二进制镜像
│
├── public/
│   └── index.html                  # SPA 入口 (Tailwind v4 @theme)
│
├── dist/                           # vite build 产物（生产模式）
│
├── tsconfig.json                   # 前端 TS 配置
├── tsconfig.server.json            # 后端 TS 配置 (strict: true)
├── vite.config.ts                  # Vite 构建配置
│
└── team/                           # 团队协作文档
    ├── requirements.md             # 当前需求
    ├── ba-scenarios.md             # 业务场景矩阵
    └── archive/                    # 已归档 Sprint
```

## 认证

统一使用 `TOKEN`。

| 场景 | 说明 |
|------|------|
| 节点初始化 | `curl ... \| TOKEN=xxx bash` |
| Agent 上报 | `TOKEN` + `nodeId` 查询参数 |
| Web 登录 | 用户名密码 → JWT |
| API 访问 | JWT 或 apiToken（10 字符）|
| WS 连接 | JWT / apiToken / ADMIN_TOKEN |

> report 端点接受 apiToken、ADMIN_TOKEN、JWT — 任何有效管理员凭证均可。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | HTTP 端口 |
| `DATA_DIR` | `./data` | 数据目录 |
| `ADMIN_TOKEN` | — | 管理员 token（服务端） |
| `GNB_CONF_DIR` | `/opt/gnb/conf/1001` | Console GNB 配置目录 |
| `GNB_INDEX_NODES` | — | Index Node 公网地址 |
| `PASSCODE_TTL` | 600 | 注册码有效期（秒） |

## API

| 路由 | 认证 | 说明 |
|------|------|------|
| `POST /api/auth/login` | — | 登录，返回 JWT |
| `POST /api/monitor/report` | TOKEN | Agent 状态上报 |
| `GET /api/enroll/init.sh` | — | 下载 initnode 脚本 |
| `POST /api/enroll` | passcode | 节点注册 |
| `GET /api/enroll/status/:id` | enrollToken | 注册状态 |
| `POST /api/enroll/:id/approve` | ADMIN_TOKEN | 审批通过 |
| `GET /api/enroll/pubkey` | — | Console SSH 公钥 |
| `GET /api/nodes` | JWT/apiToken | 节点列表 |
| `PUT /api/nodes/:id` | JWT/apiToken | 编辑节点 + 远程同步 |
| `GET/POST /api/groups` | JWT/apiToken | 分组管理 |
| `POST /api/jobs` | JWT/apiToken | 创建异步任务 |
| `POST /api/jobs/:id/callback` | clawToken | Job 回调 |
| `GET /api/mirror/*` | — | 软件镜像下载 |

## 测试

```bash
npm test    # 174 tests, 100% pass
```

## 版本演进

| 日期 | 里程碑 | 说明 |
|------|--------|------|
| 03-17 | Console 可行性 | GNB 架构调研 + Sidecar 方案评估 |
| 03-18 | 全量测试覆盖 | 77 测试用例，11 个测试文件 |
| 03-19 | 节点编辑 | 在线编辑 + address.conf 联动 |
| 03-19 | 主题切换 | 深色 ↔ 亮色模式 |
| 03-19 | 节点分组管理 | 分组 + CIDR 过滤 + 批量操作 |
| 03-20 | 16M 架构审查 | 7 个瓶颈识别 + 分级路线图 |
| 03-20 | IP 远程同步 | 编辑 TUN 地址 → SSH 远程同步 GNB |
| 03-20 | Enroll 安全加固 | enrollToken + passcode TTL + nodeId 绑定 |
| 03-20 | Agent 推模式 | 节点 Agent 每 10s 推送 → 取代 SSH 轮询 |
| 03-20 | TOKEN 统一 | 认证命名统一为 TOKEN |
| 03-20 | Stitch 设计系统 | 亮色主题 + Indigo Cloud 配色 + Glassmorphism |
| 03-20 | AI Terminal v1 | Claude Code 流式 Chat UI + WebSocket |
| 03-21 | AI Ops Terminal | Stitch 设计对齐 — 深色头部 + premium 气泡 + 零行内 style |
| 03-22 | TypeScript 全迁移 | JS→TS (strict: true) + Vite + 核心接口定义 + tsc 零错误 |

## License

GPL-3.0
