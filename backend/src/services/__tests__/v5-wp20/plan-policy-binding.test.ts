/**
 * V5-WP20-4b 套餐 ↔ 策略绑定入口（`services/plan-subscription.ts`）单元测试 —— 离线。
 *
 * 契约：`docs/v5-wp20-subscription-billing-runtime-contract.md` §3.5.3（不做隐式推导 ⇒ 必须显式绑定）。
 *
 * 为什么这个文件的核心是**串起来的那条断言**（D 组）：本仓反复出现的一类缺陷是
 * 「功能写好了、没有任何写入路径」（`preferred_node_id`、`diag` 都栽在这里）。
 * WP20-4 落了 `Plan.policy_id` 与购买时的发放分支，但如果管理端**无法写这一列**，
 * 那条链在真实系统里永远不会被触发。所以验收不是「CRUD 返回 200」而是：
 *   **绑上 → 购买路径真的发放那条策略**（用真实的 `applyPlanPurchase` 串，不是复述断言）。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp20/plan-policy-binding.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  listBindablePolicies,
  parsePlanPolicyBinding,
  resolvePlanPolicyBinding,
  type BindablePolicy,
} from "../../plan-subscription.ts";
import { applyPlanPurchase, type PlanPurchaseInput } from "../../subscription-purchase.ts";

// ─────────────────────────── 假 tx（只覆盖本 WP 的调用面） ───────────────────────────

interface FakePolicyRow extends BindablePolicy {
  apply_to_workspace_kind?: string;
}

function makeTx(policies: FakePolicyRow[]) {
  const calls: Array<Record<string, unknown>> = [];
  const tx = {
    capabilityPolicy: {
      async findUnique(args: { where: { id: number } }) {
        calls.push({ model: "capabilityPolicy", method: "findUnique", ...args });
        return policies.find((policy) => policy.id === args.where.id) ?? null;
      },
      async findMany(args: Record<string, unknown>) {
        calls.push({ model: "capabilityPolicy", method: "findMany", args });
        return policies.filter((policy) => policy.status === "active" && !policy.is_ceiling);
      },
    },
  };
  return { tx, calls };
}

const POLICY: FakePolicyRow = { id: 8, key: "pro_monthly", name: "Pro 月付", status: "active", is_ceiling: false };

// ─────────────────────────── A. 纯解析 ───────────────────────────

describe("A. parsePlanPolicyBinding：部分更新语义（skip / unbind / bind / reject）", () => {
  test("不传 = skip（不动）；null / 空串 = 显式解绑", () => {
    expect(parsePlanPolicyBinding(undefined)).toEqual({ kind: "skip" });
    expect(parsePlanPolicyBinding(null)).toEqual({ kind: "unbind" });
    expect(parsePlanPolicyBinding("")).toEqual({ kind: "unbind" });
    expect(parsePlanPolicyBinding("   ")).toEqual({ kind: "unbind" });
  });

  test("正整数与数字字符串都接受（前端 Select 给字符串、JSON 也可能给数字）", () => {
    expect(parsePlanPolicyBinding(8)).toEqual({ kind: "bind", policy_id: 8 });
    expect(parsePlanPolicyBinding("8")).toEqual({ kind: "bind", policy_id: 8 });
  });

  test("其它一律 fail-closed：0 / 负数 / 小数 / 非数字", () => {
    for (const raw of [0, -1, 1.5, "abc", "8.5", {}, []]) {
      const decision = parsePlanPolicyBinding(raw);
      expect({ raw, kind: decision.kind }).toEqual({ raw, kind: "reject" });
    }
  });
});

// ─────────────────────────── B. 校验（与发放语义同口径） ───────────────────────────

describe("B. resolvePlanPolicyBinding：只接受「能真的生效」的策略", () => {
  test("启用中的普通策略 ⇒ bind，并把策略摘要带回（供 UI/日志）", async () => {
    const { tx } = makeTx([POLICY]);
    const decision = await resolvePlanPolicyBinding(tx, 8);
    expect(decision).toEqual({ kind: "bind", policy_id: 8, policy: POLICY });
  });

  test("策略不存在 ⇒ 拒绝", async () => {
    const { tx } = makeTx([]);
    expect(await resolvePlanPolicyBinding(tx, 8)).toEqual({ kind: "reject", message: "策略不存在" });
  });

  test("策略未启用 ⇒ 拒绝（反例：绑上=用户付钱拿到一条永远不生效的发放，静默 no-op）", async () => {
    // `capability-policy.ts#isAssignmentActive` 要求 `policy.status === "active"`：
    // 未启用的策略即使有发放行也不会生效，所以必须在**绑定那一刻**就拒，而不是事后靠用户投诉发现。
    const { tx } = makeTx([{ ...POLICY, status: "inactive" }]);
    const decision = await resolvePlanPolicyBinding(tx, 8);
    expect(decision.kind).toBe("reject");
    expect((decision as { message: string }).message).toContain("未启用");
  });

  test("平台硬上限模板 ⇒ 拒绝（反例：卖出一份『上限』而不是一份『权益』）", async () => {
    const { tx } = makeTx([{ ...POLICY, is_ceiling: true }]);
    const decision = await resolvePlanPolicyBinding(tx, 8);
    expect(decision.kind).toBe("reject");
    expect((decision as { message: string }).message).toContain("硬上限");
  });

  test("解绑 / 不改动不需要查库（省一次往返）", async () => {
    const { tx, calls } = makeTx([POLICY]);
    expect(await resolvePlanPolicyBinding(tx, null)).toEqual({ kind: "unbind", policy_id: null });
    expect(await resolvePlanPolicyBinding(tx, undefined)).toEqual({ kind: "skip" });
    expect(calls).toHaveLength(0);
  });
});

// ─────────────────────────── C. 选项列表与校验同一口径 ───────────────────────────

describe("C. listBindablePolicies：列出的必能被接受，没列出的一定被拒", () => {
  test("只回启用中的非上限策略（与 resolve 的接受集合同一口径）", async () => {
    const rows = [
      POLICY,
      { ...POLICY, id: 9, key: "inactive_x", status: "inactive" as const },
      { ...POLICY, id: 10, key: "ceiling", is_ceiling: true },
    ];
    const { tx, calls } = makeTx(rows);
    const options = await listBindablePolicies(tx);

    expect(options.map((option) => option.key)).toEqual(["pro_monthly"]);
    expect(calls[0]).toMatchObject({ method: "findMany" });
    expect((calls[0]!.args as Record<string, unknown>).where).toEqual({ status: "active", is_ceiling: false });

    // 口径一致性：列出的每个 id 都能通过 resolve；没列出的每个 id 都被拒。
    for (const option of options) {
      expect((await resolvePlanPolicyBinding(tx, option.id)).kind).toBe("bind");
    }
    for (const row of rows.filter((r) => !options.some((o) => o.id === r.id))) {
      expect((await resolvePlanPolicyBinding(tx, row.id)).kind).toBe("reject");
    }
  });
});

// ─────────────────────────── D. 端到端（服务层）：绑上 ⇒ 发放分支被触发 ───────────────────────────

describe("D. '能真的绑上，且绑上之后发放分支被触发'（本 WP 的真正验收）", () => {
  /** 极简假 tx：够 applyPlanPurchase 走完（订阅 upsert + legacy 双写 + 发放）。 */
  function makePurchaseTx() {
    const captured = { subscription: [] as Array<Record<string, unknown>>, assignments: [] as Array<Record<string, unknown>> };
    const tx = {
      planSubscription: {
        async findUnique() {
          return null;
        },
        async upsert(args: Record<string, unknown>) {
          captured.subscription.push(args);
          return { id: 501 };
        },
      },
      plan: { async findUnique() { return null; } },
      userPlan: {
        async findUnique() { return { id: 9 }; },
        async update() { return { id: 9 }; },
        async create() { return { id: 10 }; },
      },
      workspacePolicyAssignment: {
        async findUnique() { return null; },
        async updateMany() { return { count: 0 }; },
        async upsert(args: Record<string, unknown>) {
          captured.assignments.push(args);
          return { id: 77 };
        },
      },
    };
    return { tx: tx as unknown as Parameters<typeof applyPlanPurchase>[0], captured };
  }

  test("未绑定的套餐：购买成功但**不发放**（reason 可见）", async () => {
    const { tx, captured } = makePurchaseTx();
    const result = await applyPlanPurchase(tx, {
      now: new Date("2026-10-05T05:30:00.000Z"),
      workspace_id: 7,
      payer_user_id: 11,
      plan: { id: 3, name: "Pro", billing_cycle: "month", price: 20, policy_id: null },
      order_id: 900,
    });
    expect(result.grant).toEqual({ granted: false, policy_id: null, reason: "plan_policy_unbound", revoked: 0 });
    expect(captured.assignments).toHaveLength(0);
  });

  test("管理端绑上策略 ⇒ 同一段购买路径立刻发放那条策略（policy_id 一路贯通）", async () => {
    // ① 管理端提交 `policy_id`
    const { tx: adminTx } = makeTx([POLICY]);
    const decision = await resolvePlanPolicyBinding(adminTx, 8);
    expect(decision.kind).toBe("bind");

    // ② 这一列被写进 plan（`update`/`create` 的 data 就是 `{policy_id: decision.policy_id}`）
    const boundPlanPolicyId = decision.kind === "bind" ? decision.policy_id : null;
    expect(boundPlanPolicyId).toBe(8);

    // ③ 购买路径按这条绑定发放 —— 用的就是生产代码 applyPlanPurchase
    const { tx: purchaseTx, captured } = makePurchaseTx();
    const input: PlanPurchaseInput = {
      now: new Date("2026-10-05T05:30:00.000Z"),
      workspace_id: 7,
      payer_user_id: 11,
      plan: { id: 3, name: "Pro", billing_cycle: "month", price: 20, policy_id: boundPlanPolicyId },
      order_id: 900,
    };
    const result = await applyPlanPurchase(purchaseTx, input);

    expect(result.grant.granted).toBe(true);
    expect(result.grant.policy_id).toBe(8);
    const create = captured.assignments[0]!.create as Record<string, unknown>;
    expect(create).toMatchObject({ workspace_id: 7, policy_id: 8, source: "purchase" });
    // 发放到期点与订阅到期点同源（订阅 upsert 的计算结果）
    const subscriptionCreate = captured.subscription[0]!.create as Record<string, unknown>;
    expect(create.expires_at).toEqual(subscriptionCreate.expires_at);
  });
});

// ─────────────────────────── E. 接线守卫：入口不许悄悄消失 ───────────────────────────

describe("E. 静态守卫：管理端与前端都必须真的有这个入口", () => {
  const ADMIN_SOURCE = readFileSync(new URL("../../../routes/admin-extended.ts", import.meta.url), "utf8");
  const WEB_FORM = readFileSync(
    new URL("../../../../../web/src/components/admin/plans-manager.tsx", import.meta.url),
    "utf8",
  );
  const WEB_API = readFileSync(new URL("../../../../../web/src/lib/api.ts", import.meta.url), "utf8");

  test("套餐 CRUD 的创建与更新都解析 `body.policy_id`（POST 与 PATCH 各一次）", () => {
    const hits = [...ADMIN_SOURCE.matchAll(/resolvePlanPolicyBinding\(tx, body\.policy_id\)/g)];
    expect(hits).toHaveLength(2);
    // 创建路径要把它落进 data，更新路径要按部分更新语义只在非 skip 时落
    expect(ADMIN_SOURCE).toContain("policy_id: boundPolicyId");
    expect(ADMIN_SOURCE).toContain("data.policy_id = binding.policy_id");
  });

  test("有一条只读的选项端点，且用的是同一口径的服务函数", () => {
    expect(ADMIN_SOURCE).toContain('adminExtendedRoutes.get("/plan-policy-options"');
    expect(ADMIN_SOURCE).toContain("listBindablePolicies(db)");
  });

  test("前端表单把 `policy_id` 发出去（写路径的最后一环，缺了它整条链断掉）", () => {
    expect(WEB_FORM).toContain("policy_id:");
    expect(WEB_FORM).toContain("planPolicyOptions()");
    expect(WEB_API).toContain('"/admin/plan-policy-options"');
  });
});
