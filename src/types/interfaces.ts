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
  core: any; // GNB 核心状态（结构不定）
  nodes: PeerNode[];
  addresses: any[];
  sysInfo: SysInfo;
  openclaw: any | null;
  error: any | null;
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
  [key: string]: any;
}
