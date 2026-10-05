/**
 * Admin Node / Egress control surface.
 *
 * Application-level admin authentication and the `nodes` resource permission
 * guard protect these routes. This module manages desired node roles, egress
 * pools/targets and read-only credential/runtime projections; credential secrets
 * are never returned here and runtime dispatch remains owned by the orchestrator.
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
import { readPoolTargetHealth } from "../services/target-health-read.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const nodeAdminRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

/** 统一错误响应：`{ error, message, code }`（message 兼容前端 ApiError 取文案）。 */
function adminError(c: Ctx, e: NodeAdminError) {
  const status = ADMIN_ERROR_STATUS[e.code] ?? 500;
  const body: Record<string, unknown> = { error: e.message, message: e.message, code: e.code };
  // Preserve condition/dependency details so the Web can distinguish runtime-condition refusals.
  if (e.condition !== undefined) body.condition = e.condition;
  if (e.dependencies !== undefined) body.dependencies = e.dependencies;
  return c.json(body, status);
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
 * credential list / get（ 的 rotate/revoke 之外补的读端点）
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

/**
 * GET /api/admin/node/pools/:poolId/health —— / 的目标健康视图。
 *
 * 与 `.../targets` 分开而不是塞进同一个响应：那是**期望**（用户要什么），
 * 这是**观测 + 合成**（我们看到了什么、据此判断什么）。混在一个响应里，
 * 下一次改动就很难说清哪个字段属于哪一类事实，而这是 §7 反复强调的边界。
 */
nodeAdminRoutes.get("/node/pools/:poolId/health", async (c) => {
  const poolId = numericParam(c, "poolId", "池");
  if (poolId === null) return c.json({ error: "非法池 ID", message: "非法池 ID" }, 400);
  // now 在路由边界取一次并透传：同一次响应里所有目标必须用同一个时刻判定 stale。
  const result = await readPoolTargetHealth({ poolId, now: new Date() });
  if (!result.ok) return c.json({ error: "池不存在", message: "池不存在" }, 404);
  return c.json({
    data: {
      targets: result.health.targets,
      observers: result.health.observers,
      // V5.2: 目标身份 → 期望行 id。界面据此把状态贴到目标上，不必自己再实现一遍
      // 归一化规则（第二份实现一旦漂移，症状是"被观测到的目标显示成没有证据"）。
      target_ids: result.health.targetIds,
      observed_at: result.health.now.toISOString(),
    },
  });
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
