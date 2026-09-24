/**
 * 审计日志中间件 —— 请求后 fire-and-forget 落库
 *
 * 挂在 `authRequired` **之后**（需要 `c.get("user")` 与 `c.get("ip")`），
 * 位置在 app.ts 中：
 *   ip 提取 → 认证 → **审计** → 限流 → 路由
 * 先审计后限流，保证「被限流的请求」同样留下痕迹。
 *
 * 记录规则见 `services/audit.ts#shouldAudit`；本中间件只负责「取上下文 →
 * 构造记录 → 异步写入 → 重抛错误」。写入失败被吞掉，绝不影响主响应。
 */
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { AppVariables } from "./auth.ts";
import { buildAuditEntry, shouldAudit, writeAudit } from "../services/audit.ts";

export interface AuditMiddlewareOptions {
  enabled?: boolean;
}

function enabledFromEnv(): boolean {
  return (process.env.AUDIT_LOG_ENABLED ?? "true") !== "false";
}

export function createAuditMiddleware(options: AuditMiddlewareOptions = {}) {
  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const enabled = options.enabled ?? enabledFromEnv();
    const method = c.req.method;
    const path = c.req.path;
    if (!enabled || !shouldAudit(path, method)) return await next();

    let status = 0;
    let thrown: unknown;
    try {
      await next();
      status = c.res?.status ?? 0;
    } catch (e) {
      thrown = e;
      status = e instanceof HTTPException ? e.status : 500;
    }

    const user = c.get("user");
    await writeAudit(
      buildAuditEntry({
        method,
        path,
        status,
        ip: c.get("ip") ?? null,
        userAgent: c.req.header("user-agent") ?? null,
        user: user
          ? { id: user.id, email: user.email, super_admin: user.super_admin, admin_roles: user.admin_roles }
          : null,
      }),
    );

    if (thrown) throw thrown;
  });
}
