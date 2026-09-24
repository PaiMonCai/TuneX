import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  createRateLimitMiddleware,
  memoryRateLimitStore,
  type RateLimitRule,
} from "../rate-limit.ts";
import { createAuditMiddleware } from "../audit.ts";
import { setAuditSink, resetAuditSink, type AuditEntry } from "../../services/audit.ts";

/**
 * 中间件接线（Hono 集成）验证：用最小 Hono app + 内存 store + fake 审计 sink，
 * 断言真实请求路径下 —— 429、Retry-After、X-RateLimit-* 头、审计落库、错误后仍审计。
 * 不依赖 DB / Redis。
 */

function buildApp(rules: RateLimitRule[], ip = "9.9.9.9") {
  const app = new Hono();
  // 模拟 app.ts 链序：先注入 ip + 假用户，再审计、再限流，最后路由。
  app.use("*", async (c, next) => {
    c.set("ip", ip);
    c.set("user", { id: 42, email: "u@tunex.local", super_admin: false, admin_roles: [] });
    await next();
  });
  app.use("*", createAuditMiddleware({ enabled: true }));
  app.use("*", createRateLimitMiddleware({ rules, store: memoryRateLimitStore(() => 1000), enabled: true }));
  app.get("/api/ping", (c) => c.json({ ok: true }));
  app.post("/api/things", (c) => c.json({ ok: true }, 201));
  app.post("/api/boom", () => {
    throw new HTTPException(500, { message: "boom" });
  });
  app.onError((e, c) => (e instanceof HTTPException ? c.json({ error: e.message }, e.status) : c.json({ error: "x" }, 500)));
  return app;
}

const dummyRules: RateLimitRule[] = [
  { name: "things", windowSeconds: 60, max: 1, methods: ["POST"], match: (p, m) => m === "POST" && p === "/api/things", scope: "user" },
];

describe("rate-limit middleware (Hono)", () => {
  test("allows and sets X-RateLimit headers under the limit", async () => {
    const app = buildApp(dummyRules);
    const res = await app.request("/api/things", { method: "POST" });
    expect(res.status).toBe(201);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("1");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(res.headers.get("X-RateLimit-Rule")).toBe("things");
  });

  test("blocks the 2nd request with 429 + Retry-After + code", async () => {
    const app = buildApp(dummyRules);
    await app.request("/api/things", { method: "POST" });
    const res = await app.request("/api/things", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("RATE_LIMITED");
  });

  test("unmatched path is not limited", async () => {
    const app = buildApp(dummyRules);
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/api/ping");
      expect(res.status).toBe(200);
    }
  });
});

describe("audit middleware (Hono)", () => {
  test("writes an entry after the response, and still audits errors", async () => {
    const captured: AuditEntry[] = [];
    setAuditSink({ write: async (e) => void captured.push(e) });
    try {
      const app = buildApp(dummyRules);
      await app.request("/api/things", { method: "POST", headers: { "user-agent": "test-agent" } });
      await app.request("/api/boom", { method: "POST" });

      // POST 与 500 都应被记录
      expect(captured.length).toBe(2);
      const post = captured.find((e) => e.method === "POST")!;
      expect(post.resource).toBe("things");
      expect(post.status).toBe(201);
      expect(post.actor_id).toBe(42);
      expect(post.actor_type).toBe("user");
      expect(post.user_agent).toBe("test-agent");
      expect(post.ip).toBe("9.9.9.9");

      const boom = captured.find((e) => e.status === 500)!;
      expect(boom).toBeTruthy();
    } finally {
      resetAuditSink();
    }
  });

  test("audit is skipped for noisy non-api and non-GET user GETs", async () => {
    const captured: AuditEntry[] = [];
    setAuditSink({ write: async (e) => void captured.push(e) });
    try {
      const app = buildApp([]);
      await app.request("/api/ping"); // GET /api/ping 非 admin/非敏感 → 不审计
      expect(captured.length).toBe(0);
    } finally {
      resetAuditSink();
    }
  });
});
