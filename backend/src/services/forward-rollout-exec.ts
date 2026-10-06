/**
 * Forward rollout execution, recovery and compensation.
 *
 * Rollout rows are resumable execution ledgers, not desired/runtime truth.
 * Executors replay idempotent steps, keep uncertain ACK timeouts in a waiting
 * state, compensate only after explicit cutover failure, and preserve the last
 * known applied revision until a replacement is confirmed.
 */

import { randomUUID } from "node:crypto";

import { acquirePort, releaseLease } from "./portPool.ts";
import type { AcquirePortOutcome } from "./portPool.ts";
import { Orchestrator } from "./orchestrator.ts";
import { ACTIVE_ROLLOUT_PHASES, planRollout, ROLLOUT_STAGE_SEQUENCE, rolloutStepKey } from "./forward-rollout.ts";
import {
  dispatchFactsFromRow,
  persistedForwardProtocol,
  type DispatchFacts,
} from "./forward-contract.ts";
import type { PlanRolloutInput, RolloutPlan, RolloutSnapshot, RolloutStep } from "./forward-rollout.ts";
import { admitRoute } from "./forward-route.ts";
import type { RuntimeUseDenied, RuntimeUseResource } from "./forward-capability.ts";
// 远端出口腿的委托。编排只调这里的入口 —— 签名/重试/幂等键/镜像行
// 全部有且只有一个实现（`federation/forward-hop.ts`），rollout 不再自己拼一遍。
import {
  checkFederatedEgressForSnapshot,
  delegateFederatedEgress,
  federatedEgressPeerOf,
  recordRemoteEgressAddress,
  releaseFederatedEgress,
  remoteEgressAddressFor,
  FEDERATED_EGRESS_PLAN_NODE_ID,
  type ForwardHopSender,
} from "./federation/forward-hop.ts";

/** Existing runtime use, not a new creation/count slot. Production never defaults to allow. */
export type RuntimeUseChecker = (workspaceId: number, resource: RuntimeUseResource) => Promise<RuntimeUseDenied | null>;
export const defaultRuntimeUse: RuntimeUseChecker = async (workspaceId, resource) => {
  const { checkForwardRuntimeUse } = await import("./forward-capability.ts");
  return checkForwardRuntimeUse(workspaceId, resource);
};

/* ================================================================== */
/* 契约类型                                                            */
/* ================================================================== */

/** rollout 的 phase。五阶段 + §13.3.5/§3.6 的四个终态/等待态。 */
export type RolloutStatus =
  | "validate"
  | "prepare"
  | "cutover"
  | "drain"
  | "cleanup"
  | "done"
  | "failed"
  | "compensating"
  | "degraded"
  | "waiting";

/**
 * 步骤运行时上下文（每个 step 执行器都拿它）。
 *
 * 注入而不是全局单例：`resumeRollouts`（C5）与单元测试都要能在不同
 * db/orchestrator 上跑同一个 runner。
 */
export interface RolloutExecContext {
  rolloutId: number;
  tunnelId: number;
  revision: number;
  baseRevision: number | null;
  /** 目标 snapshot（desired）。 */
  desired: RolloutSnapshot;
  /** 旧 snapshot（applied）；null = 首次部署。 */
  applied: RolloutSnapshot | null;
  /** 计划里的步骤全集（续跑时用于跳过已完成）。 */
  plan: RolloutPlan;
  /** 已完成的 step 幂等键集合。 */
  completed: ReadonlySet<string>;
  /** 执行过程中新占用的资源句柄（补偿/失败清理要用）。 */
  prepared: PreparedResource[];
  /** 执行过程中产生的人类可读记录（写回 rollout 行）。 */
  notes: string[];
}

/** 本轮 rollout 自己创建的、失败时需要回收的资源。 */
export interface PreparedResource {
  kind: "lease" | "egress_apply" | "binding";
  node_id: number | null;
  port: number | null;
  /** `releaseLease` 用的租约主键；binding 用 binding pair。 */
  handle: number | { ingress_node_id: number; egress_node_id: number } | null;
  /**
   * false = 这条 lease 在本轮开始前就已由同一 tunnel 持有，仅作为端口事实复用；
   * PREPARE 失败时绝不能释放它，否则会把仍服务旧版本的 durable ownership 一起拆掉。
   * 缺省/true = 本轮 acquire/revive 的资源，失败清理应回收。
   */
  owned_by_rollout?: boolean;
}

/** 一个 step 的执行结果。 */
export type StepOutcome =
  | { ok: true; note?: string; sideEffect?: PreparedResource }
  /** `soft` = §13.3.5 DRAIN 的语义：失败但不阻塞后续阶段。 */
  | { ok: false; soft?: boolean; error_code: string; error: string };

/** 一次 rollout 执行的总体结果。 */
export interface RolloutExecResult {
  ok: boolean;
  rolloutId: number;
  phase: RolloutStatus;
  /** 失败/降级时的机器可读码。 */
  error_code?: string;
  error?: string;
  /** 已完成步骤数（含本次之前）。 */
  completed: number;
  /** 补偿是否已尝试。 */
  compensated?: boolean;
}

/** `executeRollout` 的依赖注入（测试替身）。 */
export interface RolloutDeps {
  /**
   * 数据访问。**必填** 调用方（route/worker）显式传 `db`，测试传内存替身。
   * 做成可选会让「忘了注入就静默走进程单例」成为可能——而那正是 rollout
   * 这类跨请求状态最容易出静默数据错乱的地方。
   */
  db: RolloutDb;
  /**
   * 控制面 transport。调用方（route/worker）显式注入；无法取得时应以
   * `agent_unreachable` 的失败形态交给调用方，而不是代填 null
   * （本模块的 step runner 在无 transport 时无法安全执行任何下发）。
   */
  orchestrator: Orchestrator;
  /** Re-read grants/policy/traffic before every PREPARE/CUTOVER side effect. */
  runtimeUse?: RuntimeUseChecker;
  /**
   * 跨面板出站的注入点（默认走 `client.callPeer`）。
   *
   * 只有"这条 Forward 声明了 federated_egress_peer"的路径会用到它；为空时那些
   * 路径会走真实的 `callPeer`（签名/超时/重试的唯一实现）。测试注入假 transport，
   * 于是"远端腿的建立/补偿/释放"可以在没有第二个 Panel 的情况下被断言。
   */
  federatedSender?: ForwardHopSender;
  now?: () => Date;
  /** 测试可注入无等待 sleeper；生产默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 本模块用到的 Prisma 最小接口。
 *
 * 显式列出而不是 `typeof db`：C4/C5 的测试要能用内存替身跑全矩阵，
 * 而替身只需要这几个方法。真库里 `db` 满足之（结构上兼容）。
 */
export interface RolloutDb {
  tunnel: {
    findUnique(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
  forwardRevision: {
    findFirst(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    /**
     * V5.3：回滚需要为**新世代**写一份快照（内容 = 基线）。缺它就没法回滚 ——
     * 这是刻意让端口显式化：如果某个替身没实现它，`create` 会立刻失败并被记进
     * `compensation_error`，而不是让补偿悄悄退回"原地重放基线版本"那条已经证明行不通的路。
     */
    create(args: unknown): Promise<unknown>;
  };
  forwardRollout: {
    create(args: unknown): Promise<unknown>;
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
  /**
   * RELAY 新 pair 的 NodeBinding（§13.3.1）。`nodeBinding` 是既有表，与
   * `forward_rollout` 一样通过 `deps.db` 注入：替身只需要这两个方法。
   */
  nodeBinding: {
    findUnique(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
  };
  /**
   * `acquirePort` / `releaseLease` 走同一个 db（它们自己也有 `deps` 注入点，
   * 但让 rollout 与其共用同一个 db 更符合「一个 rollout 里端口与阶段账本
   * 必须同源」——否则测试替身要维护两份 db）。
   */
  node: {
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
  nodePortLease: {
    create(args: unknown): Promise<unknown>;
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
  /**
   * Agent 最近一次自报的 runtime 快照。旧测试替身可以不实现；缺失时恢复
   * 仍走同 revision 重放，只是少一条“事实确认后跳过重发”的优化/安全路径。
   */
  nodeStateReport?: {
    findUnique(args: unknown): Promise<unknown>;
  };
}

/* ================================================================== */
/* rollout 行读取                                                      */
/* ================================================================== */

/** rollout 行在本模块里使用的投影（JSON 列解出来后的形态）。 */
export interface RolloutRowView {
  id: number;
  tunnel_id: number;
  revision: number;
  base_revision: number | null;
  /** rollout 行自己的 phase 列（`phase` 与 RolloutStatus 同名不同物：列是 DB 真相）。 */
  phase: RolloutStatus;
  /** `strategy` 列；迁移前的存量行为 NULL（DB 允许、不回落不影响语义）。 */
  strategy: string | null;
  /** `steps` 列：register 时写入的「计划 + desired/applied 快照」。 */
  steps: unknown;
  /** `cleaned` 列：已完成的 step 幂等键集合（追加式）。 */
  cleaned: string[];
  /** `prepared` 列：本轮创建、失败时要回收的资源句柄（追加式）。 */
  prepared: PreparedResource[];
  /** `notes` 列：逐步流水账（追加式）；迁移前的存量行为 NULL。 */
  notes: string[] | null;
  /** `compensation_error`：补偿失败原因；成功补偿与未补偿时为 NULL。 */
  compensation_error: string | null;
  last_error_code: string | null;
  last_error: string | null;
  compensated: boolean;
  /** 单执行器 DB lease；老替身/迁移前对象允许 undefined，按 NULL 处理。 */
  executor_owner?: string | null;
  executor_lease_until?: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

/* ================================================================== */
/* 纯函数：JSON 记账列的读写                                            */
/* ================================================================== */

/**
 * 把 rollout 行的 JSON 记账列读成结构化数组。
 *
 * 为什么值得单独一个函数：这三列（`plan` / `completed` / `prepared`）是
 * **追加式**的，`completed` 还要参与「续跑去重」。若每个写点各写一遍
 * `as unknown as T`，迟早有一处把 `undefined` 当成 `[]`，然后
 * `steps.push` 在下一行炸——而那正是重启后的第一行代码。
 */
export function readLedger<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value)) return value as T;
  return fallback;
}

/** 同 {@link readLedger}，但只接受字符串数组（`completed` 列）。 */
export function readKeySet(value: unknown): string[] {
  const arr = readLedger<unknown[]>(value, []);
  return arr.filter((k): k is string => typeof k === "string");
}

/**
 * 读 `steps` 列里的计划。
 *
 * 单独一个函数而不是内联 `as RolloutPlan`：坏行（null / 非对象 / 缺 steps
 * 数组）必须在**进入执行循环之前**就被识别成 `plan_missing`，而不是在
 * `plan.steps.filter` 那行抛 TypeError——后者会被上层 catch 成 500，
 * 而它其实是「这行 rollout 数据坏了，重试也没用」。
 */
export function readPlan(value: unknown): RolloutPlan | null {
  if (!value || typeof value !== "object") return null;
  const plan = value as RolloutPlan;
  if (!Array.isArray(plan.steps)) return null;
  return plan;
}

/* ================================================================== */
/* 追加式记账（并发安全）                                               */
/* ================================================================== */

/**
 * 把一个 step 标记为已完成。
 *
 * 用 `updateMany where completed NOT contains` 而不是先读后写：并发两次
 * 续跑（worker cron 与请求同步路径）对同一个 step 只会有一个写入成功，
 * 另一个看到 count=0 就知道「已经有人做过了」→ 幂等跳过。
 * 这也让**重复执行同一个 step 永远是安全的**（幂等键天然去重）。
 */
export async function markStepCompleted(
  rolloutId: number,
  key: string,
  deps: { db: RolloutDb },
): Promise<boolean> {
  const res = (await deps.db.forwardRollout.updateMany({
    where: { id: rolloutId },
    data: { cleaned: { push: key } },
  })) as { count: number };
  return res.count > 0;
}

/**
 * 登记一个本轮创建、失败时需要回收的资源。
 *
 * 顺序要紧：**先记账再做事** 还是 **先做事再记账**？这里选后者（执行器
 * 返回 sideEffect，调用方落库后再做下一件），因为 PREPARE 失败路径的第一
 * 件事就是「清理已登记的资源」——如果登记晚于创建，崩溃窗口里 resource
 * 存在但没人知道，端口就泄漏到 `reconcileLeases` 的孤儿回收（那要等 TTL）。
 * 代价是崩溃窗口内多跑一次幂等 no-op，可接受。
 */
export async function appendPrepared(
  rolloutId: number,
  resource: PreparedResource,
  deps: { db: RolloutDb },
): Promise<void> {
  await deps.db.forwardRollout.updateMany({
    where: { id: rolloutId },
    data: { prepared: { push: resource } },
  });
}

/* ================================================================== */
/* 状态迁移（带前置状态条件，乐观并发）                                  */
/* ================================================================== */

/**
 * 迁移 rollout 行的 phase。
 *
 * `from` 是乐观锁：`compensating` → `failed` 必须只从 `compensating` 出发，
 * 否则补偿循环里一条迟到的失败会把已成功补偿的 rollout 改写成 failed。
 * 返回 false = 状态已被别人改过，调用方应重新读行再决定。
 */
export async function transitionRollout(
  rolloutId: number,
  from: RolloutStatus | RolloutStatus[],
  to: RolloutStatus,
  patch: Record<string, unknown>,
  deps: { db: RolloutDb },
): Promise<boolean> {
  const where = Array.isArray(from) ? { id: rolloutId, phase: { in: from } } : { id: rolloutId, phase: from };
  const res = (await deps.db.forwardRollout.updateMany({
    where,
    data: { phase: to, ...patch },
  })) as { count: number };
  return res.count > 0;
}

/* ================================================================== */
/* 节点/快照解析（register 用）                                        */
/* ================================================================== */

/** tunnel 行里 register 需要的投影。 */
interface TunnelProjection {
  id: number;
  name: string;
  tunnel_mode: string;
  ingress_node_id: number | null;
  egress_node_id: number | null;
  middle_node_id?: number | null;
  listen_ip: string | null;
  listen_port: number | null;
  remote_host: string | null;
  remote_port: number | null;
  egress_pool_id: number | null;
  egress_port: number | null;
  config_revision: number;
  desired_revision_id: number | null;
  desired_status: string;
  apply_status: string;
  /** 远端出口声明（NULL = 出口在本机）。 */
  federated_egress_peer?: string | null;
}

/**
 * 计划/执行期的一份快照：`RolloutSnapshot` +  的远端出口声明。
 *
 * `RolloutSnapshot` 归 `forward-rollout.ts`（本轮的改动范围之外），而这里只需要多读
 * 一个**可选**字段，所以用子类型而不是去动那个契约 —— 类型层面仍然是同一个形状，
 * 既有的构造点与替换快照一律不受影响。
 */
type FederatedRolloutSnapshot = RolloutSnapshot & { federated_egress_peer?: string | null };

/**
 * 读 tunnel 行 + 最新 snapshot，凑出 {@link PlanRolloutInput} 的四个输入
 * 里的两个（`desired` / `applied`）+  impact 之外的节点事实。
 *
 * **不复制 runtime 事实**（§13.3.5）：这里读出来的就是 tunnel 投影列与
 * snapshot 行本身，`desired` 取 `desired_revision_id` 指向的那一行；
 * 找不到（suspend bump 出的 revision 没有 snapshot，报告 R5）时回退到投影列
 * 合成基线——与  `currentDesiredConfig` 同口径。
 */
/**
 * 相邻两跳的绑定集合（`"ingress->egress"`）。V5.4 路由准入需要它，而它是**外部事实**，
 * 因此在这里一次性读出来交给纯判定。
 *
 * 读不到时返回空集合 = "没有绑定" ⇒ 三跳路由会被拒（fail-closed）。多跳在没有许可链路时本来
 * 就不该下发，把"读不到"当成"有绑定"才是危险方向。
 */
async function loadBoundPairs(db: RolloutDb): Promise<ReadonlySet<string>> {
  // Treat a partial dependency surface as "no bindings loaded" rather than
  // crashing a rollout before the fail-closed route admission check.
  const port = (db as unknown as { nodeBinding?: { findMany?: (args: unknown) => Promise<unknown> } }).nodeBinding;
  if (typeof port?.findMany !== "function") return new Set<string>();
  const rows = (await port.findMany({ select: { ingress_node_id: true, egress_node_id: true } }).catch(() => [])) as
    | Array<{ ingress_node_id: number; egress_node_id: number }>
    | undefined;
  return new Set((rows ?? []).map((b) => `${b.ingress_node_id}->${b.egress_node_id}`));
}

/**
 * Release ownership held by a node that no longer hosts the Forward.
 *
 * This runs only after the old ingress runtime has been drained, so releasing the
 * obsolete lease cannot create dual ownership. Same-node listener moves keep the
 * lease because ownership did not move.
 */
async function releaseStalePlacementLease(
  deps: RolloutDeps,
  ctx: RolloutExecContext,
  oldNodeId: number,
): Promise<void> {
  if (ctx.desired.ingress_node_id === oldNodeId) return;
  try {
    const { releaseLease: releasePlacementLease } = await import("./placement-lease.ts");
    await releasePlacementLease({ tunnelId: ctx.tunnelId, nodeId: oldNodeId, now: deps.now?.() ?? new Date() });
  } catch {
    // 尽力而为：CLEANUP 阶段不该因为归属释放失败而整条 rollout 判失败。留在那里的旧租约会自然过期
    // （TTL），下一轮 reconcile 就能认领 —— 届时的行为与"等待过期"一致。
  }
}

async function loadRolloutNodes(
  tunnelId: number,
  deps: { db: RolloutDb },
): Promise<{
  desired: FederatedRolloutSnapshot;
  applied: FederatedRolloutSnapshot | null;
  nodes: PlanRolloutInput["nodes"];
  bindingExists: boolean | null;
}> {
  const row = (await deps.db.tunnel.findUnique({
    where: { id: tunnelId },
    include: { ingress_node: true, egress_node: true },
  })) as (TunnelProjection & { ingress_node: unknown; egress_node: unknown }) | null;
  if (!row) throw new Error(`tunnel ${tunnelId} not found`);

  const snapshots = (await deps.db.forwardRevision.findMany({
    where: { tunnel_id: tunnelId },
    orderBy: { revision: "desc" },
    take: 2,
  })) as Array<Record<string, unknown>>;

  const snapshotToRollout = (s: Record<string, unknown>): FederatedRolloutSnapshot => ({
    name: String(s.name ?? row.name),
    mode: String(s.mode ?? row.tunnel_mode) === "relay" ? "relay" : "direct",
    ingress_node_id: Number(s.ingress_node_id ?? row.ingress_node_id ?? 0),
    egress_node_id: s.egress_node_id == null ? null : Number(s.egress_node_id),
    middle_node_id: s.middle_node_id == null ? null : Number(s.middle_node_id),
    listen_ip: (s.listen_ip as string | null) ?? row.listen_ip,
    listen_port: s.listen_port == null ? null : Number(s.listen_port),
    target_host: (s.target_host as string | null) ?? null,
    target_port: s.target_port == null ? null : Number(s.target_port),
    egress_pool_id: s.egress_pool_id == null ? null : Number(s.egress_pool_id),
    egress_port: s.egress_port == null ? null : Number(s.egress_port),
    egress_targets: Array.isArray(s.targets)
      ? (s.targets as Array<{ host: string; port: number; weight: number; order_by: number }>)
      : null,
    desired_status: (s.desired_status as string | null) ?? null,
    // 这一跳"在哪一侧"必须随快照进计划 —— 续跑/补偿都靠它决定
    // 该走本地 orchestrator 还是 peer（快照是唯一的放置事实来源）。
    federated_egress_peer: federatedEgressPeerOf(s),
  });

  // desired：desired_revision_id 指向的 snapshot；缺失时用投影列合成基线
  // （报告 R5 的 suspend bump 场景；口径与  currentDesiredConfig 一致）。
  const desiredRow = row.desired_revision_id
    ? snapshots.find((s) => Number(s.id) === Number(row.desired_revision_id))
    : snapshots[0];
  const desired: FederatedRolloutSnapshot = desiredRow
    ? snapshotToRollout(desiredRow)
    : {
        name: row.name,
        mode: row.tunnel_mode === "relay" ? "relay" : "direct",
        ingress_node_id: row.ingress_node_id ?? 0,
        egress_node_id: row.egress_node_id ?? null,
        middle_node_id: row.middle_node_id ?? null,
        listen_ip: row.listen_ip,
        listen_port: row.listen_port ?? null,
        target_host: row.remote_host,
        target_port: row.remote_port == null ? null : Number(row.remote_port),
        egress_pool_id: row.egress_pool_id,
        egress_port: row.egress_port,
        egress_targets: null,
        desired_status: row.desired_status,
        // 没有 snapshot 的存量行（报告 R5）：投影列就是唯一事实来源。
        federated_egress_peer: federatedEgressPeerOf(row),
      };

  // applied：desired 之外的**次新** snapshot。
  // 用「次新」而不是「applied_revision 那一行」：本表不存 applied_revision，
  // 而 §13.3.5 的 DRAIN/CLEANUP 需要的「旧 runtime」= 上一次成功 apply 的
  // 配置，在快照序列里正是次新。
  //
  // **排除 desired 用 revision 数值而不是对象引用** fallback 分支里 desired
  // 是从投影列合成的、不在 snapshots 数组里，用 `s !== desiredRow` 排除不掉
  // 任何一行 ⇒ applied 会取到次新的第一条（= desired 自己那次）⇒ 新旧对调，
  // CUTOVER 切旧端口、DRAIN 撤新监听。这种错法不会抛异常，只会把端口换错。
  const desiredRevision = desiredRow ? Number(desiredRow.revision) : null;
  const appliedRows = snapshots.filter(
    (s) => desiredRevision === null || Number(s.revision) !== desiredRevision,
  );
  const applied = appliedRows.length > 0 ? snapshotToRollout(appliedRows[0]!) : null;

  const nodeFact = (n: unknown): PlanRolloutInput["nodes"]["ingress"] => {
    if (!n || typeof n !== "object") return null;
    const rec = n as Record<string, unknown>;
    return {
      id: Number(rec.id),
      node_id: String(rec.node_id ?? ""),
      role: (rec.role as string | null) ?? null,
      connect_ip: (rec.connect_ip as string | null) ?? null,
      //  lifecycle 列已随  schema 落地：节点行（include: true）会带上它，
      // 因此 validateRolloutAdmission 能真的拦住维护中/退役中节点。undefined
      // 只出现在构造入参（注入的替身）没这个字段时，行为退化为 fail-closed。
      lifecycle: (rec.lifecycle as string | null | undefined) ?? undefined,
      port_range_configured:
        rec.port_range_min == null || rec.port_range_max == null ? false : true,
    };
  };

  // A desired revision may choose different Nodes while the tunnel projection
  // still describes the old applied topology. Admission must inspect the target.
  const [desiredIngress, desiredEgress, desiredMiddle] = await Promise.all([
    (row.ingress_node as { id?: number } | null)?.id === desired.ingress_node_id
      ? row.ingress_node
      : deps.db.node.findUnique({ where: { id: desired.ingress_node_id } }),
    desired.egress_node_id == null ? null
      : (row.egress_node as { id?: number } | null)?.id === desired.egress_node_id
        ? row.egress_node
        : deps.db.node.findUnique({ where: { id: desired.egress_node_id } }),
    desired.middle_node_id == null
      ? null
      : deps.db.node.findUnique({ where: { id: desired.middle_node_id } }),
  ]);
  const nodes: PlanRolloutInput["nodes"] = {
    ingress: nodeFact(desiredIngress),
    // ──：声明了远端 peer 时，出口跳在**另一个面板**上 ──
    //
    // 计划器需要一份出口节点事实（准入与路由模型都以它为前提），而本机确实没有
    // 出口节点。这里给的是一份**显式占位**（`FEDERATED_EGRESS_PLAN_NODE_ID`）：
    // 它只让计划通过，联邦分支第一件事就是不看它而直接走 `callPeer`。
    // 若这里给 null，计划会在 VALIDATE 阶段被拒 —— 症状是"保存成功、什么都不发生"。
    egress: federatedEgressPeerOf(desired) === null
      ? nodeFact(desiredEgress)
      : {
          id: FEDERATED_EGRESS_PLAN_NODE_ID,
          node_id: `federated:${federatedEgressPeerOf(desired)}`,
          role: "egress",
          connect_ip: null,
          lifecycle: "active",
          port_range_configured: false,
        },
    middle: nodeFact(desiredMiddle),
    // 旧拓扑的节点对象：applied snapshot 里有 id 即可，运行时 DRAIN/CLEANUP
    // 只需要 node id 与端口，不需要再读一次 Node 行（避免旧节点已删时读库失败）。
    ingress_previous:
      applied && applied.ingress_node_id !== desired.ingress_node_id
        ? {
            id: applied.ingress_node_id,
            node_id: "",
            role: null,
            connect_ip: null,
          }
        : applied
          ? {
              id: applied.ingress_node_id,
              node_id: "",
              role: null,
              connect_ip: null,
            }
          : null,
    egress_previous:
      applied && applied.egress_node_id != null && applied.egress_node_id !== desired.egress_node_id
        ? { id: applied.egress_node_id, node_id: "", role: null, connect_ip: null }
        : applied && applied.egress_node_id != null
          ? { id: applied.egress_node_id, node_id: "", role: null, connect_ip: null }
          : null,
    middle_previous:
      applied?.middle_node_id != null
        ? { id: applied.middle_node_id, node_id: "", role: null, connect_ip: null }
        : null,
  };

  // Binding 存在性：只有 RELAY 且出口节点解析出来才有意义。
  // 远端出口腿没有本机出口节点，也就没有可建的 NodeBinding（绑定是**本机**节点间
  // 的许可关系，跨面板那一跳由 host 的 grant 授权，见契约 §3.1）。
  let bindingExists: boolean | null = null;
  if (
    federatedEgressPeerOf(desired) === null &&
    desired.mode === "relay" &&
    desired.ingress_node_id != null &&
    desired.egress_node_id != null
  ) {
    const found = (await deps.db.nodeBinding.findUnique({
      where: {
        ingress_node_id_egress_node_id: {
          ingress_node_id: desired.ingress_node_id,
          egress_node_id: desired.egress_node_id,
        },
      },
    })) as { id: number } | null;
    bindingExists = found != null;
  }

  return { desired, applied, nodes, bindingExists };
}

/** Resolve the candidate Nodes' CURRENT groups, never the old applied groups.
 * Missing identity/topology fails closed even when a test checker is injected. */
async function rolloutRuntimeDenial(
  tunnelId: number,
  desired: RolloutSnapshot,
  deps: RolloutDeps,
): Promise<RuntimeUseDenied | null> {
  const [rawTunnel, rawIngress, rawEgress] = await Promise.all([
    deps.db.tunnel.findUnique({ where: { id: tunnelId } }),
    deps.db.node.findUnique({ where: { id: desired.ingress_node_id }, select: { node_group_id: true } }),
    desired.mode === "relay" && desired.egress_node_id != null
      ? deps.db.node.findUnique({ where: { id: desired.egress_node_id }, select: { node_group_id: true } })
      : null,
  ]);
  const tunnel = rawTunnel as {
    workspace_id?: number;
    user_id?: number;
    forward_protocol?: unknown;
    tunnel_type?: string;
  } | null;
  const ingress = rawIngress as { node_group_id?: number } | null;
  const egress = rawEgress as { node_group_id?: number } | null;
  const validId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
  // 出口腿在远端时，本机**没有**出口节点组可授权 —— 那一跳的容量与
  // 配额权威在 host（契约 §1 的 Quota authority 答案：容量事实发生在 host）。
  // 这里仍然严格校验入口侧与归属，不是"跳过授权"。
  const federatedEgress = federatedEgressPeerOf(desired) !== null;
  if (!validId(tunnel?.workspace_id) || !validId(tunnel?.user_id) ||
      !validId(ingress?.node_group_id) ||
      (!federatedEgress && desired.mode === "relay" && !validId(egress?.node_group_id))) {
    return { code: "forbidden", reason: "scope_revoked", error_layer: "resource_scope", message: "转发归属或候选节点组已失效，无法应用目标配置" };
  }
  return (deps.runtimeUse ?? defaultRuntimeUse)(tunnel.workspace_id, {
    user_id: tunnel.user_id,
    in_node_group_id: ingress.node_group_id,
    out_node_group_id: !federatedEgress && desired.mode === "relay" ? egress!.node_group_id! : null,
    // Policy checks use the canonical product protocol; the legacy DB projection
    // is only a persisted-fact fallback.
    protocol: persistedForwardProtocol(tunnel.forward_protocol, tunnel.tunnel_type),
  });
}

/* ================================================================== */
/* 远端出口腿（）                                              */
/* ================================================================== */

/**
 * 出口腿委托给 peer。
 *
 * 这个函数是 rollout 与 `federation/forward-hop.ts` 之间的**唯一**接缝：
 * 计划/账本/补偿仍然全部由本文件负责，只有"那一跳怎么建"被换成了 `callPeer`。
 * 它做的三件事：
 *   1. 拓扑自检（同一份判定在注册时也跑过，但**续跑**可能拿到一份更早的计划）；
 *   2. 委托（reserve → apply → 镜像行），失败时由 forward-hop 内部完成远端补偿；
 *   3. 把 host 返回的可寻址地址登记下来 —— 入口的 next_hop 只认它。
 */
async function delegateRemoteEgressStep(ctx: RolloutExecContext, deps: RolloutDeps): Promise<StepOutcome> {
  const peer = federatedEgressPeerOf(ctx.desired);
  if (peer === null) {
    return { ok: false, error_code: "invariant_violated", error: "远端出口分支被调用，但 desired 未声明 federated_egress_peer" };
  }
  const facts = await dispatchFactsFor(ctx.tunnelId, deps.db);
  if (facts === null) {
    return {
      ok: false,
      error_code: "unsupported_protocol",
      error: "该转发使用的协议尚未进入当前 runtime 白名单（或缺少该协议必需的配置），拒绝委托远端出口",
    };
  }
  const check = checkFederatedEgressForSnapshot({
    tunnelId: ctx.tunnelId,
    revision: ctx.revision,
    snapshot: ctx.desired,
    protocol: facts.protocol,
  });
  if (!check.ok) {
    return { ok: false, error_code: check.code, error: check.message };
  }

  const outcome = await delegateFederatedEgress(
    {
      tunnelId: ctx.tunnelId,
      revision: ctx.revision,
      declaredPeer: peer,
      mode: ctx.desired.mode,
      ingress_node_id: ctx.desired.ingress_node_id,
      local_egress_node_id: ctx.desired.egress_node_id,
      middle_node_id: (ctx.desired as { middle_node_id?: number | null }).middle_node_id ?? null,
      protocol: facts.protocol,
      targets: ctx.desired.egress_targets ?? [],
      lb_strategy: await loadEgressPoolLb(deps, ctx.desired.egress_pool_id),
    },
    { db: deps.db as never, sender: deps.federatedSender, now: deps.now },
  );

  if (!outcome.ok) {
    // 远端失败**绝不**回落本机出口（契约 §5/§7）：这里只如实上报，把状态交给
    // 既有的失败分流（PREPARE 失败 → error；CUTOVER 失败 → 补偿）。
    const release = outcome.lease_ref
      ? outcome.compensated
        ? `远端租约 ${outcome.lease_ref} 已释放`
        : `远端租约 ${outcome.lease_ref} 释放未确认（需对账）`
      : "远端未产生租约";
    return { ok: false, error_code: outcome.code, error: `远端出口 ${peer}: ${outcome.message}；${release}` };
  }

  if (outcome.next_hop !== null) recordRemoteEgressAddress(ctx.tunnelId, peer, outcome.next_hop);
  return {
    ok: true,
    note:
      `远端 egress peer=${peer} lease=${outcome.lease_ref} epoch=${outcome.lease_epoch} ` +
      `applied_revision=${outcome.applied_revision} ` +
      `next_hop=${outcome.next_hop ?? "（host 未返回可寻址地址，入口将 fail-closed）"}` +
      `${outcome.replayed ? "（幂等重放）" : ""}`,
  };
}

/**
 * 该隧道当前**已经持有**的入口端口（本机 durable lease）。
 *
 * 只给联邦恢复路径用（见 `acquire_port` 的注释）：同 revision 重跑时必须续用端口，
 * 否则同一方向会出现两条 active 租约。
 */
async function existingIngressPort(deps: RolloutDeps, tunnelId: number): Promise<number | null> {
  const reader = (deps.db as unknown as { nodePortLease?: { findMany?: (args: unknown) => Promise<unknown> } })
    .nodePortLease?.findMany;
  if (typeof reader !== "function") return null;
  const rows = (await reader({
    where: { tunnel_id: tunnelId, lease_type: "ingress", status: "active" },
    select: { port: true },
  }).catch(() => [])) as Array<{ port: unknown }>;
  const port = rows.length > 0 ? Number(rows[0]!.port) : NaN;
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** 本机出口池的负载均衡策略（原样转述给 host；读不到时 null = 让 host 用默认）。 */
async function loadEgressPoolLb(deps: RolloutDeps, poolId: number | null): Promise<string | null> {
  if (poolId == null) return null;
  const pool = (deps.db as unknown as { egressPool?: { findUnique?: (args: unknown) => Promise<unknown> } })
    .egressPool?.findUnique;
  if (typeof pool !== "function") return null;
  const row = (await pool({ where: { id: poolId }, select: { lb_strategy: true } }).catch(() => null)) as
    | { lb_strategy?: string | null }
    | null;
  return typeof row?.lb_strategy === "string" && row.lb_strategy.length > 0 ? row.lb_strategy : null;
}

/** 这条被撤下的旧出口腿是不是一条**远端**腿（本机没有它的 runtime）。 */
function appliedRemoteEgressPeer(ctx: RolloutExecContext): string | null {
  return federatedEgressPeerOf(ctx.applied);
}

/**
 * 释放远端出口腿（幂等）。
 *
 * `revision` 决定 intent_id —— 必须是**建那条腿时**的那一代，否则会去释放另一代
 * revision 的租约（释放是幂等的，但释错人不是）。
 */
async function releaseRemoteEgressStep(
  ctx: RolloutExecContext,
  deps: RolloutDeps,
  revision: number,
): Promise<{ ok: boolean; message: string }> {
  const peer = federatedEgressPeerOf(ctx.desired) ?? appliedRemoteEgressPeer(ctx);
  const result = await releaseFederatedEgress(
    { tunnelId: ctx.tunnelId, revision, peer_panel_id: peer },
    { db: deps.db as never, sender: deps.federatedSender, now: deps.now },
  );
  return { ok: result.ok, message: result.ok ? "已释放" : `${result.code ?? "internal_error"}: ${result.message ?? ""}` };
}

/* ================================================================== */
/* 步骤执行器                                                          */
/* ================================================================== */

/**
 * 执行单个 step。**每个分支必须幂等**（续跑会重放）。
 *
 * 返回 `{ok:false}` 时调用方按 §13.3.5 分流；`soft:true` 只用于 DRAIN
 * （在途连接由 kernel 超时兜底，不阻塞 CLEANUP）。
 */
async function runStep(
  step: RolloutStep,
  ctx: RolloutExecContext,
  deps: RolloutDeps,
): Promise<StepOutcome> {
  const orchestrator = deps.orchestrator;
  const nodeId = step.node_id;

  switch (step.kind) {
    /* ---------------- PREPARE ---------------- */

    case "acquire_port": {
      if (nodeId == null) {
        return { ok: false, error_code: "invariant_violated", error: "acquire_port 缺少 node_id" };
      }
      // 远端出口腿的端口/节点由 **host** 在自己的 grant 范围里分配
      // （契约 §1.5：端口归承载方）。本机既不分端口，也不建任何 node_port_lease 行
      // —— 建了就是第二份 ownership。
      if (step.direction === "egress" && federatedEgressPeerOf(ctx.desired) !== null) {
        return {
          ok: true,
          note: `远端出口腿：跳过本机 ${nodeId}:${step.port ?? "auto"} 的端口/节点分配（端口归 host 的 portPool）`,
        };
      }
      // **只对联邦 Forward 的恢复路径**做的端口续用。
      //
      // 恢复用同一个 revision 重跑，而 `desired.listen_port` 可能是"自动分配"
      // （NULL）—— 若照旧把 NULL 当 preferred 去 acquirePort，`portPool` 只在
      // "preferred 明确且命中原 lease" 时续用，于是会在**同一方向**再占一个端口，
      // 而旧租约仍然 active：库里出现双占、隧道行只记得其中一个。
      // 本机已经持有这条隧道的入口端口 ⇒ 以它作为 preferred（续用而非重分配）。
      //
      // 非联邦路径**一行都不进这里**（`federatedEgressPeerOf(...) === null`）。
      const declareFederated = federatedEgressPeerOf(ctx.desired) !== null;
      const preferredPort =
        step.port ??
        (declareFederated && step.direction === "ingress"
          ? await existingIngressPort(deps, ctx.tunnelId)
          : null);
      const leaseType = step.direction === "egress" ? "egress" : "ingress";
      // `AcquirePortResult.reused` 同时覆盖“已有 active lease”与“revive released row”，
      // 但失败补偿只应保留前者。先拍一张 active ownership 快照，才能区分这两种语义。
      let preexistingActiveLeaseId: number | null = null;
      if (preferredPort != null) {
        const before = (await deps.db.nodePortLease.findMany({
          where: {
            node_id: nodeId,
            port: preferredPort,
            tunnel_id: ctx.tunnelId,
            lease_type: leaseType,
            status: "active",
          },
          select: { id: true, node_id: true, port: true, tunnel_id: true, lease_type: true, status: true },
        })) as Array<{
          id: number;
          node_id?: number;
          port?: number;
          tunnel_id?: number | null;
          lease_type?: string;
          status?: string;
        }>;
        const held = before.find(
          (row) =>
            row.id > 0 &&
            (row.node_id === undefined || row.node_id === nodeId) &&
            (row.port === undefined || row.port === preferredPort) &&
            (row.tunnel_id === undefined || row.tunnel_id === ctx.tunnelId) &&
            (row.lease_type === undefined || row.lease_type === leaseType) &&
            (row.status === undefined || row.status === "active"),
        );
        preexistingActiveLeaseId = held?.id ?? null;
      }

      const outcome: AcquirePortOutcome = await acquirePort(
        {
          nodeId,
          leaseType,
          preferredPort,
          tunnelId: ctx.tunnelId,
          // 同上：本隧道自己的腿占着的端口不算冲突（幂等编辑/重试/还原端口都必须能过）。
          ownRuntimeIds: Orchestrator.localRuntimeIdsForTunnel(ctx.tunnelId),
        },
        { db: deps.db as never },
      );
      if (!outcome.ok) {
        return { ok: false, error_code: `port_${outcome.code}`, error: `端口分配失败：${outcome.code}` };
      }
      return {
        ok: true,
        note: `lease ${outcome.result.leaseId} = ${outcome.result.port}${outcome.result.reused ? "（续用）" : ""}`,
        sideEffect: {
          kind: "lease",
          node_id: nodeId,
          port: outcome.result.port,
          handle: outcome.result.leaseId,
          owned_by_rollout: preexistingActiveLeaseId !== outcome.result.leaseId,
        },
      };
    }

    case "ensure_binding": {
      // §13.3.1：Binding 是显式创建的可复用基础设施关系；修改 Forward 不删它。
      // 这里已由 `binding_exists === false` 作为入步骤条件，因此 create 是
      // 新建而非 upsert；重复执行撞 @@unique 时按「已存在」算成功（幂等）。
      //
      // 远端出口腿没有本机出口节点 ⇒ 没有可建的 Binding。跨面板那一跳
      // 的许可由 host 的 grant 决定（契约 §3.1），不是本机节点间的 Binding。
      if (federatedEgressPeerOf(ctx.desired) !== null) {
        return { ok: true, note: "远端出口腿：跳过本机 NodeBinding（跨面板那一跳由 host 的 grant 授权）" };
      }
      const ingressId = Number(step.meta?.ingress_node_id ?? nodeId);
      const egressId = Number(step.meta?.egress_node_id ?? nodeId);
      if (!Number.isFinite(ingressId) || !Number.isFinite(egressId)) {
        return { ok: false, error_code: "invariant_violated", error: "ensure_binding 缺少 pair" };
      }
      try {
        await deps.db.nodeBinding.create({
          data: { ingress_node_id: ingressId, egress_node_id: egressId },
        });
      } catch {
        // 可能已被别处建好（§13.3.1 允许多 Forward 复用同一 pair）。
        const existing = (await deps.db.nodeBinding.findUnique({
          where: {
            ingress_node_id_egress_node_id: {
              ingress_node_id: ingressId,
              egress_node_id: egressId,
            },
          },
        })) as { id: number } | null;
        if (!existing) {
          return { ok: false, error_code: "binding_create_failed", error: "NodeBinding 创建失败" };
        }
        return { ok: true, note: `binding ${existing.id} 已存在（幂等续用）` };
      }
      return {
        ok: true,
        sideEffect: {
          kind: "binding",
          node_id: egressId,
          port: null,
          handle: { ingress_node_id: ingressId, egress_node_id: egressId },
        },
      };
    }

    case "prepare_egress": {
      // 声明了远端 peer 时，这一跳**不走**本机 `dispatchEgress`，
      // 而是委托给承载方（预留 → 应用 → 镜像行），拿它返回的地址当下一跳。
      if (federatedEgressPeerOf(ctx.desired) !== null) {
        return delegateRemoteEgressStep(ctx, deps);
      }
      // §13.3.5 铁律：EGRESS 先 apply、ACK 后**不切入口**（入口由 CUTOVER 的
      // cutover_ingress 负责）。因此这里只做 egress 侧下发。
      if (nodeId == null) {
        return { ok: false, error_code: "invariant_violated", error: "prepare_egress 缺少 node" };
      }
      const egressPort = resolveEgressPort(step, ctx);
      if (egressPort <= 0) {
        return { ok: false, error_code: "invariant_violated", error: "prepare_egress 无法解析出口端口" };
      }
      const targets = ctx.desired.egress_targets ?? [];
      const egressFacts = await dispatchFactsFor(ctx.tunnelId, deps.db);
      if (egressFacts === null) {
        return {
          ok: false,
          error_code: "unsupported_protocol",
          error: "该转发使用的协议尚未进入当前 runtime 白名单（或缺少该协议必需的配置），拒绝下发出口",
        };
      }
      const outcome = await orchestrator.dispatchEgress({
        tunnelId: ctx.tunnelId,
        revision: ctx.revision,
        egressNode: nodeFor(orchestrator, nodeId),
        egressPort,
        poolId: ctx.desired.egress_pool_id,
        targets: targets.map((t) => ({ host: t.host, port: t.port, weight: t.weight, order_by: t.order_by })),
        protocol: egressFacts.protocol,
        tlsCertPath: egressFacts.tlsCertPath,
        tlsKeyPath: egressFacts.tlsKeyPath,
        // V5.1b : the datagram exit attests its ingress. Derived once, in the
        // dispatch facts, so both legs of the hop name the same address.
        hopPeer: egressFacts.hopPeer,
      });
      if (!outcome.ok) {
        return { ok: false, error_code: outcome.error_code, error: outcome.error };
      }
      // 登记 next_hop 的 host 段：cutover_ingress 要拼 `<egress host>:<egress port>`。
      // 只认 dispatchEgress 返回的 egress_host（它对「这台节点实际可寻址地址」
      // 做了判定），**不猜 IP**——猜错就是每个新连接都连不上的静默故障。
      recordNextHop(ctx.rolloutId, nodeId, outcome.egress_host);
      return {
        ok: true,
        note: `egress ${nodeId}:${egressPort} applied（未切入口）`,
        sideEffect: { kind: "egress_apply", node_id: nodeId, port: egressPort, handle: null },
      };
    }

    /* ---------------- CUTOVER ---------------- */

    case "cutover_egress": {
      // 同节点只换目标池时，PREPARE 没有 egress 步，出口侧的"按新
      // revision 生效"就发生在 CUTOVER。远端腿走同一条幂等委托：同一
      // `(intent_id, revision)` 在 host 侧返回首次结果，host 复用 epoch。
      if (federatedEgressPeerOf(ctx.desired) !== null) {
        return delegateRemoteEgressStep(ctx, deps);
      }
      // 出口侧「此刻起按新 revision 生效」的标记。Agent 侧 egress 已在
      // PREPARE apply，这里做的是把入口的 next_hop 指向它之前的那一步：
      // 若 PREPARE 已 apply 同 revision，此处是幂等重发（Agent 按 revision
      // 三态收敛，同 revision ⇒ no-op）。
      if (nodeId == null) {
        return { ok: false, error_code: "invariant_violated", error: "cutover_egress 缺少 node" };
      }
      const egressPort = resolveEgressPort(step, ctx);
      if (egressPort <= 0) {
        return { ok: false, error_code: "invariant_violated", error: "cutover_egress 无法解析出口端口" };
      }
      const targets = ctx.desired.egress_targets ?? [];
      const egressFacts = await dispatchFactsFor(ctx.tunnelId, deps.db);
      if (egressFacts === null) {
        return {
          ok: false,
          error_code: "unsupported_protocol",
          error: "该转发使用的协议尚未进入当前 runtime 白名单（或缺少该协议必需的配置），拒绝下发出口",
        };
      }
      const outcome = await orchestrator.dispatchEgress({
        tunnelId: ctx.tunnelId,
        revision: ctx.revision,
        egressNode: nodeFor(orchestrator, nodeId),
        egressPort,
        poolId: ctx.desired.egress_pool_id,
        targets: targets.map((t) => ({ host: t.host, port: t.port, weight: t.weight, order_by: t.order_by })),
        protocol: egressFacts.protocol,
        tlsCertPath: egressFacts.tlsCertPath,
        tlsKeyPath: egressFacts.tlsKeyPath,
        // V5.1b : the datagram exit attests its ingress. Derived once, in the
        // dispatch facts, so both legs of the hop name the same address.
        hopPeer: egressFacts.hopPeer,
      });
      if (!outcome.ok) {
        return { ok: false, error_code: outcome.error_code, error: outcome.error };
      }
      return { ok: true, note: `egress ${nodeId}:${egressPort} 生效于 revision ${ctx.revision}` };
    }

    case "handoff_ingress_owner": {
      if (nodeId == null || ctx.applied == null) {
        return {
          ok: false,
          error_code: "invariant_violated",
          error: "handoff_ingress_owner 缺少旧入口节点或 applied snapshot",
        };
      }

      // 两阶段交接：先确认旧 client-facing runtime 已经撤下，再把 ownership
      // lease 显式置为到期。绝不能反过来，否则旧 Agent 仍可能按它手里的
      // lease_expires_at 继续服务，而新 Agent 已经能 claim —— 这就是双主窗口。
      const direction = ctx.applied.mode === "direct" ? "direct" : "ingress";
      const removed = await orchestrator.removeTunnel({
        tunnelId: ctx.tunnelId,
        node: nodeFor(orchestrator, nodeId),
        direction,
        // 旧 runtime 当前最多是 base revision；用目标 revision 即可单调前进。
        // 不用 revision+1：若后续新入口 cutover 失败，补偿会用 revision+1
        // 恢复旧入口；这里若提前占掉 +1，回滚会被 Agent 判 equal/stale。
        revision: ctx.revision,
        reason: `rollout ${ctx.rolloutId} ingress ownership handoff`,
      });
      if (!removed.ok) {
        return { ok: false, error_code: removed.error_code, error: removed.error };
      }

      const released = await orchestrator.releaseOwnership({
        tunnelId: ctx.tunnelId,
        nodeId,
        now: deps.now?.() ?? new Date(),
      });
      if (!released.ok && released.reason !== "not_found") {
        return {
          ok: false,
          error_code: "ownership_release_failed",
          error: `旧入口 ${nodeId} ownership 释放失败：${released.reason}`,
        };
      }

      return {
        ok: true,
        note: `old ingress ${nodeId} 已撤下，ownership 已释放，允许新入口认领`,
      };
    }

    case "cutover_ingress": {
      const ingressNodeId = nodeId;
      if (ingressNodeId == null) {
        return { ok: false, error_code: "invariant_violated", error: "cutover_ingress 缺少 node_id" };
      }
      const port = resolveIngressPort(step, ctx);

      if (ctx.desired.mode === "relay") {
        const remotePeer = federatedEgressPeerOf(ctx.desired);
        const egressNodeId = ctx.desired.egress_node_id;
        // 出口腿在远端时本机**没有**出口节点，这不是"缺出口"——
        // next_hop 由 host 的响应决定（见 resolveNextHop 的联邦分支）。
        if ((egressNodeId == null && remotePeer === null) || step.direction === "egress") {
          return { ok: false, error_code: "invariant_violated", error: "RELAY cutover 缺少出口节点" };
        }
        // next_hop 由 PREPARE 里 dispatchEgress 的返回值决定；重放时 egress
        // 已在目标 revision，Agent 侧同 revision ⇒ 幂等 no-op。
        const nextHop = resolveNextHop(ctx);
        if (!nextHop) {
          return {
            ok: false,
            error_code: "next_hop_unresolved",
            error: "RELAY 入口切换前无法解析 next_hop（出口未就绪）",
          };
        }
        // /G0: a cutover issues a real command, so it carries the
        // Forward's persisted protocol instead of letting the orchestrator
        // default an absent one to tcp.
        const ingressFacts = await dispatchFactsFor(ctx.tunnelId, deps.db);
        if (ingressFacts === null) {
          return {
            ok: false,
            error_code: "unsupported_protocol",
            error: "该转发使用的协议尚未进入当前 runtime 白名单（或缺少该协议必需的配置），拒绝切换",
          };
        }
        const outcome = await orchestrator.dispatchIngress({
          tunnelId: ctx.tunnelId,
          revision: ctx.revision,
          ingressNode: nodeFor(orchestrator, ingressNodeId),
          ingressPort: port,
          nextHop,
          protocol: ingressFacts.protocol,
          tlsCertPath: ingressFacts.tlsCertPath,
          tlsKeyPath: ingressFacts.tlsKeyPath,
        });
        if (!outcome.ok) {
          return { ok: false, error_code: outcome.error_code, error: outcome.error };
        }
        return { ok: true, note: `ingress ${ingressNodeId}:${port} → ${nextHop}` };
      }

      // DIRECT：纯 target 热换时同 listener（§13.3.4「旧 TCP 连接继续」）。
      if (!ctx.desired.target_host || !ctx.desired.target_port) {
        return { ok: false, error_code: "invalid_target", error: "DIRECT cutover 缺少目标" };
      }
      const directFacts = await dispatchFactsFor(ctx.tunnelId, deps.db);
      if (directFacts === null) {
        return {
          ok: false,
          error_code: "unsupported_protocol",
          error: "该转发使用的协议尚未进入当前 runtime 白名单（或缺少该协议必需的配置），拒绝切换",
        };
      }
      const outcome = await orchestrator.dispatchDirect({
        tunnelId: ctx.tunnelId,
        revision: ctx.revision,
        ingressNode: nodeFor(orchestrator, ingressNodeId),
        ingressPort: port,
        remoteHost: ctx.desired.target_host,
        remotePort: ctx.desired.target_port,
        listenHost: ctx.desired.listen_ip,
        protocol: directFacts.protocol,
        tlsCertPath: directFacts.tlsCertPath,
        tlsKeyPath: directFacts.tlsKeyPath,
      });
      if (!outcome.ok) {
        return { ok: false, error_code: outcome.error_code, error: outcome.error };
      }
      return { ok: true, note: `direct ${ingressNodeId}:${port} → ${ctx.desired.target_host}:${ctx.desired.target_port}` };
    }

    /* ---------------- DRAIN ---------------- */

    case "drain_ingress":
    case "drain_egress": {
      // 旧出口腿在**远端**时，本机没有它的 runtime 可撤 —— 那条腿的
      // 停服就是 CLEANUP 里的 `drop_old_egress` 发出的 `DELETE /leases/:ref`。
      // 这里若照旧报 invariant_violated，会把一次正常的"远端出口撤下"变成
      // DRAIN 硬失败（整条 rollout 落到 degraded）。
      if (step.kind === "drain_egress" && nodeId == null && appliedRemoteEgressPeer(ctx) !== null) {
        return { ok: true, note: `远端出口腿（peer=${appliedRemoteEgressPeer(ctx)}）的停服在 CLEANUP 由 DELETE /leases 完成` };
      }
      // 报告 R3：wire 上没有 drain 原语，backend 用 `remove_tunnel` 表达
      // 「停止接受新连接后等待在途退出」（tunnel-api.ts#suspend 同一表达）。
      if (nodeId == null) {
        return { ok: false, error_code: "invariant_violated", error: "drain 缺少 node_id" };
      }
      const outcome = await orchestrator.removeTunnel({
        tunnelId: ctx.tunnelId,
        node: nodeFor(orchestrator, nodeId),
        direction:
          step.kind === "drain_egress"
            ? "egress"
            : ctx.applied?.mode === "direct"
              ? "direct"
              : "ingress",
        // 撤旧用 revision+1：让 Agent 的 stale 闸门放行（orchestrator.ts 注释）。
        revision: ctx.revision + 1,
        reason: `rollout ${ctx.rolloutId} drain ${step.kind}`,
      });
      if (!outcome.ok) {
        // §13.3.5：drain 失败只记 warning，在途连接由 kernel 超时兜底。
        return { ok: false, soft: true, error_code: outcome.error_code, error: outcome.error };
      }
      return { ok: true, note: `${step.kind} ${nodeId} 已退场` };
    }

    /* ---------------- CLEANUP ---------------- */

    case "release_old_lease": {
      if (nodeId == null) {
        return { ok: false, error_code: "invariant_violated", error: "release_old_lease 缺少 node_id" };
      }

      // 同节点 listener move 的旧 runtime 由 Agent ReplaceListener 自己 retire。
      // cutover ACK 只保证“新 listener 已上线”，旧 forwarder 的 Stop/drain 仍在
      // Agent 后台进行，最长 3s。不能对同 logical resource 再发 remove_tunnel，
      // 也不能立刻释放 backend durable lease；否则下一次分配可能撞 Agent 仍持有
      // 的旧端口 guard。
      const sameNodeListenerMove =
        step.direction === "ingress" &&
        ctx.applied != null &&
        ctx.applied.ingress_node_id === ctx.desired.ingress_node_id &&
        ctx.applied.listen_port != null &&
        ctx.desired.listen_port != null &&
        ctx.applied.listen_port !== ctx.desired.listen_port &&
        step.port === ctx.applied.listen_port;
      if (sameNodeListenerMove) {
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        await sleep(SAME_NODE_LISTENER_RETIRE_WAIT_MS);
      }
      // 幂等：releaseLease 对已 released 的租约是 no-op（portPool.ts 注释）。
      //
      // 必须按**本步骤要释放的那一条**旧 lease 定位，不能传 `{ tunnelId, nodeId }`：
      // portPool.releaseLease 只实现 {leaseId} / {tunnelId} / {nodeId} 三种键，
      // 没有组合语义——同时带 tunnelId 与 nodeId 时命中的是 tunnelId 分支，
      // 它把 nodeId 静默丢掉，`updateMany({ tunnel_id, status: 'active' })` 会
      // 释放该 tunnel 下**所有** active lease，包括本轮 PREPARE 刚 acquirePort
      // 拿到的新端口 lease。后果是 cutover 已生效、applied_revision 已前进，
      // 而新端口的 durable lease 却已回收 ⇒ 账本与 runtime 不一致，且下一次
      // 分配命中该端口时不会发现占用 ⇒ 双绑风险。
      // 与下面 releasePrepared 的补偿口径一致：补偿也用 { leaseId }。
      //
      // `step.port` 是计划期从 applied.listen_port 写死的旧端口（planRollout
      // 的 `push(..., { port: applied?.listen_port ?? null })`）。极端情况下
      // 没有 port ⇒ 定位不到具体旧 lease ⇒ 不再假装精确释放，直接退回
      // 修正前的口径，让 caller 的记账保持可解释（而不是静默全部释放）。
      const oldLeaseRows = (await deps.db.nodePortLease.findMany({
        where: {
          node_id: nodeId,
          ...(step.port != null ? { port: step.port } : {}),
          tunnel_id: ctx.tunnelId,
          status: "active",
        },
        select: { id: true },
      })) as Array<{ id: number }>;
      // 取第一条：同 (node, port) 的 lease 在该节点端口区间内唯一。
      const releaseTransitLease =
        step.port == null &&
        step.meta?.reason === "transit_changed" &&
        oldLeaseRows.length === 1;
      const oldLeaseId: number | null =
        (step.port != null || releaseTransitLease) && oldLeaseRows.length > 0
          ? oldLeaseRows[0]!.id
          : null;

      // 旧 rollout 行重放时那一条可能已被释放：这时回退到按 tunnelId 释放，
      // 不因差一行而让整个 rollout 判失败（§13.3.5 CLEANUP 是尽力而为）。
      // 找不到 active 的旧 lease = 它已经被之前一轮 CLEANUP/reconciler 回收。
      // 这是幂等成功，不得退回按 tunnelId 全量释放：那会把 PREPARE 刚拿到、
      // 当前 runtime 正在使用的新端口 lease 一并释放，制造账本/runtime 分叉。
      if (oldLeaseId === null) {
        await releaseStalePlacementLease(deps, ctx, nodeId);
        return { ok: true, note: `lease ${nodeId}:${step.port ?? "?"} 已释放（幂等）` };
      }
      const released = await releaseLease({ leaseId: oldLeaseId }, { db: deps.db as never });
      await releaseStalePlacementLease(deps, ctx, nodeId);
      return {
        ok: true,
        note: released
          ? `lease ${nodeId}:${step.port ?? "?"} released`
          : `lease ${nodeId}:${step.port ?? "?"} 已释放（幂等）`,
      };
    }

    case "drop_old_egress":
    case "drop_old_transit": {
      if (nodeId == null) {
        // 这条旧出口腿在远端 ⇒ 撤它的唯一正确动作是**释放远端租约**。
        // 顺序按契约 §3.3「先本地入口停 → 再远端释放」：CLEANUP 发生在入口已经
        // 切到新 next_hop（或已撤下）之后，所以这里正是那一刀。
        //
        // intent_id 用 **applied 那一代** revision（`base_revision`）：租约是按
        // 那一代的键建的，用别的键去释放会释错人。
        if (step.kind === "drop_old_egress" && appliedRemoteEgressPeer(ctx) !== null) {
          const revision = ctx.baseRevision ?? ctx.revision;
          const released = await releaseRemoteEgressStep(ctx, deps, revision);
          if (!released.ok) {
            // 释放失败必须留下痕迹，且**不得**假装成功：远端残留 runtime/端口就是
            // G4 的同族泄漏，只是它发生在另一台面板上，更不容易被看见。
            return {
              ok: false,
              error_code: "federation_release_failed",
              error: `远端出口腿释放失败（intent=fw-${ctx.tunnelId}-${revision}）：${released.message}`,
            };
          }
          return { ok: true, note: `远端出口腿（intent=fw-${ctx.tunnelId}-${revision}）${released.message}` };
        }
        return { ok: false, error_code: "invariant_violated", error: `${step.kind} 缺少 node_id` };
      }
      const outcome = await orchestrator.removeTunnel({
        tunnelId: ctx.tunnelId,
        node: nodeFor(orchestrator, nodeId),
        direction: "egress",
        // revision+1：同 removeTunnel 的补偿口径，重复执行幂等。
        revision: ctx.revision + 1,
        reason: `rollout ${ctx.rolloutId} ${step.kind === "drop_old_transit" ? "drop old transit" : "drop old egress"}`,
      });
      if (!outcome.ok) {
        // §13.3.5：CLEANUP 失败只记 degraded，不影响已生效的新 revision。
        return { ok: false, soft: true, error_code: outcome.error_code, error: outcome.error };
      }
      return {
        ok: true,
        note: step.kind === "drop_old_transit"
          ? `old transit ${nodeId} 已撤下`
          : `old egress ${nodeId} 已撤下`,
      };
    }

    /* ---------------- VALIDATE（无副作用）---------------- */

    case "validate":
      return { ok: true, note: "validate（计划期已判定）" };

    /* ---------------- 中间跳（）---------------- */

    case "prepare_transit": {
      // 中间跳与出口跳是**同一个原语**（一个监听 + 拨号到"目标"的转发），区别只在目标是谁：
      // 出口指向真实目标池，中间跳指向**下一跳的节点间监听地址**。
      //
      // 正向先远后近 ⇒ 轮到这里时下一跳（出口）已经发过，它的可寻址 host 已登记；因此这里
      // 用与入口同样的 `resolveNextHop`：不猜 IP，只用 dispatch 返回的地址。
      const middleNodeId = nodeId;
      if (middleNodeId == null) {
        return { ok: false, error_code: "invariant_violated", error: "prepare_transit 缺少 node_id" };
      }
      if (ctx.desired.mode !== "relay") {
        return { ok: false, error_code: "invariant_violated", error: "只有 RELAY 路由才有中间跳" };
      }
      const port = resolveIngressPort(step, ctx);
      // 中间跳的下一跳**就是出口跳**（三跳的上限决定了中间跳最多一个）。这里不能用
      // `resolveNextHop`：那是"入口的下一跳"，在有三跳时指向中间跳自己。
      const egressNodeId = ctx.desired.egress_node_id;
      const nextHop = egressNodeId == null ? null : resolveHopAddress(ctx, egressNodeId, ctx.desired.egress_port ?? null);
      if (!nextHop) {
        return {
          ok: false,
          error_code: "next_hop_unresolved",
          error: `中间跳 ${middleNodeId} 无法解析下一跳（出口）地址：出口未就绪`,
        };
      }
      // 协议事实与其它真实命令一样必须过 runtime 闸门（A1/A2 的 tls/ws 靠的就是这里）。
      const transitFacts = await dispatchFactsFor(ctx.tunnelId, deps.db);
      if (transitFacts === null) {
        return {
          ok: false,
          error_code: "unsupported_protocol",
          error: "该转发使用的协议尚未进入当前 runtime 白名单（或缺少该协议必需的配置），拒绝中间跳",
        };
      }
      // 中间跳只有**一份实现**（`Orchestrator.dispatchTransit`）：创建路径也用它。
      const transit = await orchestrator.dispatchTransit({
        tunnelId: ctx.tunnelId,
        revision: ctx.revision,
        node: nodeFor(orchestrator, middleNodeId),
        port,
        nextHop,
        protocol: transitFacts.protocol,
      });
      if (!transit.ok) {
        return { ok: false, error_code: transit.error_code, error: transit.error };
      }
      // 登记中间跳的可寻址 host：入口的 cutover 会用它拼 next_hop。
      recordNextHop(ctx.rolloutId, middleNodeId, transit.host);
      return { ok: true, note: `transit ${middleNodeId}:${port} → ${nextHop}` };
    }

    default: {
      const exhaustive: never = step.kind;
      return { ok: false, error_code: "invariant_violated", error: `未知步骤：${String(exhaustive)}` };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 节点解析辅助                                                        */
/* ------------------------------------------------------------------ */

/**
 * 从 ctx 里已有的节点事实合成一个 `OrchestratorNode`。
 *
 * 为什么不直接读 DB：DRAIN/CLEANUP 操作的**旧**节点可能已经被用户删掉，
 * 那时读库拿不到 Node 行，而 `removeTunnel` 只需要 `id/node_id/connect_ip`
 * 就能发命令（并会因为不可达快速失败）。旧节点没有 role 信息 ⇒ 传 null，
 * orchestrator 只是把它塞进 payload。
 */
/**
 * 从节点索引里取 `OrchestratorNode`；索引里没有（旧节点已删、或 drain
 * 的是本轮回迁之外的节点）时给一个最小可用形态。
 *
 * 注意**不按方向区分** 节点索引是 id → Node 的映射，同一台 BOTH 节点无论
 * 当 ingress 还是 egress 都是同一行。方向只影响 `removeTunnel` 拼哪个
 * tunnel id（`-relay` / `-egress` / `-direct`），那由 direction 参数自己决定。
 */
/**
 * The admitted protocol of an existing Forward (/G0).
 *
 * Rollout steps issue real commands to real Agents, so they must carry the
 * Forward's protocol fact instead of letting the orchestrator default to tcp —
 * a historical non-TCP Forward would otherwise be "cut over" as TCP. `null` means
 * the fact is not runnable, and the step refuses instead of dispatching.
 */
/**
 * The dispatch facts of an existing Forward: protocol + whatever that protocol
 * needs (today: the tls certificate paths).
 *
 * Reading them together is the point. G1A found this the hard way: after `tls`
 * arrived, this function returned only the protocol, so every hot reload of a
 * tls Forward failed at `Orchestrator.tlsFields` ("missing certificate paths")
 * while create and restore worked — a dispatch path that knew the protocol but
 * not its required configuration.
 */
async function dispatchFactsFor(
  tunnelId: number,
  store: RolloutDeps["db"],
): Promise<DispatchFacts | null> {
  // Read through the INJECTED store, never the process-wide singleton: this
  // module is exercised offline with a stub, and reaching for `db` directly made
  // every rollout test fail with "db.tunnel.findUnique is not a function".
  const handle = store as unknown as {
    tunnel?: { findUnique?: (args: unknown) => Promise<unknown> };
  };
  const findUnique = handle?.tunnel?.findUnique;
  if (!findUnique) return null;
  const row = (await findUnique({
    where: { id: tunnelId },
    select: {
      forward_protocol: true,
      tunnel_type: true,
      tls_cert_path: true,
      tls_key_path: true,
      // V5.1b : the datagram exit's attestation address comes from the
      // INGRESS node, so the facts read it here. Every dispatch site that already
      // uses this helper therefore gets `hopPeer` without re-deriving it — two
      // sites deriving it is how the two legs would name different addresses.
      //
      // `state_report` rides along because the address that is actually TRUE is the
      // one the ingress reported using (`hop_local_addr`), not its `connect_ip`:
      // on a multi-homed node those differ, and using `connect_ip` made the exit
      // drop every hop packet.
      ingress_node: { select: { connect_ip: true, state_report: { select: { tunnels: true } } } },
    },
  })) as {
    forward_protocol?: unknown;
    tunnel_type?: unknown;
    tls_cert_path?: unknown;
    tls_key_path?: unknown;
    ingress_node?: { connect_ip?: unknown; state_report?: { tunnels?: unknown } | null } | null;
  } | null;
  return row
    ? dispatchFactsFromRow({ ...row, ingress_runtime_id: Orchestrator.relayTunnelId(tunnelId) })
    : null;
}

function nodeFor(orchestrator: Orchestrator, nodeId: number): Parameters<Orchestrator["removeTunnel"]>[0]["node"] {
  const rec = nodeIndex.get(orchestrator)?.get(nodeId);
  return rec ?? { id: nodeId, node_id: String(nodeId), connect_ip: null, role: null };
}

/**
 * 一次 rollout 执行期间解析出的节点表（id → OrchestratorNode）。
 *
 * 通过 WeakMap 挂在 orchestrator 上而不是放进 ctx：`resumeRollouts` 会对
 * 同一个 orchestrator 反复建 ctx，节点解析结果可以跨 rollout 复用；而
 * ctx 本身是每次执行重建的，放进去等于每次都重查。
 */
const nodeIndex = new WeakMap<Orchestrator, Map<number, Parameters<Orchestrator["removeTunnel"]>[0]["node"]>>();

/** 供 register 阶段登记的入口：把本轮涉及的节点写进索引。 */
export function indexRolloutNodes(
  orchestrator: Orchestrator,
  nodes: Array<Parameters<Orchestrator["removeTunnel"]>[0]["node"]>,
): void {
  const map = nodeIndex.get(orchestrator) ?? new Map();
  for (const n of nodes) map.set(n.id, n);
  nodeIndex.set(orchestrator, map);
}

/** ingress 端口：step 优先，其次本轮回迁的 lease，最后 desired。 */
function resolveIngressPort(step: RolloutStep, ctx: RolloutExecContext): number {
  if (step.port != null) return step.port;
  const fromLease = ctx.prepared.find(
    (p) => p.kind === "lease" && p.node_id === (step.node_id ?? ctx.desired.ingress_node_id) && p.port != null,
  );
  if (fromLease?.port != null) return fromLease.port;
  return ctx.desired.listen_port ?? 0;
}

/** egress 端口与 ingress 同义：snapshot 可为 auto(null)，以本轮 lease 为准。 */
function resolveEgressPort(step: RolloutStep, ctx: RolloutExecContext): number {
  if (step.port != null) return step.port;
  const nodeId = step.node_id ?? ctx.desired.egress_node_id;
  const fromApply = ctx.prepared.find(
    (p) => p.kind === "egress_apply" && p.node_id === nodeId && p.port != null,
  );
  if (fromApply?.port != null) return fromApply.port;
  const fromLease = ctx.prepared.find(
    (p) => p.kind === "lease" && p.node_id === nodeId && p.port != null,
  );
  if (fromLease?.port != null) return fromLease.port;
  return ctx.desired.egress_port ?? 0;
}

/** `<egress ip>:<egress port>`；解析不到 ⇒ null ⇒ cutover_ingress 拒绝执行。 */
/**
 * 解析**某一跳**的节点间可寻址地址（`host:port`）。
 *
 * 只允许从**已登记**的节点事实里取 host（`recordNextHop` 的产物，来自那台节点自己的
 * dispatch 返回值）—— 不猜 IP：猜错就是"每个新连接都连不上"的静默故障。
 *
 * `fallbackPort` 只在那一跳没有自己的 lease/apply 登记时才用（单跳出口沿用了 historical
 * `desired.egress_port`），中间跳没有这个回落：它的端口必须来自计划期的 acquire_port。
 */
function resolveHopAddress(ctx: RolloutExecContext, nodeId: number, fallbackPort: number | null): string | null {
  const prepared = ctx.prepared.find((p) => p.kind === "egress_apply" && p.node_id === nodeId && p.port != null);
  const lease = ctx.prepared.find((p) => p.kind === "lease" && p.node_id === nodeId && p.port != null);
  const port = prepared?.port ?? lease?.port ?? fallbackPort ?? 0;
  if (port <= 0) return null;
  const host = nextHopHosts.get(ctx.rolloutId)?.get(nodeId);
  if (!host) return null;
  return `${host}:${port}`;
}

/**
 * 入口的 `next_hop` = **它的下一跳**。三跳时那不是出口，而是中间跳 —— 也就是"下一跳是谁"
 * 取决于路由形状，不能写死成 egress。判定依据是同一份放置事实（`middle_node_id`），
 * 与计划、准入、纯路由模型用的是同一个字段。
 */
function resolveNextHop(ctx: RolloutExecContext): string | null {
  // 出口腿在远端时，"下一跳是谁"由 **host 的应用响应**决定
  // （`node_address` + `port`）。本机没有那台节点的任何地址事实，所以这里
  // 只能读登记表；登记不到就返回 null，让 cutover_ingress 以
  // `next_hop_unresolved` fail-closed —— **绝不**猜 IP（猜错是每个新连接都
  // 连不上的静默故障，这个项目已经踩过一次）。
  const peer = federatedEgressPeerOf(ctx.desired);
  if (peer !== null) return remoteEgressAddressFor(ctx.tunnelId, peer);
  const middle = (ctx.desired as { middle_node_id?: number | null }).middle_node_id ?? null;
  const nextHopNodeId = middle ?? ctx.desired.egress_node_id;
  if (nextHopNodeId == null) return null;
  // 中间跳的端口必须来自它自己的 lease/apply；出口跳保留 historical 回落。
  return resolveHopAddress(ctx, nextHopNodeId, middle != null ? null : ctx.desired.egress_port ?? null);
}

/**
 * rolloutId → egressNodeId → 已解析的 egress host（dispatchEgress 的产物）。
 *
 * 为什么需要它：`cutover_ingress` 要拼 `<egress host>:<egress port>`，而 host
 * 只能来自 `dispatchEgress` 的返回值（它做过 `node_unaddressable` 判定）。
 * PREPARE 与 CUTOVER 之间隔着一次进程重启也成立——因为 key 是 rolloutId，
 * 而重放 PREPARE 的 `prepare_egress` 会在 cutover_ingress 之前被重放
 * （§3.5「续跑 = 重放未完成 steps」），重新 dispatch 一次就会重新登记。
 */
const nextHopHosts = new Map<number, Map<number, string>>();

/** 登记一次成功的 egress 下发出的 host（覆盖写：同 rollout 同节点只认最后一次）。 */
function recordNextHop(rolloutId: number, egressNodeId: number, host: string): void {
  const byRollout = nextHopHosts.get(rolloutId) ?? new Map<number, string>();
  byRollout.set(egressNodeId, host);
  nextHopHosts.set(rolloutId, byRollout);
}

/* ================================================================== */
/* 补偿（§3.4）                                                        */
/* ================================================================== */

/**
 * CUTOVER 失败后的回退。
 *
 * 顺序是 §3.4 的三步：
 *   1. 撤掉**本次已切过去的新** runtime（两端），用 `revision + 1` 让 Agent
 *      的 stale 闸门放行；
 *   2. 对 `base_revision` 的完整 snapshot 重新 dispatch；
 *   3. 分流：成功 ⇒ `apply_status=error` + `apply_error` 带 `rollout_id` 与
 *      `previous_revision`；失败 ⇒ `phase=degraded` + `compensation_error`。
 *
 * 第 2 步用**基线 revision 本身**（不是 +1）：Agent 的 `isStale(next,current)`
 * 判 `next < current` 才拒，同 revision 会让 `ReplaceListener` 判 equal ⇒
 * 幂等 no-op——「基线还在跑就别动它」正是要的行为。
 */
export async function compensateRollout(
  rolloutId: number,
  deps: RolloutDeps,
): Promise<{ ok: boolean; error?: string }> {
  const row = (await deps.db.forwardRollout.findUnique({ where: { id: rolloutId } })) as
    | (RolloutRowView & Record<string, unknown>)
    | null;
  if (!row) return { ok: false, error: `rollout ${rolloutId} 不存在` };

  const orchestrator = deps.orchestrator;
  const errors: string[] = [];

  // ① 撤新 runtime（两端）。revision+1 让闸门放行。
  // 用 plan 里存的 desired 快照，而不是重读 tunnel 行：补偿必须针对**本次
  // 尝试切过去的那个**拓扑，而 tunnel 行可能已被后续编辑改写。
  const removeRevision = row.revision + 1;
  const planned = planSnapshot(row.steps, "desired");
  const baselinePlanned = planSnapshot(row.steps, "applied");
  const plannedMiddle = (planned as { middle_node_id?: number | null }).middle_node_id ?? null;
  const removals: Array<{ direction: "direct" | "egress" | "ingress"; nodeId: number; isIngress?: boolean }> = [
    { direction: "egress", nodeId: planned.egress_node_id ?? 0 },
    {
      direction: planned.mode === "direct" ? "direct" : "ingress",
      nodeId: planned.ingress_node_id,
      isIngress: true,
    },
    // V5.4：中间跳也是"新 runtime"，也必须撤。它的形态与出口跳相同（监听 + 拨号到下一跳），
    // 因此方向同样是 `egress` —— runtime id 按节点分命名空间，中间跳与真出口不会互相覆盖。
    //
    // 漏掉它会留下一条**孤儿中转链路** 照旧监听端口、照旧接受连接，把流量转给一个已经被
    // 拆掉的下一跳。这类残留不报错，只静默占着端口与许可 —— 也正是 G4 明确要验的一项。
    { direction: "egress", nodeId: plannedMiddle ?? 0 },
  ];
  let plannedIngressRemoved = false;
  for (const { direction, nodeId, isIngress } of removals) {
    if (!nodeId) continue;
    const outcome = await orchestrator.removeTunnel({
      tunnelId: row.tunnel_id,
      node: nodeFor(orchestrator, nodeId),
      direction,
      revision: removeRevision,
      reason: `rollout ${rolloutId} compensation`,
    });
    if (!outcome.ok) {
      errors.push(`remove ${direction}: ${outcome.error}`);
    } else if (isIngress) {
      plannedIngressRemoved = true;
    }
  }

  // ──：本次尝试切过去的**新**远端出口腿也要撤 ──
  //
  // 它同样是"新 runtime"，只是不在本机；`removals` 只认本机节点。漏掉它会在另一个
  // 面板上留下一条继续监听、继续把流量转给旧目标的腿（G4 的同族泄漏），而且它在
  // 本机的账本里看起来"已经补偿完成"。
  const plannedPeer = federatedEgressPeerOf(planned);
  if (plannedPeer !== null) {
    const released = await releaseFederatedEgress(
      { tunnelId: row.tunnel_id, revision: row.revision, peer_panel_id: plannedPeer },
      { db: deps.db as never, sender: deps.federatedSender, now: deps.now },
    );
    if (!released.ok) {
      errors.push(`release remote egress (peer=${plannedPeer}, revision=${row.revision}): ${released.message ?? released.code}`);
    }
  }

  // 若目标入口曾经 claim 成功，但 apply/ACK 随后失败，ownership 仍会留在新节点。
  // 只有确认新入口 runtime 已撤下后才允许释放它；随后基线入口才能按新世代重新 claim。
  if (
    plannedIngressRemoved &&
    planned.ingress_node_id &&
    planned.ingress_node_id !== baselinePlanned.ingress_node_id
  ) {
    const released = await orchestrator.releaseOwnership({
      tunnelId: row.tunnel_id,
      nodeId: planned.ingress_node_id,
      now: deps.now?.() ?? new Date(),
    });
    // not_owner/not_found 代表失败发生在 claim 之前（ownership 仍在旧主人或从未存在），
    // 这两种都无需额外动作；真正异常会在后面的基线 replay 中继续暴露。
    if (!released.ok && released.reason !== "not_owner" && released.reason !== "not_found") {
      errors.push(`release planned ingress ownership: ${released.reason}`);
    }
  }

  /** 回滚世代（内容 = 基线）。null = 没有基线可回（首次部署失败：撤干净即正确）。 */
  let rollbackRevision: number | null = null;

  // ② 重放基线。base_revision 为 null ⇒ 没有旧 runtime 可回，只需要撤新的
  //    （首次部署失败的情形：撤干净即回到「没有 runtime」这个正确状态）。
  if (row.base_revision != null) {
    const baseline = (await deps.db.forwardRevision.findFirst({
      where: { tunnel_id: row.tunnel_id, revision: row.base_revision },
    })) as Record<string, unknown> | null;
    if (!baseline) {
      errors.push(`baseline snapshot revision=${row.base_revision} 不存在`);
    } else {
      // Rollback is a new generation carrying baseline content. Replaying an older
      // revision would violate the Agent's monotonic revision fence; reusing the
      // failed target revision would make revision identity disagree with content.
      const rollbackGeneration = Math.max(
        Number(row.base_revision),
        Number(row.revision ?? row.base_revision),
      ) + 1;
      rollbackRevision = rollbackGeneration;
      const { id: _snapshotId, revision: _snapshotRevision, ...baselineFields } = baseline as Record<string, unknown> & {
        id?: unknown;
        revision?: unknown;
      };
      // 新世代的快照必须存在，否则后续 rollout 按 revision 找基线会报"不存在"。
      await deps.db.forwardRevision
        .create({ data: { ...baselineFields, tunnel_id: row.tunnel_id, revision: rollbackGeneration } } as never)
        .catch((e: unknown) => {
          errors.push(`rollback snapshot revision=${rollbackGeneration} 写入失败：${(e as Error)?.message ?? String(e)}`);
        });
      const ingressNodeId = Number(baseline.ingress_node_id);
      const listenPort = baseline.listen_port == null ? null : Number(baseline.listen_port);
      if (!ingressNodeId || listenPort == null) {
        errors.push("baseline snapshot 缺 ingress_node_id / listen_port");
      } else if (String(baseline.mode) === "relay") {
        const baselinePeer = federatedEgressPeerOf(baselinePlanned);
        const egressPort = baseline.egress_port == null ? null : Number(baseline.egress_port);
        const egressNodeId = baseline.egress_node_id == null ? null : Number(baseline.egress_node_id);
        const targets = Array.isArray(baseline.targets)
          ? (baseline.targets as Array<{ host: string; port: number; weight?: number; order_by?: number }>)
          : [];
        const replayEgressFacts = await dispatchFactsFor(row.tunnel_id, deps.db);
        /**
         * 回滚后的出口事实（host + 监听端口）。
         *
         * 它可能来自两处 —— 本机 `dispatchEgress` 的返回值，或**远端
         * peer 的应用响应**。两条路的共同点是"地址只能来自承载方自己"，所以这里
         * 归一成一个变量，入口与中间跳的指向都只认它。
         */
        let replayEgressHost: string | null = null;
        let replayEgressPort: number | null = egressPort;

        if (replayEgressFacts === null) {
          errors.push(`replay egress: 协议未通过当前 runtime Gate（tunnel ${row.tunnel_id}）`);
        } else if (baselinePeer !== null) {
          // 基线本身是一条**远端**出口腿：回滚必须再委托一次（同一个 intent 键、
          // 新的世代号）。只撤新腿而不重建基线腿，会把入口指到一个本机并不存在的
          // 地址上 —— 表现为"回滚成功"但整条转发不通。
          const delegated = await delegateFederatedEgress(
            {
              tunnelId: row.tunnel_id,
              revision: rollbackRevision,
              declaredPeer: baselinePeer,
              mode: "relay",
              ingress_node_id: ingressNodeId,
              local_egress_node_id: null,
              middle_node_id: baseline.middle_node_id == null ? null : Number(baseline.middle_node_id),
              protocol: replayEgressFacts.protocol,
              targets: targets.map((t, i) => ({
                host: t.host,
                port: t.port,
                weight: t.weight ?? 1,
                order_by: t.order_by ?? (i + 1) * 10,
              })),
              lb_strategy: await loadEgressPoolLb(deps, baseline.egress_pool_id == null ? null : Number(baseline.egress_pool_id)),
            },
            { db: deps.db as never, sender: deps.federatedSender, now: deps.now },
          );
          if (!delegated.ok) {
            errors.push(`replay egress (federated ${baselinePeer}): ${delegated.message}`);
          } else if (delegated.next_hop === null) {
            // host 没给可寻址地址 ⇒ 不许猜，回滚只能报错（fail-closed）。
            errors.push(`replay egress (federated ${baselinePeer}): host 未返回可寻址 node_address`);
          } else {
            replayEgressHost = delegated.node_address;
            replayEgressPort = delegated.port;
          }
        } else if (egressPort == null || egressNodeId == null) {
          errors.push("baseline RELAY snapshot 缺出口");
        } else {
          const egress = await orchestrator.dispatchEgress({
            tunnelId: row.tunnel_id,
            revision: rollbackRevision,
            egressNode: nodeFor(orchestrator, egressNodeId),
            egressPort,
            poolId: baseline.egress_pool_id == null ? null : Number(baseline.egress_pool_id),
            targets: targets.map((t, i) => ({
              host: t.host,
              port: t.port,
              weight: t.weight ?? 1,
              order_by: t.order_by ?? (i + 1) * 10,
            })),
            protocol: replayEgressFacts.protocol,
            tlsCertPath: replayEgressFacts.tlsCertPath,
            tlsKeyPath: replayEgressFacts.tlsKeyPath,
            hopPeer: replayEgressFacts.hopPeer,
          });
          if (!egress.ok) {
            errors.push(`replay egress: ${egress.error}`);
          } else {
            replayEgressHost = egress.egress_host;
            replayEgressPort = egressPort;
          }
        }

        if (replayEgressFacts !== null && replayEgressHost !== null && replayEgressPort != null) {
            let ingressNextHop = `${replayEgressHost}:${replayEgressPort}`;
            const baselineMiddleId =
              baseline.middle_node_id == null ? null : Number(baseline.middle_node_id);

            // V5.4：如果基线本身是三跳，回滚也必须先恢复 middle，再让 ingress 指向它。
            // middle 的物理端口不复制进 snapshot；它仍由 NodePortLease 唯一持有。
            if (baselineMiddleId != null) {
              const leases = (await deps.db.nodePortLease.findMany({
                where: {
                  node_id: baselineMiddleId,
                  tunnel_id: row.tunnel_id,
                  status: "active",
                },
                select: { port: true },
              })) as Array<{ port: number }>;
              if (leases.length !== 1) {
                errors.push(
                  `replay transit: middle ${baselineMiddleId} active lease 数量=${leases.length}，无法唯一解析端口`,
                );
              } else {
                const transit = await orchestrator.dispatchTransit({
                  tunnelId: row.tunnel_id,
                  revision: rollbackRevision,
                  node: nodeFor(orchestrator, baselineMiddleId),
                  port: leases[0]!.port,
                  nextHop: `${replayEgressHost}:${replayEgressPort}`,
                  protocol: replayEgressFacts.protocol,
                });
                if (!transit.ok) {
                  errors.push(`replay transit: ${transit.error}`);
                } else {
                  ingressNextHop = `${transit.host}:${leases[0]!.port}`;
                }
              }
            }

            if (!errors.some((message) => message.startsWith("replay transit:"))) {
              const ingress = await orchestrator.dispatchIngress({
                tunnelId: row.tunnel_id,
                revision: rollbackRevision,
                ingressNode: nodeFor(orchestrator, ingressNodeId),
                ingressPort: listenPort,
                nextHop: ingressNextHop,
                // The same facts the egress leg just used: one Forward, one protocol.
                protocol: replayEgressFacts.protocol,
                tlsCertPath: replayEgressFacts.tlsCertPath,
                tlsKeyPath: replayEgressFacts.tlsKeyPath,
              });
              if (!ingress.ok) errors.push(`replay ingress: ${ingress.error}`);
            }
        }
      } else {
        const targetHost = (baseline.target_host as string | null) ?? null;
        const targetPort = baseline.target_port == null ? null : Number(baseline.target_port);
        if (!targetHost || targetPort == null) {
          errors.push("baseline DIRECT snapshot 缺 target");
        } else {
          // NOTE: `row` here is the ROLLOUT row; the protocol fact lives on the
          // TUNNEL row. Reading it off the rollout row would always look like "no
          // fact at all" and refuse every replay.
          const replayDirectFacts = await dispatchFactsFor(row.tunnel_id, deps.db);
          if (replayDirectFacts === null) {
            errors.push(`replay direct: 协议未通过当前 runtime Gate（tunnel ${row.tunnel_id}）`);
          } else {
            const ingress = await orchestrator.dispatchDirect({
              tunnelId: row.tunnel_id,
              revision: rollbackRevision,
              ingressNode: nodeFor(orchestrator, ingressNodeId),
              ingressPort: listenPort,
              remoteHost: targetHost,
              remotePort: targetPort,
              listenHost: (baseline.listen_ip as string | null) ?? null,
              protocol: replayDirectFacts.protocol,
              tlsCertPath: replayDirectFacts.tlsCertPath,
              tlsKeyPath: replayDirectFacts.tlsKeyPath,
            });
            if (!ingress.ok) errors.push(`replay direct: ${ingress.error}`);
          }
        }
      }
    }
  }

  // ③ 分流。
  if (errors.length === 0) {
    // ── 补偿成功后的记账（V5.3：回滚是**新世代**）──
    //
    // Terminal rollout state is only allowed after the Tunnel ledger converged.
    // Otherwise a failed DB write would leave phase=failed forever while the
    // durable runtime projection still describes the pre-compensation state.
    try {
      const updated = (await deps.db.tunnel.updateMany({
        where: { id: row.tunnel_id },
        data:
          rollbackRevision === null
            ? {
                apply_status: "error",
                apply_error_code: "cutover_failed_compensated",
                apply_error: `rollout ${rolloutId} 补偿完成：没有旧 runtime 可回（首次部署失败）`,
              }
            : {
                config_revision: rollbackRevision,
                applied_revision: rollbackRevision,
                apply_status: "active",
                apply_error_code: "rollback_compensated",
                apply_error:
                  `rollout ${rolloutId} 已回滚：内容 = revision ${row.base_revision ?? "none"}，` +
                  `新世代 = ${rollbackRevision}（回滚产生新世代，而不是原地重放旧版本号）`,
              },
      })) as { count?: number };
      if (updated.count === 0) throw new Error(`tunnel ${row.tunnel_id} rollback ledger row not found`);
    } catch (error) {
      const detail = `rollback ledger 写入失败：${error instanceof Error ? error.message : String(error)}`;
      await transitionRollout(
        rolloutId,
        "compensating",
        "degraded",
        {
          compensated: false,
          compensation_error: detail.slice(0, 2000),
          last_error_code: "compensation_failed",
          updated_at: (deps.now?.() ?? new Date()).toISOString(),
        },
        { db: deps.db },
      );
      return { ok: false, error: detail };
    }

    const moved = await transitionRollout(
      rolloutId,
      "compensating",
      "failed",
      {
        compensated: true,
        compensation_error: null,
        last_error_code: "cutover_failed_compensated",
        updated_at: (deps.now?.() ?? new Date()).toISOString(),
      },
      { db: deps.db },
    );
    if (!moved) return { ok: false, error: "compensation terminal transition lost CAS ownership" };
    return { ok: true };
  }

  await transitionRollout(
    rolloutId,
    "compensating",
    "degraded",
    {
      compensated: false,
      compensation_error: errors.join("; ").slice(0, 2000),
      last_error_code: "compensation_failed",
      updated_at: (deps.now?.() ?? new Date()).toISOString(),
    },
    { db: deps.db },
  );
  return { ok: false, error: errors.join("; ") };
}

/**
 * phase CAS 失败并不等于 rollout 失败：同步 PATCH 与 resume worker 可能同时
 * 续跑同一行。CAS 只负责选出当前执行器；输掉竞争的一方观察新状态后退出，
 * 不得把“已被别人接管”翻成 502 apply_failed。
 */
function concurrentTakeoverResult(
  rolloutId: number,
  fresh: RolloutRowView | null,
  fallbackCompleted: number,
): RolloutExecResult {
  if (!fresh) {
    return {
      ok: false, rolloutId, phase: "failed",
      error_code: "concurrent_transition",
      error: "rollout 状态已变化且无法重新读取",
      completed: fallbackCompleted,
    };
  }
  const completed = readKeySet(fresh.cleaned).length;
  if (fresh.phase === "done") return { ok: true, rolloutId, phase: "done", completed };
  if (fresh.phase === "failed" || fresh.phase === "degraded") {
    return {
      ok: false, rolloutId, phase: fresh.phase,
      error_code: fresh.last_error_code ?? "rollout_failed",
      error: fresh.last_error ?? "rollout 已由另一执行器推进到失败终态",
      completed, compensated: fresh.compensated,
    };
  }
  return {
    ok: false, rolloutId, phase: fresh.phase,
    error_code: "concurrent_transition",
    error: "rollout 已由另一执行器接管，等待收敛",
    completed,
  };
}

/* ================================================================== */
/* 单执行器 lease + runtime 事实确认                                    */
/* ================================================================== */

/**
 * 一条远程 ACK 最长等 15s；RELAY 补偿可能连续做多次远程操作。90s 足够当前
 * owner 完成一个阶段，又能让崩溃后的 worker 在 S10 的 180s 窗口内接管。
 */
export const ROLLOUT_EXECUTOR_LEASE_MS = 90_000;
/** Agent state report 周期 30s；多给 5s 抖动，先等事实再决定是否重发。 */
export const ROLLOUT_RUNTIME_CONFIRM_WAIT_MS = 35_000;
const ROLLOUT_RUNTIME_CONFIRM_POLL_MS = 1_000;
/**
 * Agent pipeTracker.Stop() 的 drainTimeout 是 3s。Same-node listener replacement
 * 在 ACK 前已经把新 listener 放进 registry，但旧 listener 的 Stop 在后台 goroutine
 * 中完成；backend 释放旧 durable lease 前多留 500ms 调度余量，避免旧 Agent
 * port guard 尚未释放时控制面把该端口重新分配出去。
 */
export const SAME_NODE_LISTENER_RETIRE_WAIT_MS = 3_500;

function asDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

async function claimRolloutExecutor(
  rolloutId: number,
  deps: RolloutDeps,
): Promise<{ token: string | null; row: RolloutRowView | null }> {
  const row = (await deps.db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
  if (!row) return { token: null, row: null };
  if (row.phase === "done" || row.phase === "failed" || row.phase === "degraded") {
    return { token: null, row };
  }

  const now = deps.now?.() ?? new Date();
  const observedOwner = row.executor_owner ?? null;
  const observedLease = row.executor_lease_until ?? null;
  const leaseDate = asDate(observedLease);
  if (observedOwner && leaseDate && leaseDate.getTime() > now.getTime()) {
    return { token: null, row };
  }

  const token = randomUUID();
  const leaseUntil = new Date(now.getTime() + ROLLOUT_EXECUTOR_LEASE_MS);
  // 对“刚才读到的 owner + lease + phase”做精确 CAS。两个 executor 即使同时
  // 读到 NULL，也只有一个能把 NULL→token；过期接管同理。
  const claimed = (await deps.db.forwardRollout.updateMany({
    where: {
      id: rolloutId,
      phase: row.phase,
      executor_owner: observedOwner,
      executor_lease_until: observedLease,
    },
    data: {
      executor_owner: token,
      executor_lease_until: leaseUntil,
    },
  })) as { count: number };

  return claimed.count > 0 ? { token, row } : { token: null, row };
}

async function renewRolloutExecutor(rolloutId: number, token: string, deps: RolloutDeps): Promise<boolean> {
  const now = deps.now?.() ?? new Date();
  const renewed = (await deps.db.forwardRollout.updateMany({
    where: { id: rolloutId, executor_owner: token },
    data: { executor_lease_until: new Date(now.getTime() + ROLLOUT_EXECUTOR_LEASE_MS) },
  })) as { count: number };
  return renewed.count > 0;
}

async function releaseRolloutExecutor(rolloutId: number, token: string, deps: RolloutDeps): Promise<void> {
  await deps.db.forwardRollout
    .updateMany({
      where: { id: rolloutId, executor_owner: token },
      data: { executor_owner: null, executor_lease_until: null },
    })
    .catch(() => {});
}

function runtimeResourceId(step: RolloutStep, ctx: RolloutExecContext): string | null {
  if (step.kind === "prepare_egress" || step.kind === "cutover_egress") {
    return Orchestrator.egressTunnelId(ctx.tunnelId);
  }
  if (step.kind === "cutover_ingress") {
    return ctx.desired.mode === "relay"
      ? Orchestrator.relayTunnelId(ctx.tunnelId)
      : Orchestrator.directTunnelId(ctx.tunnelId);
  }
  return null;
}

/**
 * ACK timeout 后优先问 Agent 最近一次**具体 resource** 自报，而不是再猜一次。
 * 只有同 node + 同 resource 的 revision >= desired 才算确认；绝不使用节点级
 * reported_revision（它是 max，可能来自别的 tunnel，会制造假阳性）。
 */
async function runtimeConfirmsStepApplied(
  step: RolloutStep,
  ctx: RolloutExecContext,
  deps: RolloutDeps,
): Promise<boolean> {
  const reader = deps.db.nodeStateReport?.findUnique;
  const nodeId = step.node_id;
  const resourceId = runtimeResourceId(step, ctx);
  if (!reader || nodeId == null || !resourceId) return false;

  const deadline = (deps.now?.() ?? new Date()).getTime() + ROLLOUT_RUNTIME_CONFIRM_WAIT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  while (true) {
    const snap = (await reader({
      where: { node_id: nodeId },
      select: { tunnels: true, reported_at: true },
    }).catch(() => null)) as { tunnels?: unknown; reported_at?: Date | string | null } | null;

    if (snap && Array.isArray(snap.tunnels)) {
      for (const raw of snap.tunnels) {
        if (!raw || typeof raw !== "object") continue;
        const tunnel = raw as Record<string, unknown>;
        if (String(tunnel.id ?? "") !== resourceId) continue;
        const revision = Number(tunnel.revision);
        // resource revision 单调递增；只要 >= desired，就已经是比任何 wall-clock
        // 更强的事实。不要再拿 rollout.updated_at/lease heartbeat 当 freshness 闸门。
        if (Number.isFinite(revision) && revision >= ctx.revision) return true;
      }
    }

    const nowMs = (deps.now?.() ?? new Date()).getTime();
    if (nowMs >= deadline) return false;
    await sleep(Math.min(ROLLOUT_RUNTIME_CONFIRM_POLL_MS, Math.max(0, deadline - nowMs)));
  }
}

/* ================================================================== */
/* 主执行循环                                                          */
/* ================================================================== */

/**
 * 续跑一条 rollout：按 {@link ROLLOUT_STAGE_SEQUENCE} 顺序重放未完成 steps。
 *
 * 「已完成」的判据只有 completed 幂等键集合——所以这个函数可以直接被
 * `resumeRollouts`（C5）反复调用，重复调用最多让已完成步骤再幂等跑一遍。
 */
export async function executeRollout(
  rolloutId: number,
  deps: RolloutDeps,
): Promise<RolloutExecResult> {
  const claimed = await claimRolloutExecutor(rolloutId, deps);
  if (!claimed.row) {
    return { ok: false, rolloutId, phase: "failed", error_code: "not_found", error: `rollout ${rolloutId} 不存在`, completed: 0 };
  }
  if (!claimed.token) {
    const row = claimed.row;
    if (row.phase === "done" || row.phase === "failed" || row.phase === "degraded") {
      return {
        ok: row.phase === "done",
        rolloutId,
        phase: row.phase,
        completed: readKeySet(row.cleaned).length,
        ...(row.phase === "done" ? {} : {
          error_code: row.last_error_code ?? "rollout_failed",
          error: row.last_error ?? undefined,
          compensated: row.compensated,
        }),
      };
    }
    return concurrentTakeoverResult(rolloutId, row, readKeySet(row.cleaned).length);
  }

  try {
    return await executeRolloutOwned(rolloutId, deps, claimed.token);
  } finally {
    await releaseRolloutExecutor(rolloutId, claimed.token, deps);
  }
}

async function executeRolloutOwned(
  rolloutId: number,
  deps: RolloutDeps,
  executorToken: string,
): Promise<RolloutExecResult> {
  const db = deps.db;
  const row = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as
    | (RolloutRowView & Record<string, unknown>)
    | null;
  if (!row) {
    return { ok: false, rolloutId, phase: "failed", error_code: "not_found", error: `rollout ${rolloutId} 不存在`, completed: 0 };
  }
  if (row.phase === "done" || row.phase === "failed" || row.phase === "degraded") {
    return { ok: row.phase === "done", rolloutId, phase: row.phase, completed: row.cleaned?.length ?? 0 };
  }

  // 崩溃若发生在「已切到 compensating、但补偿还没跑完」的窗口，恢复入口
  // 必须继续补偿，而不是把 compensating 伪装成 prepare。补偿动作本身按
  // revision/command_id 幂等，可以安全重放。
  if (row.phase === "compensating") {
    const comp = await compensateRollout(rolloutId, deps);
    return {
      ok: false,
      rolloutId,
      phase: comp.ok ? "failed" : "degraded",
      error_code: comp.ok ? (row.last_error_code ?? "cutover_failed_compensated") : "compensation_failed",
      error: comp.error ?? row.last_error ?? undefined,
      completed: readKeySet(row.cleaned).length,
      compensated: true,
    };
  }

  const plan = readPlan(row.steps);
  const completed = new Set(readKeySet(row.cleaned));
  if (!plan || !Array.isArray(plan.steps)) {
    return { ok: false, rolloutId, phase: "failed", error_code: "plan_missing", error: "rollout 行缺 plan", completed: 0 };
  }

  const desired = planSnapshot(plan, "desired");
  const applied = planSnapshot(plan, "applied");
  const prepared = readLedger<PreparedResource[]>(row.prepared, []);
  const ctx: RolloutExecContext = {
    rolloutId,
    tunnelId: row.tunnel_id,
    revision: row.revision,
    baseRevision: row.base_revision,
    desired,
    applied,
    plan,
    completed,
    prepared,
    // `notes` 是**追加式流水账** `transitionRollout` 写 `notes: ctx.notes` 时
    // 走的是 Prisma 的 `{ push }`，若此处重新置 []，第一次 patch 就会把上一轮
    // （崩溃前的阶段）落账抹掉，`§13.3.2` 要求「可追溯到本轮结束」就断了。
    // 因此必须从当前行读起；列为 NULL（迁移前存量行）时按空数组开始。
    notes: [...readLedger<string[]>(row.notes, [])],
  };

  const phases = ROLLOUT_STAGE_SEQUENCE;
  // waiting 是「上一次 remote step 的结果未知」，不是一个具体执行阶段。
  // 保留它作为当前 DB phase；循环遇到第一个未完成 step 时再原子地
  // waiting → step.phase。这样 PREPARE/CUTOVER 任一位置都能从断点恢复。
  let status: RolloutStatus = row.phase;
  const recoveringAmbiguous = row.phase === "waiting" && (
    row.last_error_code === "ack_timeout" || ctx.notes.some((note) => note.includes(" WAIT ack_timeout "))
  );

  for (const phase of phases) {
    const steps = plan.steps.filter((s) => s.phase === phase && !completed.has(s.idempotency_key));
    if (steps.length === 0) continue;

    if (status !== phase) {
      const moved = await transitionRollout(rolloutId, status, phase, {}, { db });
      // status 已被并发改动 ⇒ 重新读行（别用旧 completed 覆盖别人的进度）。
      if (!moved) {
        const fresh = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
        return concurrentTakeoverResult(rolloutId, fresh, completed.size);
      }
      status = phase;
    }

    for (const step of steps) {
      // owner 在每个可能产生副作用的 step 前续租；租约丢失 = 本执行器立即停手。
      if (!(await renewRolloutExecutor(rolloutId, executorToken, deps))) {
        const fresh = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
        return concurrentTakeoverResult(rolloutId, fresh, completed.size);
      }

      // : registration is not an authorization lease. Re-read CURRENT target
      // scope/capability before *each* lease/binding/command write, including a
      // recovered pending rollout. Blocking keeps the ledger recoverable and the
      // old applied runtime intact; do not turn denial into destructive rollback.
      // DRAIN/CLEANUP and compensation deliberately bypass this business-use gate.
      if (phase === "prepare" || phase === "cutover") {
        const denied = await rolloutRuntimeDenial(ctx.tunnelId, ctx.desired, deps);
        if (denied) {
          const code = denied.reason;
          const error = `[${denied.error_layer}] ${denied.message}`;
          ctx.notes.push(`${phase}:${step.kind} BLOCKED ${code} ${error}`);
          const moved = await transitionRollout(rolloutId, status, "waiting", {
            last_error_code: code,
            last_error: error.slice(0, 2000),
            notes: ctx.notes,
            updated_at: (deps.now?.() ?? new Date()).toISOString(),
          }, { db });
          if (!moved) {
            const fresh = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
            return concurrentTakeoverResult(rolloutId, fresh, completed.size);
          }
          await markTunnelFailed(ctx.tunnelId, code, error, db);
          return { ok: false, rolloutId, phase: "waiting", error_code: code, error, completed: completed.size };
        }
      }

      // S10.47：第一次 command 的 ACK 可能丢了，但 Agent 已真实应用。恢复时先用
      // state report 确认具体 resource 的 revision；确认后只补 ledger，不重发命令。
      if (recoveringAmbiguous && await runtimeConfirmsStepApplied(step, ctx, deps)) {
        const note = `${step.phase}:${step.kind} CONFIRMED runtime revision=${ctx.revision}`;
        await markStepCompleted(rolloutId, step.idempotency_key, { db });
        completed.add(step.idempotency_key);
        ctx.completed = completed;
        ctx.notes.push(note);
        continue;
      }

      const outcome = await runStep(step, ctx, { ...deps, db });
      if (outcome.ok) {
        await markStepCompleted(rolloutId, step.idempotency_key, { db });
        completed.add(step.idempotency_key);
        ctx.completed = completed;
        if (outcome.sideEffect) {
          await appendPrepared(rolloutId, outcome.sideEffect, { db });
          ctx.prepared.push(outcome.sideEffect);
        }
        if (outcome.note) ctx.notes.push(`${step.phase}:${step.kind} ${outcome.note}`);
        continue;
      }

      if (outcome.soft) {
        // DRAIN/CLEANUP 的软失败：记 warning 继续（§13.3.5）。
        ctx.notes.push(`${step.phase}:${step.kind} SOFT ${outcome.error_code} ${outcome.error}`);
        await markStepCompleted(rolloutId, step.idempotency_key, { db });
        completed.add(step.idempotency_key);
        ctx.completed = completed;
        continue;
      }

      /* ---------------- 失败分流（§13.3.5 第三张表）---------------- */

      // outbound-only transport 的 ACK timeout 是「结果未知」，不是「命令未执行」：
      // command 已经先写入 Redis 队列，信封 TTL 远长于同步 ACK 等待窗口；Agent
      // 恢复后仍可能执行这条命令。此时若立刻 compensation，会与迟到的原命令
      // 竞态，形成 runtime 已到新 revision、ledger 却 degraded 的 S10.47。
      //
      // 因此 PREPARE/CUTOVER 的 ack_timeout 统一停在 waiting，不释放
      // prepared 资源、不发 revision+1 的补偿。下一轮 resume 以同 revision
      // 重放未完成 step：若原命令已生效，Agent 返回 duplicate/同 revision ACK；
      // 若没生效，则这次正常应用。两种情况最终都走同一条成功记账路径。
      if (
        (phase === "prepare" || phase === "cutover") &&
        (
          outcome.error_code === "ack_timeout" ||
          (recoveringAmbiguous && outcome.error_code === "stale_revision")
        )
      ) {
        ctx.notes.push(`${step.phase}:${step.kind} WAIT ${outcome.error_code} ${outcome.error}`);
        const moved = await transitionRollout(
          rolloutId,
          phase,
          "waiting",
          {
            last_error_code: outcome.error_code,
            last_error: `${outcome.error}`.slice(0, 2000),
            notes: ctx.notes,
            updated_at: (deps.now?.() ?? new Date()).toISOString(),
          },
          { db },
        );
        if (!moved) {
          const fresh = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
          return concurrentTakeoverResult(rolloutId, fresh, completed.size);
        }
        return {
          ok: false,
          rolloutId,
          phase: "waiting",
          error_code: outcome.error_code,
          error: outcome.error,
          completed: completed.size,
        };
      }

      if (phase === "prepare") {
        // 释放本轮自己创建的资源 + 撤已 ACK 的 egress；applied_revision 不动、
        // 旧 runtime 继续（CUTOVER 尚未发生，撤自己就够了）。
        const cleanup = await releasePrepared(ctx, deps, db);
        const cleanupError = cleanup.ok ? null : cleanup.error;
        const error = cleanupError ? `${outcome.error}；${cleanupError}` : outcome.error;
        const terminalPhase = cleanup.ok ? "failed" : "degraded";
        const code = cleanup.ok ? outcome.error_code : "compensation_failed";

        // Tunnel 记账必须先成功，才允许 rollout 进入终态。否则终态会让 resume
        // 永远不再捞这条记录，而 Tunnel 仍停在旧状态。
        await markTunnelFailed(row.tunnel_id, code, error, db);
        const moved = await transitionRollout(
          rolloutId,
          phase,
          terminalPhase,
          {
            last_error_code: code,
            last_error: error.slice(0, 2000),
            ...(cleanupError ? { compensation_error: cleanupError.slice(0, 2000) } : {}),
            notes: ctx.notes,
            updated_at: (deps.now?.() ?? new Date()).toISOString(),
          },
          { db },
        );
        if (!moved) {
          const fresh = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
          return concurrentTakeoverResult(rolloutId, fresh, completed.size);
        }
        return {
          ok: false,
          rolloutId,
          phase: terminalPhase,
          error_code: code,
          error,
          completed: completed.size,
        };
      }

      if (phase === "cutover") {
        // 入口已经可能切过去了 ⇒ 必须补偿（§3.4）。
        // releasePrepared fail-closed：runtime 未确认撤除时不会释放端口租约。
        const preparedCleanup = await releasePrepared(ctx, deps, db);
        const moved = await transitionRollout(
          rolloutId,
          phase,
          "compensating",
          { last_error_code: outcome.error_code, last_error: outcome.error, updated_at: (deps.now?.() ?? new Date()).toISOString() },
          { db },
        );
        if (!moved) {
          const fresh = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
          return concurrentTakeoverResult(rolloutId, fresh, completed.size);
        }
        if (!(await renewRolloutExecutor(rolloutId, executorToken, deps))) {
          const fresh = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
          return concurrentTakeoverResult(rolloutId, fresh, completed.size);
        }
        const comp = await compensateRollout(rolloutId, deps);
        const cleanupError = preparedCleanup.ok ? null : preparedCleanup.error;
        const errorParts = [outcome.error, cleanupError, comp.error].filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        );
        return {
          // **补偿成功也是失败** `comp.ok=true` 只说明「回退到旧版本成功」，
          // 本次 desired revision 没有生效。任何 PREPARE 清理泄漏都保持 degraded，
          // 因为端口租约仍被刻意保留，等待 reconcile 安全回收。
          ok: false,
          rolloutId,
          phase: comp.ok && preparedCleanup.ok ? "failed" : "degraded",
          error_code: cleanupError ? "compensation_failed" : outcome.error_code,
          error: errorParts.join("；"),
          completed: completed.size,
          compensated: true,
        };
      }

      // drain/cleanup 的硬失败（理论上只剩 invariant_violated）。
      await transitionRollout(
        rolloutId,
        phase,
        "degraded",
        { last_error_code: outcome.error_code, last_error: outcome.error, notes: ctx.notes, updated_at: (deps.now?.() ?? new Date()).toISOString() },
        { db },
      );
      return {
        ok: false,
        rolloutId,
        phase: "degraded",
        error_code: outcome.error_code,
        error: outcome.error,
        completed: completed.size,
      };
    }
  }

  // 全部阶段走完。
  //
  // `from` 用**整个 active 集合**而不是字面量 "cleanup"：最后一个阶段的
  // 步骤可能全是「已完成」而在循环里被 `continue` 跳过（例如上次执行跑到
  // drain 就崩了，恢复时 drain/cleanup 都已完成），此时 `status` 仍是循环
  // 进入时的值。写死 "cleanup" 会让这次过渡静默失败 ⇒ rollout 行永远停在
  // 中间态，`resumeRollouts` 下一轮又会把它捞起来重放。
  // Durable Tunnel bookkeeping is part of the rollout, not a best-effort epilogue.
  // Write it BEFORE the terminal phase: if this fails the rollout remains resumable
  // and the next executor can retry only the ledger convergence.
  await markTunnelApplied(row.tunnel_id, row.revision, ctx, db, deps.now);
  const finished = await transitionRollout(
    rolloutId,
    [...ACTIVE_ROLLOUT_PHASES],
    "done",
    { updated_at: (deps.now?.() ?? new Date()).toISOString(), notes: ctx.notes },
    { db },
  );
  if (!finished) {
    const fresh = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
    return concurrentTakeoverResult(rolloutId, fresh, completed.size);
  }
  return { ok: true, rolloutId, phase: "done", completed: completed.size };
}

/**
 * plan 里存的 desired/applied 快照（register 时随计划一起落库）。
 *
 * 入参故意用 `unknown`：`row.plan` 从 DB 读回来是 JSON，类型只有运行期保证。
 * 校验失败时返回空形态让 cutover 立即以 invariant_violated 失败——宁可
 * 明确失败，也不要拿 undefined 字段去下发配置。
 */
function planSnapshot(plan: unknown, which: "desired" | "applied"): RolloutSnapshot {
  const raw = (plan as Record<string, unknown> | null | undefined)?.[which];
  if (raw && typeof raw === "object") return raw as RolloutSnapshot;
  // 兜底：desired 缺失 ⇒ 从 revision 推不出任何可用配置，返回空形态让
  // cutover 立即以 invariant_violated 失败，而不是拿 undefined 去下发。
  return {
    name: "",
    mode: "direct",
    ingress_node_id: 0,
    egress_node_id: null,
    listen_ip: null,
    listen_port: null,
    target_host: null,
    target_port: null,
    egress_pool_id: null,
    egress_port: null,
    egress_targets: null,
    desired_status: null,
  };
}

/** 释放本轮 created 的 lease / 撤已 ACK 的 egress（PREPARE/CUTOVER 失败路径）。 */
async function releasePrepared(
  ctx: RolloutExecContext,
  deps: RolloutDeps,
  db: RolloutDb,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Runtime teardown is the safety barrier before a port lease may be released.
  // If teardown is uncertain, retaining the lease is a safe leak; releasing it
  // would allow another runtime to acquire a port that may still be listening.
  const teardownErrors: string[] = [];
  const egressApplies = ctx.prepared.filter((p) => p.kind === "egress_apply");
  for (const p of egressApplies) {
    if (p.node_id == null) continue;
    try {
      const removed = await deps.orchestrator.removeTunnel({
        tunnelId: ctx.tunnelId,
        node: nodeFor(deps.orchestrator, p.node_id),
        direction: "egress",
        revision: ctx.revision + 1,
        reason: `rollout ${ctx.rolloutId} prepare-failed cleanup`,
      });
      if (!removed.ok) teardownErrors.push(`egress node ${p.node_id}: ${removed.error}`);
    } catch (error) {
      teardownErrors.push(
        `egress node ${p.node_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ──：远端腿不在 `prepared` 里 ──
  const peer = federatedEgressPeerOf(ctx.desired);
  if (peer !== null) {
    try {
      const released = await releaseRemoteEgressStep(ctx, deps, ctx.revision);
      if (released && typeof released === "object" && "ok" in released && released.ok === false) {
        teardownErrors.push(
          `remote egress ${peer}: ${"message" in released ? String(released.message ?? "release failed") : "release failed"}`,
        );
      }
    } catch (error) {
      teardownErrors.push(
        `remote egress ${peer}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (teardownErrors.length > 0) {
    return {
      ok: false,
      error: `runtime teardown 未确认完成，保留端口租约等待 reconcile：${teardownErrors.join("; ")}`,
    };
  }

  const leaseErrors: string[] = [];
  for (const p of ctx.prepared) {
    if (p.kind !== "lease" || typeof p.handle !== "number") continue;
    if (p.owned_by_rollout === false) continue;
    try {
      // false = 已经被并发清理/回收；portPool 明确定义为幂等成功语义，不应
      // 因“没有 active 行可改”把整个 rollout 升级成 degraded。
      await releaseLease({ leaseId: p.handle }, { db: db as never });
    } catch (error) {
      leaseErrors.push(
        `lease ${p.handle}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return leaseErrors.length === 0
    ? { ok: true }
    : { ok: false, error: `端口租约释放未完全收敛：${leaseErrors.join("; ")}` };
}

/** PREPARE 失败：tunnel 行记 error，applied_revision 不动（§13.3.5）。 */
async function markTunnelFailed(
  tunnelId: number,
  code: string,
  message: string,
  db: RolloutDb,
): Promise<void> {
  const updated = (await db.tunnel.updateMany({
    where: { id: tunnelId },
    data: {
      apply_status: "error",
      apply_error_code: code,
      apply_error: `[${code}] ${message}`.slice(0, 2000),
    },
  })) as { count?: number };
  if (updated.count === 0) {
    throw new Error(`tunnel ${tunnelId} failure ledger row not found`);
  }
}

/**
 * 全部阶段完成：tunnel 行回到 active（desired 与 applied 一致）。
 *
 * **必须写 `applied_revision`（与 `config_revision` 同值）** 这正是 §13.3.5
 * 「成功推进 applied」的那一步，也是 Agent ACK 顺序之后唯一能让
 * `reconciler.isRevisionBehind()`（`applied < config`）安静下来的地方。只写
 * `config_revision` 会留下一个静默故障：rollout 记 done、Agent 已在跑新配置，
 * 而 tunnel 行永远显示「落后」——reconciler 每轮 `resend_same_revision` 重发
 * 同一 revision，被 Agent 的 stale 闸门拒绝后又进入重试退避，循环空转。
 * `markTunnelApplied` 是  对 tunnel 行成功记账的唯一出口，与
 * `scheduler.persistSuccess`（创建路径）保持同一组列，避免两条写入路径语义分叉。
 *
 * `last_applied_at` 同样要写：reconciler 的 `DEFAULT_RETRY_BACKOFF_MS` 退避
 * 读它，缺列/不写会让退避窗口永远算不出（`null` ⇒ 不 defer）。
 */
async function markTunnelApplied(
  tunnelId: number,
  revision: number,
  ctx: RolloutExecContext,
  db: RolloutDb,
  now?: () => Date,
): Promise<void> {
  const ingressLease = ctx.prepared.find(
    (p) => p.kind === "lease" && p.node_id === ctx.desired.ingress_node_id && p.port != null,
  );
  const egressApplied = ctx.prepared.find(
    (p) => p.kind === "egress_apply" && p.node_id === ctx.desired.egress_node_id && p.port != null,
  );
  const egressLease = ctx.prepared.find(
    (p) => p.kind === "lease" && p.node_id === ctx.desired.egress_node_id && p.port != null,
  );
  const concreteListenPort = ingressLease?.port ?? ctx.desired.listen_port ?? null;
  const concreteEgressPort =
    ctx.desired.mode === "relay"
      ? (egressApplied?.port ?? egressLease?.port ?? ctx.desired.egress_port ?? null)
      : null;

  const updated = (await db.tunnel.updateMany({
    where: { id: tunnelId },
    data: {
      apply_status: "active",
      desired_status: "active",
      apply_error_code: null,
      apply_error: null,
      config_revision: revision,
      applied_revision: revision,
      listen_port: concreteListenPort,
      egress_port: concreteEgressPort,
      egress_pool_id: ctx.desired.mode === "relay" ? ctx.desired.egress_pool_id : null,
      last_applied_at: (now?.() ?? new Date()).toISOString(),
    },
  })) as { count?: number };
  if (updated.count === 0) {
    throw new Error(`tunnel ${tunnelId} success ledger row not found`);
  }
}

/* ================================================================== */
/* 登记（registerRollout）                                              */
/* ================================================================== */

export interface RegisterRolloutInput {
  tunnelId: number;
  /**  `computeForwardImpact` 的输出（preview 已算过，直接透传）。 */
  impact: Parameters<typeof planRollout>[0]["impact"];
  /** 期望的 revision（已由  `createForwardRevision` 落库）。 */
  revision: number;
  baseRevision: number | null;
  /** suspended 编辑 ⇒ noop rollout（§3.6）。 */
  suspended?: boolean;
}

export interface RegisterRolloutResult {
  ok: boolean;
  rolloutId: number | null;
  /** `blocked` = VALIDATE 失败（§13.3.5 失败规则一）：什么都不写。 */
  status: "done" | "waiting" | "in_progress" | "blocked" | "created" | "conflict";
  error_code?: string;
  error?: string;
  blocking?: Array<{ code: string; message: string }>;
  warnings?: string[];
  /** 本次执行是否已进入补偿（CUTOVER 失败路径）。 */
  compensated?: boolean;
}

/**
 * 登记并**首次执行**一次 rollout。
 *
 * `patchForward` 落库后同步调用（§3.5「被动触发」）。三条约束：
 *  · VALIDATE 失败 ⇒ 不写 rollout 行、不动 tunnel 行（planRollout 纯函数
 *    保证这里想写也拿不到计划）；
 *  · 同期至多一条未完成 rollout（报告 R6：Gateway 竞态 ⇒ 后到者 conflict）；
 *  · suspended ⇒ noop（§3.6：存 desired 不启 runtime，resume 时重放）。
 */
export async function registerRollout(
  input: RegisterRolloutInput,
  deps: RolloutDeps,
): Promise<RegisterRolloutResult> {
  const db = deps.db;

  // R6：抢占闸门。已有 active rollout ⇒ 拒绝（调用方翻 409 revision_conflict）。
  const inFlight = (await db.forwardRollout.findMany({
    where: {
      tunnel_id: input.tunnelId,
      phase: { in: [...ACTIVE_ROLLOUT_PHASES] },
    },
    take: 1,
    select: { id: true },
  })) as Array<{ id: number }>;
  if (inFlight.length > 0) {
    return {
      ok: false,
      rolloutId: inFlight[0]!.id,
      status: "conflict",
      error_code: "revision_conflict",
      error: "该转发已有正在进行的更新",
    };
  }

  const { desired, applied, nodes, bindingExists } = await loadRolloutNodes(input.tunnelId, { db });

  // ── V5.4：路由准入（整条路由已知的那一层）──
  //
  // 放在这里而不是每条腿各自判定：`dispatchIngress` 看不到出口节点，按腿判定会把**每一个 RELAY
  // 都拒掉**（试过，28 个测试失败）。路由是一个整体，准入也必须看在整条路由上。
  //
  // 配置了中间跳 = 三跳，而当前下发只会发单跳形状：放行的话转发**会正常工作，但走的是另一条路**，
  // 没有任何错误。因此 fail-closed —— 在**任何副作用之前**拒绝，并点名是哪一跳。
  const declaredPeerAtRegistration = federatedEgressPeerOf(desired);
  if (declaredPeerAtRegistration !== null) {
    // ──：远端出口的**同一强度**准入 ──
    //
    // 本机路由模型（`buildRoutePlan`）要求出口是一个**本机**节点 id，而声明了 peer
    // 时出口在另一个面板上。这里用同一份 fail-closed 判定替代它，判定的强度不变：
    // 只允许"一个远端 hop、且必须在 egress"（契约 §9），其余（远端 ingress/transit、
    // 3+ 跳、本机与远端同时声明出口、需要节点本地证书的协议）一律拒绝。
    // 绝不放行一个"看起来能跑但其实下发不了"的形状。
    const facts = await dispatchFactsFor(input.tunnelId, db);
    const federatedAdmission = checkFederatedEgressForSnapshot({
      tunnelId: input.tunnelId,
      revision: input.revision,
      snapshot: desired,
      protocol: facts?.protocol ?? null,
    });
    if (!federatedAdmission.ok) {
      return {
        ok: false,
        rolloutId: null,
        status: "blocked",
        error_code: federatedAdmission.code,
        error: federatedAdmission.message,
        blocking: [{ code: federatedAdmission.code, message: federatedAdmission.message }],
      };
    }
  } else {
  const routeAdmission = admitRoute(
    {
      ingress_node_id: desired.ingress_node_id,
      egress_node_id: desired.egress_node_id,
      middle_node_id: (desired as { middle_node_id?: number | null }).middle_node_id ?? null,
      tunnel_mode: desired.mode,
      revision: input.revision,
    },
    await loadBoundPairs(db),
    // V5.4：多跳的**计划 + 执行 + 补偿 + 准入**四件都齐了才打开这一位。
    // 它存在的原因是：`admitRoute` 必须能区分"这个形状不合法"与"这个形状还没实现" ——
    // 在实现齐备之前放行，等于让用户配了中间跳之后跑一条**别的路**且毫无提示。
    { multiHopImplemented: true },
  );
  if (!routeAdmission.ok) {
    return {
      ok: false,
      rolloutId: null,
      status: "blocked",
      error_code: routeAdmission.code,
      error: routeAdmission.error,
      blocking: [{ code: routeAdmission.code, message: routeAdmission.error }],
    };
  }
  }

  if (!input.suspended && input.impact.runtime_change) {
    const denied = await rolloutRuntimeDenial(input.tunnelId, desired, deps);
    if (denied) {
      return {
        ok: false, rolloutId: null, status: "blocked",
        error_code: denied.reason, error: denied.message,
        blocking: [{ code: denied.reason, message: `[${denied.error_layer}] ${denied.message}` }],
      };
    }
  }
  indexRolloutNodes(
    deps.orchestrator,
    [nodes.ingress, nodes.egress, nodes.middle].filter((n) => n != null) as any,
  );

  const planInput: PlanRolloutInput = {
    revision: input.revision,
    base_revision: input.baseRevision,
    impact: input.impact,
    desired,
    applied,
    nodes,
    binding_exists: bindingExists,
  };
  const plan = planRollout(planInput, input.tunnelId);

  if (plan.blocking.length > 0) {
    return {
      ok: false,
      rolloutId: null,
      status: "blocked",
      error_code: plan.blocking[0]!.code,
      error: plan.blocking[0]!.message,
      blocking: plan.blocking,
      warnings: plan.warnings,
    };
  }

  const now = (deps.now?.() ?? new Date()).toISOString();
  const created = (await db.forwardRollout.create({
    data: {
      tunnel_id: input.tunnelId,
      revision: input.revision,
      base_revision: input.baseRevision,
      phase: input.suspended || plan.steps.length === 0 ? "done" : "validate",
      strategy: plan.strategy,
      steps: planWithSnapshots(plan, desired, applied),
      cleaned: [],
      prepared: [],
      last_error_code: null,
      last_error: null,
      compensated: false,
      created_at: now,
      updated_at: now,
    },
    select: { id: true },
  })) as { id: number };

  // suspended / 空计划 ⇒ noop，语义就是 done（§3.6 / §13.3.2）。
  if (input.suspended || plan.steps.length === 0) {
    return { ok: true, rolloutId: created.id, status: "done", warnings: plan.warnings };
  }

  const result = await executeRollout(created.id, deps);
  return {
    // waiting = desired 已接收但 runtime 结果暂未知；保留 ok=false 让调用者能
    // 区分「已应用」和「已接受待收敛」，同时用 status 精确表达可恢复状态。
    ok: result.ok,
    rolloutId: created.id,
    status: result.ok ? "done" : result.phase === "waiting" ? "waiting" : result.error_code === "concurrent_transition" ? "in_progress" : "created",
    error_code: result.error_code,
    error: result.error,
    warnings: plan.warnings,
    compensated: result.compensated,
  };
}

/** 把 desired/applied 快照随计划一起落库（续跑时不再读 tunnel 行）。 */
function planWithSnapshots(plan: RolloutPlan, desired: RolloutSnapshot, applied: RolloutSnapshot | null): unknown {
  return { ...plan, desired, applied };
}

/** 供测试与续跑读取 step 幂等键的辅助（与 C3 同一函数，避免两套口径）。 */
export { rolloutStepKey };
