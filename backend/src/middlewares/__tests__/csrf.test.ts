import { test, expect, describe, mock } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppVariables } from "../auth.ts";

/**
 * CSRF 防护中间件离线单测（不连 MySQL / Redis；env 已 mock，cookie name 固定
 * 为 `access`）。
 *
 * 覆盖 {@link checkCsrf} 全部分支：
 *   safe-method / no-cookie / exempt / custom-header / origin-match /
 *   referer-match / no-origin / origin-mismatch
 * 外加 Hono 接线层（真实 header → 403 响应体）。
 */

// env.ts 会 requireSecret 三个密钥，测试环境必须先 mock 掉它（与 mail-tokens /
// config-generator-ports 同一模式）。路径必须与 csrf.ts 内解析到的同一文件。
const MODULE_ENV = new URL("../../env.ts", import.meta.url).pathname;
mock.module(MODULE_ENV, () => ({ env: { cookieName: "access" } }));

const { checkCsrf, isCsrfExempt, createCsrfMiddleware, CSRF_EXEMPT_PATTERNS } =
  await import("../csrf.ts");

const base = {
  method: "POST",
  hasSessionCookie: true,
  path: "/api/tunnels",
  host: "tunex.example",
  origin: "https://tunex.example",
};

describe("checkCsrf — 方法维度", () => {
  test("安全方法（GET/HEAD/OPTIONS/TRACE）全部放行", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "TRACE"]) {
      const d = checkCsrf({ ...base, method });
      expect(d.allowed).toBe(true);
      expect(d.reason).toBe("safe-method");
    }
  });

  test("非安全方法（POST/PUT/PATCH/DELETE）才会进入 cookie 判定", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(checkCsrf({ ...base, method }).reason).not.toBe("safe-method");
    }
  });

  test("小写方法也按非安全方法处理（大小写不敏感）", () => {
    const d = checkCsrf({ ...base, method: "post", origin: null, referer: null });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no-origin");
  });
});

describe("checkCsrf — cookie 维度", () => {
  test("非安全方法但无会话 cookie → 放行（CSRF 与 Bearer 通道无关）", () => {
    const d = checkCsrf({ ...base, hasSessionCookie: false, origin: null, referer: null });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("no-cookie");
  });
});

describe("checkCsrf — 豁免路径", () => {
  test("isCsrfExempt 覆盖三条指定豁免路径", () => {
    expect(isCsrfExempt("/api/pay/epay/callback")).toBe(true);
    expect(isCsrfExempt("/api/pay/stripe/callback")).toBe(true);
    expect(isCsrfExempt("/api/tunnel/observer")).toBe(true);
    expect(isCsrfExempt("/api/tunnel/subscription")).toBe(true);
  });

  test("非豁免路径不误伤", () => {
    expect(isCsrfExempt("/api/pay/epay")).toBe(false);
    expect(isCsrfExempt("/api/pay/epay/callback/extra")).toBe(false);
    expect(isCsrfExempt("/api/tunnel/observer/x")).toBe(false);
    expect(isCsrfExempt("/api/tunnel/subscriptions")).toBe(false);
    expect(isCsrfExempt("/api/tunnels")).toBe(false);
  });

  test("豁免路径即使跨站 Origin 也放行（决策 reason=exempt）", () => {
    for (const path of [
      "/api/pay/epay/callback",
      "/api/tunnel/observer",
      "/api/tunnel/subscription",
    ]) {
      const d = checkCsrf({ ...base, path, origin: "https://evil.example" });
      expect(d.allowed).toBe(true);
      expect(d.reason).toBe("exempt");
    }
  });

  test("CSRF_EXEMPT_PATTERNS 精确等于任务指定的三条（锚定全路径）", () => {
    expect(CSRF_EXEMPT_PATTERNS).toHaveLength(3);
    expect(CSRF_EXEMPT_PATTERNS[0]?.test("/api/pay/any-channel/callback")).toBe(true);
    expect(CSRF_EXEMPT_PATTERNS[1]?.test("/api/tunnel/observer")).toBe(true);
    expect(CSRF_EXEMPT_PATTERNS[2]?.test("/api/tunnel/subscription")).toBe(true);
  });
});

describe("checkCsrf — 自定义头凭证", () => {
  test("X-Requested-With: XMLHttpRequest → 放行", () => {
    const d = checkCsrf({ ...base, origin: null, referer: null, xrw: "XMLHttpRequest" });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("custom-header");
  });

  test("X-TuneX-CSRF（任意非空值）→ 放行", () => {
    const d = checkCsrf({ ...base, origin: null, referer: null, xcsrf: "abc123" });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("custom-header");
  });

  test("空的 X-TuneX-CSRF 不构成凭证", () => {
    const d = checkCsrf({ ...base, origin: null, referer: null, xcsrf: "" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no-origin");
  });

  test("X-Requested-With 非 XMLHttpRequest 值不构成凭证", () => {
    const d = checkCsrf({ ...base, origin: null, referer: null, xrw: "fetch" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no-origin");
  });

  test("X-Requested-With 大小写不敏感（浏览器头值大小写有差异）", () => {
    const d = checkCsrf({ ...base, origin: null, referer: null, xrw: "xmlhttprequest" });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("custom-header");
  });

  test("自定义头优先于 Origin 判定（优先返回 custom-header）", () => {
    const d = checkCsrf({ ...base, origin: "https://evil.example", xrw: "XMLHttpRequest" });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("custom-header");
  });
});

describe("checkCsrf — Origin / Referer host 比对", () => {
  test("Origin host 与请求 Host 一致（同 scheme、含/不含端口）→ 放行", () => {
    const d1 = checkCsrf({ ...base, origin: "https://tunex.example" });
    expect(d1.allowed).toBe(true);
    expect(d1.reason).toBe("origin-match");

    const d2 = checkCsrf({ ...base, host: "tunex.example:8443", origin: "https://tunex.example:8443" });
    expect(d2.allowed).toBe(true);
    expect(d2.reason).toBe("origin-match");

    // http/https 不影响判定（scheme 不在 host 比较范围内）
    const d3 = checkCsrf({ ...base, origin: "http://tunex.example" });
    expect(d3.allowed).toBe(true);
    expect(d3.reason).toBe("origin-match");
  });

  test("Origin host 一致时大小写不同也放行（host 大小写不敏感）", () => {
    const d = checkCsrf({ ...base, host: "TuneX.Example", origin: "https://tunex.example" });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("origin-match");
  });

  test("Origin host 不一致 → 拒绝", () => {
    const d = checkCsrf({ ...base, origin: "https://evil.example" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("origin-mismatch");
  });

  test("端口不同视为跨站 → 拒绝", () => {
    const d = checkCsrf({ ...base, host: "tunex.example:8443", origin: "https://tunex.example:9000" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("origin-mismatch");
  });

  test("子域不同视为跨站 → 拒绝", () => {
    const d = checkCsrf({ ...base, origin: "https://sub.tunex.example" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("origin-mismatch");
  });

  test("Origin 非法（非 URL）→ 拒绝", () => {
    const d = checkCsrf({ ...base, origin: "not a url" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no-origin");
  });

  test("Origin 缺失但 Referer host 一致 → 放行（referer-match）", () => {
    const d = checkCsrf({
      ...base,
      origin: null,
      referer: "https://tunex.example/tunnels/12?tab=1",
    });
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe("referer-match");
  });

  test("Referer host 不一致 → 拒绝（origin-mismatch 而非 referer）", () => {
    const d = checkCsrf({ ...base, origin: null, referer: "https://evil.example/x" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no-origin");
  });

  test("Referer 非法（非 URL）→ 拒绝", () => {
    const d = checkCsrf({ ...base, origin: null, referer: "javascript:alert(1)" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no-origin");
  });

  test("Origin 与 Referer 都缺失 → 拒绝", () => {
    const d = checkCsrf({ ...base, origin: null, referer: null });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no-origin");
  });

  test("空串 origin/referer 视为缺失", () => {
    const d = checkCsrf({ ...base, origin: "", referer: "" });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no-origin");
  });
});

describe("csrf middleware (Hono 接线)", () => {
  function buildApp() {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (c, next) => {
      c.set("ip", "9.9.9.9");
      await next();
    });
    app.use("*", createCsrfMiddleware());
    app.post("/api/things", (c) => c.json({ ok: true }, 201));
    app.get("/api/things", (c) => c.json({ ok: true }));
    return app;
  }

  test("带 cookie + 同源 Origin 的 POST 通过 → 201", async () => {
    const res = await buildApp().request("/api/things", {
      method: "POST",
      headers: { cookie: "access=jwt", origin: "https://tunex.example", host: "tunex.example" },
    });
    expect(res.status).toBe(201);
  });

  test("带 cookie 的跨站 POST 被 403 拒绝（错误码 CSRF_REJECTED）", async () => {
    const res = await buildApp().request("/api/things", {
      method: "POST",
      headers: { cookie: "access=jwt", origin: "https://evil.example", host: "tunex.example" },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; reason?: string };
    expect(body.code).toBe("CSRF_REJECTED");
    expect(body.reason).toBe("origin-mismatch");
  });

  test("cookie 名之外的前缀不误判（session=xxx 不算会话 cookie）", async () => {
    const res = await buildApp().request("/api/things", {
      method: "POST",
      headers: { cookie: "other=1", origin: "https://evil.example", host: "tunex.example" },
    });
    expect(res.status).toBe(201);
  });

  test("X-Requested-With 头的跨站 POST 放行（自定义头凭证）", async () => {
    const res = await buildApp().request("/api/things", {
      method: "POST",
      headers: {
        cookie: "access=jwt",
        origin: "https://evil.example",
        host: "tunex.example",
        "x-requested-with": "XMLHttpRequest",
      },
    });
    expect(res.status).toBe(201);
  });

  test("豁免路径（支付回调）即使跨站也放行", async () => {
    const app = buildApp();
    app.post("/api/pay/epay/callback", (c) => c.json({ received: true }));
    const res = await app.request("/api/pay/epay/callback", {
      method: "POST",
      headers: { cookie: "access=jwt", origin: "https://evil.example", host: "tunex.example" },
    });
    expect(res.status).toBe(200);
  });

  test("GET 请求不受影响（安全方法）", async () => {
    const res = await buildApp().request("/api/things", {
      method: "GET",
      headers: { cookie: "access=jwt", host: "tunex.example" },
    });
    expect(res.status).toBe(200);
  });

  test("无 cookie 的 POST 放行（Bearer 通道不受 CSRF 约束）", async () => {
    const res = await buildApp().request("/api/things", {
      method: "POST",
      headers: { authorization: "Bearer key", host: "tunex.example" },
    });
    expect(res.status).toBe(201);
  });
});
