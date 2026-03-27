# 控制面断层修复 — 任务队列 → Daemon WS 桥接

> 复杂度分级：**M**（跨模块、修改现有 API 接口语义）

## 问题根因

```
┌─ Console 前端 ─────────────────────┐    ┌── synon-daemon ───────────┐
│ 用户点击"安装技能/重启 OpenClaw"    │    │ handle_server_message()   │
│         ↓                          │    │                           │
│ POST /api/nodes/:id/skills         │    │ "skill_install"  → 原生   │
│ POST /api/claw/:id/restart         │    │ "claw_restart"   → 原生   │
│         ↓                          │    │ "claw_upgrade"   → 原生   │
│ taskQueue.enqueueTask()            │    │ "exec_cmd"       → 白名单 │
│   → SQLite INSERT (agent_tasks)    │    │                           │
│   → this.emit('taskQueued')        │    │ ⚠️ 从未收到任何任务！      │
│         ↓ ???                      │    └───────────────────────────┘
│ 🔴 无人监听该事件                   │
│ 🔴 旧 node-agent.sh 轮询 HTTP      │
│    但 daemon 用 WS，不走 HTTP       │
└────────────────────────────────────┘
```

**两大断层**：
1. **Observer 断层**：`taskQueue.emit('taskQueued')` 无人监听，任务永远锁在 SQLite 里
2. **Protocol 错配**：`claw.ts` 下发 `sudo systemctl restart openclaw` 等 shell 命令，但 daemon 白名单不含 `sudo`；同时用了 `| bash` 触发黑名单。而 daemon 已有原生 `claw_restart` / `claw_upgrade` 处理器

## 设计模式应用

### 1. 观察者模式 (Observer) — 联通 TaskQueue ↔ WS

**核心**：`ws-handler.ts` 订阅 `taskQueue.on('taskQueued')`，实时将任务推送给对应 daemon。

```
TaskQueue.enqueueTask()
    │
    ├─ SQLite INSERT (持久化)
    │
    └─ this.emit('taskQueued', { nodeId, task })
          │
          └─ ws-handler 监听
                │
                ├─ daemon 在线 → sendToDaemon(nodeId, msg) → WS 下发
                │                                             ↓
                │                              daemon → handle_server_message()
                │                                             ↓
                │                              cmd_result 回传 → 更新 SQLite
                │
                └─ daemon 离线 → 保持 SQLite queued 状态
                               → 老 agent 下次 HTTP 轮询时仍可领取
```

### 2. 策略模式 (Strategy) — 任务类型 → WS 消息映射

**核心**：新增 `task-dispatcher.ts` 策略表，将 `task.type` 映射为 daemon 理解的 WS 消息结构。

```typescript
const DISPATCH_STRATEGIES: Record<string, (task) => WsMessage> = {
  'skill_install':   (t) => ({ type: 'skill_install',   skillId: t.skillId }),
  'skill_uninstall': (t) => ({ type: 'skill_uninstall', skillId: t.skillId }),
  'claw_restart':    ()  => ({ type: 'claw_restart' }),
  'claw_upgrade':    (t) => ({ type: 'claw_upgrade', version: t.version }),
  'exec_cmd':        (t) => ({ type: 'exec_cmd', command: t.command }),
};
```

**降级策略**：未匹配的 type → 降级为 `exec_cmd`（走 daemon 白名单）。

### 3. 适配器模式 (Adapter) — 统一 claw.ts 的命令语义

**核心**：`claw.ts` 的 restart/update 路由不再拼接 shell 命令，改为存入语义化的 `type`，让策略表翻译。

**Before**:
```typescript
command: 'sudo systemctl restart openclaw',  // ❌ daemon 白名单拒收
```

**After**:
```typescript
type: 'claw_restart',  // ✅ 策略表翻译成 WS 原生消息
command: '',           // 不再需要 shell 命令
```

## 变更清单

### [NEW] `src/services/task-dispatcher.ts`
任务类型 → WS 消息的策略映射表 + 分发逻辑。接收 `(task, sendFn)` 翻译并发送。

### [MODIFY] `src/services/ws-handler.ts`
- 工厂函数新增 `taskQueue` 依赖注入
- 在 daemon 连接建立后，监听 `taskQueue.on('taskQueued')`
- 收到 `cmd_result` 时，调用 `taskQueue.processTaskResults()` 闭环

### [MODIFY] `src/server.ts`
- 将 `taskQueue` 传入 `createWsHandlers()`

### [MODIFY] `src/routes/claw.ts`
- `restart` 路由：`type: 'claw_restart'`，移除 `command` 字段
- `update` 路由：`type: 'claw_upgrade'`，移除 shell 拼接

### 不改动
- `synon-daemon` 端完全不改（已有完善的原生处理器）
- `exec_handler.rs` 白名单不改（正确的安全边界）
- `task-queue.ts` 不改（已有 emit 事件和 processTaskResults）

## 验证计划

1. **单元测试**：`task-dispatcher.test.ts` — 覆盖策略映射和降级逻辑
2. **集成测试**：模拟 `taskQueue.emit('taskQueued')` → 验证 `sendToDaemon` 被调用
3. **生产验证**：部署后，在 UI 点击安装技能 / 重启 OpenClaw → 观察 daemon 日志
