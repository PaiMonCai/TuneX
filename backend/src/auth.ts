/**
 * 认证核心 —— 双通道：Cookie JWT (jose/HS256) + Bearer API Key (uuid v4)
 * 依据: relayx-auth-rbac-source-verification-report.md §2
 *
 * 原版用 StackAuth 远端 JWKS；本复刻改用本地 HS256 签发（jose），
 * 保留 cookie 名为 `access`、TTL 12h、Bearer api_key 直查 user.api_key 的通道语义。
 */
import { SignJWT, jwtVerify } from "jose";
import { randomUUID, timingSafeEqual, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { env } from "./env.ts";

const secretKey = new TextEncoder().encode(env.authSecret);

export interface JwtPayload {
  sub: string; // user.id (字符串)
  email: string;
  super_admin: boolean;
  iat?: number;
  exp?: number;
}

/** 签发 access JWT（HS256，默认 12h） */
export async function signAccessToken(payload: {
  userId: number;
  email: string;
  superAdmin: boolean;
}): Promise<string> {
  return new SignJWT({
    email: payload.email,
    super_admin: payload.superAdmin,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(String(payload.userId))
    .setIssuer(env.jwtIssuer)
    .setIssuedAt()
    .setExpirationTime(`${env.jwtTtlSeconds}s`)
    .sign(secretKey);
}

/** 校验 access JWT；失败返回 null */
export async function verifyAccessToken(token: string): Promise<JwtPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: env.jwtIssuer,
      algorithms: ["HS256"],
    });
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: String(payload.email ?? ""),
      super_admin: payload.super_admin === true,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

/** UUID v4 格式校验（原版 isUUID 正则） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUID(token: string): boolean {
  return UUID_RE.test(token);
}

/** 恒定时间比较（长度不等直接 false，避免抛错） */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 密码哈希 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** 生成强随机密码（seed 用；避免易混淆字符） */
export function generatePassword(length = 24): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*-_=+";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function newApiKey(): string {
  return randomUUID();
}

/** 序列化 cookie（手写以避免额外依赖；语义等价于 hono setCookie 默认值） */
export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge?: number; secure?: boolean; httpOnly?: boolean; sameSite?: "Lax" | "Strict" | "None"; path?: string } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path ?? "/"}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (typeof opts.maxAge === "number") parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join("; ");
}
