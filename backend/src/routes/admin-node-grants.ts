/** Platform RBAC grants shared node groups to users without plans or payments. */
import { Hono } from "hono";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { enqueueRefresh, refreshNodeGroups } from "../socket/config-refresh.ts";

export const nodeGrantRoutes = new Hono<{ Variables: AppVariables }>();

function numericId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

nodeGrantRoutes.get("/node/group/:id/grants", async (c) => {
  const groupId = numericId(c.req.param("id"));
  if (!groupId) return c.json({ error: "非法节点组 ID" }, 400);
  const group = await db.nodeGroup.findUnique({ where: { id: groupId }, select: { id: true } });
  if (!group) return c.json({ error: "节点组不存在" }, 404);
  const grants = await db.nodeGroupGrant.findMany({
    where: { node_group_id: groupId },
    orderBy: { id: "asc" },
    include: { user: { select: { id: true, email: true, status: true } } },
  });
  return c.json({ data: grants });
});

nodeGrantRoutes.post("/node/group/:id/grants", async (c) => {
  const groupId = numericId(c.req.param("id"));
  if (!groupId) return c.json({ error: "非法节点组 ID" }, 400);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const userId = numericId(String(body?.user_id ?? ""));
  if (!userId || (body?.direction !== "in" && body?.direction !== "out")) {
    return c.json({ error: "需要有效用户 ID 和 in/out 方向" }, 400);
  }
  const direction = body.direction;
  const [group, user] = await Promise.all([
    db.nodeGroup.findUnique({ where: { id: groupId }, select: { id: true, node_type: true, user_id: true } }),
    db.user.findUnique({ where: { id: userId }, select: { id: true, status: true } }),
  ]);
  if (!group || !user) return c.json({ error: "节点组或用户不存在" }, 404);
  if (group.node_type !== direction || user.status !== "active" || group.user_id === user.id) {
    return c.json({ error: "方向不符、用户停用或已经拥有该节点组" }, 400);
  }
  const grant = await db.nodeGroupGrant.upsert({
    where: { user_id_node_group_id_direction: { user_id: userId, node_group_id: groupId, direction } },
    create: { user_id: userId, node_group_id: groupId, direction, active: true },
    update: { active: true },
  });
  enqueueRefresh(refreshNodeGroups([groupId]));
  return c.json({ data: grant });
});

nodeGrantRoutes.delete("/node/group/:id/grants/:userId/:direction", async (c) => {
  const groupId = numericId(c.req.param("id"));
  const userId = numericId(c.req.param("userId"));
  const direction = c.req.param("direction");
  if (!groupId || !userId || (direction !== "in" && direction !== "out")) {
    return c.json({ error: "非法节点组授权参数" }, 400);
  }
  const revoked = await db.nodeGroupGrant.updateMany({
    where: { user_id: userId, node_group_id: groupId, direction, active: true },
    data: { active: false },
  });
  if (!revoked.count) return c.json({ error: "有效授权不存在" }, 404);
  enqueueRefresh(refreshNodeGroups([groupId]));
  return c.json({ data: { ok: true } });
});
