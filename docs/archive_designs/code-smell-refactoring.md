# 代码坏味道审查与重构设计

> TDD 阶段 1 产出 — 使用经典设计模式对 opengnb-gui 后端核心代码进行坏味道审查。

## 审查范围

| 文件 | 行数 | 审查焦点 |
|------|------|---------|
| `key-manager.ts` | 681 | 过长方法、条件分支、职责过重 |
| `gnb-monitor.ts` | 333 | 职责不纯（监控 + 任务队列） |
| `node-store.ts` | 425 | 重复建表语句、mixin 组合方式 |
| `skills-store.ts` | 230 | 构造函数条件逻辑、类职责单一 |
| `server.ts` | 389 | boot 函数过长、认证逻辑重复 |
| `routes/nodes.ts` | 355 | 安装命令条件分支过深、require 散落 |
| `ws-handler.ts` | 383 | 认证逻辑重复三次 |

---

## 坏味道清单

### 🔴 高优先级

#### 1. 条件分支瀑布：技能安装命令生成（`routes/nodes.ts` L248-277）

**坏味道**: 7 个 `if-else` 分支，每个分支根据 `source` 类型生成不同安装命令。典型的 **「以多态取代条件表达式」** 场景。

```typescript
// 当前（坏味道）
if (source === 'openclaw-bundled') { command = `openclaw plugins enable ${skillId}`; }
else if (source === 'clawhub') { command = `clawhub install ${skillId}`; }
else if (source === 'github') { ... }
else if (source === 'openclaw') { ... }  // 10 行复合命令
else if (source === 'skills.sh') { ... }
else if (source === 'npm') { ... }
else if (source === 'console') { return res.json(...); }
else if (source.startsWith('http')) { ... }
else { return res.status(400)...; }
```

**重构方案**: **策略模式 + 工厂函数**

```typescript
// 提炼为独立策略注册表（Map<source, CommandBuilder>）
const INSTALL_STRATEGIES: Record<string, SkillCommandBuilder> = {
  'openclaw-bundled': (ctx) => `openclaw plugins enable ${ctx.skillId}`,
  'clawhub':         (ctx) => `clawhub install ${ctx.skillId}`,
  'github':          (ctx) => `openclaw plugins install github:${ctx.repo}`,
  'skills.sh':       (ctx) => `npx -y skills add ${ctx.slug}`,
  'npm':             (ctx) => `npm install -g ${ctx.skillId} --registry=...`,
  // ...
};

// 路由层只做分发
const builder = INSTALL_STRATEGIES[source];
if (!builder) return res.status(400)...;
const command = builder(ctx);
```

同样适用于卸载命令（`L310-324`）。

---

#### 2. 重复的认证逻辑（`server.ts` L184-197, `ws-handler.ts` L51-62 × 3 处）

**坏味道**: Token 解析逻辑（adminToken / JWT / apiToken 三级 fallback）在 3 个位置重复：
- `server.ts` `/api/monitor/report` 内联认证
- `ws-handler.ts` `resolveWsToken()` 函数
- `middleware/auth.ts` `requireAuth` 中间件

**重构方案**: **提炼方法 → 统一 Token 解析器**

将认证逻辑收敛到 `middleware/auth.ts` 导出一个纯函数 `resolveToken(token, { adminToken, store, verifyJwt })`，所有消费方统一调用。

---

#### 3. `GnbMonitor` 职责不纯（`gnb-monitor.ts` L228-328）

**坏味道**: `GnbMonitor` 同时承担 **监控收集** 和 **Agent 任务队列管理** 两个不相关职责。100 行任务队列代码（`enqueueTask` / `getPendingTasks` / `processTaskResults` / `getNodeTasks` / `deleteTask`）与 GNB 监控无关。

**重构方案**: **提炼类 → `TaskQueue` 独立模块**

将任务队列相关方法提炼为 `services/task-queue.ts`，`GnbMonitor` 只做监控；`server.ts` 分别注入两个实例。

---

### 🟡 中优先级

#### 4. `key-manager.ts` `updateNode()` 过长（L363-431, 68 行）

**坏味道**: 单个方法内包含 4 种字段校验（tunAddr / sshPort / name / sshUser），每种校验都有独立的 early-return。缩进最深处达 3 层。

**重构方案**: **提炼方法 + 引入参数对象**

```typescript
// 提炼校验器
const FIELD_VALIDATORS: Record<string, (value: any, nodeId: string, store: any) => string | null> = {
  tunAddr: validateTunAddr,
  sshPort: validateSshPort,
  name:    validateName,
  sshUser: validateSshUser,
};
```

将 4 个校验块提炼为独立函数，`updateNode` 只做 loop + delegate。

---

#### 5. `SkillsStore` 构造函数条件逻辑（`skills-store.ts` L24-37）

**坏味道**: 构造函数内用 `typeof` 检查判断共享模式 vs 独立模式。违反「**以工厂函数取代构造函数**」原则。

**重构方案**: **工厂函数**

```typescript
// 取代构造函数的双模式判断
static fromSharedDb(db: Database): SkillsStore { ... }
static fromPath(dbPath: string): SkillsStore { ... }
```

---

#### 6. `node-store.ts` 重复建表语句（L60-163 vs L170-192）

**坏味道**: `agent_tasks` 建表语句完整出现两次 — 一次在主 `_createTables()` DDL 块中，一次在「独立建表迁移」兜底中。维护时必须同步两处。

**重构方案**: **提炼常量**

```typescript
const AGENT_TASKS_DDL = `CREATE TABLE IF NOT EXISTS agent_tasks (...)`;
// 两处统一引用
```

---

#### 7. `server.ts` `boot()` 函数过长（L69-382, 313 行）

**坏味道**: 整个应用初始化在一个巨大的 `boot()` 函数中完成 — 包括 DB 初始化、用户创建、路由注册、事件绑定、服务启动。是典型的 **God Function**。

**重构方案**: **提炼方法**

拆分为语义清晰的子函数：
- `initDatabase()` — DB + 首次用户
- `initRoutes(app, deps)` — 路由注册
- `initEventHandlers(deps)` — 事件绑定
- `startServer(server, deps)` — 监听 + 启动日志

---

### 🟢 低优先级（记录但本轮不做）

#### 8. `require` 散落在函数体内

多处在函数内 `const crypto = require('crypto')` 或 `const path = require('path')`（`routes/nodes.ts` L85, L146-148, L279, L306）。应提升到文件顶部。

#### 9. `ws-handler.ts` 三个 WS 服务器認证流程结构重复

三个 `connection` handler 都包含相同的 auth timeout + message-once-parse-validate 模式。可用高阶函数提炼公共认证壳。

#### 10. `any` 类型泛滥

几乎所有参数和返回值都是 `any`，丧失类型安全。但这是长期改进方向，本轮不做。

---

## 本轮重构优先级

按 **影响面 × 风险** 排序，推荐本轮聚焦 **高优先级 3 项**：

| # | 重构项 | 手法 | 影响文件 | 复杂度 |
|---|--------|------|---------|--------|
| 1 | 技能命令策略模式 | 以多态取代条件表达式 | `routes/nodes.ts` + 新文件 `services/skill-command.ts` | standard |
| 2 | 统一 Token 解析器 | 提炼方法 | `middleware/auth.ts`, `server.ts`, `ws-handler.ts` | standard |
| 3 | TaskQueue 独立模块 | 提炼类 | `gnb-monitor.ts` + 新文件 `services/task-queue.ts`, `server.ts` | standard |

中优先级项（#4 updateNode 校验提炼、#5 SkillsStore 工厂函数、#6 重复 DDL）在本轮重构完成后作为后续迭代。

---

## 验证计划

### 自动化测试

项目使用 `node:test` 内置测试框架，运行命令：

```bash
# 全量测试
node --import tsx --test 'src/__tests__/**/*.test.ts'

# 单文件测试
node --import tsx --test src/__tests__/routes/nodes-skills.test.ts
```

每项重构需要：
1. 新增对应单元测试（RED → GREEN → REFACTOR）
2. 全量回归测试通过

### 新增测试计划

| 重构项 | 新增测试文件 | 覆盖点 |
|--------|-------------|--------|
| 技能命令策略 | `src/__tests__/services/skill-command.test.ts` | 7 种 source 类型各生成正确命令；未知 source 返回 null |
| 统一 Token 解析 | 扩展 `src/__tests__/middleware/auth.test.ts` | resolveToken 三级 fallback；无效 token 返回 false |
| TaskQueue 独立模块 | `src/__tests__/services/task-queue.test.ts` | enqueue / getPending / processResults / delete 的行为不变 |

### 回归验证

每项重构完成后运行全量测试确认无回归：

```bash
node --import tsx --test 'src/__tests__/**/*.test.ts'
```
