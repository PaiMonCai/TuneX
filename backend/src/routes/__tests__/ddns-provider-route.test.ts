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

mock.module(WORKSPACE_MODULE, () => ({
  ...realWorkspace,
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

/* ================================================================== */
/* 防复发：替身的导出面必须 ⊇ 真实模块                                    */
/* ================================================================== */

describe("替身语义完整（同进程其它测试依赖这一点）", () => {
  test("mock 的导出集合包含真实模块的**每一个**运行时导出", async () => {
    // 这条守卫的存在理由：`mock.module` 是进程级替换，替身缺一个导出就会让**另一个
    // 文件**在加载阶段 SyntaxError `Export named 'X' not found`，而那种失败的输出
    // 没有 `(fail)` 前缀、只在特定跑法下出现 —— 极难归因（本文件 2026-10-07 就踩过）。
    const mocked = (await import(WORKSPACE_MODULE)) as Record<string, unknown>;
    const missing = Object.keys(realWorkspace).filter((name) => !(name in mocked));
    expect(missing).toEqual([]);
    // 反方向不要求相等：替身**允许**多给（今天就是多给了 `...realWorkspace` 之外的覆盖），
    // 但少给一个都不行。用 `⊇` 而不是 `===`，正是为了让这条断言只表达纪律本身。
    expect(Object.keys(realWorkspace).length).toBeGreaterThan(0);
  });

  test("替身确实换掉了那一个导出（否则上面的等式可能只是在自欺）", async () => {
    const mocked = (await import(WORKSPACE_MODULE)) as Record<string, unknown>;
    expect(mocked.resolveWorkspaceAccess).not.toBe(realWorkspace.resolveWorkspaceAccess);
    // 其余导出必须是**真实现本体**（透传），不是重新包装的等价物。
    expect(mocked.createPersonalWorkspace).toBe(realWorkspace.createPersonalWorkspace);
    expect(mocked.resolveWorkspaceMembership).toBe(realWorkspace.resolveWorkspaceMembership);
  });
});
