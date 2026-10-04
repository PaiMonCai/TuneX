/**
 * V5.3 WP10 —— 自动故障转移**循环**（把执行器挂到既有节拍上）。
 *
 * 本模块只做三件事，且每件都必须由调用方看见结果：
 *   1. 找出"值得评估"的 Forward（有归属租约、是 RELAY/DIRECT 的承载者）；
 *   2. 为每个 Forward 提供策略与候选节点这两个**没有 schema 归属**的输入（§8 的开放项）；
 *   3. 调用既有执行器，并把它的结构化结果原样汇总出去（不吞、不简化成布尔）。
 *
 * 刻意的取舍：
 *   · **不新开时间心跳**：挂在既有 reconcile 节拍上（先恢复未完成的 rollout，再评估迁移），
 *     第二条时间真相是本项目反复禁止的；
 *   · **不做补偿**：执行器失败即失败，epoch 永不回退（回退=重开双主窗口）；
 *   · **fail-closed**：策略没被配置过 ⇒ `auto_failover=false`；候选节点找不到 ⇒ 不迁移；
 *     端口事实读不到 ⇒ 执行器按 0 处理（不迁移）。
 */

import { db } from "../db.ts";
import { systemConfig } from "./config.ts";
import {
  executeFailoverForTunnel,
  readFailoverDecisionFacts,
  type ApplyPlacementMove,
  type FailoverExecutorDeps,
  type FailoverExecutionResult,
  type FailoverExecutorDb,
  type FailoverDestinations,
  type PlacementMoveRequest,
} from "./failover-executor.ts";
import type { FailoverPolicyFacts } from "./failover-policy.ts";

/** 策略配置键：`{ "auto_failover": bool, "auto_failback": bool }`。 */
export const FAILOVER_POLICY_CONFIG_KEY = "FAILOVER_POLICY";

/**
 * 读运维策略。
 *
 * **缺省即关**：没配置过就两个都 false。§8 要求"自动迁移必须是显式 policy"，
 * 而"默认打开、出事再关"正好违背它 —— 迁移是会中断服务的动作，不该由缺省值开启。
 * 坏 JSON 同样按关闭处理（并**报告**，见调用方的 log）。
 */
export async function readFailoverPolicy(): Promise<FailoverPolicyFacts & { parse_error?: string }> {
  const raw = await systemConfig.getConfig(FAILOVER_POLICY_CONFIG_KEY).catch(() => null);
  if (raw === null || raw === "") return { auto_failover: false, auto_failback: false };
  try {
    const parsed = JSON.parse(raw) as { auto_failover?: unknown; auto_failback?: unknown };
    return {
      auto_failover: parsed.auto_failover === true,
      auto_failback: parsed.auto_failback === true,
    };
  } catch (e) {
    return {
      auto_failover: false,
      auto_failback: false,
      parse_error: (e as Error)?.message ?? String(e),
    };
  }
}

/**
 * 候选节点：同一**入口节点组**内、非现任、在线、角色能当入口的节点。
 *
 * 这是调度关注点，因此不需要存储：§8 说的 preferred/standby 是"谁更适合承载"，
 * 而今天能回答这个问题的唯一事实来源就是节点组与节点角色。找不到就返回空
 * —— 执行器会给出 `standby_candidate` 这条 blocker，而不是拿一个随便的节点去迁。
 */
export async function pickFailoverDestination(ctx: {
  tunnel_id: number;
  workspace_id: number;
  owner_node_id: number | null;
}): Promise<FailoverDestinations> {
  const tunnel = await db.tunnel.findUnique({
    where: { id: ctx.tunnel_id },
    select: { in_node_group_id: true },
  });
  if (!tunnel) return { candidate_node_id: null, preferred_node_id: null };
  const candidates = await db.node.findMany({
    where: {
      node_group_id: tunnel.in_node_group_id,
      id: ctx.owner_node_id === null ? undefined : { not: ctx.owner_node_id },
      role: { in: ["ingress", "both"] },
      // 只看"这个节点自己说自己还活着"的节点：面板最近收到过它的上报。
      state_report: { reported_at: { gt: new Date(Date.now() - 5 * 60_000) } },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  // 今天没有"首选节点"的存储归属，所以不做偏好排序：按 id 取第一个可用候选。
  // 这是**刻意的**：偏好是产品决定，没有地方表达时就不该由实现者挑一个当默认。
  return { candidate_node_id: candidates[0]?.id ?? null, preferred_node_id: null };
}

export interface FailoverSweepOptions {
  /** 只评估这些 tunnel（缺省 = 所有有归属租约的 Forward）。测试与小范围试跑都用它。 */
  readonly tunnelIds?: readonly number[];
  readonly db?: FailoverExecutorDb;
  readonly now?: () => Date;
  readonly log?: (event: { level: "info" | "warn" | "error"; message: string; detail?: unknown }) => void;
  /**
   * 策略来源。缺省读系统配置；注入之后本模块的策略分支可以在**没有数据库**的进程里断言
   * —— "策略没配置 ⇒ 什么都不做"这条 fail-closed 规则值得被钉住，而它恰恰是最不该需要
   * 起一个数据库才能测的规则。
   */
  readonly readPolicy?: typeof readFailoverPolicy;
  /** 只评估这些 tunnel 时用的执行器（测试注入替身）。 */
  readonly execute?: typeof executeFailoverForTunnel;
}

export interface FailoverSweepResult {
  readonly evaluated: number;
  readonly moved: number;
  readonly held: number;
  readonly results: readonly FailoverExecutionResult[];
}

/**
 * 一次扫描：找出候选 Forward，逐个交给执行器。
 *
 * 逐个而不是并发：迁移会改归属并触发 rollout，多个同时迁移会让"冷却"与"端口可用性"这两个
 * 判断基于彼此过期的快照。一次扫描处理一个，下一拍再处理下一个 —— 慢一点，但每个决定都
 * 建立在真实状态上。
 */
export async function runFailoverSweep(options: FailoverSweepOptions = {}): Promise<FailoverSweepResult> {
  const now = options.now ?? (() => new Date());
  const logFn = options.log ?? ((e) => console.log(`[failover] ${e.level} ${e.message}`, e.detail ?? ""));

  const policy = await (options.readPolicy ?? readFailoverPolicy)();
  if (policy.parse_error) {
    logFn({ level: "warn", message: "FAILOVER_POLICY 配置无法解析，按关闭处理", detail: policy.parse_error });
  }
  // 策略关闭时**不扫描**：省掉每拍的读库，也让"没开自动迁移"在日志里是静默的而不是每拍一条 hold。
  if (!policy.auto_failover && !policy.auto_failback) {
    return { evaluated: 0, moved: 0, held: 0, results: [] };
  }

  const tunnelIds = options.tunnelIds
    ? [...options.tunnelIds]
    : (
        await db.placementLease.findMany({ select: { tunnel_id: true }, orderBy: { tunnel_id: "asc" } })
      ).map((l) => l.tunnel_id);

  const deps: FailoverExecutorDeps = {
    readDecisionFacts: (input) =>
      readFailoverDecisionFacts(input, {
        db: options.db ?? (db as unknown as FailoverExecutorDb),
        policy: () => policy,
        destinations: (ctx) => pickFailoverDestination(ctx),
      }),
    loadLease: async (tunnelId) => (await import("./placement-lease.ts")).loadLease(tunnelId),
    claimLease: async (input) => (await import("./placement-lease.ts")).claimLease(input),
    applyPlacementMove: defaultApplyPlacementMove,
    now,
    log: (event) =>
      logFn({
        level: event.level,
        message: `failover ${event.event}${event.reason ? ` (${event.reason})` : ""}`,
        detail: { tunnel_id: event.tunnel_id, detail: event.detail },
      }),
  };

  const results: FailoverExecutionResult[] = [];
  let moved = 0;
  let held = 0;
  for (const tunnelId of tunnelIds) {
    const result = await (options.execute ?? executeFailoverForTunnel)(tunnelId, deps);
    results.push(result);
    if (result.outcome === "moved") moved += 1;
    if (result.outcome === "hold") held += 1;
    if (result.outcome !== "hold") {
      logFn({ level: "info", message: `failover ${result.outcome}`, detail: result });
    }
  }
  return { evaluated: tunnelIds.length, moved, held, results };
}

/**
 * 生产接线：走**既有**的 Forward 变更路径（用户在界面上改入口节点走的就是那条）。
 *
 * 放在这里而不是模块级 import：`forward-service` 在 import 期就需要 DATABASE_URL，
 * 动态解析让本模块（及其安全核心）可以在没有 env 的进程里被 import 与断言。
 */
const defaultApplyPlacementMove: ApplyPlacementMove = async (request: PlacementMoveRequest) => {
  const { patchForward } = await import("./forward-service.ts");
  const patch: Record<string, unknown> = { ingress_node_id: request.toNodeId };
  if (request.expectedConfigRevision !== null) patch.expected_revision = request.expectedConfigRevision;
  const result = await patchForward(request.tunnelId, request.workspaceId, patch);
  if (result.ok) {
    return { ok: true, kind: "dispatched", code: null, message: null, revision: null, apply_status: null };
  }
  // `patchForward` returns a DISCRIMINATED UNION: on failure the error fields are on the
  // result itself (`{ok:false, status, code, message}`), not nested under `.error`.
  const err = result as unknown as { status?: number; code?: string; message?: string };
  // 409（用户同时编辑过）是"被拒绝"而不是"失败"：它意味着乐观并发基线过期，
  // 执行器必须把它当作可重试的拒绝，而不是当成一次崩溃。
  const rejected = err.status === 409;
  return {
    ok: false,
    kind: rejected ? "rejected" : "failed",
    code: err.code ?? null,
    message: err.message ?? "placement move failed",
    revision: null,
    apply_status: null,
  };
};
