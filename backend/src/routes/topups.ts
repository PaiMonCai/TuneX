/**
 * 充值路由（用户侧）—— 前端 api.topups.*
 *
 * 本文件导出两个 Hono 子应用（前端把二者都归在 api.topups 下）：
 *   topupsRoutes   → 挂载 app.route("/api/topups", topupsRoutes)
 *       GET  /             充值订单列表（仅本人；分页/关键字/状态过滤）
 *       GET  /:id          充值订单详情
 *       POST /             创建充值订单 { amount, payment_id } → TopupOrder
 *       POST /:id/cancel   用户取消订单
 *   paymentsRoutes → 挂载 app.route("/api/payments", paymentsRoutes)
 *       GET  /             可用支付方式 [{ id, name, method }]
 *
 * 挂载方式（由 app.ts 的收尾子代理执行，本模块不修改 app.ts）：
 *   import { topupsRoutes, paymentsRoutes } from "./routes/topups.ts";
 *   app.route("/api/topups", topupsRoutes);
 *   app.route("/api/payments", paymentsRoutes);
 *
 * 响应封装：前端 request() 剥掉 **一层** 顶层 data —— 列表返回
 *   { data: { data: rows, total, page, page_size } }，单对象返回 { data: obj }。
 *
 * 下单复用 services/payment/order.ts 的 TopupOrderService（含最低金额校验、
 * 单用户互斥锁、单笔 pending 限制、网关下单、10 分钟自动取消），
 * 路由层只做入参适配与错误 → HTTP 状态映射。
 *
 * 注意：POST /api/pay/create 是同一能力的另一入口（price + redirect_url），
 * 两者共用同一服务与 pending 限制，不会产生重复订单。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import { env } from "../env.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { PaymentError } from "../services/payment/errors.ts";
import { topupOrderService } from "../services/payment/order.ts";

export const topupsRoutes = new Hono<{ Variables: AppVariables }>();
export const paymentsRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

/** PaymentError → HTTPException（保留服务层给定的状态码） */
function toHttpException(e: unknown): never {
  if (e instanceof PaymentError) {
    throw new HTTPException(e.httpStatus as 400 | 401 | 403 | 404 | 409 | 500 | 502, { message: e.message });
  }
  throw e;
}

/* ------------------------------------------------------------------ */
/* GET /api/payments —— 可用支付方式                                    */
/* ------------------------------------------------------------------ */

paymentsRoutes.get("/", async (c) => {
  requireUser(c);
  const rows = await db.payment.findMany({
    where: { status: "active" },
    orderBy: [{ order_by: "desc" }, { id: "desc" }],
    // 与原版一致：不暴露 url / config（含商户密钥等敏感配置）
    select: { id: true, name: true, method: true },
  });
  return c.json({ data: rows });
});

/* ------------------------------------------------------------------ */
/* GET /api/topups —— 列表                                             */
/* ------------------------------------------------------------------ */

topupsRoutes.get("/", async (c) => {
  const user = requireUser(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const page_size = Math.min(200, Math.max(1, Number(q.page_size ?? 20) || 20));
  const keyword = String(q.keyword ?? "").trim();
  const status = q.status && q.status !== "all" ? String(q.status) : undefined;

  const where = {
    user_id: user.id,
    ...(status ? { status: status as "pending" | "success" | "cancelled" } : {}),
    ...(keyword ? { order_id: { contains: keyword } } : {}),
  };

  const [rows, total] = await Promise.all([
    db.topupOrder.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * page_size,
      take: page_size,
      include: { payment: { select: { id: true, name: true, method: true } } },
    }),
    db.topupOrder.count({ where }),
  ]);

  return c.json({ data: { data: rows, total, page, page_size } });
});

/* ------------------------------------------------------------------ */
/* GET /api/topups/:id —— 详情                                         */
/* ------------------------------------------------------------------ */

topupsRoutes.get("/:id", async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的订单 ID" }, 400);

  const order = await db.topupOrder.findFirst({
    where: { id, user_id: user.id },
    include: { payment: { select: { id: true, name: true, method: true } } },
  });
  if (!order) return c.json({ error: "充值订单不存在" }, 404);
  return c.json({ data: order });
});

/* ------------------------------------------------------------------ */
/* POST /api/topups —— 创建充值订单                                     */
/* ------------------------------------------------------------------ */

topupsRoutes.post("/", async (c) => {
  const user = requireUser(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "参数错误" }, 400);

  const amount = Number(body.amount ?? body.price);
  const paymentId = Number(body.payment_id);

  if (!Number.isFinite(amount)) return c.json({ error: "充值金额必须是数字" }, 400);
  if (!Number.isInteger(paymentId)) return c.json({ error: "请选择支付方式" }, 400);

  // 支付完成后跳回充值页（前端拿到 pay_url 后会新窗口打开）
  const redirectUrl = String(body.redirect_url ?? `${env.siteUrl.replace(/\/+$/, "")}/topup`);

  try {
    const created = await topupOrderService.createTopupOrder({
      user_id: user.id,
      price: amount,
      payment_id: paymentId,
      redirect_url: redirectUrl,
      client_ip: c.get("ip") ?? "",
    });

    // 前端期望拿到完整 TopupOrder（order_id / pay_url / bonus / status ...）
    const order = await db.topupOrder.findUniqueOrThrow({
      where: { id: created.id },
      include: { payment: { select: { id: true, name: true, method: true } } },
    });
    return c.json({ data: order }, 201);
  } catch (e) {
    toHttpException(e);
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/topups/:id/cancel —— 用户取消                             */
/* ------------------------------------------------------------------ */

topupsRoutes.post("/:id/cancel", async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的订单 ID" }, 400);

  try {
    await topupOrderService.cancelByUser(id, user.id);
    return c.json({ data: { ok: true } });
  } catch (e) {
    toHttpException(e);
  }
});
