/**
 * V4-WP5 — Node lifecycle 路由层测试（Hono `app.request`，不连 DB/Redis）。
 *
 * 覆盖行为（对照 `routes/node-lifecycle.ts` 的端点表）：
 *   · 404 —— 路径 id 既不是数字主键也不是 node_id 字符串；
 *   · 400 —— lifecycle / note 入参非法（在 DB 之前被挡）；
 *   · 409 —— 迁移白名单拒绝（retiring → active）；
 *   · 409 —— 删除闸门（未退役 / 依赖非空），且**行不被删**；
 *   · 200 —— 同值幂等保存；retiring + 干净 → 删除成功，行消失；
 *   · impact 端点回五类计数 + role_check（角色收缩 / 端口区间收缩各自独立判定）；
 *   · **凭据哈希绝不外泄**：任何响应的 JSON 都不含哈希串。
 *
 * ── 替身注入（沿用 node-credential.test.ts 的同一模式）──
 * 路由模块顶层 `import { db } from "../../db.ts"`，而该模块只在首次求值时
 * 读一次 `globalThis.__tunexPrisma`。所以**不能**指望「先 import 路由，再改
 * 全局」——module scope 的 `const db` 早已绑定。
 *
 * 因此这里：模块级 `dbStub` + `mock.module(../../db.ts)`（在 import 被测
 * 路由之前注册）+ 顶层 await import。`resetState()` 在 beforeEach 清空
 * `dbStub` 持有的数组/Maps，行为与按函数 inject 等价。
 *
 * ⚠️ 进程级副作用：mock.module 是 Bun 进程级注册表，同进程后续加载的测试
 * 文件若之前没 import 过 `db.ts`，也会拿到这个替身。本文件把 `db` 的导出面
 * 补齐（node / tunnel / nodeBinding / nodePortLease / egressPool），与
 * `services/node-admin.ts`、`services/node-lifecycle.ts` 实际调用面对齐。
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  mockDb,
  resetLifecycleStub,
  stubState,
  STUB_CRED_HASH as CRED_HASH,
} from "../../__tests__/lifecycle-db-stub.ts";

type NodeRow = ReturnType<typeof stubState.seedNode>;

// 代理到共享替身的薄封装（保持原测试体的可读形状）。
const nodes = {
  get: (id: number) => stubState.node(id),
  has: (id: number) => stubState.hasNode(id),
};
const tunnelRows = { push: stubState.pushTunnel };
const bindingRows = { push: stubState.pushBinding };
const leaseRows = { push: stubState.pushLease };
const poolRows = { push: stubState.pushPool };

function resetState(): void {
  resetLifecycleStub();
}

function seedNode(over: Parameters<typeof stubState.seedNode>[0] = {}): NodeRow {
  return stubState.seedNode(over);
}

/** Prisma P2025：update/delete 的目标行不存在（共享替身内部也用同一形状）。 */

// mock.module 必须在被测模块 import **之前**注册。共享替身保证：同进程内
// services/__tests__ 与 routes/__tests__ 注册的是**同一个** dbStub 对象，
// 谁先注册都不会把对方的用例打挂（见 lifecycle-db-stub.ts 顶部说明）。
mockDb();

// 替身就位后才 import 被测路由（此时 db.ts 已被替换）。
const { nodeLifecycleRoutes } = await import("../node-lifecycle.ts");

/** 模块级单实例：Hono 的路由表在 route() 时一次性注册。 */
const app = new Hono<{ Variables: Record<string, never> }>();
app.route("/api/admin", nodeLifecycleRoutes);

beforeEach(() => {
  resetLifecycleStub();
});

/* ------------------------------------------------------------------ */
/* GET /api/admin/node/:id/lifecycle                                   */
/* ------------------------------------------------------------------ */

describe("GET /api/admin/node/:id/lifecycle", () => {
  test("active + online → accepts_new_business=true，含全部四态迁移目标", async () => {
    const node = seedNode();
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.lifecycle).toBe("active");
    expect(body.data.connection).toBe("online");
    expect(body.data.accepts_new_business).toBe(true);
    expect(body.data.admission_rejection).toBeNull();
    expect(body.data.allowed_transitions).toEqual(["active", "maintenance", "disabled", "retiring"]);
    // 凭据纪律：只有布尔，不明文不哈希
    expect(body.data.has_credential).toBe(true);
    expect(JSON.stringify(body)).not.toContain(CRED_HASH);
  });

  test("node_id 字符串也能定位（resolveNodeId 的两种入参）", async () => {
    const node = seedNode();
    const res = await app.request(`/api/admin/node/${encodeURIComponent(String(node.node_id))}/lifecycle`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { node_id: string } };
    expect(body.data.node_id).toBe(node.node_id);
  });

  test("maintenance → accepts_new_business=false + rejection=node_in_maintenance", async () => {
    const node = seedNode({ lifecycle: "maintenance" });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.accepts_new_business).toBe(false);
    expect(body.data.admission_rejection).toBe("node_in_maintenance");
    expect(body.data.allowed_transitions).toEqual(["active", "maintenance", "disabled", "retiring"]);
  });

  test("retiring → 迁移目标只有 retiring（前端应只留删除）", async () => {
    const node = seedNode({ lifecycle: "retiring" });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`);
    const body = (await res.json()) as { data: { allowed_transitions: string[] } };
    expect(body.data.allowed_transitions).toEqual(["retiring"]);
  });

  test("节点不存在 → 404 { error, message }", async () => {
    const res = await app.request("/api/admin/node/424242/lifecycle");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("节点不存在");
    expect(body.message).toBe("节点不存在");
  });
});

/* ------------------------------------------------------------------ */
/* PATCH /api/admin/node/:id/lifecycle                                 */
/* ------------------------------------------------------------------ */

describe("PATCH /api/admin/node/:id/lifecycle", () => {
  test("active → maintenance（带 note）写库并回投影", async () => {
    const node = seedNode();
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lifecycle: "maintenance", note: "计划维护" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { node: Record<string, unknown>; view: Record<string, unknown> };
    };
    expect(body.data.node.lifecycle).toBe("maintenance");
    expect(body.data.node.lifecycle_note).toBe("计划维护");
    expect(body.data.node.lifecycle_updated_at).not.toBeNull();
    expect(body.data.view.accepts_new_business).toBe(false);
    // 哈希绝不外泄
    expect(JSON.stringify(body)).not.toContain(CRED_HASH);
    // 状态真的落到了替身里
    expect(nodes.get(node.id)!.lifecycle).toBe("maintenance");
  });

  test("maintenance → active 恢复准入", async () => {
    const node = seedNode({ lifecycle: "maintenance" });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lifecycle: "active" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { view: { accepts_new_business: boolean } } };
    expect(body.data.view.accepts_new_business).toBe(true);
  });

  test("同值迁移合法（幂等保存 note）", async () => {
    const node = seedNode({ lifecycle: "maintenance" });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lifecycle: "maintenance", note: "继续维护" }),
    });
    expect(res.status).toBe(200);
    expect(nodes.get(node.id)!.lifecycle_note).toBe("继续维护");
  });

  test("retiring → active 拒绝：409 + condition=invalid_transition", async () => {
    const node = seedNode({ lifecycle: "retiring" });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lifecycle: "active" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; condition?: string; message: string };
    expect(body.code).toBe("invalid_state");
    expect(body.condition).toBe("invalid_transition");
    expect(body.message).toContain("retiring");
    // 不被改
    expect(nodes.get(node.id)!.lifecycle).toBe("retiring");
  });

  test("disabled → maintenance 拒绝", async () => {
    const node = seedNode({ lifecycle: "disabled" });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lifecycle: "maintenance" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { condition: string };
    expect(body.condition).toBe("invalid_transition");
  });

  test("非法 lifecycle → 400（不碰 DB）", async () => {
    const node = seedNode();
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lifecycle: "retired" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_input");
    expect(nodes.get(node.id)!.lifecycle).toBe("active");
  });

  test("超长 note → 400", async () => {
    const node = seedNode();
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lifecycle: "maintenance", note: "x".repeat(256) }),
    });
    expect(res.status).toBe(400);
  });

  test("note 空串 = 显式清空（无 lifecycle 键时也生效）", async () => {
    const node = seedNode({ lifecycle: "maintenance", lifecycle_note: "旧原因" });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "" }),
    });
    expect(res.status).toBe(200);
    expect(nodes.get(node.id)!.lifecycle_note).toBeNull();
  });

  test("空 body / 非 JSON body → 200 且不动状态（视为无操作）", async () => {
    const node = seedNode({ lifecycle: "retiring" });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, { method: "PATCH" });
    expect(res.status).toBe(200);
    expect(nodes.get(node.id)!.lifecycle).toBe("retiring");
  });

  test("节点不存在 → 404", async () => {
    const res = await app.request("/api/admin/node/424242/lifecycle", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lifecycle: "maintenance" }),
    });
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/admin/node/:id/impact                                      */
/* ------------------------------------------------------------------ */

describe("GET /api/admin/node/:id/impact", () => {
  test("干净节点 → 全零 impact + role_check.ok", async () => {
    const node = seedNode();
    const res = await app.request(`/api/admin/node/${node.id}/impact`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { impact: Record<string, unknown>; role_check: { ok: boolean } };
    };
    expect(body.data.impact).toEqual({
      ingress_forward_count: 0,
      egress_forward_count: 0,
      binding_count: 0,
      active_port_lease_count: 0,
      egress_pool_count: 0,
      blockers: [],
    });
    expect(body.data.role_check.ok).toBe(true);
  });

  test("五类依赖各计各的", async () => {
    const node = seedNode();
    tunnelRows.push({ ingress_node_id: node.id, egress_node_id: null });
    tunnelRows.push({ ingress_node_id: node.id, egress_node_id: 999 });
    tunnelRows.push({ ingress_node_id: 999, egress_node_id: node.id });
    bindingRows.push({ ingress_node_id: node.id, egress_node_id: 999 });
    leaseRows.push({ node_id: node.id, port: 10001, status: "active" });
    poolRows.push({ node_id: node.id });
    const res = await app.request(`/api/admin/node/${node.id}/impact`);
    const body = (await res.json()) as { data: { impact: Record<string, number> } };
    expect(body.data.impact.ingress_forward_count).toBe(2);
    expect(body.data.impact.egress_forward_count).toBe(1);
    expect(body.data.impact.binding_count).toBe(1);
    expect(body.data.impact.active_port_lease_count).toBe(1);
    expect(body.data.impact.egress_pool_count).toBe(1);
  });

  test("?next_role=ingress 丢掉出口能力但有出口 Forward → role_check 拒绝", async () => {
    const node = seedNode();
    tunnelRows.push({ ingress_node_id: 999, egress_node_id: node.id });
    const res = await app.request(`/api/admin/node/${node.id}/impact?current_role=both&next_role=ingress`);
    const body = (await res.json()) as { data: { role_check: { ok: boolean; condition: string } } };
    expect(body.data.role_check.ok).toBe(false);
    expect(body.data.role_check.condition).toBe("node_still_used_as_egress");
  });

  test("?next_role=ingress 干净 → role_check.ok", async () => {
    const node = seedNode();
    const res = await app.request(`/api/admin/node/${node.id}/impact?current_role=both&next_role=ingress`);
    const body = (await res.json()) as { data: { role_check: { ok: boolean } } };
    expect(body.data.role_check.ok).toBe(true);
  });

  test("?port_min/port_max 收缩罩住 active 租约 → port_range_would_orphan_leases", async () => {
    const node = seedNode();
    leaseRows.push({ node_id: node.id, port: 9999, status: "active" });
    const res = await app.request(`/api/admin/node/${node.id}/impact?port_min=10000&port_max=20000`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { role_check: { ok: boolean; condition: string; message: string } } };
    expect(body.data.role_check.ok).toBe(false);
    expect(body.data.role_check.condition).toBe("port_range_would_orphan_leases");
    expect(body.data.role_check.message).toContain("9999");
  });

  test("?port_min/port_max 不罩住任何 active 租约 → ok", async () => {
    const node = seedNode();
    leaseRows.push({ node_id: node.id, port: 15000, status: "active" });
    const res = await app.request(`/api/admin/node/${node.id}/impact?port_min=10000&port_max=20000`);
    const body = (await res.json()) as { data: { role_check: { ok: boolean } } };
    expect(body.data.role_check.ok).toBe(true);
  });

  test("?port_min/port_max 非数字 → 不判定（视为未配置）", async () => {
    const node = seedNode();
    leaseRows.push({ node_id: node.id, port: 80, status: "active" });
    const res = await app.request(`/api/admin/node/${node.id}/impact?port_min=abc&port_max=xyz`);
    const body = (await res.json()) as { data: { role_check: { ok: boolean } } };
    expect(body.data.role_check.ok).toBe(true);
  });

  test("节点不存在 → 404", async () => {
    const res = await app.request("/api/admin/node/424242/impact");
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* DELETE /api/admin/node/:id/lifecycle                                */
/* ------------------------------------------------------------------ */

describe("DELETE /api/admin/node/:id/lifecycle", () => {
  test("未退役 → 409 condition=node_not_retiring，行不动", async () => {
    const node = seedNode({ lifecycle: "active" });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; condition: string; dependencies?: unknown };
    expect(body.code).toBe("invalid_state");
    expect(body.condition).toBe("node_not_retiring");
    // 依赖清单随错误返回，前端可直接列「要先清什么」
    expect(body.dependencies).toBeDefined();
    expect(nodes.has(node.id)).toBe(true);
  });

  test("retiring + 干净 → 200 且行删除", async () => {
    const node = seedNode({ lifecycle: "retiring" });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: number; deleted: boolean } };
    expect(body.data.deleted).toBe(true);
    expect(body.data.id).toBe(node.id);
    expect(nodes.has(node.id)).toBe(false);
  });

  test("retiring + 仍有入口 Forward → 409 dependency_blocked，行不删", async () => {
    const node = seedNode({ lifecycle: "retiring" });
    tunnelRows.push({ ingress_node_id: node.id, egress_node_id: null });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; dependencies?: { ingress_forward_count: number } };
    expect(body.code).toBe("dependency_blocked");
    expect(body.dependencies?.ingress_forward_count).toBe(1);
    expect(nodes.has(node.id)).toBe(true);
  });

  test("retiring + 仍有绑定 → 409，行不删", async () => {
    const node = seedNode({ lifecycle: "retiring" });
    bindingRows.push({ ingress_node_id: node.id, egress_node_id: 2 });
    const res = await app.request(`/api/admin/node/${node.id}/lifecycle`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(nodes.has(node.id)).toBe(true);
  });

  test("节点不存在 → 404", async () => {
    const res = await app.request("/api/admin/node/424242/lifecycle", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* 全端点凭据纪律                                                       */
/* ------------------------------------------------------------------ */

describe("凭据纪律：所有端点响应都不含哈希", () => {
  test("四个端点的 JSON 序列化后都不含哈希串", async () => {
    const node = seedNode({ lifecycle: "retiring" });
    const get = await app.request(`/api/admin/node/${node.id}/lifecycle`);
    expect(JSON.stringify(await get.json())).not.toContain(CRED_HASH);
    const patch = await app.request(`/api/admin/node/${node.id}/lifecycle`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lifecycle: "retiring" }),
    });
    expect(JSON.stringify(await patch.json())).not.toContain(CRED_HASH);
    const impact = await app.request(`/api/admin/node/${node.id}/impact`);
    expect(JSON.stringify(await impact.json())).not.toContain(CRED_HASH);
    const del = await app.request(`/api/admin/node/${node.id}/lifecycle`, { method: "DELETE" });
    expect(JSON.stringify(await del.json())).not.toContain(CRED_HASH);
  });
});
