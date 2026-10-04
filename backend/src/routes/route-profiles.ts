/**
 * V5-WP13.5B —— Route Profile HTTP 面（`DEVELOPMENT.md` §9.4.2–§9.4.6）。
 *
 * 挂载：`app.route("/api/route-profiles", routeProfilesRoutes)`（app.ts 一行）。
 * 契约（FROZEN）：`docs/v5-wp13-5b-route-profile-contract.md`。
 *
 * ── 为什么不是 /api/admin/* ──
 * Admin Console 与 User Console 走**同一套后端资源与 RBAC**，前端只做 UX 分层
 * （§9.4.1：前端 guard 只负责 UX，backend RBAC / workspace scope 才是安全真相）。
 * 因此这里用 workspace 域角色（`resolveWorkspaceAccess` 的 `node` 资源族，与
 * `routes/node-groups.ts` 同口径），而不是新增一个 admin 权限 key —— 多一个 key
 * 就多一处「谁该看到什么」的分叉。
 *
 * ── 读/写闸门 ──
 *   GET  → `read`（消费者可以看；具体可见性由 visibility 判定收紧）
 *   POST / PATCH → `manage`（编排是管理动作，不是普通成员能力）
 * 精细到「这条线路能不能被这个用户消费」的判定在服务层（`canConsumeRouteProfile`），
 * 路由层不复制一份。
 *
 * 响应封装：与既有路由一致 —— `{ data: ... }`，列表为
 * `{ data: { data, total, page, page_size } }`（前端 request() 剥一层 data）。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { canWorkspaceResourceAction, resolveWorkspaceAccess } from "../services/workspace.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import {
  analyzeRouteProfileImpact,
  applyRouteProfile,
  auditContextFrom,
  createRouteProfile,
  getRouteProfileDetail,
  listConsumableRouteProfiles,
  listRouteProfileVersions,
  listRouteProfiles,
  loadRouteProfileVersion,
  patchRouteProfile,
  publishRouteProfileVersion,
  type RouteProfileResult,
  type RouteProfileServiceError,
} from "../services/route-profile.ts";

export const routeProfilesRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

routeProfilesRoutes.use("*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  const action = method === "GET" || method === "HEAD" ? "read" : "manage";
  // TEAM-01 口径（与 node-groups 一致）：线路编排属于节点/网络资源族，
  // 因此资源族传 "node"，让自定义角色能表达「管理线路但不碰转发」。
  c.set("workspace", await resolveWorkspaceAccess(c, action, "node"));
  await next();
});

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user;
}

function auditCtx(c: Ctx) {
  return auditContextFrom(requireUser(c), {
    ip: c.get("ip") ?? null,
    userAgent: c.req.header("user-agent") ?? null,
  });
}

/** 统一出口：成功 `{data}`；失败带 code / error_layer / retryable / next_action（§13）。 */
function send<T>(c: Ctx, result: RouteProfileResult<T>, successStatus: 200 | 201 = 200) {
  if (!result.ok) {
    const e: RouteProfileServiceError = result;
    return c.json(
      {
        error: e.message,
        code: e.code,
        error_layer: e.error_layer,
        retryable: e.retryable,
        next_action: e.next_action,
        ...(e.data === undefined ? {} : { data: e.data }),
      },
      e.status,
    );
  }
  return c.json({ data: result.data }, successStatus);
}

function idParam(c: Ctx, name = "id"): number | null {
  const value = Number(c.req.param(name));
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function body(c: Ctx): Promise<Record<string, unknown>> {
  const raw = await c.req.json().catch(() => null);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/* ---------------------------------------------------------------- */
/* 列表 / 创建                                                       */
/* ---------------------------------------------------------------- */

routeProfilesRoutes.get("/", async (c) => {
  const workspace = c.get("workspace")!;
  const q = c.req.query();
  const enabledParam = q.enabled;
  const result = await listRouteProfiles(workspace.id, {
    page: Number(q.page ?? 1),
    page_size: Number(q.page_size ?? 20),
    keyword: q.keyword ?? "",
    visibility: q.visibility ?? null,
    enabled:
      enabledParam === undefined || enabledParam === ""
        ? null
        : enabledParam === "true" || enabledParam === "1",
  });
  if (!result.ok) return send(c, result);
  // 与 node-groups 列表同形：{ data: { data, total, page, page_size } }
  return c.json({ data: result.data });
});

routeProfilesRoutes.post("/", async (c) => {
  const workspace = c.get("workspace")!;
  const payload = await body(c);
  const result = await createRouteProfile({
    workspaceId: workspace.id,
    name: payload.name,
    description: payload.description,
    visibility: payload.visibility,
    enabled: payload.enabled,
    template: payload.template,
    assignments: payload.assignments,
    change_summary: payload.change_summary,
    audit: auditCtx(c),
  });
  return send(c, result, 201);
});

/**
 * 消费侧可见/可选列表（**只读**）。
 *
 * 放在 `/:id` 之前注册：否则 "available" 会被当成 id 解析。
 * 它的判定只用服务层的 `canConsumeRouteProfile`（enabled → 可见性 → 授权命中），
 * 无显式授权就看不到（fail-closed）。本版不做计费/entitlement 落库。
 */
routeProfilesRoutes.get("/available", async (c) => {
  const user = requireUser(c);
  const workspace = c.get("workspace")!;
  const result = await listConsumableRouteProfiles({
    workspaceId: workspace.id,
    isManager: canWorkspaceResourceAction(workspace, "manage", "node"),
    planIds: [],
  });
  if (!result.ok) return send(c, result);
  return c.json({ data: { data: result.data, total: result.data.length, user_id: user.id } });
});

/* ---------------------------------------------------------------- */
/* 详情 / metadata 编辑                                              */
/* ---------------------------------------------------------------- */

routeProfilesRoutes.get("/:id", async (c) => {
  const workspace = c.get("workspace")!;
  const id = idParam(c);
  if (id === null) return c.json({ error: "线路模板 ID 不合法", code: "invalid_input" }, 400);
  return send(c, await getRouteProfileDetail(id, workspace.id));
});

routeProfilesRoutes.patch("/:id", async (c) => {
  const workspace = c.get("workspace")!;
  const id = idParam(c);
  if (id === null) return c.json({ error: "线路模板 ID 不合法", code: "invalid_input" }, 400);
  const payload = await body(c);
  const result = await patchRouteProfile(id, workspace.id, {
    // 显式透传模板键：服务层收到它们会 400（模板内容变更只能发新版本）。
    ...payload,
    audit: auditCtx(c),
  });
  return send(c, result);
});

/* ---------------------------------------------------------------- */
/* 版本发布 / 版本查询                                                */
/* ---------------------------------------------------------------- */

routeProfilesRoutes.post("/:id/versions", async (c) => {
  const workspace = c.get("workspace")!;
  const id = idParam(c);
  if (id === null) return c.json({ error: "线路模板 ID 不合法", code: "invalid_input" }, 400);
  const payload = await body(c);
  const result = await publishRouteProfileVersion(id, workspace.id, {
    template: payload.template,
    expected_version: payload.expected_version,
    change_summary: payload.change_summary,
    audit: auditCtx(c),
  });
  return send(c, result, 201);
});

routeProfilesRoutes.get("/:id/versions", async (c) => {
  const workspace = c.get("workspace")!;
  const id = idParam(c);
  if (id === null) return c.json({ error: "线路模板 ID 不合法", code: "invalid_input" }, 400);
  const limit = Number(c.req.query("limit") ?? 50);
  return send(c, await listRouteProfileVersions(id, workspace.id, Number.isFinite(limit) ? limit : 50));
});

routeProfilesRoutes.get("/:id/versions/:version", async (c) => {
  const workspace = c.get("workspace")!;
  const id = idParam(c);
  const version = Number(c.req.param("version"));
  if (id === null || !Number.isInteger(version) || version < 1) {
    return c.json({ error: "线路模板 ID 或版本号不合法", code: "invalid_input" }, 400);
  }
  const loaded = await loadRouteProfileVersion(id, workspace.id, version);
  if (!loaded.ok) return send(c, loaded);
  return c.json({
    data: {
      route_profile_id: id,
      version: loaded.data.version,
      body: loaded.data.body,
      template: loaded.data.template,
    },
  });
});

/* ---------------------------------------------------------------- */
/* Impact Analysis（只读）与 apply（显式 rollout 入口）               */
/* ---------------------------------------------------------------- */

routeProfilesRoutes.get("/:id/impact", async (c) => {
  const workspace = c.get("workspace")!;
  const id = idParam(c);
  if (id === null) return c.json({ error: "线路模板 ID 不合法", code: "invalid_input" }, 400);
  const versionParam = c.req.query("version");
  const version = versionParam === undefined || versionParam === "" ? null : Number(versionParam);
  if (version !== null && (!Number.isInteger(version) || version < 1)) {
    return c.json({ error: "version 必须是正整数", code: "invalid_input" }, 400);
  }
  return send(c, await analyzeRouteProfileImpact(id, workspace.id, version));
});

routeProfilesRoutes.post("/:id/apply", async (c) => {
  const workspace = c.get("workspace")!;
  const id = idParam(c);
  if (id === null) return c.json({ error: "线路模板 ID 不合法", code: "invalid_input" }, 400);
  const payload = await body(c);
  const result = await applyRouteProfile({
    profileId: id,
    workspaceId: workspace.id,
    version: payload.version,
    forward_ids: payload.forward_ids,
    expected_revisions: payload.expected_revisions,
    dry_run: payload.dry_run,
    audit: auditCtx(c),
  });
  return send(c, result);
});
