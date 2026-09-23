/**
 * 节点组路由（用户侧，只读）—— 前端 api.nodeGroups.*
 *
 * 端点（挂载于 /api/node-groups）：
 *   GET /          可用节点组列表（含 node_count / online_node_count 统计）
 *
 * 挂载方式（由 app.ts 的收尾子代理执行，本模块不修改 app.ts）：
 *   import { nodeGroupsRoutes } from "./routes/node-groups.ts";
 *   app.route("/api/node-groups", nodeGroupsRoutes);
 *
 * 响应封装：前端 request() 剥掉 **一层** data，故列表返回
 *   { data: { data: rows, total, page, page_size } }
 * 前端拿到即为 Paginated<NodeGroup>（用于创建隧道时的入口/出口节点组下拉）。
 *
 * 可见范围：与原版/前端 mock 一致，返回全部 active 节点组（节点组属基础设施，
 * 非用户私有数据）；运营如需按套餐限制可见性，可在此叠加 plan 过滤。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const nodeGroupsRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

nodeGroupsRoutes.get("/", async (c) => {
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
    db.nodeGroup.findMany({
      where,
      orderBy: [{ order_by: "asc" }, { id: "asc" }],
      skip: (page - 1) * page_size,
      take: page_size,
      include: { _count: { select: { nodes: true } } },
    }),
    db.nodeGroup.count({ where }),
  ]);

  // 在线节点数：节点 status=active 即视为在线（与 mock / 前端口径一致）
  const groupIds = rows.map((g) => g.id);
  const onlineCounts = await db.node.groupBy({
    by: ["node_group_id"],
    where: { node_group_id: { in: groupIds }, status: "active" },
    _count: { _all: true },
  });
  const onlineMap = new Map(onlineCounts.map((r) => [r.node_group_id, r._count._all]));

  const data = rows.map(({ _count, ...g }) => ({
    ...g,
    node_count: _count.nodes,
    online_node_count: onlineMap.get(g.id) ?? 0,
  }));

  return c.json({ data: { data, total, page, page_size } });
});
