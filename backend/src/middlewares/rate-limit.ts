/**
 * 全局限流中间件 —— 固定窗口 + Redis 原子计数（fail-open）
 *
 * ── 背景 ──
 * 脚手架里只有 `socket/index.ts` 的 `register_block` 一处防爆破，HTTP 侧
 * （登录、注册、支付回调、全站 API）此前无任何限流。本模块补上「按规则匹配请求
 * → 计数 → 超限返回 429」的通用闸门（见 DEVELOPMENT.md §7 P2「全局限流」）。
 *
 * ── 设计要点 ──
 *  · **规则表驱动**：`GLOBAL_RATE_LIMIT_RULES` 按顺序匹配，命中第一条即生效；
 *    未命中任何规则 → 放行（不做兜底计数，避免误伤健康检查等）。
 *  · **固定窗口**：`INCR` 首次写入时设 `EXPIRE`，用 Lua 脚本保证「自增 + 过期」
 *    原子（`INCR` 与 `EXPIRE` 分开会在崩溃窗口内产生永不过期的 key）。
 *  · **计数维度**：`scope:"user"` 优先按登录用户 id，未登录回退 IP；`scope:"ip"`
 *    恒按 IP（登录/注册等未认证端点只能按 IP）。
 *  · **fail-open**：Redis 不可用时视为放行。限流是「尽力而为」的保护，绝不能在
 *    缓存故障时把正常业务挡在门外（配置下发侧同样的取向）。
 *  · **纯逻辑与副作用分离**：{@link selectRule} / {@link identityOf} /
 *    {@link evaluate} 均为纯函数，可离线单测（见 `__tests__/rate-limit.test.ts`）；
 *    {@link createRateLimitMiddleware} 负责接线。
 *
 * TEN-02 键作用域：限流计数键经 {@link scopedKey} 生成，走平台段
 * `ws:global:ratelimit:<rule>:<identity>`。identity 已含 `user:<id>` 或
 * `ip:<addr>`，键值只是一个整数计数、不描述任何租户资产，因此归入 global
 * 段而非 workspace 段——但前缀仍然要带，保证全站键位一个规范。
 */
import { createMiddleware } from "hono/factory";
import type { AppVariables } from "./auth.ts";
import { RedisKeys } from "../redis.ts";

/* ================================================================== */
/* 类型                                                               */
/* ================================================================== */

/** 计数维度。 */
export type RateLimitScope = "user" | "ip";

/** 一条限流规则。 */
export interface RateLimitRule {
  /** 规则名（用于 Redis key 与日志）。 */
  name: string;
  /** 窗口长度（秒）。 */
  windowSeconds: number;
  /** 窗口内允许的最大请求数；超过即 429。 */
  max: number;
  /** 适用方法集合（大写）；缺省表示所有方法。 */
  methods?: string[];
  /** 路径判定：返回 true 表示该规则适用。 */
  match: (path: string, method: string) => boolean;
  /** 计数维度；缺省 `user`。 */
  scope?: RateLimitScope;
  /** 超限提示文案；缺省通用文案。 */
  message?: string;
}

/** 计数存储接口（默认 Redis；测试注入内存实现）。 */
export interface RateLimitStore {
  /**
   * 对 key 自增一次并返回当前计数与剩余 TTL（秒）。
   * 首次写入时设置 windowSeconds 过期。
   */
  incr(key: string, windowSeconds: number): Promise<{ count: number; ttl: number }>;
}

/** 一次限流判定的结论。 */
export interface RateLimitDecision {
  allowed: boolean;
  /** 窗口内剩余可用次数（不小于 0）。 */
  remaining: number;
  /** 建议的 Retry-After（秒），仅在 allowed=false 时有意义。 */
  retryAfter: number;
  /** 命中的规则名；未命中任何规则时为 null。 */
  rule: string | null;
  /**
   * 是否因存储故障而 fail-open 放行（用于监控/日志，不参与业务判定）。
   */
  degraded: boolean;
}

export const DEFAULT_RATE_LIMIT_MESSAGE = "请求过于频繁，请稍后再试";

/* ================================================================== */
/* 规则表                                                             */
/* ================================================================== */

const isPost = (method: string) => method === "POST";

/**
 * 默认全局限流规则（按顺序匹配）。
 *
 * 阈值取值说明：
 *  · 登录 / 注册 / 找回：按 IP，60s 内 10 / 5 / 5 次 —— 抵御撞库与批量注册；
 *  · 密钥轮换：按用户，60s 内 5 次 —— 防骚扰式轮换与凭据探测；
 *  · 支付回调：按 IP，60s 内 60 次 —— 给第三方重试留足余量，仅挡明显刷量；
 *  · 全站 API 兜底：按登录用户（未登录回退 IP），60s 内 600 次 —— 约 10 QPS，
 *    正常控制台轮询（5–30s 一次）远达不到，异常脚本会先撞线。
 */
export const GLOBAL_RATE_LIMIT_RULES: RateLimitRule[] = [
  {
    name: "auth-login",
    windowSeconds: 60,
    max: 10,
    methods: ["POST"],
    match: (p, m) => isPost(m) && p === "/api/auth/login",
    scope: "ip",
  },
  {
    name: "auth-register",
    windowSeconds: 60,
    max: 5,
    methods: ["POST"],
    match: (p, m) => isPost(m) && p === "/api/auth/register",
    scope: "ip",
  },
  {
    name: "auth-recover",
    windowSeconds: 60,
    max: 5,
    methods: ["POST"],
    match: (p, m) =>
      isPost(m) &&
      (p === "/api/auth/forgot" ||
        p === "/api/auth/forgot-password" ||
        p === "/api/auth/reset" ||
        p === "/api/auth/reset-password" ||
        p === "/api/auth/resend-verification"),
    scope: "ip",
  },
  {
    name: "pay-callback",
    windowSeconds: 60,
    max: 60,
    match: (p) => /^\/api\/pay\/[^/]+\/callback$/.test(p),
    scope: "ip",
  },
  {
    name: "key-rotation",
    windowSeconds: 60,
    max: 5,
    methods: ["POST"],
    // SEC-02：轮换端点单独限流（按登录用户）。60s 内 5 次远多于真人操作，
    // 但挡住了「反复轮换把某账号凭据打失效」的骚扰与枚举式探测；
    // 无需按 IP——这些端点必须已认证。
    match: (p, m) =>
      isPost(m) &&
      (p === "/api/settings/api-key" ||
        p === "/api/settings/api-key/regenerate" ||
        p === "/api/settings/subscription-key" ||
        p === "/api/settings/subscription-key/regenerate"),
    scope: "user",
  },
  {
    name: "api-global",
    windowSeconds: 60,
    max: 600,
    match: (p) => p.startsWith("/api/"),
    scope: "user",
  },
];

/* ================================================================== */
/* 纯逻辑                                                             */
/* ================================================================== */

/** 按方法过滤后的候选规则。 */
function ruleApplies(rule: RateLimitRule, path: string, method: string): boolean {
  if (rule.methods && !rule.methods.includes(method)) return false;
  try {
    return rule.match(path, method);
  } catch {
    return false;
  }
}

/** 选取第一条命中的规则；无命中返回 null。 */
export function selectRule(
  rules: readonly RateLimitRule[],
  path: string,
  method: string,
): RateLimitRule | null {
  for (const rule of rules) {
    if (ruleApplies(rule, path, method)) return rule;
  }
  return null;
}

/** 计算计数身份：user 维度优先用登录用户，否则回退 IP（IP 缺失时用 anon）。 */
export function identityOf(
  rule: RateLimitRule,
  ctx: { ip: string; userId?: number },
): string {
  const ip = ctx.ip && ctx.ip.trim() ? ctx.ip.trim() : "anon";
  if ((rule.scope ?? "user") === "ip") return `ip:${ip}`;
  return ctx.userId ? `user:${ctx.userId}` : `ip:${ip}`;
}

/**
 * 组装 Redis key。
 *
 * TEN-02：经 {@link RedisKeys.rateLimit} 生成，带 `ws:global:` 前缀。
 */
export function rateLimitKey(ruleName: string, identity: string): string {
  return RedisKeys.rateLimit(ruleName, identity);
}

/**
 * 纯判定：给定当前计数、规则上限、剩余 TTL → 结论。
 * `count > max` 判为超限（第 max+1 次请求被挡）。
 */
export function evaluate(
  rule: RateLimitRule,
  hit: { count: number; ttl: number },
  degraded = false,
): RateLimitDecision {
  const remaining = Math.max(0, rule.max - hit.count);
  const allowed = hit.count <= rule.max;
  return {
    allowed,
    remaining: allowed ? remaining : 0,
    retryAfter: allowed ? 0 : Math.max(1, Math.floor(hit.ttl)),
    rule: rule.name,
    degraded,
  };
}

/**
 * 执行一次限流判定（组合 selectRule + identityOf + store.incr + evaluate）。
 *
 * store 抛错时 fail-open：返回 allowed=true、degraded=true。
 */
export async function checkRateLimit(
  rules: readonly RateLimitRule[],
  store: RateLimitStore,
  req: { path: string; method: string; ip: string; userId?: number },
): Promise<RateLimitDecision> {
  const rule = selectRule(rules, req.path, req.method);
  if (!rule) {
    return { allowed: true, remaining: 0, retryAfter: 0, rule: null, degraded: false };
  }
  const identity = identityOf(rule, req);
  const key = rateLimitKey(rule.name, identity);
  try {
    const hit = await store.incr(key, rule.windowSeconds);
    return evaluate(rule, hit);
  } catch {
    // fail-open：缓存故障不阻断业务。
    return { allowed: true, remaining: 0, retryAfter: 0, rule: rule.name, degraded: true };
  }
}

/* ================================================================== */
/* Redis 存储                                                         */
/* ================================================================== */

/** 自增 + 首次设过期：原子，避免 INCR/EXPIRE 分离导致 key 永不失效。 */
const INCR_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return { c, ttl }
`;

/** 默认 Redis 存储（懒加载 redis，避免测试引入本模块即连库）。 */
export function redisRateLimitStore(): RateLimitStore {
  return {
    async incr(key, windowSeconds) {
      const { redis } = await import("../redis.ts");
      const res = (await redis.eval(INCR_LUA, 1, key, String(windowSeconds))) as
        | [number, number]
        | number[]
        | null;
      const count = Number(Array.isArray(res) ? res[0] : res ?? 1);
      const ttl = Number(Array.isArray(res) ? res[1] : windowSeconds);
      return { count, ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : windowSeconds };
    },
  };
}

/** 进程内内存存储（单元测试 / 无 Redis 场景）。 */
export function memoryRateLimitStore(now: () => number = () => Date.now()): RateLimitStore & {
  reset(): void;
} {
  const buckets = new Map<string, { count: number; expireAt: number }>();
  return {
    async incr(key, windowSeconds) {
      const t = now();
      const cur = buckets.get(key);
      if (!cur || cur.expireAt <= t) {
        buckets.set(key, { count: 1, expireAt: t + windowSeconds * 1000 });
        return { count: 1, ttl: windowSeconds };
      }
      cur.count += 1;
      return { count: cur.count, ttl: Math.max(1, Math.ceil((cur.expireAt - t) / 1000)) };
    },
    reset() {
      buckets.clear();
    },
  };
}

/* ================================================================== */
/* 中间件                                                             */
/* ================================================================== */

export interface RateLimitMiddlewareOptions {
  rules?: readonly RateLimitRule[];
  store?: RateLimitStore;
  /** 总开关；默认读 env.rateLimitEnabled。 */
  enabled?: boolean;
}

/**
 * 全局限流中间件。必须在「解析 IP + 认证」之后挂载，才能拿到 `ip` 与 `user`。
 *
 * 放行时附加 `X-RateLimit-Limit/Remaining` 头；超限返回 429 + `Retry-After`。
 */
export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions = {}) {
  const rules = options.rules ?? GLOBAL_RATE_LIMIT_RULES;
  const store = options.store ?? redisRateLimitStore();

  return createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
    const enabled = options.enabled ?? readEnabledFromEnv();
    if (!enabled) return await next();

    const rule = selectRule(rules, c.req.path, c.req.method);
    if (!rule) return await next();

    const decision = await checkRateLimit(rules, store, {
      path: c.req.path,
      method: c.req.method,
      ip: c.get("ip") ?? "",
      userId: c.get("user")?.id,
    });

    if (!decision.allowed) {
      return c.json(
        { error: rule.message ?? DEFAULT_RATE_LIMIT_MESSAGE, code: "RATE_LIMITED" },
        429,
        {
          "Retry-After": String(decision.retryAfter),
          "X-RateLimit-Limit": String(rule.max),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Rule": rule.name,
        },
      );
    }

    await next();
    c.header("X-RateLimit-Limit", String(rule.max));
    c.header("X-RateLimit-Remaining", String(decision.remaining));
    c.header("X-RateLimit-Rule", rule.name);
  });
}

function readEnabledFromEnv(): boolean {
  return (process.env.RATE_LIMIT_ENABLED ?? "true") !== "false";
}
