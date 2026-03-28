# OpenClaw 集中控制台 — Sprint 1 任务清单

设计文档: docs/designs/openclaw-console-control.md
分支: feature/openclaw-console-control

---

## Task 1.1: Upgrade 自动回滚（Rust）
- 文件: `/Users/liyuqing/sproot/synon-daemon/src/claw_manager.rs` `upgrade()` 函数
- 改动:
  - 升级前调用 `read_local_version().await` 记录 `prev_version`
  - `npm install` 成功但 `restart()` 失败 → 回滚到 `prev_version`
  - `npm install` 本身失败 → 直接返回错误（旧版本仍在，无需回滚）
  - 回滚失败时日志警告，不 panic
- 验证: `cargo test -p synon-daemon` 新增测试: `test_upgrade_rollback_on_restart_failure`
- 复杂度: cheap
- 风险: 🟢 LOW

- [x] RED: 新增 `test_upgrade_rollback_on_restart_failure` 测试（必须 FAIL）
- [x] GREEN: 修改 `upgrade()` 实现自动回滚
- [x] REFACTOR: 检查错误消息格式、日志语言
- [x] REVIEW: Spec + Quality

---

## Task 1.2: Config Tab 可编辑（TypeScript 前端）
- 文件: `src/client/components/node-detail-panel.ts`
  - `loadClawTab()` 的 config 子 Tab 渲染逻辑（L677-685 附近）
- 改动:
  - 将 `<pre>JSON.stringify(data)</pre>` 替换为:
    - `<textarea id="claw-config-editor-{nid}">` 可编辑（等宽字体）
    - 原始内容存入 `data-original` 属性（供 diff 对比）
    - "保存" 按钮 → `Nodes.saveClawConfig(nodeId)`
  - 新增方法 `saveClawConfig(nodeId)`:
    - 读取 textarea 内容与 original 对比
    - 调用 `POST /api/claw/:nodeId/config` with `{ patch: newContent, baseHash: "" }`
    - Toast 成功/失败提示
- 验证: `npm run build` 无报错（前端编译门控）
- 复杂度: standard
- 风险: 🟡 MED

- [x] RED: `npm run build` 预检（基线）
- [x] GREEN: 实现 textarea + 保存逻辑
- [x] REFACTOR: UX 细节（loading 状态、按钮禁用）
- [x] REVIEW: Spec + Quality

---

## Task 1.3: Channels Tab 可视化卡片（TypeScript 前端，只读）
- 文件: `src/client/components/node-detail-panel.ts`
  - `loadChannelsTab()` 渲染逻辑
- 改动:
  - 当前: `<pre>JSON.stringify(data)</pre>`
  - 改为: 解析 `data.channels` / `data.data` 数组 → Provider 卡片列表
  - 每张卡片: Provider 名称 + 类型 + 健康状态（running/error/unknown） + API Key 脱敏（前8位+...）
  - 无 channels 数据时展示 "暂无渠道信息" 占位
  - **一期不做增删改操作**
- 验证: `npm run build` 无报错
- 复杂度: cheap
- 风险: 🟢 LOW

- [x] RED: `npm run build` 预检
- [x] GREEN: 实现卡片渲染逻辑
- [x] REFACTOR: 检查 raw JSON 兜底展示逻辑
- [x] REVIEW: Spec + Quality
