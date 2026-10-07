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
import { isIP } from "node:net";
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
import {
  normalizeConnectIpPatch,
  updateNodeConnectIp,
  type NodeAddressDb,
} from "../services/node-address.ts";
import { collectSupportBundle, defaultSupportBundleDeps } from "../services/support-bundle.ts";
import { checkUpgradePrecondition, renderNodeUpgradeScript, validateAgentImageRef } from "../services/node-upgrade.ts";
import {
  NODE_OFFLINE_AFTER_SECONDS,
  collectNodeDiagnostics,
  defaultNodeDiagnosticsDeps,
} from "../services/node-diagnostics.ts";
// 版本比较**复用** WP6 健康合成里的同一个纯函数，不为升级卡片另写一套 semver 口径
// （那就是第二套「是否落后」的判定，专项明令禁止）。
import { isVersionOlder } from "../services/node-health.ts";
import { env } from "../env.ts";
import { panelMigrationView, readPanelMigrationFromEnv } from "../services/node-install.ts";

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
  } else if (method === "PATCH") {
    /**
     * 修改节点安全字段（当前只有 `connect_ip`）⇒ `node:manage`。
     *
     * 这里**必须**是 `manage` 而不是 `update`：`services/workspace.ts:requiredPermission`
     * 对 `resource === "node"` 只认 `read` / `manage` 两种动作，`update` 会映射成 **null**
     * ⇒ `canWorkspaceResourceAction` 直接 false（连 owner 也过不去）。真机 PATCH 实测就是
     * `403 permission_denied`，与本文件里 bindings / enrollment 的既有口径（manage）也不一致。
     */
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

// 行为参照：ForwardX（AGPL-3.0-only）——「成员自带连接地址（`connectHost`）」这一产品逻辑：
// 可拨号地址**不是**在创建那一刻定死的，而是事后可以设置与修改的。
// 代码为本项目改写（改在**节点**这一层，不引入成员级第二份地址），未复制其实现。
// 参照溯源：docs/agent/forwardx-code-reuse.md
/**
 * `PATCH /api/nodes/:id` —— 修改节点的**安全字段**（当前只有 `connect_ip`）。
 *
 * ── 为什么需要它 ──
 * `connect_ip` 曾经**只在 provision 时可写**：对已存在的节点再 provision，该字段被忽略
 * （`routes/node-groups.ts` 的重签分支只重发 enrollment，不动任何配置）。于是
 * 「建的时候没填地址」的节点**永远不能当 RELAY / 三跳的一跳** —— 下发时以
 * `502 apply_failed / invariant_violated: RELAY plan needs a <host>:<port> next_hop` 结束，
 * 而那句错误既没说是哪台机器，也没说该怎么办。
 *
 * ── 边界（为什么只开放这一个字段）──
 * 这里**不是**通用节点编辑器：role / 端口区间 / 生命周期 / 凭据都有各自的既有入口与判定
 * （`node-groups.ts`、`node-lifecycle.ts`、`node-credential*`），从这条路径改它们会绕过那些
 * 判定。因此本端点只认 `connect_ip`，其余字段一律 400（fail-closed，而不是"忽略未知字段"）。
 *
 * ── 拒绝分支（都有行为测试）──
 *   · `id` 非法 / 节点不属于当前 Workspace → 400 / 404（与同文件其余端点同形）；
 *   · 请求体缺 `connect_ip`、类型不对、空白串 → 400 `invalid_connect_ip`；
 *   · 地址形状不合法（含空白、方括号、非法 IP、非法主机名）→ 400 `invalid_connect_ip`；
 *   · 清空（`null`）而**仍有 RELAY/三跳依赖这台节点当跳** → 409 `connect_ip_in_use`
 *     （列出依赖它的转发，让用户先改/删那些转发 —— 否则下次下发必然失败）；
 *   · 权限：workspace `node:manage`（沿用本文件 `*` middleware 的映射，见下方新增的 PATCH 分支）。
 *
 * 不动 `node_id`（身份）、不动 `agent_id`、不写审计之外的任何状态；响应是与 `/api/nodes`
 * 同一份投影（`nodeView`），调用方不需要第二套形状。
 */
nodesRoutes.patch("/:id", async (c) => {
  const ws = workspace(c);
  const nodeId = idParam(c, "id");
  if (nodeId === null) return c.json({ error: "节点 ID 不合法", code: "invalid_input" }, 400);

  const raw = await c.req.json().catch(() => null);
  const parsed = normalizeConnectIpPatch(raw);
  if (!parsed.ok) return c.json({ error: parsed.message, code: parsed.code }, parsed.status);

  const result = await updateNodeConnectIp(db as unknown as NodeAddressDb, {
    nodeId,
    workspaceId: ws.id,
    value: parsed.value,
  });
  if (!result.ok) {
    return c.json(
      { error: result.message, code: result.code, ...(result.data ? { data: result.data } : {}) },
      result.status,
    );
  }
  return c.json({ data: nodeView(result.node as never) });
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

/**
 * R1-A —— `GET /api/nodes/:id/upgrade-state`
 *
 * 升级卡片的**只读**事实来源。为什么必须由服务端提供（而不是前端把几个字段凑出来）：
 *
 *  1. **用户域此前没有任何「实际上报版本」的读投影。** `node.version` 是**管理员配置
 *     字段**（schema 默认 `unknown`；真机取证：9 台节点的 `node.version` 全是 `unknown`，
 *     而 `node_state_report.version` 是 `0.13.22`）。前端拿 `node.version` 当"当前运行
 *     版本"就是把配置当事实 —— R1-A 已确认这是必须避免的展示错误。上报版本只存在于
 *     `node_state_report`，此前只有管理端 `/api/admin/node/:id/state` 能读到。
 *  2. **前置结论必须与 `POST /:id/upgrade-command` 同源。** 这里直接调用同一个
 *     `checkUpgradePrecondition`，并把它的 `code` / `message` **原样**下发；前端不另写
 *     一套"先切维护再升级"的规则（否则两处会在改规则时静默分叉）。
 *  3. **判定窗口由服务端下发。** `offline_after_seconds` 与 `report_freshness` 用的是
 *     diagnostics 同一个常量 `NODE_OFFLINE_AFTER_SECONDS`；F2 的教训是同一事实的多份
 *     字面量迟早分叉，所以前端不许自己编窗口。
 *  4. **是否落后同样复用既有判定**（`isVersionOlder`，WP6 用它给 `agent_version_behind`）。
 *     基线（`TUNEX_AGENT_LATEST_VERSION`）未配置时如实给 `unknown` —— 不伪造落后，也不
 *     伪造"已是最新"。
 *
 * 权限：`node:read`（本文件 middleware 的 GET 默认映射）。**只读**：不生成脚本、不下发
 * 命令、不改任何运行态。能读 ≠ 能升级：生成脚本仍是 `node:manage`（POST upgrade-command）。
 */
nodesRoutes.get("/:ingressId/upgrade-state", async (c) => {
  const ws = workspace(c);
  const nodeId = idParam(c, "ingressId");
  if (nodeId === null) return c.json({ error: "节点 ID 不合法" }, 400);

  const node = await loadWorkspaceNode(nodeId, ws.id);
  if (!node) return c.json({ error: "节点不存在", code: "not_found", error_layer: "resource_scope" }, 404);

  const report = await db.nodeStateReport.findUnique({
    where: { node_id: node.id },
    select: { version: true, role: true, reported_at: true, last_error: true },
  });

  const reportedAt = report?.reported_at ?? null;
  const ageSeconds = reportedAt ? Math.max(0, Math.round((Date.now() - reportedAt.getTime()) / 1000)) : null;
  // 「面板还在收到上报」是一个**连接事实**，与"升级是否成功"无关：这里只回答前者。
  const reportFreshness: "fresh" | "stale" | "unknown" =
    ageSeconds === null ? "unknown" : ageSeconds > NODE_OFFLINE_AFTER_SECONDS ? "stale" : "fresh";

  const facts = {
    node_key: node.node_id,
    agent_id: node.agent_id ?? "",
    role: node.role ?? null,
    lifecycle: node.lifecycle ?? null,
  };
  // allow_active **不传**：读投影展示的是"默认路径能不能直接升级"这一事实；
  // 带业务升级是调用者在 POST 时的显式决定，不能在只读投影里替他做掉。
  const precondition = checkUpgradePrecondition(facts);

  const reportedVersion = report?.version ?? null;
  const expectedVersion = env.agentLatestVersion.trim() === "" ? null : env.agentLatestVersion.trim();
  const older = isVersionOlder(reportedVersion, expectedVersion);

  return c.json({
    data: {
      node: {
        id: node.id,
        node_key: node.node_id,
        agent_id: node.agent_id,
        role: node.role ?? null,
        lifecycle: node.lifecycle ?? null,
      },
      reported: report
        ? {
            version: reportedVersion,
            role: report.role ?? null,
            reported_at: reportedAt ? reportedAt.toISOString() : null,
            age_seconds: ageSeconds,
            last_error: report.last_error ?? null,
          }
        : null,
      report_freshness: reportFreshness,
      /**
       * ⚠️ 管理员配置字段（schema `Node.version`），**不是**实际上报版本。
       * 只有需要对照"配置与实报是否一致"时才展示，且必须显式标注。
       */
      configured_version: node.version,
      target: {
        /** 部署方发给节点的镜像（`TUNEX_AGENT_IMAGE`）；升级脚本的默认目标。 */
        image: env.agentImage,
        image_source: process.env.TUNEX_AGENT_IMAGE?.trim() ? "env:TUNEX_AGENT_IMAGE" : "builtin_default",
        /** 部署方声明的版本基线；`null` = 未配置 = 面板**不判定**落后。 */
        expected_version: expectedVersion,
        /** behind | not_behind | unknown（unknown = 基线未配置或版本号无法比较）。 */
        version_drift: older === null ? "unknown" : older ? "behind" : "not_behind",
      },
      precondition: precondition.ok
        ? { ok: true, code: null, message: null }
        : { ok: false, code: precondition.code ?? null, message: precondition.message ?? null },
      offline_after_seconds: NODE_OFFLINE_AFTER_SECONDS,
      /**
       * 面板迁移回退（task-44）：**面板侧配置了什么**（部署环境变量）。
       *
       * ⚠️ 这是**面板级**配置，不是这台节点的运行态：
       * "agent 现在到底在跟哪个地址说话"由 agent 上报（`panel_url_in_use` /
       * `panel_migration_id` / `panel_fallback_active`），而**面板侧还没有持久化它的列**
       * （需要一次 schema 迁移，不在本切片范围）⇒ 这里如实标注 `node_reported_state_persisted: false`，
       * 绝不用"配置了回退"冒充"节点正在回退"。
       */
      panel_migration: panelMigrationView(await loadPanelMigration()),
      generated_at: new Date().toISOString(),
    },
  });
});

/**
 * 读面板级迁移配置（部署环境变量：TUNEX_PANEL_MIGRATION_*）。
 *
 * **"确实没配置"与"读不到"必须分开**：前者是部署方的选择（`not_configured`，`problem=null`），
 * 后者是这次取数的降级（`unreadable`，`problem` 非空、可重试）。把两者都渲染成"未配置"
 * 就是"取不到 ⇒ 显示成没事"，正是本专项反复禁掉的那类展示错误。
 */
async function loadPanelMigration() {
  try {
    return readPanelMigrationFromEnv();
  } catch (error) {
    return {
      ok: false as const,
      reason: "unreadable" as const,
      detail: error instanceof Error ? error.message : "读取面板迁移配置失败",
    };
  }
}

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
