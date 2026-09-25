/**
 * WP10 — Admin Node / Egress API（管理端：节点角色 / 凭据状态 / 出口池 / 运行态）
 *
 * 依据 `DEVELOPMENT.md` §7.13「WP10 / WP11 — API Track」。
 * 挂载（app.ts）：`app.route("/api/admin", nodeAdminRoutes);`
 * 中间件由 app.ts 统一施加（adminRequired → adminPermissionGuard），
 * 因此本模块不重复挂认证/权限。
 *
 * ── RBAC 归属（不新增资源键，复用既有 `nodes`）──
 * 全部路径都以 `/node` 开头，落在 `permissions.ts` 的 `nodes` 资源
 * （`apiPrefixes: ["/admin/node", "/admin/nodes"]`）下：GET 需 read、
 * 写需 write。WP10 是节点/出口能力的控制面，不是独立业务域——新增资源键
 * 会让角色编辑器里多出一个无法单独授权的重复入口，也会让同一个「改节点」
 * 动作散落在两个权限上。
 * 凭据签发/轮换/撤销仍在 WP7 的 routes/admin.ts（本文件只做 list/get）。
 *
 * ── 没有「下发」逻辑（§7.13 对 WP11 立的规矩对 WP10 同样生效）──
 * 这里只改 DB 里的 desired state（角色 / 池 / 目标）。revision 自增、
 * Agent 通知、补偿回滚都归 WP8 编排器。任何「下发」路径都不经本文件。
 *
 * ── 凭据纪律（与 WP7 完全对齐）──
 * 明文唯一出口是 WP7 的 issue/rotate 响应；本文件只在 credential list/get
 * 里回状态投影（布尔 + 时间戳），**既不明文也不哈希**。
 * 所有非 GET 请求都会被 middlewares/audit.ts 自动落审计，凭据相关字段
 * 由 services/audit.ts 的 SENSITIVE_RE 丢 metadata，本文件不写日志。
 *
 * ── 限流 ──
 * 敏感写操作（凭据轮换）沿用 WP7 的 `node-credential-rotation` 规则
 * （middlewares/rate-limit.ts，POST /api/admin/node/:id/credential*，
 * 60s/5 次，user 维度）；本文件其余端点走 `api-global` 600/min。
 *
 * 端点总览（全部落在 `nodes` 资源的 `/admin/node` 前缀下，见上方 RBAC 说明）：
 *   PATCH  /api/admin/node/:id/role              节点角色（+端口区间/默认策略）
 *   GET    /api/admin/node/:id/detail            节点详情（含池与目标，凭据脱敏）
 *   GET    /api/admin/node/:id/credential        单节点凭据状态
 *   GET    /api/admin/node/credentials           全量凭据状态（?role/?online/?stale）
 *   GET    /api/admin/node/:id/pools             某节点的池（含目标）
 *   POST   /api/admin/node/:id/pools             建池
 *   GET    /api/admin/node/pools                 全量池（?node_id/?targets）
 *   PATCH  /api/admin/node/pools/:poolId          改池
 *   DELETE /api/admin/node/pools/:poolId          删池
 *   GET    /api/admin/node/pools/:poolId/targets  池内目标
 *   POST   /api/admin/node/pools/:poolId/targets  加目标
 *   PUT    /api/admin/node/pools/:poolId/targets  整批替换目标集
 *   PATCH  /api/admin/node/targets/:targetId      改单条目标
 *   DELETE /api/admin/node/targets/:targetId      删目标
 *   GET    /api/admin/node/:id/state             单节点运行态
 *   GET    /api/admin/node/states                全量运行态（?role/?online/?stale）
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { db } from "../db.ts";
import {
  ADMIN_ERROR_STATUS,
  createEgressPool,
  createTarget,
  deleteEgressPool,
  deleteTarget,
  getNodeCredential,
  getNodeDetail,
  getNodeState,
  listEgressPools,
  listNodeStates,
  listNodeStatesWithCredentials,
  listTargets,
  replaceTargets,
  resolveNodeId,
  updateEgressPool,
  updateNodeRole,
  updateTarget,
  type NodeAdminError,
} from "../services/node-admin.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const nodeAdminRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

/** 统一错误响应：`{ error, message, code }`（message 兼容前端 ApiError 取文案）。 */
function adminError(c: Ctx, e: NodeAdminError) {
  const status = ADMIN_ERROR_STATUS[e.code] ?? 500;
  return c.json({ error: e.message, message: e.message, code: e.code }, status);
}

/** 节点 id 解析失败（数字主键或 node_id 字符串都找不到）→ 404。 */
async function nodeNotFound(c: Ctx, message: string) {
  return c.json({ error: message, message }, 404);
}

/** 读 JSON body，拿不到就按空对象（各 handler 自己校验必填字段）。 */
async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** 路径里的数字 id，非正整数 → 400。 */
function numericParam(c: Ctx, name: string, label: string): number | null {
  const value = Number(c.req.param(name));
  return Number.isInteger(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------------------ *
 * Node role —— /api/admin/node/:id/role
 * ------------------------------------------------------------------ */

/**
 * PATCH /api/admin/node/:id/role
 *
 * body: { role: "ingress"|"egress"|"both"|null, port_range_min?, port_range_max?,
 *         lb_strategy? }
 *
 * 丢掉出口能力时节点还有池 → 409（先删池）；获得出口能力时自动补 `default`
 * 池（幂等），响应 `default_pool_created` 告知前端是否发生了。
 */
nodeAdminRoutes.patch("/node/:id/role", async (c) => {
  const resolved = await resolveNodeId(db, c.req.param("id"));
  if (!resolved.ok) return nodeNotFound(c, resolved.message);
  const body = await readJson(c);
  const result = await updateNodeRole(resolved.id, {
    role: body.role,
    portRangeMin: body.port_range_min,
    portRangeMax: body.port_range_max,
    lbStrategy: body.lb_strategy,
  });
  if (!result.ok) return adminError(c, result);
  const { node_credential_hash: _hash, ...node } = result.node;
  return c.json({
    data: { node, role: node.role, default_pool_created: result.default_pool_created },
  });
});

/* ------------------------------------------------------------------ *
 * 节点详情 —— GET /api/admin/node/:id/detail
 * ------------------------------------------------------------------ */
nodeAdminRoutes.get("/node/:id/detail", async (c) => {
  const resolved = await resolveNodeId(db, c.req.param("id"));
  if (!resolved.ok) return nodeNotFound(c, resolved.message);
  const result = await getNodeDetail(resolved.id);
  if (!result.ok) return adminError(c, result);
  return c.json({ data: result.detail });
});

/* ------------------------------------------------------------------ *
 * credential list / get（WP7 的 rotate/revoke 之外补的读端点）
 * ------------------------------------------------------------------ */

/** GET /api/admin/node/:id/credential —— 单节点凭据状态（不明文、不哈希）。 */
nodeAdminRoutes.get("/node/:id/credential", async (c) => {
  const resolved = await resolveNodeId(db, c.req.param("id"));
  if (!resolved.ok) return nodeNotFound(c, resolved.message);
  const result = await getNodeCredential(resolved.id);
  if (!result.ok) return adminError(c, result);
  return c.json({ data: result.credential });
});

/**
 * GET /api/admin/node/credentials —— 全量凭据状态 + 运行时快照摘要。
 *
 * 查询串：`?role=ingress|egress|both`、`?online=true|false`、`?stale=true|false`。
 * 每项含 `credential: { state: "never"|"active"|"revoked", ... }`。
 */
nodeAdminRoutes.get("/node/credentials", async (c) => {
  const result = await listNodeStatesWithCredentials({
    role: c.req.query("role"),
    online: c.req.query("online"),
    stale: c.req.query("stale"),
  });
  if (!result.ok) return adminError(c, result);
  return c.json({ data: result.items, total: result.total });
});

/* ------------------------------------------------------------------ *
 * EgressPool CRUD —— /api/admin/node/:id/pools 与 /api/admin/node/pools/:poolId
 * ------------------------------------------------------------------ */

/** GET /api/admin/node/:id/pools —— 某节点的池（含目标）。 */
nodeAdminRoutes.get("/node/:id/pools", async (c) => {
  const resolved = await resolveNodeId(db, c.req.param("id"));
  if (!resolved.ok) return nodeNotFound(c, resolved.message);
  const result = await listEgressPools({ nodeId: resolved.id, includeTargets: true });
  if (!result.ok) return adminError(c, result);
  return c.json({ data: { data: result.pools, total: result.total } });
});

/** GET /api/admin/node/pools —— 全量池（`?node_id=` 可选过滤，`?targets=1` 带目标）。 */
nodeAdminRoutes.get("/node/pools", async (c) => {
  const nodeParam = c.req.query("node_id");
  let nodeId: number | null = null;
  if (nodeParam) {
    const resolved = await resolveNodeId(db, nodeParam);
    if (!resolved.ok) return nodeNotFound(c, resolved.message);
    nodeId = resolved.id;
  }
  const result = await listEgressPools({
    nodeId,
    includeTargets: c.req.query("targets") === "1" || c.req.query("targets") === "true",
  });
  if (!result.ok) return adminError(c, result);
  return c.json({ data: { data: result.pools, total: result.total } });
});

/**
 * POST /api/admin/node/:id/pools —— 建池。
 *
 * 节点须有出口能力；`default` 池名保留给自动创建的那一个。
 */
nodeAdminRoutes.post("/node/:id/pools", async (c) => {
  const resolved = await resolveNodeId(db, c.req.param("id"));
  if (!resolved.ok) return nodeNotFound(c, resolved.message);
  const body = await readJson(c);
  const result = await createEgressPool(resolved.id, {
    name: body.name,
    lbStrategy: body.lb_strategy,
    status: body.status,
  });
  if (!result.ok) return adminError(c, result);
  return c.json({ data: result.pool }, 201);
});

/**
 * PATCH /api/admin/node/pools/:poolId —— 改池（名称 / 策略 / 启停）。
 *
 * 从 inactive 改回 active 时校验「至少一个 active 且 weight>0 的目标」——
 * 否则下发的就是空目标快照（§2.2 硬规则）。
 */
nodeAdminRoutes.patch("/node/pools/:poolId", async (c) => {
  const poolId = numericParam(c, "poolId", "池");
  if (poolId === null) return c.json({ error: "非法池 ID", message: "非法池 ID" }, 400);
  const body = await readJson(c);
  const result = await updateEgressPool(poolId, {
    name: body.name,
    lbStrategy: body.lb_strategy,
    status: body.status,
  });
  if (!result.ok) return adminError(c, result);
  return c.json({ data: result.pool });
});

/**
 * DELETE /api/admin/node/pools/:poolId —— 删池。
 *
 * 有 RELAY 隧道引用 → 409（换目标池是热更新，不是连环删）。无引用时目标由
 * DB 层 `EgressTarget.onDelete: Cascade` 一并清掉。
 */
nodeAdminRoutes.delete("/node/pools/:poolId", async (c) => {
  const poolId = numericParam(c, "poolId", "池");
  if (poolId === null) return c.json({ error: "非法池 ID", message: "非法池 ID" }, 400);
  const result = await deleteEgressPool(poolId);
  if (!result.ok) return adminError(c, result);
  return c.json({ data: { ok: true } });
});

/* ------------------------------------------------------------------ *
 * EgressTarget CRUD —— /api/admin/node/pools/:poolId/targets 与 /api/admin/node/targets/:targetId
 * ------------------------------------------------------------------ */

/** GET /api/admin/node/pools/:poolId/targets —— 池内目标。 */
nodeAdminRoutes.get("/node/pools/:poolId/targets", async (c) => {
  const poolId = numericParam(c, "poolId", "池");
  if (poolId === null) return c.json({ error: "非法池 ID", message: "非法池 ID" }, 400);
  const result = await listTargets({ poolId });
  if (!result.ok) return adminError(c, result);
  return c.json({ data: { data: result.targets, total: result.total } });
});

/** POST /api/admin/node/pools/:poolId/targets —— 加目标（单条）。 */
nodeAdminRoutes.post("/node/pools/:poolId/targets", async (c) => {
  const poolId = numericParam(c, "poolId", "池");
  if (poolId === null) return c.json({ error: "非法池 ID", message: "非法池 ID" }, 400);
  const body = await readJson(c);
  const result = await createTarget(poolId, {
    host: body.host,
    port: body.port,
    weight: body.weight,
    orderBy: body.order_by,
    remark: body.remark,
    status: body.status,
  });
  if (!result.ok) return adminError(c, result);
  return c.json({ data: result.target }, 201);
});

/**
 * PUT /api/admin/node/pools/:poolId/targets —— 整批替换目标集（面板「保存池」）。
 *
 * body: `{ targets: [ { id?, host, port, weight?, order_by?, status? } ] }`
 * 终态必须至少有一个 active 且 weight>0 的目标；整批提交才对中间态免疫。
 */
nodeAdminRoutes.put("/node/pools/:poolId/targets", async (c) => {
  const poolId = numericParam(c, "poolId", "池");
  if (poolId === null) return c.json({ error: "非法池 ID", message: "非法池 ID" }, 400);
  const body = await readJson(c);
  const inputs = Array.isArray(body.targets) ? (body.targets as unknown[]) : [];
  const result = await replaceTargets(poolId, inputs);
  if (!result.ok) return adminError(c, result);
  return c.json({ data: result.targets });
});

/** PATCH /api/admin/node/targets/:targetId —— 改单条目标。 */
nodeAdminRoutes.patch("/node/targets/:targetId", async (c) => {
  const targetId = numericParam(c, "targetId", "目标");
  if (targetId === null) return c.json({ error: "非法目标 ID", message: "非法目标 ID" }, 400);
  const body = await readJson(c);
  const result = await updateTarget(targetId, {
    host: body.host,
    port: body.port,
    weight: body.weight,
    orderBy: body.order_by,
    remark: body.remark,
    status: body.status,
  });
  if (!result.ok) return adminError(c, result);
  return c.json({ data: result.target });
});

/** DELETE /api/admin/node/targets/:targetId —— 删目标（删完会空池则 409）。 */
nodeAdminRoutes.delete("/node/targets/:targetId", async (c) => {
  const targetId = numericParam(c, "targetId", "目标");
  if (targetId === null) return c.json({ error: "非法目标 ID", message: "非法目标 ID" }, 400);
  const result = await deleteTarget(targetId);
  if (!result.ok) return adminError(c, result);
  return c.json({ data: { ok: true } });
});

/* ------------------------------------------------------------------ *
 * runtime / state query —— /api/admin/node/:id/state 与 /api/admin/node/states
 * ------------------------------------------------------------------ */

/**
 * GET /api/admin/node/:id/state —— 单节点运行态（读 node_state_report）。
 *
 * 从未上报 → `reported_at = null` 等空态字段（不是 404：新节点没上报是
 * 正常状态，前端据此显示「等待首次上报」）。`stale` / `role_mismatch`
 * 是显式标注的不一致，不做抹平（见服务的批注）。
 */
nodeAdminRoutes.get("/node/:id/state", async (c) => {
  const resolved = await resolveNodeId(db, c.req.param("id"));
  if (!resolved.ok) return nodeNotFound(c, resolved.message);
  const result = await getNodeState(resolved.id);
  if (!result.ok) return adminError(c, result);
  return c.json({ data: result.state });
});

/** GET /api/admin/node/states —— 全量运行态（巡检页；?role/?online/?stale）。 */
nodeAdminRoutes.get("/node/states", async (c) => {
  const result = await listNodeStates({
    role: c.req.query("role"),
    online: c.req.query("online"),
    stale: c.req.query("stale"),
  });
  if (!result.ok) return adminError(c, result);
  return c.json({ data: result.states, total: result.total });
});
