/**
 * 中间件链 —— authRequired / adminRequired / adminPermissionGuard /
 * superAdminRequired (roles independent of billing/license)
 * 依据: auth-rbac-source-verification-report.md §1-§3
 */
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { getCookie } from "hono/cookie";
import { db } from "../db.ts";
import { redis, RedisKeys } from "../redis.ts";
import { env } from "../env.ts";
import { verifyAccessToken, isUUID } from "../auth.ts";
import { resolveUserByKey } from "../services/user-keys.ts";
import {
  getEffectiveAccess,
  resolveAdminRoute,
  requiredLevel,
  levelSatisfies,
  STAFF_SHARED_KEY,
  SUPER_ADMIN_KEY,
} from "../permissions.ts";

export type AuthedUser = Awaited<ReturnType<typeof loadUserWithRoles>>;

export interface AppVariables {
  user?: NonNullable<AuthedUser>;
  ip?: string;
  workspace?: import("../services/workspace.ts").WorkspaceAccess;
}

/** 统一加载用户（含 admin_roles） */
export async function loadUserWithRoles(id: number) {
  return db.user.findUnique({
    where: { id },
    include: { admin_roles: true },
  });
}

/** 请求方 IP：x-forwarded-for[0] ?? x-real-ip ?? cf-connecting-ip */
export function extractIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return headers.get("x-real-ip") ?? headers.get("cf-connecting-ip") ?? "";
}

/**
 * 免认证路径白名单（原版 noAuthPathsRegex，本次任务指定集合）
 * /api/auth/*、/api/pay/*\/callback、/api/tunnel/observer、/healthz
 * 另保留原版的 /api/system/config/site、/api/tunnel/subscription、/api/license
 */
const NO_AUTH_PATTERNS: RegExp[] = [
  /^\/api\/auth\/.*/,
  /^\/api\/pay\/[^/]+\/callback$/,
  /^\/api\/tunnel\/observer$/,
  /^\/api\/tunnel\/subscription$/,
  /^\/api\/system\/config\/site$/,
  /^\/api\/license(\/.*)?$/,
  /^\/healthz$/,
  /^\/queuedash(\/.*)?$/,
  /^\/openapi\.json$/,
  /^\/docs$/,
  /^\/socket\.io(\/.*)?$/,
];

export function isNoAuthPath(path: string): boolean {
  return NO_AUTH_PATTERNS.some((re) => re.test(path));
}

/** 冒充机制（x-impersonation + Redis，TTL 2h），仅超管可用 */
export const IMPERSONATION_HEADER = "x-impersonation";
export const IMPERSONATION_TTL_SECONDS = 2 * 60 * 60;

// TEN-02：冒充票据是 token 自作用域（token 全局唯一、值只描述「哪个用户」），
// 键走 `ws:global:impersonation:<token>`。

async function resolveImpersonation(
  headers: Headers,
  user: NonNullable<AuthedUser>,
): Promise<NonNullable<AuthedUser>> {
  if (!user.super_admin) return user;
  const token = headers.get(IMPERSONATION_HEADER);
  if (!token) return user;

  let targetId: string | null = null;
  try {
    targetId = await redis.get(RedisKeys.impersonation(token));
  } catch {
    return user;
  }
  if (!targetId) return user;

  const target = await loadUserWithRoles(Number(targetId));
  if (!target || target.status === "inactive") return user;
  return target;
}

/**
 * authRequired —— 双通道认证
 * 通道 A: Cookie `access`（JWT，HS256）
 * 通道 B: Authorization: Bearer <uuid v4>（查 user.api_key_hash，见 services/user-keys.ts：
 *   新凭据只落 sha256 哈希，旧明文行在首次认证时惰性迁移）
 */
export const authRequired = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const path = c.req.path;
  if (isNoAuthPath(path)) return await next();

  // ---- 通道 A: Cookie JWT ----
  const cookie = getCookie(c, env.cookieName);
  if (cookie) {
    const payload = await verifyAccessToken(cookie);
    if (!payload) throw new HTTPException(401, { message: "Unauthorized" });

    const userId = Number(payload.sub);
    if (!Number.isInteger(userId)) throw new HTTPException(401, { message: "Unauthorized" });

    // ① Redis 映射缓存（sub → user.id）
    // TEN-02：JWT sub 映射是**账户**数据（一个用户可属于多个 workspace），
    // 不属于任何单个租户 → `ws:global:user:<sub>:id`。
    let user: NonNullable<AuthedUser> | null = null;
    try {
      const cachedId = await redis.get(RedisKeys.userSub(payload.sub));
      if (cachedId) user = await loadUserWithRoles(Number(cachedId));
    } catch {
      /* Redis 故障时不阻断认证 */
    }

    // ② 缓存未命中 → 直接查库
    if (!user) {
      user = await loadUserWithRoles(userId);
      if (!user) throw new HTTPException(401, { message: "Unauthorized" });
      try {
        await redis.set(RedisKeys.userSub(payload.sub), String(user.id));
      } catch {
        /* 忽略 */
      }
    }

    if (user.status === "inactive") throw new HTTPException(403, { message: "用户账户已被封禁" });

    c.set("user", await resolveImpersonation(c.req.raw.headers, user));
    return await next();
  }

  // ---- 通道 B: Bearer API Key ----
  const authHeader = c.req.header("authorization") ?? "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  if (!bearer) throw new HTTPException(401, { message: "Unauthorized" });

  if (!isUUID(bearer)) throw new HTTPException(401, { message: "Unauthorized" });

  // SEC-02：凭据哈希化。先查哈希列，未命中再查明文列（惰性迁移命中时同事务写哈希清
  // 明文）；恒定时间复核已由 hash 唯一索引等值匹配 + 迁移路径内的 safeEqual 覆盖。
  const user = await resolveUserByKey("api_key", bearer);
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });

  if (user.status === "inactive") throw new HTTPException(403, { message: "用户账户已被封禁" });

  c.set("user", user);
  return await next();
});

/** adminRequired —— 身份闸门 */
export const adminRequired = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const user = c.get("user");
  if (user?.super_admin) return await next();
  if (user && user.admin_roles.length > 0 && getEffectiveAccess(user).size > 0) {
    return await next();
  }
  throw new HTTPException(403, { message: "Forbidden" });
});

/** adminPermissionGuard —— 细粒度资源闸门 */
export const adminPermissionGuard = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  if (user?.super_admin) return await next();

  // 路由挂载带 /api 前缀；权限表按原版以 /admin/* 为键，故先剥离 /api
  const normalizedPath = c.req.path.replace(/^\/api(?=\/)/, "");
  const entry = resolveAdminRoute(normalizedPath);
  if (!entry) throw new HTTPException(403, { message: "无权访问该功能" });
  if (entry.key === SUPER_ADMIN_KEY) throw new HTTPException(403, { message: "Forbidden" });
  if (entry.key === STAFF_SHARED_KEY) return await next();

  const granted = getEffectiveAccess(user).get(entry.key);
  const required = requiredLevel(c.req.method);
  if (granted && levelSatisfies(granted, required)) return await next();

  throw new HTTPException(403, { message: "无权访问该功能" });
});

/** superAdminRequired */
export const superAdminRequired = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  if (c.get("user")?.super_admin) return await next();
  throw new HTTPException(403, { message: "Forbidden" });
});
