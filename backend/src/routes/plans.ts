/**
 * 套餐路由（用户侧）—— 前端 api.plans.*
 *
 * 端点（挂载于 /api/plans）：
 *   GET  /          套餐列表（分页 / 关键字 / 状态过滤）
 *   GET  /:id       套餐详情
 *   POST /purchase  购买套餐（余额扣款 + 订单 + 订阅落库，单事务）
 *
 * 挂载方式（由 app.ts 的收尾子代理执行，本模块不修改 app.ts）：
 *   import { plansRoutes } from "./routes/plans.ts";
 *   app.route("/api/plans", plansRoutes);
 *
 * 响应封装：前端 request() 剥掉 **一层** 顶层 data —— 列表返回
 *   { data: { data: rows, total, page, page_size } }，单对象返回 { data: obj }。
 *
 * 购买流程（V5-WP20-4 起，契约 §3.5）：
 *   ① 套餐存在且 active ② 库存校验 ③ 优惠码折算 ④ 余额校验
 *   ⑤ 单事务：扣余额 + BalanceLog + 订单（带 `workspace_id`）+ **订阅** + **purchase 发放**
 *   ⑥ 事务提交后 `invalidatePolicyCache`
 *
 * 三处与旧实现的语义差异（**不是重写，是接线**）：
 *   · 订阅的真相从 `UserPlan`（用户级单例）改为 `PlanSubscription`（**workspace 级**，§3.5.2）；
 *     `UserPlan` 降级为 legacy 展示投影，仍在同一事务里双写，按 user 维度。
 *   · 落库 + 发放的唯一实现是 `services/subscription-purchase.ts#applyPlanPurchase` ——
 *     周期结算的续期执行器用的是**同一段**（两处各写一份正是契约禁止的第二份真相）。
 *   · `UserPlan.traffic_used` **不再被写**（§3.3.2 / §4.0 冻结：它是派生/只读的 legacy 列）。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { invalidatePolicyCache } from "../services/policy-service.ts";
import { applyPlanPurchase, planTrafficBytes } from "../services/subscription-purchase.ts";
import { ensurePersonalWorkspace } from "../services/workspace.ts";

export const plansRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

/* ------------------------------------------------------------------ */
/* GET / —— 列表                                                       */
/* ------------------------------------------------------------------ */

plansRoutes.get("/", async (c) => {
  requireUser(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const page_size = Math.min(200, Math.max(1, Number(q.page_size ?? 20) || 20));
  const keyword = String(q.keyword ?? "").trim();
  const status = q.status && q.status !== "all" ? String(q.status) : undefined;

  const where = {
    ...(status ? { status: status as "active" | "inactive" } : {}),
    ...(keyword ? { name: { contains: keyword } } : {}),
  };

  const [rows, total] = await Promise.all([
    db.plan.findMany({
      where,
      orderBy: [{ order_by: "asc" }, { id: "asc" }],
      skip: (page - 1) * page_size,
      take: page_size,
      include: { node_groups: { include: { node_group: { select: { id: true, name: true } } } } },
    }),
    db.plan.count({ where }),
  ]);

  const data = rows.map(({ node_groups, ...p }) => ({
    ...p,
    node_groups: node_groups.map((ng) => ({ id: ng.node_group.id, name: ng.node_group.name })),
  }));

  return c.json({ data: { data, total, page, page_size } });
});

/* ------------------------------------------------------------------ */
/* GET /:id —— 详情                                                    */
/* ------------------------------------------------------------------ */

plansRoutes.get("/:id", async (c) => {
  requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的套餐 ID" }, 400);

  const plan = await db.plan.findUnique({
    where: { id },
    include: { node_groups: { include: { node_group: { select: { id: true, name: true } } } } },
  });
  if (!plan) return c.json({ error: "套餐不存在" }, 404);

  const { node_groups, ...rest } = plan;
  return c.json({
    data: { ...rest, node_groups: node_groups.map((ng) => ({ id: ng.node_group.id, name: ng.node_group.name })) },
  });
});

/* ------------------------------------------------------------------ */
/* POST /purchase —— 购买                                              */
/* ------------------------------------------------------------------ */

plansRoutes.post("/purchase", async (c) => {
  const user = requireUser(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "参数错误" }, 400);

  const planId = Number(body.plan_id);
  if (!Number.isInteger(planId)) return c.json({ error: "缺少 plan_id" }, 400);

  const plan = await db.plan.findUnique({ where: { id: planId } });
  if (!plan) return c.json({ error: "套餐不存在" }, 404);
  if (plan.status !== "active") return c.json({ error: "该套餐已下架" }, 400);
  if (plan.stock !== null && plan.stock <= 0) return c.json({ error: "库存不足" }, 400);

  // 购买归属到用户的 `personal` workspace（契约 §3.5.2：套餐属 workspace，不属 user）。
  // 这里用幂等修复而不是「查不到就拒绝」：workspace 由注册流程创建，但**早于**该流程的存量账号
  // 可能没有；为一次合法购买返回 500 是最差的选择，而 `ensurePersonalWorkspace` 本来就是
  // 为这种账号准备的幂等修复（内含 `assignDefaultPolicy`，即既有那条 system_default 发放）。
  const workspace = await ensurePersonalWorkspace({ id: user.id, email: user.email });

  // ---- 优惠码折算 ----
  let total = plan.price + (plan.setup_fee ?? 0);
  let couponId: number | null = null;
  const code = String(body.coupon ?? "").trim();
  if (code) {
    const now = new Date();
    const coupon = await db.planCoupon.findFirst({ where: { code } });
    if (!coupon) return c.json({ error: "优惠码无效" }, 400);
    if (coupon.valid_start && coupon.valid_start > now) return c.json({ error: "优惠码尚未生效" }, 400);
    if (coupon.valid_end && coupon.valid_end < now) return c.json({ error: "优惠码已过期" }, 400);
    if (coupon.valid_cycle && coupon.valid_cycle !== plan.billing_cycle) {
      return c.json({ error: "优惠码不适用于该套餐周期" }, 400);
    }
    const usedTotal = await db.planOrder.count({ where: { coupon_id: coupon.id } });
    if (coupon.max_use !== null && usedTotal >= coupon.max_use) {
      return c.json({ error: "优惠码使用次数已达上限" }, 400);
    }
    const usedByMe = await db.planOrder.count({ where: { coupon_id: coupon.id, user_id: user.id } });
    if (coupon.max_use_per_user !== null && usedByMe >= coupon.max_use_per_user) {
      return c.json({ error: "您已使用过该优惠码" }, 400);
    }
    total = coupon.type === "percentage" ? total * (1 - coupon.value / 100) : total - coupon.value;
    total = Number(Math.max(0, total).toFixed(2));
    couponId = coupon.id;
  }

  if (user.balance < total) return c.json({ error: "余额不足，请先充值" }, 400);

  // ---- 单事务：扣款 → 订单 → 订阅（PlanSubscription 唯一真相 + legacy 双写）→ purchase 发放 ----
  //
  // 顺序即契约（§3.5.2/R6）：扣款、订单、订阅、发放必须**同事务** —— 授权同步失败要回滚，
  // 不得「扣了钱却不留权」。缓存失效（`invalidatePolicyCache`）放在**提交之后**。
  const result = await db.$transaction(async (tx) => {
    // ① 扣余额（条件更新，防并发超扣）
    const debited = await tx.user.updateMany({
      where: { id: user.id, balance: { gte: total } },
      data: { balance: { decrement: total } },
    });
    if (debited.count !== 1) throw new HTTPException(400, { message: "余额不足，请先充值" });

    const afterUser = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { balance: true } });

    await tx.balanceLog.create({
      data: { user_id: user.id, balance: afterUser.balance, amount: -total, type: "plan" },
    });

    // ② 库存递减
    if (plan.stock !== null) {
      await tx.plan.update({ where: { id: plan.id }, data: { stock: { decrement: 1 } } });
    }

    // ③ 订单（`workspace_id` 表达「这笔钱买给哪个租户」，R5：历史行 NULL 不猜）
    const order = await tx.planOrder.create({
      data: {
        user_id: user.id,
        workspace_id: workspace.id,
        plan_id: plan.id,
        price: total,
        balance: afterUser.balance,
        coupon_id: couponId,
      },
    });

    // ④ 订阅 + 发放：唯一实现见 services/subscription-purchase.ts（续期执行器用的是同一段）
    const purchase = await applyPlanPurchase(tx, {
      now: new Date(),
      workspace_id: workspace.id,
      payer_user_id: user.id,
      plan: {
        id: plan.id,
        name: plan.name,
        billing_cycle: plan.billing_cycle,
        price: plan.price,
        policy_id: plan.policy_id,
        traffic_bytes: planTrafficBytes(plan.traffic),
        max_tunnels: plan.max_tunnels,
      },
      order_id: order.id,
    });

    return { order, purchase, balance: afterUser.balance };
  });

  // 事实已提交 ⇒ 现在才失效缓存（若在事务内失效，别人可能读到尚未提交的旧发放）。
  invalidatePolicyCache(workspace.id);

  return c.json({
    data: {
      ok: true,
      order_id: result.order.id,
      plan_id: plan.id,
      price: total,
      balance: result.balance,
      subscription: {
        id: result.purchase.subscription_id,
        started_at: result.purchase.started_at,
        expires_at: result.purchase.expires_at,
        renewed_same_plan: result.purchase.renewed_same_plan,
      },
      // 可观测：套餐没绑策略时购买照常但不发放（原因码随响应返回，前端/运营能看见）。
      grant: {
        granted: result.purchase.grant.granted,
        policy_id: result.purchase.grant.policy_id,
        reason: result.purchase.grant.reason ?? null,
        replaced: result.purchase.grant.revoked,
      },
      user_plan: result.purchase.legacy_user_plan,
    },
  });
});
