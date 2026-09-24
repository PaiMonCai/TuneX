import { test, expect, describe } from "bun:test";
import {
  GLOBAL_RATE_LIMIT_RULES,
  selectRule,
  identityOf,
  rateLimitKey,
  evaluate,
  checkRateLimit,
  memoryRateLimitStore,
  type RateLimitRule,
} from "../rate-limit.ts";

const rule = (over: Partial<RateLimitRule> = {}): RateLimitRule => ({
  name: "t",
  windowSeconds: 60,
  max: 3,
  match: () => true,
  ...over,
});

describe("selectRule", () => {
  test("login POST hits auth-login (ip scope)", () => {
    const r = selectRule(GLOBAL_RATE_LIMIT_RULES, "/api/auth/login", "POST");
    expect(r?.name).toBe("auth-login");
    expect(r?.scope).toBe("ip");
  });

  test("register POST hits auth-register", () => {
    expect(selectRule(GLOBAL_RATE_LIMIT_RULES, "/api/auth/register", "POST")?.name).toBe(
      "auth-register",
    );
  });

  test("pay callback hits pay-callback regardless of method", () => {
    expect(selectRule(GLOBAL_RATE_LIMIT_RULES, "/api/pay/epay/callback", "POST")?.name).toBe(
      "pay-callback",
    );
  });

  test("generic api path falls through to api-global", () => {
    expect(selectRule(GLOBAL_RATE_LIMIT_RULES, "/api/tunnels", "GET")?.name).toBe("api-global");
  });

  test("non-api / health path matched by no rule", () => {
    expect(selectRule(GLOBAL_RATE_LIMIT_RULES, "/healthz", "GET")).toBeNull();
    expect(selectRule(GLOBAL_RATE_LIMIT_RULES, "/socket.io/", "GET")).toBeNull();
  });

  test("login GET is not the login rule (method guard) → api-global", () => {
    expect(selectRule(GLOBAL_RATE_LIMIT_RULES, "/api/auth/login", "GET")?.name).toBe("api-global");
  });
});

describe("identityOf", () => {
  test("ip scope always uses ip", () => {
    const r = rule({ scope: "ip" });
    expect(identityOf(r, { ip: "1.2.3.4", userId: 9 })).toBe("ip:1.2.3.4");
  });

  test("user scope prefers user id", () => {
    const r = rule({ scope: "user" });
    expect(identityOf(r, { ip: "1.2.3.4", userId: 9 })).toBe("user:9");
  });

  test("user scope falls back to ip when anonymous", () => {
    const r = rule({ scope: "user" });
    expect(identityOf(r, { ip: "1.2.3.4" })).toBe("ip:1.2.3.4");
  });

  test("empty ip becomes anon", () => {
    expect(identityOf(rule({ scope: "ip" }), { ip: "  " })).toBe("ip:anon");
  });
});

describe("evaluate", () => {
  test("count below/at max is allowed", () => {
    expect(evaluate(rule({ max: 3 }), { count: 3, ttl: 42 }).allowed).toBe(true);
    expect(evaluate(rule({ max: 3 }), { count: 3, ttl: 42 }).remaining).toBe(0);
  });

  test("count above max is blocked with retryAfter", () => {
    const d = evaluate(rule({ max: 3 }), { count: 4, ttl: 17 });
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
    expect(d.retryAfter).toBe(17);
  });
});

describe("checkRateLimit (memory store)", () => {
  test("blocks the (max+1)th request in a window", async () => {
    const store = memoryRateLimitStore(() => 1000);
    const rules = [rule({ name: "x", max: 2, windowSeconds: 60 })];
    const req = { path: "/api/x", method: "POST", ip: "9.9.9.9" };
    expect((await checkRateLimit(rules, store, req)).allowed).toBe(true);
    expect((await checkRateLimit(rules, store, req)).allowed).toBe(true);
    const third = await checkRateLimit(rules, store, req);
    expect(third.allowed).toBe(false);
    expect(third.rule).toBe("x");
  });

  test("window expiry resets the counter", async () => {
    let now = 1000;
    const store = memoryRateLimitStore(() => now);
    const rules = [rule({ name: "w", max: 1, windowSeconds: 10 })];
    const req = { path: "/api/w", method: "POST", ip: "1.1.1.1" };
    expect((await checkRateLimit(rules, store, req)).allowed).toBe(true);
    expect((await checkRateLimit(rules, store, req)).allowed).toBe(false);
    now = 1000 + 10_001;
    expect((await checkRateLimit(rules, store, req)).allowed).toBe(true);
  });

  test("distinct users counted separately (user scope)", async () => {
    const store = memoryRateLimitStore(() => 1000);
    const rules = [rule({ name: "u", max: 1, scope: "user" })];
    expect((await checkRateLimit(rules, store, { path: "/api/u", method: "GET", ip: "1.1.1.1", userId: 1 })).allowed).toBe(true);
    expect((await checkRateLimit(rules, store, { path: "/api/u", method: "GET", ip: "1.1.1.1", userId: 2 })).allowed).toBe(true);
    expect((await checkRateLimit(rules, store, { path: "/api/u", method: "GET", ip: "1.1.1.1", userId: 1 })).allowed).toBe(false);
  });

  test("no matching rule → allowed, rule null", async () => {
    const store = memoryRateLimitStore();
    const d = await checkRateLimit(GLOBAL_RATE_LIMIT_RULES, store, { path: "/healthz", method: "GET", ip: "1.1.1.1" });
    expect(d.allowed).toBe(true);
    expect(d.rule).toBeNull();
  });

  test("storage failure fails OPEN (allowed, degraded)", async () => {
    const store = {
      incr: async () => {
        throw new Error("redis down");
      },
    };
    const d = await checkRateLimit([rule({ max: 1 })], store, { path: "/api/x", method: "POST", ip: "1.1.1.1" });
    expect(d.allowed).toBe(true);
    expect(d.degraded).toBe(true);
  });
});

describe("rateLimitKey", () => {
  test("namespaced key (TEN-02：带 ws:global: 前缀)", () => {
    expect(rateLimitKey("auth-login", "1.2.3.4")).toBe(
      "ws:global:ratelimit:auth-login:1.2.3.4",
    );
  });

  test("identity 含冒号时被转义（不能伪造出新的段）", () => {
    // escapeSegment 把 `:` 转成 `\:`：否则 `ip:1.2.3.4` 里的冒号会被
    // 解析成额外段，同 key 前缀下不同 rule/identity 可能串味。
    expect(rateLimitKey("auth-login", "ip:1.2.3.4")).toBe(
      "ws:global:ratelimit:auth-login:ip\\:1.2.3.4",
    );
  });
});
