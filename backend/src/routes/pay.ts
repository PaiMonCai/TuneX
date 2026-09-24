/**
 * 支付路由 —— 用户侧下单 + 网关异步回调
 * 依据: pay-channel-analysis-report.md §6-§7（源码级还原 rurets/pay.ts + routes/topup.ts）
 *
 * 端点：
 *   GET  /api/pay                      支付方式列表（仅非敏感字段，需认证）
 *   POST /api/pay/create               创建充值订单（需认证）
 *   POST /api/pay/:id/cancel           用户取消订单（需认证）
 *   GET  /api/pay/:id/callback         网关异步回调（免认证）
 *   POST /api/pay/:id/callback         网关异步回调（免认证）
 *
 * 挂载方式（由 app.ts 的收尾子代理执行，本模块不修改 app.ts）：
 *   import { payRoutes } from "./routes/pay.ts";
 *   app.route("/api/pay", payRoutes);
 *
 * 免认证依赖 Whitelist regex `/^\/api\/pay\/[^/]+\/callback$/`（已存在）。
 *
 * 框架依赖：仅 Hono 的**类型与异常**（HTTPException）+ zod 入参校验。
 * 业务逻辑全部在 services/payment/**，路由层只做适配。
 */
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { db } from "../db.ts";
import { env } from "../env.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import {
  AmountMismatchError,
  PaymentError,
  SignatureError,
  TradeStatusError,
} from "../services/payment/errors.ts";
import { topupOrderService, type CallbackOutcome } from "../services/payment/order.ts";
import { buildNotifyUrl } from "../services/payment/index.ts";

export const payRoutes = new Hono<{ Variables: AppVariables }>();

/* ------------------------------------------------------------------ */
/* 工具                                                               */
/* ------------------------------------------------------------------ */

/** PaymentError → HTTPException（保留结构化 code，供前端/运维区分） */
function toHttpException(e: unknown): never {
  if (e instanceof PaymentError) {
    throw new HTTPException(e.httpStatus as 400 | 401 | 403 | 404 | 409 | 500 | 502, {
      message: e.message,
      cause: e,
    });
  }
  throw e;
}

const CreateTopupSchema = z.object({
  price: z.coerce.number().positive(),
  redirect_url: z.string().url(),
  payment_id: z.coerce.number().int().positive(),
});

/** 解析回调载荷：GET → query；POST → JSON 优先，回落 form-urlencoded */
export async function parseCallbackPayload(c: {
  req: {
    method: string;
    query: () => Record<string, string>;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    header: (k: string) => string | undefined;
  };
}): Promise<Record<string, unknown>> {
  if (c.req.method.toUpperCase() === "GET") {
    return { ...c.req.query() } as Record<string, unknown>;
  }

  const contentType = (c.req.header("content-type") ?? "").toLowerCase();

  if (contentType.includes("application/json")) {
    const body = await c.req.json().catch(() => null);
    if (body && typeof body === "object") return body as Record<string, unknown>;
  }

  // 表单 / 未知类型：先按 form 解析，失败再试 JSON
  const raw = await c.req.text().catch(() => "");
  if (raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        /* fallthrough to form parse */
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    if (Object.keys(out).length > 0) return out;
  }

  // 兜底：query string（部分网关把参数同时放 query）
  return { ...c.req.query() } as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* GET / —— 支付方式列表                                              */
/* ------------------------------------------------------------------ */

payRoutes.get("/", async (c) => {
  if (!env.paymentsEnabled) return c.json({ data: [] });
  // 与原版一致：**不返回 url / config**（含 api_key / pid / merchant_uuid 等敏感配置）
  const payments = await db.payment.findMany({
    where: { status: "active" },
    orderBy: [{ order_by: "desc" }, { id: "desc" }],
    select: {
      id: true,
      name: true,
      method: true,
      type: true,
      fixed_fee: true,
      percent_fee: true,
    },
  });
  return c.json({ data: payments });
});

/* ------------------------------------------------------------------ */
/* POST /create —— 创建充值订单                                        */
/* ------------------------------------------------------------------ */

payRoutes.post("/create", async (c) => {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });

  const body = await c.req.json().catch(() => null);
  const parsed = CreateTopupSchema.safeParse(body);
  if (!parsed.success) {
    throw new HTTPException(400, { message: "参数错误: price / redirect_url / payment_id" });
  }
  const { price, redirect_url, payment_id } = parsed.data;

  try {
    const order = await topupOrderService.createTopupOrder({
      user_id: user.id,
      price,
      payment_id,
      redirect_url,
      client_ip: c.get("ip") ?? "",
    });
    return c.json({ data: { pay_url: order.pay_url, order_id: order.order_id, id: order.id } });
  } catch (e) {
    toHttpException(e);
  }
});

/* ------------------------------------------------------------------ */
/* POST /:id/cancel —— 用户取消订单                                    */
/* ------------------------------------------------------------------ */

payRoutes.post("/:id/cancel", async (c) => {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) throw new HTTPException(400, { message: "非法的订单 ID" });

  try {
    await topupOrderService.cancelByUser(id, user.id);
    return c.body(null, 204);
  } catch (e) {
    toHttpException(e);
  }
});

/* ------------------------------------------------------------------ */
/* GET|POST /:id/callback —— 网关异步回调（免认证）                    */
/* ------------------------------------------------------------------ */

async function handleCallback(c: {
  req: {
    method: string;
    query: () => Record<string, string>;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
    header: (k: string) => string | undefined;
    param: (k: string) => string;
  };
  text: (s: string, status?: number) => Response;
}) {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.text("invalid payment id", 400);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await parseCallbackPayload(c as never);
  } catch {
    return c.text("bad request", 400);
  }

  let outcome: CallbackOutcome;
  try {
    outcome = await topupOrderService.handleCallback(id, payload);
  } catch (e) {
    // 验签失败 / 状态非成功 / 金额不一致 → 明确 4xx，且**不做任何 DB 写**
    if (e instanceof SignatureError || e instanceof TradeStatusError) {
      console.warn(`[pay] callback rejected (${(e as PaymentError).code}) payment=${id}`);
      return c.text((e as PaymentError).code, 400);
    }
    if (e instanceof AmountMismatchError) {
      console.error(
        `[pay] AMOUNT MISMATCH payment=${id} order=${e.orderId} expected=${e.expected} actual=${e.actual}`,
      );
      return c.text("amount mismatch", 400);
    }
    if (e instanceof PaymentError) {
      console.warn(`[pay] callback error (${e.code}): ${e.message}`);
      return c.text(e.code, e.httpStatus as 400);
    }
    console.error("[pay] callback unhandled error:", e);
    return c.text("error", 500);
  }

  // 返回网关约定的成功文本（EPay: success / BEPUSDT|Heleket: ok）
  return c.text(outcome.response, 200);
}

payRoutes.get("/:id/callback", (c) => handleCallback(c as never));
payRoutes.post("/:id/callback", (c) => handleCallback(c as never));

/* ------------------------------------------------------------------ */
/* 便捷导出：供 app.ts / 测试使用                                      */
/* ------------------------------------------------------------------ */

export { buildNotifyUrl };
export const payRouteHandlers = { handleCallback, parseCallbackPayload };
