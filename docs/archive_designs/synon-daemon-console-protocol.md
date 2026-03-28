# Console 协议重构设计 — 配合 synon-daemon

> 当 synon-daemon 取代 SSH+脚本 后，SynonClaw Console 在数据获取和操作下发方面需要做的调整。

---

## 一、 现状 vs 目标架构对比

### 现状（三种异构通道）

```
前端 SPA
  ↕ WS (wss://console/ws)              ← 监控数据推送
  
Console (Node.js)
  ↕ SSH (via ssh-manager.ts)           ← 运维操作、OpenClaw RPC
  ↓ HTTP GET /api/monitor/report       ← 节点心跳（curl 脚本推）
  
节点 (Bash脚本 + Node.js)
  ├── node-agent.sh (每10s cron)       ← 系统状态采集 + POST
  ├── openclaw (Node.js, 150MB)        ← AI能力
  └── gnb (C)                          ← 网络
```

### 目标（统一 WSS 控制面）

```
前端 SPA
  ↕ WS 不变（继续 ws-handler.ts） 

Console (Node.js)
  ↕ WSS /ws/daemon               ← 新增第4个 WS 通道（取代 SSH + HTTP push）

节点 (Rust daemon, 2MB)
  ├── synon-daemon ← 主体，与 Console 维持长连接
  │     ├── 推: 状态心跳 (替代 node-agent.sh 的 HTTP POST)
  │     ├── 收: 路由/配置/命令 下发 (替代 provisioner.ts SSH)
  │     └── 转: OpenClaw 本地 HTTP 调用 (替代 claw-rpc.ts SSH代理)
  ├── openclaw (不变)
  └── gnb (不变)
```

---

## 二、 Console 需要新增的 WS 通道：`/ws/daemon`

在 `ws-handler.ts` 新增第 4 个 `WebSocketServer`（`wssDaemon`），专用于 synon-daemon 双向通信。

### 连接握手

```
← daemon: { type: "hello", nodeId: "...", token: "...", version: "1.0.0",
             gnbStatus: "running", clawStatus: "running", tunAddr: "10.x.x.x" }
→ console: { type: "hello-ack", ok: true, pendingCmds: [...] }
```

- `token` 是节点注册时 Console 颁发的 `apiToken`（已有字段，无需新增）
- 基于此鉴权，不需要额外增加 `users` 表改动

### 消息类型设计

| 方向 | type | 取代什么 |
|---|---|---|
| daemon → Console | `heartbeat` | `node-agent.sh` + HTTP POST `/api/monitor/report` |
| daemon → Console | `gnb_peers` | `gnb_ctl` 解析结果（P2P 对等体列表）|
| daemon → Console | `claw_event` | OpenClaw WS `health`/`tick` 事件订阅结果 |
| daemon → Console | `cmd_result` | SSH exec 命令结果返回 |
| Console → daemon | `route_update` | SSH + 重写 `address.conf` + `systemctl restart gnb` |
| Console → daemon | `claw_rpc` | SSH代理 `curl 127.0.0.1:18789` |
| Console → daemon | `exec_cmd` | `provisioner.ts` 的 SSH 命令（受限白名单）|
| Console → daemon | `deploy_file` | SSH + `scp` 文件分发 |

---

## 三、 Console 各模块调整映射

### 3.1 `gnb-monitor.ts` — 数据接收层调整

**现状**：`ingest(nodeId, report)` 由 HTTP route `/api/monitor/report` 调用

**调整**：新增 `ingestFromDaemon(ws, msg)` 方法，被 wssDaemon `heartbeat` 消息触发——**上层 `ingest()` 接口不变**，只是调用来源从 HTTP 改为 WS。

```typescript
// gnb-monitor.ts 新增（改动极小）
ingestFromDaemon(nodeId: string, heartbeat: DaemonHeartbeat) {
  // 映射字段后复用现有 ingest()
  this.ingest(nodeId, {
    sysInfo: heartbeat.sysInfo,
    nodes: heartbeat.gnbPeers,
    clawStatus: heartbeat.clawStatus,
    // ...
  });
}
```

**保留 HTTP `/api/monitor/report`**：在过渡期，老节点（尚未安装 synon-daemon）继续走 HTTP push，两者并行。

### 3.2 `claw-rpc.ts` — 彻底重构

**现状**：通过 SSH exec `curl 127.0.0.1:18789` 代理 OpenClaw 调用（两跳，~200ms）

**调整**：Console 通过 `wssDaemon` 向对应节点发送 `claw_rpc` 指令，daemon 本地调用后将结果推回。

```typescript
// 新增 daemon-proxy.ts（取代 claw-rpc.ts）
class DaemonProxy {
  // 向 daemon 发送 RPC 请求，等待 cmd_result 响应
  async callDaemon(nodeId: string, cmd: DaemonCmd, timeout = 10000): Promise<unknown>;
  
  // 便捷方法（接口与 claw-rpc.ts 保持一致，方便迁移）
  async getClawStatus(nodeId: string) {
    return this.callDaemon(nodeId, { type: 'claw_rpc', method: 'status' });
  }
  async patchClawConfig(nodeId: string, patch: string, baseHash: string) {
    return this.callDaemon(nodeId, { type: 'claw_rpc', method: 'config.patch', params: { patch, baseHash } });
  }
}
```

`routes/claw.ts` 只需将 `clawRPC` 替换为 `daemonProxy` 实例，外部 REST API 接口**完全不变**。

### 3.3 `provisioner.ts` — SSH 操作逐步替代

**现状**：整个 `_exec()` / `_installGnb()` / `_installClaw()` 链路依赖 SSH

**调整策略（渐进，不破坏现有能力）**：

1. 安装类操作（`installGnb`, `installClaw`）：改为 Console 发 `deploy_file` + `exec_cmd` 给 daemon，daemon 本地执行
2. 配置类操作（`configureGnb`）：改为发 `route_update` 事件，daemon 原子写入 + 热重载
3. `_verify()` 验证：daemon 主动通过 `heartbeat` 上报状态，Console 侧被动检查，不需要主动 SSH 验证

**过渡期**：`provisioner.ts` 内部判断 `node.daemonVersion` 字段——有 daemon 则走 WSS 通道，无 daemon 则降级到旧 SSH 路径。零破坏性发布。

### 3.4 `ssh-manager.ts` — 缩小职责

**保留场景**：仅保留 Web SSH 终端（`wssSsh` 通道）的交互式 Shell，这是用户明确需要的调试体验。

**移除场景**：所有自动化脚本的 `exec()` 调用，统一由 daemon 接管。

---

## 四、 `ws-handler.ts` 新增 wssDaemon 的关键实现要点

```typescript
// ws-handler.ts 新增 wssDaemon
const wssDaemon = new WebSocketServer({ noServer: true });

// 每个 daemon 连接绑定到一个 nodeId
const daemonConns = new Map<string, WsClient>(); // nodeId → ws

wssDaemon.on('connection', (ws, req) => {
  // 1. 等待 hello 帧鉴权（与 node 的 apiToken 比对）
  ws.once('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type !== 'hello') { ws.close(4001, '非法连接'); return; }
    const node = validateDaemonToken(msg.nodeId, msg.token);
    if (!node) { ws.close(4003, '认证失败'); return; }
    
    daemonConns.set(msg.nodeId, ws);
    ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
    
    // 2. 后续消息路由
    ws.on('message', (data) => handleDaemonMessage(msg.nodeId, JSON.parse(data)));
    ws.on('close', () => daemonConns.delete(msg.nodeId));
  });
});

// 3. 下发命令给 daemon（被 routes/claw.ts 和 provisioner.ts 调用）
function sendToDaemon(nodeId: string, cmd: DaemonCmd): Promise<unknown> {
  const ws = daemonConns.get(nodeId);
  if (!ws) throw new Error(`节点 ${nodeId} daemon 未连接`);
  // 用 reqId 实现 req/res 配对
  return pendingDaemonReqs.set_and_wait(cmd.reqId, ws, cmd);
}
```

---

## 五、 节点数据库字段新增（极小改动）

只需在 `nodes` 表的 JSON 元数据中新增两个字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `daemonVersion` | `TEXT` | 已安装的 synon-daemon 版本，`null` 表示未装 |
| `daemonConnectedAt` | `TEXT` | 最近一次 WS 连接时间，用于判断在线状态 |

无需 schema migration，因为 `nodes` 表的额外字段以 JSON TEXT 形式存储。

---

## 六、 迁移路径总结

```
现在                          过渡期                         目标
─────────────────────────────────────────────────────────────────
node-agent.sh (HTTP push) → 并行运行，daemon 优先          → 仅 daemon WSS push
claw-rpc.ts (SSH 代理)    → daemon 连接时自动启用新路径    → daemon-proxy.ts
provisioner.ts (SSH)      → node.daemonVersion 判断分流    → exec_cmd via daemon
ssh-manager.ts (全功能)   → 保留 Web SSH 终端功能          → 仅交互式 Shell
```

**关键原则：Console 对外的 REST/WS API 接口对前端 SPA 全部保持不变，调整仅发生在 Console 内部的数据获取和操作下发层。**
