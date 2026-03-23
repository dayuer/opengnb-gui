# SynonClaw Console

<p align="center">
  <img src="public/logo-512.png" alt="SynonClaw" width="120">
</p>

<p align="center">
  <strong>P2P VPN 节点管理中台</strong><br>
  基于 GNB 隧道 · Agent 推送监控 · Claude 智能运维
</p>

<p align="center">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-100%25-3178c6?logo=typescript&logoColor=white">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-≥20-339933?logo=nodedotjs&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/License-GPL--3.0-blue">
</p>

---

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
- **技能商店** — 发现/安装 AI 技能和集成插件（OpenClaw、skills.sh、npm）

### 监控（推模式）
- **Agent 推送** — 节点每 10s 主动上报 GNB/系统/OpenClaw 状态
- **离线检测** — 60s 无上报自动判定离线
- **指标存储** — 时序数据持久化 + 趋势聚合
- **实时仪表盘** — WebSocket 推送 + sparkline 趋势图 + 甜甜圈分布图

### 安全
- **enrollToken** — 注册成功签发，绑定 nodeId，防跨节点访问
- **passcode TTL** — 30 分钟有效期，过期自动失效
- **文件权限** — agent.env / 私钥 chmod 600
- **命令白名单** — SSH 命令安全门控
- **WebSocket 认证** — Token 通过首条消息认证（非 URL 参数），防日志泄露

### AI 运维 (AI Ops Terminal)
- **自然语言运维** — 用中文描述运维意图，Claude Code 自动理解并执行 SSH 命令
- **流式执行** — Console 本地调用 Claude CLI → `stream-json` → WebSocket 实时推送
- **安全门控** — 63 条危险命令黑名单拦截（rm -rf、shutdown、reboot 等）
- **快捷指令** — 一键状态检查、日志查看、性能分析、服务重启

### UI / UX
- **Stitch 设计系统** — Indigo Cloud 配色 + Glassmorphism 毛玻璃卡片
- **深色/亮色主题** — 完整 Dark Mode Token 覆盖，`color-scheme` 同步，`localStorage` 持久化
- **URL 路由持久化** — Hash-based routing，刷新恢复页面，浏览器前进/后退
- **可访问性** — Skip-link、`aria-live` Toast、`role="alert"`、语义 `<button>` 元素
- **等宽数字** — `font-variant-numeric: tabular-nums` 指标卡对齐
- **响应式** — 移动端侧边栏折叠，触控优化 `touch-action: manipulation`

## 快速开始

```bash
# 安装依赖
npm install

# 开发环境（后端 + 前端一体）
npm run dev               # Express + tsx --watch → http://localhost:3000

# 前端独立开发（HMR）
npm run dev:vite           # Vite → http://localhost:5173

# 类型检查
npm run typecheck          # tsc --noEmit (strict: true)

# 测试
npm test                   # Node.js 原生 test runner

# 生产构建
npm run build              # vite build → dist/
npm start                  # tsx src/server.ts
```

> 💡 **首日登录凭证**
>
> 默认控制台登录口令设计为管理员起步：
> **Username**: `admin`
> **Password**: `admin123`
>
> 建议在登录 WebUI 后右上角及时进行修改。

## 节点接入

```bash
curl -sSL https://api.synonclaw.com/api/enroll/init.sh | TOKEN=xxx bash
```

> TOKEN 在 Console Web UI →「API Token」弹窗中获取。

### 初始化流程

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
├── index.html                       # SPA 入口 (Tailwind v4 @theme + Dark Mode)
├── public/
│   ├── favicon.ico                  # 品牌图标 (16+32+48)
│   ├── logo-512.png                 # 高清 Logo (512×512, 透明背景)
│   ├── logo-36.png                  # 侧边栏 Logo (36×36)
│   ├── apple-touch-icon.png         # iOS 触控图标 (180×180)
│   └── index.html                   # 生产模式 fallback
│
├── scripts/
│   ├── initnode.sh                  # 节点初始化（10 步）
│   ├── node-agent.sh                # 节点监控 Agent（推模式）
│   ├── init-db.ts                   # 数据库 schema 初始化/迁移脚本
│   ├── setup-console.sh             # Console 一键部署
│   ├── deploy.sh                    # 增量部署（git push + SSH）
│   ├── sync-mirror.sh               # GNB/OpenClaw 镜像同步
│   └── pack-openclaw.sh             # OpenClaw 打包脚本
│
├── src/
│   ├── server.ts                    # Express + WebSocket 入口
│   ├── services/
│   │   ├── node-store.ts            # SQLite 数据层
│   │   ├── key-manager.ts           # 密钥 + 审批 + address.conf 同步
│   │   ├── gnb-monitor.ts           # 推模式监控 + Agent 任务队列
│   │   ├── gnb-parser.ts            # GNB 状态解析器
│   │   ├── metrics-store.ts         # 指标时序存储 + 趋势聚合
│   │   ├── skills-store.ts          # 技能注册表（共享 DB 模式）
│   │   ├── ssh-manager.ts           # SSH 连接池（通过 GNB TUN）
│   │   ├── provisioner.ts           # 远程部署 OpenClaw
│   │   ├── job-manager.ts           # 异步任务（投递+回调+超时）
│   │   ├── claw-rpc.ts              # OpenClaw RPC 客户端
│   │   ├── ai-ops.ts                # Claude 智能运维（安全门控）
│   │   ├── mirror-updater.ts        # 镜像自动更新
│   │   ├── audit-logger.ts          # 操作审计日志
│   │   └── data-paths.ts            # 集中路径管理
│   ├── routes/
│   │   ├── enroll.ts                # 注册审批（enrollToken + flexAuth）
│   │   ├── nodes.ts                 # 节点管理（编辑 + 远程 TUN 同步）
│   │   ├── auth.ts                  # 登录认证
│   │   ├── jobs.ts                  # 异步 Job（回调 + clawToken 校验）
│   │   ├── claw.ts                  # OpenClaw 管理
│   │   ├── groups.ts                # 节点分组 CRUD
│   │   ├── mirror.ts                # 软件镜像下载
│   │   └── ai.ts                    # AI 运维 WebSocket
│   ├── middleware/
│   │   ├── auth.ts                  # JWT + apiToken 认证
│   │   ├── error-handler.ts         # 全局错误处理
│   │   └── rate-limit.ts            # 速率限制
│   ├── client/                      # 前端 TypeScript (Vite ESM)
│   │   ├── main.ts                  # 入口 + window 全局挂载
│   │   ├── core.ts                  # 核心状态管理 + Hash 路由
│   │   ├── ws.ts                    # WebSocket 客户端（消息认证）
│   │   ├── modal.ts                 # 弹窗组件
│   │   ├── utils.ts                 # DOM/格式/Toast 工具函数
│   │   └── pages/
│   │       ├── dashboard.ts         # 仪表盘（指标卡 + 甜甜圈图 + 趋势）
│   │       ├── nodes.ts             # 节点管理 + AI Ops Terminal
│   │       ├── users.ts             # 团队管理
│   │       ├── settings.ts          # 系统设置（Token/密码/监控参数）
│   │       ├── groups.ts            # 分组管理
│   │       └── skills.ts            # 技能商店
│   ├── types/
│   │   ├── global.d.ts              # 全局类型声明
│   │   └── interfaces.ts            # 核心数据结构接口
│   └── __tests__/                   # TypeScript 测试（16 文件）
│
├── data/                            # 运行时数据（自动创建）
│   ├── registry/nodes.db            # SQLite 主库（9 表：nodes/groups/metrics/users/jobs/audit_logs/skills/agent_tasks）
│   ├── security/ssh/                # Console ED25519 密钥对
│   ├── logs/ops/                    # 运维终端日志
│   └── mirror/                      # GNB/OpenClaw 二进制镜像
│
├── DESIGN.md                        # 设计系统文档
├── AGENTS.md                        # 架构文档
├── package.json
├── tsconfig.json                    # 前端 TS 配置
├── tsconfig.server.json             # 后端 TS 配置 (strict: true)
└── vite.config.ts                   # Vite 构建配置
```

## 认证

| 场景 | 方式 |
|------|------|
| 节点初始化 | `curl ... \| TOKEN=xxx bash` |
| Agent 上报 | `TOKEN` + `nodeId` 查询参数 |
| Web 登录 | 用户名密码 → JWT |
| API 访问 | JWT 或 apiToken（10 字符）|
| WebSocket | 首条消息认证（JWT / apiToken / ADMIN_TOKEN）|

## 环境变量

```bash
cp .env.example .env
```

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | 3000 | HTTP 端口 |
| `DATA_DIR` | `./data` | 数据根目录 |
| `ADMIN_TOKEN` | (自动生成) | 管理员 Token |
| `GNB_NODE_ID` | 1001 | Console GNB 节点 ID |
| `GNB_CONF_DIR` | `/opt/gnb/conf/1001` | GNB 配置目录 |
| `GNB_TUN_ADDR` | `10.1.0.1` | Console TUN 地址 |
| `GNB_INDEX_NODES` | — | Index Node 公网地址 |
| `POLL_INTERVAL_MS` | 10000 | Agent 轮询间隔（ms）|
| `STALE_TIMEOUT_MS` | 60000 | 离线判定超时（ms）|

部署相关环境变量见 `.env.example`。

## API

| 路由 | 认证 | 说明 |
|------|------|------|
| `POST /api/auth/login` | — | 登录，返回 JWT |
| `POST /api/auth/change-password` | JWT | 修改密码 |
| `POST /api/monitor/report` | TOKEN | Agent 状态上报 |
| `GET /api/enroll/init.sh` | — | 下载 initnode 脚本 |
| `POST /api/enroll` | passcode | 节点注册 |
| `GET /api/enroll/status/:id` | enrollToken | 注册状态查询 |
| `POST /api/enroll/:id/approve` | JWT | 审批通过 |
| `GET /api/enroll/pubkey` | — | Console SSH 公钥 |
| `GET /api/nodes` | JWT/apiToken | 节点列表 |
| `PUT /api/nodes/:id` | JWT/apiToken | 编辑节点 |
| `GET/POST /api/groups` | JWT/apiToken | 分组管理 |
| `POST /api/jobs` | JWT/apiToken | 创建异步任务 |
| `POST /api/jobs/:id/callback` | clawToken | Job 回调 |
| `GET /api/mirror/*` | — | 软件镜像下载 |

## 部署

```bash
# 一键部署到远程服务器
DEPLOY_SERVER=<IP>  DEPLOY_DOMAIN=<域名>  bash scripts/deploy.sh
```

部署脚本执行 5 步：推送代码 → 检查环境 → 安装依赖 + `init-db.ts` 迁移 → 配置 systemd + nginx → HTTPS 证书。

## 版本演进

| 日期 | 里程碑 | 说明 |
|------|--------|------|
| 03-23 | **数据库合并 + 任务持久化** | skills.db 合入 nodes.db、agent_tasks SQLite 持久化、init-db.ts 迁移脚本、优雅关闭修复 |
| 03-22 | **v1.1.0-alpha: 技能中心落地** | 新增独立 `技能商店` 路由，接入真实底层的 `.online` 布尔精准探测，打通选节点 Modal 自动下发并重构了部署侧的 Vite 全链路。 |
| 03-17 | Console 可行性 | GNB 架构调研 + Sidecar 方案评估 |
| 03-18 | 全量测试覆盖 | 测试用例覆盖所有 services/routes/middleware |
| 03-19 | 节点编辑 + 分组 | 在线编辑 + address.conf 联动 + CIDR 过滤 |
| 03-20 | Agent 推模式 | 节点 Agent 每 10s 推送 → 取代 SSH 轮询 |
| 03-20 | Enroll 安全加固 | enrollToken + passcode TTL + nodeId 绑定 |
| 03-20 | Stitch 设计系统 | 亮色主题 + Indigo Cloud 配色 + Glassmorphism |
| 03-21 | AI Ops Terminal | Claude Code 流式 Chat UI + WebSocket + 安全门控 |
| 03-21 | 可访问性修复 | aria-live、语义元素、focus-visible、prefers-reduced-motion |
| 03-22 | TypeScript 全迁移 | JS → TS (strict: true) + Vite + tsc 零错误 |
| 03-22 | UI 全面审查修复 | 设计系统统一、Dark Mode、URL 路由、XSS 修复 |
| 03-22 | 品牌 Logo | S-wave 渐变 Logo + favicon.ico + apple-touch-icon |

## License

GPL-3.0
