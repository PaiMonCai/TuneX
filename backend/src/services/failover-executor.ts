/**
 * V5.3 WP10 —— 归属迁移**执行器**：把 `decideFailover` 的判定变成一次安全的归属迁移。
 *
 * 这是 V5.3 里最危险的一段代码：这里写错不会让用例变红，而是让两台节点同时服务同一条
 * Forward（§8.2）。所以本模块的每一步都只有一个理由，且**全部 IO 都注入**（测试可以
 * 离线跑全部路径，包括"旧租约还活着"和"别人已经先动了"）。
 *
 * ── 执行顺序，以及为什么只能是这个顺序 ──
 *
 * ~~~text
 *   0. deps.now()                       注入的时刻（唯一的时间来源）
 *   1. readDecisionFacts(tunnelId)       读事实（真库读路径，注入）
 *   2. decideFailover(facts)             纯策略（failover-policy.ts，不在这里重写）
 *   3. CAS：loadLease 与 expected_epoch 比对
 *        ├─ 不等 ⇒ abort(epoch_mismatch)：别人已经迁移过，**什么都不改**
 *        └─ 相等 ⇒ 继续
 *   4. claimLease(目的节点)               两阶段交接（placement-lease.ts）
 *        ├─ not_expired ⇒ waiting：旧租约还活着，等它，**什么都不改**
 *        └─ ok ⇒ 归属已经是目的节点的了（epoch + 1）
 *   5. applyPlacementMove()              既有变更路径（forward-service → rollout 五阶段）
 * ~~~
 *
 * **为什么先认领、再迁移**（这一步错了就是双主或长中断）：
 *   · 如果先迁移再认领：rollout 的 `cutover_ingress` 会向新节点下发，而下发路径
 *     （`orchestrator.claimOwnership`）在**旧租约未过期**时会拒绝下发 —— 迁移根本推不动；
 *     就算推得动，新节点在旧租约还活着时激活 = 双主窗口，正是 §8 禁止的"先给新的、再收旧的"。
 *   · 所以：先让旧租约过期（或者等到它过期），认领成功（epoch + 1）之后旧节点立刻被
 *     栅栏挡住（Agent 侧拒绝 stale epoch，§8.2），新节点还没开始服务 —— 这中间是**短暂
 *     中断**，而不是双主。§8 的取舍是明写的：「"可能还有另一个主人"比"短暂中断"更危险」。
 *   · 认领之后 rollout 里的下发路径会**再次**认领同一个节点，那是**续约**（同 epoch），
 *     幂等且无害 —— epoch 的推进只发生在我的第 4 步这一处。
 *
 * ── 残差风险（明确写出来，不藏）──
 *
 * 第 4 步成功、第 5 步失败时，新节点持有归属但还没服务，旧节点已被栅栏挡住 ⇒ 服务中断，
 * 直到 rollout 被续跑（既有机制：`registerRollout` 写的 rollout 行 + worker 的
 * `resumeRollouts()`）。这是刻意的取舍，不是遗漏：**不允许**为了"恢复服务"把归属改回去
 * （epoch 永不回退，§8 一），也不允许放宽两阶段交接。
 *
 * ── 为什么不自己下发 ──
 *
 * 迁移**必须**走既有变更路径（`forward-service.patchForward` → `registerRollout` →
 * 五阶段 rollout 的 `node_migration` 计划）。本模块只提交一次"入口节点换成 X"的变更，
 * 自己不构造任何下发序列：第二条搬 Forward 的路正是这个项目反复拒绝的东西，而且它必然
 * 与既有路径的 drain / 端口租约释放 / 补偿逻辑产生分歧。`patchForward` 只接收
 * `{ ingress_node_id }`，所以这里**没有任何字段**能表达目标/desired 的改动 ——
 * 迁移改的是"谁承载"，不是"指向什么"。
 */
import { decideFailover, placementMigration, type FailoverDecision } from "./failover-policy.ts";
import type {
  FailoverCandidateFacts,
  FailoverCooldownFacts,
  FailbackFacts,
  FailoverInput,
  FailoverObservedTarget,
  FailoverPolicyFacts,
  MigrationKind,
  OwnerLivenessFacts,
  PlacementFacts,
  PlacementMigration,
} from "./failover-policy.ts";
import type { LeaseClaimResult, PlacementLeaseRow } from "./placement-lease.ts";
import { deriveConnection } from "./node-lifecycle.ts";
import { synthesiseTargetHealth } from "./target-health.ts";

/**
 * 本模块**静态**只 import 纯模块（策略、连接判定、WP6 合成、阈值）。
 *
 * 与 DB / orchestrator 耦合的三个模块（`placement-lease` / `portPool` /
 * `forward-service`）一律在**默认接线的调用点**动态解析：这样"决策 + CAS + 两阶段"
 * 这段安全核心可以在没有 DATABASE_URL 的进程里被 import 和测试，而生产接线仍然
 * 只有一条路（下面 `defaultFailoverExecutorDeps`）。
 */

/* ================================================================== */
/* 结果码                                                              */
/* ================================================================== */

export const FAILOVER_EXECUTOR_REASONS = [
  /** 策略判定不迁移（含全部 blockers）。 */
  "hold",
  /** 读不到决策事实（隧道不存在 / 库读失败）：不迁移。 */
  "facts_unavailable",
  /** CAS 失败：租约 epoch 已不是决策所依据的那个 —— 别人已经迁移过（幂等的关键）。 */
  "epoch_mismatch",
  /** 租约现任与决策假设的「迁出节点」不一致：事实对不上，不迁移。 */
  "owner_mismatch",
  /** 两阶段：旧租约还没过期 —— 等它，不强行交接。 */
  "old_lease_still_live",
  /** 认领被拒（not_owner / not_found）。 */
  "claim_rejected",
  /** 认领回来的 epoch ≠ expected + 1：读与认领之间有人抢先迁移。 */
  "claim_epoch_unexpected",
  /** 既有变更路径因并发编辑冲突而拒绝（用户正在编辑同一条 Forward）。 */
  "placement_move_conflict",
  /** 既有变更路径拒绝（VALIDATE 不放行 / 校验失败 / 节点不可用）。 */
  "placement_move_rejected",
  /** 变更已提交但 rollout 失败（补偿或待续跑）。 */
  "placement_move_failed",
  /** 迁移已推进。 */
  "moved",
] as const;

export type FailoverExecutorReason = (typeof FAILOVER_EXECUTOR_REASONS)[number];

export type FailoverOutcome = "moved" | "hold" | "waiting" | "aborted" | "failed";

const FAILOVER_EXECUTOR_REASON_TEXT: Record<FailoverExecutorReason, string> = {
  hold: "策略判定不迁移",
  facts_unavailable: "读不到决策事实：不迁移",
  epoch_mismatch: "租约 epoch 已变（别人已经迁移过）：中止且不改动任何东西",
  owner_mismatch: "租约现任与决策假设的迁出节点不一致：中止",
  old_lease_still_live: "旧租约尚未过期：等待两阶段交接条件成立",
  claim_rejected: "认领归属被拒绝",
  claim_epoch_unexpected: "认领返回的 epoch 不是预期的新世代（有人抢先迁移）",
  placement_move_conflict: "该转发正在被并发编辑：本次迁移中止",
  placement_move_rejected: "既有变更路径拒绝了本次归属变更",
  placement_move_failed: "归属变更已提交，但下发失败（等待续跑）",
  moved: "归属已迁移",
};

export function describeFailoverExecutorReason(reason: FailoverExecutorReason): string {
  return FAILOVER_EXECUTOR_REASON_TEXT[reason] ?? "归属迁移结果未知";
}

/* ================================================================== */
/* 决策事实（读路径的输出；纯策略的输入）                                 */
/* ================================================================== */

/**
 * 迁移执行需要、但**不属于纯策略**的上下文。
 *
 * `config_revision` 用于提交变更时做乐观并发（`patchForward` 的 `expected_revision`）：
 * 运维正在编辑同一条 Forward 时，自动化不该把人的改动覆盖掉，而应该中止并汇报。
 */
export interface DecisionFacts {
  readonly tunnel_id: number;
  readonly workspace_id: number;
  readonly config_revision: number | null;
  readonly placement: PlacementFacts;
  readonly owner: OwnerLivenessFacts;
  readonly candidate: FailoverCandidateFacts | null;
  readonly target_observations: FailoverInput["target_observations"];
  readonly cooldown: FailoverCooldownFacts;
  readonly policy: FailoverPolicyFacts;
  readonly failback: FailbackFacts | null;
}

/** 事实读不到时给出机器可读原因（**不**抛错：调用方要能记录它）。 */
export type ReadDecisionFactsResult =
  | { ok: true; facts: DecisionFacts }
  | {
      ok: false;
      /**
       * `tunnel_not_found` = 行不存在；`no_placement` = 既没有租约也没有入口节点，
       * 于是没有"谁的归属"可迁移（**不是**默认成节点 0 然后假迁移一次）；
       * `db_unavailable` = 读失败。
       */
      code: "tunnel_not_found" | "no_placement" | "db_unavailable";
      detail: string | null;
    };

/** 事实读取端口（注入；默认实现见 `readFailoverDecisionFacts`）。 */
export type ReadDecisionFacts = (input: {
  tunnelId: number;
  now: Date;
}) => Promise<ReadDecisionFactsResult>;

/* ================================================================== */
/* 迁移端口（既有变更路径）                                              */
/* ================================================================== */

/**
 * 一次归属变更的请求。
 *
 * **只有入口节点一个可变字段**：没有 target / desired 相关字段，因此本模块在类型层面
 * 就无法改「这条 Forward 指向什么」。选中哪个候选节点是调用方的事（池策略），
 * 这里只回答「能不能迁到它」以及「怎么安全地迁」。
 */
export interface PlacementMoveRequest {
  readonly tunnelId: number;
  readonly workspaceId: number;
  readonly fromNodeId: number;
  readonly toNodeId: number;
  readonly kind: MigrationKind;
  /** 迁移指令所依据的 epoch（调用方以它 CAS）。 */
  readonly expectedEpoch: number;
  /** 新世代 = expectedEpoch + 1。 */
  readonly nextEpoch: number;
  /** 提交变更时的乐观并发基线（用户若同时编辑过，变更会被拒绝而不是被覆盖）。 */
  readonly expectedConfigRevision: number | null;
}

/**
 * 迁移端口的结果。
 *
 * `kind` 三态刻意分开：`rejected` 表示**什么都没改**（可以安全地再试），
 * `failed` 表示**desired 已提交、下发失败**（要靠既有 rollout 续跑恢复），
 * 把两者混成一个 `ok:false` 会让调用方分不清"要不要重试"和"要不要等续跑"。
 */
export interface PlacementMoveResult {
  readonly ok: boolean;
  readonly kind: "dispatched" | "rejected" | "failed";
  readonly code: string | null;
  readonly message: string | null;
  /** 变更后的 revision / apply_status（可观测；读不到时为 null）。 */
  readonly revision: number | null;
  readonly apply_status: string | null;
}

/** 迁移端口（注入；默认实现 = `forward-service.patchForward` → 既有 rollout）。 */
export type ApplyPlacementMove = (request: PlacementMoveRequest) => Promise<PlacementMoveResult>;

/* ================================================================== */
/* 依赖（全部注入：照 `RolloutDeps` 的形态）                             */
/* ================================================================== */

export interface FailoverExecutorEvent {
  readonly level: "info" | "warn" | "error";
  readonly event: "decision" | "abort" | "waiting" | "claim" | "moved" | "failed";
  readonly tunnel_id: number;
  /** 终态事件带机器可读原因；`decision` 事件还没有终态，所以是 null（action 在 detail 里）。 */
  readonly reason: FailoverExecutorReason | null;
  readonly detail: string | null;
  readonly from_node_id: number | null;
  readonly to_node_id: number | null;
  readonly epoch: number | null;
  /** 策略判定（只有 `decision` 事件带）。 */
  readonly action?: string | null;
}

export interface FailoverExecutorDeps {
  /** 读决策事实。**必填**：与本项目其它执行器一样，不提供"忘了注入就静默走进程单例"的路。 */
  readDecisionFacts: ReadDecisionFacts;
  /** 读当前租约（CAS 的依据）。 */
  loadLease: (tunnelId: number) => Promise<PlacementLeaseRow | null>;
  /** 认领归属（两阶段交接）。 */
  claimLease: (input: {
    tunnelId: number;
    nodeId: number;
    revision: number;
    now: Date;
  }) => Promise<LeaseClaimResult>;
  /** 提交归属变更（既有 rollout 路径）。 */
  applyPlacementMove: ApplyPlacementMove;
  /** 注入的时刻；缺省 = `new Date()`（唯一允许读时钟的地方）。 */
  now?: () => Date;
  /** 结构化日志端口；缺省 = 不记录（结果对象本身始终带原因）。 */
  log?: (event: FailoverExecutorEvent) => void;
}

export interface FailoverExecutionResult {
  readonly tunnel_id: number;
  readonly outcome: FailoverOutcome;
  readonly reason: FailoverExecutorReason;
  readonly detail: string | null;
  /** 策略判定（`hold` 时也带，含全部 blockers / conditions）。 */
  readonly decision: FailoverDecision | null;
  /** 迁移指令（判定为 hold 时为 null）。 */
  readonly migration: PlacementMigration | null;
  /** CAS 读到的租约（迁移前）。 */
  readonly lease_before: PlacementLeaseRow | null;
  /** 认领之后的租约（未认领时与 before 相同）。 */
  readonly lease_after: PlacementLeaseRow | null;
  /** 迁移端口的结果（未走到迁移时为 null）。 */
  readonly move: PlacementMoveResult | null;
}

/* ================================================================== */
/* 纯映射（可离线穷举单测）                                              */
/* ================================================================== */

/** 把读路径的事实折成纯策略的输入。时间由调用方注入，不在这里读时钟。 */
export function buildDecisionInput(
  facts: DecisionFacts,
  now: Date,
  thresholds?: FailoverInput["thresholds"],
): FailoverInput {
  return {
    forward_id: facts.tunnel_id,
    now,
    placement: facts.placement,
    owner: facts.owner,
    candidate: facts.candidate,
    target_observations: facts.target_observations,
    cooldown: facts.cooldown,
    policy: facts.policy,
    failback: facts.failback,
    thresholds: thresholds ?? null,
  };
}

/**
 * 把既有变更路径的结果折成本执行器的三态结果。
 *
 * 与 `patchForward` 的契约逐条对应（`ForwardServiceResult`）：
 *   · `ok: false, status 409` → `rejected`（乐观并发：用户在改同一条 Forward）；
 *   · `ok: false, status 502` → `failed`（`apply_failed`：变更已推下去并失败）；
 *   · `ok: false` 其它 → `rejected`（校验 / 节点不可用 / 库不可用：什么都没改）；
 *   · `ok: true` 且 `apply_status === "error"` → `failed`（desired 已落库、下发失败）；
 *   · `ok: true` 其它 → `dispatched`（变更已提交并交给 rollout，含 waiting/in_progress）。
 *
 * 注意 `patchForward` 在 VALIDATE 被拒时也返回 `ok: true`（§13.3.6：desired 落库成功，
 * runtime 待节点恢复后再应用）—— 那是**已提交**，不是失败，所以这里按 `apply_status`
 * 再分一次，而不是把 `ok: true` 一律当成"新节点已经开始服务"。
 */
export function classifyMoveResult(
  result:
    | { ok: true; data: unknown }
    | { ok: false; status: number; code: string; message: string },
): PlacementMoveResult {
  if (!result.ok) {
    // 502 = `apply_failed`：变更已经走到下发阶段并失败（要么已补偿、要么等续跑）；
    // 409 = 乐观并发冲突；400/403/404/503 = 什么都没改。
    if (result.status === 502) {
      return {
        ok: false,
        kind: "failed",
        code: result.code,
        message: result.message,
        revision: null,
        apply_status: null,
      };
    }
    return {
      ok: false,
      kind: "rejected",
      code: result.code,
      message: result.message,
      revision: null,
      apply_status: null,
    };
  }
  const view = (result.data ?? {}) as Record<string, unknown>;
  const applyStatus = typeof view.apply_status === "string" ? view.apply_status : null;
  const revision = typeof view.config_revision === "number" ? view.config_revision : null;
  if (applyStatus === "error") {
    return {
      ok: false,
      kind: "failed",
      code: typeof view.apply_error_code === "string" ? view.apply_error_code : "apply_failed",
      message: typeof view.apply_error === "string" ? view.apply_error : null,
      revision,
      apply_status: applyStatus,
    };
  }
  return { ok: true, kind: "dispatched", code: null, message: null, revision, apply_status: applyStatus };
}

function outcomeFor(reason: FailoverExecutorReason): FailoverOutcome {
  switch (reason) {
    case "hold":
      return "hold";
    case "old_lease_still_live":
      return "waiting";
    case "placement_move_failed":
      return "failed";
    case "moved":
      return "moved";
    default:
      return "aborted";
  }
}

/* ================================================================== */
/* 执行器                                                              */
/* ================================================================== */

/**
 * 判断并（在允许时）执行一次归属迁移。
 *
 * 纯编排：所有 IO 走 `deps`，所有规则走 `decideFailover`。任何一条路径都返回
 * 结构化的 `reason`，没有"静默什么都不做"的分支。
 */
export async function executeFailoverForTunnel(
  tunnelId: number,
  deps: FailoverExecutorDeps,
): Promise<FailoverExecutionResult> {
  const now = deps.now?.() ?? new Date();
  const log = (event: FailoverExecutorEvent): void => {
    deps.log?.(event);
  };
  const base = {
    tunnel_id: tunnelId,
    decision: null,
    migration: null,
    lease_before: null,
    lease_after: null,
    move: null,
  } satisfies Omit<FailoverExecutionResult, "outcome" | "reason" | "detail">;

  // ── 1. 事实 ──
  const read = await deps.readDecisionFacts({ tunnelId, now });
  if (!read.ok) {
    const reason: FailoverExecutorReason = "facts_unavailable";
    log({
      level: "warn",
      event: "abort",
      tunnel_id: tunnelId,
      reason,
      detail: `${read.code}: ${read.detail ?? ""}`.trim(),
      from_node_id: null,
      to_node_id: null,
      epoch: null,
    });
    return { ...base, outcome: outcomeFor(reason), reason, detail: `${read.code}: ${read.detail ?? ""}`.trim() };
  }

  const facts = read.facts;

  // ── 2. 纯策略判定 ──
  const decision = decideFailover(buildDecisionInput(facts, now));
  const migration = placementMigration(decision);
  const decisionResult = { ...base, decision, migration };
  log({
    level: "info",
    event: "decision",
    tunnel_id: tunnelId,
    reason: null,
    action: decision.action,
    detail: `action=${decision.action} blockers=${decision.blockers.map((b) => b.reason).join(",")}`,
    from_node_id: migration?.from_node_id ?? facts.placement.owner_node_id,
    to_node_id: migration?.to_node_id ?? null,
    epoch: facts.placement.epoch,
  });

  if (migration === null) {
    // hold：什么都没读、什么都没写。blockers 原样带回给调用方。
    const reason: FailoverExecutorReason = "hold";
    return { ...decisionResult, outcome: outcomeFor(reason), reason, detail: decision.blockers[0]?.detail ?? null };
  }

  // ── 3. CAS：租约 epoch 必须仍是决策所依据的那个 ──
  //
  // 这是「重复迁移无害」的全部机制：两次调用用同一份决策，第二次读到的 epoch 已经是
  // 第一次推进过的值，于是它在**动任何东西之前**就中止了。
  const leaseBefore = await deps.loadLease(tunnelId);
  const currentEpoch = leaseBefore?.epoch ?? 0;
  if (currentEpoch !== migration.expected_epoch) {
    const reason: FailoverExecutorReason = "epoch_mismatch";
    const detail = `租约 epoch=${currentEpoch}，决策所依据的是 ${migration.expected_epoch}：别人已经迁移过`;
    log({
      level: "warn",
      event: "abort",
      tunnel_id: tunnelId,
      reason,
      detail,
      from_node_id: migration.from_node_id,
      to_node_id: migration.to_node_id,
      epoch: currentEpoch,
    });
    return { ...decisionResult, lease_before: leaseBefore, lease_after: leaseBefore, outcome: "aborted", reason, detail };
  }
  if (leaseBefore !== null && leaseBefore.owner_node_id !== migration.from_node_id) {
    const reason: FailoverExecutorReason = "owner_mismatch";
    const detail = `租约现任是 ${leaseBefore.owner_node_id}，决策假设迁出 ${migration.from_node_id}`;
    log({
      level: "warn",
      event: "abort",
      tunnel_id: tunnelId,
      reason,
      detail,
      from_node_id: migration.from_node_id,
      to_node_id: migration.to_node_id,
      epoch: currentEpoch,
    });
    return { ...decisionResult, lease_before: leaseBefore, lease_after: leaseBefore, outcome: "aborted", reason, detail };
  }

  // ── 4. 两阶段交接 ──
  const claim = await deps.claimLease({
    tunnelId,
    nodeId: migration.to_node_id,
    revision: facts.config_revision ?? 0,
    now,
  });

  if (!claim.ok) {
    if (claim.reason === "not_expired") {
      const reason: FailoverExecutorReason = "old_lease_still_live";
      const detail =
        `旧租约仍由节点 ${claim.current?.owner_node_id ?? "?"} 持有，` +
        `${claim.current?.lease_expires_at?.toISOString() ?? "?"} 才过期：等待，不强行交接`;
      log({
        level: "info",
        event: "waiting",
        tunnel_id: tunnelId,
        reason,
        detail,
        from_node_id: migration.from_node_id,
        to_node_id: migration.to_node_id,
        epoch: currentEpoch,
      });
      return {
        ...decisionResult,
        lease_before: leaseBefore,
        lease_after: leaseBefore,
        outcome: outcomeFor(reason),
        reason,
        detail,
      };
    }
    const reason: FailoverExecutorReason = "claim_rejected";
    const detail = `认领被拒：${claim.reason}`;
    log({
      level: "error",
      event: "abort",
      tunnel_id: tunnelId,
      reason,
      detail,
      from_node_id: migration.from_node_id,
      to_node_id: migration.to_node_id,
      epoch: currentEpoch,
    });
    return { ...decisionResult, lease_before: leaseBefore, lease_after: leaseBefore, outcome: "aborted", reason, detail };
  }

  // 认领成功。两种合法形态：
  //   · 换人 ⇒ epoch 必须正好是 decision 里的 next_epoch（否则是并发抢占）；
  //   · 已经是该目的地持有（changed_owner=false）⇒ 归属部分已经完成，幂等继续。
  if (claim.changed_owner && claim.epoch !== migration.next_epoch) {
    const reason: FailoverExecutorReason = "claim_epoch_unexpected";
    const detail = `认领得到 epoch=${claim.epoch}，期望 ${migration.next_epoch}：读与认领之间有人抢先迁移`;
    log({
      level: "error",
      event: "abort",
      tunnel_id: tunnelId,
      reason,
      detail,
      from_node_id: migration.from_node_id,
      to_node_id: migration.to_node_id,
      epoch: claim.epoch,
    });
    return {
      ...decisionResult,
      lease_before: leaseBefore,
      lease_after: claim.lease,
      outcome: "aborted",
      reason,
      detail,
    };
  }
  log({
    level: "info",
    event: "claim",
    tunnel_id: tunnelId,
    reason: "moved",
    detail: `归属 → 节点 ${claim.lease.owner_node_id}（epoch ${claim.epoch}，${claim.changed_owner ? "换人" : "已是现任"}）`,
    from_node_id: migration.from_node_id,
    to_node_id: migration.to_node_id,
    epoch: claim.epoch,
  });

  // ── 5. 既有变更路径：只提交入口节点的变化，剩下的交给 rollout 五阶段 ──
  let move: PlacementMoveResult;
  try {
    move = await deps.applyPlacementMove({
      tunnelId,
      workspaceId: facts.workspace_id,
      fromNodeId: migration.from_node_id,
      toNodeId: migration.to_node_id,
      kind: migration.kind,
      expectedEpoch: migration.expected_epoch,
      nextEpoch: migration.next_epoch,
      expectedConfigRevision: facts.config_revision,
    });
  } catch (e) {
    move = {
      ok: false,
      kind: "failed",
      code: "move_threw",
      message: e instanceof Error ? e.message : String(e),
      revision: null,
      apply_status: null,
    };
  }

  const leaseAfter = (await deps.loadLease(tunnelId).catch(() => null)) ?? claim.lease;

  if (move.kind === "rejected") {
    const conflict = move.code === "revision_conflict";
    const reason: FailoverExecutorReason = conflict ? "placement_move_conflict" : "placement_move_rejected";
    const detail = `${move.code ?? "rejected"}: ${move.message ?? ""}`.trim();
    log({
      level: "warn",
      event: "abort",
      tunnel_id: tunnelId,
      reason,
      detail,
      from_node_id: migration.from_node_id,
      to_node_id: migration.to_node_id,
      epoch: claim.epoch,
    });
    return {
      ...decisionResult,
      lease_before: leaseBefore,
      lease_after: leaseAfter,
      move,
      outcome: "aborted",
      reason,
      detail,
    };
  }

  if (move.kind === "failed") {
    const reason: FailoverExecutorReason = "placement_move_failed";
    const detail = `${move.code ?? "apply_failed"}: ${move.message ?? ""}`.trim();
    log({
      level: "error",
      event: "failed",
      tunnel_id: tunnelId,
      reason,
      detail,
      from_node_id: migration.from_node_id,
      to_node_id: migration.to_node_id,
      epoch: claim.epoch,
    });
    return {
      ...decisionResult,
      lease_before: leaseBefore,
      lease_after: leaseAfter,
      move,
      outcome: "failed",
      reason,
      detail,
    };
  }

  const reason: FailoverExecutorReason = "moved";
  const detail = `apply_status=${move.apply_status ?? "?"}`;
  log({
    level: "info",
    event: "moved",
    tunnel_id: tunnelId,
    reason,
    detail,
    from_node_id: migration.from_node_id,
    to_node_id: migration.to_node_id,
    epoch: claim.epoch,
  });
  return {
    ...decisionResult,
    lease_before: leaseBefore,
    lease_after: leaseAfter,
    move,
    outcome: outcomeFor(reason),
    reason,
    detail,
  };
}

/* ================================================================== */
/* 默认读路径（真库；db 注入以便离线测试）                                */
/* ================================================================== */

/** 本模块用到的 Prisma 最小接口（与 `RolloutDb` 同一条理由：替身只需要这几个方法）。 */
export interface FailoverExecutorDb {
  tunnel: { findUnique(args: unknown): Promise<unknown> };
  node: { findUnique(args: unknown): Promise<unknown> };
  targetObservation: { findMany(args: unknown): Promise<unknown> };
  forwardRollout: { findFirst(args: unknown): Promise<unknown> };
  egressPool?: { findUnique(args: unknown): Promise<unknown> };
}

/**
 * 目的地选择（§8.2 的 `preferred ingress` / `standby ingress[]`）。
 *
 * **今天没有对应的 schema 列**，所以这里是显式注入的选择器而不是某个默认实现：
 * 谁是对的候选（池策略、优先级、成本）是调用方的事，本模块只回答"能不能迁到它"。
 * 推荐实现：用调度器挑入口的同一套规则（`scheduler.pickNode`）在入口节点组里挑一个
 * 非现任节点。`preferred_node_id` 为空时不做自动回切（fail-closed）。
 */
export interface FailoverDestinations {
  readonly candidate_node_id: number | null;
  readonly preferred_node_id: number | null;
}

export interface FailoverFactsReaderOptions {
  readonly db: FailoverExecutorDb;
  /**
   * 运维策略（§8 条件 6）。**今天没有 schema 列**，因此必须由调用方给出来源；
   * 缺省实现（`defaultFailoverExecutorDeps`）用 fail-closed 的「不允许自动迁移」。
   */
  readonly policy: (ctx: {
    tunnel_id: number;
    workspace_id: number;
  }) => Promise<FailoverPolicyFacts> | FailoverPolicyFacts;
  /** 候选/首选节点。**今天没有 schema 列**：调用方挑选。 */
  readonly destinations: (ctx: {
    tunnel_id: number;
    workspace_id: number;
    owner_node_id: number | null;
  }) => Promise<FailoverDestinations> | FailoverDestinations;
  /** 读当前租约（默认 = placement-lease 的真实现）。 */
  readonly loadLease?: (tunnelId: number) => Promise<PlacementLeaseRow | null>;
  /**
   * 可用端口数（默认 = `portPool.availablePorts`，真库）。
   * 不抛：读不到按 0 处理（fail-closed —— 没有可靠端口事实就不迁移）。
   */
  readonly portAvailability?: (nodeId: number) => Promise<number>;
  /**
   * 上一次归属迁移时刻（冷却输入）。
   *
   * 默认实现读 **rollout 台账**里最近一条 `strategy = "node_migration"` 的行：
   * 一次归属迁移必然留下这样一条 rollout，所以这是既有的、真实的冷却来源。
   * 注意**不能**用租约行的 `updated_at`：续约也会更新它，冷却会被永远刷新。
   */
  readonly lastMigration?: (
    tunnelId: number,
  ) => Promise<{ at: Date | string | number | null; kind: MigrationKind | null } | null>;
  /**
   * 首选节点的连续健康判定次数。**今天没有计数器来源**，默认 0 —— 于是自动回切
   * 在接线之前不会发生（fail-closed，不会"凭一次探测把流量搬回去"）。
   */
  readonly failbackHealthyChecks?: (tunnelId: number) => Promise<number>;
  /** 观测新鲜度上限（ms）；缺省用 WP6 的 stale 线。 */
  readonly observationStaleAfterMs?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNodeId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** 目标身份（与 `node-state.targetKeyOf` 同口径：小写、去尾点、去 IPv6 方括号）。 */
export function targetKeyOf(host: unknown, port: unknown): string | null {
  if (typeof host !== "string") return null;
  const normalized = host.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  const p = num(port);
  if (!normalized || p === null || !Number.isInteger(p)) return null;
  return `${normalized}:${p}`;
}

/**
 * 读一次决策需要的全部事实。
 *
 * 只读既有投影：隧道行、归属租约、节点行（`deriveConnection` 判可达）、
 * `target_observation`（经 WP6 合成得到逐观测者结论）、rollout 台账（冷却）。
 * 三个**没有存储来源**的事实（策略、候选/首选、回切健康计数）由 options 注入，
 * 而不是在这里猜一个默认值。
 */
export async function readFailoverDecisionFacts(
  input: { tunnelId: number; now: Date },
  options: FailoverFactsReaderOptions,
): Promise<ReadDecisionFactsResult> {
  const { tunnelId, now } = input;
  const loadLeaseFn = options.loadLease ?? (await import("./placement-lease.ts")).loadLease;

  let tunnel: Record<string, unknown> | null;
  let lease: PlacementLeaseRow | null;
  try {
    tunnel = record(
      await options.db.tunnel.findUnique({
        where: { id: tunnelId },
        select: {
          id: true,
          workspace_id: true,
          tunnel_mode: true,
          config_revision: true,
          ingress_node_id: true,
          egress_node_id: true,
          egress_pool_id: true,
          // 只读目标身份，用于拼观测的 target_key；本模块没有任何字段可写 desired。
          remote_host: true,
          remote_port: true,
        },
      }),
    );
    lease = await loadLeaseFn(tunnelId);
  } catch (e) {
    return { ok: false, code: "db_unavailable", detail: e instanceof Error ? e.message : String(e) };
  }
  if (!tunnel) return { ok: false, code: "tunnel_not_found", detail: `tunnel ${tunnelId}` };

  const workspaceId = num(tunnel.workspace_id) ?? 0;
  const desiredIngress = asNodeId(tunnel.ingress_node_id);
  const ownerNodeId = lease?.owner_node_id ?? desiredIngress;
  if (ownerNodeId === null) {
    // 没有归属可迁移：既没有租约行也没有入口节点。**不**把它折成节点 0，
    // 否则策略会"从节点 0 迁移"，那是一个凭空捏造的归属事实。
    return { ok: false, code: "no_placement", detail: `tunnel ${tunnelId} 没有入口归属` };
  }
  const destinations = await options.destinations({
    tunnel_id: tunnelId,
    workspace_id: workspaceId,
    owner_node_id: ownerNodeId ?? null,
  });
  const policy = await options.policy({ tunnel_id: tunnelId, workspace_id: workspaceId });

  const ownerFacts = await readNodeFacts(options.db, ownerNodeId, now);

  const observations = await readObservations(options, tunnelId, tunnel, now);
  const candidate = await readDestination(options, destinations.candidate_node_id, now);
  const preferredId = destinations.preferred_node_id;
  let failback: FailbackFacts | null = null;
  if (preferredId !== null && preferredId !== ownerNodeId) {
    const preferred = await readDestination(options, preferredId, now);
    if (preferred !== null) {
      const checks = (await options.failbackHealthyChecks?.(tunnelId)) ?? 0;
      failback = { candidate: preferred, healthy_checks: checks };
    }
  }

  const migrated = await readLastMigration(options, tunnelId);

  return {
    ok: true,
    facts: {
      tunnel_id: tunnelId,
      workspace_id: workspaceId,
      config_revision: num(tunnel.config_revision),
      placement: {
        owner_node_id: ownerNodeId,
        epoch: lease?.epoch ?? 0,
        preferred_node_id: preferredId,
      },
      owner: { reachable: ownerFacts.reachable, last_seen_at: ownerFacts.last_seen_at },
      candidate,
      target_observations: observations,
      cooldown: { last_migration_at: migrated?.at ?? null, last_migration_kind: migrated?.kind ?? null },
      policy,
      failback,
    },
  };
}

/**
 * 节点存活事实：复用 V4 `node-lifecycle` 的连接判定，不在这里重写一套。
 *
 * **两个字段都要带出去**：只给 `reachable` 会让策略永远无法证明「不可达**且**超过
 * stale 阈值」—— 于是自动迁移永远发生不了（一个安静的"什么都不做"）。这正是
 * 端到端用例存在的原因。
 */
async function readNodeFacts(
  db: FailoverExecutorDb,
  nodeId: number,
  now: Date,
): Promise<{ reachable: boolean; last_seen_at: Date | null }> {
  const row = record(
    await db.node
      .findUnique({
        where: { id: nodeId },
        select: {
          status: true,
          last_seen_at: true,
          node_credential_hash: true,
          credential_revoked: true,
        },
      })
      .catch(() => null),
  );
  if (!row) return { reachable: false, last_seen_at: null };
  const lastSeen = row.last_seen_at instanceof Date ? row.last_seen_at : null;
  const reachable =
    deriveConnection({
      status: typeof row.status === "string" ? row.status : null,
      last_seen_at: lastSeen,
      has_credential: typeof row.node_credential_hash === "string" && row.node_credential_hash.length > 0,
      credential_revoked: row.credential_revoked === true,
      now,
    }) === "online";
  return { reachable, last_seen_at: lastSeen };
}

/**
 * 观测事实。
 *
 * DIRECT 读它自己的目标；RELAY 读**出口池的全部目标**并摊平 —— 池里任何一个目标有
 * 新鲜的"目标坏了"证据，都意味着"换入口节点帮不上忙"（§8 条件 3）。每条观测都经
 * WP6 `synthesiseTargetHealth` 变成逐观测者结论，本模块不重算健康规则。
 */
async function readObservations(
  options: FailoverFactsReaderOptions,
  tunnelId: number,
  tunnel: Record<string, unknown>,
  now: Date,
): Promise<FailoverInput["target_observations"]> {
  const keys: string[] = [];
  const directKey = targetKeyOf(tunnel.remote_host, tunnel.remote_port);
  if (directKey) keys.push(directKey);

  const poolId = asNodeId(tunnel.egress_pool_id);
  if (poolId !== null && options.db.egressPool) {
    const pool = record(
      await options.db.egressPool
        .findUnique({ where: { id: poolId }, select: { targets: { select: { host: true, port: true } } } })
        .catch(() => null),
    );
    const targets = Array.isArray(pool?.targets) ? (pool!.targets as unknown[]) : [];
    for (const entry of targets) {
      const t = record(entry);
      const key = targetKeyOf(t?.host, t?.port);
      if (key) keys.push(key);
    }
  }
  if (keys.length === 0) return { observers: [] };

  let rows: unknown[];
  try {
    rows = (await options.db.targetObservation.findMany({
      where: { target_key: { in: keys } },
      select: {
        node_id: true,
        target_key: true,
        reachable: true,
        latency_ms: true,
        consecutive_success: true,
        consecutive_failure: true,
        success_rate: true,
        observed_at: true,
        observation_source: true,
      },
    })) as unknown[];
  } catch {
    return { observers: [] };
  }

  const observers: FailoverObservedTarget[] = [];
  for (const entry of rows) {
    const row = record(entry);
    if (!row) continue;
    const key = typeof row.target_key === "string" ? row.target_key : `${tunnelId}`;
    // 经 WP6 合成：这条观测者的事实 → 它自己的结论 + 是否过期。
    const view = synthesiseTargetHealth({
      target: key,
      observations: [
        {
          observation_source: typeof row.observation_source === "string" ? row.observation_source : null,
          reachable: row.reachable === true,
          latency_ms: num(row.latency_ms),
          consecutive_success: num(row.consecutive_success),
          consecutive_failure: num(row.consecutive_failure),
          success_rate: num(row.success_rate),
          observed_at: row.observed_at instanceof Date ? row.observed_at : null,
        },
      ],
      previous: null,
      now,
      thresholds:
        options.observationStaleAfterMs === undefined
          ? null
          : { STALE_AFTER_MS: options.observationStaleAfterMs },
    });
    const observer = view.observers[0];
    if (!observer) continue;
    // 观测者身份取租约/DB 的节点 id（WP6 的 label 是线上字符串，两者都收）。
    observers.push({
      node_id: num(row.node_id) ?? observer.observer_label,
      state: observer.state,
      stale: observer.stale,
    });
  }
  return { observers };
}

/** 目的地的承载事实：节点在线 + 端口租约是否有可用端口。 */
async function readDestination(
  options: FailoverFactsReaderOptions,
  nodeId: number | null,
  now: Date,
): Promise<FailoverCandidateFacts | null> {
  if (nodeId === null) return null;
  const { reachable } = await readNodeFacts(options.db, nodeId, now);
  const count = options.portAvailability
    ? await options.portAvailability(nodeId).catch(() => 0)
    : await (await import("./portPool.ts"))
        .availablePorts(nodeId)
        .then((ports) => ports.length)
        .catch(() => 0);
  return { node_id: nodeId, reachable, port_available: count > 0, port_available_count: count };
}

/** 上一次归属迁移：rollout 台账里最近一条 `node_migration`。 */
async function readLastMigration(
  options: FailoverFactsReaderOptions,
  tunnelId: number,
): Promise<{ at: Date | string | number | null; kind: MigrationKind | null } | null> {
  if (options.lastMigration) return options.lastMigration(tunnelId);
  const row = record(
    await options.db.forwardRollout
      .findFirst({
        where: { tunnel_id: tunnelId, strategy: "node_migration" },
        orderBy: { id: "desc" },
        select: { created_at: true },
      })
      .catch(() => null),
  );
  if (!row) return null;
  const createdAt = row.created_at;
  return { at: createdAt instanceof Date ? createdAt : null, kind: null };
}

/* ================================================================== */
/* 默认接线                                                            */
/* ================================================================== */

export interface DefaultFailoverExecutorOptions extends Omit<FailoverFactsReaderOptions, "db"> {
  readonly db: FailoverExecutorDb;
  readonly now?: () => Date;
  readonly log?: (event: FailoverExecutorEvent) => void;
}

/**
 * 生产接线的默认依赖。
 *
 *   · 事实读取 = `readFailoverDecisionFacts`（真库）；
 *   · 租约 = `placement-lease.ts`（两阶段交接的唯一实现）；
 *   · 归属变更 = `forward-service.patchForward`（**既有**变更路径：它内部做 revision、
 *     impact、`registerRollout`，五阶段 rollout 里就是 `node_migration`）。
 *
 * 这里**没有**第二个"移动 Forward"的实现：本模块只把一次入口节点变更提交给既有路径。
 */
export function defaultFailoverExecutorDeps(options: DefaultFailoverExecutorOptions): FailoverExecutorDeps {
  const readerOptions: FailoverFactsReaderOptions = options;
  return {
    readDecisionFacts: (input) => readFailoverDecisionFacts(input, readerOptions),
    loadLease: async (tunnelId) => (await import("./placement-lease.ts")).loadLease(tunnelId),
    claimLease: async (input) => (await import("./placement-lease.ts")).claimLease(input),
    applyPlacementMove: async (request) => {
      // 迁移只走既有变更路径（forward-service.patchForward → registerRollout →
      // 五阶段 rollout 的 node_migration 计划）。本模块不构造第二套下发序列。
      const { patchForward } = await import("./forward-service.ts");
      const result = await patchForward(request.tunnelId, request.workspaceId, {
        ingress_node_id: request.toNodeId,
        // 乐观并发：运维正在编辑同一条 Forward 时，自动化不能覆盖人的改动。
        expected_revision: request.expectedConfigRevision,
      });
      return classifyMoveResult(result);
    },
    now: options.now,
    log: options.log,
  };
}
