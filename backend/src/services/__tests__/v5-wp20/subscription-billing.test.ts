/**
 * V5-WP20-3 周期结算 tick（`services/subscription-billing.ts`）单元测试 —— 离线，不碰 DB/Redis。
 *
 * 契约：`docs/v5-wp20-subscription-billing-runtime-contract.md` §3.1（先占位后执行 + 接管续跑）、
 * §3.2.4（只写账本、不做权限判定）、§3.5.3（只记账、绝不默认扣款续期）、§7.2.2（注入时钟）、
 * O4（接管超时来自 SystemConfig）；DoD 第 1/4/5/9 条。
 *
 * 测试里用的是一个**忠实的内存账本**：它复刻了两条真实约束——① `UNIQUE(plan_subscription_id,
 * period_key)`（重复占位抛 P2002 形状的错）②「只推进仍处于 pending 的行」的 CAS 更新——
 * 并且执行器**每次被调用都会真的动钱**（`orders` / `balance`）。这样 DoD 第 4 条
 * 「连跑两轮不重复扣款」才是一条有内容的断言，而不是「反正没人扣钱」的空断言。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp20/subscription-billing.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import {
  DEFAULT_SETTLEMENT_TAKEOVER_MINUTES,
  MAX_SETTLEMENT_TAKEOVER_MINUTES,
  SETTLEMENT_BATCH_LIMIT,
  isSettlementDuplicate,
  resolveTakeoverTimeoutMinutes,
  settlementPeriodFor,
  settleDuePeriods,
  type SettlementState,
  type SubscriptionSettlementDeps,
} from "../../subscription-billing.ts";

// ─────────────────────────── 内存账本（忠实的 fake） ───────────────────────────

interface LedgerRow {
  id: number;
  subscription_id: number;
  period_key: string;
  state: SettlementState;
  attempts: number;
  order_id: number | null;
  error: string | null;
  started_at: Date;
  settled_at: Date | null;
}

interface Subscription {
  id: number;
  workspace_id: number;
  plan_id: number;
  started_at: Date;
  expires_at: Date | null;
  auto_renew: boolean;
}

interface WorldOptions {
  config?: string | null;
  /** 执行期间被「别处」抢先收口（模拟并发落终态）。 */
  raceSettleDuringExecute?: boolean;
  /** 某条订阅的执行器抛错（模拟单条失败）。 */
  failSubscriptionIds?: readonly number[];
  /** 执行器被调用时记录顺序（用于证明「先接管后占位」）。 */
  trace?: string[];
}

function makeWorld(subscriptions: Subscription[], initialRows: LedgerRow[] = [], options: WorldOptions = {}) {
  const state = {
    rows: [...initialRows],
    orders: [] as Array<{ subscription_id: number; period_key: string }>,
    /** 假余额：执行器每次执行都扣 10；用来证明「不重复扣款」。 */
    balance: 1000,
    executions: 0,
    nextRowId: initialRows.reduce((max, row) => Math.max(max, row.id), 0) + 1,
    nextOrderId: 1,
  };

  const findRow = (id: number): LedgerRow | undefined => state.rows.find((row) => row.id === id);

  const deps: SubscriptionSettlementDeps = {
    async listDuePeriods({ period, now, limit }) {
      return subscriptions
        .filter((subscription) => {
          if (subscription.started_at > now) return false;
          if (subscription.expires_at !== null && subscription.expires_at <= period.period_start) return false;
          return !state.rows.some(
            (row) => row.subscription_id === subscription.id && row.period_key === period.period_key,
          );
        })
        .slice(0, limit)
        .map((subscription) => ({
          subscription_id: subscription.id,
          workspace_id: subscription.workspace_id,
          plan_id: subscription.plan_id,
          period_key: period.period_key,
          started_at: subscription.started_at,
          expires_at: subscription.expires_at,
          auto_renew: subscription.auto_renew,
        }));
    },

    async listStalePending({ cutoff, limit }) {
      return state.rows
        .filter((row) => row.state === "pending" && row.started_at <= cutoff)
        .slice(0, limit)
        .map((row) => {
          const subscription = subscriptions.find((s) => s.id === row.subscription_id)!;
          return {
            id: row.id,
            subscription_id: row.subscription_id,
            workspace_id: subscription.workspace_id,
            plan_id: subscription.plan_id,
            period_key: row.period_key,
            attempts: row.attempts,
            auto_renew: subscription.auto_renew,
          };
        });
    },

    async claimPeriod({ subscription_id, period_key, now }) {
      // 唯一键的忠实复刻：撞键必须抛出 P2002 形状的错，而不是返回「已存在」。
      if (state.rows.some((row) => row.subscription_id === subscription_id && row.period_key === period_key)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row: LedgerRow = {
        id: state.nextRowId++,
        subscription_id,
        period_key,
        state: "pending",
        attempts: 0,
        order_id: null,
        error: null,
        started_at: now,
        settled_at: null,
      };
      state.rows.push(row);
      return { id: row.id };
    },

    async executePeriod({ row, phase }) {
      options.trace?.push(`${phase}:${row.subscription_id}:${row.period_key}`);
      state.executions += 1;
      if (options.failSubscriptionIds?.includes(row.subscription_id)) {
        throw new Error("executor_boom");
      }
      if (options.raceSettleDuringExecute) {
        const target = findRow(row.settlement_id);
        if (target) {
          target.state = "settled";
          target.settled_at = new Date();
        }
      }
      if (row.auto_renew) {
        // WP20-3 的生产执行器行为：续期执行器未接线 ⇒ 留着等接管，绝不扣款。
        return { charged: false, deferred: true, reason: "renewal_executor_not_wired" };
      }
      // 假扣款：真的动钱，用来证明引擎不会让同一周期执行两次。
      state.balance -= 10;
      const order = { subscription_id: row.subscription_id, period_key: row.period_key };
      state.orders.push(order);
      return { charged: true, order_id: state.nextOrderId++ };
    },

    async markSettled({ id, order_id, now }) {
      const row = findRow(id);
      if (!row || row.state !== "pending") return { advanced: false }; // CAS
      row.state = "settled";
      row.settled_at = now;
      row.order_id = order_id;
      row.error = null;
      row.attempts += 1;
      return { advanced: true };
    },

    async markFailed({ id, error }) {
      const row = findRow(id);
      if (!row || row.state !== "pending") return { advanced: false }; // CAS
      row.state = "failed";
      row.error = error;
      row.attempts += 1;
      return { advanced: true };
    },

    async markDeferred({ id, reason }) {
      const row = findRow(id);
      if (!row || row.state !== "pending") return { advanced: false }; // CAS
      row.error = reason;
      row.attempts += 1;
      return { advanced: true };
    },

    async readTakeoverTimeoutConfig() {
      return options.config ?? null;
    },
  };

  return { deps, state };
}

const SUB = (over: Partial<Subscription> = {}): Subscription => ({
  id: 1,
  workspace_id: 7,
  plan_id: 3,
  started_at: new Date("2026-01-01T00:00:00.000Z"),
  expires_at: null,
  auto_renew: false,
  ...over,
});

const NOW = new Date("2026-10-05T05:30:00.000Z"); // 上海 2026-10-05 13:30

const pendingRow = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: 1,
  subscription_id: 1,
  period_key: "2026-09",
  state: "pending",
  attempts: 0,
  order_id: null,
  error: null,
  started_at: new Date("2026-10-05T05:00:00.000Z"),
  settled_at: null,
  ...over,
});

// ─────────────────────────── A. 纯函数 ───────────────────────────

describe("A. 纯判别：接管超时 / 唯一键冲突 / 周期推导", () => {
  test("resolveTakeoverTimeoutMinutes：合法值直用，缺省/非法回落 10，越界回落", () => {
    expect(resolveTakeoverTimeoutMinutes("10")).toEqual({ minutes: 10, missing: false, invalid: false });
    expect(resolveTakeoverTimeoutMinutes("1")).toEqual({ minutes: 1, missing: false, invalid: false });
    expect(resolveTakeoverTimeoutMinutes("1440")).toEqual({ minutes: 1440, missing: false, invalid: false });
    // 小数向下取整（"1.9" → 1）；取整后 < 1 才算非法
    expect(resolveTakeoverTimeoutMinutes("1.9")).toEqual({ minutes: 1, missing: false, invalid: false });
    expect(resolveTakeoverTimeoutMinutes("0.9")).toEqual({
      minutes: DEFAULT_SETTLEMENT_TAKEOVER_MINUTES,
      missing: false,
      invalid: true,
    });
    for (const raw of [undefined, null, "", "   "]) {
      expect(resolveTakeoverTimeoutMinutes(raw)).toEqual({
        minutes: DEFAULT_SETTLEMENT_TAKEOVER_MINUTES,
        missing: true,
        invalid: false,
      });
    }
    for (const raw of ["abc", "0", "-5", "1441", "NaN"]) {
      expect({ raw, decision: resolveTakeoverTimeoutMinutes(raw) }).toEqual({
        raw,
        decision: { minutes: DEFAULT_SETTLEMENT_TAKEOVER_MINUTES, missing: false, invalid: true },
      });
    }
    expect(DEFAULT_SETTLEMENT_TAKEOVER_MINUTES).toBe(10); // 与充值订单超时同口径
    expect(MAX_SETTLEMENT_TAKEOVER_MINUTES).toBe(1440); // 24 小时上限（见常量注释的反例）
  });

  test("isSettlementDuplicate 只认唯一键冲突：其它错误必须冒出去", () => {
    expect(isSettlementDuplicate(Object.assign(new Error("dup"), { code: "P2002" }))).toBe(true);
    expect(isSettlementDuplicate(Object.assign(new Error("dup"), { errno: 1062 }))).toBe(true);
    expect(isSettlementDuplicate(Object.assign(new Error("fk"), { code: "P2003" }))).toBe(false);
    expect(isSettlementDuplicate(new Error("db down"))).toBe(false);
    expect(isSettlementDuplicate(null)).toBe(false);
    expect(isSettlementDuplicate(undefined)).toBe(false);
  });

  test("settlementPeriodFor 用上海口径（跨月那一秒）", () => {
    const before = settlementPeriodFor(new Date("2026-01-31T15:59:59.999Z"));
    const after = settlementPeriodFor(new Date("2026-01-31T16:00:00.000Z"));
    expect(before.period_key).toBe("2026-01");
    expect(after.period_key).toBe("2026-02");
    expect(after.period_start.toISOString()).toBe("2026-01-31T16:00:00.000Z");
    // 日粒度：键与日首同源
    const day = settlementPeriodFor(new Date("2026-03-31T17:30:00.000Z"), "day");
    expect(day.period_key).toBe("2026-04-01");
    expect(day.period_start.toISOString()).toBe("2026-03-31T16:00:00.000Z");
  });
});

// ─────────────────────────── B. DoD 4：连跑两轮只结算一次 ───────────────────────────

describe("B. DoD 第 4 条：同一 (订阅, 周期) 连跑两轮，第二轮零动作、账本零变化", () => {
  test("第一轮结算一次，第二轮 due/settled/skipped 全为 0，订单与余额不变", async () => {
    const { deps, state } = makeWorld([SUB()]);

    const first = await settleDuePeriods(deps, NOW);
    expect(first).toMatchObject({ period_key: "2026-10", due: 1, settled: 1, skipped: 0, deferred: 0, failed: 0 });
    expect(state.executions).toBe(1);
    expect(state.orders).toEqual([{ subscription_id: 1, period_key: "2026-10" }]);
    expect(state.balance).toBe(990);
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ subscription_id: 1, period_key: "2026-10", state: "settled", attempts: 1 });
    expect(state.rows[0]!.order_id).toBe(1);
    expect(state.rows[0]!.settled_at?.toISOString()).toBe(NOW.toISOString());

    const ordersAfterFirst = [...state.orders];
    const balanceAfterFirst = state.balance;

    const second = await settleDuePeriods(deps, NOW);
    expect(second).toMatchObject({ due: 0, settled: 0, skipped: 0, deferred: 0, failed: 0, taken_over: 0 });
    expect(state.executions).toBe(1); // 执行器没有被再调一次
    expect(state.orders).toEqual(ordersAfterFirst);
    expect(state.balance).toBe(balanceAfterFirst);
    expect(state.rows).toHaveLength(1); // 没有第二行
  });

  test("跨月推进：同一订阅下个月产生新行，旧行不动", async () => {
    const { deps, state } = makeWorld([SUB()]);
    await settleDuePeriods(deps, new Date("2026-10-05T05:30:00.000Z"));
    const later = await settleDuePeriods(deps, new Date("2026-11-05T05:30:00.000Z"));
    expect(later).toMatchObject({ period_key: "2026-11", due: 1, settled: 1 });
    expect(state.rows.map((row) => row.period_key)).toEqual(["2026-10", "2026-11"]);
    expect(state.rows.every((row) => row.state === "settled")).toBe(true);
    expect(state.orders).toHaveLength(2); // 两个月各一次，互不重复
  });

  test("并发占位：唯一的闸门是 DB 唯一键 —— 撞 P2002 计 skipped 且不执行", async () => {
    // 模拟「两个 worker 同一拍」：另一个 worker 已经建了占位行，但本轮的到期查询没看到它。
    const raced = pendingRow({ id: 99, period_key: "2026-10", started_at: NOW });
    const { deps, state } = makeWorld([SUB()], [raced]);
    const due = await deps.listDuePeriods({
      period: { period_key: "2026-10", period_start: new Date("2026-09-30T16:00:00.000Z") },
      now: NOW,
      limit: 10,
    });
    // fake 的到期查询会看到这一行（真实 SQL 也会），所以先把它挪走再复现竞态：
    expect(due).toHaveLength(0);
    state.rows = [];
    let claimed = false;
    const racing: SubscriptionSettlementDeps = {
      ...deps,
      async claimPeriod(input) {
        if (!claimed) {
          claimed = true;
          state.rows.push(pendingRow({ id: 100, period_key: input.period_key, started_at: input.now }));
        }
        return deps.claimPeriod(input);
      },
    };

    const result = await settleDuePeriods(racing, NOW);
    expect(result).toMatchObject({ due: 1, settled: 0, skipped: 1, failed: 0 });
    expect(state.executions).toBe(0); // 被别处占了 ⇒ 一行都不执行
    expect(state.balance).toBe(1000);
  });

  test("并发落终态：execute 期间被别处收口 ⇒ 计 skipped 而不是重复计 settled", async () => {
    const { deps, state } = makeWorld([SUB()], [], { raceSettleDuringExecute: true });
    const result = await settleDuePeriods(deps, NOW);
    expect(result).toMatchObject({ due: 1, settled: 0, skipped: 1, failed: 0 });
    expect(state.rows[0]!.state).toBe("settled"); // 收口只发生一次（别处那次）
    expect(state.rows[0]!.attempts).toBe(0); // 本拍没有推进成功，所以不算一次尝试
  });
});

// ─────────────────────────── C. DoD 5：崩溃接管恰好一次 ───────────────────────────

describe("C. DoD 第 5 条：崩在「占位之后、执行之前」的 pending 由下一轮恰好一次推到 settled", () => {
  test("超过接管超时 ⇒ 接管并落 settled；再下一轮什么也不做（恰好一次）", async () => {
    // 上个月的行崩在中间：started_at 比 now 早 11 分钟 > 默认 10 分钟超时。
    const stale = pendingRow({ started_at: new Date(NOW.getTime() - 11 * 60_000) });
    const { deps, state } = makeWorld([SUB()], [stale]);

    const first = await settleDuePeriods(deps, NOW);
    // settled=2：接管的旧周期 + 本轮新占位的周期；taken_over=1 只数接管相位。
    expect(first).toMatchObject({ taken_over: 1, settled: 2, deferred: 0, failed: 0, due: 1 });
    expect(state.rows[0]).toMatchObject({ state: "settled", attempts: 1 });
    expect(state.rows[0]!.settled_at?.toISOString()).toBe(NOW.toISOString());
    // 接管补执行了旧周期一次；同一拍还为新周期执行了一次 —— 每个周期各一次，不重不漏。
    expect(state.orders).toEqual([
      { subscription_id: 1, period_key: "2026-09" },
      { subscription_id: 1, period_key: "2026-10" },
    ]);
    // 本轮还为新周期（2026-10）建了占位：两行都在，且都 settled
    expect(state.rows.map((row) => row.period_key)).toEqual(["2026-09", "2026-10"]);

    const ordersAfter = state.orders.length;
    const executionsAfter = state.executions;
    const second = await settleDuePeriods(deps, NOW);
    expect(second).toMatchObject({ taken_over: 0, settled: 0, deferred: 0, failed: 0, due: 0 });
    expect(state.orders).toHaveLength(ordersAfter); // 恰好一次：旧周期不会被再执行
    expect(state.executions).toBe(executionsAfter);
  });

  test("未到接管超时的 pending 不动（超时是判定的全部）", async () => {
    const fresh = pendingRow({ started_at: new Date(NOW.getTime() - 9 * 60_000) });
    const { deps, state } = makeWorld([SUB()], [fresh]);
    const result = await settleDuePeriods(deps, NOW);
    expect(result).toMatchObject({ taken_over: 0, settled: 1 });
    // 只有新周期那行被结算；旧行仍是 pending
    expect(state.rows[0]).toMatchObject({ period_key: "2026-09", state: "pending", attempts: 0 });
    expect(state.rows[1]).toMatchObject({ period_key: "2026-10", state: "settled" });
  });

  test("接管超时来自 SystemConfig：配成 60 分钟后同样的行不再被接管", async () => {
    const stale = pendingRow({ started_at: new Date(NOW.getTime() - 11 * 60_000) });
    const { deps, state } = makeWorld([SUB()], [stale], { config: "60" });
    const result = await settleDuePeriods(deps, NOW);
    expect(result).toMatchObject({ taken_over: 0, takeover_minutes: 60, takeover_config_missing: false });
    expect(state.rows[0]).toMatchObject({ period_key: "2026-09", state: "pending" });
  });

  test("配置缺失/非法可观测（不静默）", async () => {
    const { deps } = makeWorld([SUB()]);
    const missing = await settleDuePeriods(deps, NOW);
    expect(missing).toMatchObject({ takeover_config_missing: true, takeover_config_invalid: false, takeover_minutes: 10 });

    const dirty = makeWorld([SUB()], [], { config: "abc" });
    const invalid = await settleDuePeriods(dirty.deps, NOW);
    expect(invalid).toMatchObject({ takeover_config_missing: false, takeover_config_invalid: true, takeover_minutes: 10 });
  });

  test("先接管、后占位（顺序即契约：先把未完成的旧相位收口）", async () => {
    const stale = pendingRow({ started_at: new Date(NOW.getTime() - 11 * 60_000) });
    const trace: string[] = [];
    const { deps } = makeWorld([SUB()], [stale], { trace });
    await settleDuePeriods(deps, NOW);
    expect(trace[0]).toBe("takeover:1:2026-09");
    expect(trace[1]).toBe("claim:1:2026-10");
  });
});

// ─────────────────────────── D. 绝不默认扣款续期（DoD 9 / §3.5.3） ───────────────────────────

describe("D. auto_renew=true 的订阅：留在 pending 等接管，绝不扣款、绝不算结算完成", () => {
  test("第一轮 deferred：账本仍 pending、attempts=1、无订单、余额不动", async () => {
    const { deps, state } = makeWorld([SUB({ auto_renew: true })]);
    const result = await settleDuePeriods(deps, NOW);
    expect(result).toMatchObject({ due: 1, settled: 0, deferred: 1, failed: 0 });
    expect(state.rows[0]).toMatchObject({
      state: "pending",
      attempts: 1,
      error: "renewal_executor_not_wired",
      settled_at: null,
      order_id: null,
    });
    expect(state.orders).toHaveLength(0);
    expect(state.balance).toBe(1000);
  });

  test("超时后被接管仍是 deferred（attempts 增长、仍不扣款），不会假装完成", async () => {
    const { deps, state } = makeWorld([SUB({ auto_renew: true })]);
    await settleDuePeriods(deps, NOW);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const result = await settleDuePeriods(deps, later);
    expect(result).toMatchObject({ taken_over: 1, deferred: 1, settled: 0, due: 0 });
    expect(state.rows[0]).toMatchObject({ state: "pending", attempts: 2 });
    expect(state.orders).toHaveLength(0);
    expect(state.balance).toBe(1000);
  });

  test("auto_renew=false 是默认路径：只记账（charged=false 也照常落 settled）", async () => {
    const { deps, state } = makeWorld([SUB({ auto_renew: false })]);
    await settleDuePeriods(deps, NOW);
    expect(state.rows[0]).toMatchObject({ state: "settled", error: null });
  });
});

// ─────────────────────────── E. 有界性与失败隔离 ───────────────────────────

describe("E. 有界性与失败隔离（worker 是共享进程里的一拍）", () => {
  test("到期数超过单轮上限 ⇒ truncated 且只处理 LIMIT 条", async () => {
    const subs = Array.from({ length: SETTLEMENT_BATCH_LIMIT + 1 }, (_v, index) => SUB({ id: index + 1 }));
    const { deps, state } = makeWorld(subs);
    const result = await settleDuePeriods(deps, NOW);
    expect(result.truncated).toBe(true);
    expect(state.rows).toHaveLength(SETTLEMENT_BATCH_LIMIT);
    expect(result.settled).toBe(SETTLEMENT_BATCH_LIMIT);
  });

  test("单条执行失败不拖垮整轮：其余照常结算，失败留 error 且不重复计数", async () => {
    const subs = [SUB({ id: 1 }), SUB({ id: 2 }), SUB({ id: 3 })];
    const { deps, state } = makeWorld(subs, [], { failSubscriptionIds: [2] });
    const result = await settleDuePeriods(deps, NOW);
    expect(result).toMatchObject({ due: 3, settled: 2, failed: 1 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.subscription_id).toBe(2);
    expect(result.errors[0]!.error).toContain("executor_boom");
    expect(state.rows.find((row) => row.subscription_id === 2)).toMatchObject({
      state: "failed",
      attempts: 1,
    });
    expect(state.rows.filter((row) => row.state === "settled")).toHaveLength(2);
  });

  test("占位失败（非唯一键错）计 failed 并写 errors —— 不许把 DB 故障伪装成「已结算过」", async () => {
    const { deps } = makeWorld([SUB()]);
    const broken: SubscriptionSettlementDeps = {
      ...deps,
      async claimPeriod() {
        throw new Error("db_down");
      },
    };
    const result = await settleDuePeriods(broken, NOW);
    expect(result).toMatchObject({ due: 1, settled: 0, skipped: 0, failed: 1 });
    expect(result.errors[0]!.error).toContain("claim_failed: db_down");
  });
});

// Worker wiring and repository-wide architecture are covered by integration/CI smoke tests.
