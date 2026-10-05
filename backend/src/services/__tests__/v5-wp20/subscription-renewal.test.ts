/**
 * V5-WP20-4 续期执行器（`renewSubscriptionPeriod`）单元测试 —— 离线，`db.ts` 用模块级替身。
 *
 * 契约：§3.1.4（先占位后执行 + 接管续跑）、§3.5.3（自动续费 **默认关闭**，只有显式开启才扣款）、
 * §3.2.4（唯一执行者只写四类台账）、O4（接管允许重复执行 ⇒ 必须幂等可重放）。
 *
 * 为什么这是一个"钱路径"测试：接管机制**允许**同一周期被执行两次，所以幂等锚点必须是账本行上的
 * `order_id`（提交后重跑要能短路），而不是"应该不会重跑"的假设。本文件逐条断言：
 *   ① 已提交过订单 ⇒ 短路，不再扣款；
 *   ② 首次执行 ⇒ 扣款 + 流水 + 订单 + 延长订阅 + 发放 + 写回锚点，全在**一次** `$transaction` 里；
 *   ③ 余额不足 / 团队 workspace 无钱包 / 商品不可续费 ⇒ `deferred`（留 pending 等接管）且**一分钱没动**；
 *   ④ 终身订阅 / 用户在结算时关掉自动续费 ⇒ 按"只记账"收口，不扣款、不假装续期。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp20/subscription-renewal.test.ts
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ─────────────────────────── db 替身（必须在 import 被测模块之前注册） ───────────────────────────

interface Substub {
  settlement: { id: number; order_id: number | null; state: string };
  subscription: {
    id: number;
    workspace_id: number;
    plan_id: number;
    started_at: Date;
    expires_at: Date | null;
    auto_renew: boolean;
    personal_user_id: number | null;
  } | null;
  plan: {
    id: number;
    name: string;
    price: number;
    billing_cycle: string;
    policy_id: number | null;
    status: string;
    renewable: boolean;
  } | null;
  balance: number;
  /** `user.updateMany` 的条件扣款是否命中（false = 余额不足）。 */
  debit_hits: boolean;
  legacy_user_plan_exists: boolean;
  orders: Array<Record<string, unknown>>;
  balance_logs: Array<Record<string, unknown>>;
  settlement_writes: Array<Record<string, unknown>>;
  subscription_upserts: Array<Record<string, unknown>>;
  assignment_upserts: Array<Record<string, unknown>>;
  transactions: number;
}

const state: Substub = {
  settlement: { id: 1, order_id: null, state: "pending" },
  subscription: null,
  plan: null,
  balance: 100,
  debit_hits: true,
  legacy_user_plan_exists: true,
  orders: [],
  balance_logs: [],
  settlement_writes: [],
  subscription_upserts: [],
  assignment_upserts: [],
  transactions: 0,
};

function resetState() {
  state.settlement = { id: 1, order_id: null, state: "pending" };
  state.subscription = {
    id: 501,
    workspace_id: 7,
    plan_id: 3,
    started_at: new Date("2026-09-01T00:00:00.000Z"),
    expires_at: new Date("2026-10-05T00:00:00.000Z"),
    auto_renew: true,
    personal_user_id: 11,
  };
  state.plan = {
    id: 3,
    name: "Pro",
    price: 20,
    billing_cycle: "month",
    policy_id: 8,
    status: "active",
    renewable: true,
  };
  state.balance = 100;
  state.debit_hits = true;
  state.legacy_user_plan_exists = true;
  state.orders = [];
  state.balance_logs = [];
  state.settlement_writes = [];
  state.subscription_upserts = [];
  state.assignment_upserts = [];
  state.transactions = 0;
}

function makeTx() {
  return {
    async $queryRaw(_strings: TemplateStringsArray, ..._values: unknown[]) {
      // id = -1 是「行已被删」的哨兵（避免在用例里二次 mock 模块）
      if (state.settlement.id === -1) return [];
      return [{ id: state.settlement.id, order_id: state.settlement.order_id, state: state.settlement.state }];
    },
    planSubscription: {
      async findUnique(args: { where: { id?: number; workspace_id?: number } }) {
        if (!state.subscription) return null;
        if (args.where.id !== undefined || args.where.workspace_id !== undefined) {
          // 生产代码用 `include/select` 取 `workspace.personal_user_id`（扣款主体），替身必须同形。
          return {
            ...state.subscription,
            workspace: {
              id: state.subscription.workspace_id,
              personal_user_id: state.subscription.personal_user_id,
            },
          };
        }
        return null;
      },
      async upsert(args: Record<string, unknown>) {
        state.subscription_upserts.push(args);
        return { id: state.subscription?.id ?? 501 };
      },
    },
    plan: {
      async findUnique() {
        return state.plan;
      },
    },
    workspace: {
      async findUnique() {
        return state.subscription
          ? { id: state.subscription.workspace_id, personal_user_id: state.subscription.personal_user_id }
          : null;
      },
    },
    user: {
      async updateMany(args: Record<string, unknown>) {
        if (!state.debit_hits) return { count: 0 };
        const amount = (args.data as { balance?: { decrement?: number } }).balance?.decrement ?? 0;
        state.balance -= amount;
        return { count: 1 };
      },
      async findUniqueOrThrow() {
        return { balance: state.balance };
      },
    },
    balanceLog: {
      async create(args: Record<string, unknown>) {
        state.balance_logs.push(args.data as Record<string, unknown>);
        return { id: 1 };
      },
    },
    planOrder: {
      async create(args: Record<string, unknown>) {
        state.orders.push(args.data as Record<string, unknown>);
        return { id: 900 + state.orders.length };
      },
    },
    userPlan: {
      async findUnique() {
        return state.legacy_user_plan_exists ? { id: 9 } : null;
      },
      async update(args: Record<string, unknown>) {
        return { id: 9, ...(args.data as object) };
      },
      async create(args: Record<string, unknown>) {
        return { id: 10, ...(args.data as object) };
      },
    },
    subscriptionPeriodSettlement: {
      async update(args: Record<string, unknown>) {
        state.settlement_writes.push(args.data as Record<string, unknown>);
        const order_id = (args.data as { order_id?: number }).order_id ?? null;
        state.settlement.order_id = order_id;
        return { id: state.settlement.id };
      },
    },
    workspacePolicyAssignment: {
      async findUnique() {
        return null;
      },
      async updateMany() {
        return { count: 0 };
      },
      async upsert(args: Record<string, unknown>) {
        state.assignment_upserts.push(args);
        return { id: 77 };
      },
    },
  };
}

const fakeDb = {
  async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    state.transactions += 1;
    return fn(makeTx());
  },
};

// 注意路径层级：本文件在 `src/services/__tests__/v5-wp20/`，`db.ts` 在 `src/` ⇒ 需要三层 ../。
// （写成两层会注册到不存在的 `src/services/db.ts`，替身静默不生效、用例会去连真库。）
mock.module(new URL("../../../db.ts", import.meta.url).pathname, () => ({ db: fakeDb }));

const { renewSubscriptionPeriod } = await import("../../subscription-billing.ts");

const ROW = {
  subscription_id: 501,
  workspace_id: 7,
  plan_id: 3,
  period_key: "2026-10",
  auto_renew: true,
  started_at: null,
  expires_at: null,
  settlement_id: 1,
};

const NOW = new Date("2026-10-05T05:30:00.000Z");

beforeEach(resetState);

// ─────────────────────────── A. 幂等锚点 ───────────────────────────

describe("A. 幂等锚点：order_id 已存在 ⇒ 短路，不再扣款", () => {
  test("接管重跑时只复用那张订单（钱只动一次）", async () => {
    state.settlement.order_id = 777;
    const outcome = await renewSubscriptionPeriod({ row: ROW, now: NOW });

    expect(outcome).toEqual({ charged: true, order_id: 777 });
    expect(state.balance).toBe(100); // 没有扣款
    expect(state.orders).toHaveLength(0); // 没有新订单
    expect(state.balance_logs).toHaveLength(0);
    expect(state.settlement_writes).toHaveLength(0); // 也没有改写锚点
  });

  test("行已被别处收口（state != pending）⇒ 不动钱", async () => {
    state.settlement.state = "settled";
    const outcome = await renewSubscriptionPeriod({ row: ROW, now: NOW });
    expect(outcome).toEqual({ charged: false, order_id: null });
    expect(state.orders).toHaveLength(0);
    expect(state.balance).toBe(100);
  });
});

// ─────────────────────────── B. 首次执行的完整形状 ───────────────────────────

describe("B. 首次执行：一次事务里完成扣款 → 流水 → 订单 → 延长 → 发放 → 锚点", () => {
  test("全部落库，且订单 id 写回账本行", async () => {
    const outcome = await renewSubscriptionPeriod({ row: ROW, now: NOW });

    expect(state.transactions).toBe(1); // 只开一次事务
    expect(outcome).toEqual({ charged: true, order_id: 901 });
    expect(state.balance).toBe(80); // 扣了 plan.price = 20
    expect(state.balance_logs).toEqual([{ user_id: 11, balance: 80, amount: -20, type: "plan" }]);
    expect(state.orders).toEqual([{ user_id: 11, workspace_id: 7, plan_id: 3, price: 20, balance: 80 }]);
    // 订阅延长：同套餐续期从 max(now, 原到期) 起算（原到期 10-05T00:00Z < now ⇒ 从 now 起算）
    const upsert = state.subscription_upserts[0]!;
    expect((upsert.update as Record<string, unknown>).expires_at).toEqual(new Date("2026-11-04T05:30:00.000Z"));
    expect((upsert.update as Record<string, unknown>).started_at).toEqual(state.subscription!.started_at);
    expect("auto_renew" in (upsert.update as object)).toBe(false); // 续期不改用户的选择
    // 发放：purchase 来源、到期点与订阅同源
    const grant = state.assignment_upserts[0]!;
    expect(grant.create).toMatchObject({ workspace_id: 7, policy_id: 8, source: "purchase" });
    expect((grant.create as Record<string, unknown>).expires_at).toEqual(new Date("2026-11-04T05:30:00.000Z"));
    // 幂等锚点
    expect(state.settlement_writes).toEqual([{ order_id: 901 }]);
    expect(state.settlement.order_id).toBe(901);
  });

  test("计划没有绑定策略：照常扣款续期，但不发放（result 不报错）", async () => {
    state.plan!.policy_id = null;
    const outcome = await renewSubscriptionPeriod({ row: ROW, now: NOW });
    expect(outcome.charged).toBe(true);
    expect(state.balance).toBe(80); // 钱照扣（用户确实续了一个月）
    expect(state.assignment_upserts).toHaveLength(0); // 但不发放
  });
});

// ─────────────────────────── C. deferred：留 pending，一分钱不动 ───────────────────────────

describe("C. 不该做/做不了 ⇒ deferred（留 pending 等接管），绝不假装成功", () => {
  test("余额不足：deferred，不扣款、不建订单、不延长", async () => {
    state.debit_hits = false;
    const outcome = await renewSubscriptionPeriod({ row: ROW, now: NOW });
    expect(outcome).toEqual({ charged: false, deferred: true, reason: "insufficient_balance" });
    expect(state.balance).toBe(100);
    expect(state.orders).toHaveLength(0);
    expect(state.subscription_upserts).toHaveLength(0);
    expect(state.settlement_writes).toHaveLength(0);
  });

  test("团队 workspace（没有钱包主体）：deferred，不扣款", async () => {
    state.subscription!.personal_user_id = null;
    const outcome = await renewSubscriptionPeriod({ row: ROW, now: NOW });
    expect(outcome).toEqual({ charged: false, deferred: true, reason: "workspace_has_no_wallet" });
    expect(state.orders).toHaveLength(0);
  });

  test("商品下架 / 不可续费：deferred，不扣款", async () => {
    state.plan!.status = "inactive";
    expect(await renewSubscriptionPeriod({ row: ROW, now: NOW })).toEqual({
      charged: false,
      deferred: true,
      reason: "plan_not_renewable",
    });
    state.plan!.status = "active";
    state.plan!.renewable = false;
    expect(await renewSubscriptionPeriod({ row: ROW, now: NOW })).toEqual({
      charged: false,
      deferred: true,
      reason: "plan_not_renewable",
    });
    expect(state.balance).toBe(100);
  });

  test("账本行被删（settlement_row_gone）：deferred，不崩", async () => {
    state.settlement.id = -1; // 哨兵：FOR UPDATE 查不到行
    const outcome = await renewSubscriptionPeriod({ row: ROW, now: NOW });
    expect(outcome).toEqual({ charged: false, deferred: true, reason: "settlement_row_gone" });
    expect(state.orders).toHaveLength(0);
  });
});

// ─────────────────────────── D. 只记账收口（不扣款） ───────────────────────────

describe("D. 没有可续的周期 / 用户已关闭自动续费 ⇒ 只记账收口", () => {
  test("终身订阅（expires_at = null）：不续期、不扣款", async () => {
    state.subscription!.expires_at = null;
    const outcome = await renewSubscriptionPeriod({ row: ROW, now: NOW });
    expect(outcome).toEqual({ charged: false, order_id: null, deferred: false, reason: "lifetime_no_renewal" });
    expect(state.orders).toHaveLength(0);
    expect(state.balance).toBe(100);
  });

  test("用户在结算这一刻把 auto_renew 关了：尊重它，不扣款", async () => {
    state.subscription!.auto_renew = false;
    const outcome = await renewSubscriptionPeriod({ row: ROW, now: NOW });
    expect(outcome).toEqual({ charged: false, order_id: null, deferred: false, reason: "auto_renew_off" });
    expect(state.orders).toHaveLength(0);
    expect(state.balance).toBe(100);
  });

  test("订阅行消失：deferred（不崩、不扣款）", async () => {
    state.subscription = null;
    const outcome = await renewSubscriptionPeriod({ row: ROW, now: NOW });
    expect(outcome).toEqual({ charged: false, deferred: true, reason: "subscription_gone" });
    expect(state.orders).toHaveLength(0);
  });
});
