import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppVariables } from "../middlewares/auth.ts";
import { resolveWorkspaceAccess } from "../services/workspace.ts";
import {
  LinkResourceError, listLinks, getLink, createLink, updateLink, deployLink,
  retireLink, createLinkForward, updateLinkForward, actionLinkForward,
} from "../services/link-resource.ts";

export const linksRoutes = new Hono<{ Variables: AppVariables }>();
linksRoutes.use("*", async (c, next) => {
  // Carrier administration owns every binding it manages, like node routes.
  const action = ["GET", "HEAD"].includes(c.req.method) ? "read" : "manage";
  c.set("workspace", await resolveWorkspaceAccess(c, action, "node"));
  if (!(["GET", "HEAD"].includes(c.req.method)) && /\/forwards(?:\/|$)/.test(c.req.path)) {
    const forwardAction = c.req.method === "POST" && /\/forwards\/?$/.test(c.req.path) ? "create" : "update";
    await resolveWorkspaceAccess(c, forwardAction, "forward");
    if (/\/actions\/?$/.test(c.req.path)) {
      const payload = await c.req.json().catch(() => null);
      if (payload?.action === "delete") await resolveWorkspaceAccess(c, "delete", "forward");
    }
  }
  await next();
});
linksRoutes.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  if (error instanceof LinkResourceError) return c.json({ error: error.code, code: error.code }, error.status);
  if (error instanceof z.ZodError) return c.json({ error: "参数不合法", code: "invalid_input" }, 400);
  const code = (error as { code?: unknown }).code;
  if (code === "P2002") return c.json({ error: "资源或版本已存在", code: "revision_conflict" }, 409);
  // Never echo compiler input, ORM errors or raw executable output (key material).
  return c.json({ error: "连接资源操作未完成", code: "link_operation_failed" }, 503);
});
const positive = z.coerce.number().int().positive().max(2_147_483_647);
linksRoutes.get("/", async (c) => c.json({ data: await listLinks(c.get("workspace")!.id) }));
linksRoutes.post("/", async (c) => c.json({ data: await createLink(c.get("workspace")!.id,
  c.get("user")!.id, await c.req.json()) }, 201));
linksRoutes.get("/:id", async (c) => c.json({ data: await getLink(c.get("workspace")!.id, positive.parse(c.req.param("id"))) }));
linksRoutes.put("/:id/config", async (c) => {
  const input = z.object({ expected_version: positive, config: z.unknown() }).strict().parse(await c.req.json());
  return c.json({ data: await updateLink(c.get("workspace")!.id, positive.parse(c.req.param("id")), input.expected_version, input.config) });
});
linksRoutes.post("/:id/deploy", async (c) => c.json({ data: await deployLink(c.get("workspace")!.id, positive.parse(c.req.param("id"))) }));
linksRoutes.post("/:id/rotate-key", async (c) => c.json({ data: await deployLink(c.get("workspace")!.id, positive.parse(c.req.param("id")), true) }));
linksRoutes.delete("/:id", async (c) => c.json({ data: await retireLink(c.get("workspace")!.id, positive.parse(c.req.param("id"))) }));
linksRoutes.post("/:id/forwards", async (c) => c.json({ data: await createLinkForward(c.get("workspace")!.id,
  positive.parse(c.req.param("id")), c.get("user")!.id, await c.req.json()) }, 201));
linksRoutes.put("/:id/forwards/:forwardId", async (c) => {
  const input = z.object({ expected_revision: z.number().int().min(0), binding: z.unknown() }).strict().parse(await c.req.json());
  return c.json({ data: await updateLinkForward(c.get("workspace")!.id, positive.parse(c.req.param("id")),
    positive.parse(c.req.param("forwardId")), c.get("user")!.id, input.expected_revision, input.binding) });
});
linksRoutes.post("/:id/forwards/:forwardId/actions", async (c) => {
  const input = z.object({ action: z.enum(["suspend", "resume", "retry", "delete"]) }).strict().parse(await c.req.json());
  return c.json({ data: await actionLinkForward(c.get("workspace")!.id, positive.parse(c.req.param("id")),
    positive.parse(c.req.param("forwardId")), input.action, c.get("user")!.id) });
});
