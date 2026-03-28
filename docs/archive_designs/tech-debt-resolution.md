# 技术债务消解 — 三件套设计文档

> TDD Phase 1: Brainstorming 产出

## 需求总结

解决当前系统的三大技术债务：

1. **数据膨胀** — `audit_logs` 和已完成的 `agent_tasks` 缺乏 TTL 清理（`metrics` 已有 7 天 TTL + 降采样，不在范围内）
2. **孤儿任务** — `dispatched` 状态任务在 Console 重启后无法自动回收，采用 **A+B 双保险** 方案
3. **RBAC 权限** — 三级权限体系 `admin / operator / viewer`

---

## 债务一：数据 TTL 清理

### 现状

- `MetricsStore._maintenance()` 已有 7 天硬删除 + 24h 降采样 → **不需要改**
- `audit_logs` 有 `deleteAuditBefore(ts)` SQL 语句已就绪，但从未被定时调用
- 已完成的 `agent_tasks` 有 `taskDeleteOldBefore(isoDate)` 语句已就绪，也从未被调用

### 方案

创建 `services/sweeper.ts`（独立模块），挂到 `MetricsStore._maintenance()` 同一个调度周期里（每 5 分钟一次），执行：

```
1. 清理 30 天前的 audit_logs（DELETE FROM audit_logs WHERE ts < ?）
2. 清理 7 天前已完成的 agent_tasks（DELETE FROM agent_tasks WHERE completedAt IS NOT NULL AND completedAt < ?）
```

**不新建定时器**，而是让 `MetricsStore` 在 `_maintenance()` 中回调 Sweeper，减少系统中的 setInterval 数量。

### 保留策略

| 表 | 保留时间 | 依据 |
|----|---------|------|
| `metrics` | 7 天 | 已有，不变 |
| `audit_logs` | 30 天 | 合规审计需要 |
| `agent_tasks`（已完成） | 7 天 | 与 metrics 对齐 |

---

## 债务二：孤儿任务自愈（A + B 双保险）

### 现状

`TaskQueue` 的 `getPendingTasks()` 将 `queued` → `dispatched`，但如果 Agent 不上报结果（断连、重启等），该任务永远悬挂在 `dispatched` 状态。

### 方案

在 `TaskQueue` 中增加两个方法：

#### A) 启动扫描 `healOrphanTasks()`

- **触发时机**：`server.ts` 的 `boot()` 中，`initServices()` 之后立即调用
- **逻辑**：将所有 `dispatched` 且 `dispatchedAt` 超过 `timeoutMs` 的任务标记为 `timeout`
- 需要在 `task-store.ts` 增加一条预编译语句 `findStaleDispatched`

#### B) 定时扫描 `startOrphanTimer(intervalMs)`

- **触发时机**：与监控循环同步启动
- **间隔**：每 60 秒扫描一次（轻量 SQL 查询，无性能压力）
- **逻辑**：同 A，但运行在 `setInterval` 中

两者共用同一个核心方法 `_healStale()`。

### 状态流修正

```
queued → dispatched → completed / failed / timeout(新增)
```

---

## 债务三：三级 RBAC 权限体系

### 角色定义

| 角色 | 描述 | 权限 |
|------|------|------|
| `admin` | 超级管理员 | 全部操作 |
| `operator` | 运维人员 | 节点管理、技能安装/卸载、查看监控日志。不能：管理用户、修改系统设置 |
| `viewer` | 只读用户 | 仅查看仪表盘、节点列表、监控数据。不能执行任何写操作 |

### 修改点

#### middleware/auth.ts

- 增加 `requireRole(...roles: string[])` 中间件生成器，替代硬编码的 `requireAdmin`
- 保留 `requireAdmin` 作为 `requireRole('admin')` 的快捷方式

#### routes/ 路由权限注解

| 路由 | 当前 | 修改后 |
|------|------|--------|
| `GET /api/nodes` | `requireAuth` | `requireAuth` (所有角色可读) |
| `POST /api/nodes/:id/*` | `requireAuth` | `requireRole('admin', 'operator')` |
| `DELETE /api/nodes/:id` | `requireAuth` | `requireRole('admin')` |
| `POST /api/provision/:id` | `requireAuth + strictLimit` | `requireRole('admin')` |
| `/api/ai` | `requireAuth + strictLimit` | `requireRole('admin', 'operator')` |
| `/api/auth/users (CRUD)` | `requireAuth` | `requireRole('admin')` |
| `/api/skills` (写) | `requireAuth` | `requireRole('admin', 'operator')` |
| `/api/skills` (读) | `requireAuth` | `requireAuth` |
| `/api/claw` | `requireAuth` | `requireRole('admin', 'operator')` |

#### stores/user-store.ts

- 确保 `insertUser` 时接受 `role` 参数（当前写死 `'admin'`，改为默认 `'viewer'`）

#### routes/auth.ts

- 管理员创建用户 API 时允许指定 `role`
- 登录接口返回 `role` 信息供前端路由判断

---

## 文件变更清单

| 操作 | 文件 |
|------|------|
| **[NEW]** | `src/services/sweeper.ts` |
| **[MODIFY]** | `src/services/metrics-store.ts` — 注入 Sweeper 回调 |
| **[MODIFY]** | `src/stores/task-store.ts` — 增加 `findStaleDispatched` 语句 |
| **[MODIFY]** | `src/services/task-queue.ts` — 增加 `healOrphanTasks()` + `startOrphanTimer()` |
| **[MODIFY]** | `src/middleware/auth.ts` — 增加 `requireRole()` |
| **[MODIFY]** | `src/server.ts` — 启动时调用 healOrphanTasks，路由加权限 |
| **[MODIFY]** | `src/stores/user-store.ts` — role 参数化 |
| **[MODIFY]** | `src/routes/auth.ts` — 创建用户支持 role |
| **[NEW]** | `src/__tests__/services/sweeper.test.ts` |
| **[MODIFY]** | `src/__tests__/services/task-queue.test.ts` — 增加孤儿自愈测试 |
| **[NEW]** | `src/__tests__/middleware/rbac.test.ts` |
