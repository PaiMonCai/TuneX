/**
 * 中间件链 —— authRequired / adminRequired / adminPermissionGuard /
 * superAdminRequired / businessLicenseRequired
 * 依据: relayx-auth-rbac-source-verification-report.md §1-§3
 */
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { getCookie } from "hono/cookie";
import { db } from "../db.ts";
import { redis, RedisKeys } from "../redis.ts";
import { env } from "../env.ts";
import { verifyAccessToken, isUUID, safeEqual } from "../auth.ts";
import { licenseService } from "../services/license.ts";
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
 * 通道 B: Authorization: Bearer <uuid v4>（user.api_key）
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

  // 个人授权禁用 API Key（原版语义）
  const license = await licenseService.getLicense();
  if (license && license.type !== "business") {
    throw new HTTPException(403, { message: "请购买商业授权" });
  }

  const user = await db.user.findUnique({
    where: { api_key: bearer },
    include: { admin_roles: true },
  });
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });

  // 恒定时间比较复核（防时序侧信道）
  if (!safeEqual(user.api_key, bearer)) throw new HTTPException(401, { message: "Unauthorized" });

  if (user.status === "inactive") throw new HTTPException(403, { message: "用户账户已被封禁" });

  c.set("user", user);
  return await next();
});

/** adminRequired —— 身份闸门 */
export const adminRequired = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const user = c.get("user");
  if (user?.super_admin) return await next();
  if (
    user?.admin_roles?.length &&
    (await licenseService.isBusinessLicense()) &&
    getEffectiveAccess(user).size > 0
  ) {
    return await next();
  }
  throw new HTTPException(403, { message: "Forbidden" });
});

/** adminPermissionGuard —— 细粒度资源闸门 */
export const adminPermissionGuard = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const user = c.get("user");
  if (user?.super_admin) return await next();

  // 路由挂载带 /api 前缀；权限表按原版以 /admin/* 为键，故先剥离 /api
  const normalizedPath = c.req.path.replace(/^\/api(?=\/)/, "");
  const entry = resolveAdminRoute(normalizedPath);
  if (!entry) throw new HTTPException(403, { message: "无权访问该功能" });
  if (entry.key === SUPER_ADMIN_KEY) throw new HTTPException(403, { message: "Forbidden" });
  if (entry.key === STAFF_SHARED_KEY) return await next();

  if (!(await licenseService.isBusinessLicense())) {
    throw new HTTPException(403, { message: "无权访问该功能" });
  }

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

/** businessLicenseRequired —— 无 license 放行，个人授权 403 */
export const businessLicenseRequired = createMiddleware<{ Variables: AppVariables }>(
  async (c, next) => {
    const license = await licenseService.getLicense();
    if (license && license.type !== "business") {
      throw new HTTPException(403, { message: "请购买商业授权" });
    }
    return await next();
  },
);
