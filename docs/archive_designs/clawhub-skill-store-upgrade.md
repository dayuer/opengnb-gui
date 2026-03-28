# 技能商店升级设计：ClawHub + GitHub + 自建技能库

## 背景

当前技能商店是**静态硬编码** — 24 个技能写死在 `skills-store.ts` 的 `BUILTIN_SKILLS` 数组中，首次启动写入 SQLite。三大痛点：

1. **数据源静态**：新增技能需要改代码 + 发版
2. **与 OpenClaw 生态割裂**：ClawHub 有 13000+ 公开技能，无法浏览和安装
3. **不支持 GitHub 直装**：很多社区技能托管在 GitHub，无法一键安装

## 目标

三大安装源，统一在一个技能商店 UI 中：

```
┌──────────────────────────────────────────────┐
│              技能商店 (SkillHub)               │
├──────────┬──────────────┬────────────────────┤
│ 自建技能库 │  ClawHub 官方  │  GitHub 仓库直装    │
│ (本地上传) │ (在线搜索安装)  │ (URL 一键安装)     │
└──────────┴──────────────┴────────────────────┘
```

## 三大安装源设计

### 1. 自建技能库（已有基础，增强）

**现状**：已有 `POST /api/skills` 上传接口 + SQLite 存储。

**增强**：
- 支持上传 `SKILL.md` 文件 → 自动解析 YAML frontmatter 提取元数据
- 支持打包 `.tar.gz` 上传 → 存储到 `data/skills/` 目录
- 自建技能安装命令：`cp` 到节点的 `~/.openclaw/extensions/` 目录

**数据模型**（已有 `skills` 表，扩展字段）：

```sql
ALTER TABLE skills ADD COLUMN packagePath TEXT DEFAULT '';  -- 本地包路径
ALTER TABLE skills ADD COLUMN clawhubId TEXT DEFAULT '';    -- ClawHub 注册 ID
ALTER TABLE skills ADD COLUMN githubRepo TEXT DEFAULT '';   -- GitHub 仓库地址
ALTER TABLE skills ADD COLUMN installCommand TEXT DEFAULT ''; -- 自定义安装命令
```

**安装命令**：
```bash
# 自建技能 → 从 Console 下载并解压到 extensions 目录
curl -sSL $CONSOLE_URL/api/skills/$SKILL_ID/package | tar xz -C ~/.openclaw/extensions/
```

---

### 2. ClawHub 官方对接（核心新能力）

**方案**：在 Console 后端做**中间代理**，调 ClawHub API 搜索/查询，前端展示。

**数据流**：
```
前端搜索 → Console API → ClawHub API → 返回技能列表
前端安装 → Console 入队任务 → Agent 执行 → clawhub install <skill>
```

**后端新增 API**：

```
GET  /api/clawhub/search?q=browser     # 搜索 ClawHub
GET  /api/clawhub/skill/:id            # 获取技能详情
POST /api/clawhub/install              # 安装到指定节点（入队任务）
```

**安装命令**：
```bash
# ClawHub 技能 → clawhub CLI 安装
clawhub install <skill-name>
# 或直接用 openclaw（会自动查 ClawHub）
openclaw plugins install <skill-name>
```

**前端 Tab**：
```
[本地技能] [ClawHub 商店] [GitHub 安装]
```

ClawHub 商店 Tab 中：
- 搜索框 → 调 `/api/clawhub/search`
- 卡片展示技能名称、作者、安装量、评分
- 「安装到节点」按钮 → 选择目标节点 → 入队安装任务

**缓存策略**：
- 搜索结果缓存 5 分钟（内存 LRU）
- 热门技能列表定时同步到 SQLite（每日）

---

### 3. GitHub 仓库直装（灵活扩展）

**方案**：支持输入 GitHub 仓库 URL，Console 解析并生成安装命令。

**支持的 URL 格式**：
```
https://github.com/user/repo
https://github.com/user/repo/tree/main/packages/skill-name
github:user/repo
```

**安装命令生成**：
```bash
# 方案 A：npm from git（含 openclaw.extensions）
openclaw plugins install github:user/repo

# 方案 B：直接 clone + link
git clone --depth 1 https://github.com/user/repo /tmp/skill-install \
  && cd /tmp/skill-install \
  && npm install --production \
  && cp -r . ~/.openclaw/extensions/repo
```

**前端 UI**：
- 输入框：粘贴 GitHub 仓库 URL
- 自动解析：仓库名、README 摘要、星标数
- 「安装到节点」按钮

---

## 统一安装架构

所有安装源最终都通过同一条链路：

```
前端点击安装
  ↓
POST /api/nodes/:id/skills
  body: { skillId, source, name, installCommand? }
  ↓
routes/nodes.ts 根据 source 生成 command
  ↓
gnb-monitor.enqueueTask(nodeId, task)
  ↓
Agent 心跳拾取 → 本地执行 → 回传结果
  ↓
前端轮询刷新状态（已实现）
```

**source → command 映射表**：

| source | 安装命令 | 卸载命令 |
|--------|---------|---------|
| `openclaw-bundled` | `openclaw plugins enable {id}` | `openclaw plugins disable {id}` |
| `clawhub` | `clawhub install {id}` | `clawhub uninstall {id}` |
| `github` | `openclaw plugins install github:{repo}` | `openclaw plugins uninstall {id}` |
| `custom` | 自定义命令 | 自定义命令 |
| `skills.sh` | `npx -y skills add {slug}` | — |
| `npm` | `npm install -g {id}` | `npm uninstall -g {id}` |

---

## 实施路线图（建议分 3 期）

### Phase 1：自建技能库增强（1-2h）
- [ ] `skills` 表 schema 扩展（新字段）
- [ ] 上传 SKILL.md / tar.gz 支持
- [ ] 自建技能安装命令适配
- [ ] 现有 `BUILTIN_SKILLS` source 修正（stock → `openclaw-bundled`）

### Phase 2：ClawHub 官方对接（2-4h）
- [ ] 后端 ClawHub 代理 API（搜索 + 详情）
- [ ] 前端 ClawHub Tab + 搜索框 + 技能卡片
- [ ] 安装命令适配（`clawhub install` 或 `openclaw plugins install`）
- [ ] 搜索结果缓存

### Phase 3：GitHub 直装（1-2h）
- [ ] GitHub URL 解析器（提取 user/repo）
- [ ] 前端 GitHub 安装 Tab + URL 输入框
- [ ] 安装命令生成（`openclaw plugins install github:user/repo`）

---

## 待确认问题

1. **ClawHub API**：节点上有 `clawhub` CLI 吗？还是只能用 `openclaw plugins install`？
2. **认证**：ClawHub 搜索/安装需要认证吗？`clawhub login` 流程？
3. **自建技能包格式**：是否遵循 OpenClaw 官方的 `openclaw.extensions` 规范，还是自定义格式？
