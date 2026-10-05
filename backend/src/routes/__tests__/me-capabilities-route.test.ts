/**
 * V5-WP20-6b — `GET /api/me/capabilities` 的 **HTTP 契约**回归。
 *
 * 为什么单开一个文件、并且跑在**子进程**里（沿用 `workspace-rbac-v4.test.ts` 的模式）：
 *   1. 本用例要替换 `services/policy-service.ts` 与 `services/workspace.ts`，
 *      而 `mock.module` 是**进程级**注册表 —— 与其它路由套件同进程会互相污染
 *      （那个文件顶部已经记过这条教训："Run mocks in a child process so Bun's global
 *      module registry cannot replace workspace authorization in unrelated route suites"）。
 *   2. 断言的是「HTTP 状态码 + 响应体形状 + 路由把哪些参数交给了服务层」，
 *      而不是纯函数 —— 这正是「模块存在、路由没挂」那类缺陷唯一能被抓住的地方。
 *
 * 覆盖：
 *   A. 未认证 ⇒ 401（不触碰服务层）；
 *   B. 已认证 ⇒ 200 + `{data: …}` 信封，且**口径来自生效策略**（`limits.traffic_period`、
 *      `traffic_used` 是窗口求和值、联邦缺口字段在）；
 *   C. 工作空间解析与 dashboard 同源（同一个 `resolveWorkspaceMembership`），
 *      并且传下去的是**解析出来的 workspace id**（不是请求里声称的、也不是用户 id）；
 *   D. 接线守卫：端点真的挂载在 `/api/me`，且 `getWorkspaceUsageReport` 有调用者
 *      （它此前是零调用者的死代码）。
 *
 * 跑法（backend 目录）：bun test src/routes/__tests__/me-capabilities-route.test.ts
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const root = new URL("../..", import.meta.url).pathname;

const scenario = String.raw`
import { mock, expect } from "bun:test";
import { Hono } from "hono";
const root = process.env.TUNEX_ME_ROOT;

let authed = true;
let seenWorkspaceId = null;
let seenNow = null;
const calls = [];

// 服务层替身：报告内容就是「生效策略口径」的 fixture（period=month ⇒ 窗口求和）。
mock.module(root + "services/policy-service.ts", () => ({
  getWorkspaceUsageReport: async (workspaceId, opts) => {
    seenWorkspaceId = workspaceId;
    seenNow = opts?.now ?? null;
    calls.push("report");
    return {
      tunnels: 2,
      nodes: 1,
      members: 3,
      traffic_used: 1234,              // 窗口求和值（不是 legacy 列）
      traffic_used_unattributed_federated: 99,
      policy: { tunnel_types: ["tcp"], deny_scope: false },
      limits: { traffic_period: "month", traffic_limit: 10000, max_tunnels: 5 },
    };
  },
}));

// 工作空间解析替身：模拟 x-workspace-id 命中的那个租户（id=42）。
mock.module(root + "services/workspace.ts", () => ({
  resolveWorkspaceMembership: async () => ({ id: 42, kind: "personal" }),
}));

const { meRoutes } = await import(root + "routes/me.ts");
const app = new Hono();
app.use("*", async (c, next) => {
  if (authed) c.set("user", { id: 7, email: "u@tunex.local" });
  await next();
});
app.route("/api/me", meRoutes);

const get = async () => {
  const res = await app.request("/api/me/capabilities");
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }  // 401 是纯文本 "Unauthorized"
  return { status: res.status, text, body };
};

// A. 未认证 ⇒ 401，且不触碰服务层
authed = false;
const unauth = await get();
expect(unauth.status).toBe(401);
expect(unauth.text).toContain("Unauthorized");
expect(calls).toEqual([]);

// B/C. 已认证 ⇒ 200 + 生效策略口径 + 解析出的 workspace id
authed = true;
const ok = await get();
expect(ok.status).toBe(200);
const data = ok.body.data;
expect(data.traffic_used).toBe(1234);
expect(data.limits.traffic_period).toBe("month");
expect(data.limits.traffic_limit).toBe(10000);
expect(data.traffic_used_unattributed_federated).toBe(99);
expect(data.policy.tunnel_types).toEqual(["tcp"]);
expect(calls).toEqual(["report"]);
expect(seenWorkspaceId).toBe(42);
// 时间点必须显式透传（同一次请求里只有一个 now ⇒ 窗口起点不会算两遍）
expect(seenNow instanceof Date).toBe(true);
console.log("ME CAPABILITIES CHECKS OK");
`;

test("GET /api/me/capabilities：401 / 200 + 生效策略口径 / 传对 workspace", () => {
  const result = spawnSync(process.execPath, ["-e", scenario], {
    cwd: root,
    env: {
      ...process.env,
      TUNEX_ME_ROOT: root,
      // 与 tests/preload-env.ts 同口径的占位值：`bun -e` 不加载 preload，
      // 而路由的传递依赖里可能有 `env.ts` 的 requireSecret（只在 import 期读）。
      DATABASE_URL: process.env.DATABASE_URL ?? "mysql://tunex-test:tunex-test@127.0.0.1:3306/tunex_test_unused", // secret-scan:allow — local test fixture
      REDIS_URL: process.env.REDIS_URL ?? "redis://127.0.0.1:6379/15",
      AUTH_SECRET: process.env.AUTH_SECRET ?? "tunex-unit-test-auth-secret-not-a-real-secret", // secret-scan:allow — local test fixture
      LICENSE_SECRET: process.env.LICENSE_SECRET ?? "tunex-unit-test-license-secret-not-a-real-secret", // secret-scan:allow — local test fixture
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
  expect(result.stdout).toContain("ME CAPABILITIES CHECKS OK");
  expect(result.error).toBeUndefined();
});

test("接线守卫：端点真的挂在 /api/me，且 getWorkspaceUsageReport 不再是零调用者", async () => {
  const { readFileSync } = await import("node:fs");
  const app = readFileSync(root + "app.ts", "utf8");
  const me = readFileSync(root + "routes/me.ts", "utf8");

  // 挂载点（route-mount-coverage.test.ts 会机械地盯 router 导出，这里再钉具体前缀）
  expect(app).toContain('app.route("/api/me", meRoutes)');
  // 契约 §3.3.2 指定的读路径：这个端点必须真的调用那份报告
  expect(me).toContain("getWorkspaceUsageReport(workspace.id");
  // 死代码的解法：给它调用者（不是删掉它）—— 全仓至少要有一个生产调用点
  expect(me).toContain('import { getWorkspaceUsageReport } from "../services/policy-service.ts";');
  const callers = me.match(/getWorkspaceUsageReport\(/g) ?? [];
  expect(callers).toHaveLength(1); // import 行没有括号，命中的就是那个真实调用
});
