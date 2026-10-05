/**
 * V5-WP19-C —— `GET /api/forwards/:id/topology` 的**行为级可达性**测试。
 *
 * 为什么单有"注册顺序守卫"还不够：`forward-route-order.test.ts` 是**读源码**判断顺序的，
 * 它能挡住"把新路由写到 catch-all 之后"，但挡不住"路由写对了顺序却因为别的原因不可达"。
 * 所以这里挂**真实**的 `forwardsRoutes`，用 `app.request()` 真的打一次。
 *
 * ── 2026-10-05 修正：mock 必须**透传**真实模块的全部导出 ──
 * `mock.module` 是**进程级**注册表，而它替换的是**整个模块**。本文件原先这样写：
 *
 *   mock.module("../../services/forward-topology.ts", () => ({ defaultTopologyDeps, loadForwardTopology }))
 *
 * 于是同一进程里**别的测试文件**一旦 import 该模块的其它导出（`v5-wp19-c-topology.test.ts`
 * 要 `projectForwardTopology`），就在**加载阶段**失败：
 *
 *   SyntaxError: Export named 'projectForwardTopology' not found in module '…/forward-topology.ts'
 *
 * **而这条失败的输出没有 `(fail)` 前缀** ⇒ 我几次用 `grep '^(fail)'` 查它都没命中，把它误判成
 * "负载敏感假红" ✗（真实情况是：全量套件**稳定地** `2747 pass / 1 fail`，而 WP19-C 的断言
 * 其实**从未真正跑过**）。这是本会话里我最该记住的一次误判 —— **只按一种"失败长什么样"去查，
 * 没有去读错误原文**。
 *
 * 修法：先 import 真实模块，再把两个要替身的导出覆盖掉、其余**原样透传**：
 *   `mock.module(path, () => ({ ...real, one: …, two: … }))`
 * 这样别的文件的 import 依旧拿到真实现 ✓，而本文件仍然能控制路由看到的数据 ✓。
 * （仓库里另一条路是整段搬进子进程 —— 见 `workspace-rbac-v4.test.ts`；那更适合"连 mock 之间
 * 也会互相污染"的场景，本文件用透传就够，且不必处理子进程的退出与 Redis 重连问题。）
 */
import { beforeEach, describe, expect, test, mock } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const TOPOLOGY_MODULE = "../../services/forward-topology.ts";
// 先拿真实现（后面透传它）：`mock.module` 会替换整个模块，凡是别人也 import 的导出都必须保留。
const realTopology = await import(TOPOLOGY_MODULE);

const accesses: Array<{ action: string; resource: string }> = [];
let deny = false;
let topologyResult: unknown = {
  ok: true,
  topology: { forward_id: 7, mode: "relay", segments: [], observed_at: null, stale_segments: 0 },
};

mock.module("../../services/workspace.ts", () => ({
  resolveWorkspaceAccess: async (_c: unknown, action: string, resource: string) => {
    accesses.push({ action, resource });
    if (deny) throw new HTTPException(403, { message: "工作空间角色无权操作" });
    return { id: 3, role: "owner" as const, customPermissions: null };
  },
  canWorkspaceResourceAction: () => true,
  workspacePermissionDenied: () => new HTTPException(403, { message: "工作空间角色无权操作" }),
}));

// 只覆盖这两个导出，其余**透传**（关键是 `projectForwardTopology` 必须还在）。
mock.module(TOPOLOGY_MODULE, () => ({
  ...realTopology,
  defaultTopologyDeps: () => ({}),
  loadForwardTopology: async () => topologyResult,
}));

const { forwardsRoutes } = await import("../forwards.ts");

const app = new Hono<{ Variables: Record<string, never> }>();
app.use("*", async (c, next) => {
  (c as unknown as { set: (k: string, v: unknown) => void }).set("user", { id: 1, super_admin: false });
  await next();
});
app.route("/api/forwards", forwardsRoutes);

const url = "http://localhost/api/forwards/7/topology";

beforeEach(() => {
  accesses.length = 0;
  deny = false;
  topologyResult = {
    ok: true,
    topology: { forward_id: 7, mode: "relay", segments: [], observed_at: null, stale_segments: 0 },
  };
});

describe("V5-WP19-C: 拓扑视图的路由可达性", () => {
  test("真的能被路由到（没被 /:id/:action 之类的 catch-all 吃掉）", async () => {
    const res = await app.request(url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { forward_id?: number } };
    expect(body.data?.forward_id).toBe(7);
  });

  test("读权限：用 forward:read，且被拒时请求根本到不了处理器", async () => {
    deny = true;
    const res = await app.request(url);
    expect(res.status).toBe(403);
    expect(accesses).toEqual([{ action: "read", resource: "forward" }]);
  });

  test("转发不存在 ⇒ 404（不是空拓扑）", async () => {
    topologyResult = { ok: false, code: "not_found", message: "端口转发不存在" };
    const res = await app.request(url);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("not_found");
  });

  test("计划不成立 ⇒ 409 且带原因码（把「拓扑不成立」与「转发不存在」分开）", async () => {
    topologyResult = { ok: false, code: "no_ingress_node", message: "该转发还没有入口节点" };
    const res = await app.request(url);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("no_ingress_node");
  });
});
