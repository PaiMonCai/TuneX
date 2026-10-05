/**
 * Periodic subscription settlement orchestration.
 *
 * The database unique key on subscription + period is the idempotency gate:
 * workers claim a period before executing it, then mark the claim settled.
 * Stale pending claims may be taken over and replayed, so the injected period
 * executor must itself be idempotent. This module coordinates settlement state;
 * entitlement evaluation and purchase-grant semantics live in their own layers.
 */
import {
  billingDayStart,
  billingMonthStart,
  billingPeriodKey,
  type BillingPeriodGranularity,
} from "./billing-time.ts";

/** 接管超时缺省值（分钟）：与充值订单超时同口径（`routes/topups.ts` 的 10 分钟）。 */
export const DEFAULT_SETTLEMENT_TAKEOVER_MINUTES = 10;

/** 接管超时下限（分钟）。再小等于「执行前先认为上一个人死了」，只会白跑重复执行。 */
export const MIN_SETTLEMENT_TAKEOVER_MINUTES = 1;

/**
 * 接管超时上限（分钟）= 24 小时。
 * 反例：不设上限时一条 `BILLING_SETTLEMENT_TAKEOVER_MINUTES=525600`（一年）能让崩在中间的
 * `pending` 行整整一年无人接管——而它恰恰是「已经占位、还没执行」的钱路径。
 */
export const MAX_SETTLEMENT_TAKEOVER_MINUTES = 1440;

/**
 * 单轮最多处理多少条（占位阶段与接管阶段各自计数）。
 *
 * 与 `RESUME_BATCH_LIMIT=25` 同理：设上限只是为了让「异常堆积时这一拍有界」，正常量级
 * （每个订阅每月一行）永远触碰不到。超限置 `truncated`，剩余行下一轮继续。
 */
export const SETTLEMENT_BATCH_LIMIT = 200;

/** Persisted settlement states. */
export type SettlementState = "pending" | "settled" | "failed";

/** 结算周期键（`YYYY-MM` / `YYYY-MM-DD`，上海时区）。 */
export interface SettlementPeriod {
  /** 账本唯一键的一半；与订阅构成幂等闸门。 */
  period_key: string;
  /** 周期起点（上海自然月月首），用于「本周期开始时订阅是否仍有效」的判定。 */
  period_start: Date;
}

/** 解析后的接管超时（含「配置不可用」标记，供观测用）。 */
export interface TakeoverTimeoutDecision {
  /** 实际使用的分钟数（始终落在 `[1, MAX]`）。 */
  minutes: number;
  /** `config` 表里没有这一行。 */
  missing: boolean;
  /** 有这一行但值非法（非数字 / 0 / 负数 / 越界 / 小数），已回落默认值。 */
  invalid: boolean;
}

/**
 * 把 `SystemConfig.BILLING_SETTLEMENT_TAKEOVER_MINUTES` 的字符串解析成分钟数。
 *
 * 与 `traffic-retention.ts#resolveRetentionDays` 同一形状：**只回落、不抛异常**
 * （一条脏配置不该让钱路径的接管任务整轮挂掉）。缺省 / 非法一律用
 * {@link DEFAULT_SETTLEMENT_TAKEOVER_MINUTES}；小数向下取整，取整后越界按越界处理。
 */
export function resolveTakeoverTimeoutMinutes(
  raw: string | null | undefined,
): TakeoverTimeoutDecision {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { minutes: DEFAULT_SETTLEMENT_TAKEOVER_MINUTES, missing: true, invalid: false };
  }
  const numeric = Math.floor(Number(raw));
  const valid =
    Number.isFinite(numeric) &&
    numeric >= MIN_SETTLEMENT_TAKEOVER_MINUTES &&
    numeric <= MAX_SETTLEMENT_TAKEOVER_MINUTES;
  if (!valid) {
    return { minutes: DEFAULT_SETTLEMENT_TAKEOVER_MINUTES, missing: false, invalid: true };
  }
  return { minutes: numeric, missing: false, invalid: false };
}

/** Settlement period for the current tick; monthly is the production default. */
export function settlementPeriodFor(
  now: Date,
  granularity: BillingPeriodGranularity = "month",
): SettlementPeriod {
  return {
    period_key: billingPeriodKey(now, granularity),
    period_start: granularity === "month" ? billingMonthStart(now) : billingDayStart(now),
  };
}

/**
 * 是否是「占位撞唯一键」。
 *
 * 只认 Prisma 的 `P2002`（`portPool.ts#isUniqueConflict` 同口径）与 MySQL 的原生 `ER_DUP_ENTRY`
 * （1062）：除此之外的错误都是**真失败**，必须让调用方看见（把它当幂等跳过 = 把 DB 故障伪装成
 * 「这一周期已经结算过了」，那是最坏的一类静默）。
 */
export function isSettlementDuplicate(error: unknown): boolean {
  const shape = error as { code?: unknown; errno?: unknown } | null | undefined;
  if (!shape) return false;
  return shape.code === "P2002" || shape.errno === 1062;
}

/** 占位输入：一条「该订阅的本周期需要结算」的事实。 */
export interface SettlementTarget {
  subscription_id: number;
  workspace_id: number;
  plan_id: number;
  period_key: string;
  /** 只读字段：本模块**绝不**把它写成 `true`（DoD 第 9 条：自动动作默认关闭）。 */
  auto_renew: boolean;
  /** 订阅起点（生产查询已保证 `<= now`）。接管阶段只按账本行续跑，拿不到 ⇒ `null`。 */
  started_at: Date | null;
  expires_at: Date | null;
}

/** 占位阶段的到期订阅（订阅元数据齐全）。 */
export interface DuePeriod extends SettlementTarget {
  started_at: Date;
}

/** 接管阶段的待续跑行（必然是 `state="pending"` 且已超时）。 */
export interface StaleSettlementRow {
  id: number;
  subscription_id: number;
  workspace_id: number;
  plan_id: number;
  period_key: string;
  attempts: number;
  auto_renew: boolean;
}

/**
 * 执行器的结果。
 *
 * `charged=false` + 无 `deferred` = 本周期**没有**需要发生的钱/台账动作（只记账，见下）。
 */
export interface ExecuteOutcome {
  /** 本次是否真的发生了扣款/发放（WP20-4 接线后可能为 true）。 */
  charged: boolean;
  /** 产生的订单 id（没有订单为 null/省略）。 */
  order_id?: number | null;
  /**
   * 执行器判定「这一步现在还不该做」⇒ 行**留在 `pending`**，下一轮接管再来。
   * 用在「续期执行器尚未接线」这类场景：既不能假装 `settled`（那是谎报钱已经动过），
   * 也不能记 `failed`（`failed` 不会被接管，等于把一条钱路径永久静默丢掉）。
   */
  deferred?: boolean;
  /** `deferred` 的原因码（进 `error` 列，给人看；判定不依赖它）。 */
  reason?: string;
}

/** 结算编排的依赖（生产实现见 {@link defaultSettlementDeps}，测试注入内存替身）。 */
export interface SubscriptionSettlementDeps {
  /** 列出「本周期还没有占位行、且本周期开始时订阅仍有效」的订阅。 */
  listDuePeriods(input: { period: SettlementPeriod; now: Date; limit: number }): Promise<DuePeriod[]>;
  /** 列出超时未完成的 `pending` 行（接管续跑）。 */
  listStalePending(input: { cutoff: Date; limit: number }): Promise<StaleSettlementRow[]>;
  /**
   * ① 占位：`create` 一行账本。
   * **撞唯一键必须原样抛出**（由 {@link isSettlementDuplicate} 判定为幂等跳过），
   * 不要在这里吞掉错误——否则引擎无法区分「已被别人占了」与「DB 挂了」。
   */
  claimPeriod(input: {
    subscription_id: number;
    workspace_id: number;
    period_key: string;
    now: Date;
  }): Promise<{ id: number }>;
  /** ② 执行：扣款/发放（WP20-4 接线的位置）。必须对同一 `(subscription, period)` 幂等可重放。 */
  executePeriod(input: {
    row: SettlementTarget & { settlement_id: number };
    /** `claim` = 本轮新占位；`takeover` = 接管上一轮崩在中间的行。 */
    phase: "claim" | "takeover";
    now: Date;
  }): Promise<ExecuteOutcome>;
  /** ③a 落 `settled`。返回**恰好推进一行**才为 true（CAS：`where state="pending"`）。 */
  markSettled(input: {
    id: number;
    order_id: number | null;
    now: Date;
  }): Promise<{ advanced: boolean }>;
  /** ③b 落 `failed`（`attempts+1`、写 `error`、**不**写 `settled_at`）。 */
  markFailed(input: { id: number; error: string }): Promise<{ advanced: boolean }>;
  /** ③c 保持 `pending` 但记账一次尝试（`attempts+1`、写 `error`、**不动** `started_at`，见下）。 */
  markDeferred(input: { id: number; reason: string; now: Date }): Promise<{ advanced: boolean }>;
  /** 读 `SystemConfig.BILLING_SETTLEMENT_TAKEOVER_MINUTES`（返回 value 或 null）。 */
  readTakeoverTimeoutConfig(): Promise<string | null>;
  /** 可选的日志接缝（worker 里就是 console.log）。 */
  log?(event: Record<string, unknown>): void;
}

/** 一轮结算的结果统计（worker 每拍打印；「暴涨的 pending」= 环境有问题）。 */
export interface SettlementTickResult {
  /** 本轮结算的周期键。 */
  period_key: string;
  /** 本轮扫到的到期订阅数（已占位的不会再出现在这里）。 */
  due: number;
  /** 推到 `settled` 的行数（含接管成功的部分）。 */
  settled: number;
  /** 占位撞唯一键而跳过的条数（**只有并发**才会出现：串行连跑两轮时第二轮 `due=0`）。 */
  skipped: number;
  /** 执行器判定「现在不做」而留在 `pending` 的条数。 */
  deferred: number;
  /** 执行失败（含落终态 CAS 失败）的条数。 */
  failed: number;
  /**
   * 本轮**实际接管处理**的条数（含接管后又 `deferred` 的）。
   *
   * 语义刻意与 `settled` 分开：`settled` 数的是**结果**，`taken_over` 数的是**相位**。
   * 反例：若只把「接管后落 settled」计入，一条每次都 deferred 的续期会永远显示
   * `taken_over=0`，运维据此会以为「没有行被卡住」——而这恰恰是唯一被卡住的那类行。
   */
  taken_over: number;
  /** 生效的接管超时（分钟）。 */
  takeover_minutes: number;
  /** 配置缺失 / 非法标记（运维发现脏配置用）。 */
  takeover_config_missing: boolean;
  takeover_config_invalid: boolean;
  /** 单轮硬上限被触碰（剩余行下一轮继续）。 */
  truncated: boolean;
  /** 单条错误摘要（不含敏感字段）。 */
  errors: Array<{ subscription_id: number | null; period_key: string; error: string }>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 跑一轮结算（幂等，可重复执行）。
 *
 * @param deps 全部 I/O 依赖（可注入）。
 * @param now 显式时间点（契约 §7.2.2：编排层必须接受显式 `now`，**禁止** patch 全局 `Date.now`）。
 *            默认 `new Date()` 与 `deleteExpiredTraffic(deps, now = new Date())` 同口径。
 */
export async function settleDuePeriods(
  deps: SubscriptionSettlementDeps,
  now: Date = new Date(),
): Promise<SettlementTickResult> {
  const period = settlementPeriodFor(now);
  const takeover = resolveTakeoverTimeoutMinutes(await deps.readTakeoverTimeoutConfig());
  const result: SettlementTickResult = {
    period_key: period.period_key,
    due: 0,
    settled: 0,
    skipped: 0,
    deferred: 0,
    failed: 0,
    taken_over: 0,
    takeover_minutes: takeover.minutes,
    takeover_config_missing: takeover.missing,
    takeover_config_invalid: takeover.invalid,
    truncated: false,
    errors: [],
  };

  // ── 阶段一：接管上一轮崩在「占位之后、执行之前」的 pending 行 ──
  //
  // 放在占位之前（与 `cron_reconcile_v3` 先跑 `resumeRollouts` 同取向）：先把已经占了位的周期
  // 收口，再开新周期；否则同一订阅的「未完成旧周期」与「新周期」会在日志里交错，且一旦
  // 执行器对顺序敏感（例如续期要先于新月记账），反序会制造难以复现的状态。
  const takeoverCutoff = new Date(now.getTime() - takeover.minutes * 60_000);
  const stale = await deps.listStalePending({
    cutoff: takeoverCutoff,
    limit: SETTLEMENT_BATCH_LIMIT + 1,
  });
  if (stale.length > SETTLEMENT_BATCH_LIMIT) {
    result.truncated = true;
    stale.length = SETTLEMENT_BATCH_LIMIT;
  }
  for (const row of stale) {
    // 计数在**处理前**：`taken_over` 数的是「本轮接管了几行」，与它们最终落 settled 还是
    // 又被打回 deferred 无关（见 SettlementTickResult.taken_over 的反例）。
    result.taken_over += 1;
    await runExecution(deps, result, {
      row: {
        subscription_id: row.subscription_id,
        workspace_id: row.workspace_id,
        plan_id: row.plan_id,
        period_key: row.period_key,
        auto_renew: row.auto_renew,
        // 接管只按账本行续跑：订阅的起止日期与「本周期该不该结算」已经在建占位那一拍判定过。
        started_at: null,
        expires_at: null,
        settlement_id: row.id,
      },
      phase: "takeover",
      now,
    });
  }

  // ── 阶段二：为「本周期还没占位」的订阅占位并执行 ──
  const due = await deps.listDuePeriods({
    period,
    now,
    limit: SETTLEMENT_BATCH_LIMIT + 1,
  });
  if (due.length > SETTLEMENT_BATCH_LIMIT) {
    result.truncated = true;
    due.length = SETTLEMENT_BATCH_LIMIT;
  }
  result.due = due.length;

  for (const subscription of due) {
    // ① 占位。撞唯一键 = 并发下已被别处占了这一周期 ⇒ 幂等跳过（不是失败）。
    let claim: { id: number };
    try {
      claim = await deps.claimPeriod({
        subscription_id: subscription.subscription_id,
        workspace_id: subscription.workspace_id,
        period_key: subscription.period_key,
        now,
      });
    } catch (error) {
      if (isSettlementDuplicate(error)) {
        result.skipped += 1;
        continue;
      }
      result.failed += 1;
      result.errors.push({
        subscription_id: subscription.subscription_id,
        period_key: subscription.period_key,
        error: `claim_failed: ${errorText(error)}`,
      });
      continue;
    }

    await runExecution(deps, result, {
      row: { ...subscription, settlement_id: claim.id },
      phase: "claim",
      now,
    });
  }

  return result;
}

/** ② + ③：执行一次，并按结果落终态。单条失败只记账，不影响整轮。 */
async function runExecution(
  deps: SubscriptionSettlementDeps,
  result: SettlementTickResult,
  input: {
    // 接管阶段拿不到订阅的起止日期（只按账本行续跑）⇒ 用 SettlementTarget 而不是 DuePeriod。
    row: SettlementTarget & { settlement_id: number };
    phase: "claim" | "takeover";
    now: Date;
  },
): Promise<void> {
  const { row, phase, now } = input;
  try {
    const outcome = await deps.executePeriod({ row, phase, now });

    if (outcome.deferred) {
      const reason = outcome.reason ?? "deferred";
      const { advanced } = await deps.markDeferred({ id: row.settlement_id, reason, now });
      if (!advanced) {
        // CAS 失败 = 另一拍已经把这行推进到终态 ⇒ 幂等跳过，不重复计数。
        result.skipped += 1;
        return;
      }
      result.deferred += 1;
      deps.log?.({ event: "settlement_deferred", subscription_id: row.subscription_id, period_key: row.period_key, reason });
      return;
    }

    // ③ 落终态：CAS 到 `pending`，`advanced=false` 说明别处已经收口 ⇒ 跳过而非重复计成功。
    const { advanced } = await deps.markSettled({
      id: row.settlement_id,
      order_id: outcome.order_id ?? null,
      now,
    });
    if (!advanced) {
      result.skipped += 1;
      return;
    }
    result.settled += 1;
    deps.log?.({
      event: "settlement_settled",
      subscription_id: row.subscription_id,
      period_key: row.period_key,
      phase,
      charged: outcome.charged,
    });
  } catch (error) {
    const message = errorText(error);
    result.failed += 1;
    result.errors.push({
      subscription_id: row.subscription_id,
      period_key: row.period_key,
      error: `${phase}_failed: ${message}`,
    });
    // 落 `failed` 是本轮**最好努力**：连落失败都写不进去（DB 挂了）时不再抛，
    // 让这一拍继续收口其余行；行留在 `pending`，下一轮接管。
    try {
      await deps.markFailed({ id: row.settlement_id, error: message });
    } catch {
      /* 见上：整轮不因单条的行内更新失败而中断 */
    }
  }
}

/**
 * 生产依赖（懒加载 `../db.ts`，避免只 import 本模块的单测被迫连库——
 * 与 `defaultTrafficRetentionDeps` / `defaultRolloutResumeDeps` 同一口径）。
 */
export function defaultSettlementDeps(): SubscriptionSettlementDeps {
  const impl: SubscriptionSettlementDeps = {
    async listDuePeriods({ period, now, limit }) {
      const { db } = await import("../db.ts");
      const rows = await db.planSubscription.findMany({
        where: {
          started_at: { lte: now },
          // 本周期还没有占位行。注意这**不是**幂等闸门（闸门是 DB 唯一键），
          // 它只是让串行连跑的第二轮 `due=0`（DoD 第 4 条），省掉必然失败的 create。
          settlements: { none: { period_key: period.period_key } },
          // 本周期开始时订阅仍有效：终身订阅（`expires_at IS NULL`）恒真；
          // 已过期的订阅只在「它过期的那一个月」收口一次，之后不再产生新行。
          OR: [{ expires_at: null }, { expires_at: { gt: period.period_start } }],
        },
        orderBy: { id: "asc" },
        take: limit,
        select: {
          id: true,
          workspace_id: true,
          plan_id: true,
          started_at: true,
          expires_at: true,
          auto_renew: true,
        },
      });
      return rows.map((row) => ({
        subscription_id: row.id,
        workspace_id: row.workspace_id,
        plan_id: row.plan_id,
        period_key: period.period_key,
        started_at: row.started_at,
        expires_at: row.expires_at,
        auto_renew: row.auto_renew,
      }));
    },

    async listStalePending({ cutoff, limit }) {
      const { db } = await import("../db.ts");
      const rows = await db.subscriptionPeriodSettlement.findMany({
        where: { state: "pending", started_at: { lte: cutoff } },
        orderBy: { started_at: "asc" },
        take: limit,
        select: {
          id: true,
          period_key: true,
          attempts: true,
          plan_subscription: {
            select: { id: true, workspace_id: true, plan_id: true, auto_renew: true },
          },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        subscription_id: row.plan_subscription.id,
        workspace_id: row.plan_subscription.workspace_id,
        plan_id: row.plan_subscription.plan_id,
        period_key: row.period_key,
        attempts: row.attempts,
        auto_renew: row.plan_subscription.auto_renew,
      }));
    },

    async claimPeriod({ subscription_id, period_key }) {
      const { db } = await import("../db.ts");
      // 不带 try/catch：撞唯一键（P2002）必须冒到引擎，由 isSettlementDuplicate 判为幂等跳过。
      const row = await db.subscriptionPeriodSettlement.create({
        data: { plan_subscription_id: subscription_id, period_key, state: "pending" },
        select: { id: true },
      });
      return { id: row.id };
    },

    async executePeriod({ row, phase, now }) {
      // ── 生产执行器（V5-WP20-4 接线）──
      //
      // 两条路径，互斥：
      //   · `auto_renew = false`（默认）⇒ **只记账**：本周期收口、不产生任何订单、不动钱。
      //     契约 §3.5.3「只记账、只降级」；到期降级不需要这里做任何事（它是 `expires_at` 上的
      //     时间比较，§3.2.2）。
      //   · `auto_renew = true` ⇒ 走 {@link renewSubscriptionPeriod}：条件扣款 + 订单 +
      //     延长订阅 + `purchase` 发放，全部在**一个事务**里，并以账本行的 `order_id` 作为
      //     幂等锚点（见该函数注释）。
      if (!row.auto_renew) {
        impl.log?.({ event: "settlement_recorded_no_charge", subscription_id: row.subscription_id, period_key: row.period_key, phase });
        return { charged: false };
      }
      return renewSubscriptionPeriod({ row, now });
    },

    async markSettled({ id, order_id, now }) {
      const { db } = await import("../db.ts");
      // CAS：只有仍处于 `pending` 的行会被推进，`attempts+1` 记录执行尝试次数。
      const res = await db.subscriptionPeriodSettlement.updateMany({
        where: { id, state: "pending" },
        data: {
          state: "settled",
          settled_at: now,
          order_id,
          error: null,
          attempts: { increment: 1 },
        },
      });
      return { advanced: res.count === 1 };
    },

    async markFailed({ id, error }) {
      const { db } = await import("../db.ts");
      const res = await db.subscriptionPeriodSettlement.updateMany({
        where: { id, state: "pending" },
        data: { state: "failed", error, attempts: { increment: 1 } },
      });
      return { advanced: res.count === 1 };
    },

    async markDeferred({ id, reason }) {
      const { db } = await import("../db.ts");
      // 保持 `pending`，只记账本次尝试：`started_at` **不动** —— 它是「本次结算开始时间」，
      // 不是「上次尝试时间」；把它前移会让接管判定一次次重置，等于永远不接管。
      const res = await db.subscriptionPeriodSettlement.updateMany({
        where: { id, state: "pending" },
        data: { error: reason, attempts: { increment: 1 } },
      });
      return { advanced: res.count === 1 };
    },

    async readTakeoverTimeoutConfig() {
      const { db } = await import("../db.ts");
      const row = await db.systemConfig.findUnique({
        where: { name: "BILLING_SETTLEMENT_TAKEOVER_MINUTES" },
        select: { value: true },
      });
      return row?.value ?? null;
    },
  };
  return impl;
}

/* ------------------------------------------------------------------ */
/* 续期执行器（V5-WP20-4 接线）                                        */
/* ------------------------------------------------------------------ */

/**
 * `auto_renew = true` 的续期：**条件扣款 + 订单 + 延长订阅 + `purchase` 发放**，单事务。
 *
 * ── 幂等锚点是账本行自己 ──
 * 接管机制允许同一周期被执行**两次**（O4 的已知代价：崩在提交前/后被重跑）。钱不能动两次，
 * 所以顺序被写死为：
 *
 *   ① `SELECT ... FOR UPDATE` 锁住本行账本（并发下另一拍会在这里等）
 *   ② 若 `order_id` 已非空 ⇒ **上一次执行已经提交过钱**，直接返回那条订单（不再扣款）
 *   ③ 否则在一个事务里：条件扣款（F8）→ `BalanceLog` → `PlanOrder` → 延长订阅 + 发放
 *      （`applyPlanPurchase`）→ **同事务**把新订单 id 写进账本行的 `order_id`
 *   ④ 引擎随后把行推到 `settled`（`markSettled` 带 `state="pending"` 的 CAS）
 *
 * 崩在任何一步：整事务回滚（钱没动），下一拍重来。崩在提交之后、`markSettled` 之前：
 * `order_id` 已落库 ⇒ 下一拍走 ②，钱只动一次。**这就是「先占位后执行」再加上一层
 * 「以订单为幂等锚点」的完整形状**；只用占位唯一键而不锚定订单，接管那一次会重复扣款。
 *
 * ── 为什么要求 workspace 有钱包主体 ──
 * 余额在 `User` 上（F8 的条件扣款），团队 workspace 没有 `personal_user_id` ⇒ 没有钱包可扣。
 * 那种情况**不能**静默跳过（会让「自动续费」看起来生效）：返回 `deferred`，由接管重试，
 * 直到运维把这条订阅的 `auto_renew` 关掉或把扣款主体接上（团队钱包是独立 WP）。
 */
export async function renewSubscriptionPeriod(input: {
  row: SettlementTarget & { settlement_id: number };
  now: Date;
}): Promise<ExecuteOutcome> {
  const { db } = await import("../db.ts");
  const { applyPlanPurchase } = await import("./subscription-purchase.ts");

  try {
    return await db.$transaction(async (tx) => {
      // ① 锁账本行（同一周期的两个执行者在这里串行化）
      const locked = await tx.$queryRaw<
        Array<{ id: number; order_id: number | null; state: string }>
      >`SELECT id, order_id, state FROM subscription_period_settlement WHERE id = ${input.row.settlement_id} FOR UPDATE`;
      const settlement = locked[0];
      if (!settlement) return { charged: false, deferred: true, reason: "settlement_row_gone" };
      if (settlement.state !== "pending") {
        // 别处已经收口（settled/failed）⇒ 不再动钱。
        return { charged: false, order_id: settlement.order_id };
      }
      // ② 幂等锚点：上一次执行已经提交过订单 ⇒ 钱已经动过，直接复用它。
      if (settlement.order_id !== null) {
        return { charged: true, order_id: settlement.order_id };
      }

      const subscription = await tx.planSubscription.findUnique({
        where: { id: input.row.subscription_id },
        select: {
          id: true,
          workspace_id: true,
          plan_id: true,
          expires_at: true,
          auto_renew: true,
          workspace: { select: { id: true, personal_user_id: true } },
        },
      });
      if (!subscription) return { charged: false, deferred: true, reason: "subscription_gone" };
      // 用户在这一刻把自动续费关掉了 ⇒ 尊重它，按「只记账」收口（不扣款、不延长）。
      if (!subscription.auto_renew) {
        return { charged: false, order_id: null, deferred: false, reason: "auto_renew_off" };
      }
      // 终身订阅没有「下一个周期」可续（`expires_at = null`）⇒ 记账收口，不进续期。
      if (subscription.expires_at === null) {
        return { charged: false, order_id: null, deferred: false, reason: "lifetime_no_renewal" };
      }
      const payer_user_id = subscription.workspace.personal_user_id;
      if (payer_user_id === null) {
        // 团队 workspace 没有钱包主体：留在 pending 等接管，绝不假装续成功。
        return { charged: false, deferred: true, reason: "workspace_has_no_wallet" };
      }

      const plan = await tx.plan.findUnique({
        where: { id: subscription.plan_id },
        select: {
          id: true,
          name: true,
          price: true,
          billing_cycle: true,
          policy_id: true,
          status: true,
          renewable: true,
        },
      });
      // 商品下架 / 不允许续费 / 记录丢失：都不是「钱」的问题，而是「不该做」。
      if (!plan || plan.status !== "active" || !plan.renewable) {
        return { charged: false, deferred: true, reason: "plan_not_renewable" };
      }

      const price = plan.price;
      // ③ 条件扣款（F8）：余额不足是**用户可见的正常结果**，不是系统失败 ⇒ 留 pending 等
      // 用户充值后由下一拍接管重试（若记 failed，续期就永远不会再发生）。
      const debited = await tx.user.updateMany({
        where: { id: payer_user_id, balance: { gte: price } },
        data: { balance: { decrement: price } },
      });
      if (debited.count !== 1) {
        return { charged: false, deferred: true, reason: "insufficient_balance" };
      }
      const afterUser = await tx.user.findUniqueOrThrow({ where: { id: payer_user_id }, select: { balance: true } });
      await tx.balanceLog.create({
        data: { user_id: payer_user_id, balance: afterUser.balance, amount: -price, type: "plan" },
      });
      const order = await tx.planOrder.create({
        data: {
          user_id: payer_user_id,
          workspace_id: subscription.workspace_id,
          plan_id: plan.id,
          price,
          balance: afterUser.balance,
        },
        select: { id: true },
      });

      // ④ 延长订阅 + 发放（与购买路径**同一段实现**，含同套餐续期从 max(now, 原到期) 起算）
      //    注意**不传**两个 legacy 额度快照字段：同套餐续期的额度不变（不需要写），且
      //    DoD 第 1 条要求本文件不出现任何额度字段名（计费侧不碰额度）。
      await applyPlanPurchase(tx, {
        now: input.now,
        workspace_id: subscription.workspace_id,
        payer_user_id,
        plan: {
          id: plan.id,
          name: plan.name,
          billing_cycle: plan.billing_cycle,
          price: plan.price,
          policy_id: plan.policy_id,
        },
        order_id: order.id,
      });

      // ⑤ 同事务写回幂等锚点：这一步提交之后，任何重跑都会在 ② 处短路。
      await tx.subscriptionPeriodSettlement.update({
        where: { id: input.row.settlement_id },
        data: { order_id: order.id },
      });

      return { charged: true, order_id: order.id };
    });
  } catch (error) {
    // 抛给引擎的 runExecution 统一记账（它会写 failed + 记 attempts）。
    throw error;
  }
}
