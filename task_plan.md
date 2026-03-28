# 弹性 TUN 子网探测 — TDD 任务清单

## Sprint 目标
实现 Console 侧的弹性子网探测 + 冲突避让，确保动态分配的 TUN IP 不与节点宿主机网段冲突。

---

## Task 1: 新增 `subnet-detector.ts` — CIDR 冲突检测核心模块
- 文件: [NEW] `src/services/subnet-detector.ts`
- 内容:
  - `parseCidr(cidr)` — 解析 CIDR → {network, prefix, mask} (复用 gnb-config 已有逻辑)
  - `cidrOverlaps(a, b)` — 两个 CIDR 是否冲突（位运算）
  - `ipInCidr(ip, cidr)` — 单个 IP 是否落入 CIDR 范围
  - `detectLocalSubnets()` — 扫描宿主机 UP 状态网卡，返回 CIDR 列表
  - `findSafeSubnet(candidates, occupied)` — 从候选池选第一个无冲突子网
- 验证: 单元测试覆盖所有边界用例
- 复杂度: standard
- 风险: 🟢 LOW

## Task 2: 单元测试 `subnet-detector.test.ts`
- 文件: [NEW] `src/__tests__/services/subnet-detector.test.ts`
- 内容: 覆盖 cidrOverlaps、ipInCidr、findSafeSubnet 的正/负/边界用例
- 验证: `npm test` 全部 PASS
- 复杂度: standard
- 风险: 🟢 LOW

## Task 3: 增强 `gnb-config.ts` — nextAvailableIp 支持冲突检测
- 文件: [MODIFY] `src/services/gnb-config.ts` L174-206
- 内容:
  - `nextAvailableIp()` 新增可选参数 `remoteSubnets?: string[]`
  - 分配候选 IP 前，额外检查 `ipInCidr(candidate, remoteSubnet)` 是否冲突
  - 冲突则跳过该 IP，继续尝试下一个
- 验证: 新增测试用例验证 remoteSubnets 过滤行为
- 复杂度: cheap
- 风险: 🟢 LOW（参数可选，不传则行为不变）

## Task 4: DB 迁移 — nodes 表新增 localSubnets 列
- 文件: [MODIFY] `scripts/init-db.ts`
- 内容: 幂等 `ALTER TABLE nodes ADD COLUMN localSubnets TEXT DEFAULT '[]'`
- 验证: `npx tsx scripts/init-db.ts` 无报错
- 复杂度: cheap
- 风险: 🟢 LOW（幂等 ALTER + 默认值安全）

## Task 5: `key-manager.ts` — 支持 auto 子网 + 审批时冲突检查
- 文件: [MODIFY] `src/services/key-manager.ts`
- 内容:
  - constructor 中检测 `GNB_TUN_SUBNET=auto` → 调用 subnet-detector 自动选择
  - `submitEnrollment()` 接受 `localSubnets` 字段并存入 DB
  - `approveNode()` 调用 `nextAvailableIp(node.localSubnets)` 冲突检查
- 验证: 集成测试覆盖 auto 模式 + 冲突场景
- 复杂度: standard
- 风险: 🟡 MED（修改审批核心路径，但 auto 为可选模式）

## Task 6: `enroll.ts` — 注册 API 接受 localSubnets
- 文件: [MODIFY] `src/routes/enroll.ts`
- 内容:
  - `POST /api/enroll` 请求体新增 `localSubnets` 字段（可选）
  - `GET /api/enroll/status/:id` 响应新增 `consoleGnbTunSubnet` 返回子网信息
- 验证: 集成测试
- 复杂度: cheap
- 风险: 🟢 LOW

## Task 7: `initnode.sh` — 探测本地网段并上报
- 文件: [MODIFY] `scripts/initnode.sh`
- 内容:
  - 新增 `detect_local_subnets()` Shell 函数
  - 注册时将 localSubnets JSON 附带到 POST 请求体
- 验证: 手动运行函数验证输出格式
- 复杂度: cheap
- 风险: 🟢 LOW

## Task 8: `heartbeat.rs` — synon-daemon 心跳上报本地网段
- 文件: [MODIFY] synon-daemon `src/heartbeat.rs`
- 内容:
  - SysInfo 新增 `local_subnets: Vec<String>`
  - collect() 中扫描 `/proc/net/fib_trie` 或 `ip addr` 输出
- 验证: `cargo build` 编译通过 + 手动测试
- 复杂度: standard
- 风险: 🟢 LOW
