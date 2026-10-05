/**
 * V5-WP17.2 —— DNS provider 路由的**权限接线**（契约 F6 ③）。
 *
 * 为什么单独测这一层：服务层的断言覆盖了"作用域判定"，但**路由层用哪条权限**是另一回事 ——
 * 把 provider 的写操作挂到 `forward:update` 上也能通过所有服务层断言，而实际后果是"任何能改
 * 转发的人都能读写租户的 DNS 凭据"。所以这里钉住的是**中间件传给权限内核的 (action, resource)**：
 *
 *   · 读 → `("read", "settings")`
 *   · 写 → `("manage", "settings")`
 *
 * 另外两条：中间件**先于**处理器生效（被拒时请求根本到不了校验与数据库），以及载荷校验
 * 在放行之后按预期拒绝坏输入。
 *
 * 替身注入与 `node-health-route.test.ts` 同一模式：`mock.module` 必须在被测路由 import
 * **之前**注册。
 */
import { test, expect, describe, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const calls: Array<{ action: string; resource: string }> = [];
let deny = false;

mock.module("../../services/workspace.ts", () => ({
  resolveWorkspaceAccess: async (_c: unknown, action: string, resource: string) => {
    calls.push({ action, resource });
    if (deny) throw new HTTPException(403, { message: "工作空间角色无权操作" });
    return { id: 7, role: "owner" as const, customPermissions: null };
  },
}));

const { ddnsRoutes } = await import("../ddns.ts");

const app = new Hono<{ Variables: Record<string, never> }>();
// 认证中间件在真实应用里更早，这里只把 `user` 放进去 —— 本测试关心的是权限那一跳。
app.use("*", async (c, next) => {
  (c as unknown as { set: (k: string, v: unknown) => void }).set("user", { id: 1, super_admin: false });
  await next();
});
app.route("/api/ddns", ddnsRoutes);

const url = "http://localhost/api/ddns/providers";

beforeEach(() => {
  calls.length = 0;
  deny = false;
});

describe("V5-WP17.2: DNS provider 路由的权限接线", () => {
  test("拒绝时：读与写都在**中间件**被拦下，且用的是 settings family", async () => {
    deny = true;
    const read = await app.request(url);
    const write = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", type: "cloudflare", credential: { token: "t" } }),
    });
    expect(read.status).toBe(403);
    expect(write.status).toBe(403);
    expect(calls).toEqual([
      { action: "read", resource: "settings" },
      { action: "manage", resource: "settings" },
    ]);
  });

  test("放行时：写入走的是 `manage/settings`，而不是转发那套权限", async () => {
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 载荷非法 ⇒ 处理器在碰数据库之前就返回 400，于是这条测试完全不依赖 db 替身。
      body: JSON.stringify({ name: "", type: "cloudflare", credential: { token: "" } }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("invalid_input");
    expect(calls).toEqual([{ action: "manage", resource: "settings" }]);
  });

  test("未知字段被拒（载荷是**封闭**的：多一个键就是一次错误的猜测）", async () => {
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", type: "cloudflare", credential: { token: "t" }, workspace_id: 999 }),
    });
    expect(res.status).toBe(400);
  });

  test("凭据的子对象也是封闭的：`credential` 里多塞字段会被拒", async () => {
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", type: "cloudflare", credential: { token: "t", secrets: { a: 1 } } }),
    });
    expect(res.status).toBe(400);
  });

  test("删除走 `manage/settings`，且非法 id 在权限之后被拒", async () => {
    const bad = await app.request(`${url}/abc`, { method: "DELETE" });
    expect(bad.status).toBe(400);
    expect(calls).toEqual([{ action: "manage", resource: "settings" }]);
  });
});
