/**
 * V4-WP5 — Node Lifecycle API（管理端：生命周期变更 / 影响检查 / 退役删除）
 *
 * 依据 `DEVELOPMENT.md` §13.4。挂载（app.ts）：`/api/admin`。
 * 认证/权限沿用挂载点的中间件（adminRequired → adminPermissionGuard）。
 *
 * ── 端点总览（全部落在 `nodes` 资源前缀，见文件末 RBAC 说明）──
 *   GET    /api/admin/node/:id/lifecycle        单节点生命周期视图（含三层状态投影）
 *   PATCH  /api/admin/node/:id/lifecycle        变更生命周期（+note）
 *   GET    /api/admin/node/:id/impact           影响检查（删除/收缩前先看这里）
 *   DELETE /api/admin/node/:id/lifecycle        retiring 后物理删除
 *
 * ── 与 node-admin.ts 的分工（避免两文件同时改同一路径）──
 * node-admin.ts 负责角色 / 出口池 / 凭据状态（WP10），本文件负责生命周期
 * （WP5）。两者共用 `resolveNodeId`（同一声明的 id → 主键解析口径），但
 * **不共享路由注册表**：node-admin.ts 已注册 `/node/:id/role` 等，本文件新增的
 * 是 `/node/:id/lifecycle` 与 `/node/:id/impact`、`DELETE /node/:id/lifecycle`，
 * 不发生覆盖。Hono 按注册顺序匹配，同路径后者覆盖前者；本文件注册在
 * node-admin.ts 之后（app.ts），但因路径不同，无冲突。
 *
 * ── 凭据纪律 ──
 * 响应只回 LifecycleNodeRow 投影（见 `lifecycleViewResponse`）：凭据只给布尔
 * `has_credential`，**既不明文也不哈希**。与 node-admin.ts 的
 * `const { node_credential_hash: _hash, ...node }` 同一纪律。
 *
 * ── 限流 ──
 * PATCH / DELETE 是敏感写，沿用 `api-global`（app.ts 全局，user 维度）。
 * 决策记录（偏离报告 §4 的 `node-lifecycle` 专用规则）：不单独挂更严的规则。
 * 理由：lifecycle 变更不是凭据轮换那种高频攻击面，且非法变更会被 409 挡住，
 * 滥用者拿不到额外能力。若运营后证明需要更严的用户维度限额，再加规则时必须
 * 插在 `api-global` **之前**（rate-limit.ts 按注册顺序首个命中生效），否则
 * 会被 api-global 先匹配而静默失效。
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
 * （message 兼容前端 ApiError 取文案；condition/dependencies 原样透传，
 * §13.5 要求「运行条件拒绝必须使用可区分的错误码」——丢掉 condition 就等于
 * 把所有拒绝渲染成同一句「操作失败」）。
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
 *   health       —— 本期不回（WP6 telemetry）
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
  // 命中则一并把收缩可行性判了（与 WP10 的 PATCH role 判定同源）。
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
