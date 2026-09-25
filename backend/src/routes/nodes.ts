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
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { resolveWorkspaceAccess } from "../services/workspace.ts";
import { createNodeEnrollment } from "../services/node-enrollment.ts";
import {
  createForward as createForwardService,
  deleteForward as deleteForwardService,
  getForward as getForwardService,
  listForwards as listForwardsService,
  runForwardAction as runForwardActionService,
  type ForwardAction,
} from "../services/forward-service.ts";

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
    c.header("Deprecation", "true");
    c.header("Link", '</api/forwards>; rel="successor-version"');
    c.header("X-TuneX-Deprecated", "/api/nodes/:ingressId/forwards");
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


const nodeSelect = {
  id: true,
  node_id: true,
  agent_id: true,
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
  agent_id: string;
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

async function loadWorkspaceNode(nodeId: number, workspaceId: number) {
  return db.node.findFirst({
    where: { id: nodeId, node_group: { workspace_id: workspaceId } },
    select: nodeSelect,
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
/* PortForward compatibility API                                      */
/* ------------------------------------------------------------------ */
/**
 * @deprecated V4 clients use /api/forwards. Keep these routes for one
 * compatibility cycle; all behavior delegates to forward-service so there is
 * no second creation/runtime implementation.
 */

nodesRoutes.get("/:ingressId/forwards", async (c) => {
  const ws = workspace(c);
  const ingressId = idParam(c, "ingressId");
  if (ingressId === null) return c.json({ error: "入口节点 ID 不合法" }, 400);
  const ingress = await loadWorkspaceNode(ingressId, ws.id);
  if (!ingress) return c.json({ error: "入口节点不存在" }, 404);

  const rows = await listForwardsService(ws.id, { ingress_node_id: ingressId });
  return c.json({ data: rows });
});

const ForwardInput = z.object({
  name: z.string().trim().min(1).max(60),
  listen_port: z.number().int().min(1).max(65535).nullable().optional(),
  target_host: z.string().trim().min(1).max(255),
  target_port: z.number().int().min(1).max(65535),
  egress_node_id: z.number().int().positive().nullable().optional(),
});

nodesRoutes.post("/:ingressId/forwards", async (c) => {
  const currentUser = requireUser(c);
  const ws = workspace(c);
  const ingressId = idParam(c, "ingressId");
  if (ingressId === null) return c.json({ error: "入口节点 ID 不合法" }, 400);

  const parsed = ForwardInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "端口转发参数不合法" }, 400);

  const result = await createForwardService(currentUser.id, ws.id, {
    ...parsed.data,
    ingress_node_id: ingressId,
    mode: parsed.data.egress_node_id ? "relay" : "direct",
  });
  if (!result.ok) {
    return c.json(
      {
        error: result.message,
        code: result.code,
        apply_error_code: result.apply_error_code,
        data: result.data,
      },
      result.status,
    );
  }
  return c.json({ data: result.data }, 201);
});

const ACTIONS = new Set<ForwardAction>(["retry", "suspend", "resume"]);

nodesRoutes.post("/:ingressId/forwards/:forwardId/:action", async (c) => {
  const ws = workspace(c);
  const ingressId = idParam(c, "ingressId");
  const forwardId = idParam(c, "forwardId");
  const action = c.req.param("action") as ForwardAction;
  if (ingressId === null || forwardId === null) {
    return c.json({ error: "ID 不合法" }, 400);
  }
  if (!ACTIONS.has(action)) {
    return c.json({ error: "不支持的端口转发动作" }, 400);
  }

  const current = await getForwardService(forwardId, ws.id);
  if (!current || Number(current.ingress_node_id) !== ingressId) {
    return c.json({ error: "端口转发不存在" }, 404);
  }

  const result = await runForwardActionService(forwardId, action, ws.id);
  if (!result.ok) {
    return c.json(
      {
        error: result.message,
        code: result.code,
        apply_error_code: result.apply_error_code,
      },
      result.status,
    );
  }
  return c.json({ data: result.data });
});

nodesRoutes.delete("/:ingressId/forwards/:forwardId", async (c) => {
  const ws = workspace(c);
  const ingressId = idParam(c, "ingressId");
  const forwardId = idParam(c, "forwardId");
  if (ingressId === null || forwardId === null) {
    return c.json({ error: "ID 不合法" }, 400);
  }

  const current = await getForwardService(forwardId, ws.id);
  if (!current || Number(current.ingress_node_id) !== ingressId) {
    return c.json({ error: "端口转发不存在" }, 404);
  }

  const result = await deleteForwardService(forwardId, ws.id);
  if (!result.ok) {
    return c.json(
      {
        error: result.message,
        code: result.code,
        apply_error_code: result.apply_error_code,
      },
      result.status,
    );
  }
  return c.json({ data: result.data });
});
