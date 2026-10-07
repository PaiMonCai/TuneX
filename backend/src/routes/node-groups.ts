/**
 * 节点组路由（用户侧）。
 *
 * 端点（挂载于 /api/node-groups）：
 *   GET  /              可用节点组列表（含 node_count / online_node_count 统计）
 *   POST /              自建节点组（`node:manage` + entitlement，token 只回显一次）
 *   POST /:id/nodes     在自有节点组内 provision 一个 Agent 身份，返回一次性 enrollment
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
 *
 * 稳定的拒绝码（web 侧可按 `code` 分支）：
 *   custom_group_not_allowed (403)           当前策略未授予自建该类节点组的能力
 *   node_limit (403)                         节点额度耗尽
 *   PORT_RANGE_REQUIRED (409)                节点组没有可用的连续端口范围，无法 provision
 *   runtime_edit_requires_impact_check (409) 重装不得顺带改运行配置
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

  // Online count uses the node status projection consumed by the current UI.
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
  try {
    const reserved = await withWorkspaceQuotaLock(workspace.id, async (tx, policy) => {
      const existing = await tx.node.findUnique({
        where: { node_id: parsed.data.node_id },
        select: { id: true, node_group_id: true, role: true },
      });
      if (existing && existing.node_group_id !== group.id) {
        return { groupConflict: true } as const;
      }
      if (existing?.role && parsed.data.role !== undefined && existing.role !== parsed.data.role) {
        return { roleConflict: existing.role } as const;
      }
      if (existing && (parsed.data.targets?.length ?? 0) > 0) {
        return { runtimeEdit: true } as const;
      }

      const nodeCount = await tx.node.count({
        where: { node_group: { workspace_id: workspace.id } },
      });
      if (!existing) {
        // 顺序是有意的（E2 复核 F3）：**能力/额度判定在端口区间之前**。
        //
        // 反例：一个没有任何生效策略的空间（真因是"策略未授予"，下一步是找管理员）
        // 里，给一个没有区间的节点组加节点。先判区间会拿到 409 PORT_RANGE_REQUIRED，
        // 而旧文案让用户"新建带端口范围的节点组" —— 那个空间 `POST /api/node-groups`
        // 只会 403 `custom_group_not_allowed`，是一条死路。能力拒绝是**改不了的事实**，
        // 区间未配置是**可修复的状态**，所以前者优先。
        const decision = checkNodeCreation(policy, nodeCount);
        if (!decision.allowed) return { denied: decision } as const;
        if (portMin === null || portMax === null || portMin < 1 || portMax > 65535 || portMin > portMax) {
          // 区间确实要修，但"去自建一个带区间的组"只在这个空间**真的能自建**时才成立
          // （自建能力由 entitlements 决定，与节点额度是两件事）。不能自建时不能提这条
          // 建议，否则又是一条死路。码保持 PORT_RANGE_REQUIRED，响应形状保持扁平两键。
          const canSelfServeGroup =
            group.node_type === "in"
              ? policy.entitlements?.allow_custom_in_group === true
              : policy.entitlements?.allow_custom_out_group === true;
          return {
            rangeConflict: canSelfServeGroup
              ? "节点组未配置端口范围，无法添加节点；请新建带端口范围的节点组，或联系管理员为该节点组配置端口范围"
              : "节点组未配置端口范围，无法添加节点；当前策略也不允许你自建节点组，请联系管理员为该节点组配置端口范围",
          } as const;
        }
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
        // Reinstall is identity/enrollment only, never an unguarded runtime
        // edit. Preserve role/range/address/lb; the dedicated impact-checked
        // APIs are the sole mutation surface for an existing node.
        ? await tx.node.findUniqueOrThrow({ where: { id: existing.id }, select })
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
    if ("runtimeEdit" in reserved) {
      return c.json({ error: "重装不会修改现有运行配置，请使用出口池管理接口", code: "runtime_edit_requires_impact_check", error_layer: "runtime_admission" }, 409);
    }
    // 节点组没有可用的连续端口范围时不能 provision：`node.port_range_min/max` 是
    // per-node 端口所有权域，未配置必须拒绝，既不回落到节点组以外的区间，也不猜一个。
    // 这是**调用方可修复的状态冲突**（改节点组），不是服务器故障 —— 因此给出与
    // web mock 同一个 409 + `PORT_RANGE_REQUIRED`，而不是落到兜底 500。
    // 文案按"这个空间能不能自建组"分叉：不能自建时不给死路建议（见锁内的顺序注释）。
    if ("rangeConflict" in reserved) {
      return c.json({
        error: reserved.rangeConflict,
        code: "PORT_RANGE_REQUIRED",
      }, 409);
    }
    const denied = "denied" in reserved ? reserved.denied : null;
    if (denied) {
      return c.json({
        error: denied.message ?? "节点额度不足",
        code: denied.reason,
      }, 403);
    }

    if (!("node" in reserved) || !reserved.node) {
      // 锁内已知的每种拒绝状态都在上面各自返回 4xx；走到这里说明状态集合与分支
      // 再次分叉（例如新增了未处理的返回形状），是服务端不变量问题而非用户输入。
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
