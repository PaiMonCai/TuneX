/**
 * 管理端路由
 * 全部挂载在 /api/admin/* 之下，由 app.ts 统一施加
 *   adminRequired → adminPermissionGuard
 * 具体资源路径需与 permissions.ts 的 apiPrefixes 对齐，否则 fail-closed 403。
 */
import { Hono } from "hono";
import { db } from "../db.ts";
import { systemConfig } from "../services/config.ts";
import { licenseService } from "../services/license.ts";
import {
  ADMIN_RESOURCES,
  sanitizePermissions,
  getEffectiveAccess,
} from "../permissions.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const adminRoutes = new Hono<{ Variables: AppVariables }>();

/* ------------------------------------------------------------------ *
 * dashboard — /api/admin/stats*  → key: dashboard
 * ------------------------------------------------------------------ */
adminRoutes.get("/stats", async (c) => {
  const [users, tunnels, nodes, plans, orders, onlineNodes] = await Promise.all([
    db.user.count(),
    db.tunnel.count(),
    db.node.count(),
    db.plan.count(),
    db.planOrder.count(),
    db.node.count({ where: { status: "active" } }),
  ]);
  return c.json({
    data: {
      user_count: users,
      tunnel_count: tunnels,
      node_count: nodes,
      online_node_count: onlineNodes,
      plan_count: plans,
      order_count: orders,
      today_revenue: 0,
      today_traffic: 0,
      revenue_trend: [],
      tunnel_type_distribution: [],
    },
  });
});

adminRoutes.get("/plan/stats", async (c) =>
  c.json({ data: { plans: await db.plan.count(), user_plans: await db.userPlan.count() } }),
);

adminRoutes.get("/topup/stats", async (c) =>
  c.json({ data: { topups: await db.topupOrder.count() } }),
);

/* ------------------------------------------------------------------ *
 * users — /api/admin/user*  → key: users
 * ------------------------------------------------------------------ */
adminRoutes.get("/user", async (c) => {
  const page = Number(c.req.query("page") ?? 1);
  const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
  const [rows, total] = await Promise.all([
    db.user.findMany({
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { id: "desc" },
      include: { admin_roles: true },
    }),
    db.user.count(),
  ]);
  // api_key 脱敏（原版列表响应剔除 api_key）
  const data = rows.map(({ api_key, ...rest }) => rest);
  return c.json({ data, total, page, limit });
});

/* ------------------------------------------------------------------ *
 * node_groups — /api/admin/node/group* → key: node_groups
 * 注意 /api/admin/node/group/summary → $staff（共享前缀，任何 admin 可读）
 * ------------------------------------------------------------------ */
adminRoutes.get("/node/group/summary", async (c) =>
  c.json({ data: { total: await db.nodeGroup.count() } }),
);

adminRoutes.get("/node/group", async (c) => {
  const rows = await db.nodeGroup.findMany({ orderBy: { id: "desc" } });
  return c.json({ data: rows, total: rows.length });
});

/* ------------------------------------------------------------------ *
 * nodes — /api/admin/node* → key: nodes
 * ------------------------------------------------------------------ */
adminRoutes.get("/node", async (c) => {
  const rows = await db.node.findMany({ orderBy: { id: "desc" } });
  return c.json({ data: rows, total: rows.length });
});

/* ------------------------------------------------------------------ *
 * settings — /api/admin/system/config* → key: settings
 * ------------------------------------------------------------------ */
adminRoutes.get("/system/config", async (c) =>
  c.json({ data: await systemConfig.listAll() }),
);

adminRoutes.put("/system/config/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  if (typeof body?.value !== "string") return c.json({ error: "value 必须为字符串" }, 400);
  await systemConfig.setConfig(name, body.value);
  return c.json({ data: { name, value: body.value } });
});

/* ------------------------------------------------------------------ *
 * license — /api/admin/license* → key: license
 * ------------------------------------------------------------------ */
adminRoutes.get("/license", async (c) => {
  const license = await licenseService.getLicense();
  return c.json({ data: license ?? { type: "none" } });
});

/* ------------------------------------------------------------------ *
 * 权限元数据 —— 给前端渲染菜单/角色编辑器
 * 挂 /api/admin/meta/*；未在 ADMIN_ROUTE_TABLE 登记 → 非超管 403（fail-closed 合理）
 * ------------------------------------------------------------------ */
adminRoutes.get("/meta/resources", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const access = getEffectiveAccess(user);
  return c.json({
    data: {
      resources: ADMIN_RESOURCES.map((r) => ({
        ...r,
        granted: user?.super_admin ? "write" : (access.get(r.key) ?? null),
      })),
    },
  });
});

/* ------------------------------------------------------------------ *
 * 角色管理（$super）—— 仅超管。路径 /api/admin/role 命中 SUPER_ADMIN_KEY
 * ------------------------------------------------------------------ */
adminRoutes.get("/role", async (c) => {
  const rows = await db.adminRole.findMany({
    orderBy: { id: "desc" },
    include: { _count: { select: { users: true } } },
  });
  return c.json({ data: rows });
});

adminRoutes.post("/role", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim();
  if (!name) return c.json({ error: "名称不能为空" }, 400);
  const exist = await db.adminRole.findUnique({ where: { name } });
  if (exist) return c.json({ error: "角色名称已存在" }, 409);

  const role = await db.adminRole.create({
    data: {
      name,
      description: body?.description ?? null,
      permissions: sanitizePermissions(body?.permissions),
    },
  });
  return c.json({ data: role }, 201);
});

adminRoutes.put("/role/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const role = await db.adminRole.findUnique({ where: { id } });
  if (!role) return c.json({ error: "角色不存在" }, 404);

  const name = String(body?.name ?? role.name).trim();
  const duplicate = await db.adminRole.findFirst({ where: { name, NOT: { id } } });
  if (duplicate) return c.json({ error: "角色名称已存在" }, 409);

  const updated = await db.adminRole.update({
    where: { id },
    data: {
      name,
      description: body?.description ?? role.description,
      permissions: sanitizePermissions(body?.permissions ?? role.permissions),
    },
  });
  return c.json({ data: updated });
});

adminRoutes.delete("/role/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const count = await db.user.count({ where: { admin_roles: { some: { id } } } });
  if (count > 0) return c.json({ error: `该角色仍被 ${count} 个用户使用，请先解除分配` }, 409);
  await db.adminRole.delete({ where: { id } });
  return c.json({ data: { ok: true } });
});

/** 给用户分配角色（仅超管） */
adminRoutes.put("/user/:id/roles", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const roleIds: number[] = Array.isArray(body?.admin_role_ids) ? body.admin_role_ids : [];

  const target = await db.user.findUnique({ where: { id } });
  if (!target) return c.json({ error: "用户不存在" }, 404);

  const updated = await db.user.update({
    where: { id },
    data: { admin_roles: { set: roleIds.map((rid) => ({ id: Number(rid) })) } },
    include: { admin_roles: true },
  });
  return c.json({ data: { id: updated.id, admin_roles: updated.admin_roles } });
});
