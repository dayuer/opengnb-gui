/**
 * 核心数据结构接口定义 — SynonClaw Console
 *
 * 与 SQLite 表结构一一对应 + 运行时扩展字段
 * @alpha Phase 11
 */

// ═══════════════════════════════════════
//  节点 (nodes 表)
// ═══════════════════════════════════════

/** 节点状态枚举 */
export type NodeStatus = 'pending' | 'approved' | 'rejected';

/** 节点记录 — 对应 nodes 表 */
export interface NodeRecord {
  id: string;
  name: string;
  tunAddr: string;
  gnbNodeId: string;
  status: NodeStatus;
  sshUser: string;
  sshPort: number;
  netmask: string;
  groupId: string;
  clawToken: string;
  clawPort: number;
  gnbMapPath: string;
  gnbCtlPath: string;
  ready: number; // SQLite boolean (0/1)
  ownerId: string;
  submittedAt: string | null;
  approvedAt: string | null;
  updatedAt: string | null;
  readyAt: string | null;
  skills?: unknown[];
}

/** 节点配置 — SSH 连接所需的最小字段 */
export interface NodeConfig {
  id: string;
  name: string;
  tunAddr: string;
  sshUser: string;
  sshPort: number;
  clawToken?: string;
  clawPort?: number;
}

// ═══════════════════════════════════════
//  分组 (groups 表)
// ═══════════════════════════════════════

export interface GroupRecord {
  id: string;
  name: string;
  color: string;
  createdAt: string | null;
  nodeCount?: number; // 运行时聚合字段
}

// ═══════════════════════════════════════
//  用户 (users 表)
// ═══════════════════════════════════════

export type UserRole = 'admin' | 'member';

export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  apiToken: string;
  createdAt: string | null;
}

/** JWT Payload — signJwt/verifyJwt */
export interface JwtPayload {
  userId: string;
  username: string;
  role: UserRole;
  iat: number;
  exp: number;
}

// ═══════════════════════════════════════
//  异步 Job (jobs 表)
// ═══════════════════════════════════════

export type JobStatus = 'dispatched' | 'running' | 'completed' | 'failed';

export interface JobRecord {
  id: string;
  nodeId: string;
  command: string;
  status: JobStatus;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ═══════════════════════════════════════
//  监控指标 (metrics 表)
// ═══════════════════════════════════════

export interface MetricsRecord {
  nodeId: string;
  ts: number;
  cpu: number;
  memPct: number;
  diskPct: number;
  sshLatency: number;
  loadAvg: string;
  p2pDirect: number;
}

/** 聚合指标摘要 — /api/nodes/metrics/summary */
export interface MetricsSummary {
  avgCpu: number;
  avgMemPct: number;
  avgDiskPct: number;
  avgLatency: number;
  alertCount: number;
}

// ═══════════════════════════════════════
//  GNB Monitor — 运行时状态
// ═══════════════════════════════════════

/** 系统信息 — Agent 上报 */
export interface SysInfo {
  cpuUsage: number;
  memTotalMB: number;
  memUsedMB: number;
  diskTotalGB: number;
  diskUsedGB: number;
  loadAvg: string;
  uptime: number;
}

/** GNB 节点对等体状态 */
export interface PeerNode {
  uuid64: string;
  tunAddr4?: string;
  wanAddr4?: string;
  wanAddr6?: string;
  inBytes?: number;
  outBytes?: number;
  latency4Usec?: number;
  latency6Usec?: number;
  status?: string;
}

/** 节点监控状态 — Monitor.latestState */
export interface MonitorState {
  online: boolean;
  lastUpdate: number;
  sshLatencyMs: number;
  core: Record<string, unknown> | null; // GNB 核心状态（结构不定）
  nodes: PeerNode[];
  addresses: Array<Record<string, unknown>>;
  sysInfo: SysInfo;
  openclaw: OpenClawInfo | null;
  error: string | null;
}

/** OpenClaw 信息 — Agent 上报 */
export interface OpenClawInfo {
  token?: string;
  port?: number;
  version?: string;
  plugins?: string[];
}

/** 前端节点监控数据 — /api/nodes/monitor */
export interface NodeMonitorData {
  id: string;
  name: string;
  tunAddr: string;
  online: boolean;
  lastUpdate: number;
  sshLatencyMs: number;
  sysInfo: SysInfo;
  nodes: PeerNode[];
  groupId?: string;
}

// ═══════════════════════════════════════
//  AI Ops
// ═══════════════════════════════════════

/** AI 操作响应 */
export interface AiOpsResponse {
  response: string;
  commands: string[];
  blocked?: boolean;
}

// ═══════════════════════════════════════
//  WebSocket 消息类型
// ═══════════════════════════════════════

export type WsMessageType =
  | 'status_update'
  | 'pending_update'
  | 'provision_log'
  | 'job_dispatched'
  | 'job_result';

export interface WsMessage {
  type: WsMessageType;
  [key: string]: unknown;
}

// ═══════════════════════════════════════
//  Agent 任务队列 (agent_tasks 表)
// ═══════════════════════════════════════

export type TaskStatus = 'queued' | 'dispatched' | 'completed' | 'failed' | 'timeout';
export type TaskType = 'skill_install' | 'skill_uninstall' | string;

export interface AgentTask {
  taskId: string;
  nodeId: string;
  type: TaskType;
  command: string;
  skillId: string;
  skillName: string;
  status: TaskStatus;
  timeoutMs: number;
  resultCode?: number | null;
  resultStdout?: string | null;
  resultStderr?: string | null;
  queuedAt: string;
  dispatchedAt?: string | null;
  completedAt?: string | null;
}

/** Agent 心跳上报的任务执行结果 */
export interface TaskResult {
  taskId: string;
  code: number;
  stdout: string;
  stderr: string;
}

// ═══════════════════════════════════════
//  技能命令策略
// ═══════════════════════════════════════

export interface SkillCommandContext {
  skillId: string;
  slug?: string;
  repo?: string;
  source: string;
  name?: string;
}

export interface SkillInstallResult {
  command?: string;
  skip?: boolean;
  message?: string;
  error?: boolean;
}

// ═══════════════════════════════════════
//  认证 Token 解析
// ═══════════════════════════════════════

export type TokenSource = 'jwt' | 'apiToken' | 'adminToken';

export interface TokenResult {
  valid: boolean;
  source?: TokenSource;
  userId?: string;
  username?: string;
  role?: string;
}

// ═══════════════════════════════════════
//  技能注册表 (skills 表)
// ═══════════════════════════════════════

export interface SkillRecord {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  category: string;
  icon: string;
  iconGradient: string;
  rating: number;
  installs: number;
  source: string;
  slug: string;
  installType: string;
  skillContent: string;
  isBuiltin: number;
  createdAt: string | null;
  updatedAt: string | null;
}

// ═══════════════════════════════════════
//  审计日志 (audit_logs 表)
// ═══════════════════════════════════════

export interface AuditLogEntry {
  id?: number;
  timestamp: string;
  userId: string;
  username: string;
  action: string;
  resource: string;
  method: string;
  path: string;
  ip: string;
  details: string;
}

// ═══════════════════════════════════════
//  字段校验器（key-manager FIELD_VALIDATORS）
// ═══════════════════════════════════════

export interface FieldValidationResult {
  value: unknown;
  error?: string;
  code?: string;
}

export type FieldValidator = (raw: unknown, nodeId: string, store: INodeStore) => FieldValidationResult;

// ═══════════════════════════════════════
//  NodeStore 接口（简化版）
// ═══════════════════════════════════════

/** NodeStore 最简接口 — 供消费方使用而非直接访问 db */
export interface INodeStore {
  db: unknown; // better-sqlite3 Database 实例
  findById(id: string): NodeRecord | undefined;
  findByStatus(status: NodeStatus): NodeRecord[];
  all(): NodeRecord[];
  count(): { cnt: number };
  countByStatus(status: NodeStatus): { cnt: number };
  insert(node: Partial<NodeRecord>): void;
  update(id: string, fields: Partial<NodeRecord>): void;
  isTunAddrTaken(ip: string, excludeId?: string): NodeRecord | undefined;
  insertUser(user: Partial<UserRecord>): void;
  userCount(): number;
  _stmts: Record<string, { run: (...args: unknown[]) => void; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] }>;
}

