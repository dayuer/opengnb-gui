# 任务队列提级 — 顺序派发 + 独立管理 UI

> 复杂度分级：**M**（新 UI Tab + 跨模块派发逻辑重构）

## 问题

当前 `ws-handler.ts` 的 Observer 监听 `taskQueued` 后立即并发派发，导致：
1. 多任务同时下发给 daemon → 竞态风险（如同时安装两个技能可能争锁）
2. 前端没有统一的任务管理入口，任务状态散落在各操作按钮的 toast 里

## 设计：顺序派发队列（Serial Dispatch Pattern）

### 核心思路

将 `ws-handler` 中的 fire-and-forget Observer 改为 **per-node 串行队列**：

```
taskQueued 事件
    │
    ├─ 追加到 nodeDispatchQueue[nodeId]
    │
    └─ tryDrainQueue(nodeId)
         │
         ├─ 已有任务执行中 → return（等待回调触发下一个）
         │
         └─ 无执行中任务 → 取队首 → sendToDaemon()
              │
              ├─ 成功 → processTaskResults() → tryDrainQueue() 递归
              │
              └─ 失败 → processTaskResults(failed) → tryDrainQueue() 递归
```

**关键**：每个 node 独立一条串行链，单个 node 内严格顺序执行，不同 node 之间互不阻塞。

### 前端 UI — 新增「任务」Tab

与「技能」「AI 模型」「渠道」平级，展示该节点的所有任务：

| 列 | 内容 |
|----|------|
| 类型图标 | 根据 task.type 显示 skill_install/claw_restart 等 |
| 任务名称 | skillName 或 type 的中文映射 |
| 状态徽章 | queued → 等待中(灰), dispatched → 执行中(蓝), completed → 成功(绿), failed → 失败(红), timeout → 超时(橙) |
| 入队时间 | queuedAt 相对时间 |
| 操作 | 展开查看 stdout/stderr + 删除按钮（仅 completed/failed/timeout 可删） |

## 变更清单

### [MODIFY] `src/services/ws-handler.ts`
- 将并发 Observer 改为 per-node 串行队列
- 新增 `nodeDispatchQueue` Map + `tryDrainQueue()` 方法
- daemon 断开时清理该 node 的 dispatch 锁

### [MODIFY] `src/client/components/node-detail-panel.ts`
- tabs 数组新增 `{ key: 'tasks', icon: 'list-todo', label: '任务' }`
- tab 路由新增 `if (ts.tab === 'tasks') this.loadTasksTab(node.id)`
- 新增 `loadTasksTab(nodeId)` + `renderTaskRow()` 方法

### 不改动
- `task-queue.ts` — 入队/出队/闭环 API 不变
- `task-dispatcher.ts` — 策略映射表不变
- `routes/nodes.ts` — GET/DELETE tasks API 已存在
- `synon-daemon` — 零改动

## 验证计划

1. **单测**: 验证 tryDrainQueue 严格顺序执行（第二个任务等第一个完成后才发）
2. **前端**: 部署后打开节点详情 → 切到任务 Tab → 确认列表渲染
3. **E2E**: 连续点两次"安装技能" → 观察 daemon 日志确认串行执行
