/**
 * V4-WP6 — Node health API 路由层测试（Hono `app.request`，不连 DB / Redis）。
 *
 * 覆盖行为（对照 `routes/node-health.ts` 的端点表）：
 *   · 200 —— 数字主键与 `node_id` 字符串都能解出同一个节点；
 *   · 404 —— 路径 id 既不是数字主键也不是 node_id；
 *   · 200 + `telemetry = null` —— 从未上报是正常状态（不是 404，也不是 500）；
 *   · 200 + `summary` —— 四态计数是**过滤前**的全量计数（巡检页的入口数据）；
 *   · `?health=` / `?lifecycle=` 过滤；非法 health 值 → 400 invalid_input；
 *   · 凭据纪律：任何响应的 JSON 都不含凭据哈希；
 *   · 判定与生命周期不混淆：offline 节点的 `health` 是 unknown，而
 *     `lifecycle` 仍是 active（§13.4.1 三层各说各的）。
 *
 * ── 替身注入 ──
 * 与 WP5 的路由测试同一模式：`mockDb()`（共享替身）→ 再 import 被测路由。
 * 共享替身保证同进程内服务层/路由层测试注册的是同一个 dbStub 对象，数据放
 * 在模块级 Map 里，`resetLifecycleStub()` 即清空。
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { Hono } from "hono";
import {
  mockDb,
  resetLifecycleStub,
  stubState,
  freshHeartbeat,
  STUB_CRED_HASH as CRED_HASH,
} from "../../__tests__/lifecycle-db-stub.ts";

// mock.module 必须在被测模块 import 之前注册（共享替身的单例约束）。
mockDb();

const { nodeHealthRoutes } = await import("../node-health.ts");

const app = new Hono<{ Variables: Record<string, never> }>();
app.route("/api/admin", nodeHealthRoutes);

interface HealthBody {
  data: {
    node_id: number;
    node_key: string;
    role: string | null;
    lifecycle: string;
    health: string;
    connection: string;
    reasons: Array<{ code: string; severity: string; message: string }>;
    flags: Record<string, boolean>;
    telemetry: {
      reported_at: string;
      age_seconds: number;
      version: string | null;
      applied_revision: number | null;
      known_revision: number | null;
      revision_pending: boolean;
      hostname: string | null;
      os: string | null;
      arch: string | null;
      uptime_seconds: number | null;
      runtime: { counts: Record<string, number> | null; running: string[] };
      used_ports: number[];
      host: Record<string, number | string> | null;
      errors: { count: number | null; last_at: string | null; last_message: string | null };
      expected_version: string | null;
    } | null;
    desired_runtime_count: number;
    forward_count: number;
  };
}

beforeEach(() => {
  resetLifecycleStub();
});

/* ------------------------------------------------------------------ */
/* GET /api/admin/node/:id/health                                      */
/* ------------------------------------------------------------------ */

describe("GET /api/admin/node/:id/health", () => {
  test("数字主键：在线 + 快照齐全 → 200 healthy，遥测字段逐个投影", async () => {
    const node = stubState.seedNode({ version: "1.4.0" });
    stubState.pushTunnel({
      ingress_node_id: node.id,
      egress_node_id: null,
      name: "网站入口",
      tunnel_mode: "direct",
      desired_status: "active",
      config_revision: 10,
      listen_port: 8443,
    });
    stubState.seedStateReport({
      node_id: node.id,
      version: "1.4.0",
      reported_revision: 10,
      known_revision: 10,
      tunnels: [{ id: "tunex-1-direct", mode: "DIRECT", ingress_port: 8443, revision: 10 }],
      used_ports: [8443],
      runtime_counts: { direct: 1, relay_ingress: 0, relay_egress: 0, total: 1 },
      host_metrics: { cpu_count: 4, load1: 0.4, memory_total_bytes: 8_000, memory_used_bytes: 2_000, disk_path: "/", disk_total_bytes: 100_000, disk_free_bytes: 60_000 },
    });

    const res = await app.request(`/api/admin/node/${node.id}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;

    expect(body.data.health).toBe("healthy");
    expect(body.data.connection).toBe("online");
    expect(body.data.reasons).toEqual([]);
    expect(body.data.node_key).toBe(node.node_id);
    expect(body.data.lifecycle).toBe("active");
    expect(body.data.desired_runtime_count).toBe(1);
    expect(body.data.forward_count).toBe(1);

    const t = body.data.telemetry!;
    expect(t.version).toBe("1.4.0");
    expect(t.applied_revision).toBe(10);
    expect(t.known_revision).toBe(10);
    expect(t.revision_pending).toBe(false);
    expect(t.hostname).toBe(`node-${node.id}`);
    expect(t.os).toBe("linux");
    expect(t.arch).toBe("amd64");
    expect(t.used_ports).toEqual([8443]);
    expect(t.runtime.running).toEqual(["tunex-1-direct"]);
    expect(t.runtime.counts).toMatchObject({ direct: 1, total: 1 });
    expect(t.host).toMatchObject({ cpu_count: 4, disk_path: "/" });
    expect(t.errors).toEqual({ count: 0, last_at: null, last_message: null });
    // age/uptime 由面板时钟推导，只断言「有值且非负」。
    expect(t.age_seconds).toBeGreaterThanOrEqual(0);
    expect(t.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  test("node_id 字符串与数字主键解出同一节点", async () => {
    const node = stubState.seedNode();
    const byKey = await app.request(`/api/admin/node/${node.node_id}/health`);
    const byId = await app.request(`/api/admin/node/${node.id}/health`);
    expect(byKey.status).toBe(200);
    expect(byId.status).toBe(200);
    const a = (await byKey.json()) as HealthBody;
    const b = (await byId.json()) as HealthBody;
    expect(a.data.node_id).toBe(b.data.node_id);
    expect(a.data.node_id).toBe(node.id);
  });

  test("从未上报 → 200 + telemetry=null + health=unknown + never_reported", async () => {
    const node = stubState.seedNode();
    const res = await app.request(`/api/admin/node/${node.id}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.data.health).toBe("unknown");
    expect(body.data.telemetry).toBeNull();
    expect(body.data.reasons.map((r) => r.code)).toEqual(["never_reported"]);
  });

  test("节点不存在 → 404（数字与字符串两种形态）", async () => {
    stubState.seedNode();
    expect((await app.request("/api/admin/node/999999/health")).status).toBe(404);
    expect((await app.request("/api/admin/node/no-such-node/health")).status).toBe(404);
  });

  test("无凭据 → waiting + unknown（尚未安装，不是故障）", async () => {
    const node = stubState.seedNode({ node_credential_hash: null });
    const res = await app.request(`/api/admin/node/${node.id}/health`);
    const body = (await res.json()) as HealthBody;
    expect(body.data.connection).toBe("waiting");
    expect(body.data.health).toBe("unknown");
    expect(body.data.reasons.map((r) => r.code)).toEqual(["no_credential"]);
  });

  test("offline 仍然是 lifecycle=active：三层状态各说各的（§13.4.1）", async () => {
    const node = stubState.seedNode({ last_seen_at: freshHeartbeat(200_000) });
    const res = await app.request(`/api/admin/node/${node.id}/health`);
    const body = (await res.json()) as HealthBody;
    expect(body.data.connection).toBe("offline");
    expect(body.data.lifecycle).toBe("active");
    expect(body.data.health).toBe("unknown");
    expect(body.data.health).not.toBe("error");
  });

  test("desired active 但快照无该 runtime → 200 error + runtime_missing", async () => {
    const node = stubState.seedNode();
    stubState.pushTunnel({
      ingress_node_id: node.id,
      egress_node_id: null,
      name: "网站入口",
      tunnel_mode: "direct",
      desired_status: "active",
      config_revision: 3,
    });
    stubState.seedStateReport({ node_id: node.id, tunnels: [], runtime_counts: { direct: 0, total: 0 } });
    const res = await app.request(`/api/admin/node/${node.id}/health`);
    const body = (await res.json()) as HealthBody;
    expect(body.data.health).toBe("error");
    const reason = body.data.reasons.find((r) => r.code === "runtime_missing")!;
    expect(reason.message).toContain("网站入口");
    expect(reason.severity).toBe("error");
  });

  test("revision 落后 → warning；持续错误 → error", async () => {
    const node = stubState.seedNode();
    stubState.pushTunnel({
      ingress_node_id: node.id,
      egress_node_id: null,
      tunnel_mode: "direct",
      desired_status: "active",
      config_revision: 9,
    });
    stubState.seedStateReport({
      node_id: node.id,
      reported_revision: 2,
      known_revision: 2,
      tunnels: [{ id: "tunex-1-direct", revision: 2 }],
    });
    const behind = await app.request(`/api/admin/node/${node.id}/health`);
    const behindBody = (await behind.json()) as HealthBody;
    expect(behindBody.data.health).toBe("warning");
    expect(behindBody.data.reasons.map((r) => r.code)).toContain("runtime_revision_behind");

    stubState.seedStateReport({
      node_id: node.id,
      reported_revision: 9,
      known_revision: 9,
      tunnels: [{ id: "tunex-1-direct", revision: 9 }],
      error_count: 2,
      last_error: "apply failed",
      last_error_at: freshHeartbeat(5_000),
    });
    const errRes = await app.request(`/api/admin/node/${node.id}/health`);
    const errBody = (await errRes.json()) as HealthBody;
    expect(errBody.data.health).toBe("error");
    expect(errBody.data.telemetry!.errors.count).toBe(2);
    expect(errBody.data.telemetry!.errors.last_message).toBe("apply failed");
  });

  test("resource 阈值：内存/磁盘接近上限 → warning", async () => {
    const node = stubState.seedNode();
    stubState.seedStateReport({
      node_id: node.id,
      host_metrics: { memory_total_bytes: 1_000, memory_used_bytes: 950, disk_total_bytes: 1_000, disk_free_bytes: 20 },
    });
    const res = await app.request(`/api/admin/node/${node.id}/health`);
    const body = (await res.json()) as HealthBody;
    expect(body.data.health).toBe("warning");
    const codes = body.data.reasons.map((r) => r.code);
    expect(codes).toContain("resource_memory_high");
    expect(codes).toContain("resource_disk_high");
    expect(body.data.flags.resources_ok).toBe(false);
  });

  test("凭据纪律：响应 JSON 不含凭据哈希", async () => {
    const node = stubState.seedNode();
    stubState.seedStateReport({ node_id: node.id });
    const res = await app.request(`/api/admin/node/${node.id}/health`);
    const raw = await res.text();
    expect(raw).not.toContain(CRED_HASH);
    expect(raw).not.toContain("node_credential_hash");
  });
});

/* ------------------------------------------------------------------ */
/* GET /api/admin/node/health（全量巡检）                                */
/* ------------------------------------------------------------------ */

describe("GET /api/admin/node/health", () => {
  /** 造三种健康度的节点：healthy / error（缺 runtime）/ warning（版本落后）。 */
  function seedFleet() {
    const healthy = stubState.seedNode({ node_id: "node-healthy" });
    stubState.seedStateReport({ node_id: healthy.id });

    const broken = stubState.seedNode({ node_id: "node-broken" });
    stubState.pushTunnel({
      ingress_node_id: broken.id,
      egress_node_id: null,
      name: "断了的入口",
      tunnel_mode: "direct",
      desired_status: "active",
      config_revision: 1,
    });
    stubState.seedStateReport({ node_id: broken.id, tunnels: [] });

    const stale = stubState.seedNode({ node_id: "node-stale", lifecycle: "maintenance" });
    stubState.seedStateReport({ node_id: stale.id, reported_at: freshHeartbeat(200_000) });
    return { healthy, broken, stale };
  }

  test("返回 items + total + summary（四态计数）", async () => {
    seedFleet();
    const res = await app.request("/api/admin/node/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: HealthBody["data"][];
      total: number;
      summary: Record<string, number>;
    };
    expect(body.total).toBe(3);
    expect(body.data).toHaveLength(3);
    expect(body.summary.healthy).toBe(1);
    expect(body.summary.error).toBe(1);
    expect(body.summary.warning).toBe(1);
    expect(body.summary.unknown).toBe(0);
  });

  test("summary 是过滤前的全量计数，items 才是筛选结果", async () => {
    seedFleet();
    const res = await app.request("/api/admin/node/health?health=error");
    const body = (await res.json()) as {
      data: HealthBody["data"][];
      total: number;
      summary: Record<string, number>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.data[0].node_key).toBe("node-broken");
    // 过滤不改变 summary：巡检页要能同时显示「全量 3 台，其中 1 台 error」。
    expect(body.summary).toEqual({ healthy: 1, warning: 1, error: 1, unknown: 0 });
  });

  test("health=all / 空串等于不过滤（下拉框口径）", async () => {
    seedFleet();
    for (const q of ["", "?health=", "?health=all", "?health=ALL"]) {
      const res = await app.request(`/api/admin/node/health${q}`);
      const body = (await res.json()) as { total: number };
      expect(body.total).toBe(3);
    }
  });

  test("lifecycle 过滤（巡检 maintenance 节点）", async () => {
    seedFleet();
    const res = await app.request("/api/admin/node/health?lifecycle=maintenance");
    const body = (await res.json()) as { data: HealthBody["data"][]; total: number; summary: Record<string, number> };
    expect(body.total).toBe(1);
    expect(body.data[0].node_key).toBe("node-stale");
    expect(body.data[0].lifecycle).toBe("maintenance");
  });

  test("非法 health 值 → 400 invalid_input（fail-closed，不静默返回全部）", async () => {
    seedFleet();
    const res = await app.request("/api/admin/node/health?health=banana");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_input");
  });

  test("非法 lifecycle 值 → 400 invalid_input（不能把非法枚举丢给 Prisma：那是 500）", async () => {
    seedFleet();
    const res = await app.request("/api/admin/node/health?lifecycle=banana");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_input");
  });

  test("health 过滤只认四态白名单（原型链上的键也不是合法过滤值）", async () => {
    seedFleet();
    for (const bad of ["constructor", "toString", "__proto__", "valueOf"]) {
      const res = await app.request(`/api/admin/node/health?health=${bad}`);
      expect(res.status).toBe(400);
    }
  });

  test("lifecycle=ALL / 空串等于不过滤（与 health 同一口径）", async () => {
    seedFleet();
    for (const q of ["", "?lifecycle=", "?lifecycle=ALL", "?lifecycle=all"]) {
      const res = await app.request(`/api/admin/node/health${q}`);
      const body = (await res.json()) as { total: number };
      expect(body.total).toBe(3);
    }
  });

  test("没有任何节点 → 空列表 + 全零 summary（不是 404）", async () => {
    const res = await app.request("/api/admin/node/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; total: number; summary: Record<string, number> };
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.summary).toEqual({ healthy: 0, warning: 0, error: 0, unknown: 0 });
  });

  test("单节点与 fleet 对同一节点给出一致的 health（同一个判定函数）", async () => {
    const { broken } = seedFleet();
    const one = (await (await app.request(`/api/admin/node/${broken.id}/health`)).json()) as HealthBody;
    const fleet = (await (await app.request("/api/admin/node/health")).json()) as { data: HealthBody["data"][] };
    const same = fleet.data.find((x) => x.node_id === broken.id)!;
    expect(same.health).toBe(one.data.health);
    expect(same.connection).toBe(one.data.connection);
    expect(same.reasons.map((r) => r.code)).toEqual(one.data.reasons.map((r) => r.code));
  });

  test("凭据纪律：列表响应不含哈希", async () => {
    seedFleet();
    const raw = await (await app.request("/api/admin/node/health")).text();
    expect(raw).not.toContain(CRED_HASH);
  });
});
