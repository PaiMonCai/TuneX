/**
 * Admin Node lifecycle, impact and retiring-delete surface.
 *
 * The app-level admin guards provide authentication/RBAC. Responses expose only
 * lifecycle projections and credential presence, never credential material.
 * Lifecycle changes and physical deletion keep dependency checks explicit and do
 * not implicitly cascade Forward ownership.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { db } from "../db.ts";
import {
  LIFECYCLE_ERROR_STATUS,
  changeLifecycle,
  deleteNode,
  getNodeImpact,
  getNodeLifecycle,
  listActiveLeasePorts,
  checkRoleChange,
  parseLifecycle,
  parseLifecycleNote,
} from "../services/node-lifecycle.ts";
import { resolveNodeId } from "../services/node-admin.ts";
import type { AppVariables } from "../middlewares/auth.ts";

export const nodeLifecycleRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

/**
 * 统一错误响应：`{ error, message, code, condition?, dependencies? }`
 * message supports the Web error surface; condition/dependencies remain intact
 * so runtime-condition refusals stay distinguishable.
 */
function lifecycleError(
  c: Ctx,
  e: {
    ok: false;
    code: keyof typeof LIFECYCLE_ERROR_STATUS;
    message: string;
    condition?: string;
    dependencies?: unknown;
  },
) {
  const status = LIFECYCLE_ERROR_STATUS[e.code] ?? 500;
  const body: Record<string, unknown> = { error: e.message, message: e.message, code: e.code };
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

/**
 * 单节点生命周期视图（GET / impact / PATCH 共用投影）。
 *
 * 为什么每次重新拼而不是回 changeLifecycle 的 node：PATCH 的返回要的是
 * 「写后新值」，而 changeLifecycle 的 `node` 是 DB 更新后的整行（含
 * lifecycle_note / lifecycle_updated_at，服务层已 select 了）。因此
 * 这里只做转发，不做二次过滤。
 */
function lifecycleViewResponse(node: Record<string, unknown>) {
  const { node_credential_hash: _hash, ...rest } = node;
  return rest;
}

/* ------------------------------------------------------------------ *
 * GET /api/admin/node/:id/lifecycle
 * ------------------------------------------------------------------ */

/**
 * GET /api/admin/node/:id/lifecycle
 *
 * 返回三层状态投影：
 *   lifecycle    —— 管理期望态（本层，active/maintenance/disabled/retiring）
 *   connection   —— 节点/凭据推导（waiting/online/offline，**不新增列**）
 *   health       —— 本期不回（ telemetry）
 * 另含 accepts_new_business + admission_rejection（前端据此禁用创建按钮）与
 * allowed_transitions（前端据此渲染迁移按钮）。
 */
nodeLifecycleRoutes.get("/node/:id/lifecycle", async (c) => {
  const resolved = await resolveNodeId(db, c.req.param("id"));
  if (!resolved.ok) return nodeNotFound(c, resolved.message);
  const result = await getNodeLifecycle(resolved.id);
  if (!result.ok) return lifecycleError(c, result);
  return c.json({ data: result.view });
});

/* ------------------------------------------------------------------ *
 * PATCH /api/admin/node/:id/lifecycle
 * ------------------------------------------------------------------ */

/**
 * PATCH /api/admin/node/:id/lifecycle
 *
 * body: { lifecycle: "active"|"maintenance"|"disabled"|"retiring", note?: string }
 *
 * 幂等：同值合法（更新时间戳/备注）。`lifecycle` 缺失 = 不改生命周期。
 * 迁移白名单见服务层 canTransition：retiring 单向门、disabled→maintenance 拒。
 */
nodeLifecycleRoutes.patch("/node/:id/lifecycle", async (c) => {
  const resolved = await resolveNodeId(db, c.req.param("id"));
  if (!resolved.ok) return nodeNotFound(c, resolved.message);
  const body = await readJson(c);

  // 先做一次纯函数校验，把 400 挡在 DB 之前（服务层也会判，这里是为了
  // 让请求体完全非法时不走 resolveNodeId 之外的 DB 往返）。
  if (!parseLifecycle(body.lifecycle).ok) {
    return c.json(
      { error: "生命周期状态必须是 active / maintenance / disabled / retiring", message: "生命周期状态必须是 active / maintenance / disabled / retiring", code: "invalid_input" },
      400,
    );
  }
  if (!parseLifecycleNote(body.note).ok) {
    return c.json({ error: "备注必须是字符串且不超过 255 字", message: "备注必须是字符串且不超过 255 字", code: "invalid_input" }, 400);
  }

  const result = await changeLifecycle(resolved.id, {
    lifecycle: body.lifecycle,
    note: body.note,
  });
  if (!result.ok) return lifecycleError(c, result);
  return c.json({
    data: {
      node: lifecycleViewResponse(result.node as unknown as Record<string, unknown>),
      view: result.view,
    },
  });
});

/* ------------------------------------------------------------------ *
 * GET /api/admin/node/:id/impact
 * ------------------------------------------------------------------ */

/**
 * GET /api/admin/node/:id/impact
 *
 * 影响检查（前端在「删除」「收缩角色/端口区间」前调，先给用户看要清什么）。
 * 返回 NodeImpact：五类依赖计数 + 收缩端口区间会悬空的 active 租约端口。
 */
nodeLifecycleRoutes.get("/node/:id/impact", async (c) => {
  const resolved = await resolveNodeId(db, c.req.param("id"));
  if (!resolved.ok) return nodeNotFound(c, resolved.message);
  const result = await getNodeImpact(resolved.id);
  if (!result.ok) return lifecycleError(c, result);

  // 角色收缩检查：调用方可选传 `?next_role=` / `?port_min=` / `?port_max=`，
  // 命中则一并把收缩可行性判了（与  的 PATCH role 判定同源）。
  // `current_role` 缺省时按「不改角色」处理（只判端口区间悬空）。
  const nextRoleParam = c.req.query("next_role");
  const portMin = c.req.query("port_min");
  const portMax = c.req.query("port_max");
  const currentRole = c.req.query("current_role");
  let roleCheck: { ok: true } | { ok: false; condition: string; message: string } = { ok: true };
  if (nextRoleParam !== undefined) {
    roleCheck = checkRoleChange({
      node: { id: resolved.id, role: currentRole ?? null },
      impact: result.impact,
      check: { nextRole: nextRoleParam },
    });
  }
  if (portMin !== undefined && portMax !== undefined) {
    const leasePorts = await listActiveLeasePorts(resolved.id);
    const min = Number(portMin);
    const max = Number(portMax);
    roleCheck = checkRoleChange({
      node: { id: resolved.id, role: currentRole ?? null },
      impact: result.impact,
      check: {
        nextPortRange: { min: Number.isInteger(min) ? min : null, max: Number.isInteger(max) ? max : null },
        activeLeasePorts: leasePorts,
      },
    });
  }

  return c.json({
    data: {
      impact: result.impact,
      role_check: roleCheck.ok ? { ok: true } : { ok: false, condition: roleCheck.condition, message: roleCheck.message },
    },
  });
});

/* ------------------------------------------------------------------ *
 * DELETE /api/admin/node/:id/lifecycle
 * ------------------------------------------------------------------ */

/**
 * DELETE /api/admin/node/:id/lifecycle
 *
 * 物理删除节点（§13.4.3：永不隐式级联删除 Forward）。
 * 前置条件：lifecycle === "retiring" 且无任何依赖（Forward/binding/租约/池）。
 * 删除成功即节点行消失；DB 的 SET NULL 级联清 tunnel 指针与附属行，
 * 但 Forward 本身一行都不许静默消失——这就是为什么依赖清单非空即 409。
 */
nodeLifecycleRoutes.delete("/node/:id/lifecycle", async (c) => {
  const resolved = await resolveNodeId(db, c.req.param("id"));
  if (!resolved.ok) return nodeNotFound(c, resolved.message);
  const result = await deleteNode(resolved.id);
  if (!result.ok) return lifecycleError(c, result);
  return c.json({ data: { id: result.id, deleted: true } });
});
