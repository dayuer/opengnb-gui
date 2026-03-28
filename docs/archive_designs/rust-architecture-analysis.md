# 架构思考：网络关联稳定性与 `synon-daemon` 控制面服务

> 议题："为了网络的稳定性，除了 GNB，还有没有必要用 Rust 写一套服务，来解决 index，relay，node 各种服务器之间的稳定关联，而不是靠脚本的推送"

**结论：非常有必要。这是从"极客脚本工具"向"企业级 SD-WAN 平台"跨越的关键一步。**

---

## 一、 当前架构痛点（脚本推送的脆弱性）

分析 `scripts/initnode.sh` 和 `services/provisioner.ts`：

1. **首次初始化的静态快照**：节点加入时只调用一次 `/api/enroll/address-conf` 拿全网列表。GNB 启动后成为孤岛，Index IP 变更无感知。
2. **Index/Relay 变更无法自动收敛**：唯一手段是 Console 通过 SSH 逐节点推配置重启，有且只有网络可达时才能执行。
3. **SSH 强依赖造成的死锁 (Split-brain)**：GNB 隧道断了 → SSH 断了 → 推不进去 → GNB 无法修复。
4. **边缘环境极度浪费**：为跑一个 Agent 脚本，强制安装 Node.js v22（>100MB RAM）。`node-agent.sh` 依赖 awk/curl/systemd，在 Alpine/BusyBox/OpenWRT 下频繁失败。

---

## 二、 职责划分（三平面架构）

```
┌──────────────────────────────────────────────────────┐
│       SynonClaw Console (Management Plane)            │
│    Node.js 现有实现，不变                              │
└────────────────────┬─────────────────────────────────┘
                     │ WSS 长连接（HTTPS 外网，不经 GNB）↑ 改动点
         ┌───────────┼────────────┐
         │           │            │
  ┌──────▼──┐  ┌─────▼───┐  ┌───▼─────┐
  │  Index  │  │  Relay  │  │  Node   │  ← 每台服务器
  ├─────────┤  ├─────────┤  ├─────────┤
  │ synon-  │  │ synon-  │  │ synon-  │  ← Rust 守护进程 (2MB无依赖)
  │ daemon  │  │ daemon  │  │ daemon  │
  ├─────────┤  ├─────────┤  ├─────────┤
  │   GNB   │  │   GNB   │  │OpenClaw │  ← 数据面/能力面 (不变)
  │ (数据面) │  │ (数据面) │  │  +GNB   │
  └─────────┘  └─────────┘  └─────────┘
```

- **GNB** → 数据面，高性能加密转发，synon-daemon 管理其进程生命周期
- **synon-daemon (Rust)** → 控制面，向 Console 注册/心跳/双向事件，本地管理 GNB + OpenClaw
- **Console** → 管理面，呈现 UI、下发策略、告警

---

## 三、 OpenClaw 本地控制 — 调研结论 ✅ 完全可行

### 现状问题（`claw-rpc.ts` 的两跳方案）

```
Console → SSH 到节点 → curl http://127.0.0.1:18789 → OpenClaw
```

- 依赖 SSH 存活（GNB 断了就控制不了）
- 每次 RPC 建立 SSH 连接，延迟 ~200ms/次

### synon-daemon 方案（本地直调，零延迟）

```
Console ──(외网 WSS)──→ synon-daemon ──(本地进程通信 <1ms)──→ OpenClaw Gateway
                             │ 127.0.0.1:18789
```

### OpenClaw 提供三种控制接口

| 接口 | 路径 | synon-daemon 调用方式 |
|---|---|---|
| **HTTP REST** | `GET /v1/models`、`POST /v1/chat/completions`、`POST /tools/invoke` | `reqwest::get/post` |
| **WebSocket RPC** | `ws://127.0.0.1:18789`，第一帧发 `connect{ auth.token }` | `tokio-tungstenite` |
| **CLI 子进程** | `openclaw gateway status/restart/stop/install` | `std::process::Command` |

### 关键 RPC 方法（WS 协议）

```
req("status")               → Runtime: running, RPC probe: ok
req("channels.status")      → 渠道连通性
req("config.get")           → 读当前配置
req("config.patch", {...})  → 热更配置（无需重启）
req("sessions.list")        → 当前会话列表
event: health / tick / heartbeat → 实时推送 OpenClaw 健康事件
```

### Token 获取（Zero-effort）

```rust
// synon-daemon 同机进程直读文件，无需 Console 传递
let cfg: Value = serde_json::from_str(
    &fs::read_to_string("/root/.openclaw/openclaw.json")?
)?;
let token = cfg["gateway"]["auth"]["token"].as_str()?;
```

### 可行性矩阵

| 操作 | 当前（SSH代理） | synon-daemon | 可行？ |
|---|---|---|---|
| 查询 OpenClaw 状态 | SSH→curl | `GET /v1/models` 本地直调 | ✅ |
| 重启 Gateway | SSH→systemctl | `openclaw gateway restart` (子进程) | ✅ |
| 修改配置 (patch) | SSH→vim + restart | WS `req("config.patch")` 热更 | ✅ **更强** |
| 订阅实时健康事件 | 不支持 | WS `health`/`tick` 事件 | ✅ **新增能力** |
| AI 推理代理 | TUN HTTP (依赖 GNB) | `POST /v1/chat/completions` 本地 | ✅ **完全解耦** |
| 密钥/渠道热重载 | SSH→CLI | `openclaw secrets reload` 子进程 | ✅ |

---

## 四、 核心收益对比

| 维度 | 当前（脚本） | synon-daemon |
|---|---|---|
| Index IP 变更收敛 | 手工 SSH，分钟~小时级 | Console 推送 `RouteUpdateEvent`，**秒级自动** |
| GNB 崩溃检测 | systemd Restart 被动 | Watchdog 主动重启 + 告警上报 |
| OpenClaw 控制延迟 | ~200ms (SSH建连) | **<1ms (本地 HTTP/WS)** |
| 边缘最低资源要求 | Node.js v22 + curl + awk | **仅 gnb + synon-daemon 二进制** |
| Split-brain 自愈 | 无法自愈 | **带外 WSS 通道独立于 GNB 隧道** |
| 平台兼容 | Debian/Ubuntu 为主 | x86/arm64/mips/OpenWRT/树莓派 |
| 每节点 RAM 增量 | ~150MB (Node.js) | **~3MB (Rust 静态二进制)** |

---

## 五、 渐进演进路径（最小冲击）

**Step 1（4~6 周）— 替代 `node-agent.sh`**
- 功能：注册签到 + 心跳上报 + WSS 接收配置推送
- 向后兼容：旧有 `node-agent.sh` 并行运行

**Step 2（4~8 周）— GNB Watchdog + 拓扑同步**
- 监控 GNB 进程、TUN 接口健康、打洞统计
- 接收 `RouteUpdateEvent` 实时同步 `address.conf`

**Step 3（长期）— 替代 `claw-rpc.ts` 的 SSH 代理**
- Console 通过 WSS 下发 OpenClaw 控制命令，synon-daemon 本地执行
- `ssh-manager.ts` 只保留交互式 Web SSH 场景

---

## 六、 Rust 技术选型

| 依赖 | 用途 | 成熟度 |
|---|---|---|
| `tokio` | 异步运行时 | 生产级 |
| `tokio-tungstenite` | WSS 双向连接（连 Console + 连 OpenClaw）| 生产级 |
| `reqwest` | HTTP REST 调用 OpenClaw | 生产级 |
| `serde_json` | JSON 序列化 | 生产级 |
| `nix` | 进程管理、信号处理 | 生产级 |
| 静态编译 target | `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl` | 完全支持 |
