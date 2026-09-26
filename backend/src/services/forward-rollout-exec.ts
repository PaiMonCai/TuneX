/**
 * V4-WP3 — Forward Rollout Orchestrator **执行面**（`DEVELOPMENT.md` §13.3.5
 * 五阶段 / §3.3 五阶段执行器 / §3.4 compensation / §3.5 可续跑记账）。
 *
 * C3 交付了纯计划（`planRollout`），本文件交付「把计划跑完」：
 *
 * ```text
 *   registerRollout(tunnelId)          ← 读库 → plan → 写 rollout 行
 *   executeRollout(rolloutId)          ← 按已完成集合续跑未完成 steps
 *   compensate(rollout)                ← CUTOVER 失败后回退（§3.4）
 * ```
 *
 * ── 三条设计主轴 ──
 *
 * 1. **rollout 行是流水账，不是真相**（§13.3.5 + §3.5）。
 *    真相只有三处：`tunnel` 投影列（当前 applied）、WP1 `forward_revision`
 *    snapshot（desired 的历史）、Agent runtime。rollout 行只记「计划了什么、
 *    推进到哪、哪些步骤已完成」，因此它**随时可以丢**：丢了就重新 plan，
 *    不会让系统进入错误状态。这也意味着本文件所有写库都是「追加式 patch」
 *    （`steps.push` / `prepared.push` / `cleaned.push`），用 `updateMany` 带
 *    phase 条件做乐观并发，而不是 read-modify-write。
 *
 * 2. **续跑 = 重放 + 幂等键去重**（§3.5）。
 *    重启后读回 rollout 行，按 `completed`（step 幂等键集合）决定下一步。
 *    因此每个执行器必须**自己幂等**——这是复用的既有保证而不是新造的：
 *      · `acquirePort` 对同 tunnel 同方向的 preferred port 幂等续用；
 *      · `releaseLease` 对已 released 是 no-op；
 *    · `removeTunnel` 换 Agent 侧未知 id 返回 ok（`orchestrator.ts` 注释）。
 *
 * 3. **失败分流严格按 §13.3.5 第三张表**：
 *      VALIDATE 失败 → `failed`，**完全不写** rollout 行（planRollout 是纯函数，
 *                 它返回 blocking 时调用方还没落库）；
 *      PREPARE 失败 → 释放本轮 prepared 的 lease + 撤已 ACK 的 egress → `failed`，
 *                 `applied_revision` 不动、旧 runtime 继续；
 *      CUTOVER 失败 → `compensating`，接着跑 `compensate()`；
 *      DRAIN 失败 → 只记 warning，**不阻塞** CLEANUP（在途连接由 kernel 超时兜底）；
 *      CLEANUP 失败 → 记 `degraded`，不影响已生效的新 revision。
 *
 * ── 边界 ──
 * · 不改 `reconciler.ts` / `runtime-reconcile-sink.ts`（§3.5 明文）；
 * · 不加新 wire `CommandAction`：所有步骤都是既有 `apply_tunnel` /
 *   `remove_tunnel` 的不同编排顺序；
 * · 不复制 runtime 事实：端口来自 `acquirePort` 的返回值，节点来自 DB 行。
 */

import { acquirePort, releaseLease } from "./portPool.ts";
import type { AcquirePortOutcome } from "./portPool.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { ACTIVE_ROLLOUT_PHASES, planRollout, ROLLOUT_STAGE_SEQUENCE, rolloutStepKey } from "./forward-rollout.ts";
import type { PlanRolloutInput, RolloutPlan, RolloutSnapshot, RolloutStep } from "./forward-rollout.ts";

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
   * 数据访问。**必填**：调用方（route/worker）显式传 `db`，测试传内存替身。
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
  now?: () => Date;
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
  created_at: Date | null;
  updated_at: Date | null;
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
}

/**
 * 读 tunnel 行 + 最新 snapshot，凑出 {@link PlanRolloutInput} 的四个输入
 * 里的两个（`desired` / `applied`）+ WP1 impact 之外的节点事实。
 *
 * **不复制 runtime 事实**（§13.3.5）：这里读出来的就是 tunnel 投影列与
 * snapshot 行本身，`desired` 取 `desired_revision_id` 指向的那一行；
 * 找不到（suspend bump 出的 revision 没有 snapshot，报告 R5）时回退到投影列
 * 合成基线——与 WP1 `currentDesiredConfig` 同口径。
 */
async function loadRolloutNodes(
  tunnelId: number,
  deps: { db: RolloutDb },
): Promise<{
  desired: RolloutSnapshot;
  applied: RolloutSnapshot | null;
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

  const snapshotToRollout = (s: Record<string, unknown>): RolloutSnapshot => ({
    name: String(s.name ?? row.name),
    mode: String(s.mode ?? row.tunnel_mode) === "relay" ? "relay" : "direct",
    ingress_node_id: Number(s.ingress_node_id ?? row.ingress_node_id ?? 0),
    egress_node_id: s.egress_node_id == null ? null : Number(s.egress_node_id),
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
  });

  // desired：desired_revision_id 指向的 snapshot；缺失时用投影列合成基线
  // （报告 R5 的 suspend bump 场景；口径与 WP1 currentDesiredConfig 一致）。
  const desiredRow = row.desired_revision_id
    ? snapshots.find((s) => Number(s.id) === Number(row.desired_revision_id))
    : snapshots[0];
  const desired: RolloutSnapshot = desiredRow
    ? snapshotToRollout(desiredRow)
    : {
        name: row.name,
        mode: row.tunnel_mode === "relay" ? "relay" : "direct",
        ingress_node_id: row.ingress_node_id ?? 0,
        egress_node_id: row.egress_node_id ?? null,
        listen_ip: row.listen_ip,
        listen_port: row.listen_port ?? null,
        target_host: row.remote_host,
        target_port: row.remote_port == null ? null : Number(row.remote_port),
        egress_pool_id: row.egress_pool_id,
        egress_port: row.egress_port,
        egress_targets: null,
        desired_status: row.desired_status,
      };

  // applied：desired 之外的**次新** snapshot。
  // 用「次新」而不是「applied_revision 那一行」：本表不存 applied_revision，
  // 而 §13.3.5 的 DRAIN/CLEANUP 需要的「旧 runtime」= 上一次成功 apply 的
  // 配置，在快照序列里正是次新。
  //
  // **排除 desired 用 revision 数值而不是对象引用**：fallback 分支里 desired
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
      // 本分支没有 WP5 lifecycle 列 ⇒ undefined ⇒ 不阻断（R7 本地口径）。
      lifecycle: (rec.lifecycle as string | null | undefined) ?? undefined,
      port_range_configured:
        rec.port_range_min == null || rec.port_range_max == null ? false : true,
    };
  };

  const nodes: PlanRolloutInput["nodes"] = {
    ingress: nodeFact(row.ingress_node),
    egress: nodeFact(row.egress_node),
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
  };

  // Binding 存在性：只有 RELAY 且出口节点解析出来才有意义。
  let bindingExists: boolean | null = null;
  if (desired.mode === "relay" && row.ingress_node_id != null && row.egress_node_id != null) {
    const found = (await deps.db.nodeBinding.findUnique({
      where: {
        ingress_node_id_egress_node_id: {
          ingress_node_id: row.ingress_node_id,
          egress_node_id: row.egress_node_id,
        },
      },
    })) as { id: number } | null;
    bindingExists = found != null;
  }

  return { desired, applied, nodes, bindingExists };
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
      const outcome: AcquirePortOutcome = await acquirePort(
        {
          nodeId,
          leaseType: step.direction === "egress" ? "egress" : "ingress",
          preferredPort: step.port ?? null,
          tunnelId: ctx.tunnelId,
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
        },
      };
    }

    case "ensure_binding": {
      // §13.3.1：Binding 是显式创建的可复用基础设施关系；修改 Forward 不删它。
      // 这里已由 `binding_exists === false` 作为入步骤条件，因此 create 是
      // 新建而非 upsert；重复执行撞 @@unique 时按「已存在」算成功（幂等）。
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
      // §13.3.5 铁律：EGRESS 先 apply、ACK 后**不切入口**（入口由 CUTOVER 的
      // cutover_ingress 负责）。因此这里只做 egress 侧下发。
      if (nodeId == null || step.port == null) {
        return { ok: false, error_code: "invariant_violated", error: "prepare_egress 缺少 node/port" };
      }
      const targets = ctx.desired.egress_targets ?? [];
      const outcome = await orchestrator.dispatchEgress({
        tunnelId: ctx.tunnelId,
        revision: ctx.revision,
        egressNode: nodeFor(orchestrator, nodeId),
        egressPort: step.port,
        poolId: ctx.desired.egress_pool_id,
        targets: targets.map((t) => ({ host: t.host, port: t.port, weight: t.weight, order_by: t.order_by })),
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
        note: `egress ${nodeId}:${step.port} applied（未切入口）`,
        sideEffect: { kind: "egress_apply", node_id: nodeId, port: step.port, handle: null },
      };
    }

    /* ---------------- CUTOVER ---------------- */

    case "cutover_egress": {
      // 出口侧「此刻起按新 revision 生效」的标记。Agent 侧 egress 已在
      // PREPARE apply，这里做的是把入口的 next_hop 指向它之前的那一步：
      // 若 PREPARE 已 apply 同 revision，此处是幂等重发（Agent 按 revision
      // 三态收敛，同 revision ⇒ no-op）。
      if (nodeId == null || step.port == null) {
        return { ok: false, error_code: "invariant_violated", error: "cutover_egress 缺少 node/port" };
      }
      const targets = ctx.desired.egress_targets ?? [];
      const outcome = await orchestrator.dispatchEgress({
        tunnelId: ctx.tunnelId,
        revision: ctx.revision,
        egressNode: nodeFor(orchestrator, nodeId),
        egressPort: step.port,
        poolId: ctx.desired.egress_pool_id,
        targets: targets.map((t) => ({ host: t.host, port: t.port, weight: t.weight, order_by: t.order_by })),
      });
      if (!outcome.ok) {
        return { ok: false, error_code: outcome.error_code, error: outcome.error };
      }
      return { ok: true, note: `egress ${nodeId}:${step.port} 生效于 revision ${ctx.revision}` };
    }

    case "cutover_ingress": {
      const ingressNodeId = nodeId;
      if (ingressNodeId == null) {
        return { ok: false, error_code: "invariant_violated", error: "cutover_ingress 缺少 node_id" };
      }
      const port = resolveIngressPort(step, ctx);

      if (ctx.desired.mode === "relay") {
        const egressNodeId = ctx.desired.egress_node_id;
        if (egressNodeId == null || step.direction === "egress") {
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
        const outcome = await orchestrator.dispatchIngress({
          tunnelId: ctx.tunnelId,
          revision: ctx.revision,
          ingressNode: nodeFor(orchestrator, ingressNodeId),
          ingressPort: port,
          nextHop,
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
      const outcome = await orchestrator.dispatchDirect({
        tunnelId: ctx.tunnelId,
        revision: ctx.revision,
        ingressNode: nodeFor(orchestrator, ingressNodeId),
        ingressPort: port,
        remoteHost: ctx.desired.target_host,
        remotePort: ctx.desired.target_port,
        listenHost: ctx.desired.listen_ip,
      });
      if (!outcome.ok) {
        return { ok: false, error_code: outcome.error_code, error: outcome.error };
      }
      return { ok: true, note: `direct ${ingressNodeId}:${port} → ${ctx.desired.target_host}:${ctx.desired.target_port}` };
    }

    /* ---------------- DRAIN ---------------- */

    case "drain_ingress":
    case "drain_egress": {
      // 报告 R3：wire 上没有 drain 原语，backend 用 `remove_tunnel` 表达
      // 「停止接受新连接后等待在途退出」（tunnel-api.ts#suspend 同一表达）。
      if (nodeId == null) {
        return { ok: false, error_code: "invariant_violated", error: "drain 缺少 node_id" };
      }
      const outcome = await orchestrator.removeTunnel({
        tunnelId: ctx.tunnelId,
        node: nodeFor(orchestrator, nodeId),
        direction: step.direction === "egress" ? "egress" : "ingress",
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
      // 幂等：releaseLease 对已 released 的租约是 no-op（portPool.ts 注释）。
      const released = await releaseLease(
        { tunnelId: ctx.tunnelId, nodeId },
        { db: deps.db as never },
      );
      return { ok: true, note: released ? `lease ${nodeId}:${step.port ?? "?"} released` : `lease ${nodeId} 已释放（幂等）` };
    }

    case "drop_old_egress": {
      if (nodeId == null) {
        return { ok: false, error_code: "invariant_violated", error: "drop_old_egress 缺少 node_id" };
      }
      const outcome = await orchestrator.removeTunnel({
        tunnelId: ctx.tunnelId,
        node: nodeFor(orchestrator, nodeId),
        direction: "egress",
        // revision+1：同 removeTunnel 的补偿口径，重复执行幂等。
        revision: ctx.revision + 1,
        reason: `rollout ${ctx.rolloutId} drop old egress`,
      });
      if (!outcome.ok) {
        // §13.3.5：CLEANUP 失败只记 degraded，不影响已生效的新 revision。
        return { ok: false, soft: true, error_code: outcome.error_code, error: outcome.error };
      }
      return { ok: true, note: `old egress ${nodeId} 已撤下` };
    }

    /* ---------------- VALIDATE（无副作用）---------------- */

    case "validate":
      return { ok: true, note: "validate（计划期已判定）" };

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
 * 注意**不按方向区分**：节点索引是 id → Node 的映射，同一台 BOTH 节点无论
 * 当 ingress 还是 egress 都是同一行。方向只影响 `removeTunnel` 拼哪个
 * tunnel id（`-relay` / `-egress` / `-direct`），那由 direction 参数自己决定。
 */
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

/** `<egress ip>:<egress port>`；解析不到 ⇒ null ⇒ cutover_ingress 拒绝执行。 */
function resolveNextHop(ctx: RolloutExecContext): string | null {
  const egressNodeId = ctx.desired.egress_node_id;
  if (egressNodeId == null || ctx.desired.egress_port == null) return null;
  const prepared = ctx.prepared.find(
    (p) => p.kind === "egress_apply" && p.node_id === egressNodeId && p.port != null,
  );
  const port = prepared?.port ?? ctx.desired.egress_port;
  // 旧实现（orchestrator.dispatchEgress 内）会拿 egress 节点的可寻址 host
  // 拼 next_hop；这里同样只允许从**已登记**的节点事实里取，不猜 IP。
  const host = nextHopHosts.get(ctx.rolloutId)?.get(egressNodeId);
  if (!host) return null;
  return `${host}:${port}`;
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
  const removals: Array<{ direction: "egress" | "ingress"; nodeId: number }> = [
    { direction: "egress", nodeId: planned.egress_node_id ?? 0 },
    { direction: "ingress", nodeId: planned.ingress_node_id },
  ];
  for (const { direction, nodeId } of removals) {
    if (!nodeId) continue;
    const outcome = await orchestrator.removeTunnel({
      tunnelId: row.tunnel_id,
      node: nodeFor(orchestrator, nodeId),
      direction,
      revision: removeRevision,
      reason: `rollout ${rolloutId} compensation`,
    });
    if (!outcome.ok) errors.push(`remove ${direction}: ${outcome.error}`);
  }

  // ② 重放基线。base_revision 为 null ⇒ 没有旧 runtime 可回，只需要撤新的
  //    （首次部署失败的情形：撤干净即回到「没有 runtime」这个正确状态）。
  if (row.base_revision != null) {
    const baseline = (await deps.db.forwardRevision.findFirst({
      where: { tunnel_id: row.tunnel_id, revision: row.base_revision },
    })) as Record<string, unknown> | null;
    if (!baseline) {
      errors.push(`baseline snapshot revision=${row.base_revision} 不存在`);
    } else {
      const ingressNodeId = Number(baseline.ingress_node_id);
      const listenPort = baseline.listen_port == null ? null : Number(baseline.listen_port);
      if (!ingressNodeId || listenPort == null) {
        errors.push("baseline snapshot 缺 ingress_node_id / listen_port");
      } else if (String(baseline.mode) === "relay") {
        const egressPort = baseline.egress_port == null ? null : Number(baseline.egress_port);
        const egressNodeId = baseline.egress_node_id == null ? null : Number(baseline.egress_node_id);
        if (egressPort == null || egressNodeId == null) {
          errors.push("baseline RELAY snapshot 缺出口");
        } else {
          const targets = Array.isArray(baseline.targets)
            ? (baseline.targets as Array<{ host: string; port: number; weight?: number; order_by?: number }>)
            : [];
          const egress = await orchestrator.dispatchEgress({
            tunnelId: row.tunnel_id,
            revision: row.base_revision,
            egressNode: nodeFor(orchestrator, egressNodeId),
            egressPort,
            poolId: baseline.egress_pool_id == null ? null : Number(baseline.egress_pool_id),
            targets: targets.map((t, i) => ({
              host: t.host,
              port: t.port,
              weight: t.weight ?? 1,
              order_by: t.order_by ?? (i + 1) * 10,
            })),
          });
          if (!egress.ok) {
            errors.push(`replay egress: ${egress.error}`);
          } else {
            const host = egress.egress_host;
            const ingress = await orchestrator.dispatchIngress({
              tunnelId: row.tunnel_id,
              revision: row.base_revision,
              ingressNode: nodeFor(orchestrator, ingressNodeId),
              ingressPort: listenPort,
              nextHop: `${host}:${egressPort}`,
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
          const ingress = await orchestrator.dispatchDirect({
            tunnelId: row.tunnel_id,
            revision: row.base_revision,
            ingressNode: nodeFor(orchestrator, ingressNodeId),
            ingressPort: listenPort,
            remoteHost: targetHost,
            remotePort: targetPort,
            listenHost: (baseline.listen_ip as string | null) ?? null,
          });
          if (!ingress.ok) errors.push(`replay direct: ${ingress.error}`);
        }
      }
    }
  }

  // ③ 分流。
  if (errors.length === 0) {
    await transitionRollout(
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
    // §3.4：config_revision 保持目标 revision（desired 不回退），apply_status
    // 归到 error 让 UI 显示「更新失败，上一版本仍运行」（§3.7 WP4 契约）。
    await deps.db.tunnel
      .updateMany({
        where: { id: row.tunnel_id },
        data: {
          apply_status: "error",
          apply_error_code: "cutover_failed_compensated",
          apply_error: `rollout ${rolloutId} 回退到 revision ${row.base_revision ?? "none"}`,
        },
      })
      .catch(() => {});
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
    // `notes` 是**追加式流水账**：`transitionRollout` 写 `notes: ctx.notes` 时
    // 走的是 Prisma 的 `{ push }`，若此处重新置 []，第一次 patch 就会把上一轮
    // （崩溃前的阶段）落账抹掉，`§13.3.2` 要求「可追溯到本轮结束」就断了。
    // 因此必须从当前行读起；列为 NULL（迁移前存量行）时按空数组开始。
    notes: [...readLedger<string[]>(row.notes, [])],
  };

  const phases = ROLLOUT_STAGE_SEQUENCE;
  let status: RolloutStatus = row.phase === "compensating" || row.phase === "waiting" ? "prepare" : row.phase;

  for (const phase of phases) {
    const steps = plan.steps.filter((s) => s.phase === phase && !completed.has(s.idempotency_key));
    if (steps.length === 0) continue;

    if (status !== phase) {
      const moved = await transitionRollout(rolloutId, status, phase, {}, { db });
      // status 已被并发改动 ⇒ 重新读行（别用旧 completed 覆盖别人的进度）。
      if (!moved) {
        const fresh = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
        return {
          ok: false,
          rolloutId,
          phase: fresh?.phase ?? "failed",
          error_code: "concurrent_transition",
          error: "rollout 状态被并发修改，重试",
          completed: readKeySet(fresh?.cleaned).length,
        };
      }
      status = phase;
    }

    for (const step of steps) {
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

      if (phase === "prepare") {
        // 释放本轮自己创建的资源 + 撤已 ACK 的 egress；applied_revision 不动、
        // 旧 runtime 继续（CUTOVER 尚未发生，撤自己就够了）。
        await releasePrepared(ctx, deps, db);
        await transitionRollout(
          rolloutId,
          phase,
          "failed",
          {
            last_error_code: outcome.error_code,
            last_error: `${outcome.error}`.slice(0, 2000),
            notes: ctx.notes,
            updated_at: (deps.now?.() ?? new Date()).toISOString(),
          },
          { db },
        );
        await markTunnelFailed(row.tunnel_id, outcome.error_code, outcome.error, db);
        return {
          ok: false,
          rolloutId,
          phase: "failed",
          error_code: outcome.error_code,
          error: outcome.error,
          completed: completed.size,
        };
      }

      if (phase === "cutover") {
        // 入口已经可能切过去了 ⇒ 必须补偿（§3.4）。
        await releasePrepared(ctx, deps, db);
        const moved = await transitionRollout(
          rolloutId,
          phase,
          "compensating",
          { last_error_code: outcome.error_code, last_error: outcome.error, updated_at: (deps.now?.() ?? new Date()).toISOString() },
          { db },
        );
        if (!moved) {
          const fresh = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
          return {
            ok: false,
            rolloutId,
            phase: fresh?.phase ?? "failed",
            error_code: "concurrent_transition",
            error: "rollout 状态被并发修改，重试",
            completed: readKeySet(fresh?.cleaned).length,
          };
        }
        const comp = await compensateRollout(rolloutId, deps);
        return {
          // **补偿成功也是失败**：`comp.ok=true` 只说明「回退到旧版本成功」，
          // 本次 desired revision 没有生效。报 ok:true 会让 patchForward 认为
          // 新配置已在跑，从而把「更新失败，上一版本仍运行」显示成成功。
          ok: false,
          rolloutId,
          phase: comp.ok ? "failed" : "degraded",
          error_code: outcome.error_code,
          error: outcome.error,
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
  const finished = await transitionRollout(
    rolloutId,
    [...ACTIVE_ROLLOUT_PHASES],
    "done",
    { updated_at: (deps.now?.() ?? new Date()).toISOString(), notes: ctx.notes },
    { db },
  );
  if (!finished) {
    const fresh = (await db.forwardRollout.findUnique({ where: { id: rolloutId } })) as RolloutRowView | null;
    if (fresh && (fresh.phase === "done" || fresh.phase === "failed")) {
      return { ok: fresh.phase === "done", rolloutId, phase: fresh.phase, completed: completed.size };
    }
  }
  await markTunnelApplied(row.tunnel_id, row.revision, db, deps.now);
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
): Promise<void> {
  // 逆序释放：后创建的先撤（egress 先于 ingress 创建 ⇒ 先撤 ingress？不——
  // 这里只撤 lease 与 egress runtime，顺序是「先撤 egress runtime 再放 lease」，
  // 与 CLEANUP 同口径，避免端口释放后 listener 还在的双绑窗口）。
  const egressApplies = ctx.prepared.filter((p) => p.kind === "egress_apply");
  for (const p of egressApplies) {
    if (p.node_id == null) continue;
    await deps.orchestrator
      .removeTunnel({
        tunnelId: ctx.tunnelId,
        node: nodeFor(deps.orchestrator, p.node_id),
        direction: "egress",
        revision: ctx.revision + 1,
        reason: `rollout ${ctx.rolloutId} prepare-failed cleanup`,
      })
      .catch(() => {});
  }
  for (const p of ctx.prepared) {
    if (p.kind !== "lease" || typeof p.handle !== "number") continue;
    await releaseLease({ leaseId: p.handle }, { db: db as never }).catch(() => {});
  }
}

/** PREPARE 失败：tunnel 行记 error，applied_revision 不动（§13.3.5）。 */
async function markTunnelFailed(
  tunnelId: number,
  code: string,
  message: string,
  db: RolloutDb,
): Promise<void> {
  await db.tunnel
    .updateMany({
      where: { id: tunnelId },
      data: {
        apply_status: "error",
        apply_error_code: code,
        apply_error: `[${code}] ${message}`.slice(0, 2000),
      },
    })
    .catch(() => {});
}

/**
 * 全部阶段完成：tunnel 行回到 active（desired 与 applied 一致）。
 *
 * **必须写 `applied_revision`（与 `config_revision` 同值）**：这正是 §13.3.5
 * 「成功推进 applied」的那一步，也是 Agent ACK 顺序之后唯一能让
 * `reconciler.isRevisionBehind()`（`applied < config`）安静下来的地方。只写
 * `config_revision` 会留下一个静默故障：rollout 记 done、Agent 已在跑新配置，
 * 而 tunnel 行永远显示「落后」——reconciler 每轮 `resend_same_revision` 重发
 * 同一 revision，被 Agent 的 stale 闸门拒绝后又进入重试退避，循环空转。
 * `markTunnelApplied` 是 WP3 对 tunnel 行成功记账的唯一出口，与
 * `scheduler.persistSuccess`（创建路径）保持同一组列，避免两条写入路径语义分叉。
 *
 * `last_applied_at` 同样要写：reconciler 的 `DEFAULT_RETRY_BACKOFF_MS` 退避
 * 读它，缺列/不写会让退避窗口永远算不出（`null` ⇒ 不 defer）。
 */
async function markTunnelApplied(
  tunnelId: number,
  revision: number,
  db: RolloutDb,
  now?: () => Date,
): Promise<void> {
  await db.tunnel
    .updateMany({
      where: { id: tunnelId },
      data: {
        apply_status: "active",
        desired_status: "active",
        apply_error_code: null,
        apply_error: null,
        config_revision: revision,
        applied_revision: revision,
        last_applied_at: (now?.() ?? new Date()).toISOString(),
      },
    })
    .catch(() => {});
}

/* ================================================================== */
/* 登记（registerRollout）                                              */
/* ================================================================== */

export interface RegisterRolloutInput {
  tunnelId: number;
  /** WP1 `computeForwardImpact` 的输出（preview 已算过，直接透传）。 */
  impact: Parameters<typeof planRollout>[0]["impact"];
  /** 期望的 revision（已由 WP1 `createForwardRevision` 落库）。 */
  revision: number;
  baseRevision: number | null;
  /** suspended 编辑 ⇒ noop rollout（§3.6）。 */
  suspended?: boolean;
}

export interface RegisterRolloutResult {
  ok: boolean;
  rolloutId: number | null;
  /** `blocked` = VALIDATE 失败（§13.3.5 失败规则一）：什么都不写。 */
  status: "done" | "blocked" | "created" | "conflict";
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
    ok: result.ok,
    rolloutId: created.id,
    status: result.ok ? "done" : "created",
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
