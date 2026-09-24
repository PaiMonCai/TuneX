/**
 * 认证路由（全部位于免认证白名单 /api/auth/* 内）
 * - POST /api/auth/register
 * - POST /api/auth/login   → 签发 JWT + Set-Cookie access
 * - POST /api/auth/logout  → 清 cookie
 * - GET  /api/auth/me      → 端点内自行解析身份（白名单不跑全局 authRequired）
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import { db } from "../db.ts";
import { env } from "../env.ts";
import { redis, RedisKeys } from "../redis.ts";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  serializeCookie,
  verifyAccessToken,
  isUUID,
  newApiKey,
} from "../auth.ts";
import { systemConfig } from "../services/config.ts";
import { createPersonalWorkspace } from "../services/workspace.ts";
import { licenseService } from "../services/license.ts";
import { loadUserWithRoles, type AppVariables } from "../middlewares/auth.ts";

export const authRoutes = new Hono<{ Variables: AppVariables }>();

function publicUser(u: {
  id: number;
  email: string;
  super_admin: boolean;
  api_key: string;
  balance: number;
  status: string;
  created_at: Date;
}) {
  return {
    id: u.id,
    email: u.email,
    super_admin: u.super_admin,
    api_key: u.api_key,
    balance: u.balance,
    status: u.status,
    created_at: u.created_at,
  };
}

const RegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "密码至少 8 位"),
  ref: z.coerce.number().int().optional(),
});

authRoutes.post("/register", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = RegisterSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "参数错误", details: parsed.error.flatten() }, 400);
  }
  const { email, password, ref } = parsed.data;

  if (!(await systemConfig.allowRegister())) {
    return c.json({ error: "当前站点不允许注册" }, 403);
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return c.json({ error: "邮箱已注册" }, 409);

  // 推荐人解析（cookie ref 或 body.ref，均为 user.id）
  let parentId: number | undefined;
  const refCookie = c.req.header("cookie")?.match(/(?:^|;\s*)ref=([^;]+)/)?.[1];
  const refId = ref ?? (refCookie ? Number(refCookie) : undefined);
  if (refId && Number.isInteger(refId)) {
    const parent = await db.user.findUnique({ where: { id: refId } });
    if (parent) parentId = parent.id;
  }

  // 首个用户自动成为超管（原版语义）
  const anySuperAdmin = await db.user.findFirst({ where: { super_admin: true } });
  const superAdmin = !anySuperAdmin;

  const passwordHash = await hashPassword(password);

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { email, super_admin: superAdmin, parent_id: parentId, api_key: newApiKey() },
    });
    await tx.userCredential.create({
      data: { user_id: created.id, password: passwordHash },
    });
    await createPersonalWorkspace(tx, created);
    return created;
  });

  return c.json({ data: publicUser(user) }, 201);
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRoutes.post("/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "参数错误" }, 400);

  const { email, password } = parsed.data;

  const user = await db.user.findUnique({ where: { email }, include: { credential: true } });
  // 统一错误信息，避免账号枚举
  if (!user || !user.credential) return c.json({ error: "邮箱或密码错误" }, 401);
  if (user.status === "inactive") return c.json({ error: "用户账户已被封禁" }, 403);

  const ok = await verifyPassword(password, user.credential.password);
  if (!ok) return c.json({ error: "邮箱或密码错误" }, 401);

  const token = await signAccessToken({
    userId: user.id,
    email: user.email,
    superAdmin: user.super_admin,
  });

  try {
    await redis.set(RedisKeys.userSub(String(user.id)), String(user.id), "EX", env.jwtTtlSeconds);
  } catch {
    /* Redis 故障不阻断登录 */
  }

  const cookie = serializeCookie(env.cookieName, token, {
    maxAge: env.jwtTtlSeconds,
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: "Lax",
    path: "/",
  });
  c.header("Set-Cookie", cookie);

  return c.json({
    data: {
      user: { id: user.id, email: user.email, super_admin: user.super_admin, api_key: user.api_key },
      expires_in: env.jwtTtlSeconds,
    },
  });
});

authRoutes.post("/logout", async (c) => {
  const cookie = serializeCookie(env.cookieName, "", {
    maxAge: 0,
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: "Lax",
    path: "/",
  });
  c.header("Set-Cookie", cookie);
  return c.json({ data: { ok: true } });
});

/** 共享：从请求解析身份（cookie JWT 或 Bearer api_key） */
export async function authenticateRequest(c: Context) {
  const cookieToken = c.req.header("cookie")?.match(/(?:^|;\s*)access=([^;]+)/)?.[1];
  if (cookieToken) {
    const payload = await verifyAccessToken(decodeURIComponent(cookieToken));
    if (payload) {
      const id = Number(payload.sub);
      if (Number.isInteger(id)) {
        const u = await loadUserWithRoles(id);
        if (u && u.status !== "inactive") return u;
      }
    }
  }
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (bearer && isUUID(bearer)) {
    const license = await licenseService.getLicense();
    if (license && license.type !== "business") return null;
    const u = await db.user.findUnique({ where: { api_key: bearer }, include: { admin_roles: true } });
    if (u && u.status !== "inactive") return u;
  }
  return null;
}

/** GET /api/auth/me —— 白名单内自解析身份 */
authRoutes.get("/me", async (c) => {
  const user = await authenticateRequest(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ data: publicUser(user) });
});

/** GET /api/auth/permissions —— 当前用户权限视图（调试/前端菜单用） */
authRoutes.get("/permissions", async (c) => {
  const user = await authenticateRequest(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  return c.json({
    data: {
      super_admin: user.super_admin,
      roles: (user.admin_roles ?? []).map((r) => ({ id: r.id, name: r.name, permissions: r.permissions })),
    },
  });
});
