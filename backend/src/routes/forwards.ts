/**
 * V4 user-facing Forward API.
 *
 * Forward is the product object. Tunnel stays an internal runtime record.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppVariables } from "../middlewares/auth.ts";
import { db } from "../db.ts";
import { canWorkspaceResourceAction, resolveWorkspaceAccess } from "../services/workspace.ts";
import { defaultDiagnoseDeps, diagnoseForward } from "../services/agent-diagnose.ts";
import {
  createForward,
  deleteForward,
  getForward,
  getForwardSummary,
  getForwardTraffic,
  listForwards,
  listForwardsPage,
  patchForward,
  previewForwardUpdate,
  runForwardAction,
  runForwardBatch,
  type ForwardAction,
  type ForwardServiceResult,
} from "../services/forward-service.ts";
import { parseForwardBatchRequest } from "../services/forward-batch.ts";
import { FORWARD_PROTOCOLS } from "../services/forward-contract.ts";
import {
  forwardListShape,
  forwardOrderBy,
  forwardPage,
  parseForwardListQuery,
} from "../services/forward-list-query.ts";

export const forwardsRoutes = new Hono<{ Variables: AppVariables }>();
type Ctx = Context<{ Variables: AppVariables }>;

forwardsRoutes.use("*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  const path = c.req.path;

  let action: "read" | "create" | "update" | "delete" = "read";
  if (method === "DELETE") action = "delete";
  else if (method === "POST" && /\/api\/forwards\/?$/.test(path)) {
    action = "create";
  } else if (method === "POST" && /\/diagnose\/?$/.test(path)) {
    // V4-WP11C: the probe is read-only (no desired-state change, no revision
    // bump). Requiring forward:update would tell a read-only role "you may not
    // diagnose the forward you can see", which is not the product rule.
    action = "read";
  } else if (method === "PATCH" || method === "PUT" || method === "POST") {
    action = "update";
  }

  c.set("workspace", await resolveWorkspaceAccess(c, action, "forward"));
  await next();
});

function workspace(c: Ctx): NonNullable<AppVariables["workspace"]> {
  const value = c.get("workspace");
  if (!value) throw new HTTPException(403, { message: "工作空间未授权" });
  return value;
}

function user(c: Ctx): NonNullable<AppVariables["user"]> {
  const value = c.get("user");
  if (!value) throw new HTTPException(401, { message: "Unauthorized" });
  return value;
}

/** Preliminary workspace checks cannot establish creator ownership. Query only the
 * scoped runtime identity; full-access identities keep service-level scope checks. */
async function authorizeForward(c: Ctx, id: number, action: "read" | "update" | "delete") {
  const access = workspace(c);
  if (canWorkspaceResourceAction(access, action, "forward")) return null;
  const row = await db.tunnel.findFirst({
    where: { id, workspace_id: access.id, category: "port_forward" },
    select: { user_id: true },
  });
  if (!row) return c.json({ error: "端口转发不存在", code: "not_found", error_layer: "resource_scope" }, 404);
  if (!canWorkspaceResourceAction(access, action, "forward", row.user_id === user(c).id)) {
    return c.json({ error: "无权操作该端口转发", code: "forbidden", error_layer: "rbac" }, 403);
  }
  return null;
}

function idParam(c: Ctx, name: string): number | null {
  const value = Number(c.req.param(name));
  return Number.isInteger(value) && value > 0 ? value : null;
}

function send<T>(
  c: Ctx,
  result: ForwardServiceResult<T>,
  successStatus: 200 | 201 = 200,
) {
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
  return c.json({ data: result.data }, successStatus);
}

const ForwardCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    mode: z.enum(["direct", "relay"]),
    protocol: z.enum(FORWARD_PROTOCOLS).optional(),
    // V5-WP5-A1: paths only. Shape is enforced here; existence is the Agent's
    // check (the panel cannot see the node's filesystem), and a missing file is
    // a build-time refusal on the node.
    tls_cert_path: z.string().trim().min(1).max(512).startsWith("/").optional(),
    tls_key_path: z.string().trim().min(1).max(512).startsWith("/").optional(),
    ingress_node_id: z.number().int().positive(),
    egress_node_id: z.number().int().positive().nullable().optional(),
    // V5.4：三跳路由的中间跳（省略 = 单跳）。schema 是 `.strict()` 的 —— 也就是说
    // 少了这一行，body 里的 `middle_node_id` 会被**拒绝**（400）而不是被静默丢掉。
    // 这个 400 是对的（未知字段 fail-closed），它暴露的是"服务层加了、路由层没加"
    // 这一半漏接线 —— 与协议/证书/健康/池内容那几次同类，只是这次发生在入参层。
    middle_node_id: z.number().int().positive().nullable().optional(),
    listen_port: z.number().int().min(1).max(65535).nullable().optional(),
    target_host: z.string().trim().min(1).max(255),
    target_port: z.number().int().min(1).max(65535),
    // V5.5 WP15：把出口腿委托给一个已信任的 peer panel（缺省 = 出口在本机）。
    // 形状在这里判；"这个 peer 存不存在/信不信任"由 service 层的
    // `validateFederatedEgressDeclaration` 判（唯一的实现，见 forward-hop.ts），
    // 失败返回契约 §6 的错误码而不是 500。
    federated_egress_peer: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/**
 * V4-WP1 §13.3.1 / §13.3.3：可编辑全集（与 create 的字段一致）+ `expected_revision`。
 *
 * `expected_revision` 是可选的乐观并发凭据，不是筛选条件——缺失说明客户端是
 * 首次请求或有意跳过并发检查；存在但不匹配 → 409（见 patchForward 内闸门）。
 */
const ForwardPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    mode: z.enum(["direct", "relay"]).optional(),
    ingress_node_id: z.number().int().positive().optional(),
    egress_node_id: z.number().int().positive().nullable().optional(),
    /** V5.4：中间跳（`null` = 回到单跳）。与入出口同样是运行态放置事实。 */
    middle_node_id: z.number().int().positive().nullable().optional(),
    listen_port: z.number().int().min(1).max(65535).nullable().optional(),
    target_host: z.string().trim().min(1).max(255).nullable().optional(),
    target_port: z.number().int().min(1).max(65535).nullable().optional(),
    // V5-WP5-A1: the tls front's paths are editable, with the SAME shape rule as
    // create. The protocol itself is deliberately NOT here: turning a tcp Forward
    // into a tls one is a different operation (port lease, target semantics and
    // the RELAY shape all change), and §6.1 did not freeze that semantics — so it
    // is refused by omission rather than guessed at.
    tls_cert_path: z.string().trim().min(1).max(512).startsWith("/").optional(),
    tls_key_path: z.string().trim().min(1).max(512).startsWith("/").optional(),
    /**
     * V5.5 WP15：`null` = 改回本机出口；省略 = 不变（候选合并的语义）。
     * peer 是否存在/已信任由 service 层判定（唯一实现），这里只判形状。
     */
    federated_egress_peer: z.string().trim().min(1).max(64).nullable().optional(),
    expected_revision: z.number().int().nonnegative().nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      Object.keys(v).some(
        (k) => k !== "expected_revision" && k !== "name",
      ) ||
      v.name !== undefined,
    { message: "至少提供一个有效输入字段" },
  );

const ACTIONS = new Set<ForwardAction>(["retry", "suspend", "resume"]);

/**
 * V4-WP9 §13.6：列表改为**服务端**分页 / 排序。
 *
 * 响应形状 `{ data: { data, total, page, page_size } }`（前端 request() 剥一层
 * 后即 `Paginated<PortForward>`），与 `GET /api/node-groups`、
 * `GET /api/tunnels` 的分页信封完全一致——同一产品里不能有两种分页形状。
 *
 * 兼容口径（重要）：
 *   · 客户端**显式带 page / page_size**才走分页信封；
 *   · 不带分页参数时返回裸数组（保持 WP4 及之前 `api.forwards.list()` 的契约，
 *     以及 E2E 脚本 / 仪表盘的 `slice(0,5)` 取用方式）。
 *   这条不是"过渡期双轨"：分页信封与裸数组都是冻结契约，前者是新 UI 的形态，
 *   后者是「取全部」的显式语义（服务端仍施加上限，防止无界查询）。
 *
 * 上限常量 `FORWARD_LIST_MAX_UNPAGED` 定义在 `forward-list-query.ts`——兼容端点
 * `/api/nodes/:ingressId/forwards` 用同一个常量，两处不能各写一个数字。
 */

forwardsRoutes.get("/", async (c) => {
  const ws = workspace(c);
  const q = c.req.query();
  const parsed = parseForwardListQuery(q);

  if (forwardListShape(q) === "all") {
    // 「取全部」的上限在 `listForwards` 服务层（单一落点），这里不再二次截断。
    return c.json({ data: await listForwards(ws.id, parsed.filters) });
  }

  const page = await listForwardsPage(ws.id, parsed.filters, {
    skip: parsed.skip,
    take: parsed.take,
    orderBy: forwardOrderBy(parsed.sort, parsed.order),
  });
  return c.json({
    data: forwardPage(page.data, page.total, parsed.page, parsed.page_size),
  });
});

forwardsRoutes.get("/summary", async (c) => {
  return c.json({ data: await getForwardSummary(workspace(c).id) });
});

forwardsRoutes.post("/", async (c) => {
  const parsed = ForwardCreateSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "端口转发参数不合法", code: "invalid_input" }, 400);
  }

  const ws = workspace(c);
  return send(
    c,
    await createForward(user(c).id, ws.id, parsed.data),
    201,
  );
});

forwardsRoutes.get("/:id/traffic", async (c) => {
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const days = Math.max(
    1,
    Math.min(90, Number(c.req.query("days") ?? 14) || 14),
  );
  return send(c, await getForwardTraffic(id, workspace(c).id, days));
});

forwardsRoutes.get("/:id", async (c) => {
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const row = await getForward(id, workspace(c).id);
  if (!row) {
    return c.json({ error: "端口转发不存在", code: "not_found" }, 404);
  }
  return c.json({ data: row });
});

forwardsRoutes.patch("/:id", async (c) => {
  // V4-WP1：PATCH 是「编辑」语义而非「改名字」——不再只接受 name 补丁。
  // 单用户/单窗口编辑最快，但两个浏览器标签先后保存必须被 expected_revision
  // 拦下（409），否则后保存者会静默覆盖前者的端口/节点选择。
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const parsed = ForwardPatchSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "端口转发参数不合法";
    return c.json({ error: message, code: "invalid_input" }, 400);
  }
  const denied = await authorizeForward(c, id, "update");
  if (denied) return denied;
  return send(c, await patchForward(id, workspace(c).id, parsed.data, user(c).id));
});

/**
 * V4-WP11C —— `POST /api/forwards/:id/diagnose`
 *
 * 只读诊断：探针目标由服务端从该转发的**已授权期望状态**推导（见
 * services/forward-probe-plan.ts），请求体不携带任何 host/port —— 否则这个
 * 端点会变成"用客户机房里的机器扫内网"的 SSRF 工具。
 *
 * 权限：read 级（forward:read），资源作用域照旧由 resolveWorkspaceAccess +
 * creator guard 保证；它不改 desired、不加 revision、不发业务流量。
 */
forwardsRoutes.post("/:id/diagnose", async (c) => {
  const id = idParam(c, "id");
  if (id === null) return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  const denied = await authorizeForward(c, id, "read");
  if (denied) return denied;
  const result = await diagnoseForward(id, workspace(c).id, defaultDiagnoseDeps());
  if (!result.ok) {
    return c.json({ error: result.message, code: result.code, error_layer: result.error_layer }, result.status);
  }
  return c.json({ data: result.report });
});

/**
 * V4-WP1 §13.3.3 preview：保存前影响面（不写库、不触发 apply）。
 *
 * 路由与 mutation 同源：同一个 zod schema、同一个 candidate resolver。
 * 因此「preview 显示可保存」与「PATCH 实际接受」不可能出现两种结论。
 * 注意：注册在 `/:id/:action` 之前，否则 action 参数会吃掉 "preview"。
 */
forwardsRoutes.post("/:id/preview", async (c) => {
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const parsed = ForwardPatchSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "端口转发参数不合法";
    return c.json({ error: message, code: "invalid_input" }, 400);
  }
  const denied = await authorizeForward(c, id, "update");
  if (denied) return denied;
  const u = c.get("user");
  return send(
    c,
    await previewForwardUpdate(
      id,
      workspace(c).id,
      parsed.data,
      u?.id ?? undefined,
    ),
  );
});

/**
 * V4-WP9 §13.6：批量 retry / suspend / resume。
 *
 * 为什么是独立路径 `/batch` 而不是给 `POST /api/forwards/:id/:action` 加数组形态：
 * 单条与批量的**错误语义不同**——单条失败整请求失败（4xx/5xx），批量失败是
 * 逐条结果 + 200。把两种语义塞进一个端点会让客户端无法判断该看 `error` 还是
 * `results`。路由注册在 `/:id/:action` **之前**，否则 `:id` 会吃掉 "batch"。
 *
 * 限流：见 rate-limit.ts 的 `forward-batch` 规则（必须在 `api-global` 之前命中）。
 */
forwardsRoutes.post("/batch", async (c) => {
  const parsed = parseForwardBatchRequest(
    await c.req.json().catch(() => null),
  );
  if ("message" in parsed) {
    return c.json({ error: parsed.message, code: "invalid_input" }, 400);
  }
  const payload = await runForwardBatch(
    parsed.ids,
    parsed.action,
    workspace(c).id,
    (row: { user_id: number }) => canWorkspaceResourceAction(
      workspace(c), "update", "forward", row.user_id === user(c).id,
    ),
  );
  return c.json({ data: payload });
});

forwardsRoutes.post("/:id/:action", async (c) => {
  const id = idParam(c, "id");
  const action = c.req.param("action") as ForwardAction;
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  if (!ACTIONS.has(action)) {
    return c.json({ error: "不支持的端口转发动作", code: "invalid_input" }, 400);
  }
  const denied = await authorizeForward(c, id, "update");
  if (denied) return denied;
  return send(c, await runForwardAction(id, action, workspace(c).id));
});

forwardsRoutes.delete("/:id", async (c) => {
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const denied = await authorizeForward(c, id, "delete");
  if (denied) return denied;
  return send(c, await deleteForward(id, workspace(c).id));
});
