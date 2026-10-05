/**
 * V5-WP20-4 —— 「一次已付费的套餐交易如何落库」的**唯一**实现。
 *
 * 契约：`docs/v5-wp20-subscription-billing-runtime-contract.md` §3.5.2（套餐归属是 workspace，
 * `UserPlan` 冻结为 legacy 双写）、§3.5.3（自动续费默认关闭）、§3.5.4（`PlanOrder.workspace_id`）、
 * R6（双写漂移）；DoD 第 2/9 条。
 *
 * 两个消费者，一套语义：
 *   1. **用户购买**（`routes/plans.ts` 的 `POST /purchase`）——扣款与订单已由路由完成；
 *   2. **周期结算的续期执行器**（`services/subscription-billing.ts` 的 `executePeriod`）——
 *      该路径自己完成条件扣款与订单，然后调这里。
 * 若两边各写一份「延长多久、给哪条发放」，那正是契约禁止的第二份真相。
 *
 * ── 四条写死在这里的规则 ──
 *   1. **`PlanSubscription` 是唯一真相**，`UserPlan` 只是 legacy 展示投影（仅个人 workspace 双写）。
 *   2. **同套餐续期从 `max(now, 原到期点)` 起算**（F10），换套餐则替换期限（`started_at = now`）。
 *   3. **`auto_renew` 绝不被本模块写成 true**：创建时显式 `false`（fail-closed 默认，DoD 9），
 *      续期/换套餐时**不碰**这一列 —— 一次续费不该偷偷改用户的选择。
 *   4. **`traffic_used` 一个字节都不写**（契约 §3.3.2 / §4.0 冻结：它是派生/只读的 legacy 列，
 *      回写会产生第二份用量真相）。历史行为里的「换套餐把 `traffic_used` 置 0」因此**被删除**；
 *      反例：那个 0 会被读成「本周期已用 0 字节」，而真相是窗口求和（前端应改读
 *      `GET /api/me/capabilities`，见 WP20-6）。
 */
import type { BillingCycle, Prisma } from "@prisma/client";
import { grantPolicyFromPurchase, type PurchaseGrantResult } from "./policy-service.ts";

/**
 * 账单周期 → 天数（`lifetime` 用 100 年近似）。
 *
 * 与 F9 的既有口径逐字一致（`routes/plans.ts:37` 原文），**不是**日历月。
 * 这是 V4 已冻结的用户可见行为（`DEVELOPMENT.md` §1），本 WP 不改它 ——
 * 要改成日历月属于策略发放语义的变更，需要独立契约。
 */
export const PURCHASE_CYCLE_DAYS: Record<string, number> = {
  month: 30,
  quarter: 90,
  half_year: 180,
  year: 365,
  lifetime: 36500,
};

export const MS_PER_DAY = 86_400_000;

/** 当前订阅的最小形状（`PlanSubscription` 的读投影）。 */
export interface CurrentSubscription {
  id: number;
  plan_id: number;
  started_at: Date;
  expires_at: Date | null;
}

/** {@link nextSubscriptionTerm} 的结果。 */
export interface SubscriptionTerm {
  days: number;
  started_at: Date;
  expires_at: Date | null;
  /** 是否走了「同套餐续期」（决定 `started_at` 保留还是重置）。 */
  renewed_same_plan: boolean;
}

/**
 * 纯函数：算出这次交易之后订阅的起止点。
 *
 * 规则（与 F10 的既有语义对齐）：
 *   · 同套餐续期：`started_at` **保留**，`expires_at = max(now, 原到期点) + days`；
 *   · 换套餐 / 首次：`started_at = now`，`expires_at = now + days`；
 *   · `lifetime`：`expires_at = null`（无到期点，不是「很远的一天」）。
 *
 * 反例（为什么同套餐要取 `max`）：直接 `now + days` 会让提前续费的用户**损失**剩余天数；
 * 而 `原到期点 + days` 在已过期时又会把到期点算到过去（等于没续）。
 */
export function nextSubscriptionTerm(input: {
  now: Date;
  billing_cycle: string;
  plan_id: number;
  current: CurrentSubscription | null;
}): SubscriptionTerm {
  const days = PURCHASE_CYCLE_DAYS[input.billing_cycle] ?? 30;
  const same = input.current !== null && input.current.plan_id === input.plan_id;
  if (!same) {
    return {
      days,
      started_at: input.now,
      expires_at: input.billing_cycle === "lifetime" ? null : new Date(input.now.getTime() + days * MS_PER_DAY),
      renewed_same_plan: false,
    };
  }
  const current = input.current!;
  const base = Math.max(input.now.getTime(), current.expires_at ? current.expires_at.getTime() : input.now.getTime());
  return {
    days,
    started_at: current.started_at,
    expires_at: input.billing_cycle === "lifetime" ? null : new Date(base + days * MS_PER_DAY),
    renewed_same_plan: true,
  };
}

/** {@link applyPlanPurchase} 的输入：一次**已经付过钱**的交易（扣款与订单在调用方完成）。 */
export interface PlanPurchaseInput {
  /** 同一次交易里唯一的时间点（购买时间 / 续期结算时间）。 */
  now: Date;
  /** 归属 workspace：个人用户的 `personal` workspace（`PlanSubscription.workspace_id @unique`）。 */
  workspace_id: number;
  /**
   * 付款人 = legacy `UserPlan` 投影的 key。
   *
   * `null` = 该 workspace 没有钱包主体（团队 workspace 的 `personal_user_id` 为 NULL）⇒
   * **不写** legacy 投影（团队订阅没有对应的用户级展示行，凭空建一行会造出假归属）。
   */
  payer_user_id: number | null;
  plan: {
    id: number;
    name: string;
    billing_cycle: BillingCycle;
    /** 购买当时的标价 → 写进订阅快照（对账用；实付在 `PlanOrder.price`）。 */
    price: number;
    /** 套餐显式绑定的策略；`null` ⇒ 不发放 `purchase` 发放（见 policy-service 的注释）。 */
    policy_id: number | null;
    /**
     * legacy 投影需要的额度快照（字节；`null` = 不限）。
     *
     * **省略（`undefined`）= 不要动这两列**。续期（同套餐）刻意省略：额度不变就不该写，
     * 而且 DoD 第 1 条要求 `services/subscription-billing.ts` 里**不出现** `max_tunnels`/
     * `traffic_limit` 这类额度字段（计费侧不得触碰额度）—— 续期路径不去读它们，自然也不违例。
     */
    traffic_bytes?: number | null;
    max_tunnels?: number | null;
  };
  /** 本次交易产生的订单 id（进发放审计备注，也是续期幂等的锚点）。 */
  order_id: number;
}

/** {@link applyPlanPurchase} 的结果（全部可观测，便于断言与日志）。 */
export interface PlanPurchaseResult {
  subscription_id: number;
  plan_id: number;
  started_at: Date;
  expires_at: Date | null;
  renewed_same_plan: boolean;
  /** legacy `UserPlan` 投影的写入结果（`skipped` = 非个人 workspace，理论上不出现）。 */
  legacy_user_plan: "created" | "updated" | "skipped";
  grant: PurchaseGrantResult;
}

/**
 * 在**调用方的事务内**落库一次已付费的套餐交易。
 *
 * 调用方必须保证：① 扣款与 `PlanOrder` 已在同一事务里完成（R6：授权失败要回滚钱）；
 * ② 事务提交后执行 `invalidatePolicyCache(workspace_id)`（缓存失效只该发生在事实落库之后）。
 */
export async function applyPlanPurchase(
  tx: Prisma.TransactionClient,
  input: PlanPurchaseInput,
): Promise<PlanPurchaseResult> {
  const current = await tx.planSubscription.findUnique({
    where: { workspace_id: input.workspace_id },
    select: { id: true, plan_id: true, started_at: true, expires_at: true },
  });

  const term = nextSubscriptionTerm({
    now: input.now,
    billing_cycle: input.plan.billing_cycle,
    plan_id: input.plan.id,
    current,
  });

  // 换套餐时，旧套餐绑定的策略要显式撤销（否则两份套餐的发放会按并集同时生效）。
  let replaced_policy_id: number | null = null;
  if (current && current.plan_id !== input.plan.id) {
    const previousPlan = await tx.plan.findUnique({
      where: { id: current.plan_id },
      select: { policy_id: true },
    });
    replaced_policy_id = previousPlan?.policy_id ?? null;
  }

  const snapshot = {
    plan_id: input.plan.id,
    started_at: term.started_at,
    expires_at: term.expires_at,
    plan_name: input.plan.name,
    billing_cycle: input.plan.billing_cycle,
    price: input.plan.price,
  };
  const subscription = await tx.planSubscription.upsert({
    where: { workspace_id: input.workspace_id },
    create: {
      workspace_id: input.workspace_id,
      ...snapshot,
      // fail-closed 默认（DoD 9）：新建订阅永远是 false，自动续费必须由用户显式选择。
      auto_renew: false,
      source: "purchase",
    },
    // 注意**不包含** `auto_renew`：续期/换套餐不该偷偷改用户的选择。
    update: snapshot,
    select: { id: true },
  });

  // legacy 投影：`UserPlan` 冻结为展示视图，只镜像 dashboard/admin 仍在读的那几列。
  // 团队 workspace（无 `personal_user_id`）没有对应的用户级展示行 ⇒ 明确跳过，不凭空建一行。
  //
  // 额度快照两列：`undefined` ⇒ 不写（Prisma 视为「未提供」）。购买路径给值（可能换套餐，额度会变），
  // 续期路径省略（同套餐，额度不变）。
  const legacy_quota =
    input.plan.traffic_bytes === undefined && input.plan.max_tunnels === undefined
      ? {}
      : {
          ...(input.plan.traffic_bytes === undefined ? {} : { traffic: input.plan.traffic_bytes }),
          ...(input.plan.max_tunnels === undefined ? {} : { max_tunnels: input.plan.max_tunnels }),
        };
  let legacy_user_plan: PlanPurchaseResult["legacy_user_plan"] = "skipped";
  if (input.payer_user_id !== null) {
    const legacy = await tx.userPlan.findUnique({ where: { user_id: input.payer_user_id }, select: { id: true } });
    if (legacy) {
      await tx.userPlan.update({
        where: { user_id: input.payer_user_id },
        data: {
          plan_id: input.plan.id,
          expired_at: term.expires_at,
          ...legacy_quota,
          // 绝不写 `traffic_used`（契约 §3.3.2 冻结）。
        },
      });
      legacy_user_plan = "updated";
    } else {
      await tx.userPlan.create({
        data: {
          user_id: input.payer_user_id,
          plan_id: input.plan.id,
          expired_at: term.expires_at,
          ...legacy_quota,
        },
      });
      legacy_user_plan = "created";
    }
  }

  const grant = await grantPolicyFromPurchase(tx, {
    workspace_id: input.workspace_id,
    policy_id: input.plan.policy_id,
    expires_at: term.expires_at,
    replace_policy_id: replaced_policy_id,
    note: `order:${input.order_id} plan:${input.plan.id}`,
    now: input.now,
  });

  return {
    subscription_id: subscription.id,
    plan_id: input.plan.id,
    started_at: term.started_at,
    expires_at: term.expires_at,
    renewed_same_plan: term.renewed_same_plan,
    legacy_user_plan,
    grant,
  };
}

/** 1 GiB 的字节数（与 `routes/plans.ts` 的既有口径一致：`GB = 1024^3`）。 */
export const GB_BYTES = 1024 * 1024 * 1024;

/** 套餐 `traffic`（GB 整数）→ 字节；`null` 保持 `null`（= 不限）。 */
export function planTrafficBytes(trafficGb: number | null, bytesPerGb: number = GB_BYTES): number | null {
  return trafficGb === null ? null : trafficGb * bytesPerGb;
}
