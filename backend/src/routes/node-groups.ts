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
 * 可见范围：仅自有或显式授权节点组；不通过套餐隐式授权。
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../db.ts";
import { resolveWorkspaceAccess } from "../services/workspace.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { withWorkspaceQuotaLock } from "../services/policy-service.ts";
import { checkNodeCreation } from "../services/capability-policy.ts";
import { createNodeEnrollment } from "../services/node-enrollment.ts";

export const nodeGroupsRoutes = new Hono<{ Variables: AppVariables }>();

nodeGroupsRoutes.use("*", async (c, next) => {
  // TEAM-01：resource="node" 让自建节点组的 manage 动作落到 node:manage 权限上，
  // 否则自定义角色无法被授予「管理节点但不碰隧道」这类组合。
  c.set("workspace", await resolveWorkspaceAccess(c, c.req.method === "POST" ? "manage" : "read", "node"));
  await next();
});

type Ctx = Context<{ Variables: AppVariables }>;

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

nodeGroupsRoutes.get("/", async (c) => {
  const user = requireUser(c);
  const workspace = c.get("workspace")!;

  const q = c.req.query();
  const page = Math.max(1, Number(q.page ?? 1) || 1);
  const page_size = Math.min(200, Math.max(1, Number(q.page_size ?? 20) || 20));
  const keyword = String(q.keyword ?? "").trim();
  const where = {
    OR: [
      { workspace_id: workspace.id },
      ...(workspace.id === workspace.personalWorkspaceId
        ? [{ grants: { some: { user_id: user.id, active: true } } }]
        : []),
    ],
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

  // A shared group grant allows tunnel use, not possession of its Agent registration token.
  const data = rows.map(({ _count, token: _token, ...g }) => ({
    ...g,
    node_count: _count.nodes,
    online_node_count: onlineMap.get(g.id) ?? 0,
  }));

  return c.json({ data: { data, total, page, page_size } });
});

const CreateNodeGroup = z.object({
  name: z.string().trim().min(1).max(60),
  node_type: z.enum(["in", "out"]),
  port_range: z.string().regex(/^\d{1,5}-\d{1,5}$/).optional(),
});

/** Team owners/admins can deploy their own groups; the Agent token is shown only once. */
nodeGroupsRoutes.post("/", async (c) => {
  const user = requireUser(c);
  const workspace = c.get("workspace")!;
  const parsed = CreateNodeGroup.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "节点组名称、方向或端口范围不合法" }, 400);
  const { name, node_type, port_range } = parsed.data;
  if (port_range) {
    const [start, end] = port_range.split("-").map(Number);
    if (start < 1 || end > 65535 || start > end) return c.json({ error: "端口范围不合法" }, 400);
  }
  // SOFT-01：自建入口/出口组是一种能力（entitlement），按 workspace 行锁串行判定，
  // 策略未授予 allow_custom_*_group 时拒绝（不是超限提示，是能力未开通）。
  const group = await withWorkspaceQuotaLock(workspace.id, async (tx, policy) => {
    const customAllowed = node_type === "in" ? policy.entitlements.allow_custom_in_group : policy.entitlements.allow_custom_out_group;
    if (!customAllowed) {
      return { denied: true } as const;
    }
    const created = await tx.nodeGroup.create({
      data: { name, node_type, port_range, workspace_id: workspace.id, user_id: user.id },
      select: { id: true, name: true, node_type: true, token: true, workspace_id: true },
    });
    await tx.auditEvent.create({
      data: { workspace_id: workspace.id, actor_user_id: user.id, action: "node_group.created", resource_type: "node_group", resource_id: String(created.id) },
    });
    return { group: created } as const;
  });

  if ("group" in group) return c.json({ data: group.group }, 201);
  return c.json({ error: `当前策略不允许自建${node_type === "in" ? "入口" : "出口"}节点组`, code: "custom_group_not_allowed" }, 403);
});


const ProvisionNode = z.object({
  node_id: z.string().trim().min(1).max(255),
  connect_ip: z.string().trim().min(1).max(255).nullable().optional(),
  role: z.enum(["ingress", "egress", "both"]).optional(),
  targets: z.array(z.object({
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    weight: z.number().int().min(1).max(100).optional(),
  })).max(64).optional(),
});

/**
 * Provision one concrete Agent identity inside an owned workspace NodeGroup.
 *
 * Returns a short-lived one-time enrollment + install command. The real
 * per-node credential is minted only when the node consumes that enrollment.
 */
nodeGroupsRoutes.post("/:id/nodes", async (c) => {
  const user = requireUser(c);
  const workspace = c.get("workspace")!;
  const groupId = Number(c.req.param("id"));
  if (!Number.isInteger(groupId) || groupId <= 0) {
    return c.json({ error: "节点组 ID 不合法" }, 400);
  }

  const parsed = ProvisionNode.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "node_id / connect_ip / role 不合法" }, 400);
  }

  const group = await db.nodeGroup.findFirst({
    where: { id: groupId, workspace_id: workspace.id },
    select: { id: true, node_type: true, port_range: true },
  });
  if (!group) return c.json({ error: "节点组不存在" }, 404);

  const role = parsed.data.role ?? (group.node_type === "in" ? "ingress" : "egress");
  const range = group.port_range?.split("-").map(Number) ?? [];
  const portMin = range.length === 2 && Number.isInteger(range[0]) ? range[0]! : null;
  const portMax = range.length === 2 && Number.isInteger(range[1]) ? range[1]! : null;
  if (portMin === null || portMax === null || portMin < 1 || portMax > 65535 || portMin > portMax) {
    return c.json({ error: "节点组未配置可用于 v3 的连续端口范围" }, 409);
  }

  try {
    const reserved = await withWorkspaceQuotaLock(workspace.id, async (tx, policy) => {
      const existing = await tx.node.findUnique({
        where: { node_id: parsed.data.node_id },
        select: { id: true, node_group_id: true, role: true },
      });
      if (existing && existing.node_group_id !== group.id) {
        return { groupConflict: true } as const;
      }
      if (existing?.role && existing.role !== role) {
        return { roleConflict: existing.role } as const;
      }

      const nodeCount = await tx.node.count({
        where: { node_group: { workspace_id: workspace.id } },
      });
      if (!existing) {
        const decision = checkNodeCreation(policy, nodeCount);
        if (!decision.allowed) return { denied: decision } as const;
      }

      const select = {
        id: true,
        node_id: true,
        agent_id: true,
        connect_ip: true,
        node_group_id: true,
        role: true,
        port_range_min: true,
        port_range_max: true,
      } as const;
      const node = existing
        ? await tx.node.update({
            where: { id: existing.id },
            data: {
              ...(parsed.data.connect_ip !== undefined ? { connect_ip: parsed.data.connect_ip } : {}),
              role,
              port_range_min: portMin,
              port_range_max: portMax,
              lb_strategy: "round",
            },
            select,
          })
        : await tx.node.create({
            data: {
              node_id: parsed.data.node_id,
              connect_ip: parsed.data.connect_ip ?? null,
              node_group_id: group.id,
              role,
              port_range_min: portMin,
              port_range_max: portMax,
              lb_strategy: "round",
              order_by: nodeCount * 1000,
            },
            select,
          });

      if ((role === "egress" || role === "both") && (parsed.data.targets?.length ?? 0) > 0) {
        const targets = parsed.data.targets ?? [];
        const pool = await tx.egressPool.upsert({
          where: { node_id_name: { node_id: node.id, name: "default" } },
          update: { lb_strategy: "round", status: "active" },
          create: {
            node_id: node.id,
            name: "default",
            lb_strategy: "round",
            status: "active",
          },
          select: { id: true },
        });
        await tx.egressTarget.deleteMany({ where: { pool_id: pool.id } });
        await tx.egressTarget.createMany({
          data: targets.map((target, index) => ({
            pool_id: pool.id,
            host: target.host,
            port: target.port,
            weight: target.weight ?? 1,
            order_by: (index + 1) * 1000,
            status: "active",
          })),
        });
      }

      await tx.auditEvent.create({
        data: {
          workspace_id: workspace.id,
          actor_user_id: user.id,
          action: existing ? "node.reprovisioned" : "node.provisioned",
          resource_type: "node",
          resource_id: String(node.id),
        },
      });
      return { node } as const;
    });

    if ("groupConflict" in reserved && reserved.groupConflict) {
      return c.json({ error: "node_id 已被其它节点组占用" }, 409);
    }
    if ("roleConflict" in reserved && reserved.roleConflict) {
      return c.json({ error: `已存在节点角色为 ${reserved.roleConflict}，请先显式修改角色` }, 409);
    }
    const denied = "denied" in reserved ? reserved.denied : null;
    if (denied) {
      return c.json({
        error: denied.message ?? "节点额度不足",
        code: denied.reason,
      }, 403);
    }

    if (!("node" in reserved) || !reserved.node) {
      return c.json({ error: "创建节点失败" }, 500);
    }
    const enrollment = await createNodeEnrollment(reserved.node.id);
    return c.json({
      data: {
        node: reserved.node,
        enrollment,
      },
    }, 201);
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      return c.json({ error: "node_id 已存在" }, 409);
    }
    throw e;
  }
});
