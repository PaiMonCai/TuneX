/**
 * 工单路由（用户侧）—— 前端 api.tickets.*
 *
 * 端点（挂载于 /api/tickets）：
 *   GET    /            工单列表（仅本人；分页/关键字/状态过滤）
 *   POST   /            创建工单 { title, content }
 *   GET    /:id         工单详情（含 replies）
 *   PATCH  /:id         更新工单（标题 / 状态）
 *   DELETE /:id         删除工单
 *   POST   /:id/replies 追加回复
 *
 * 挂载方式（由 app.ts 的收尾子代理执行，本模块不修改 app.ts）：
 *   import { ticketsRoutes } from "./routes/tickets.ts";
 *   app.route("/api/tickets", ticketsRoutes);
 *
 * 响应封装：前端 request() 剥掉 **一层** 顶层 data —— 列表返回
 *   { data: { data: rows, total, page, page_size } }，单对象返回 { data: obj }。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const ticketsRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

function publicTicket(t: Record<string, unknown>) {
  return t;
}

/* ------------------------------------------------------------------ */
/* GET / —— 列表                                                       */
/* ------------------------------------------------------------------ */

ticketsRoutes.get("/", async (c) => {
  const user = requireUser(c);
  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const page_size = Math.min(200, Math.max(1, Number(q.page_size ?? 20) || 20));
  const keyword = String(q.keyword ?? "").trim();
  const status = q.status && q.status !== "all" ? String(q.status) : undefined;

  const where = {
    user_id: user.id,
    ...(status ? { status: status as "open" | "closed" } : {}),
    ...(keyword ? { title: { contains: keyword } } : {}),
  };

  const [rows, total] = await Promise.all([
    db.ticket.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * page_size,
      take: page_size,
      include: { replies: { orderBy: { id: "asc" } } },
    }),
    db.ticket.count({ where }),
  ]);

  return c.json({ data: { data: rows, total, page, page_size } });
});

/* ------------------------------------------------------------------ */
/* POST / —— 创建                                                      */
/* ------------------------------------------------------------------ */

ticketsRoutes.post("/", async (c) => {
  const user = requireUser(c);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "参数错误" }, 400);

  const title = String(body.title ?? "").trim();
  const content = String(body.content ?? "").trim();
  if (!title) return c.json({ error: "工单标题不能为空" }, 400);
  if (title.length > 100) return c.json({ error: "工单标题长度不能超过 100 字符" }, 400);
  if (!content) return c.json({ error: "工单内容不能为空" }, 400);
  if (content.length > 5000) return c.json({ error: "工单内容长度不能超过 5000 字符" }, 400);

  const ticket = await db.ticket.create({
    data: { title, content, status: "open", user_id: user.id },
    include: { replies: true },
  });
  return c.json({ data: publicTicket(ticket as unknown as Record<string, unknown>) }, 201);
});

/* ------------------------------------------------------------------ */
/* GET /:id —— 详情                                                    */
/* ------------------------------------------------------------------ */

ticketsRoutes.get("/:id", async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的工单 ID" }, 400);

  const ticket = await db.ticket.findFirst({
    where: { id, user_id: user.id },
    include: { replies: { orderBy: { id: "asc" } }, user: { select: { id: true, email: true } } },
  });
  if (!ticket) return c.json({ error: "工单不存在" }, 404);
  return c.json({ data: publicTicket(ticket as unknown as Record<string, unknown>) });
});

/* ------------------------------------------------------------------ */
/* PATCH /:id —— 更新                                                  */
/* ------------------------------------------------------------------ */

ticketsRoutes.patch("/:id", async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的工单 ID" }, 400);

  const ticket = await db.ticket.findFirst({ where: { id, user_id: user.id } });
  if (!ticket) return c.json({ error: "工单不存在" }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return c.json({ error: "参数错误" }, 400);

  const data: Record<string, unknown> = {};
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return c.json({ error: "工单标题不能为空" }, 400);
    if (title.length > 100) return c.json({ error: "工单标题长度不能超过 100 字符" }, 400);
    data.title = title;
  }
  if (body.status !== undefined) {
    const s = String(body.status);
    if (s !== "open" && s !== "closed") return c.json({ error: "工单状态不合法" }, 400);
    data.status = s;
  }

  const updated = await db.ticket.update({
    where: { id: ticket.id },
    data,
    include: { replies: { orderBy: { id: "asc" } } },
  });
  return c.json({ data: publicTicket(updated as unknown as Record<string, unknown>) });
});

/* ------------------------------------------------------------------ */
/* DELETE /:id —— 删除                                                 */
/* ------------------------------------------------------------------ */

ticketsRoutes.delete("/:id", async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的工单 ID" }, 400);

  const ticket = await db.ticket.findFirst({ where: { id, user_id: user.id } });
  if (!ticket) return c.json({ error: "工单不存在" }, 404);

  await db.$transaction([
    db.ticketReply.deleteMany({ where: { ticket_id: ticket.id } }),
    db.ticket.delete({ where: { id: ticket.id } }),
  ]);
  return c.json({ data: { ok: true, id: ticket.id } });
});

/* ------------------------------------------------------------------ */
/* POST /:id/replies —— 追加回复                                       */
/* ------------------------------------------------------------------ */

ticketsRoutes.post("/:id/replies", async (c) => {
  const user = requireUser(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "非法的工单 ID" }, 400);

  const ticket = await db.ticket.findFirst({ where: { id, user_id: user.id } });
  if (!ticket) return c.json({ error: "工单不存在" }, 404);
  if (ticket.status === "closed") return c.json({ error: "工单已关闭，无法回复" }, 400);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const content = String(body?.content ?? "").trim();
  if (!content) return c.json({ error: "回复内容不能为空" }, 400);
  if (content.length > 5000) return c.json({ error: "回复内容长度不能超过 5000 字符" }, 400);

  const reply = await db.$transaction(async (tx) => {
    const created = await tx.ticketReply.create({
      data: {
        content,
        // 用户侧回复恒为非管理员；管理员走 /api/admin/ticket/* 另设 is_admin
        is_admin: false,
        ticket_id: ticket.id,
        user_id: user.id,
      },
    });
    await tx.ticket.update({ where: { id: ticket.id }, data: { updated_at: new Date() } });
    return created;
  });

  return c.json({ data: reply }, 201);
});
