/**
 * **套餐 ↔ 能力策略绑定入口**（把 `Plan.policy_id` 变成真能写的一列）。
 *
 * ── 为什么需要这个 WP ──
 * WP20-4 落了 `Plan.policy_id` 与购买时的发放分支，但**没有任何写入路径**能设它：
 * 于是「套餐 → `purchase` 发放」这条链在真实系统里永远不会被触发。这在本仓是一类反复出现的
 * 缺陷形态（写好了能力却没有写入方：`preferred_node_id`、`diag` 都栽在这里），
 * 所以本模块的验收不是「CRUD 返回 200」，而是「**能真的绑上，且绑上之后发放分支被触发**」
 * ——后者由 `services/__tests__/v5-wp20/plan-policy-binding.test.ts` 用真实
 * `applyPlanPurchase` 串起来断言。
 *
 * ── 为什么校验放在服务层 ──
 * 管理端路由只负责解析请求体；「哪些策略可以绑」是一条**领域判定**，它必须与发放语义
 * （`capability-policy.ts#isAssignmentActive` 要求 `policy.status === "active"`）保持同一口径。
 * 放在路由里会随第二个调用方（未来的批量导入 / CLI）漂移。见 `plan_subscription_ops` 的两条拒绝理由。
 *
 * ── 契约 ──
 * `docs/v5-wp20-subscription-billing-runtime-contract.md` §3.5.3（不做隐式推导 ⇒ 必须显式绑定）。 */
import type { Prisma } from "@prisma/client";

/** 可绑定的策略（读投影）。 */
export interface BindablePolicy {
  id: number;
  key: string;
  name: string;
  status: "active" | "inactive";
  is_ceiling: boolean;
}

/**
 * 解析管理端传来的 `policy_id` 原始值 —— **纯函数**，不碰 db。
 *
 * | 输入 | 决定 | 理由 |
 * |---|---|---|
 * | `undefined` | `skip` | 请求没带这个字段 = 不改动（PATCH 的部分更新语义） |
 * | `null` / `""` | `unbind` | **显式解绑**是必要能力：绑错了要能退回来 |
 * | 正整数 / 数字字符串 | `bind` | 前端 `<Select>` 与 JSON 都可能给两种形态 |
 * | 其它（0 / 负数 / 小数 / `"abc"`） | `reject` | fail-closed，不猜 |
 */
export type PlanPolicyBindingIntent =
  | { kind: "skip" }
  | { kind: "unbind" }
  | { kind: "bind"; policy_id: number }
  | { kind: "reject"; message: string };

export function parsePlanPolicyBinding(raw: unknown): PlanPolicyBindingIntent {
  if (raw === undefined) return { kind: "skip" };
  if (raw === null) return { kind: "unbind" };
  if (typeof raw === "string" && raw.trim() === "") return { kind: "unbind" };
  const numeric = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { kind: "reject", message: "策略 ID 不合法" };
  }
  return { kind: "bind", policy_id: numeric };
}

/** {@link resolvePlanPolicyBinding} 的结果：可直接喂给 `plan.policy_id`。 */
export type PlanPolicyBindingDecision =
  | { kind: "skip" }
  | { kind: "unbind"; policy_id: null }
  | { kind: "bind"; policy_id: number; policy: BindablePolicy }
  | { kind: "reject"; message: string };

/** 读策略的最小依赖面（乐观：接受 Prisma tx 或 Client）。 */
export interface PolicyLookup {
  capabilityPolicy: {
    findUnique(args: {
      where: { id: number };
      select: { id: true; key: true; name: true; status: true; is_ceiling: true };
    }): Promise<BindablePolicy | null>;
  };
}

/**
 * 校验并落定一条绑定意图。**两条拒绝理由都不是洁癖**：
 *
 * 1. `status !== "active"` ⇒ 拒绝。`capability-policy.ts` 的 `isAssignmentActive` 与
 *    `isWithinGrace` 都要求 `policy.status === "active"`，所以把**未启用**的策略绑给套餐，
 *    结果是「用户付了钱、拿到一条永远不生效的发放」—— 静默 no-op，正是本 WP 要消灭的形态。
 *    要卖它，先把策略启用。
 * 2. `is_ceiling` ⇒ 拒绝。`is_ceiling` 是**平台硬上限模板**，语义是「所有 workspace 的绝对上界，
 *    不直接发放」；允许绑定会让这个商品卖出一份『上限』而不是一份『权益』。
 */
export async function resolvePlanPolicyBinding(
  client: PolicyLookup,
  raw: unknown,
): Promise<PlanPolicyBindingDecision> {
  const intent = parsePlanPolicyBinding(raw);
  if (intent.kind === "skip") return { kind: "skip" };
  if (intent.kind === "reject") return intent;
  if (intent.kind === "unbind") return { kind: "unbind", policy_id: null };

  const policy = await client.capabilityPolicy.findUnique({
    where: { id: intent.policy_id },
    select: { id: true, key: true, name: true, status: true, is_ceiling: true },
  });
  if (!policy) return { kind: "reject", message: "策略不存在" };
  if (policy.status !== "active") return { kind: "reject", message: "该策略未启用，绑定后发放不会生效" };
  if (policy.is_ceiling) return { kind: "reject", message: "平台硬上限模板不能作为套餐策略发放" };
  return { kind: "bind", policy_id: policy.id, policy };
}

/**
 * 策略选项列表（给管理端「绑定策略」下拉框用）：**只列可绑的** —— 启用中且不是平台上限模板。
 * 与 {@link resolvePlanPolicyBinding} 的接受集合**同一口径**：下拉框里能选的，服务端一定接受；
 * 下拉框里没有的（未启用 / 上限模板），服务端也会拒。两处口径若漂移，
 * 就会出现「UI 能选但保存报错」或反过来的「能保存但发放不生效」。
 */
export async function listBindablePolicies(client: {
  capabilityPolicy: {
    findMany(args: {
      where: { status: "active"; is_ceiling: false };
      orderBy: { key: "asc" };
      select: { id: true; key: true; name: true; status: true; is_ceiling: true };
    }): Promise<BindablePolicy[]>;
  };
}): Promise<BindablePolicy[]> {
  return client.capabilityPolicy.findMany({
    where: { status: "active", is_ceiling: false },
    orderBy: { key: "asc" },
    select: { id: true, key: true, name: true, status: true, is_ceiling: true },
  });
}
