/**
 * Forward rollout state, ledger and compare-and-swap helpers.
 *
 * This module owns resumable ledger shape and phase transitions. Runtime side
 * effects remain in forward-rollout-exec.ts.
 */
import type { acquirePort, releaseLease } from "./portPool.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { RolloutPlan, RolloutSnapshot } from "./forward-rollout.ts";
import type { RuntimeUseDenied, RuntimeUseResource } from "./forward-capability.ts";
import type { ForwardHopSender } from "./federation/forward-hop.ts";

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
  /** Offline seam for all-node native composite admission before side effects. */
  loadCapabilityFacts?: import("./runtime-admission.ts").CapabilityFactsLoader;
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

