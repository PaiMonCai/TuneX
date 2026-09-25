/**
 * v3 端口分配器（WP3，DEVELOPMENT.md §7.6）。
 *
 * ── 两层真相：DB 是终审，Redis 只是并发协调 ──
 * 端口**所有权**的唯一真相源是 `node_port_lease` 上的
 * `UNIQUE(node_id, port)`。Redis NX 锁只负责把「同一 (node, port) 的并发分配」
 * 从「每次都打到 DB 唯一约束」降为「通常只打一次」。因此三条硬约束：
 *
 *   1. **抢到锁 ≠ 拿到端口**：`acquire` 在锁内仍走 DB insert，撞 P2002 是
 *      **正常路径**（说明别人已经持有），调用方应继续尝试下一个候选端口，
 *      而不是当成故障。
 *   2. **锁必须有 TTL**：进程在「拿到锁 → 释放锁」之间崩掉，不能让别人
 *      永远分不到这个端口（{@link DEFAULT_LOCK_TTL_S}）。
 *   3. **锁丢了不代表租约失效**：{@link leaseHolder} / {@link reconcileLeases}
 *      只认 DB 行，绝不用「Redis 里没有这个 key」反推「这个端口现在空闲」——
 *      Redis 可以是 fake/被 flush/正在重启。
 *
 * ── ingress 与 egress 共用同一物理 namespace ──
 * `lease_type`（ingress/egress）只是**元数据**，不构成隔离：DB 唯一键是
 * `(node_id, port)`，与方向无关。这正是 schema 注释里「否则 BOTH 节点会用同一
 * 端口同时双绑 ingress/egress」的意思——一个角色为 `both` 的节点，它的入口池与
 * 出口池哪怕在管理端配成两个区间，也共用同一张物理端口表。
 *
 * 本模块不负责校验「区间不重叠」（那是节点配置的职责，见 §7.6「BOTH Node 同
 * port 冲突」），本模块负责的是：**只要两次分配来自同一个 node_id，
 * 无论方向，都必须在物理端口上互斥**。区间重叠在这里表现为 `port_taken`，
 * 由调用方改成可解释的 error，而不是两个 listener 各自 bind 上同一个端口。
 *
 * 反过来说：**不同 node_id 天然隔离**。入口节点 7 拿 19000、出口节点 8 也拿
 * 19000 完全合法——它们是两台物理机。
 *
 * ── legacy DIRECT 端口不可被抢占 ──
 * 存量 DIRECT 隧道仍由 `socket/port-allocator.ts`（legacy）在**入口组**内做
 * 确定性分配，最终落在 `tunnel.listen_port` 上，agent 直接 bind。那条路径没有
 * `node_port_lease` 行，因此**本模块对 DIRECT 端口一无所知**。
 *
 * 这就是 `AcquirePortInput.reservedPorts` 存在的原因：调用方（编排器/建隧道
 * 端点）必须把「同节点现有 DIRECT 隧道的 `listen_port`」灌进来，v3 分配才会
 * 避开它们。否则新分配的 v3 端口会与存量 agent 正在 bind 的端口撞号——而那种
 * 撞号**没有任何 DB 约束兜底**，比 v3 内部撞号危险得多。
 *
 * ── released 行仍占用唯一键（WP1 schema 的既有决定）──
 * `@@unique([node_id, port])` 不带 `status` 过滤，而 `releaseLease` 是**软删除**
 * （`status='released'`，保留行供对账，见 model 注释）。于是「端口用过一次就
 * 永久不能再分」会是一个真实的 bug——长期运行的节点会把区间耗尽。
 *
 * 因此 `acquirePort` 的写入是 **revive-or-create**：先原子地「认领」一条已释放
 * 的行（`updateMany` 带 `status='released'` 守卫，MySQL 行锁保证并发下第二个
 * 调用方看到 0 行），认领不到再 `create`。这样 DB 唯一约束依然是一切的所有权
 * 终审（P2002 = 真被占用），端口本身仍可回收再用。
 *
 * ── 不做什么（明确的边界）──
 *  · 不接路由/HTTP：WP3 只交付服务层 + 单测，WP8 编排器才消费它。
 *  · 不做 agent 实际 bind 探测：端口在 OS 层的可用性由 agent 的
 *    `EADDRINUSE` 反馈，控制面只保证「自己不再重复分配」。
 *  · 不做 Node.role 校验：role 只是能力声明，端口物理互斥与它无关（§7.6
 *    要求 BOTH 节点同 port 冲突，那正是 role 无关的物理互斥）。
 */
import { db } from "../db.ts";
import { redis, RedisKeys } from "../redis.ts";
import { nodeScope } from "../tenant-scope.ts";

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
  /**
   * 该节点上已被占用的端口（调用方提供，通常是同节点存量 DIRECT 隧道的
   * `listen_port`）。这些端口不参与候选，DB 里也查不到它们——legacy 路径不写
   * 租约行（见文件头「legacy DIRECT 端口不可被抢占」）。
   */
  reservedPorts?: Iterable<number | null | undefined>;
  /**
   * 租约过期时间。NULL = 不自动过期（显式释放）。
   * 预分配未传时按 {@link PREALLOC_TTL_S} 兜底（见该常量注释）。
   */
  expiresAt?: Date | null;
  /** 依赖注入接缝（测试替身）；未传则走进程级默认的 db/redis 单例。 */
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
  | "no_available_port";

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

/**
 * 任一端点上的「是否同一台物理机同一端口」判定。
 *
 * `lease_type` **不出现在任何判定里**：physical uniqueness 的语义就是
 * `(node_id, port)`，方向只是标签。写测试时不要期望「ingress 与 egress
 * 各自独立编号」——那正是 §7.6 要禁的 BOTH 双绑。
 */
export function sameLeaseTarget(a: { node_id: number; port: number }, b: { node_id: number; port: number }): boolean {
  return a.node_id === b.node_id && a.port === b.port;
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
export interface PortPoolDb {
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

export interface PortPoolDeps {
  db?: PortPoolDb;
  redis?: PortPoolRedis;
  /** 默认 {@link DEFAULT_LOCK_TTL_S}。 */
  lockTtlS?: number;
}

/** 进程级默认依赖（路由/编排器直接用）。 */
const defaultDeps: Required<PortPoolDeps> = {
  db: db as unknown as PortPoolDb,
  redis: redis as unknown as PortPoolRedis,
  lockTtlS: DEFAULT_LOCK_TTL_S,
};

/** 合并调用方注入的依赖（只注入需要的部分，其余走默认单例）。 */
function deps(over: PortPoolDeps | undefined): Required<PortPoolDeps> {
  return {
    db: over?.db ?? defaultDeps.db,
    redis: over?.redis ?? defaultDeps.redis,
    lockTtlS: over?.lockTtlS ?? defaultDeps.lockTtlS,
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

/** Prisma 唯一冲突错误判定（`UNIQUE(node_id, port)` 撞击 → 换下一个候选端口）。 */
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
  status: LeaseStatus;
  expires_at: Date | null;
}

/**
 * 申请端口租约。
 *
 * 每个候选端口依次尝试（见 {@link MAX_ATTEMPTS}）：
 *   1. 纯函数过滤：黑名单 / 节点区间 / reservedPorts（user-specified 与 auto
 *      共用同一套，`portCandidates` 之后的判定对两者一模一样）；
 *   2. Redis NX 抢占锁（拿不到 → 仍然尝试写 DB，靠唯一约束兜底）；
 *   3. **revive-or-create**：
 *        a. `updateMany({ node_id, port, status: 'released' })` 带守卫地认领
 *           一条已释放的行（端口回收再用的唯一途径，见文件头「released 行」）；
 *        b. 认领不到 → `create`；撞 P2002 = **真被占用**（正常路径）→ 下一个候选；
 *   4. 成功 → 放锁、返回。
 *
 * 第 3 步的顺序（先 revive 后 create）保证「端口从不因为保留 released 行而
 * 永久耗尽」，同时 DB 唯一约束仍是最终真相：并发的两个 acquire 要么一个 revive
 * 成功、另一个看到 0 行后走 create 撞 P2002，要么都 revive 失败、都走 create
 * 而只有一个成功。两条路都收敛到「恰好一个持有者」。
 */
export async function acquirePort(
  input: AcquirePortInput,
  inject?: PortPoolDeps,
): Promise<AcquirePortOutcome> {
  const { db: pdb, redis: rdb, lockTtlS } = deps(input.deps ?? inject);
  const context = await resolveContext(pdb, input.nodeId);
  if (!context.ok) return { ok: false, code: context.code };
  const { scope, range } = context.ctx;

  // 调用方预留（legacy DIRECT 等 DB 里没有行的端口）。
  const reserved = new Set<number>();
  for (const p of input.reservedPorts ?? []) {
    if (isValidPort(p)) reserved.add(p);
  }

  // DB 侧已占用的端口（一次批量查询，避免 N+1；只看 active，released 行不占位）。
  // 同一 Tunnel 以同方向重入自己已经持有的 preferred port 是幂等续用，不是冲突。
  // suspend 只停 runtime、不释放 durable lease，因此 resume 必须能原端口恢复。
  const activeRows = (await pdb.nodePortLease.findMany({
    where: { node_id: input.nodeId, status: LEASE_STATUS.active },
    select: { id: true, port: true, tunnel_id: true, lease_type: true },
  })) as Array<{ id: number; port: number; tunnel_id: number | null; lease_type: LeaseDirection }>;

  const isPreferred = input.preferredPort !== undefined && input.preferredPort !== null;
  if (isPreferred && input.tunnelId !== null && input.tunnelId !== undefined) {
    const held = activeRows.find((row) => row.port === input.preferredPort);
    if (held && held.tunnel_id === input.tunnelId && held.lease_type === input.leaseType) {
      return {
        ok: true,
        result: {
          port: held.port,
          leaseId: held.id,
          leaseType: held.lease_type,
          tunnelId: held.tunnel_id,
          reused: true,
        },
      };
    }
  }
  for (const row of activeRows) reserved.add(row.port);

  // 预分配默认 TTL：NULL expiry 的预分配是 reconcile 收不回的孤儿
  // （删隧道会把 tunnel_id 打成 NULL，无法与「活着的新建中」区分）。
  const expiresAt =
    input.tunnelId === null || input.tunnelId === undefined
      ? (input.expiresAt ?? new Date(Date.now() + PREALLOC_TTL_S * 1000))
      : (input.expiresAt ?? null);

  const pool = portCandidates(range, input.preferredPort ?? null);
  const attempts = isPreferred ? pool : pool.slice(0, MAX_ATTEMPTS);

  for (const port of attempts) {
    // 硬性校验（端口形态 / 黑名单 / 区间）。
    //   · user-specified：**中止**并给出具体原因 —— 绝不允许「用户点名要 80」
    //     被悄悄改成分到别的端口，调用方会拿到和自己请求不一致的结果；
    //   · auto：跳到下一个候选。候选集由 expandAvailablePorts 生成，黑名单与
    //     区间已在那里剔除，所以这几行对 auto 实际不可达；保留跳过只是防御。
    if (!isValidPort(port) || isBlacklistedPort(port) || port < range.min || port > range.max) {
      if (!isPreferred) continue;
      const code = !isValidPort(port)
        ? "port_out_of_range"
        : isBlacklistedPort(port)
          ? "port_blacklisted"
          : "port_outside_node_range";
      return { ok: false, code, port };
    }
    // 软性校验（已占用）：auto 的下一个候选，user-specified 直接失败。
    // 两者的区别只在「候选集长度」，不在判定本身——这正是 §7.6 要的
    // 「同一规则」：没有白名单绕过项，也没有 auto 专属的绕过项。
    if (reserved.has(port)) {
      if (isPreferred) return { ok: false, code: "port_taken", port };
      continue;
    }

    const gotLock = await tryLock(rdb, scope, input.nodeId, port, lockTtlS);
    try {
      // 3a. 认领一条已释放的行（端口回收再用的唯一途径）。
      const revived = (await pdb.nodePortLease.updateMany({
        where: { node_id: input.nodeId, port, status: LEASE_STATUS.released },
        data: {
          status: LEASE_STATUS.active,
          lease_type: input.leaseType,
          tunnel_id: input.tunnelId ?? null,
          expires_at: expiresAt,
          created_at: new Date(),
        },
      })) as { count: number };
      if (revived.count > 0) {
        const row = (await pdb.nodePortLease.findUnique({
          where: { node_id_port: { node_id: input.nodeId, port } },
        })) as LeaseRow | null;
        return {
          ok: true,
          result: {
            port,
            leaseId: row?.id ?? -1,
            leaseType: input.leaseType,
            tunnelId: input.tunnelId ?? null,
            reused: true,
          },
        };
      }

      // 3b. 没有可认领的 released 行 → 全新插入。
      try {
        const row = (await pdb.nodePortLease.create({
          data: {
            node_id: input.nodeId,
            port,
            lease_type: input.leaseType,
            tunnel_id: input.tunnelId ?? null,
            status: LEASE_STATUS.active,
            expires_at: expiresAt,
          },
        })) as LeaseRow;
        return {
          ok: true,
          result: {
            port,
            leaseId: row.id,
            leaseType: input.leaseType,
            tunnelId: input.tunnelId ?? null,
            reused: false,
          },
        };
      } catch (e) {
        if (!isUniqueConflict(e)) throw e;
        // 并发的重复 apply 可能在 activeRows 快照之后抢先创建了同一租约。
        // 重新读 holder：只有同 Tunnel + 同方向才按幂等成功收敛；其它情况仍是冲突。
        if (input.tunnelId !== null && input.tunnelId !== undefined) {
          const holder = (await pdb.nodePortLease.findUnique({
            where: { node_id_port: { node_id: input.nodeId, port } },
          })) as LeaseRow | null;
          if (
            holder?.status === LEASE_STATUS.active &&
            holder.tunnel_id === input.tunnelId &&
            holder.lease_type === input.leaseType
          ) {
            return {
              ok: true,
              result: {
                port,
                leaseId: holder.id,
                leaseType: holder.lease_type,
                tunnelId: holder.tunnel_id,
                reused: true,
              },
            };
          }
        }
        // 已被其它所有者占用 → 下一个候选端口；user-specified 最终返回 port_taken。
      }
    } finally {
      if (gotLock) await unlock(rdb, scope, input.nodeId, port);
    }
  }

  if (attempts.length === 0) return { ok: false, code: "no_available_port" };
  return { ok: false, code: "port_taken" };
}

/**
 * 释放租约（软删除：置 `status='released'`，保留行）。
 *
 * 三种粒度（按参数优先级）：
 *   · `leaseId`   —— 精确释放一条；
 *   · `tunnelId`  —— 释放该隧道持有的全部 active 租约（编排器删隧道/改
 *                    目标池的补偿路径）；
 *   · `nodeId`    —— 释放该节点全部 active 租约（节点下线/撤销角色）。
 *
 * 返回 false 表示「没有 active 租约被释放」——可能是从来没租过，也可能是已被
 * {@link reconcileLeases} 抢先回收。两者都**不是错误**，调用方不该重试。
 */
export async function releaseLease(
  args: { leaseId?: number; tunnelId?: number; nodeId?: number },
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
): Promise<{
  leaseId: number;
  leaseType: LeaseDirection;
  tunnelId: number | null;
  status: LeaseStatus;
  expiresAt: Date | null;
} | null> {
  const { db: pdb } = deps(inject);
  const row = (await pdb.nodePortLease.findUnique({
    where: { node_id_port: { node_id: nodeId, port } },
  })) as LeaseRow | null;
  if (!row) return null;
  return {
    leaseId: row.id,
    leaseType: row.lease_type,
    tunnelId: row.tunnel_id,
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
  reserved?: Iterable<number | null | undefined>,
  inject?: PortPoolDeps,
): Promise<number[]> {
  const pdb = deps(inject).db;
  const context = await resolveContext(pdb, nodeId);
  if (!context.ok) return [];
  const rows = (await pdb.nodePortLease.findMany({
    where: { node_id: nodeId, status: LEASE_STATUS.active },
    select: { port: true },
  })) as { port: number }[];
  const taken = new Set<number>(rows.map((r) => r.port));
  for (const p of reserved ?? []) if (isValidPort(p)) taken.add(p);
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
    select: { id: true, node_id: true, port: true, tunnel_id: true, expires_at: true },
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
