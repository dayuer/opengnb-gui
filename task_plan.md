# 全局代码审计与技术文档汇总计划

## 目标
执行 `现在空闲时间，审计一下全部的代码实现，汇总技术文档，并给出下一步要做的功能`。
此任务将通过无盲区扫描当前系统的后端架构、前端实现、部署脚本等，完成知识库更新，并输出未来的演进方向。

## 进度情况 (Progress)

- [x] Phase 1: 核心代码审计 (Codebase Audit)
  - [x] 审计 `src/server.ts` 及核心 `services/` (如 `key-manager`, `node-store`, `task-queue` 等)
  - [x] 审计 `src/routes/` 及 API 鉴权、异常处理机制 (`middleware/`)
  - [x] 审计 `src/stores/` 数据库层实现，验证 Schema 设计与 SQLite WAL 模式
  - [x] 审计 `src/client/` 前端 SPA 架构 (Vite + Vanilla TS 组件模型、WebSocket 通信栈)
  - [x] 审计 `scripts/` (部署、DB 初始化、Agent 脚本等)
- [x] Phase 2: 技术文档汇总 (Documentation Synthesis)
  - [x] 梳理系统整体架构图与组件数据流，可能更新补充 `AGENTS.md`
  - [x] 梳理核心机制（如 SSH 下行控制、推拉结合的任务队列模型）
  - [x] 输出当前系统的技术债 (Technical Debt) 与实现约束
- [x] Phase 3: 下一步功能规划 (Roadmap & Next Steps)
  - [x] 评估业务闭环中缺失的环节
  - [x] 拟定优先级最高的功能特性栈并撰写推荐 Next Steps (将写入 `docs/tech_debt_and_roadmap.md`)

## [2026-03-27] OpenClaw 控制面扩展与 Daemon 长连接修缮

- [x] Task 1: 扩展 UI 节点详情面板，将 OpenClaw 的 Models 和 Channels 提级为独立子 Tab，并增加 `重启`与`更新`操作按钮。
- [x] Task 2: 新增 API `/api/claw/:nodeId/restart` 和 `/api/claw/:nodeId/update`，打通下发系统。
- [x] Task 3: 优化前端 Skills Tab 中的 `已安装` 判断，精确按照 `status === 'ready'` 过滤状态机副作用。
- [x] Task 4: 诊断并修复 Rust Daemon `synon-daemon` 由于 NAT 超时的断联问题。
  - 引入了 `socket2` 以建立并配置内核级 TCP Keepalive。
  - 实施了基于应用层的 Ping-Pong Watchdog 控制循环。
- [x] Task 5: 验证并多机器部署最新二进制与重启控制流（TDD 闭环）。
