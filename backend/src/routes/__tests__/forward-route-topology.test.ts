/**
 * V5-WP19-C —— `GET /api/forwards/:id/topology` 的**行为级可达性**测试。
 *
 * 为什么单有"注册顺序守卫"还不够：`forward-route-order.test.ts` 是**读源码**判断顺序的，
 * 它能挡住"把新路由写到 catch-all 之后"，但挡不住"路由写对了顺序却因为别的原因不可达"
 * （例如路径拼错、方法写错、被更早的同形状路由吃掉）。所以这里挂**真实**的
 * `forwardsRoutes`，用 `app.request()` 真的打一次 —— 顺序、方法、路径三者一起被验证。
 *
 * 这条测试的由来值得写下来：本仓在同一个 WP 里被"单独 mount 的路由测试验证不了它在应用里
 * 真的可达"咬过两次（`POST /:id/dns` 被 catch-all 吃掉；`preferred-ingress` 因 Prisma 字段
 * 写错 500）。两次都是**真拓扑**发现的，而两次的单元测试都是绿的。
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

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

mock.module("../../services/forward-topology.ts", () => ({
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
