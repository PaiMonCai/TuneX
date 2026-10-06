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
 *
 * ── 2026-10-07 修正：替身必须**语义完整**（透传真实模块的全部运行时导出）──
 *
 * `mock.module` 是**进程级**注册表，替换的是**整个** `workspace.ts`。本文件原先只给了
 * 一个 `resolveWorkspaceAccess`，于是同一进程里后跑的测试在**加载阶段**就炸：
 *
 *   SyntaxError: Export named 'createPersonalWorkspace' not found in module '…/services/workspace.ts'
 *
 * 复现（只跑这两个文件，无需其它）：
 *   bun test src/routes/__tests__/ddns-provider-route.test.ts \
 *            src/routes/__tests__/route-mount-coverage.test.ts --timeout 10000
 *   → 5 pass / 1 fail / 1 error（`route-mount-coverage` 经 `app.ts` 间接需要
 *     `createPersonalWorkspace`；全量跑因文件被分派到不同 worker 而侥幸绿 ⇒ 顺序敏感）。
 *
 * 修法与 `forward-route-topology.test.ts` 同一取向：**先 import 真实现，再只覆盖要
 * 替身的那一个导出**（`{ ...real, resolveWorkspaceAccess: spy }`）。替身本身是必要的：
 * 真实现要连库，而本文件要钉的是"路由中间件把哪一对 (action, resource) 交给权限内核" ——
 * 那是**调用参数**，不是真实现的返回值，只有 spy 看得见。但替身的**面**必须完整。
 */
import { test, expect, describe, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const WORKSPACE_MODULE = "../../services/workspace.ts";

// 先拿真实现（后面透传它）：`mock.module` 替换整个模块，凡是别人也 import 的导出都必须
// 保留 —— 否则失败会发生在**别的文件**的加载阶段，排查成本极高。
const realWorkspace = await import(WORKSPACE_MODULE);

const calls: Array<{ action: string; resource: string }> = [];
let deny = false;

/**
 * 交给 `mock.module` 的替身构造器。
 *
 * 抽成具名函数是为了能被下面的"防复发"断言**直接调用检查** —— 因为 Bun 的语义是：
 * `mock.module` 只对**之后首次 import 该模块的文件**生效；本文件已经 import 过真实现，
 * 所以从本文件里再怎么 `await import(...)` 拿到的都是**真实现**，看不到自己的替身
 * （实测：同 specifier 与绝对路径 specifier 都返回真实现）。受害方永远是**另一个文件**，
 * 这正是这个缺陷只在特定跑法下出现、且失败输出不带 `(fail)` 前缀的原因。
 * 所以能钉住的就是"我们交给注册表的那个对象"。
 */
function buildWorkspaceMock(): Record<string, unknown> {
  return {
    ...realWorkspace,
    resolveWorkspaceAccess: async (_c: unknown, action: string, resource: string) => {
      calls.push({ action, resource });
      if (deny) throw new HTTPException(403, { message: "工作空间角色无权操作" });
      return { id: 7, role: "owner" as const, customPermissions: null };
    },
  };
}

mock.module(WORKSPACE_MODULE, buildWorkspaceMock);

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

/* ================================================================== */
/* 防复发：替身的导出面必须 ⊇ 真实模块                                    */
/* ================================================================== */

describe("替身语义完整（同进程其它测试依赖这一点）", () => {
  test("替身的导出集合 ⊇ 真实模块的**每一个**运行时导出", () => {
    // 这条守卫的存在理由：`mock.module` 是进程级替换，替身缺一个导出就会让**另一个
    // 文件**在加载阶段 SyntaxError `Export named 'X' not found`，而那种失败的输出
    // 没有 `(fail)` 前缀、只在特定跑法下出现 —— 极难归因（本文件 2026-10-07 就踩过）。
    //
    // 断言对象是**交给注册表的那个对象**（`buildWorkspaceMock()`），不是 `await import()`：
    // Bun 只对"之后首次 import 的文件"生效，本文件已经 import 过真实现，因此从本文件里
    // 拿不到自己的替身（见 `buildWorkspaceMock` 的注释）。
    const mock = buildWorkspaceMock();
    const missing = Object.keys(realWorkspace).filter((name) => !(name in mock));
    expect(missing).toEqual([]);
    expect(Object.keys(realWorkspace).length).toBeGreaterThan(0);
    // 允许多给（今天就是"透传 + 覆盖一个"），但少给一个都不行 ⇒ 断言用 ⊇ 而不是 ===。
  });

  test("替身确实换掉了那一个导出，其余仍是真实现本体（不是重新包装）", () => {
    const mock = buildWorkspaceMock();
    expect(mock.resolveWorkspaceAccess).not.toBe(realWorkspace.resolveWorkspaceAccess);
    expect(mock.createPersonalWorkspace).toBe(realWorkspace.createPersonalWorkspace);
    expect(mock.resolveWorkspaceMembership).toBe(realWorkspace.resolveWorkspaceMembership);
  });

  test("回归反例：手写的部分替身会被上面两条挡住", () => {
    // 把 2026-10-07 之前的写法（只有 resolveWorkspaceAccess 的字面量）当作输入，
    // 证明守卫**真的会红** —— 而不是一条恒真断言。
    const partial: Record<string, unknown> = { resolveWorkspaceAccess: async () => ({}) };
    const missing = Object.keys(realWorkspace).filter((name) => !(name in partial));
    expect(missing).toContain("createPersonalWorkspace");
    expect(missing).toContain("resolveWorkspaceMembership");
    expect(missing.length).toBeGreaterThan(0);
  });
});
