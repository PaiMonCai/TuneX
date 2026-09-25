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
  runForwardAction,
  type ForwardAction,
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

const ForwardPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

const ACTIONS = new Set<ForwardAction>(["retry", "suspend", "resume"]);

forwardsRoutes.get("/", async (c) => {
  const ws = workspace(c);
  const q = c.req.query();
  const mode = q.mode === "direct" || q.mode === "relay"
    ? (q.mode as ForwardMode)
    : undefined;

  const rows = await listForwards(ws.id, {
    mode,
    apply_status: q.apply_status?.trim() || undefined,
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
  const id = idParam(c, "id");
  if (id === null) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const parsed = ForwardPatchSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "端口转发参数不合法", code: "invalid_input" }, 400);
  }
  return send(c, await patchForward(id, workspace(c).id, parsed.data));
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
