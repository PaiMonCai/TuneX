/**
 * 环境变量集中读取。
 *
 * Security: secrets have no built-in default. Deployments must supply
 * AUTH_SECRET. Missing secrets fail fast instead of silently using a shared value.
 *
 * Legacy TUNEX_CONFIG_KEY / TUNEX_LICENSE_KEY / LICENSE_SECRET inputs are no longer
 * runtime dependencies; the old Socket.IO/Fernet/license-signing paths were removed.
 */

function requireSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required and has no default`);
  return value;
}

/**
 * 开关解析必须与 `services/looking-glass.ts:lookingGlassEnabledFromEnv` 同一语义。
 *
 * 这里复制而不是 import：env.ts 是**最底层**模块（services 会 import 它），反向
 * import 会形成环。两处语义一致性由 `v5-wp19/d-looking-glass.test.ts` 直接断言
 * （同一张"哪些取值算开"的表跑两个实现）。
 */
function lookingGlassEnabledFromEnv(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction: (process.env.NODE_ENV ?? "development") === "production",
  port: Number(process.env.PORT ?? 3000),
  siteUrl: process.env.SITE_URL ?? "http://localhost:8088",
  /** Docker-first node installer pulls this dedicated slim Agent image. */
  agentImage: process.env.TUNEX_AGENT_IMAGE?.trim() || "ghcr.io/paimoncai/tunex-agent:latest",
  /**
   * V4-WP6：面板建议节点升级到的 Agent 版本（§13.4.3「查看 Agent version /
   * 是否建议升级」的**基线**）。空串 = 未配置 = **不判版本落后**
   * （`agent_version_unknown` 也不会出现）。
   *
   * 为什么不从代码里推断：仓库里没有任何权威的「当前 Agent 版本」常量
   * （`agentImage` 只有镜像标签 `:latest`），凭猜测编一个基线会让面板对所有
   * 节点谎报「版本落后」。部署方知道自己发的镜像版本，就由部署方给这一项。
   */
  agentLatestVersion: process.env.TUNEX_AGENT_LATEST_VERSION?.trim() || "",

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

  disableWorker: (process.env.DISABLE_WORKER ?? "false") === "true",
  /** Optional billing integration; off by default, independent of RBAC. */
  paymentsEnabled: process.env.PAYMENTS_ENABLED === "true",
  /**
   * V5-WP19-D —— Looking Glass（从节点向公网目标发一次有界 TCP 连接测试）。
   *
   * **默认关闭**，与契约 §3 D7④ 一致：这是一个"让别人的机器替我发包"的能力，
   * 上线前要独立安全评审，因此不能因为没配置就默认打开。
   *
   * 解析走 `lookingGlassEnabledFromEnv`（services/looking-glass.ts）：显式真值
   * `1/true/yes/on` 才算开，拼写错误（`ture`/`enable`）等于关。方向刻意的——
   * 宽松解析会让一次拼写错误悄悄打开一个向客户机房发探测包的功能。
   */
  lookingGlassEnabled: lookingGlassEnabledFromEnv(process.env.LOOKING_GLASS_ENABLED),
  /**
   * V5.5 WP14 —— 本 Panel 对**其他 Panel** 公布的可达地址（不含路径）。
   *
   * 为什么不能直接用 `siteUrl`：那是给浏览器用的地址（可能是 127.0.0.1 或外网域名），
   * 而 peer 需要的是一个它能拨通的地址（容器网络里是 `http://panel:3000`）。
   * 空串 = 回落到 `siteUrl`（单机/同网部署通常也对）。
   */
  federationPublicUrl: process.env.FEDERATION_PUBLIC_URL?.trim() || "",
} as const;
