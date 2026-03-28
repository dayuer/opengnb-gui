# Roadmap 阶段二演进 — 三功能设计文档

> TDD Phase 1: Brainstorming 产出

## 需求总结

在阶段一技术债（Sweeper, Orphan Healing, RBAC）消解完毕后，推进系统的三项核心演进：

1. **SSH 终端审计拦截** — 基于 RBAC 角色分级的命令过滤（admin 不拦截，operator/viewer 全量拦截）
2. **拓扑可视化** — D3.js force-directed graph，利用已有 `p2pDirect` 数据绘制网状拓扑
3. **Playbook Engine** — 扩展 `task-queue`，支持多步骤依赖拓扑的批量编排

---

## 功能一：SSH 终端审计拦截（RBAC 分级）

### 现状

- `ws-handler.ts` 的 `/ws/ssh` 是**纯透传管道**：`ws.on('message') → sshStream.write(msg)`
- 没有任何命令检测和拦截能力
- `ai-ops.ts` 已有 `BLOCKED_PATTERNS`（约 30 条正则）和 `_checkCommandSafety()` 方法
- `resolveToken()` 返回 `{ valid, userId, source }` — **缺少 `role` 字段**

### 设计

#### 1. 扩展 `resolveToken()` 返回 `role`

```typescript
// auth.ts — resolveToken 增加 role 字段
// JWT 路径: payload.role
// apiToken 路径: user.role
// adminToken 路径: 固定 'admin'
```

`TokenResult` 接口已有 `role?: string` 字段但从未赋值。需修改 `resolveToken()` 的 JWT 分支和 apiToken 分支填充 `role`。

#### 2. 提取 `BLOCKED_PATTERNS` 为共享模块

新建 `services/command-filter.ts`：

```typescript
// 从 ai-ops.ts 提取 BLOCKED_PATTERNS + 检查函数
export const BLOCKED_PATTERNS = [...];
export function checkCommandSafety(cmd: string): { blocked: boolean; reason?: string } | null;
```

`ai-ops.ts` 改为 `import { checkCommandSafety } from './command-filter'`。

#### 3. SSH WS 命令拦截

在 `ws-handler.ts` 的 SSH 连接中，**仅对非 admin 用户**启用命令检测：

```
ws.on('message', (msg) => {
  if (userRole !== 'admin') {
    // 累积字符到行缓冲区
    // 检测到回车 (\r 或 \n) 时检查整行命令
    // 匹配黑名单 → 发送红色告警文本 + 阻止该行传到 sshStream
    // 不匹配 → 正常转发
  } else {
    sshStream.write(msg); // admin 直通
  }
});
```

**行缓冲策略**：SSH 终端是字符流而非行流。需要：
- 维护一个 per-connection 的行缓冲区 `lineBuf`
- 每次收到数据拼接到 `lineBuf`
- 遇到 `\r` 或 `\n` 时取出完整行进行安全检查
- 检查通过后将原文（含 `\r`）转发给 `sshStream`
- 检查不通过时发送告警文本并清空 `lineBuf`
- 非回车字符正常转发（保证交互体验——用户需要实时看到回显）

**关键决策**：字符实时转发 + 回车时检查整行。这意味着用户能看到自己在输入什么（回显由远端 SSH 控制），但按下回车的那一刻如果命令危险，会被阻止执行。实现方式是在 `\r` 到来时**不转发该 `\r`**，而是发送告警信息，并用 Ctrl+U 清除远端行缓冲。

### 状态流

```
用户输入字符 → 实时转发到 sshStream（保持回显）
用户按回车 → 检查 lineBuf vs BLOCKED_PATTERNS
  ├── 安全 → 转发 \r，清空 lineBuf
  └── 危险 → 发送 \x15(Ctrl+U) 清远端 + 发红色告警 + 清空 lineBuf + 审计日志
```

---

## 功能二：拓扑可视化（D3.js Force-Directed）

### 数据基础

`gnb-monitor.ts` 的 `ingest()` 已将 `statusData.nodes`（PeerNode 数组）存入 `latestState`。
每个 `PeerNode` 包含: `uuid64, tunAddr4, status ('Direct'|'Relay'), latency4Usec, inBytes, outBytes`。

前端通过 WS `snapshot`/`update` 消息已经在收到 `nodes` 数组（每个节点的对等体列表）。

### 设计

#### 1. 新增前端页面 `pages/topology.ts`

- 路由: `#topology`，导航栏增加 "网络拓扑" 入口
- 使用 D3.js v7 (`d3-force`, `d3-selection`, `d3-zoom`) 通过 CDN 引入

#### 2. 拓扑数据构建

从 `App.nodesData` 转换为 D3 节点和边：

```typescript
interface TopoNode { id: string; name: string; tunAddr: string; online: boolean; x?: number; y?: number; }
interface TopoLink { source: string; target: string; type: 'direct' | 'relay'; latencyUs: number; }

function buildTopology(nodesData): { nodes: TopoNode[], links: TopoLink[] } {
  // 每个 node → TopoNode
  // 每个 node.nodes[] 对等体 → TopoLink（去重双向边）
}
```

#### 3. D3 渲染

- SVG 容器，支持 zoom + drag
- 节点: 圆形，颜色编码（在线/离线），悬停弹出卡片（sysInfo 摘要）
- 边: 实线(Direct) / 虚线(Relay)，粗细映射延迟
- 自动布局: `d3.forceSimulation` + `forceLink` + `forceCharge` + `forceCenter`

#### 4. 实时更新

监听 `App.nodesData` 的 WS 变更，diff 节点/边集合，调用 D3 的 enter/update/exit pattern。

### UI 集成

在 `core.ts` 的 `PAGE_TITLES` 和 `renderPage` 中注册 `topology` 路由。
导航栏 HTML 增加拓扑入口图标（使用 `network` lucide icon）。

---

## 功能三：Playbook Engine（批量编排）

### 现状

`TaskQueue` 当前只支持**单节点单任务**入队。没有任务依赖、步骤顺序、跨节点编排能力。

### 设计

#### 1. 数据模型 — `playbooks` 表 + `playbook_steps` 表

```sql
CREATE TABLE IF NOT EXISTS playbooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',  -- pending | running | completed | failed | cancelled
  targetNodeIds TEXT DEFAULT '[]', -- JSON 数组
  createdAt TEXT,
  startedAt TEXT,
  completedAt TEXT
);

CREATE TABLE IF NOT EXISTS playbook_steps (
  id TEXT PRIMARY KEY,
  playbookId TEXT NOT NULL,
  seq INTEGER NOT NULL,          -- 执行顺序
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  targetScope TEXT DEFAULT 'all', -- all | specific(nodeIds JSON)
  dependsOn TEXT DEFAULT '[]',   -- 前置步骤 ID JSON 数组
  status TEXT DEFAULT 'pending',
  resultSummary TEXT DEFAULT '',
  startedAt TEXT,
  completedAt TEXT,
  FOREIGN KEY (playbookId) REFERENCES playbooks(id) ON DELETE CASCADE
);
```

#### 2. 新增 `services/playbook-engine.ts`

核心逻辑：

```typescript
class PlaybookEngine extends EventEmitter {
  // 创建 Playbook
  create(name: string, steps: StepDef[], targetNodeIds: string[]): Playbook;

  // 启动执行
  start(playbookId: string): void;

  // 步骤执行器（内部）
  private _executeStep(step: PlaybookStep): Promise<StepResult>;

  // 步骤完成回调 — 检查依赖图，分发下一批可执行步骤
  private _onStepComplete(stepId: string, result: StepResult): void;

  // 取消
  cancel(playbookId: string): void;
}
```

**依赖拓扑执行**：使用 Kahn 算法（拓扑排序），每轮找出所有入度为 0 的步骤并行分发到对应节点的 `TaskQueue`。步骤完成后更新入度，执行下一轮。

**与 TaskQueue 的集成**：PlaybookEngine 为每个步骤 × 每个目标节点创建 `AgentTask`，监听 `TaskQueue.on('taskCompleted')` 来驱动流转。

#### 3. 路由 `routes/playbooks.ts`

```
POST   /api/playbooks          — 创建 playbook
GET    /api/playbooks           — 列表
GET    /api/playbooks/:id       — 详情（含步骤状态）
POST   /api/playbooks/:id/start — 启动
POST   /api/playbooks/:id/cancel — 取消
DELETE /api/playbooks/:id       — 删除
```

权限: `requireRole('admin', 'operator')`。

#### 4. 前端 — 暂不实现

Playbook 的前端 UI 复杂度较高（可视化步骤编辑器 + 执行进度甘特图），建议先通过 API 提供能力，前端在后续迭代中做。

---

## 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **[NEW]** | `src/services/command-filter.ts` | 从 ai-ops 提取的命令安全检查模块 |
| **[MODIFY]** | `src/services/ai-ops.ts` | 移除内联 `BLOCKED_PATTERNS`，改用 command-filter |
| **[MODIFY]** | `src/services/ws-handler.ts` | SSH 连接增加 RBAC 命令拦截 |
| **[MODIFY]** | `src/middleware/auth.ts` | `resolveToken()` 增加 `role` 返回 |
| **[MODIFY]** | `src/types/interfaces.ts` | `UserRole` 增加 `operator` \| `viewer` |
| **[NEW]** | `src/client/pages/topology.ts` | D3.js 拓扑可视化页面 |
| **[MODIFY]** | `src/client/core.ts` | 注册 topology 路由 |
| **[MODIFY]** | `src/client/main.ts` | 导入 + 挂载 Topology |
| **[NEW]** | `src/services/playbook-engine.ts` | Playbook 编排引擎 |
| **[NEW]** | `src/stores/playbook-store.ts` | Playbook 预编译语句 |
| **[NEW]** | `src/routes/playbooks.ts` | Playbook API 路由 |
| **[MODIFY]** | `src/services/node-store.ts` | Mixin playbook-store |
| **[MODIFY]** | `scripts/init-db.ts` | 新增 playbooks + playbook_steps 建表 |
| **[MODIFY]** | `src/server.ts` | 注册 playbook 路由 + 引擎 |
| **[NEW]** | `src/__tests__/services/command-filter.test.ts` | 命令过滤单元测试 |
| **[NEW]** | `src/__tests__/services/playbook-engine.test.ts` | Playbook 引擎单元测试 |
| **[MODIFY]** | `src/__tests__/middleware/rbac.test.ts` | resolveToken role 测试 |

---

## 实现顺序

鉴于依赖关系，建议按以下顺序实施：

1. **功能一: SSH 终端审计拦截**（最小变更面，安全优先）
   - Step 1.1: 提取 `command-filter.ts` + 测试
   - Step 1.2: 扩展 `resolveToken()` 返回 role + 测试
   - Step 1.3: 修改 `ws-handler.ts` SSH 管道 + 集成测试
   - Step 1.4: 修改 `ai-ops.ts` 复用 command-filter

2. **功能二: 拓扑可视化**（前端独立，不影响后端）
   - Step 2.1: 新建 `topology.ts` 页面 + 路由注册
   - Step 2.2: D3.js 拓扑渲染 + 实时更新
   - Step 2.3: 浏览器验证

3. **功能三: Playbook Engine**（最复杂，最后做）
   - Step 3.1: DB schema + store
   - Step 3.2: PlaybookEngine 核心 + 测试
   - Step 3.3: 路由 + server 集成
