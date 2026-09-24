/**
 * 环境变量集中读取。
 *
 * Security: secrets have no built-in default. Deployments must supply
 * AUTH_SECRET, LICENSE_SECRET, TUNEX_CONFIG_KEY and TUNEX_LICENSE_KEY.
 * Missing secrets fail fast instead of silently using a shared value.
 */
import { configKey, licenseKey } from "./crypto/keys.ts";

function requireSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required and has no default`);
  return value;
}
export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: (process.env.NODE_ENV ?? "development") === "production",
  port: Number(process.env.PORT ?? 3000),
  siteUrl: process.env.SITE_URL ?? "http://localhost:8088",

  databaseUrl: requireSecret("DATABASE_URL"),
  redisUrl: process.env.REDIS_URL ?? "redis://redis:6379",

  authSecret: requireSecret("AUTH_SECRET"),
  jwtIssuer: process.env.JWT_ISSUER ?? "tunex",
  /** Cookie `access` 的 JWT 有效期：12h（与原版会话对齐） */
  jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS ?? 12 * 60 * 60),

  cookieName: process.env.COOKIE_NAME ?? "access",
  /** secure 开关：明文 HTTP 本地栈置 false，TLS 环境必须 true */
  cookieSecure: (process.env.COOKIE_SECURE ?? "false") === "true",

  allowRegisterFallback: (process.env.ALLOW_REGISTER_FALLBACK ?? "true") === "true",

  licenseType: process.env.LICENSE_TYPE ?? "business",
  licenseExpiredAt: Number(process.env.LICENSE_EXPIRED_AT ?? 0),
  licenseSecret: requireSecret("LICENSE_SECRET"),

  disableWorker: (process.env.DISABLE_WORKER ?? "false") === "true",
  /** Optional billing integration; off by default, independent of RBAC. */
  paymentsEnabled: process.env.PAYMENTS_ENABLED === "true",
} as const;

// Fail fast at startup: validate the per-install Fernet keys as soon as this
// module is loaded, instead of lazily on first use. A deployment missing either
// key cannot boot, so a key leaked from one install can never be reused.
if (process.env.NODE_ENV !== "test") {
  configKey();
  licenseKey();
}
