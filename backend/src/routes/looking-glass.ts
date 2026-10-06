/**
 *  —— Looking Glass API（用户侧）。
 *
 * 契约：`docs/v5-wp19-latency-observability-contract.md` §3 D7 / §5  / §7 G19.9–G19.13。
 *
 * ── 端点 ──
 *   GET  /api/looking-glass/status          开关与线形上限（UI 据此决定是否显示入口）
 *   POST /api/looking-glass/nodes/:id/tests 对某个节点发起一次有界主动测试
 *
 * ── RBAC 归属（**不新增权限键**）──
 * 两条都要求 `node:read` + 工作空间作用域（D10：不得用 `node:manage` 代理执行权——
 * 把"能改节点"变成"能对任意公网目标发包"是权限放大）。结果只回给发起者，不落库
 * （D7⑤），因此不需要新的可见性模型。
 *
 * ── 为什么是**路由工厂**而不是进程级单例 ──
 * 挂载（`app.ts`）只写一行；但这一层的四类拒绝（默认关 / 跨租户 / 单飞 / 未广告动作）
 * 都是**安全边界**，必须能在不连 DB / 不连 Redis 的测试里逐个钉死。因此所有 IO 走
 * 注入（`service` / `workspace` / `resolveNodeParam`），默认实现用懒加载装配。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppVariables } from "../middlewares/auth.ts";
import {
  LOOKING_GLASS_CAVEATS,
  LOOKING_GLASS_DEFAULT_METHOD,
  LOOKING_GLASS_DEFAULT_TIMEOUT_MS,
  LOOKING_GLASS_ENABLED_ENV,
  LOOKING_GLASS_MAX_PINNED_ADDRESSES,
  LOOKING_GLASS_MAX_REQUESTED_TARGETS,
  LOOKING_GLASS_MAX_TIMEOUT_MS,
  LOOKING_GLASS_METHODS,
  LOOKING_GLASS_UNAVAILABLE_METHODS,
  defaultLookingGlassDeps,
  runLookingGlass,
  type LookingGlassDeps,
} from "../services/looking-glass.ts";

type Ctx = Context<{ Variables: AppVariables }>;

export interface LookingGlassRouteOptions {
  /** 服务依赖（默认 `defaultLookingGlassDeps()`：懒加载 DB/总线/审计）。 */
  service?: LookingGlassDeps;
  /** 工作空间访问解析；默认 `resolveWorkspaceAccess(c, "read", "node")`。 */
  workspace?: (c: Ctx) => Promise<{ id: number }>;
  /** 节点标识解析（数字主键或 node_id 字符串）；默认走 `resolveNodeId(db, param)`。 */
  resolveNodeParam?: (param: string) => Promise<number | null>;
  /** 平台管理员判定；默认 `super_admin || admin_roles.length > 0`（同 `adminRequired`）。 */
  isPlatformAdmin?: (c: Ctx) => boolean;
}

function defaultIsPlatformAdmin(c: Ctx): boolean {
  const user = c.get("user");
  return user?.super_admin === true || (user?.admin_roles?.length ?? 0) > 0;
}

export function createLookingGlassRoutes(options: LookingGlassRouteOptions = {}): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const service = options.service ?? defaultLookingGlassDeps();

  const workspaceOf = options.workspace ?? (async (c: Ctx) => {
    const { resolveWorkspaceAccess } = await import("../services/workspace.ts");
    const access = await resolveWorkspaceAccess(c, "read", "node");
    return { id: access.id };
  });
  const resolveNodeParam = options.resolveNodeParam ?? (async (param: string) => {
    const { db } = await import("../db.ts");
    const { resolveNodeId } = await import("../services/node-admin.ts");
    const resolved = await resolveNodeId(db, param);
    return resolved.ok ? resolved.id : null;
  });
  const isPlatformAdmin = options.isPlatformAdmin ?? defaultIsPlatformAdmin;

  /**
   * GET /api/looking-glass/status
   *
   * 只回"这个部署有没有开 + 线形上限是多少"。它**不**因为开关关闭而 403：
   * UI 需要能回答"为什么没有这个入口"，而一个会 403 的状态端点会让前端把
   * "未启用"显示成"出错了"。开关的**执行性**拒绝在 POST 上。
   */
  routes.get("/status", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "Unauthorized" });
    const enabled = await service.enabled();
    return c.json({
      data: {
        enabled,
        switch_env: LOOKING_GLASS_ENABLED_ENV,
        /** 关闭时平台管理员仍可用（D7④）；前端据此决定是否显示"管理员例外"。 */
        platform_admin_override: isPlatformAdmin(c),
        method: LOOKING_GLASS_METHODS[0],
        caps: {
          max_targets: LOOKING_GLASS_MAX_REQUESTED_TARGETS,
          max_pinned_addresses: LOOKING_GLASS_MAX_PINNED_ADDRESSES,
          default_timeout_ms: LOOKING_GLASS_DEFAULT_TIMEOUT_MS,
          max_timeout_ms: LOOKING_GLASS_MAX_TIMEOUT_MS,
          methods: [...LOOKING_GLASS_METHODS],
          /**
           * 本版本**不提供**的方法与原因（task-40）。
           *
           * 为什么显式回给前端：ForwardX 的方法集里有 traceroute/mtr，运维会照着找；
           * 不说清"为什么没有"就会被读成"这个产品没有诊断能力"，而真相是在我们的权限
           * 模型下做不到（raw socket 需要 CAP_NET_RAW，生产 install 用 --cap-drop ALL）。
           */
          unavailable_methods: LOOKING_GLASS_UNAVAILABLE_METHODS.map((entry) => ({ ...entry })),
        },
        targets: "public-only（私网/回环/链路本地/多播/保留段一律拒绝）",
        caveats: LOOKING_GLASS_CAVEATS,
      },
    });
  });

  /**
   * POST /api/looking-glass/nodes/:id/tests
   *
   * body: `{ targets: [{host, port}], method?, timeout_ms? }`
   *
   * `host` 可以是公网字面地址或域名（域名由**面板**解析后钉死成地址）。
   * 所有拒绝都带 `code` 与 `error_layer`，并且都发生在**发包之前**。
   */
  routes.post("/nodes/:id/tests", async (c) => {
    const user = c.get("user");
    if (!user) throw new HTTPException(401, { message: "Unauthorized" });
    const workspace = await workspaceOf(c);

    const nodeId = await resolveNodeParam(c.req.param("id"));
    if (nodeId === null) {
      return c.json({ error: "节点不存在", code: "not_found", error_layer: "resource_scope" }, 404);
    }

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "请求体必须是 JSON 对象", code: "invalid_body", error_layer: "runtime_admission" }, 400);
    }

    const result = await runLookingGlass(
      {
        nodeId,
        workspaceId: workspace.id,
        actorUserId: user.id,
        isPlatformAdmin: isPlatformAdmin(c),
        ip: c.get("ip") ?? null,
        targets: body.targets,
        method: body.method,
        timeoutMs: body.timeout_ms,
      },
      service,
    );
    if (!result.ok) {
      return c.json({ error: result.message, code: result.code, error_layer: result.error_layer }, result.status);
    }
    return c.json({ data: result.report });
  });

  return routes;
}

export const lookingGlassRoutes = createLookingGlassRoutes();
