/**
 * WP12 Admin Web — 节点管理契约单测（纯逻辑，不起服务器 / 浏览器）。
 *
 * 覆盖交付要求：
 *   1. **角色三元与「未声明」**：ingress / egress / both 合法；null 是显式的
 *      「尚未声明」，不能被默认成 ingress（存量迁移行的真实形状）；
 *   2. **凭据生命周期**：未签发 → 不能吊销 / 不能轮转；签发 / 轮转只回一次性明文；
 *      吊销只回 { revoked: true }（明文绝不再现）；吊销后 has_credential 仍在
 *      （哈希保留，面板才分得清「已撤销」与「瞎猜」）；
 *   3. **详情聚合契约**：GET /admin/nodes/:id 返回 NodeDetail（pools/state），
 *      且**绝不下发** node_credential_hash（服务端契约红线）；
 *   4. **出口池 / 目标 CRUD**：命名 / 端口 / 去重等不变量与后端一致。
 *
 * 跑法（web 目录）：bun test src/components/admin/__tests__/wp12-node-management.test.ts
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { getStore, resetStore } from "@/mocks/state";
import type {
  EgressPool,
  EgressTarget,
  NodeCredentialIssued,
  NodeCredentialRevoked,
  NodeDetail,
} from "@/lib/types";

const COOKIE = "tunex_session=u1"; // mock 演示用户（owner，具备 admin 权限）
const call = <T>(method: string, path: string, body?: unknown) =>
  handleMock(method, path, { cookie: COOKIE, body }) as Promise<{ status: number; body: T }>;

beforeEach(() => {
  resetStore();
});

describe("WP12 节点角色 / 端口区间", () => {
  test("存量种子节点 role 为 null（未声明），不得被填成 ingress", () => {
    const db = getStore();
    expect(db.nodes[0].role ?? null).toBeNull();
    expect(db.nodes[0].port_range_min ?? null).toBeNull();
  });

  test("PATCH role=null 合法：显式声明「尚未声明」", async () => {
    const res = await call<Node>("PATCH", "/admin/nodes/4", { role: null, port_range_min: 21000, port_range_max: 39000 });
    expect(res.status).toBe(200);
    expect(res.body.role ?? null).toBeNull();
    expect(res.body.port_range_min).toBe(21000);
    expect(res.body.port_range_max).toBe(39000);
  });

  test("PATCH 非法角色 / 非法策略被拒", async () => {
    expect((await call("PATCH", "/admin/nodes/4", { role: "gateway" })).status).toBeGreaterThanOrEqual(400);
    expect((await call("PATCH", "/admin/nodes/4", { lb_strategy: "fastest" })).status).toBeGreaterThanOrEqual(400);
  });

  test("egress/both 可设默认池策略 round | rand", async () => {
    const r1 = await call<Node>("PATCH", "/admin/nodes/4", { role: "egress", lb_strategy: "rand" });
    expect(r1.body.lb_strategy).toBe("rand");
    const r2 = await call<Node>("PATCH", "/admin/nodes/6", { role: "both", lb_strategy: "round" });
    expect(r2.body.lb_strategy).toBe("round");
  });

  test("列表返回每行的 v3 字段（列表页可直接渲染角色徽章）", async () => {
    const res = await call<{ data: Node[] }>("GET", "/admin/nodes");
    expect(res.status).toBe(200);
    for (const n of res.body.data) expect("role" in n && "has_credential" in n).toBe(true);
  });
});

describe("WP12 详情聚合契约", () => {
  test("GET /admin/nodes/:id = NodeDetail（pools + state）", async () => {
    const res = await call<NodeDetail>("GET", "/admin/nodes/1");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.pools)).toBe(true);
    expect(res.body.state === null || typeof res.body.state === "object").toBe(true);
  });

  test("详情绝不下发凭据哈希（服务端契约红线）", async () => {
    const res = await call<Record<string, unknown>>("GET", "/admin/nodes/4");
    expect(res.body.node_credential_hash).toBeUndefined();
    expect(res.body.credential_hash).toBeUndefined();
    // 只允许三个派生态
    expect(typeof res.body.has_credential).toBe("boolean");
    expect(typeof res.body.credential_revoked).toBe("boolean");
  });

  test("节点不存在 → 404", async () => {
    expect((await call("GET", "/admin/nodes/999")).status).toBe(404);
  });
});

describe("WP12 凭据 lifecycle", () => {
  test("未签发：吊销 / 轮转都被拒", async () => {
    expect((await call("POST", "/admin/node/1/credential/revoke", {})).status).toBeGreaterThanOrEqual(400);
    expect((await call("POST", "/admin/node/1/credential/rotate", {})).status).toBeGreaterThanOrEqual(400);
  });

  test("签发：返回一次性明文 + issued_at（而非 rotated_at）", async () => {
    const res = await call<NodeCredentialIssued>("POST", "/admin/node/1/credential", {});
    expect(res.status).toBe(200);
    expect(res.body.credential.startsWith("tunx_mock_")).toBe(true);
    expect(res.body.node_key).toBe(getStore().nodes[0].node_id);
    expect(typeof res.body.issued_at).toBe("string");
    expect(res.body.rotated_at).toBeUndefined();
    expect((res.body as unknown as { credential_hash?: string }).credential_hash).toBeUndefined();
  });

  test("详情在签发后翻转 has_credential，仍不下发明文", async () => {
    await call("POST", "/admin/node/1/credential", {});
    const d = await call<NodeDetail>("GET", "/admin/nodes/1");
    expect(d.body.has_credential).toBe(true);
    expect(d.body.credential_revoked).toBe(false);
    expect((d.body as unknown as { credential?: string }).credential).toBeUndefined();
  });

  test("轮转：rotated_at 而非 issued_at，且明文每次都不同（旧 token 即时失效）", async () => {
    const issue = (await call<NodeCredentialIssued>("POST", "/admin/node/1/credential", {})).body;
    const rotate = (await call<NodeCredentialIssued>("POST", "/admin/node/1/credential/rotate", {})).body;
    expect(rotate.credential).not.toBe(issue.credential);
    expect(typeof rotate.rotated_at).toBe("string");
    expect(rotate.issued_at).toBeUndefined();
  });

  test("吊销：只回 { revoked: true }，明文绝不重放；哈希位保留", async () => {
    await call("POST", "/admin/node/1/credential", {});
    const revoke = (await call<NodeCredentialRevoked>("POST", "/admin/node/1/credential/revoke", {})).body;
    expect(revoke.revoked).toBe(true);
    expect(revoke.node_key).toBe(getStore().nodes[0].node_id);
    expect((revoke as unknown as { credential?: string }).credential).toBeUndefined();

    const d = await call<NodeDetail>("GET", "/admin/nodes/1");
    expect(d.body.credential_revoked).toBe(true);
    expect(d.body.has_credential).toBe(true); // 哈希保留 → 面板显示「已撤销」而不是「未签发」
  });

  test("重复吊销被拒（幂等守卫）", async () => {
    await call("POST", "/admin/node/1/credential", {});
    expect((await call("POST", "/admin/node/1/credential/revoke", {})).status).toBe(200);
    expect((await call("POST", "/admin/node/1/credential/revoke", {})).status).toBeGreaterThanOrEqual(400);
  });

  test("吊销后仍可重新签发（rotate = 重新签发新明文）", async () => {
    await call("POST", "/admin/node/1/credential", {});
    await call("POST", "/admin/node/1/credential/revoke", {});
    const again = await call<NodeCredentialIssued>("POST", "/admin/node/1/credential", {});
    expect(again.status).toBe(200);
    expect(typeof again.body.credential).toBe("string");
    const d = await call<NodeDetail>("GET", "/admin/nodes/1");
    expect(d.body.credential_revoked).toBe(false);
  });

  test("删节点会清掉凭据与池（级联与后端 onDelete 一致）", async () => {
    await call("POST", "/admin/node/1/pools", { name: "HK-OUT", lb_strategy: "round" });
    expect((await call("DELETE", "/admin/nodes/1", {})).status).toBe(200);
    expect((await call("GET", "/admin/nodes/1", {})).status).toBe(404);
    expect(getStore().egressPools.has(1)).toBe(false);
    expect(getStore().nodeCredentials.has(1)).toBe(false);
  });

  test("未签发节点（没有旧 token）轮转被拒 ⇒ 不会凭空签发", async () => {
    expect((await call("POST", "/admin/node/7/credential/rotate", {})).status).toBeGreaterThanOrEqual(400);
  });
});

describe("WP12 出口池 / 出口目标 CRUD", () => {
  const NODE = 4;

  test("建池：默认策略可空（回落 node.lb_strategy）", async () => {
    const res = await call<EgressPool>("POST", `/admin/nodes/${NODE}/pools`, { name: "HK-OUT" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("HK-OUT");
    expect(res.body.lb_strategy ?? null).toBeNull();
    expect(res.body.status).toBe("active");
  });

  test("建池：空名被拒", async () => {
    expect((await call("POST", `/admin/nodes/${NODE}/pools`, { name: "" })).status).toBeGreaterThanOrEqual(400);
  });

  test("池策略校验 round | rand", async () => {
    const ok = await call<EgressPool>("POST", `/admin/nodes/${NODE}/pools`, { name: "A", lb_strategy: "rand" });
    expect(ok.body.lb_strategy).toBe("rand");
    expect((await call("POST", `/admin/nodes/${NODE}/pools`, { name: "B", lb_strategy: "cheapest" })).status).toBeGreaterThanOrEqual(400);
  });

  test("目标：host/port 分列；重复 host:port 被拒；端口范围校验", async () => {
    const pool = (await call<EgressPool>("POST", `/admin/nodes/${NODE}/pools`, { name: "A" })).body;
    const t = (await call<EgressTarget>("POST", `/admin/nodes/${NODE}/pools/${pool.id}/targets`, { host: "10.0.0.5", port: 8080, weight: 2 })).body;
    expect([t.host, t.port, t.weight]).toEqual(["10.0.0.5", 8080, 2]);
    expect(t.order_by).toBe(0); // 首个目标默认 0，后续按索引递增

    expect((await call("POST", `/admin/nodes/${NODE}/pools/${pool.id}/targets`, { host: "10.0.0.5", port: 8080 })).status).toBeGreaterThanOrEqual(400);
    expect((await call("POST", `/admin/nodes/${NODE}/pools/${pool.id}/targets`, { host: "10.0.0.6", port: 70000 })).status).toBeGreaterThanOrEqual(400);
    expect((await call("POST", `/admin/nodes/${NODE}/pools/${pool.id}/targets`, { host: "", port: 80 })).status).toBeGreaterThanOrEqual(400);
  });

  test("目标：PATCH 局部更新 + DELETE 后 404", async () => {
    const pool = (await call<EgressPool>("POST", `/admin/nodes/${NODE}/pools`, { name: "A" })).body;
    const t = (await call<EgressTarget>("POST", `/admin/nodes/${NODE}/pools/${pool.id}/targets`, { host: "10.0.0.5", port: 8080 })).body;
    const patched = (await call<EgressTarget>("PATCH", `/admin/nodes/${NODE}/pools/${pool.id}/targets/${t.id}`, { weight: 3, status: "inactive", remark: "备用" })).body;
    expect([patched.weight, patched.status, patched.remark]).toEqual([3, "inactive", "备用"]);

    expect((await call("DELETE", `/admin/nodes/${NODE}/pools/${pool.id}/targets/${t.id}`, {})).body).toEqual({ ok: true, id: t.id });
    expect((await call("PATCH", `/admin/nodes/${NODE}/pools/${pool.id}/targets/${t.id}`, { weight: 1 })).status).toBe(404);
  });

  test("详情把池 + 目标一起带回（一个请求渲染整个 pools 区块）", async () => {
    await call<EgressPool>("POST", `/admin/nodes/${NODE}/pools`, { name: "HK-OUT", lb_strategy: "round" });
    const detail = (await call<NodeDetail>("GET", `/admin/nodes/${NODE}`)).body;
    expect(detail.pools.length).toBeGreaterThan(0);
    for (const p of detail.pools) expect(Array.isArray(p.targets)).toBe(true);
  });

  test("未知池 / 目标 → 404（不静默建新行）", async () => {
    expect((await call("GET", `/admin/nodes/${NODE}/pools/999`)).status).toBe(404);
    expect((await call("DELETE", `/admin/nodes/${NODE}/pools/999`, {})).status).toBe(404);
  });

  test("state 端点无上报时返回 null（面板显示空态而非报错）", async () => {
    const res = await call<unknown>("GET", `/admin/nodes/${NODE}/state`);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});
