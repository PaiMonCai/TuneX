/**
 * V5-WP17.2 —— DNS provider 的增 / 删 / 查（**凭据必须封存**；零外呼）。
 *
 * 为什么 provider 单独一个前缀（`/api/ddns/providers`）而不是挂在转发下面：
 * **凭据属于设置域，不属于某一条转发**。挂在转发下面会让"这条转发的主人能改平台凭据"
 * 变成可能，而凭据是跨转发复用的资源。契约 F6 ③ 因此把它放在 `settings` family：
 * 读 `settings:read`、写 `settings:manage` —— 与"管理节点组"那类组合权限同一套判据。
 *
 * 这里**只落库**：创建 provider 不验证 token 是否有效、不做任何网络调用（执行器是 WP17.3）。
 * 想让"凭据对不对"有一个真相，就得有一个负责**发请求**的人 —— 把它塞进 CRUD 会让创建接口
 * 变成一条隐式的出网通道（多租户下正是要避免的）。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { resolveWorkspaceAccess } from "../services/workspace.ts";
import {
  DDNS_ERROR_CODES,
  createDnsProvider,
  deleteDnsProvider,
  listDnsProviders,
} from "../services/ddns-binding.ts";
import type { DdnsDb, DdnsDeps, DdnsResult } from "../services/ddns-binding.ts";

export const ddnsRoutes = new Hono<{ Variables: AppVariables }>();

ddnsRoutes.use("*", async (c, next) => {
  const readOnly = c.req.method === "GET" || c.req.method === "HEAD";
  c.set("workspace", await resolveWorkspaceAccess(c, readOnly ? "read" : "manage", "settings"));
  await next();
});

type Ctx = Context<{ Variables: AppVariables }>;

function workspaceOf(c: Ctx): NonNullable<AppVariables["workspace"]> {
  const value = c.get("workspace");
  // 上面的 `use("*")` 一定会设置它；这里只是把"类型上可选"收成"运行期必然存在"，
  // 而不是在各处写 `!` —— 断言散开之后，真出问题时就找不到是**谁**没设置它。
  if (!value) throw new Error("ddns routes require a resolved workspace");
  return value;
}

function user(c: Ctx): NonNullable<AppVariables["user"]> {
  const value = c.get("user");
  if (!value) throw new Error("ddns routes require an authenticated user");
  return value;
}

function deps(c: Ctx): DdnsDeps {
  return {
    db: db as unknown as DdnsDb,
    // 平台级 provider（`workspace_id = NULL`）只有平台管理员能用 —— 与中间件同一判据。
    isPlatformAdmin: async () => user(c).super_admin === true,
  };
}

function sendDdns<T>(c: Ctx, result: DdnsResult<T>, successStatus: 200 | 201 = 200) {
  if (!result.ok) {
    const status =
      result.code === DDNS_ERROR_CODES.dns_provider_not_found
        ? 404
        : result.code === DDNS_ERROR_CODES.dns_provider_forbidden
          ? 403
          : 400;
    return c.json({ error: result.error, code: result.code, error_layer: "ddns" }, status);
  }
  return c.json({ data: result.value }, successStatus);
}

/**
 * 凭据形状。`token` 必填；`endpoint` 可覆盖（Gate 用本地 stub，契约 F6 明确不新增 provider 类型）；
 * `zone` 可选。**这里不校验它们是否真的能用** —— 那是执行器的事。
 */
const ProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.string().trim().min(1).max(40),
    credential: z
      .object({
        token: z.string().trim().min(1).max(4096),
        endpoint: z.string().trim().max(255).optional(),
        zone: z.string().trim().max(255).optional(),
      })
      .strict(),
    platform_level: z.boolean().optional(),
  })
  .strict();

ddnsRoutes.get("/providers", async (c) => {
  const result = await listDnsProviders(deps(c), {
    workspaceId: workspaceOf(c).id,
    userId: user(c).id,
  });
  return sendDdns(c, result);
});

ddnsRoutes.post("/providers", async (c) => {
  const parsed = ProviderSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "provider 参数不合法", code: "invalid_input" }, 400);
  }
  const result = await createDnsProvider(deps(c), {
    workspaceId: workspaceOf(c).id,
    userId: user(c).id,
    name: parsed.data.name,
    type: parsed.data.type,
    credential: parsed.data.credential,
    ...(parsed.data.platform_level === undefined ? {} : { platformLevel: parsed.data.platform_level }),
  });
  return sendDdns(c, result, 201);
});

ddnsRoutes.delete("/providers/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) {
    return c.json({ error: "ID 不合法", code: "invalid_input" }, 400);
  }
  const result = await deleteDnsProvider(deps(c), {
    workspaceId: workspaceOf(c).id,
    userId: user(c).id,
    providerId: id,
  });
  return sendDdns(c, result);
});
