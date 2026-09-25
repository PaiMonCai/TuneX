/**
 * User-facing Node-first API.
 *
 * Product model:
 *   Ingress Node -> PortForward
 *     egress_node_id omitted => DIRECT
 *     egress_node_id present => RELAY, only through an explicit NodeBinding
 *
 * Tunnel remains the internal runtime/desired-state record. These routes project
 * it as a PortForward and never ask the user to choose a tunnel mode directly.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { resolveWorkspaceAccess } from "../services/workspace.ts";
import {
  countWorkspaceTunnels,
  sumWorkspaceTraffic,
  withWorkspaceQuotaLock,
} from "../services/policy-service.ts";
import { checkTunnelCreation } from "../services/capability-policy.ts";
import { createNodeEnrollment } from "../services/node-enrollment.ts";
import { getOrchestrator } from "../services/relay-wiring.ts";
import { reapplyDirectTunnel, reapplyRelayTunnel } from "../services/scheduler.ts";
import {
  runTunnelAction as runTunnelActionApi,
  TUNNEL_API_ERROR_STATUS,
  type TunnelAction,
} from "../services/tunnel-api.ts";

export const nodesRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

nodesRoutes.use("*", async (c, next) => {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();

  let action: "read" | "create" | "update" | "delete" | "manage" = "read";
  let resource: "node" | "tunnel" = "node";

  if (path.includes("/bindings")) {
    action = method === "GET" ? "read" : "manage";
    resource = "node";
  } else if (path.includes("/forwards")) {
    resource = "tunnel";
    if (method === "DELETE") action = "delete";
    else if (method === "POST" && /\/forwards\/?$/.test(path)) action = "create";
    else if (method === "GET") action = "read";
    else action = "update";
  } else if (path.endsWith("/enrollment") && method === "POST") {
    action = "manage";
    resource = "node";
  }

  c.set("workspace", await resolveWorkspaceAccess(c, action, resource));
  await next();
});

function workspace(c: Ctx): NonNullable<AppVariables["workspace"]> {
  const value = c.get("workspace");
  if (!value) throw new HTTPException(403, { message: "工作空间未授权" });
  return value;
}

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

function idParam(c: Ctx, name: string): number | null {
  const value = Number(c.req.param(name));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function targetAddress(host: string, port: number): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
}

const nodeSelect = {
  id: true,
  node_id: true,
  connect_ip: true,
  role: true,
  status: true,
  version: true,
  last_seen_at: true,
  port_range_min: true,
  port_range_max: true,
  lb_strategy: true,
  node_group_id: true,
  node_credential_hash: true,
  credential_revoked: true,
  node_group: { select: { id: true, name: true, node_type: true, workspace_id: true } },
} as const;

function nodeView(node: {
  id: number;
  node_id: string;
  connect_ip: string | null;
  role: string | null;
  status: string;
  version: string;
  last_seen_at: Date | null;
  port_range_min: number | null;
  port_range_max: number | null;
  lb_strategy: string | null;
  node_group_id: number;
  node_credential_hash?: string | null;
  credential_revoked?: boolean;
  node_group?: unknown;
}) {
  const lastSeen = node.last_seen_at?.getTime() ?? 0;
  const online =
    node.status === "active" &&
    lastSeen > 0 &&
    Date.now() - lastSeen <= 90_000 &&
    Boolean(node.node_credential_hash) &&
    !node.credential_revoked;

  const {
    node_credential_hash: _credentialHash,
    ...safe
  } = node;
  return {
    ...safe,
    online,
    has_credential: Boolean(_credentialHash),
    registered: Boolean(_credentialHash) && !node.credential_revoked,
  };
}

const forwardInclude = Prisma.validator<Prisma.TunnelInclude>()({
  ingress_node: { select: { id: true, node_id: true, connect_ip: true, role: true } },
  egress_node: { select: { id: true, node_id: true, connect_ip: true, role: true } },
  egress_pool: {
    include: {
      targets: {
        where: { status: "active" as const },
        orderBy: [{ order_by: "asc" as const }, { id: "asc" as const }],
      },
    },
  },
});

function portForwardView(t: any) {
  const target =
    t.tunnel_mode === "relay"
      ? t.egress_pool?.targets?.[0] ?? null
      : t.remote_host && t.remote_port
        ? { host: t.remote_host, port: t.remote_port, weight: 1 }
        : null;
  return {
    id: t.id,
    name: t.name,
    protocol: "tcp",
    mode: t.tunnel_mode ?? "direct",
    ingress_node_id: t.ingress_node_id,
    ingress_node: t.ingress_node ?? null,
    egress_node_id: t.egress_node_id,
    egress_node: t.egress_node ?? null,
    listen_ip: t.listen_ip,
    listen_port: t.listen_port,
    target_host: target?.host ?? null,
    target_port: target?.port ?? null,
    target_weight: target?.weight ?? null,
    desired_status: t.desired_status,
    apply_status: t.apply_status,
    config_revision: t.config_revision,
    applied_revision: t.applied_revision,
    apply_error_code: t.apply_error_code,
    apply_error: t.apply_error,
    last_applied_at: t.last_applied_at,
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

async function loadWorkspaceNode(nodeId: number, workspaceId: number) {
  return db.node.findFirst({
    where: { id: nodeId, node_group: { workspace_id: workspaceId } },
    select: nodeSelect,
  });
}

async function loadForward(id: number, ingressNodeId: number, workspaceId: number) {
  return db.tunnel.findFirst({
    where: { id, workspace_id: workspaceId, ingress_node_id: ingressNodeId },
    include: forwardInclude,
  });
}

/* ------------------------------------------------------------------ */
/* Nodes                                                               */
/* ------------------------------------------------------------------ */

nodesRoutes.get("/", async (c) => {
  const ws = workspace(c);
  const raw = await db.node.findMany({
    where: { node_group: { workspace_id: ws.id } },
    orderBy: [{ order_by: "asc" }, { id: "asc" }],
    select: nodeSelect,
  });
  return c.json({ data: raw.map((node) => nodeView(node)) });
});

/** Re-generate a short-lived one-click installer for an existing node. */
nodesRoutes.post("/:ingressId/enrollment", async (c) => {
  const ws = workspace(c);
  const nodeId = idParam(c, "ingressId");
  if (nodeId === null) return c.json({ error: "节点 ID 不合法" }, 400);
  const node = await loadWorkspaceNode(nodeId, ws.id);
  if (!node) return c.json({ error: "节点不存在" }, 404);
  const enrollment = await createNodeEnrollment(node.id);
  return c.json({ data: enrollment }, 201);
});

/* ------------------------------------------------------------------ */
/* Ingress <-> Egress bindings                                        */
/* ------------------------------------------------------------------ */

nodesRoutes.get("/:ingressId/bindings", async (c) => {
  const ws = workspace(c);
  const ingressId = idParam(c, "ingressId");
  if (ingressId === null) return c.json({ error: "入口节点 ID 不合法" }, 400);
  const ingress = await loadWorkspaceNode(ingressId, ws.id);
  if (!ingress) return c.json({ error: "入口节点不存在" }, 404);
  if (ingress.role !== "ingress" && ingress.role !== "both") {
    return c.json({ error: "该节点不具备入口能力" }, 409);
  }

  const rows = await db.nodeBinding.findMany({
    where: {
      ingress_node_id: ingressId,
      egress_node: { node_group: { workspace_id: ws.id } },
    },
    orderBy: { id: "asc" },
    include: {
      egress_node: { select: nodeSelect },
    },
  });
  return c.json({
    data: rows.map((row) => ({
      id: row.id,
      ingress_node_id: row.ingress_node_id,
      egress_node_id: row.egress_node_id,
      egress_node: nodeView(row.egress_node),
      created_at: row.created_at,
    })),
  });
});

const BindingInput = z.object({
  egress_node_id: z.number().int().positive(),
});

nodesRoutes.post("/:ingressId/bindings", async (c) => {
  const ws = workspace(c);
  const ingressId = idParam(c, "ingressId");
  if (ingressId === null) return c.json({ error: "入口节点 ID 不合法" }, 400);
  const parsed = BindingInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "出口节点 ID 不合法" }, 400);

  const [ingress, egress] = await Promise.all([
    loadWorkspaceNode(ingressId, ws.id),
    loadWorkspaceNode(parsed.data.egress_node_id, ws.id),
  ]);
  if (!ingress) return c.json({ error: "入口节点不存在" }, 404);
  if (!egress) return c.json({ error: "出口节点不存在" }, 404);
  if (ingress.id === egress.id) return c.json({ error: "入口和出口不能是同一节点" }, 409);
  if (ingress.role !== "ingress" && ingress.role !== "both") {
    return c.json({ error: "入口节点角色必须是 ingress 或 both" }, 409);
  }
  if (egress.role !== "egress" && egress.role !== "both") {
    return c.json({ error: "出口节点角色必须是 egress 或 both" }, 409);
  }

  const binding = await db.nodeBinding.upsert({
    where: {
      ingress_node_id_egress_node_id: {
        ingress_node_id: ingress.id,
        egress_node_id: egress.id,
      },
    },
    update: {},
    create: { ingress_node_id: ingress.id, egress_node_id: egress.id },
  });
  return c.json({
    data: {
      ...binding,
      egress_node: nodeView(egress),
    },
  }, 201);
});

nodesRoutes.delete("/:ingressId/bindings/:egressId", async (c) => {
  const ws = workspace(c);
  const ingressId = idParam(c, "ingressId");
  const egressId = idParam(c, "egressId");
  if (ingressId === null || egressId === null) return c.json({ error: "节点 ID 不合法" }, 400);

  const [ingress, egress] = await Promise.all([
    loadWorkspaceNode(ingressId, ws.id),
    loadWorkspaceNode(egressId, ws.id),
  ]);
  if (!ingress || !egress) return c.json({ error: "节点不存在" }, 404);

  const used = await db.tunnel.count({
    where: {
      workspace_id: ws.id,
      ingress_node_id: ingressId,
      egress_node_id: egressId,
      tunnel_mode: "relay",
    },
  });
  if (used > 0) {
    return c.json({ error: `该出口仍被 ${used} 条端口转发使用，请先删除或改为其它出口` }, 409);
  }

  await db.nodeBinding.deleteMany({
    where: { ingress_node_id: ingressId, egress_node_id: egressId },
  });
  return c.json({ data: { ok: true } });
});

/* ------------------------------------------------------------------ */
/* PortForward                                                         */
/* ------------------------------------------------------------------ */

nodesRoutes.get("/:ingressId/forwards", async (c) => {
  const ws = workspace(c);
  const ingressId = idParam(c, "ingressId");
  if (ingressId === null) return c.json({ error: "入口节点 ID 不合法" }, 400);
  const ingress = await loadWorkspaceNode(ingressId, ws.id);
  if (!ingress) return c.json({ error: "入口节点不存在" }, 404);

  const rows = await db.tunnel.findMany({
    where: { workspace_id: ws.id, ingress_node_id: ingressId, category: "port_forward" },
    orderBy: [{ order_by: "asc" }, { id: "desc" }],
    include: forwardInclude,
  });
  return c.json({ data: rows.map(portForwardView) });
});

const ForwardInput = z.object({
  name: z.string().trim().min(1).max(60),
  listen_port: z.number().int().min(1).max(65535).nullable().optional(),
  target_host: z.string().trim().min(1).max(255),
  target_port: z.number().int().min(1).max(65535),
  egress_node_id: z.number().int().positive().nullable().optional(),
});

nodesRoutes.post("/:ingressId/forwards", async (c) => {
  const user = requireUser(c);
  const ws = workspace(c);
  const ingressId = idParam(c, "ingressId");
  if (ingressId === null) return c.json({ error: "入口节点 ID 不合法" }, 400);

  const parsed = ForwardInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "端口转发参数不合法" }, 400);

  const ingress = await loadWorkspaceNode(ingressId, ws.id);
  if (!ingress) return c.json({ error: "入口节点不存在" }, 404);
  if (ingress.role !== "ingress" && ingress.role !== "both") {
    return c.json({ error: "该节点不具备入口能力" }, 409);
  }

  const egressId = parsed.data.egress_node_id ?? null;
  const egress = egressId === null ? null : await loadWorkspaceNode(egressId, ws.id);
  if (egressId !== null && !egress) return c.json({ error: "出口节点不存在" }, 404);
  if (egress && egress.id === ingress.id) return c.json({ error: "入口和出口不能是同一节点" }, 409);
  if (egress && egress.role !== "egress" && egress.role !== "both") {
    return c.json({ error: "选择的节点不具备出口能力" }, 409);
  }
  if (egress) {
    const binding = await db.nodeBinding.findUnique({
      where: {
        ingress_node_id_egress_node_id: {
          ingress_node_id: ingress.id,
          egress_node_id: egress.id,
        },
      },
      select: { id: true },
    });
    if (!binding) return c.json({ error: "该出口尚未绑定到当前入口节点" }, 409);
  }

  const target = targetAddress(parsed.data.target_host, parsed.data.target_port);
  const mode = egress ? "relay" : "direct";

  const reserved = await withWorkspaceQuotaLock(ws.id, async (tx, policy) => {
    const [tunnelCount, trafficUsed, maxOrder] = await Promise.all([
      countWorkspaceTunnels(ws.id, tx),
      sumWorkspaceTraffic(ws.id, policy.limits.traffic_period, new Date(), tx),
      tx.tunnel.aggregate({ _max: { order_by: true } }),
    ]);
    const decision = checkTunnelCreation(policy, {
      tunnelCount,
      trafficUsed,
      protocol: "tcp",
      inGroupOwned: true,
      inGroupId: ingress.node_group_id,
      outGroupId: egress?.node_group_id ?? null,
      outGroupOwned: true,
    });
    if (!decision.allowed) return { denied: decision } as const;

    if (parsed.data.listen_port != null) {
      const conflict = await tx.tunnel.findFirst({
        where: {
          ingress_node_id: ingress.id,
          listen_port: parsed.data.listen_port,
        },
        select: { id: true },
      });
      if (conflict) return { conflict: true } as const;
    }

    const tunnel = await tx.tunnel.create({
      data: {
        name: parsed.data.name,
        tunnel_type: "tcp",
        category: "port_forward",
        listen_ip: "0.0.0.0",
        listen_port: parsed.data.listen_port ?? null,
        listen_protocol: ["tcp"],
        status: "active",
        forward_addresses: mode === "direct" ? [target] : [],
        forward_addresses_protocol: mode === "direct" ? ["tcp"] : [],
        load_balance_type: "round",
        ip_type: "ipv4",
        order_by: (maxOrder._max.order_by ?? 0) + 10,
        in_node_group_id: ingress.node_group_id,
        out_node_group_id: egress?.node_group_id ?? null,
        user_id: user.id,
        workspace_id: ws.id,
        tunnel_mode: mode,
        ingress_node_id: ingress.id,
        egress_node_id: egress?.id ?? null,
        desired_status: "inactive",
        apply_status: "pending",
        config_revision: 0,
        applied_revision: null,
        remote_host: mode === "direct" ? parsed.data.target_host : null,
        remote_port: mode === "direct" ? parsed.data.target_port : null,
      },
      select: { id: true },
    });

    let poolId: number | null = null;
    if (egress) {
      const pool = await tx.egressPool.create({
        data: {
          node_id: egress.id,
          name: `forward-${tunnel.id}`,
          lb_strategy: egress.lb_strategy ?? "round",
          status: "active",
          targets: {
            create: {
              host: parsed.data.target_host,
              port: parsed.data.target_port,
              weight: 1,
              order_by: 1000,
              status: "active",
            },
          },
        },
        select: { id: true },
      });
      poolId = pool.id;
      await tx.tunnel.update({
        where: { id: tunnel.id },
        data: { egress_pool_id: poolId },
      });
    }

    return { tunnelId: tunnel.id, poolId } as const;
  });

  const denied = "denied" in reserved ? reserved.denied : null;
  if (denied) {
    return c.json({
      error: denied.message ?? "策略拒绝",
      code: denied.reason,
    }, 403);
  }
  if ("conflict" in reserved) return c.json({ error: "该入口端口已被占用" }, 409);
  const tunnelId = "tunnelId" in reserved && typeof reserved.tunnelId === "number"
    ? reserved.tunnelId
    : null;
  if (tunnelId === null) return c.json({ error: "创建端口转发失败" }, 500);

  const orchestrator = getOrchestrator();
  if (orchestrator) {
    const applied = mode === "direct"
      ? await reapplyDirectTunnel(tunnelId, orchestrator)
      : await reapplyRelayTunnel(tunnelId, orchestrator);
    if (!applied.ok) {
      const failed = await loadForward(tunnelId, ingress.id, ws.id);
      return c.json({
        error: applied.error,
        code: "apply_failed",
        apply_error_code: applied.error_code,
        data: failed ? portForwardView(failed) : { id: tunnelId },
      }, 502);
    }
  }

  const created = await loadForward(tunnelId, ingress.id, ws.id);
  if (!created) return c.json({ error: "端口转发创建后无法读取" }, 500);
  return c.json({ data: portForwardView(created) }, 201);
});

const ACTIONS = new Set<TunnelAction>(["retry", "suspend", "resume"]);

nodesRoutes.post("/:ingressId/forwards/:forwardId/:action", async (c) => {
  const ws = workspace(c);
  const ingressId = idParam(c, "ingressId");
  const forwardId = idParam(c, "forwardId");
  const action = c.req.param("action") as TunnelAction;
  if (ingressId === null || forwardId === null) return c.json({ error: "ID 不合法" }, 400);
  if (!ACTIONS.has(action)) return c.json({ error: "不支持的端口转发动作" }, 400);

  const current = await loadForward(forwardId, ingressId, ws.id);
  if (!current) return c.json({ error: "端口转发不存在" }, 404);

  const result = await runTunnelActionApi(forwardId, action, ws.id, {
    orchestrator: getOrchestrator(),
  });
  if (!result.ok) {
    return c.json(
      { error: result.message, code: result.code, apply_error_code: result.apply_error_code },
      TUNNEL_API_ERROR_STATUS[result.code],
    );
  }
  const after = await loadForward(forwardId, ingressId, ws.id);
  return c.json({ data: after ? portForwardView(after) : { id: forwardId, action } });
});

nodesRoutes.delete("/:ingressId/forwards/:forwardId", async (c) => {
  const ws = workspace(c);
  const ingressId = idParam(c, "ingressId");
  const forwardId = idParam(c, "forwardId");
  if (ingressId === null || forwardId === null) return c.json({ error: "ID 不合法" }, 400);

  const current = await loadForward(forwardId, ingressId, ws.id);
  if (!current) return c.json({ error: "端口转发不存在" }, 404);
  const dedicatedPoolId =
    current.tunnel_mode === "relay" && current.egress_pool?.name === `forward-${forwardId}`
      ? current.egress_pool.id
      : null;

  const result = await runTunnelActionApi(forwardId, "delete", ws.id, {
    orchestrator: getOrchestrator(),
  });
  if (!result.ok) {
    return c.json(
      { error: result.message, code: result.code, apply_error_code: result.apply_error_code },
      TUNNEL_API_ERROR_STATUS[result.code],
    );
  }
  if (dedicatedPoolId != null) {
    await db.egressPool.delete({ where: { id: dedicatedPoolId } }).catch(() => {});
  }
  return c.json({ data: { ok: true } });
});
