/**
 * 环境变量集中读取。
 *
 * Security: secrets have no built-in default. Deployments must supply
 * AUTH_SECRET and LICENSE_SECRET. Missing secrets fail fast instead of
 * silently using a shared value.
 *
 * WP15：TUNEX_CONFIG_KEY / TUNEX_LICENSE_KEY 不再读取也不再校验——它们只为
 * legacy agent 的 Fernet config 下发与 license 签名存在，随 Socket.IO 层删除。
 */

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
  /** Docker-first node installer pulls this dedicated slim Agent image. */
  agentImage: process.env.TUNEX_AGENT_IMAGE?.trim() || "ghcr.io/paimoncai/tunex-agent:latest",

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

  /** TEN-03 邮件服务（SMTP）。全部未配置 → 邮件内容落日志（开发环境可用）。 */
  mail: {
    host: process.env.SMTP_HOST ?? "",
    port: Number(process.env.SMTP_PORT ?? 465),
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM ?? "",
    /** STARTTLS（587）默认开；465 隐式 TLS 自动识别。置 false 走明文（测试）。 */
    secure: (process.env.SMTP_SECURE ?? "true") === "true",
  },
  /** 邮箱验证 token 有效期：24h（重置 token 固定 1h，见 services/mail-tokens.ts）。 */
  emailVerifyTtlSeconds: Number(process.env.EMAIL_VERIFY_TTL_SECONDS ?? 24 * 60 * 60),
  /** 重新发送验证邮件的间隔：60s（限流中间件之外的应用层节流）。 */
  resendVerificationIntervalSeconds: Number(process.env.RESEND_VERIFICATION_INTERVAL ?? 60),

  licenseType: process.env.LICENSE_TYPE ?? "business",
  licenseExpiredAt: Number(process.env.LICENSE_EXPIRED_AT ?? 0),
  licenseSecret: requireSecret("LICENSE_SECRET"),

  disableWorker: (process.env.DISABLE_WORKER ?? "false") === "true",
  /** Optional billing integration; off by default, independent of RBAC. */
  paymentsEnabled: process.env.PAYMENTS_ENABLED === "true",
} as const;
