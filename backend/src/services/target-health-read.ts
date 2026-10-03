/**
 * V5.2 WP5 + WP6 的**读路径**：把「用户要什么」（desired targets）与「我们看到了什么」
 * （target_observation 投影）在一个地方合并，然后交给纯合成模块得出结论。
 *
 * 这一层存在的理由，和 `dispatchFactsFromRow` 存在的理由是同一条：**两类事实的合并
 * 只允许有一处实现**。散在各自的读路径里合，就会出现"某个视图忘了算 stale"、
 * "某个接口漏了逐观测者明细"这类缺陷 —— 而且它们都不会让测试变红，只会让运维看到
 * 两个不一致的结论。
 *
 * 本模块**没有任何决策权**：
 *   · 它不筛选目标（期望清单原样进、原样出，包括当前 unhealthy 的那些）；
 *   · 它不写任何东西（观测由 Agent 上报、由 node-state 落库）；
 *   · 它不缓存结论（时间永远来自调用方传入的 `now`，见下）。
 */

import { db } from "../db.ts";
import {
  synthesiseTargetPool,
  type TargetHealthMemory,
  type TargetHealthView,
  type TargetObservationGroup,
} from "./target-health.ts";
import { targetKeyOf } from "./node-state.ts";

/** 一个池里的一条期望目标（host/port 来自 desired，不是来自观测）。 */
export interface DesiredTargetRef {
  readonly host: string;
  readonly port: number;
}

export interface TargetHealthReadResult {
  readonly targets: readonly TargetHealthView[];
  /**
   * 参与合成的观测节点 id（升序去重）。当它为空时，所有目标必然是 `unknown` ——
   * "没有任何节点观测过"和"观测过且都健康"必须是两个不同的结论，这个列表就是
   * 面板区分它们的方式。
   */
  readonly observers: readonly number[];
  /** 本次合成的时刻。调用方必须把它透传给视图，不让下游再取一次时间。 */
  readonly now: Date;
}

/**
 * 读取一批期望目标的健康视图。
 *
 * `now` 是**参数**而不是模块自己取的 `Date.now()`：同一份读结果里所有目标必须用
 * 同一个时刻判定 stale，否则同一次响应里会出现互相矛盾的新鲜度（一个目标刚过期、
 * 另一个还没过期）。这也让整条路径可以离线断言。
 */
/**
 * 观测读取的最小依赖面。
 *
 * 与 `forward-rollout-exec.ts` 里那条教训同一个理由：**通过注入的 store 读取，
 * 不要伸手抓进程级单例**。`db` 直接调用会让这条路径只能连库测，而它的大多数性质
 * （原样透传、unknown 兜底、共享同一个 now）都与数据库无关；注入之后这些性质可以
 * 离线断言，数据库只负责"行确实读得到"，那部分由 Gate 端到端覆盖。
 */
export interface TargetObservationStore {
  findMany(args: unknown): Promise<TargetObservationRow[]>;
}

/** `target_observation` 的一行（只列本模块用到的列）。 */
export interface TargetObservationRow {
  node_id: number;
  target_key: string;
  reachable: boolean;
  latency_ms: number | null;
  consecutive_success: number;
  consecutive_failure: number;
  success_rate: number;
  observed_at: Date;
  observation_source: string;
}

const defaultStore: TargetObservationStore = {
  findMany: (args) => db.targetObservation.findMany(args as never) as Promise<TargetObservationRow[]>,
};

export async function readTargetHealth(input: {
  desired: readonly DesiredTargetRef[];
  now: Date;
  /** 上一轮的合成记忆（用于 flap 窗口）。当前没有持久化，调用方按需传入。 */
  previous?: TargetHealthMemory | null;
  /** 观测来源；省略则用进程内的 Prisma 客户端（生产路径）。 */
  store?: TargetObservationStore;
}): Promise<TargetHealthReadResult> {
  const store = input.store ?? defaultStore;
  // 期望目标的身份先算齐，再一次性查观测：空集合就不要打扰数据库。
  const keys: string[] = [];
  const groups = new Map<string, DesiredTargetRef>();
  for (const target of input.desired) {
    const key = targetKeyOf(target.host, target.port);
    if (key === null) continue; // 非法目标不是观测问题，交给校验层，这里不发明身份
    keys.push(key);
    if (!groups.has(key)) groups.set(key, target);
  }

  const rows =
    keys.length === 0
      ? []
      : await store.findMany({
          where: { target_key: { in: keys } },
          orderBy: { node_id: "asc" },
        });

  const byKey = new Map<string, TargetObservationGroup["observations"][number][]>();
  const observers = new Set<number>();
  for (const row of rows) {
    observers.add(row.node_id);
    const list = byKey.get(row.target_key) ?? [];
    // observed_at（Agent 时钟）用于算 age；reported_at（DB 时钟）保留在行上，
    // 需要"不依赖 Agent 时钟的新鲜度"时读它。合成只吃前者，因为契约把 age 定义在
    // 观测时刻上。
    list.push({
      // 线上形状是 `<node>/<probe_kind>`，合成模块两种形状都接受；无法归属观测方
      // 的记录它不是证据，所以这里原样透传而不是自己拼一个。
      observation_source: row.observation_source,
      observed_at: row.observed_at,
      observation_age_ms: input.now.getTime() - row.observed_at.getTime(),
      reachable: row.reachable,
      latency_ms: row.latency_ms,
      consecutive_success: row.consecutive_success,
      consecutive_failure: row.consecutive_failure,
      success_rate: row.success_rate,
    });
    byKey.set(row.target_key, list);
  }

  // 期望清单**原样**进入合成：同一个 key 出现两次就出现两次（去重是产品语义，
  // 不是这一层能决定的），并且 unhealthy 的目标也照样在内。
  const targetInputs: TargetObservationGroup[] = keys.map((key) => ({
    target: key,
    observations: byKey.get(key) ?? [],
  }));

  return {
    targets: synthesiseTargetPool({
      targets: targetInputs,
      previous: input.previous ?? null,
      now: input.now,
    }),
    observers: [...observers].sort((a, b) => a - b),
    now: input.now,
  };
}

/**
 * 一个池的**期望目标**（来自 desired，不是来自观测）。
 *
 * `status` 非 active 的目标仍然算在期望清单里吗？算。原因是本模块不拥有"要不要看"
 * 这个判断：把停用目标从观测面里剔除，会让"你把它关了所以它不健康"和"它真的挂了"
 * 在面板上长得一样。停用目标是产品的决定，健康视图只报告事实。
 */
export async function readPoolTargetHealth(input: {
  poolId: number;
  now: Date;
  previous?: TargetHealthMemory | null;
  store?: TargetObservationStore;
}): Promise<{ ok: true; health: TargetHealthReadResult } | { ok: false; reason: "not_found" }> {
  const pool = await db.egressPool.findUnique({
    where: { id: input.poolId },
    select: { id: true, targets: { select: { host: true, port: true }, orderBy: { order_by: "asc" } } },
  });
  if (!pool) return { ok: false, reason: "not_found" };
  const health = await readTargetHealth({
    desired: pool.targets.map((t) => ({ host: t.host, port: t.port })),
    now: input.now,
    previous: input.previous ?? null,
    store: input.store,
  });
  return { ok: true, health };
}
