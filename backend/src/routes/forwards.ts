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
import { resolveWorkspaceAccess } from "../services/workspace.ts";
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
  type ForwardAction,
  type ForwardServiceResult,
} from "../services/forward-service.ts";
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
  } else if (method === "PATCH" || method === "PUT" || method === "POST") {
    action = "update";
  }

  c.set("workspace", await resolveWorkspaceAccess(c, action, "tunnel"));
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
    ingress_node_id: z.number().int().positive(),
    egress_node_id: z.number().int().positive().nullable().optional(),
    listen_port: z.number().int().min(1).max(65535).nullable().optional(),
    target_host: z.string().trim().min(1).max(255),
    target_port: z.number().int().min(1).max(65535),
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
    listen_port: z.number().int().min(1).max(65535).nullable().optional(),
    target_host: z.string().trim().min(1).max(255).nullable().optional(),
    target_port: z.number().int().min(1).max(65535).nullable().optional(),
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
  return send(c, await patchForward(id, workspace(c).id, parsed.data));
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

forwardsRoutes.post("/:id/:action", async (c) => {
  const id = idParam(c, "id");
  const action = c.req.param("action") as ForwardAction;
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  if (!ACTIONS.has(action)) {
    return c.json({ error: "不支持的端口转发动作", code: "invalid_input" }, 400);
  }
  return send(c, await runForwardAction(id, action, workspace(c).id));
});

forwardsRoutes.delete("/:id", async (c) => {
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  return send(c, await deleteForward(id, workspace(c).id));
});
