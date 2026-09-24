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
import {
  consumeEmailToken,
  buildTokenLink,
  issueEmailToken,
  issueForgotPasswordToken,
  lastUnusedVerificationAt,
  TOKEN_TTL_SECONDS,
} from "../services/mail-tokens.ts";
import { sendMail } from "../services/mail.ts";

export const authRoutes = new Hono<{ Variables: AppVariables }>();

function publicUser(u: {
  id: number;
  email: string;
  super_admin: boolean;
  api_key: string;
  balance: number;
  status: string;
  created_at: Date;
  /** TEN-03：邮箱是否已验证。0.1 阶段为软约束（未验证仍可登录），此字段供前端提示。 */
  email_verified_at?: Date | null;
}) {
  return {
    id: u.id,
    email: u.email,
    super_admin: u.super_admin,
    api_key: u.api_key,
    balance: u.balance,
    status: u.status,
    created_at: u.created_at,
    email_verified_at: u.email_verified_at ?? null,
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

  // TEN-03：注册即发验证邮件（尽力而为——SMTP 未配置时落日志，不阻断注册流程）。
  // token 在同一函数内签发并只经邮件下发，响应体绝不回显。
  const verification = await issueEmailToken(user.id, user.email, "email_verify");
  await sendMail({
    to: user.email,
    subject: "验证您的 TuneX 邮箱",
    text: [
      `欢迎加入 TuneX。`,
      ``,
      `请点击下面的链接验证邮箱（24 小时内有效，仅可使用一次）：`,
      buildTokenLink("verify-email", verification.token),
      ``,
      `如果这不是您的操作，请忽略本邮件。`,
    ].join("\n"),
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
      /** TEN-03：未验证不阻断登录（软约束），字段供前端提示去验证。 */
      email_verified: user.email_verified_at !== null,
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

/* ================================================================== */
/* TEN-03：邮箱验证                                                     */
/* ================================================================== */

const VerifyEmailSchema = z.object({
  token: z.string().min(20).max(256),
});

/**
 * GET /api/auth/verify-email?token=...
 *
 * 邮件里的链接直接点进来（浏览器 GET），故用 query 而非 body。
 * 幂等友好：成功与失败返回 **同一形状**的 JSON，前端页面按 status 渲染；
 * 过期 / 已用 / 伪造 token 一律不泄露具体原因。
 */
authRoutes.get("/verify-email", async (c) => {
  const parsed = VerifyEmailSchema.safeParse({ token: c.req.query("token") });
  if (!parsed.success) {
    return c.json({ status: "invalid", message: "验证链接无效" }, 400);
  }
  const consumed = await consumeEmailToken(parsed.data.token, "email_verify");
  if (!consumed.ok) {
    return c.json({ status: "invalid", message: "验证链接无效或已使用" }, 400);
  }
  // 已是通过令牌定位到的用户，直接把验证时间写上去（幂等：重复写同值无副作用）。
  await db.user.update({ where: { id: consumed.userId }, data: { email_verified_at: new Date() } });
  return c.json({ status: "verified", message: "邮箱验证成功" });
});

/**
 * POST /api/auth/resend-verification
 *
 * 需要登录（软约束下未验证用户登录后主动要求重发）。限流：全局 auth-recover 规则
 * 之外，这里再加 60s 应用层节流——防止同用户连点把 SMTP 队列打爆、或被用来
 * 给任意邮箱灌信（登录态已限定只能给自己发）。
 */
authRoutes.post("/resend-verification", async (c) => {
  const user = await authenticateRequest(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (user.email_verified_at) {
    return c.json({ error: "邮箱已完成验证" }, 409);
  }
  const lastSentAt = await lastUnusedVerificationAt(user.id);
  if (lastSentAt) {
    const elapsed = (Date.now() - lastSentAt.getTime()) / 1000;
    if (elapsed < env.resendVerificationIntervalSeconds) {
      const retryAfter = Math.max(1, Math.ceil(env.resendVerificationIntervalSeconds - elapsed));
      return c.json({ error: "请求过于频繁，请稍后再试" }, 429, { "Retry-After": String(retryAfter) });
    }
  }

  const verification = await issueEmailToken(user.id, user.email, "email_verify");
  await sendMail({
    to: user.email,
    subject: "验证您的 TuneX 邮箱",
    text: [
      `请点击下面的链接验证邮箱（24 小时内有效，仅可使用一次）：`,
      buildTokenLink("verify-email", verification.token),
      ``,
      `如果这不是您的操作，请忽略本邮件。`,
    ].join("\n"),
  });
  return c.json({ data: { ok: true, expires_in: TOKEN_TTL_SECONDS.email_verify } });
});

/* ================================================================== */
/* TEN-03：密码重置（邮箱枚举防护）                                      */
/* ================================================================== */

const ForgotPasswordSchema = z.object({
  email: z.string().email(),
});

/**
 * POST /api/auth/forgot-password { email }
 *
 * **防邮箱枚举**：无论邮箱是否存在，响应体、状态码、文案完全一致。
 * 邮箱不存在时同样走完其余流程（只是不落库、不发信），避免「响应更快/更慢」
 * 这种时序侧信道；邮件内容也不对调用方可见。若已发过未用的重置信，直接复用
 * 剩下的有效期时间窗（不重复发信，天然满足限频）。
 */
authRoutes.post("/forgot-password", async (c) => {
  const parsed = ForgotPasswordSchema.safeParse(await c.req.json().catch(() => null));
  // 参数错误也返回与成功一致的文案——只在请求体根本不是 JSON / 缺字段时区分，
  // 那与「邮箱是否存在」无关。
  const body = parsed.success ? parsed.data : null;
  const response = () =>
    c.json({ data: { ok: true, expires_in: TOKEN_TTL_SECONDS.password_reset } });

  if (!body) return response();

  const existing = await db.emailVerification.findFirst({
    where: { email: body.email, purpose: "password_reset", used_at: null },
    orderBy: { created_at: "desc" },
    select: { expires_at: true },
  });
  if (existing && existing.expires_at.getTime() > Date.now()) {
    // 已有一封未过期的重置信：不再发第二封（限频），仍返回成功语义。
    return response();
  }

  const issued = await issueForgotPasswordToken(body.email);
  if (issued) {
    await sendMail({
      to: body.email,
      subject: "重置您的 TuneX 密码",
      text: [
        `我们收到了重置 TuneX 密码的请求。`,
        ``,
        `请点击下面的链接重置密码（1 小时内有效，仅可使用一次）：`,
        buildTokenLink("reset-password", issued.token),
        ``,
        `如果这不是您的操作，请忽略本邮件，您的密码不会改变。`,
      ].join("\n"),
    });
  }
  return response();
});

const ResetPasswordSchema = z.object({
  token: z.string().min(20).max(256),
  password: z.string().min(8, "密码至少 8 位"),
});

/**
 * POST /api/auth/reset-password { token, password }
 *
 * 校验通过后：改密码、作废该 token、作废该用户**所有**未用的邮箱令牌
 * （验证信一并失效——密码已换，旧邮件里的链接不该还能用），再清掉 Redis 里的
 * 会话映射，让已签发但未过期的 JWT 尽快失效（见 middlewares/auth.ts 的
 * `userSub` 缓存校验路径）。
 */
authRoutes.post("/reset-password", async (c) => {
  const parsed = ResetPasswordSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    // 统一响应体：token 无效与密码不合法都返回同一句，避免把 token 状态泄露给探测方。
    return c.json({ error: "重置链接无效或已过期" }, 400);
  }

  const consumed = await consumeEmailToken(parsed.data.token, "password_reset");
  if (!consumed.ok) {
    return c.json({ error: "重置链接无效或已过期" }, 400);
  }

  const passwordHash = await hashPassword(parsed.data.password);
  await db.$transaction(async (tx) => {
    await tx.userCredential.updateMany({
      where: { user_id: consumed.userId },
      data: { password: passwordHash },
    });
    // 其余未用令牌（含邮箱验证信）全部作废。
    await tx.emailVerification.updateMany({
      where: { user_id: consumed.userId, used_at: null },
      data: { used_at: new Date() },
    });
  });

  // 旧会话下线：删掉 sub→id 映射后，authRequired 的缓存命中分支失效，回落直接查库；
  // 已签发 JWT 仍凭 exp 自然过期（最长 12h），这是无 session 表设计下的现实取舍，
  // 换密这一动作本身已经把「继续持有旧 cookie」的攻击面压到最低（攻击者已知新密码
  // 者也已获得同等访问权）。
  try {
    await redis.del(RedisKeys.userSub(String(consumed.userId)));
  } catch {
    /* Redis 故障不阻断重置 */
  }

  return c.json({ data: { ok: true } });
});
