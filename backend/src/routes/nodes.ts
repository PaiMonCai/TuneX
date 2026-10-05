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
import { canWorkspaceResourceAction, resolveWorkspaceAccess } from "../services/workspace.ts";
import { createNodeEnrollment } from "../services/node-enrollment.ts";
import {
  createForward as createForwardService,
  deleteForward as deleteForwardService,
  getForward as getForwardService,
  listForwards as listForwardsService,
  runForwardAction as runForwardActionService,
  type ForwardAction,
} from "../services/forward-service.ts";
import {
  bindingUsage,
  bindingUsageMap,
  lookupBindingUsage,
  unbindBlockedMessage,
} from "../services/binding-usage.ts";
import { projectUserNode } from "../services/node-view.ts";
import { collectSupportBundle, defaultSupportBundleDeps } from "../services/support-bundle.ts";
import { checkUpgradePrecondition, renderNodeUpgradeScript, validateAgentImageRef } from "../services/node-upgrade.ts";
import { collectNodeDiagnostics, defaultNodeDiagnosticsDeps } from "../services/node-diagnostics.ts";

export const nodesRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

nodesRoutes.use("*", async (c, next) => {
  const path = c.req.path;
  const method = c.req.method.toUpperCase();

  let action: "read" | "create" | "update" | "delete" | "manage" = "read";
  let resource: "node" | "forward" = "node";

  if (path.includes("/bindings")) {
    action = method === "GET" ? "read" : "manage";
    resource = "node";
  } else if (path.includes("/forwards")) {
    resource = "forward";
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
  //  §13.4.1：用户侧也要能回答「这台机器现在能不能接新业务」。
  // lifecycle 是 Lifecycle 层的唯一真相列（）；本文件**不重复**判定它，
  // 只把它交给 services/node-lifecycle.ts 的 nodeAdmission。
  lifecycle: true,
  // 展示用（ 的备注；不参与任何判定）。
  lifecycle_note: true,
  lifecycle_updated_at: true,
  node_group: { select: { id: true, name: true, node_type: true, workspace_id: true } },
} as const;

/** 用户侧节点行的 select 形状（Prisma `select: nodeSelect` 的投影）。 */
interface UserNodeRow {
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
  /**  生命周期列（schema `@default(active)`）；缺省 = 未 select 到。 */
  lifecycle?: string | null;
  lifecycle_note?: string | null;
  lifecycle_updated_at?: Date | null;
  node_group?: unknown;
}

/**
 *  §13.4.1 —— 用户侧节点投影。
 *
 * 三层状态的**判定不在本文件**，全部来自 `services/node-view.ts`
 * （它只调  的 `deriveConnection` / `nodeAdmission`）。这里负责：
 *   · 去掉 credential hash（既不明文也不哈希地外泄）；
 *   · 把判定结果摊平进响应体。
 *
 * 改造前本函数自己写过一份在线判据（与 `deriveConnection` 重复），
 * 详见 `services/node-view.ts` 顶部「两份实现」的说明。
 */
function nodeView(node: UserNodeRow) {
  const {
    node_credential_hash: credentialHash,
    ...safe
  } = node;
  return {
    ...safe,
    ...projectUserNode({
      status: node.status,
      last_seen_at: node.last_seen_at,
      has_credential: Boolean(credentialHash),
      credential_revoked: node.credential_revoked,
      lifecycle: node.lifecycle,
    }),
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

/**
 *  —— `GET /api/nodes/:id/diagnostics`
 *
 * Node 级诊断：回答"这个节点现在到底在跑什么"。事实来自两处——面板持有的状态上报，
 * 以及节点进程的**自述**（collect_diagnostics）。离线节点**先判活再决定是否下发**，
 * 因此不会出现"对一台掉线的机器等 20 秒超时"。
 *
 * 权限：`node:read`（GET 默认映射），只读，不产生 desired 变更。
 */
nodesRoutes.get("/:ingressId/diagnostics", async (c) => {
  const ws = workspace(c);
  const nodeId = idParam(c, "ingressId");
  if (nodeId === null) return c.json({ error: "节点 ID 不合法" }, 400);
  const result = await collectNodeDiagnostics(nodeId, ws.id, defaultNodeDiagnosticsDeps());
  if (!result.ok) {
    return c.json({ error: result.message, code: result.code, error_layer: result.error_layer }, result.status);
  }
  return c.json({ data: result.report });
});

/**
 *  —— `POST /api/nodes/:id/upgrade-command`
 *
 * 返回一段**由 Panel 渲染、由操作者在节点上执行**的升级脚本。控制面不远程替换
 * 节点上的 Agent：Agent 没有 Docker 权限，Panel 也不主动连节点（§13.6）。
 *
 * 权限：`node:manage` + workspace 作用域（沿用本文件的 middleware 映射）。
 * 副作用：**没有**——脚本不改任何运行态；维护态需要操作者按返回的提示自行切换，
 * 因为 lifecycle 有自己的、更严格的授权面。
 */
nodesRoutes.post("/:ingressId/upgrade-command", async (c) => {
  const ws = workspace(c);
  const nodeId = idParam(c, "ingressId");
  if (nodeId === null) return c.json({ error: "节点 ID 不合法" }, 400);

  const body = (await c.req.json().catch(() => null)) as
    | { agent_image?: unknown; allow_active?: unknown; container_name?: unknown }
    | null;
  const image = validateAgentImageRef(body?.agent_image);
  if (!image.ok) {
    return c.json({ error: image.reason, code: "invalid_image", error_layer: "capability" }, 400);
  }

  const node = await loadWorkspaceNode(nodeId, ws.id);
  if (!node) return c.json({ error: "节点不存在", code: "not_found", error_layer: "resource_scope" }, 404);

  const facts = {
    node_key: node.node_id,
    agent_id: node.agent_id ?? "",
    role: node.role ?? null,
    lifecycle: node.lifecycle ?? null,
  };
  const allowActive = body?.allow_active === true;
  const precondition = checkUpgradePrecondition(facts, { allowActive });
  if (!precondition.ok) {
    return c.json(
      { error: precondition.message, code: precondition.code, error_layer: "runtime_admission" },
      409,
    );
  }

  const rendered = renderNodeUpgradeScript(facts, image.image, {
    containerName: typeof body?.container_name === "string" ? body.container_name : undefined,
    // The panel address the node already uses; it is a public fact of the
    // deployment, not a secret, and the script only ever prints an HTTP code.
    panelURL: process.env.TUNEX_PUBLIC_PANEL_URL?.trim() || null,
  });
  return c.json({
    data: {
      node: { id: node.id, node_id: node.node_id, agent_id: node.agent_id, lifecycle: node.lifecycle },
      target_image: image.image,
      allow_active: allowActive,
      ...rendered,
    },
  });
});

/**
 *  —— `GET /api/nodes/:id/support-bundle`
 *
 * 一次排障快照。两条纪律：
 *   1. **白名单采集 + 确定性脱敏**（services/support-bundle.ts），凭据哈希永不入内；
 *   2. **按调用者权限裁剪段落**——只有 node:read 的身份不会拿到转发明细或审计记录，
 *      并且产物里会写明"为什么没有"。node 读出权限本身不隐含 forward/audit 读权限。
 *
 * 只读：不产生 Agent 命令、不移动 revision。
 */
nodesRoutes.get("/:ingressId/support-bundle", async (c) => {
  const ws = workspace(c);
  const nodeId = idParam(c, "ingressId");
  if (nodeId === null) return c.json({ error: "节点 ID 不合法" }, 400);
  const sections = {
    forwards: canWorkspaceResourceAction(ws, "read", "forward"),
    audit: canWorkspaceResourceAction(ws, "read", "audit"),
  };
  const result = await collectSupportBundle(nodeId, ws.id, defaultSupportBundleDeps(), sections);
  if (!result.ok) {
    return c.json({ error: result.message, code: result.code, error_layer: result.error_layer }, result.status);
  }
  return c.json({ data: result.bundle });
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

  //  §13.6「Binding usage」：一次 groupBy 拿到全部出口的使用量，
  // 而不是每个绑定查一次（N+1 在绑定量上来后是列表页的主要延迟来源）。
  const usageVisible = canWorkspaceResourceAction(ws, "read", "forward");
  const usage = bindingUsageMap(
    usageVisible ? await db.tunnel.groupBy({
      by: ["ingress_node_id", "egress_node_id"],
      where: {
        workspace_id: ws.id,
        category: "port_forward",
        tunnel_mode: "relay",
        ingress_node_id: ingressId,
        egress_node_id: { not: null },
      },
      _count: { _all: true },
    }).then((groups) =>
      groups.map((group) => ({
        ingress_node_id: group.ingress_node_id,
        egress_node_id: group.egress_node_id,
        count: group._count._all,
      })),
    ) : [],
  );

  return c.json({
    data: rows.map((row) => ({
      id: row.id,
      ingress_node_id: row.ingress_node_id,
      egress_node_id: row.egress_node_id,
      egress_node: nodeView(row.egress_node),
      created_at: row.created_at,
      // 使用量是响应投影（不新增列）：用户在解绑前就能看到影响面。
      usage_visible: usageVisible,
      ...(usageVisible ? lookupBindingUsage(usage, row.ingress_node_id, row.egress_node_id) : { used_by_forward_count: null, unbind_blocked: null, usage: null }),
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

  const created = await db.nodeBinding.upsert({
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
      ...created,
      egress_node: nodeView(egress),
      //  §13.6：新建绑定必然 0 使用量；仍显式返回，让前端的绑定行
      // 处理逻辑不需要区分「刚创建」与「列表返回」两种形状。
      ...bindingUsage(0),
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
    //  §13.6：409 文案由 `binding-usage.ts` 单点提供，与列表响应里的
    // `used_by_forward_count` / `unbind_blocked` 用同一份判定；并回传使用量，
    // 让前端在错误分支也能刷新按钮状态（而不是只弹一句话）。
    return c.json(
      {
        error: canWorkspaceResourceAction(ws, "read", "forward") ? unbindBlockedMessage(used) : "该绑定仍存在业务依赖，请由有转发权限的成员处理后再解绑",
        code: "binding_in_use",
        error_layer: "runtime_admission",
        ...(canWorkspaceResourceAction(ws, "read", "forward") ? bindingUsage(used) : {}),
      },
      409,
    );
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
 * @deprecated Use /api/forwards. Keep these routes for compatibility.
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
  //：兼容端点保持**裸数组**契约（E2E 脚本与旧客户端按数组解析）；
  // 「取全部」的上限由 `listForwards` 服务层统一施加，这里不重复截断。
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
        error_layer: result.error_layer,
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

  if (!canWorkspaceResourceAction(ws, "update", "forward")) {
    const identity = await db.tunnel.findFirst({
      where: { id: forwardId, workspace_id: ws.id, ingress_node_id: ingressId, category: "port_forward" },
      select: { user_id: true },
    });
    if (!identity) return c.json({ error: "端口转发不存在", code: "not_found", error_layer: "resource_scope" }, 404);
    if (!canWorkspaceResourceAction(ws, "update", "forward", identity.user_id === requireUser(c).id)) {
      return c.json({ error: "无权操作该端口转发", code: "forbidden", error_layer: "rbac" }, 403);
    }
  }

  const result = await runForwardActionService(forwardId, action, ws.id);
  if (!result.ok) {
    return c.json(
      {
        error: result.message,
        code: result.code,
        apply_error_code: result.apply_error_code,
        error_layer: result.error_layer,
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

  if (!canWorkspaceResourceAction(ws, "delete", "forward")) {
    const identity = await db.tunnel.findFirst({
      where: { id: forwardId, workspace_id: ws.id, ingress_node_id: ingressId, category: "port_forward" },
      select: { user_id: true },
    });
    if (!identity) return c.json({ error: "端口转发不存在", code: "not_found", error_layer: "resource_scope" }, 404);
    if (!canWorkspaceResourceAction(ws, "delete", "forward", identity.user_id === requireUser(c).id)) {
      return c.json({ error: "无权操作该端口转发", code: "forbidden", error_layer: "rbac" }, 403);
    }
  }

  const result = await deleteForwardService(forwardId, ws.id);
  if (!result.ok) {
    return c.json(
      {
        error: result.message,
        code: result.code,
        apply_error_code: result.apply_error_code,
        error_layer: result.error_layer,
      },
      result.status,
    );
  }
  return c.json({ data: result.data });
});
