/**
 * V5-WP20-3 —— 订阅**周期结算 tick**（幂等占位 + 崩溃接管续跑）。
 *
 * 契约：`docs/v5-wp20-subscription-billing-runtime-contract.md` §3.1（计费时钟与「每周期只结算一次」
 * 的幂等）、§3.2.4（唯一新增执行者是 worker 的 `cron_settle_billing`，**不做任何权限判定**）、
 * §3.5.3（自动续费 fail-closed，只记账、只降级）、§7.2.2（编排层必须注入时钟，禁止 patch 全局 `Date.now`）、
 * O4（接管超时登记在 `SystemConfig`，默认 10 分钟）；DoD 第 1/4/5/9 条。
 *
 * ── 这一层是什么、不是什么 ──
 * 是：**「每个计费周期只结算一次」这条账本事实的编排**——占位、执行、落终态、崩溃接管。
 * 不是：不做额度判定、不读 `CapabilityPolicy`、不新增 `WorkspacePolicyAssignment` 写入点
 * （DoD 1/2：计费侧不得出现 `checkTunnelCreation`/`max_tunnels`；`purchase` 发放的唯一写入点是
 * WP20-4 的 `grantPolicyFromPurchase`）。因此「扣款 / 发放」这一步是**注入的执行器**
 * （{@link SubscriptionSettlementDeps.executePeriod}）：WP20-4 把它的生产实现换成
 * 「条件扣款（F8）+ `upsert` 发放 + `PlanOrder`/`BalanceLog`」即可，本模块一行都不用改。
 *
 * ── 幂等为什么是「先占位后执行」而不是「再查一遍」──
 * 固定顺序（§3.1.4，顺序本身即契约）：
 *
 *   ① `create` 占位（DB 唯一键 `(plan_subscription_id, period_key)` 是**唯一**闸门；
 *      并发下输的一侧撞 `P2002` ⇒ 本轮跳过，而不是「先查后写」——先查后写有 TOCTOU 窗口）
 *   ② 执行（扣款/发放，注入）
 *   ③ 置 `settled`
 *
 * 崩在 ① 与 ② 之间留下的 `pending` 行由**下一轮接管续跑**（同 `forward-rollout-recovery.ts`
 * 的「捞起未完成相位续跑」模式，见 worker 的 `cron_reconcile_v3` 先跑 `resumeRollouts`）：
 * 接管判定 = `state="pending"` 且 `started_at <= now - 接管超时`。
 *
 * 为什么接管会**重复执行**同一周期（O4 的已知代价）：超时是运维量、不是事实，只要它小于真实执行
 * 耗时，同一个周期就会被执行两次。所以**执行器必须幂等可重放**（F8 的条件扣款 + 发放的 `upsert`），
 * 而本模块用「唯一键占位 + 落终态前的 CAS」把重复压缩到「最多重复一次执行」，不会重复落终态。
 *
 * ── 失败语义 ──
 * 单条失败不拖垮整轮（worker 是共享进程里的一拍）：逐条 try/catch，错误进 `errors`，下一轮自然重试
 * （与 `resumeRollouts` 同取向）。DB 整体不可用则整轮抛出，由 worker 的 `failed` 事件记录 +
 * BullMQ 重试——**不吞错**（静默失败会让「结算已生效」的假设长期不成立）。
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

/** 账本行的状态（WP20-2 冻结为 `VARCHAR(16)` 的三个值，不新增枚举）。 */
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

/** 本轮结算的周期（默认月结；`day` 只为实现完备性保留，见契约 §3.1.4 的 `period_key` 值域）。 */
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
      // ── WP20-3 的生产执行器：**只记账** ──
      //
      // 契约 §3.5.3 冻结「结算任务只记账、只降级，绝不默认扣款续期」，且 DoD 第 2 条要求
      // `workspacePolicyAssignment` 的写入点**恰好两个**（`assignDefaultPolicy` +
      // WP20-4 的 `grantPolicyFromPurchase`）。所以本 WP 的执行器**不扣款、不写订单、不发放**：
      // 它把「这一周期已被收口、本周期没有产生任何订单」写成一条账本事实（`settled`）。
      // 到期降级本身不需要这里做任何事——它是 `expires_at` 上的时间比较（契约 §3.2.2）。
      //
      // `auto_renew=true` 的续期（扣款 + 发放）属于 WP20-4：在那之前的正确行为是**留在 pending**
      // 等接管，而不是假装完成。今天没有任何路径会把 `auto_renew` 写成 true（默认 false），
      // 这条分支是给 WP20-4 的接缝，也是「绝不默认扣款续期」的代码形状。
      if (row.auto_renew) {
        return { charged: false, deferred: true, reason: "renewal_executor_not_wired" };
      }
      impl.log?.({ event: "settlement_recorded_no_charge", subscription_id: row.subscription_id, period_key: row.period_key, phase });
      return { charged: false };
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
