/**
 * Node port lease allocator.
 *
 * One lease table owns socket protocol, bind scope and port. A node+port
 * transaction range lock protects overlap checks; the unique key protects exact
 * bindings. Redis locks reduce contention and never establish ownership.
 * Ingress and egress share socket namespaces on a node, released rows
 * are revived so ports remain reusable, and callers must pass legacy/runtime
 * reservations that are not represented by a lease row.
 *
 * Allocation does not probe the node OS; bind failures are reported by the Agent
 * and reconciled through the normal runtime path.
 */
import { db } from "../db.ts";
import { redis, RedisKeys } from "../redis.ts";
import { nodeScope } from "../tenant-scope.ts";
import { bindScopesOverlap, leaseProtocol, normalizeBindScope, protocolsOverlap, type LeaseProtocol } from "../integrations/forwardx/bind-scope.ts";
import { parseLinkPlacements } from "./node-state-report.ts";

/* ================================================================== */
/* 常量                                                                 */
/* ================================================================== */

/**
 * 端口黑名单：平台基础设施端口 + 公开约定端口，永不分给隧道。
 *
 * 22 ssh · 80/443 http(s) · 3306 mysql · 5432 postgres · 6379 redis ·
 * 27017 mongodb · 9090/9191 监控导出器（prometheus / node-exporter）。
 * 这些端口被隧道占用会直接搞掉面板/DB/缓存的连通性，属于配置错误，不是可选项。
 */
export const PORT_BLACKLIST: readonly number[] = [22, 80, 443, 3306, 5432, 6379, 27017, 9090, 9191];

/** 端口合法管理区间（与 RFC 6335 的系统/动态区间口径一致）。 */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/** NX 抢占锁 TTL（秒）：覆盖「拿锁 → 写 DB → 放锁」的短事务。 */
export const DEFAULT_LOCK_TTL_S = 10;

/**
 * 预分配租约（`tunnel_id IS NULL`）的默认有效期（秒）。
 *
 * 为什么必须有默认值：`tunnel_id` 是 `ON DELETE SET NULL` 的软外键——
 * 删隧道会把租约指针置空而不是删行。若预分配允许 `expires_at = NULL`，
 * {@link reconcileLeases} 就无法把「活着的新建中预分配」与「隧道已删、
 * 指针被置空后留下的孤儿」区分开，孤儿会永久占着端口。给它一个有限 TTL
 * 让 reconcile 总能回收（见 {@link ORPHAN_RULES}）。
 */
export const PREALLOC_TTL_S = 15 * 60;

/**
 * 单个 `acquirePort` 最多尝试的候选端口数。
 *
 * **安全上限，不是分配策略**：候选集已过黑名单 + DB active 租约 + 调用方
 * reservedPorts 三重过滤，正常路径第一个候选就命中。只有「拿锁之外的真实
 * 并发竞态」才会走到第二、第三个。设上限是防止病态区间（例如区间里大量
 * released 行互相 revive 竞争）把调用拖成上千次 Redis/DB 往返。
 */
const MAX_ATTEMPTS = 64;

/** 租约状态（`status` 列是 VARCHAR(20)，这里把字面量收敛成单一来源）。 */
export const LEASE_STATUS = {
  active: "active",
  released: "released",
} as const;

/** {@link LEASE_STATUS} 的取值类型。 */
export type LeaseStatus = (typeof LEASE_STATUS)[keyof typeof LEASE_STATUS];

/* ================================================================== */
/* 类型                                                                 */
/* ================================================================== */

/** 端口方向（与 Prisma `LeaseType` 对齐，但服务层不依赖 generated 类型）。 */
export type LeaseDirection = "ingress" | "egress";

/** 分配请求。 */
/** Agent 守卫里的一个占用：端口 + 持有它的 runtime id（老 Agent 可能不报 id）。 */
export interface AgentPortHolder {
  port: number;
  runtime_id?: string | null;
  protocol?: unknown;
  bind_scope?: unknown;
  /** Closed placement identity, rather than a business Tunnel runtime ID. */
  link_id?: number;
  node_id?: number;
  lease_type?: LeaseDirection;
  owner_ready?: boolean;
  /** A numeric used_ports summary, never an explicit unowned socket claim. */
  aggregate?: boolean;
}

export type PortReservation = number | AgentPortHolder;

export interface AcquirePortInput {
  /** 节点主键（`Node.id`，即 `node_port_lease.node_id` 的外键值）。 */
  nodeId: number;
  /** 方向；**不构成物理隔离**，只是审计/排障元数据（见文件头）。 */
  leaseType: LeaseDirection;
  /**
   * 调用方指定的端口（user-specified port）。
   * 非空 → 必须走与自动分配**完全相同**的规则（黑名单、区间、唯一性、
   * DIRECT 预留），只是候选集退化为这一个端口；不允许「用户指定就跳过校验」。
   */
  preferredPort?: number | null;
  /** 占用方隧道；NULL = 预分配（`reconcile` 的回收对象之一）。 */
  tunnelId?: number | null;
  /** Independent Link owner; never represented by a fabricated tunnel ID. */
  linkId?: number | null;
  /** Omitted acquisition protocol defaults to TCP; explicit unknown facts reserve both. */
  protocol?: string | null;
  bindScope?: string | null;
  /**
   * 该节点上已被占用的端口（调用方提供，通常是同节点存量 DIRECT 隧道的
   * `listen_port`）。这些端口不参与候选，DB 里也查不到它们——legacy 路径不写
   * 租约行（见文件头「legacy DIRECT 端口不可被抢占」）。
   */
  reservedPorts?: Iterable<PortReservation | null | undefined>;
  /**
   * 租约过期时间。NULL = 不自动过期（显式释放）。
   * 预分配未传时按 {@link PREALLOC_TTL_S} 兜底（见该常量注释）。
   */
  expiresAt?: Date | null;
  /**
   * 本次申请**所属隧道**自己的 runtime id（`tunex-<tunnelId>-<方向>`）。
   *
   * 这些 runtime 占着某个端口不代表"别人占用"：把 Forward 的 listen_port 改成它当前
   * 正在使用的端口、或在失败后重试同一端口，都是合法且必须成功的编辑。不声明就会自冲突。
   */
  ownRuntimeIds?: readonly string[];
  /** 依赖注入接缝（测试替身）；未传则进程级默认的 db/redis 单例。 */
  deps?: PortPoolDeps;
}

/** 分配结果。 */
export interface AcquirePortResult {
  /** 分配到的端口。`ok=false` 时无意义。 */
  port: number;
  /** 租约主键（{@link releaseLease} 用）。 */
  leaseId: number;
  leaseType: LeaseDirection;
  tunnelId: number | null;
  linkId: number | null;
  protocol: LeaseProtocol;
  bindScope: string;
  /** 该端口**是否曾**被释放过（revive 路径 = true；全新 create = false）。 */
  reused: boolean;
}

/** `acquirePort` 的可预期失败原因（调用方据此产出可解释的 error，而非笼统 500）。 */
export type AcquireFailureCode =
  /** 节点不存在。 */
  | "node_not_found"
  /** 节点未配置 `port_range_min/max`：拒绝在未配置区间上分配。 */
  | "node_range_unset"
  /** 节点区间本身不合法（min>max 或越界）。 */
  | "node_range_invalid"
  /** 端口不是 1..65535 的整数（user-specified 脏值）。 */
  | "port_out_of_range"
  /** 端口命中黑名单（含 user-specified 指定黑名单端口）。 */
  | "port_blacklisted"
  /** user-specified 端口落在节点区间外。 */
  | "port_outside_node_range"
  /** 端口已被占用（DB 唯一键、active 租约，或调用方 reservedPorts）。 */
  | "port_taken"
  /** 区间内所有端口都不可用（三重过滤后耗尽）。 */
  | "no_available_port"
  | "unsupported_protocol";

/** `acquirePort` 的返回值（不抛「端口被占」这类可预期失败）。 */
export type AcquirePortOutcome =
  | { ok: true; result: AcquirePortResult }
  | { ok: false; code: AcquireFailureCode; port?: number };

/** {@link reconcileLeases} 的回收统计。 */
export interface ReconcileResult {
  /** 悬空隧道租约数（`tunnel_id` 指向不存在的 Tunnel）。 */
  releasedDanglingTunnel: number;
  /** 过期租约数（预分配 TTL 已过）。 */
  releasedExpired: number;
}

/* ================================================================== */
/* 纯函数（无 IO，可离线单测）                                           */
/* ================================================================== */

/** 端口号是否在合法管理区间内（1..65535 整数）。 */
export function isValidPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

/** 端口是否命中黑名单。 */
export function isBlacklistedPort(port: number): boolean {
  return PORT_BLACKLIST.includes(port);
}

/**
 * 解析节点端口区间。
 *
 * 未配置（任一端点为 null）→ `{ kind: "unset" }`：**必须拒绝分配**，不能回落到
 * 节点组 `port_range`（后者是 legacy DIRECT 整组下发用的，不是 per-node 所有权，
 * 见 schema 里 `port_range_min` 的注释）。
 */
export function resolveNodeRange(
  range: { min: number | null; max: number | null } | null | undefined,
): { kind: "unset" } | { kind: "invalid" } | { kind: "ok"; min: number; max: number } {
  const min = range?.min;
  const max = range?.max;
  if (min === null || min === undefined || max === null || max === undefined) {
    return { kind: "unset" };
  }
  if (!isValidPort(min) || !isValidPort(max) || min > max) return { kind: "invalid" };
  return { kind: "ok", min, max };
}

/**
 * 把节点区间展开为**升序去重**的可用端口表（黑名单已剔除）。
 *
 * 展开上限 {@link MAX_PORT}-{@link MIN_PORT}+1 已经由区间本身封住，因此不存在
 * `1-65535` 级别的内存放大（legacy 分配器需要显式 MAX_EXPAND，因为它接受任意
 * 区段串；这里区间来自两个整数列）。
 */
export function expandAvailablePorts(range: { min: number; max: number }): number[] {
  const out: number[] = [];
  for (let p = Math.max(MIN_PORT, range.min); p <= Math.min(MAX_PORT, range.max); p++) {
    if (!isBlacklistedPort(p)) out.push(p);
  }
  return out;
}

/**
 * 生成候选端口（升序）。
 *
 * user-specified port 与 auto port 走**同一函数**：指定端口时候选集退化为
 * `[port]`，随后的黑名单/区间/唯一性校验完全一致。这是 §7.6「user-specified
 * port 与 auto port 走同一规则」的落点——不可能出现「指定端口跳过某项校验」。
 */
export function portCandidates(
  range: { min: number; max: number },
  preferred?: number | null,
): number[] {
  if (preferred !== undefined && preferred !== null) return [preferred];
  return expandAvailablePorts(range);
}

/** Same node and port conflict only when socket protocol and bind scope overlap. */
export function sameLeaseTarget(
  a: { node_id: number; port: number; protocol?: unknown; bind_scope?: unknown },
  b: { node_id: number; port: number; protocol?: unknown; bind_scope?: unknown },
): boolean {
  return a.node_id === b.node_id && a.port === b.port &&
    protocolsOverlap(a.protocol, b.protocol) && bindScopesOverlap(a.bind_scope, b.bind_scope);
}

/* ================================================================== */
/* 依赖注入（便于测试替身，见 portPool.test.ts）                          */
/* ================================================================== */

/** 本模块需要的 Redis 最小接口（`ioredis` 实例满足之）。 */
export interface PortPoolRedis {
  set(key: string, value: string, ...rest: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  scan(cursor: number | string, ...rest: unknown[]): Promise<unknown>;
}

/** 本模块需要的 Prisma 最小接口（`db` 满足之；测试用内存替身）。 */
export interface PortPoolTransaction {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
  node: {
    findUnique(args: unknown): Promise<unknown>;
  };
  tunnel: {
    findUnique(args: unknown): Promise<unknown>;
  };
  nodePortLease: {
    create(args: unknown): Promise<unknown>;
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
}

export interface PortPoolDb extends Omit<PortPoolTransaction, "$queryRawUnsafe"> {
  $transaction<T>(fn: (tx: PortPoolTransaction) => Promise<T>, options?: { isolationLevel: "Serializable" }): Promise<T>;
}

export interface PortPoolDeps {
  db?: PortPoolDb;
  redis?: PortPoolRedis;
  /** 默认 {@link DEFAULT_LOCK_TTL_S}。 */
  lockTtlS?: number;
  /**
   * 该节点**自己上报**的占用端口（Agent 的端口守卫视图），带持有者 runtime id。
   *
   * 为什么分配器必须看它：端口归属有两个事实来源 —— 面板的 `node_port_lease`（分配器读的）
   * 与 Agent 的 `usedPort` 守卫（runtime 真的在听哪个端口）。两者短期不一致是**正常**的
   * （Remove 之后监听还在关闭、失败创建的残留、守卫漂移），但面板按 DB 发放的后果是
   * Agent 正确地拒绝 apply，而症状离原因很远：一条路由永远建不起来，日志里只有一个
   * `*_apply_rejected`。把 Agent 的事实也算作占用，等于让分配器**先问一句**再发端口。
   *
   * **必须带上 runtime id**：否则会误伤"这条隧道自己已经持有的端口"——把一条 Forward 的
   * listen_port 改成它**当前正在用**的那个端口（幂等编辑、失败重试、还原夹具）时，
   * 分配器会把它判成"别人占用"而拒绝，症状是自冲突（实测：门禁 S7 还原端口 502
   * `port_taken`，而那个端口正是这条隧道自己的 runtime 在听）。调用方通过
   * {@link AcquirePortInput.ownRuntimeIds} 声明"哪些 runtime 属于本次申请的隧道"。
   *
   * 注入是为了可测（离线单测传数组），默认实现读 `node_state_report.tunnels`。
   */
  agentUsedPorts?: (nodeId: number) => Promise<readonly AgentPortHolder[]>;
}

/** 进程级默认依赖（路由/编排器直接用）。 */
/** Keep native owner facts and unowned draining/external facts. Missing protocol reserves both. */
interface AgentPortReport {
  used_ports?: unknown;
  tunnels?: unknown;
  link_placements?: unknown;
}

export function agentPortHoldersFromReport(row: AgentPortReport | null): AgentPortHolder[] {
  const out: AgentPortHolder[] = [];
  if (Array.isArray(row?.tunnels)) {
    for (const value of row.tunnels) {
      if (value === null || typeof value !== "object") continue;
      const rec = value as Record<string, unknown>;
      const id = typeof rec.id === "string" ? rec.id : null;
      const mode = typeof rec.mode === "string" ? rec.mode.toUpperCase() : "";
      const keys = mode === "EGRESS" ? ["egress_port"] : mode === "DIRECT" || mode === "RELAY" ? ["ingress_port"] : ["ingress_port", "egress_port"];
      for (const key of keys) {
        const port = Number(rec[key]);
        if (isValidPort(port)) out.push({ port, runtime_id: id, protocol: rec.protocol, bind_scope: rec.listen_host });
      }
    }
  }
  const links = parseLinkPlacements(row?.link_placements);
  if (links.ok) {
    for (const placement of links.placements ?? []) {
      const ownerReady = placement.ready && (placement.state === "ready" || placement.state === "rolled_back") &&
        Date.parse(placement.lease_expires_at) > Date.now();
      for (const binding of placement.ports) {
        out.push({ port: binding.port, protocol: binding.protocol, bind_scope: binding.host,
          runtime_id: placement.id, link_id: placement.link_id, node_id: placement.node_id,
          lease_type: placement.role, owner_ready: ownerReady });
      }
    }
  }
  const append = (value: unknown, protocol?: unknown) => {
    if (value !== null && typeof value === "object") {
      const rec = value as Record<string, unknown>;
      const port = Number(rec.port);
      if (isValidPort(port)) out.push({ port, runtime_id: typeof rec.runtime_id === "string" ? rec.runtime_id : null, protocol: rec.protocol ?? protocol, bind_scope: rec.bind_scope });
    } else {
      const port = Number(value);
      if (isValidPort(port)) out.push({ port, runtime_id: null, protocol, aggregate: true });
    }
  };
  if (Array.isArray(row?.used_ports)) {
    for (const value of row.used_ports) append(value);
  } else if (row?.used_ports && typeof row.used_ports === "object") {
    for (const [protocol, values] of Object.entries(row.used_ports)) {
      if (Array.isArray(values)) for (const value of values) append(value, protocol);
      else if (values && typeof values === "object") {
        for (const [port, held] of Object.entries(values)) if (held) append(port, protocol);
      }
    }
  }
  return out;
}

async function defaultAgentUsedPorts(nodeId: number): Promise<readonly AgentPortHolder[]> {
  try {
    const row = (await (db as unknown as {
      nodeStateReport: { findUnique(args: unknown): Promise<unknown> };
    }).nodeStateReport.findUnique({
      where: { node_id: nodeId },
      select: { used_ports: true, tunnels: true, link_placements: true },
    })) as AgentPortReport | null;

    return agentPortHoldersFromReport(row);
  } catch (e) {
    console.warn("[portPool] agent used_ports unavailable:", e instanceof Error ? e.message : e);
    return [];
  }
}

const defaultDeps: Required<PortPoolDeps> = {
  db: db as unknown as PortPoolDb,
  redis: redis as unknown as PortPoolRedis,
  lockTtlS: DEFAULT_LOCK_TTL_S,
  agentUsedPorts: defaultAgentUsedPorts,
};

/** 合并调用方注入的依赖（只注入需要的部分，其余走默认单例）。 */
function deps(over: PortPoolDeps | undefined): Required<PortPoolDeps> {
  return {
    db: over?.db ?? defaultDeps.db,
    redis: over?.redis ?? defaultDeps.redis,
    lockTtlS: over?.lockTtlS ?? defaultDeps.lockTtlS,
    agentUsedPorts: over?.agentUsedPorts ?? defaultDeps.agentUsedPorts,
  };
}

/* ================================================================== */
/* Redis NX 抢占锁                                                      */
/* ================================================================== */

/**
 * 抢占锁 key（`ws:<scope>:node_port_lease:lock:<nodeId>:<port>`）。
 *
 * 统一走 {@link RedisKeys.portLeaseLock}（其实现 `portLeaseLockKey` 在
 * `tenant-scope.ts`，是 key 形态的单一真相源）。不在本文件拼字符串——
 * 裸名 key 正是 TEN-02 之前四种命名风格互相覆盖的根源。
 */
export function leaseLockKey(scope: number, nodeId: number, port: number): string {
  return RedisKeys.portLeaseLock(scope, String(nodeId), port);
}

/**
 * 抢占锁。
 *
 * `SET key value EX ttl NX` 的返回语义：命中返回 `"OK"`，已存在返回 `null`。
 * Redis 异常时**返回 false 而不是抛错**——锁只是优化（见文件头第 1 条），
 * Redis 挂了照样能靠 DB 唯一约束完成分配。
 */
async function tryLock(
  r: PortPoolRedis,
  scope: number,
  nodeId: number,
  port: number,
  ttlS: number,
): Promise<boolean> {
  try {
    const res = await r.set(leaseLockKey(scope, nodeId, port), "1", "EX", ttlS, "NX");
    return res === "OK";
  } catch {
    return false;
  }
}

/** 放锁（幂等；异常吞掉——TTL 会兜底，放锁失败不阻塞调用方）。 */
async function unlock(
  r: PortPoolRedis,
  scope: number,
  nodeId: number,
  port: number,
): Promise<void> {
  try {
    await r.del(leaseLockKey(scope, nodeId, port));
  } catch {
    /* ignore */
  }
}

/* ================================================================== */
/* 节点解析                                                            */
/* ================================================================== */

/** `acquire` 需要的节点投影（scope + 区间）。 */
interface NodeRow {
  id: number;
  port_range_min: number | null;
  port_range_max: number | null;
  node_group?: { workspace_id: number | null } | null;
}

/** 解析出的分配上下文。 */
interface LeaseContext {
  scope: number;
  range: { min: number; max: number };
}

/**
 * 读节点并解析分配区间。拿不到 / 区间不可用 → 返回失败码（**不抛**，
 * 让调用方用统一的 {@link AcquirePortOutcome} 分支处理）。
 *
 * scope 经 {@link nodeScope} 派生（唯一入口）：`NodePortLease` 没有
 * workspace_id 列，归属沿 `Node → node_group → workspace_id` 单向上查。
 */
async function resolveContext(
  pd: PortPoolDb,
  nodeId: number,
): Promise<{ ok: true; ctx: LeaseContext } | { ok: false; code: AcquireFailureCode }> {
  const node = (await pd.node.findUnique({
    where: { id: nodeId },
    select: {
      id: true,
      port_range_min: true,
      port_range_max: true,
      node_group: { select: { workspace_id: true } },
    },
  })) as NodeRow | null;

  if (!node) return { ok: false, code: "node_not_found" };

  const parsed = resolveNodeRange({ min: node.port_range_min, max: node.port_range_max });
  if (parsed.kind === "unset") return { ok: false, code: "node_range_unset" };
  if (parsed.kind === "invalid") return { ok: false, code: "node_range_invalid" };

  return {
    ok: true,
    ctx: { scope: nodeScope(node), range: { min: parsed.min, max: parsed.max } },
  };
}

/* ================================================================== */
/* acquire / release / holder                                          */
/* ================================================================== */

/** Exact-binding unique conflict; overlap safety comes from the node+port transaction lock. */
export function isUniqueConflict(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "P2002";
}

/** Prisma 记录不存在错误判定（`update` 目标已被并发回收）。 */
function isNotFound(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "P2025";
}

/** DB 行形状（`select` / `create` / `update` 出来的最小投影）。 */
interface LeaseRow {
  id: number;
  node_id: number;
  port: number;
  lease_type: LeaseDirection;
  tunnel_id: number | null;
  link_id: number | null;
  protocol: string;
  bind_scope: string;
  status: LeaseStatus;
  expires_at: Date | null;
}

/** Return the durable owner and canonical binding from the single lease row. */
function leaseResult(row: LeaseRow, reused: boolean): AcquirePortResult {
  return {
    port: row.port, leaseId: row.id, leaseType: row.lease_type,
    tunnelId: row.tunnel_id ?? null, linkId: row.link_id ?? null,
    protocol: leaseProtocol(row.protocol), bindScope: normalizeBindScope(row.bind_scope), reused,
  };
}

function sameOwner(row: LeaseRow, input: AcquirePortInput): boolean {
  if (row.lease_type !== input.leaseType) return false;
  if (input.linkId != null) return row.link_id === input.linkId && row.tunnel_id == null;
  return input.tunnelId != null && row.tunnel_id === input.tunnelId && row.link_id == null;
}

function bindingOverlaps(row: { protocol?: unknown; bind_scope?: unknown }, protocol: unknown, bindScope: string): boolean {
  return protocolsOverlap(row.protocol, protocol) && bindScopesOverlap(row.bind_scope, bindScope);
}

export async function acquirePort(
  input: AcquirePortInput,
  inject?: PortPoolDeps,
): Promise<AcquirePortOutcome> {
  // Native composite owns one coarse, conservative lease. Shared FXP still
  // acquires explicit child bindings; a Link must not take a composite lease.
  if (typeof input.protocol === "string" && input.protocol.trim().toLowerCase() === "both" &&
      (input.tunnelId == null || input.linkId != null)) {
    return { ok: false, code: "unsupported_protocol" };
  }
  if (input.linkId != null && input.tunnelId != null) throw new Error("port lease has exactly one business owner: linkId or tunnelId");
  const protocol = input.protocol === undefined ? "tcp" : leaseProtocol(input.protocol);
  const bindScope = normalizeBindScope(input.bindScope);
  const { db: pdb, redis: rdb, lockTtlS, agentUsedPorts } = deps(input.deps ?? inject);
  const context = await resolveContext(pdb, input.nodeId);
  if (!context.ok) return { ok: false, code: context.code };
  const { scope, range } = context.ctx;
  const isPreferred = input.preferredPort != null;
  const ownRuntimeIds = new Set(input.ownRuntimeIds ?? []);
  const reservations: AgentPortHolder[] = [];
  for (const value of input.reservedPorts ?? []) {
    if (typeof value === "number") reservations.push({ port: value });
    else if (value) reservations.push(value);
  }
  const agentFacts = await agentUsedPorts(input.nodeId);
  const activeRows = await pdb.nodePortLease.findMany({
    where: { node_id: input.nodeId, status: LEASE_STATUS.active },
  }) as LeaseRow[];
  // Only a closed, ready placement with this exact binding can explain its own
  // aggregate used_ports entry. A runtime ID alone cannot exempt another Link,
  // another scope, or a failed/updating placement. A protocol-less aggregate is
  // explained only for the requested known lane; all other requests still see it.
  const ownedLinkFacts = new Set(agentFacts.filter((holder) => input.linkId != null &&
    holder.link_id === input.linkId && holder.node_id === input.nodeId && holder.lease_type === input.leaseType &&
    holder.owner_ready === true && protocol !== "unknown" && leaseProtocol(holder.protocol) === protocol &&
    typeof holder.bind_scope === "string" && normalizeBindScope(holder.bind_scope) === bindScope));
  const ownedLinkPorts = new Set([...ownedLinkFacts].map((holder) => holder.port));
  // Never narrow an active composite lease before the old UDP/TCP lane has
  // drained. A coarse reservation remains safe across both -> single changes.
  const reusableNative = (row: LeaseRow) => input.tunnelId != null && sameOwner(row, input) &&
    row.lease_type === input.leaseType && normalizeBindScope(row.bind_scope) === bindScope &&
    (row.protocol === protocol || row.protocol === "unknown" || protocol === "unknown" && input.protocol === "both");
  const ownsBinding = (port: number, rows: readonly LeaseRow[]) => rows.some((row) =>
    row.node_id === input.nodeId && row.port === port && row.status === LEASE_STATUS.active && sameOwner(row, input) &&
    row.protocol === protocol && normalizeBindScope(row.bind_scope) === bindScope);
  const reserved = (port: number, rows: readonly LeaseRow[] = activeRows) => {
    if (reservations.some((holder) => holder.port === port && bindingOverlaps(holder, protocol, bindScope))) return true;
    const ownsLinkBinding = ownedLinkPorts.has(port) && ownsBinding(port, rows);
    return agentFacts.some((holder) => {
      if (holder.port !== port || !bindingOverlaps(holder, protocol, bindScope)) return false;
      if (holder.link_id != null) return !(ownsLinkBinding && ownedLinkFacts.has(holder));
      if (holder.runtime_id && ownRuntimeIds.has(holder.runtime_id)) return false;
      // Explicit unowned facts remain reservations, including draining work at
      // this same port. Never infer ownership from another port or from DB alone.
      return !(holder.aggregate === true && !holder.runtime_id && ownsLinkBinding);
    });
  };
  const ownedLink = input.linkId != null && !isPreferred
    ? activeRows.find((row) => sameOwner(row, input) && row.protocol === protocol && normalizeBindScope(row.bind_scope) === bindScope)
    : undefined;
  const ownedNative = input.tunnelId != null && !isPreferred
    ? activeRows.find((row) => reusableNative(row) && (input.protocol === "both" || row.protocol === "unknown"))
    : undefined;
  const ownedAutomatic = ownedLink ?? ownedNative;
  const blocked = (port: number) => reserved(port) || activeRows.some((row) =>
    row.port === port && bindingOverlaps(row, protocol, bindScope) &&
    !((isPreferred || ownedAutomatic === row) && sameOwner(row, input) &&
      (row.protocol === protocol || reusableNative(row)) && normalizeBindScope(row.bind_scope) === bindScope));
  const candidates = ownedAutomatic ? [ownedAutomatic.port] : portCandidates(range, input.preferredPort ?? null);
  const attempts = isPreferred || ownedAutomatic ? candidates : candidates.filter((port) => !blocked(port)).slice(0, MAX_ATTEMPTS);
  const expiresAt = input.linkId != null || input.tunnelId != null
    ? (input.expiresAt ?? null)
    : (input.expiresAt ?? new Date(Date.now() + PREALLOC_TTL_S * 1000));

  for (const port of attempts) {
    if (!isValidPort(port) || isBlacklistedPort(port) || port < range.min || port > range.max) {
      if (!isPreferred) continue;
      return { ok: false, port, code: !isValidPort(port) ? "port_out_of_range" : isBlacklistedPort(port) ? "port_blacklisted" : "port_outside_node_range" };
    }
    if (blocked(port)) {
      if (isPreferred) return { ok: false, code: "port_taken", port };
      continue;
    }
    const gotLock = await tryLock(rdb, scope, input.nodeId, port, lockTtlS);
    try {
      // Exact-binding uniqueness cannot protect wildcard/concrete overlap.
      // Lock the node+port index range, including an empty gap, in MySQL. With
      // Serializable, concurrent empty-gap inserts deadlock rather than admit
      // overlapping scopes; the victim retries and sees the committed owner.
      for (let retry = 0; retry < 4; retry++) {
        try {
          const outcome = await pdb.$transaction(async (tx) => {
            await tx.$queryRawUnsafe(
              "SELECT id FROM node_port_lease FORCE INDEX (node_port_lease_node_id_port_idx) WHERE node_id = ? AND port = ? FOR UPDATE",
              input.nodeId, port,
            );
            const rows = await tx.nodePortLease.findMany({ where: { node_id: input.nodeId, port } }) as LeaseRow[];
            const current = rows.filter((row) => row.status === LEASE_STATUS.active);
            const owned = current.find((row) => sameOwner(row, input) &&
              (row.protocol === protocol || reusableNative(row)) && normalizeBindScope(row.bind_scope) === bindScope);
            if (current.some((row) => row !== owned && bindingOverlaps(row, protocol, bindScope))) return null;
            if (reserved(port, current)) return null;
            if (owned) {
              if (protocol === "unknown" && owned.protocol !== "unknown" && input.protocol === "both") {
                const advanced = await tx.nodePortLease.updateMany({ where: { id: owned.id, status: LEASE_STATUS.active,
                  protocol: owned.protocol, tunnel_id: input.tunnelId, link_id: null }, data: { protocol: "unknown" } }) as { count: number };
                if (!advanced.count) return null;
                return leaseResult({ ...owned, protocol: "unknown" }, true);
              }
              return leaseResult(owned, true);
            }
            const data = {
              node_id: input.nodeId, port, protocol, bind_scope: bindScope,
              lease_type: input.leaseType, tunnel_id: input.tunnelId ?? null,
              link_id: input.linkId ?? null, status: LEASE_STATUS.active,
              expires_at: expiresAt, created_at: new Date(),
            };
            const released = rows.find((row) => row.status === LEASE_STATUS.released && row.protocol === protocol && normalizeBindScope(row.bind_scope) === bindScope);
            if (released) {
              const revived = await tx.nodePortLease.updateMany({ where: { id: released.id, status: LEASE_STATUS.released }, data }) as { count: number };
              if (!revived.count) return null;
              const row = await tx.nodePortLease.findUnique({ where: { id: released.id } }) as LeaseRow;
              return leaseResult(row, true);
            }
            return leaseResult(await tx.nodePortLease.create({ data }) as LeaseRow, false);
          }, { isolationLevel: "Serializable" });
          if (outcome) return { ok: true, result: outcome };
          break;
        } catch (error) {
          const info = error as { code?: string; meta?: { code?: string }; message?: string };
          const retryable = info.code === "P2034" || isUniqueConflict(error) ||
            info.meta?.code === "1213" || info.meta?.code === "1205" || /deadlock|lock wait timeout/i.test(info.message ?? "");
          if (!retryable) throw error;
          if (retry === 3) break;
        }
      }
    } finally {
      if (gotLock) await unlock(rdb, scope, input.nodeId, port);
    }
  }
  return { ok: false, code: isPreferred ? "port_taken" : "no_available_port", ...(isPreferred ? { port: input.preferredPort! } : {}) };
}

/** Soft release by leaseId, tunnelId, linkId, or nodeId (in that order). Link retirement requires every owner process to confirm stop. */
export async function releaseLease(
  args: { leaseId?: number; tunnelId?: number; linkId?: number; nodeId?: number },
  inject?: PortPoolDeps,
): Promise<boolean> {
  const { db: pdb } = deps(inject);

  if (args.leaseId !== undefined) {
    try {
      const updated = (await pdb.nodePortLease.update({
        where: { id: args.leaseId },
        data: { status: LEASE_STATUS.released },
      })) as LeaseRow;
      return updated.id === args.leaseId;
    } catch (e) {
      if (isNotFound(e)) return false; // 已被回收
      throw e;
    }
  }

  if (args.tunnelId !== undefined) {
    const res = (await pdb.nodePortLease.updateMany({
      where: { tunnel_id: args.tunnelId, status: LEASE_STATUS.active },
      data: { status: LEASE_STATUS.released },
    })) as { count: number };
    return res.count > 0;
  }

  // The Link runner calls this only after all owner processes confirm Stop.
  if (args.linkId !== undefined) {
    const res = await pdb.nodePortLease.updateMany({
      where: { link_id: args.linkId, status: LEASE_STATUS.active },
      data: { status: LEASE_STATUS.released },
    }) as { count: number };
    return res.count > 0;
  }

  if (args.nodeId !== undefined) {
    const res = (await pdb.nodePortLease.updateMany({
      where: { node_id: args.nodeId, status: LEASE_STATUS.active },
      data: { status: LEASE_STATUS.released },
    })) as { count: number };
    return res.count > 0;
  }

  return false;
}

/**
 * 查询某个端口当前的持有者。
 *
 * **只认 DB 行**：签名里刻意没有 Redis——「锁还在不在」与「端口归谁」是两个
 * 问题，混在一起就会写出「Redis flush 之后把所有端口判成空闲」的 bug
 * （`tenant-scope.ts` 里 `portLeaseLockKey` 的第三条使用约束就是禁这个）。
 */
export async function leaseHolder(
  nodeId: number,
  port: number,
  inject?: PortPoolDeps,
  binding?: { protocol?: string | null; bindScope?: string | null },
): Promise<{
  leaseId: number;
  leaseType: LeaseDirection;
  tunnelId: number | null;
  linkId: number | null;
  protocol: LeaseProtocol;
  bindScope: string;
  status: LeaseStatus;
  expiresAt: Date | null;
} | null> {
  const { db: pdb } = deps(inject);
  const rows = await pdb.nodePortLease.findMany({ where: { node_id: nodeId, port } }) as LeaseRow[];
  const matches = binding
    ? rows.filter((row) => row.protocol === (binding.protocol === undefined ? "tcp" : leaseProtocol(binding.protocol)) && normalizeBindScope(row.bind_scope) === normalizeBindScope(binding.bindScope))
    : rows;
  const active = matches.filter((row) => row.status === LEASE_STATUS.active);
  // A legacy number-only lookup must never silently select one of two owners.
  const eligible = active.length ? active : matches;
  if (eligible.length > 1) throw new Error("ambiguous port lease holder: protocol and bindScope are required");
  const row = eligible[0];
  if (!row) return null;
  return {
    leaseId: row.id,
    leaseType: row.lease_type,
    tunnelId: row.tunnel_id,
    linkId: row.link_id ?? null,
    protocol: leaseProtocol(row.protocol),
    bindScope: normalizeBindScope(row.bind_scope),
    status: row.status,
    expiresAt: row.expires_at,
  };
}

/**
 * 查询某节点当前**可用**的端口表（黑名单 + active 租约 + reservedPorts 已剔除）。
 *
 * released 行不占位：schema 保留它们是为了对账，不是为了占位；可用性随时可
 * 通过 `acquirePort` 的 revive 路径拿回。
 */
export async function availablePorts(
  nodeId: number,
  reserved?: Iterable<PortReservation | null | undefined>,
  inject?: PortPoolDeps,
  binding?: { protocol?: string | null; bindScope?: string | null },
): Promise<number[]> {
  const pdb = deps(inject).db;
  const context = await resolveContext(pdb, nodeId);
  if (!context.ok) return [];
  const rows = (await pdb.nodePortLease.findMany({
    where: { node_id: nodeId, status: LEASE_STATUS.active },
  })) as LeaseRow[];
  const protocol = binding?.protocol === undefined ? "tcp" : leaseProtocol(binding.protocol);
  const bindScope = normalizeBindScope(binding?.bindScope);
  const taken = new Set<number>(rows.filter((row) => bindingOverlaps(row, protocol, bindScope)).map((row) => row.port));
  for (const value of reserved ?? []) {
    if (typeof value === "number" && isValidPort(value)) taken.add(value);
    else if (value && typeof value === "object" && bindingOverlaps(value, protocol, bindScope)) taken.add(value.port);
  }
  for (const holder of await deps(inject).agentUsedPorts(nodeId)) {
    if (bindingOverlaps(holder, protocol, bindScope)) taken.add(holder.port);
  }
  return expandAvailablePorts(context.ctx.range).filter((p) => !taken.has(p));
}

/* ================================================================== */
/* reconcile                                                           */
/* ================================================================== */

/**
 * {@link reconcileLeases} 判定「孤儿」的规则（集中一处，测试直接引用）。
 *
 *   A. **悬空隧道**：`tunnel_id` 非空但 Tunnel 已不存在。无条件回收——
 *      「租约活得比隧道久」本身就是异常，不看 expires_at。
 *      （`tunnel_id` 是 `ON DELETE SET NULL` 软外键，删隧道只会把指针打成
 *      NULL，所以这条主要覆盖行被外部清理的形状；语义与 B 不同，故分开计数。）
 *   B. **过期预分配**：`tunnel_id IS NULL` 且 `expires_at` 已过，或为 NULL。
 *      NULL expiry 一并回收：`acquirePort` 给预分配兜底了
 *      {@link PREALLOC_TTL_S}，库里不该存在「没有 expiry 的预分配」。
 *
 * 两类的共同点：**不用 Redis 判定**。锁 key 是否还在，与租约是否孤儿无关。
 * @param now 覆盖当前时间（测试注入），缺省 `new Date()`。
 */
export const ORPHAN_RULES = {
  isExpired(row: { expires_at: Date | null }, now: Date): boolean {
    if (row.expires_at === null) return true;
    return row.expires_at.getTime() < now.getTime();
  },
} as const;

/**
 * 对账：回收**孤儿租约**（orphan lease）。
 *
 * @param options.now    覆盖判定用的当前时间（测试用）。
 * @param options.dryRun 只统计不写（巡检/告警预览）。
 * @param options.deps   依赖注入（测试替身）。
 * @returns 两类孤儿各自的计数。
 */
export async function reconcileLeases(
  options: { dryRun?: boolean; now?: Date; deps?: PortPoolDeps } = {},
): Promise<ReconcileResult> {
  const { db: pdb } = deps(options.deps);
  const now = options.now ?? new Date();

  const active = (await pdb.nodePortLease.findMany({
    where: { status: LEASE_STATUS.active },
    select: { id: true, node_id: true, port: true, tunnel_id: true, link_id: true, expires_at: true },
  })) as LeaseRow[];

  // 有 tunnel_id 的行一次性反查 Tunnel 存在性（批量，N+1 是错的做法）。
  const tunnelIds = [
    ...new Set(active.map((r) => r.tunnel_id).filter((t): t is number => t !== null)),
  ];
  const existing = new Set<number>();
  for (const id of tunnelIds) {
    const row = (await pdb.tunnel.findUnique({
      where: { id },
      select: { id: true },
    })) as { id: number } | null;
    if (row) existing.add(row.id);
  }

  const danglingTunnel: number[] = [];
  const expired: number[] = [];
  for (const row of active) {
    // Link process lifetime is independent of business Tunnel lifetime. Only
    // confirmed runner stop/retirement can release these owner reservations.
    if (row.link_id != null) continue;
    if (row.tunnel_id !== null && !existing.has(row.tunnel_id)) {
      danglingTunnel.push(row.id);
      continue;
    }
    if (row.tunnel_id === null && ORPHAN_RULES.isExpired(row, now)) expired.push(row.id);
  }

  if (!options.dryRun) {
    if (danglingTunnel.length > 0) {
      await pdb.nodePortLease.updateMany({
        where: { id: { in: danglingTunnel } },
        data: { status: LEASE_STATUS.released },
      });
    }
    if (expired.length > 0) {
      await pdb.nodePortLease.updateMany({
        where: { id: { in: expired } },
        data: { status: LEASE_STATUS.released },
      });
    }
  }

  return {
    releasedDanglingTunnel: danglingTunnel.length,
    releasedExpired: expired.length,
  };
}

/* ================================================================== */
/* 锁对账（可选：只清理 Redis 里没有对应 DB 行的残留锁 key）                */
/* ================================================================== */

/**
 * 扫描 Redis 侧残留的抢占锁 key（`RedisKeys.portLeaseLockScan`）。
 *
 * **只做清理，不做判定**：key 存在与否不影响端口所有权（那在 DB）。
 * 锁的 TTL 是 {@link DEFAULT_LOCK_TTL_S}，正常路径绝不会残留；能扫到的都是
 * 「进程在 set 之后、del 之前被 kill」的遗留。删掉它们只是让 keyspace
 * 干净，`acquire` 的正确性从不依赖这一步。
 *
 * @param options.scope  限定租户；不传 = 跨租户全扫。
 * @param options.dryRun 只数不删。
 * @param options.deps   依赖注入（测试替身）。
 * @returns 删除（或 `dryRun` 时发现）的 key 数。
 */
export async function reconcileLeaseLocks(
  options: { scope?: number | null; dryRun?: boolean; deps?: PortPoolDeps } = {},
): Promise<number> {
  const { redis: rdb } = deps(options.deps);
  const pattern = RedisKeys.portLeaseLockScan(options.scope ?? null);

  const keys: string[] = [];
  let cursor: number | string = "0";
  do {
    const [next, batch] = (await rdb.scan(cursor, "MATCH", pattern, "COUNT", 200)) as [string, string[]];
    cursor = next;
    if (Array.isArray(batch)) keys.push(...batch);
  } while (cursor !== "0");

  if (options.dryRun) return keys.length;

  let deleted = 0;
  for (const key of keys) {
    try {
      await rdb.del(key);
      deleted++;
    } catch {
      /* ignore */
    }
  }
  return deleted;
}

/*
 * ── 测试辅助导出 ──
 *
 * 仅断言用（锁 key 形态、唯一冲突判定、物理互斥判定）。业务代码一律走上面的
 * 公开函数，不要从这里拿内部件绕过公开语义。
 */
export const __internals = { leaseLockKey, isUniqueConflict, sameLeaseTarget };
