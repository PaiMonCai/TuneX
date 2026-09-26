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
  patchForward,
  previewForwardUpdate,
  runForwardAction,
  type ForwardAction,
  type ForwardApplyStatus,
  type ForwardMode,
  type ForwardServiceResult,
} from "../services/forward-service.ts";

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
const APPLY_STATUSES = new Set<ForwardApplyStatus>([
  "pending",
  "applying",
  "active",
  "error",
  "suspended",
]);

forwardsRoutes.get("/", async (c) => {
  const ws = workspace(c);
  const q = c.req.query();
  const mode = q.mode === "direct" || q.mode === "relay"
    ? (q.mode as ForwardMode)
    : undefined;
  const applyStatus = APPLY_STATUSES.has(q.apply_status as ForwardApplyStatus)
    ? (q.apply_status as ForwardApplyStatus)
    : undefined;
  const ingressNodeId = Number(q.ingress_node_id);
  const egressNodeId = Number(q.egress_node_id);

  const rows = await listForwards(ws.id, {
    mode,
    apply_status: applyStatus,
    ingress_node_id:
      Number.isInteger(ingressNodeId) && ingressNodeId > 0
        ? ingressNodeId
        : undefined,
    egress_node_id:
      Number.isInteger(egressNodeId) && egressNodeId > 0
        ? egressNodeId
        : undefined,
    keyword: q.keyword?.trim() || undefined,
  });
  return c.json({ data: rows });
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
