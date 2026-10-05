/**
 * V5-WP20-4 单元测试 —— 购买 → 订阅 + 发放接线（离线，不碰 DB/Redis）。
 *
 * 契约：`docs/v5-wp20-subscription-billing-runtime-contract.md` §3.5.2（归属是 workspace、
 * `UserPlan` 冻结为 legacy 双写）、§3.5.3（套餐需显式绑定策略；自动续费默认关闭）、
 * §3.5.4（`PlanOrder.workspace_id`）、§3.2.2（`purchase` 发放的唯一写入点）、R6；
 * DoD 第 2/9 条。
 *
 * 覆盖：
 *   A. 纯函数 `nextSubscriptionTerm`：首购 / 同套餐续期（未过期、已过期）/ 换套餐 / 终身 / 未知周期。
 *   B. `applyPlanPurchase`：PlanSubscription 是唯一真相 + legacy 双写（**绝不写 traffic_used**）
 *      + 换套餐撤销旧 `purchase` 发放 + 续期不动 `auto_renew`。
 *   C. `grantPolicyFromPurchase`：显式绑定才发放 / NULL 不发放也不报错 / `effective_at` 只前移不后移 /
 *      幂等 upsert。
 *   D. 静态守卫：DoD 第 2 条（发放写入点恰好两个）与「购买路径不回写 traffic_used」。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp20/subscription-purchase.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { grantPolicyFromPurchase } from "../../policy-service.ts";
import {
  GB_BYTES,
  MS_PER_DAY,
  applyPlanPurchase,
  nextSubscriptionTerm,
  planTrafficBytes,
  type CurrentSubscription,
} from "../../subscription-purchase.ts";

// ─────────────────────────── 假事务（记录调用面） ───────────────────────────

interface CapturedCall {
  model: string;
  method: string;
  args: Record<string, unknown>;
}

interface FakeTxOptions {
  currentSubscription?: CurrentSubscription | null;
  /** 旧套餐（换套餐时读它的 policy_id 以决定撤销哪条发放）。 */
  previousPlan?: { id: number; policy_id: number | null } | null;
  existingAssignment?: { effective_at: Date } | null;
  legacyUserPlan?: { id: number } | null;
  revokeCount?: number;
}

function makeTx(options: FakeTxOptions = {}) {
  const calls: CapturedCall[] = [];
  const tx = {
    planSubscription: {
      async findUnique(args: Record<string, unknown>) {
        calls.push({ model: "planSubscription", method: "findUnique", args });
        return options.currentSubscription ?? null;
      },
      async upsert(args: Record<string, unknown>) {
        calls.push({ model: "planSubscription", method: "upsert", args });
        return { id: 501 };
      },
    },
    plan: {
      async findUnique(args: Record<string, unknown>) {
        calls.push({ model: "plan", method: "findUnique", args });
        return options.previousPlan ?? null;
      },
    },
    userPlan: {
      async findUnique(args: Record<string, unknown>) {
        calls.push({ model: "userPlan", method: "findUnique", args });
        return options.legacyUserPlan === undefined ? { id: 9 } : options.legacyUserPlan;
      },
      async update(args: Record<string, unknown>) {
        calls.push({ model: "userPlan", method: "update", args });
        return { id: 9 };
      },
      async create(args: Record<string, unknown>) {
        calls.push({ model: "userPlan", method: "create", args });
        return { id: 10 };
      },
    },
    workspacePolicyAssignment: {
      async findUnique(args: Record<string, unknown>) {
        calls.push({ model: "workspacePolicyAssignment", method: "findUnique", args });
        return options.existingAssignment ?? null;
      },
      async updateMany(args: Record<string, unknown>) {
        calls.push({ model: "workspacePolicyAssignment", method: "updateMany", args });
        return { count: options.revokeCount ?? 1 };
      },
      async upsert(args: Record<string, unknown>) {
        calls.push({ model: "workspacePolicyAssignment", method: "upsert", args });
        return { id: 77 };
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, calls };
}

const NOW = new Date("2026-10-05T05:30:00.000Z");

const PLAN = {
  id: 3,
  name: "Pro",
  billing_cycle: "month" as const,
  price: 20,
  policy_id: 8,
  traffic_bytes: 100 * GB_BYTES,
  max_tunnels: 5,
};

const purchase = (over: Partial<Parameters<typeof applyPlanPurchase>[1]> = {}) => ({
  now: NOW,
  workspace_id: 7,
  payer_user_id: 11,
  plan: PLAN,
  order_id: 900,
  ...over,
});

// ─────────────────────────── A. 纯函数 ───────────────────────────

describe("A. nextSubscriptionTerm：期限怎么算（纯函数）", () => {
  test("首次购买：从 now 起算，30 天（month）", () => {
    const term = nextSubscriptionTerm({ now: NOW, billing_cycle: "month", plan_id: 3, current: null });
    expect(term).toEqual({
      days: 30,
      started_at: NOW,
      expires_at: new Date(NOW.getTime() + 30 * MS_PER_DAY),
      renewed_same_plan: false,
    });
  });

  test("同套餐续期（未过期）：从**原到期点**接续，不吞掉剩余天数", () => {
    const current: CurrentSubscription = {
      id: 1,
      plan_id: 3,
      started_at: new Date("2026-09-01T00:00:00.000Z"),
      expires_at: new Date("2026-10-20T00:00:00.000Z"), // 提前 15 天续费
    };
    const term = nextSubscriptionTerm({ now: NOW, billing_cycle: "month", plan_id: 3, current });
    expect(term.renewed_same_plan).toBe(true);
    expect(term.started_at).toEqual(current.started_at); // started_at 保留
    expect(term.expires_at!.toISOString()).toBe("2026-11-19T00:00:00.000Z"); // 10-20 + 30 天
  });

  test("同套餐续期（已过期）：从现在起算，不落回过去", () => {
    const current: CurrentSubscription = {
      id: 1,
      plan_id: 3,
      started_at: new Date("2026-08-01T00:00:00.000Z"),
      expires_at: new Date("2026-09-01T00:00:00.000Z"),
    };
    const term = nextSubscriptionTerm({ now: NOW, billing_cycle: "month", plan_id: 3, current });
    expect(term.expires_at!.toISOString()).toBe("2026-11-04T05:30:00.000Z"); // 10-05 + 30 天
  });

  test("换套餐：期限**替换**（started_at = now），旧剩余天数不结转", () => {
    const current: CurrentSubscription = {
      id: 1,
      plan_id: 99,
      started_at: new Date("2026-09-01T00:00:00.000Z"),
      expires_at: new Date("2027-09-01T00:00:00.000Z"),
    };
    const term = nextSubscriptionTerm({ now: NOW, billing_cycle: "year", plan_id: 3, current });
    expect(term.renewed_same_plan).toBe(false);
    expect(term.started_at).toEqual(NOW);
    expect(term.expires_at!.toISOString()).toBe("2027-10-05T05:30:00.000Z"); // now + 365 天
  });

  test("终身：expires_at = null（不是『很远的一天』）", () => {
    const term = nextSubscriptionTerm({ now: NOW, billing_cycle: "lifetime", plan_id: 3, current: null });
    expect(term.expires_at).toBeNull();
    expect(term.days).toBe(36500);
  });

  test("未知周期回落 30 天；planTrafficBytes 的 null 语义保持", () => {
    expect(nextSubscriptionTerm({ now: NOW, billing_cycle: "weird", plan_id: 3, current: null }).days).toBe(30);
    expect(planTrafficBytes(null)).toBeNull();
    expect(planTrafficBytes(2)).toBe(2 * GB_BYTES);
    expect(GB_BYTES).toBe(1024 * 1024 * 1024);
  });
});

// ─────────────────────────── B. applyPlanPurchase ───────────────────────────

describe("B. applyPlanPurchase：唯一真相 + legacy 双写", () => {
  test("首次购买：PlanSubscription 带快照与 fail-closed 默认；legacy 行被创建", async () => {
    const { tx, calls } = makeTx({ currentSubscription: null, legacyUserPlan: null });
    const result = await applyPlanPurchase(tx, purchase());

    const upsert = calls.find((call) => call.model === "planSubscription" && call.method === "upsert")!;
    const create = upsert.args.create as Record<string, unknown>;
    expect(create).toMatchObject({
      workspace_id: 7,
      plan_id: 3,
      plan_name: "Pro",
      billing_cycle: "month",
      price: 20,
      source: "purchase",
      auto_renew: false, // DoD 9：新建订阅永远 fail-closed
    });
    expect(create.expires_at).toEqual(new Date(NOW.getTime() + 30 * MS_PER_DAY));

    const legacyCreate = calls.find((call) => call.model === "userPlan" && call.method === "create")!;
    const legacyData = legacyCreate.args.data as Record<string, unknown>;
    expect(legacyData).toMatchObject({ user_id: 11, plan_id: 3, traffic: 100 * GB_BYTES, max_tunnels: 5 });
    expect("traffic_used" in legacyData).toBe(false); // 冻结：一个字节都不写

    expect(result).toMatchObject({
      subscription_id: 501,
      plan_id: 3,
      renewed_same_plan: false,
      legacy_user_plan: "created",
      grant: { granted: true, policy_id: 8, revoked: 0 },
    });
  });

  test("续期：保留 started_at、不碰 auto_renew、legacy 行被更新（同样不写 traffic_used）", async () => {
    const current: CurrentSubscription = {
      id: 1,
      plan_id: 3,
      started_at: new Date("2026-09-01T00:00:00.000Z"),
      expires_at: new Date("2026-10-20T00:00:00.000Z"),
    };
    const { tx, calls } = makeTx({ currentSubscription: current });
    const result = await applyPlanPurchase(tx, purchase());

    const upsert = calls.find((call) => call.model === "planSubscription" && call.method === "upsert")!;
    const update = upsert.args.update as Record<string, unknown>;
    expect(update.started_at).toEqual(current.started_at);
    expect(update.expires_at).toEqual(new Date("2026-11-19T00:00:00.000Z"));
    expect("auto_renew" in update).toBe(false); // 一次续费不该偷偷改用户的选择

    const legacyUpdate = calls.find((call) => call.model === "userPlan" && call.method === "update")!;
    const legacyData = legacyUpdate.args.data as Record<string, unknown>;
    expect(legacyData.expired_at).toEqual(new Date("2026-11-19T00:00:00.000Z"));
    expect("traffic_used" in legacyData).toBe(false);

    expect(result.renewed_same_plan).toBe(true);
    expect(result.legacy_user_plan).toBe("updated");
  });

  test("换套餐：撤销旧套餐的 purchase 发放（避免两份套餐并集并存）", async () => {
    const current: CurrentSubscription = {
      id: 1,
      plan_id: 99,
      started_at: new Date("2026-09-01T00:00:00.000Z"),
      expires_at: new Date("2026-09-30T00:00:00.000Z"),
    };
    const { tx, calls } = makeTx({ currentSubscription: current, previousPlan: { id: 99, policy_id: 42 } });
    const result = await applyPlanPurchase(tx, purchase());

    const revoke = calls.find((call) => call.method === "updateMany")!;
    expect(revoke.args.where).toEqual({
      workspace_id: 7,
      policy_id: 42,
      source: "purchase",
      revoked_at: null,
    });
    expect(result.grant.revoked).toBe(1);
  });

  test("套餐没有绑定策略：购买照常落库，但**不发放**（不报错、不猜模板）", async () => {
    const { tx, calls } = makeTx({ currentSubscription: null });
    const result = await applyPlanPurchase(tx, purchase({ plan: { ...PLAN, policy_id: null } }));

    expect(result.grant).toEqual({ granted: false, policy_id: null, reason: "plan_policy_unbound", revoked: 0 });
    // 订阅照常写入（扣款/订单在调用方已完成，不能因为没绑策略就把交易丢掉）
    expect(calls.some((call) => call.model === "planSubscription" && call.method === "upsert")).toBe(true);
    expect(calls.some((call) => call.model === "workspacePolicyAssignment" && call.method === "upsert")).toBe(false);
  });

  test("团队 workspace（无钱包主体）：订阅照常，但**不写** legacy 投影", async () => {
    const { tx, calls } = makeTx({ currentSubscription: null });
    const result = await applyPlanPurchase(tx, purchase({ payer_user_id: null }));
    expect(result.legacy_user_plan).toBe("skipped");
    expect(calls.some((call) => call.model === "userPlan" && call.method !== "findUnique")).toBe(false);
  });
});

// ─────────────────────────── C. grantPolicyFromPurchase ───────────────────────────

describe("C. grantPolicyFromPurchase：显式、幂等、effective_at 不前移后移", () => {
  test("NULL 策略：不写、返回原因码（不抛错）", async () => {
    const { tx, calls } = makeTx();
    const result = await grantPolicyFromPurchase(tx, {
      workspace_id: 7,
      policy_id: null,
      expires_at: null,
      now: NOW,
    });
    expect(result).toEqual({ granted: false, policy_id: null, reason: "plan_policy_unbound", revoked: 0 });
    expect(calls).toHaveLength(0);
  });

  test("首次发放：source=purchase、effective_at=now、expires_at 与订阅同源", async () => {
    const { tx, calls } = makeTx({ existingAssignment: null });
    const expires = new Date("2026-11-04T05:30:00.000Z");
    const result = await grantPolicyFromPurchase(tx, {
      workspace_id: 7,
      policy_id: 8,
      expires_at: expires,
      note: "order:900 plan:3",
      now: NOW,
    });
    const upsert = calls.find((call) => call.method === "upsert")!;
    expect(upsert.args.create).toMatchObject({
      workspace_id: 7,
      policy_id: 8,
      source: "purchase",
      effective_at: NOW,
      expires_at: expires,
      note: "order:900 plan:3",
    });
    expect(result).toEqual({ granted: true, policy_id: 8, revoked: 0 });
  });

  test("续期：effective_at **不后移**（提前续费的用户不能因为续费当场失去准入）", async () => {
    const original = new Date("2026-09-01T00:00:00.000Z");
    const { tx, calls } = makeTx({ existingAssignment: { effective_at: original } });
    await grantPolicyFromPurchase(tx, { workspace_id: 7, policy_id: 8, expires_at: null, now: NOW });
    const upsert = calls.find((call) => call.method === "upsert")!;
    expect((upsert.args.update as Record<string, unknown>).effective_at).toEqual(original);
    expect((upsert.args.update as Record<string, unknown>).revoked_at).toBeNull();
  });

  test("异常数据（effective_at 在未来）：回落 now，同样不后移", async () => {
    const future = new Date("2027-01-01T00:00:00.000Z");
    const { tx, calls } = makeTx({ existingAssignment: { effective_at: future } });
    await grantPolicyFromPurchase(tx, { workspace_id: 7, policy_id: 8, expires_at: null, now: NOW });
    const upsert = calls.find((call) => call.method === "upsert")!;
    expect((upsert.args.update as Record<string, unknown>).effective_at).toEqual(NOW);
  });

  test("replace_policy_id 相同 ⇒ 不撤销；不同 ⇒ 撤销且只撤 purchase 来源", async () => {
    const same = makeTx();
    await grantPolicyFromPurchase(same.tx, {
      workspace_id: 7,
      policy_id: 8,
      expires_at: null,
      replace_policy_id: 8,
      now: NOW,
    });
    expect(same.calls.some((call) => call.method === "updateMany")).toBe(false);

    const different = makeTx();
    await grantPolicyFromPurchase(different.tx, {
      workspace_id: 7,
      policy_id: 8,
      expires_at: null,
      replace_policy_id: 42,
      now: NOW,
    });
    const revoke = different.calls.find((call) => call.method === "updateMany")!;
    expect(revoke.args.data).toEqual({ revoked_at: NOW });
    expect((revoke.args.where as Record<string, unknown>).source).toBe("purchase");
  });
});

// ─────────────────────────── D. 静态守卫 ───────────────────────────

const SRC_DIR = new URL("../../../", import.meta.url); // backend/src/
const PURCHASE_SOURCE = readFileSync(new URL("../../subscription-purchase.ts", import.meta.url), "utf8");
const PURCHASE_CODE = PURCHASE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'])\/\/[^\n]*/g, "$1");

function productionSources(dir: URL): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(dir)) {
    const child = new URL(entry, dir);
    if (statSync(child).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...productionSources(new URL(`${entry}/`, dir)));
      continue;
    }
    if (entry.endsWith(".ts")) out.push({ path: child.pathname, text: readFileSync(child, "utf8") });
  }
  return out;
}

describe("D. 静态守卫：发放写入点恰好两个 / 不回写 traffic_used", () => {
  test("DoD 第 2 条：全仓 workspacePolicyAssignment 的 create|upsert 恰好 2 处（且落在指定两个函数里）", () => {
    // 断言本身不能出现在被扫的文本里，否则这条 grep 会数到自己 —— 故把模式拆开拼接。
    const pattern = new RegExp(`workspacePolicyAssignment\\.(${["up", "sert"].join("")}|${["cre", "ate"].join("")})\\b`, "g");
    const hits: Array<{ file: string; fn: string }> = [];
    for (const { path, text } of productionSources(SRC_DIR)) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'])\/\/[^\n]*/g, "$1");
      for (const match of code.matchAll(pattern)) {
        const before = code.slice(0, match.index);
        // 最近的 `export async function NAME` 就是它所在的函数（行号会随注释改动漂移，函数名不会）
        const fn = [...before.matchAll(/export async function (\w+)/g)].at(-1)?.[1] ?? "(顶层)";
        hits.push({ file: path.split("/src/")[1]!, fn });
      }
    }
    // 恰好两处：既有的 assignDefaultPolicy（system_default）与本 WP 的 grantPolicyFromPurchase（purchase）。
    expect(hits.map((hit) => hit.fn)).toEqual(["assignDefaultPolicy", "grantPolicyFromPurchase"]);
    expect(hits.map((hit) => hit.file)).toEqual(["services/policy-service.ts", "services/policy-service.ts"]);
  });

  test("购买/续期实现从不写 traffic_used（契约 §3.3.2 冻结）", () => {
    expect(PURCHASE_CODE).not.toContain("traffic_used");
    // 也不得从额度列反推策略（§3.5.3：不做隐式推导）
    expect(PURCHASE_CODE).not.toContain("max_tunnels ??");
    expect(PURCHASE_CODE).not.toContain("capabilityPolicy.findFirst");
  });

  test("`auto_renew` 在本模块只有显式 false / 只读两种形态（DoD 第 9 条）", () => {
    const autoRenewLines = PURCHASE_CODE.split("\n").filter((line) => line.includes("auto_renew"));
    expect(autoRenewLines.length).toBeGreaterThan(0);
    for (const line of autoRenewLines) {
      expect({ line, ok: /auto_renew:\s*false|不包含|绝不|auto_renew\b(?!\s*[:=]\s*true)/.test(line) }).toEqual({ line, ok: true });
    }
    expect(PURCHASE_CODE).not.toMatch(/auto_renew\s*[:=]\s*true/);
  });
});
