/**
 * V4-F2 — `PATCH /api/admin/node/:id/role` 的 **HTTP 契约**回归。
 *
 * 为什么单开一个路由层文件：Gate V4-F2 的 F2.9.11 / F2.9.12 断言的是
 * **HTTP 状态码 + DB 事实**，不是服务层内部的 `{ ok: false }`：
 *
 *   F2.9.11 §13.4.3：承载入口 Forward 时 PATCH role 收缩必须被后端阻止
 *            → 期望 `HTTP 409` 且 `SELECT role ... = both`
 *   F2.9.12 §13.4.3：使 active 租约悬空的端口区间收缩必须被后端阻止
 *            → 期望 `HTTP 409` 且 `port_range = 22000-22099`
 *
 * 缺陷形态（修复前实测）：同一节点上 `GET /node/:id/impact` 回
 * `role_check.ok=false`，而 `PATCH .../role` 回 **200 且 DB 已改**——预检与
 * 写路径口径漂移。服务层用例（`services/__tests__/node-admin.test.ts`）覆盖
 * 判定本身，本文件覆盖「判定结论 → HTTP 状态码 → 行是否被改」这条完整链路，
 * 特别是 409 ← `invalid_state` 的映射与 `condition` 的透出（§13.5 可区分错误码）。
 *
 * 替身注入沿用 `node-lifecycle-route.test.ts` / `lifecycle-db-stub.ts` 的同一
 * 模式：`mockDb()` 必须在 import 被测路由**之前**调用（`routes/node-admin.ts`
 * 顶层 `import { db } from "../db.ts"` 只在首次求值时绑定）。
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  mockDb,
  resetLifecycleStub,
  stubState,
  dbStub,
  STUB_CRED_HASH as CRED_HASH,
} from "../../__tests__/lifecycle-db-stub.ts";

mockDb();

const { nodeAdminRoutes } = await import("../node-admin.ts");
const { updateNodeRole } = await import("../../services/node-admin.ts");

/** 模块级单实例：Hono 的路由表在 route() 时一次性注册。 */
const app = new Hono<{ Variables: Record<string, never> }>();
app.route("/api/admin", nodeAdminRoutes);

/** 连响应正文一起回：断言消息里带上后端原话，失败时不用再猜。 */
async function patchRole(id: number | string, body: unknown) {
  const res = await app.request(`/api/admin/node/${id}/role`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

beforeEach(() => {
  resetLifecycleStub();
});

describe("PATCH /api/admin/node/:id/role — §13.4.3 依赖收缩 fail-closed", () => {
  test("自检：服务层用同一替身能拿到 impact 统计（排除替身面不足）", async () => {
    const node = stubState.seedNode({ role: "both" });
    stubState.pushTunnel({ ingress_node_id: node.id, egress_node_id: null });

    const r = await updateNodeRole(node.id, { role: "egress" }, { db: dbStub as never });

    expect(JSON.stringify(r)).toContain("node_still_used_as_ingress");
  });

  test("F2.9.11：承载入口 Forward 的 BOTH 节点收缩为 EGRESS → 409 且 role 仍为 both", async () => {
    const node = stubState.seedNode({
      role: "both",
      port_range_min: 22000,
      port_range_max: 22099,
    });
    // 真实依赖：一条以该节点为入口的 Forward。
    stubState.pushTunnel({ ingress_node_id: node.id, egress_node_id: null });

    const res = await patchRole(node.id, { role: "egress" });

    expect(res.status, res.text).toBe(409);
    expect(res.body.code).toBe("invalid_state");
    // 与 GET /node/:id/impact 的 role_check.condition 同源。
    expect(res.body.condition).toBe("node_still_used_as_ingress");
    expect(res.body.dependencies).toMatchObject({ ingress_forward_count: 1 });
    // 关键：DB 一个字段都没动（缺陷时这里是 "egress"）。
    expect(stubState.node(node.id)?.role).toBe("both");
  });

  test("F2.9.12：使 active 租约悬空的区间收缩 → 409 且区间不变、文案点名端口", async () => {
    const node = stubState.seedNode({
      role: "both",
      port_range_min: 22000,
      port_range_max: 22099,
    });
    stubState.pushLease({ node_id: node.id, port: 22050, status: "active" });

    const res = await patchRole(node.id, {
      role: "both",
      port_range_min: 22060,
      port_range_max: 22099,
    });

    expect(res.status, res.text).toBe(409);
    expect(res.body.condition).toBe("port_range_would_orphan_leases");
    expect(String(res.body.message)).toContain("22050");
    const after = stubState.node(node.id);
    expect(after?.port_range_min).toBe(22000);
    expect(after?.port_range_max).toBe(22099);
  });

  test("F2.9.16 的镜像：依赖清空后同样收缩 200 且真实落库（不是一律拒绝）", async () => {
    const node = stubState.seedNode({ role: "both" });

    const res = await patchRole(node.id, { role: "egress" });

    expect(res.status, res.text).toBe(200);
    expect(stubState.node(node.id)?.role).toBe("egress");
  });

  test("只改 lb_strategy 不触发收缩判定（不会被误判成丢掉入口能力）", async () => {
    const node = stubState.seedNode({ role: "egress" });
    // 出口依赖存在也不影响：本次不改角色、不改区间。
    stubState.pushTunnel({ ingress_node_id: null, egress_node_id: node.id });

    const res = await patchRole(node.id, { lb_strategy: "rand" });

    expect(res.status, res.text).toBe(200);
    expect((stubState.node(node.id) as Record<string, unknown> | undefined)?.lb_strategy).toBe(
      "rand",
    );
  });

  test("拒绝响应同样不外泄凭据哈希（§7 纪律在错误路径上也成立）", async () => {
    const node = stubState.seedNode({ role: "both" });
    stubState.pushTunnel({ ingress_node_id: node.id, egress_node_id: null });

    const res = await patchRole(node.id, { role: "egress" });

    expect(res.status, res.text).toBe(409);
    expect(res.text).not.toContain(CRED_HASH);
  });
});
