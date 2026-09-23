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
 * 购买流程（对齐原版 + 前端 mock handler 语义）：
 *   ① 套餐存在且 active ② 库存校验 ③ 优惠码折算 ④ 余额校验
 *   ⑤ 事务内：扣余额 + BalanceLog + 订单 + UserPlan（同套餐续期 / 换套餐重置）
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const plansRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

/** 账单周期 → 天数（lifetime 用 100 年近似） */
const CYCLE_DAYS: Record<string, number> = {
  month: 30,
  quarter: 90,
  half_year: 180,
  year: 365,
  lifetime: 36500,
};

const GB = 1024 * 1024 * 1024;

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

  const days = CYCLE_DAYS[String(plan.billing_cycle)] ?? 30;
  const trafficBytes = plan.traffic === null ? null : plan.traffic * GB;

  // ---- 单事务：扣款 → 订单 → 订阅 ----
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

    // ③ 订单
    const order = await tx.planOrder.create({
      data: {
        user_id: user.id,
        plan_id: plan.id,
        price: total,
        balance: afterUser.balance,
        coupon_id: couponId,
      },
    });

    // ④ 订阅：同套餐续期，否则换新
    const existing = await tx.userPlan.findUnique({ where: { user_id: user.id } });
    let userPlan;
    if (existing && existing.plan_id === plan.id) {
      const base = Math.max(Date.now(), existing.expired_at ? existing.expired_at.getTime() : Date.now());
      userPlan = await tx.userPlan.update({
        where: { user_id: user.id },
        data: {
          expired_at: plan.billing_cycle === "lifetime" ? null : new Date(base + days * 86400000),
          traffic: trafficBytes,
          max_tunnels: plan.max_tunnels,
        },
      });
    } else if (existing) {
      userPlan = await tx.userPlan.update({
        where: { user_id: user.id },
        data: {
          plan_id: plan.id,
          expired_at: plan.billing_cycle === "lifetime" ? null : new Date(Date.now() + days * 86400000),
          traffic: trafficBytes,
          traffic_used: 0,
          max_tunnels: plan.max_tunnels,
        },
      });
    } else {
      userPlan = await tx.userPlan.create({
        data: {
          user_id: user.id,
          plan_id: plan.id,
          traffic: trafficBytes,
          traffic_used: 0,
          max_tunnels: plan.max_tunnels,
          expired_at: plan.billing_cycle === "lifetime" ? null : new Date(Date.now() + days * 86400000),
        },
      });
    }

    return { order, userPlan, balance: afterUser.balance };
  });

  return c.json({
    data: {
      ok: true,
      order_id: result.order.id,
      plan_id: plan.id,
      price: total,
      balance: result.balance,
      user_plan: result.userPlan,
    },
  });
});
