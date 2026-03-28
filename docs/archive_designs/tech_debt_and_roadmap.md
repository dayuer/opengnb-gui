# SynonClaw Console 技术债与演进路线图 (Technical Debt & Roadmap)

## 一、 系统现状与当前架构约束 (Architecture Review & Constraints)

经历了从 TUI 到 Web 控制台的演进，系统当前架构已经趋于稳定，核心支撑点如下：

1. **唯一事实来源 (SQLite WAL)**
   - `data/registry/nodes.db` 承担了元数据、监控时序、任务队列和技能库等几乎所有状态的存储。
   - 这消除了分布式状态同步难题，但受限于单体 SQLite 的写并发上限（尽管开启了 WAL）。在大规模节点（上万节点）高频上报时序指标时，可能会成为 IO 瓶颈。
2. **推拉结合的节点通信协议**
   - 节点上报状态（通过 HTTP POST `/api/monitor/report`），属于**推模式**。
   - 控制端下发任务基于此心跳响应搭载 (Piggyback) Agent Tasks 返回给节点，无需维持长连接。
   - 对于高优操作（如 Provisioning、交互式 Shell等），依然依赖反向建立 SSH 隧道直连（`SSHManager` 穿透 GNB TUN）。
3. **安全与认证模型**
   - 包含面向 Web 用户流的 JWT + API Token 双模型机制。
   - 节点间的互信依赖 `GNB` 底层点对点安全（通过静态配置的 TUN 地址白名单和 GNB key）。

### 存在的技术债 (Technical Debt)
1. **指标数据的无限膨胀**
   - 所有的心跳都会持久化写入 `metrics` 和 `audit_logs` 以及 `agent_tasks`，但并未看到成熟的 TTL 定期裁剪或抽样归档机制。长此以往 SQLite 文件会急剧膨胀。
2. **缺乏细粒度 RBAC 权限系统**
   - 当前的 `users` 表带有 `role: admin`，且中间件里只要 Token 校验通过即视为 `valid` 的 Admin。缺少对“普通用户”只能看某些分组、无法执行 SSH 破坏性操作的读写隔离。
3. **错误处理与监控补偿机制**
   - 节点的 Agent 心跳断连或任务执行超时（Timeout）的处理虽然有队列的 `timeoutMs`，但依赖 `GNB Monitor` 单点定时检测，如果控制台主进程重启，可能会导致某些处于 `dispatched` 状态的任务变成游离孤儿。

---

## 二、 下一步功能规划 (Roadmap & Next Steps)

根据代码审计结果和系统演进规律，以下功能具有**最高优先级**，建议在后续开发中依次推进：

### 阶段一：稳定性与数据治理 (Stability & Data Governance)
- [ ] **系统级定时清理 (TTL Sweeper)**
  - **描述**: 引入后台 Job，定期（如每天凌晨）裁剪老旧的 `metrics` (保留7天)、已完成但超期的 `agent_tasks` 及 `jobs`，避免 DB 文件无限制增长。
  - **模块**: 增加 `services/sweeper.ts`。
- [ ] **任务孤儿流转自愈 (Orphan Task Healing)**
  - **描述**: 系统启动时或定期扫描长时间标记为 `dispatched` 但无执行结果的心跳汇报，统一置为 `timeout_failed` 以打破状态死结。

### 阶段二：安全增强与审计闭环 (Security & Compliance)
- [ ] **多租户/RBAC 权限体系**
  - **描述**: 系统应分设 `Super Admin` (统管所有)、`Admin` (管理某个分组的节点) 和 `Viewer` (仅查看监控与日志)。在 API 侧 `requireAuth` 中进一步补充 `requireRole` 断言。
- [ ] **终端防阻断审计拦截**
  - **描述**: 在 `AiOps` 流程以及 `Cloud SSH` 流程中，禁止某些高危命令（如 `rm -rf /`，更改 GNB 主配置等），保障即使被接管也不会引爆核心控制网。

### 阶段三：高级集群管控能力 (Advanced Orchestration)
- [ ] **拓扑可视化诊断与链路测速 (Topology & Link Testing)**
  - **描述**: 依靠 `gnb_vt` 提供的 `p2pDirect` 信息构建可视化的网状拓扑图。在前端绘制每个节点的健康度及延迟（可通过 WebGL/Canvas 等技术提升渲染性能）。
- [ ] **批量软件编排 (Playbook Engine)**
  - **描述**: 扩充 `task-queue` 的能力，使其支持基于依赖拓扑的多节点事务（例如：先全量分发文件 -> 再并行重启进程 -> 最后验证健康状态）。

### 阶段四：产品级完善 (Product Polish)
- [ ] **告警网关对接 (Alerting Gateway)**
  - **描述**: 将 `Monitor` 中检测到的 `offline`, `high_cpu`, `disk_full` 状态变更包装为 Webhook/飞书/钉钉机器人的即时推送。
- [ ] **暗黑模式微调与响应式适配优化**
  - **描述**: 虽然当前采用了 Stitch 的高级 UI，但针对终端手机管理，部分拓扑或长表格可能需要自适应重拍（Responsive Reflow）调整。

## 结论
建议接下来的迭代首先解决**数据库定期的 TTL 清理任务**以及**孤儿队列自愈**，来消除潜在的炸弹，然后再发力**批量技能分发/编排**的业务价值放大功能。
