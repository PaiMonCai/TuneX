/**
 * V5.5 Federation mock —— **契约一致性**（mock 必须和后端一字不差）。
 *
 * 这份测试盯三件事，全部**直接读后端源码**比对（仓库既有做法：镜像漂移就要立刻红）：
 *   A. 错误码闭集 / HTTP 状态表 / retryable 集合 与 `services/federation/errors.ts` 一致；
 *   B. `handleMock` 覆盖 `routes/admin-federation.ts` 里的每一条管理端路由；
 *   C. 列表端点的**字段名**与后端响应映射一致，且不夹带内部字段（例如 grant 的 `id`）。
 *
 * 另外覆盖 mock 自身的行为契约：token 只出现一次、握手一次性、撤销级联、
 * 配额 fail-closed、状态分层（401/403/404/429/502 各不相同）。
 *
 * 跑法（web 目录）：bun test src/mocks/__tests__/
 * 无浏览器、无 docker、无网络依赖。
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FEDERATION_ERROR_CODES,
  FEDERATION_ERROR_RETRYABLE,
  FEDERATION_ERROR_STATUS,
  buildMockFederation,
  handleFederationMock,
  MOCK_LIVE_LEASE_STATES,
  type MockFederationState,
} from "@/mocks/federation";
import { FEDERATION_HOP_ROLES, FEDERATION_LEASE_STATES } from "@/lib/types";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const BACKEND_ROUTES = resolve(REPO_ROOT, "backend/src/routes/admin-federation.ts");
const BACKEND_ERRORS = resolve(REPO_ROOT, "backend/src/services/federation/errors.ts");
const BACKEND_GRANT = resolve(REPO_ROOT, "backend/src/services/federation/grant.ts");

const routesSrc = readFileSync(BACKEND_ROUTES, "utf8");
const errorsSrc = readFileSync(BACKEND_ERRORS, "utf8");
const grantSrc = readFileSync(BACKEND_GRANT, "utf8");

let state: MockFederationState;
beforeEach(() => {
  state = buildMockFederation();
});

const call = (method: string, path: string, body?: unknown) =>
  handleFederationMock({ method, seg: path.split("/").filter(Boolean), body, state });

const body = <T>(res: { body: unknown } | null): T => res!.body as T;

describe("A. 错误码闭集 / 状态表 / retryable 与后端一致", () => {
  test("闭集逐项一致（少一个或多个都会红）", () => {
    const backendCodes = [...errorsSrc.matchAll(/"([a-z_]+)",?\s*(?:\/\/.*)?$/gm)].map((m) => m[1]);
    const declared = errorsSrc.slice(errorsSrc.indexOf("FEDERATION_ERROR_CODES"), errorsSrc.indexOf("] as const;"));
    const codes = [...declared.matchAll(/^\s*"([a-z_]+)",/gm)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(15);
    expect([...FEDERATION_ERROR_CODES]).toEqual(codes);
    expect(backendCodes.length).toBeGreaterThan(0);
  });

  test("HTTP 状态表逐项一致", () => {
    const block = errorsSrc.slice(errorsSrc.indexOf("const STATUS"), errorsSrc.indexOf("export function federationStatus"));
    const entries = [...block.matchAll(/^\s*([a-z_]+):\s*(\d+),/gm)].map((m) => [m[1], Number(m[2])] as const);
    expect(entries.length).toBeGreaterThan(15);
    for (const [code, status] of entries) {
      expect({ code, status: FEDERATION_ERROR_STATUS[code] }).toEqual({ code, status });
    }
    // 反向：mock 不许自造后端没有的码
    for (const code of Object.keys(FEDERATION_ERROR_STATUS)) {
      expect(entries.map(([c]) => c)).toContain(code);
    }
  });

  test("retryable 集合逐项一致（只有五类值得重试）", () => {
    const block = errorsSrc.slice(errorsSrc.indexOf("RETRYABLE: ReadonlySet"), errorsSrc.indexOf("const STATUS"));
    const retryable = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(retryable)).toEqual(new Set(FEDERATION_ERROR_RETRYABLE));
    expect([...FEDERATION_ERROR_RETRYABLE].sort()).toEqual(retryable.sort());
  });

  test("租约状态与 hop 角色词表与后端一致", () => {
    const leaseBlock = grantSrc.slice(grantSrc.indexOf("const LEASE_STATES"), grantSrc.indexOf("] as const;", grantSrc.indexOf("const LEASE_STATES")));
    const leaseStates = [...leaseBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect([...FEDERATION_LEASE_STATES]).toEqual(leaseStates);
    expect([...MOCK_LIVE_LEASE_STATES]).toEqual(["reserved", "active", "releasing"]);

    const hopBlock = grantSrc.slice(grantSrc.indexOf("const HOP_ROLES"), grantSrc.indexOf("] as const;", grantSrc.indexOf("const HOP_ROLES")));
    expect([...FEDERATION_HOP_ROLES]).toEqual([...hopBlock.matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
  });
});

describe("B. mock 覆盖后端每一条管理端路由", () => {
  test("后端声明的每条路由在 mock 里都有响应（不是 404）", () => {
    // 后端路由声明形如 adminFederationRoutes.get("/status", …) / .post("/peers/:id/ping", …)
    const declared = [...routesSrc.matchAll(/adminFederationRoutes\.(get|post|delete)\("([^"]+)"/g)].map((m) => [m[1].toUpperCase(), m[2]] as const);
    expect(declared.length).toBeGreaterThanOrEqual(15);
    const missing: string[] = [];
    for (const [method, path] of declared) {
      const concrete = path.replace(":id", "1").replace(":ref", "g_2a7c91");
      const res = call(method, concrete, {});
      if (!res) missing.push(`${method} ${path}`);
    }
    expect(missing).toEqual([]);
  });

  test("未知路径返回 null（交给 handler 继续匹配，而不是假装成功）", () => {
    expect(call("GET", "nope")).toBeNull();
    expect(call("GET", "peers/1/nope")).toBeNull();
  });
});

describe("C. 列表字段名与后端响应映射一致", () => {
  /**
   * 从后端 `key: value,` 的映射里抽出响应字段名。
   *
   * 注意剔除信封键 `data`：后端返回 `{ data: [...] }`，而 `request()` 会剥掉这一层，
   * mock 必须直接给出**内层**对象的字段（这正是这里要校验的对齐关系）。
   */
  function backendKeys(sectionStart: string, sectionEnd: string): string[] {
    const from = routesSrc.indexOf(sectionStart);
    expect({ sectionStart, found: from >= 0 }).toEqual({ sectionStart, found: true });
    const to = sectionEnd === "" ? routesSrc.length : routesSrc.indexOf(sectionEnd);
    expect({ sectionEnd, found: to > from }).toEqual({ sectionEnd, found: true });
    const block = routesSrc.slice(from, to);
    // `key: value,` 与简写 `key,` 两种写法都要认（后端 status 响应用的是简写）
    const explicit = [...block.matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]);
    const shorthand = [...block.matchAll(/^\s*([a-z_]+)\s*,\s*$/gm)].map((m) => m[1]);
    return [...new Set([...explicit, ...shorthand])].filter((k) => k !== "data");
  }

  test("GET /status 字段齐全", () => {
    const expected = backendKeys('get("/status"', 'post("/enable"');
    const actual = Object.keys(body<Record<string, unknown>>(call("GET", "status")));
    expect(actual.sort()).toEqual(expected.sort());
  });

  test("GET /grants 字段齐全且**不含**内部 id", () => {
    const expected = backendKeys('adminFederationRoutes.get("/grants"', 'function grantActionHandler');
    const rows = body<Array<Record<string, unknown>>>(call("GET", "grants"));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(expected.sort());
      expect(Object.keys(row)).not.toContain("id");
    }
  });

  test("GET /leases 与 /usage 字段齐全（含 last_error_code / attribution）", () => {
    const leaseKeys = backendKeys('get("/leases"', 'get("/placements"');
    for (const row of body<Array<Record<string, unknown>>>(call("GET", "leases"))) {
      expect(Object.keys(row).sort()).toEqual(leaseKeys.sort());
    }
    // 只取 `rows.map((u) => ({ … }))` 这个响应映射块：/usage 前面的 placement 查询里
    // 也有 `select: …` 之类的键，整段扫描会把它们误当成响应字段。
    const usageKeys = backendKeys("rows.map((u) => ({", "");
    for (const row of body<Array<Record<string, unknown>>>(call("GET", "usage"))) {
      expect(Object.keys(row).sort()).toEqual(usageKeys.sort());
    }
    // 用量字节必须是字符串（后端 BigInt → String）
    for (const row of body<Array<Record<string, unknown>>>(call("GET", "usage"))) {
      expect(typeof row.bytes_in).toBe("string");
      expect(typeof row.bytes_out).toBe("string");
    }
  });

  test("peers 投影只给 key_id 指纹，绝不下发公钥原文", () => {
    const peers = body<Array<Record<string, unknown>>>(call("GET", "peers"));
    for (const peer of peers) {
      expect(Array.isArray(peer.key_ids)).toBe(true);
      expect(JSON.stringify(peer)).not.toContain("jwk");
      expect(JSON.stringify(peer)).not.toContain("public_key");
    }
  });
});

describe("E. api.admin.federation.* 路径与后端一一对应", () => {
  const apiSrc = readFileSync(resolve(REPO_ROOT, "web/src/lib/api/admin.ts"), "utf8");
  const fedBlock = apiSrc.slice(apiSrc.indexOf("federation: {"), apiSrc.indexOf("  },\n};", apiSrc.indexOf("federation: {")));

  test("每条后端管理端路由都能在 api 层找到（路径参数写成 ${…}）", () => {
    const declared = [...routesSrc.matchAll(/adminFederationRoutes\.(get|post|delete)\("([^"]+)"/g)].map((m) => m[2] as string);
    const patterns = declared.map((path) => {
      const body = path
        .split("/")
        .filter(Boolean)
        .map((seg) => (seg.startsWith(":") ? "\\$\\{[^}]+\\}" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/");
      return `/admin/federation/${body}`;
    });
    const missing = patterns.filter((p) => !new RegExp(p).test(fedBlock));
    expect(missing).toEqual([]);
  });

  test("写操作齐备：enable/disable/invite/handshake/ping/rotate/revoke/key.rotate/grants 动作", () => {
    for (const method of [
      "status:",
      "enable:",
      "disable:",
      "peers:",
      "invitePeer:",
      "handshake:",
      "pingPeer:",
      "rotatePeerKey:",
      "revokePeer:",
      "rotateLocalKey:",
      "grants:",
      "createGrant:",
      "revokeGrant:",
      "suspendGrant:",
      "resumeGrant:",
      "leases:",
      "placements:",
      "usage:",
    ]) {
      expect({ method, present: fedBlock.includes(method) }).toEqual({ method, present: true });
    }
  });
});

describe("D. mock 行为契约", () => {
  test("invite 的 token 只出现一次：state 只存 hash，列表接口带不出明文", () => {
    const invite = body<{ token: string; peer_id: number; expires_at: string; panel_id: string; key_id: string }>(
      call("POST", "peers/invite", { display_name: "Panel X", endpoint_url: "https://panel-x.internal:3000" }),
    );
    expect(invite.token.length).toBeGreaterThanOrEqual(16);
    // 明文不在 state 里（任何一处都行不通）
    expect(JSON.stringify([...state.invitation_hashes.entries()])).not.toContain(invite.token);
    expect(JSON.stringify(state.peers)).not.toContain(invite.token);
    const listed = JSON.stringify(body(call("GET", "peers")));
    expect(listed).not.toContain(invite.token);
  });

  test("握手一次性消费：重放同一个 token → 403 handshake_invalid", () => {
    const invite = body<{ token: string }>(call("POST", "peers/invite", { display_name: "X", endpoint_url: "https://panel-x.internal:3000" }));
    const first = call("POST", "peers/handshake", { endpoint_url: "https://panel-x.internal:3000", token: invite.token });
    expect(first!.status).toBe(200);
    const replay = call("POST", "peers/handshake", { endpoint_url: "https://panel-x.internal:3000", token: invite.token });
    expect(replay!.status).toBe(403);
    expect(body<{ code: string }>(replay).code).toBe("handshake_invalid");
  });

  test("状态分层：网络不通 / 信任撤销 / 尚未握手 是三个不同结果", () => {
    const unreachable = call("POST", "peers/4/ping"); // 信任成立但对端不可达
    expect(unreachable!.status).toBe(502);
    expect(body<{ code: string; retryable: boolean }>(unreachable)).toMatchObject({ code: "peer_unreachable", retryable: true });

    const revoked = call("POST", "peers/3/ping");
    expect(revoked!.status).toBe(403);
    expect(body<{ code: string; retryable: boolean }>(revoked)).toMatchObject({ code: "peer_revoked", retryable: false });

    const pending = call("POST", "peers/2/ping");
    expect(pending!.status).toBe(401);
    expect(body<{ code: string }>(pending).code).toBe("key_unknown");

    const unknown = call("POST", "peers/999/ping");
    expect(unknown!.status).toBe(404);
    expect(body<{ code: string }>(unknown).code).toBe("peer_unknown");
  });

  test("错误体形状与后端一字不差：只有五个字段，没有 error / data 包装", () => {
    const res = call("POST", "peers/999/ping");
    expect(Object.keys(body<Record<string, unknown>>(res)).sort()).toEqual([
      "code",
      "correlation_id",
      "message",
      "peer_panel_id",
      "retryable",
    ]);
  });

  test("撤销 peer 级联其活跃租约，并报告被连带的数量", () => {
    const before = state.leases.filter((l) => l.peer_panel_id === "7c2b8e14-3a55-4f0d-9c21-8be4d7a01c33" && MOCK_LIVE_LEASE_STATES.includes(String(l.state))).length;
    expect(before).toBeGreaterThan(0);
    const res = call("DELETE", "peers/1");
    expect(res!.status).toBe(200);
    expect(body<{ revoked_leases: number }>(res).revoked_leases).toBe(before);
    // 撤销后不可逆：再撤销 → 403 peer_revoked
    expect(call("DELETE", "peers/1")!.status).toBe(403);
  });

  test("撤销 grant 级联租约并推进 grant_epoch", () => {
    const res = call("POST", "grants/g_2a7c91/revoke");
    expect(res!.status).toBe(200);
    const out = body<{ leases_revoked: number; grant_epoch: number; already_revoked: boolean }>(res);
    expect(out.leases_revoked).toBeGreaterThan(0);
    expect(out.grant_epoch).toBe(4); // 种子里是 3
    expect(out.already_revoked).toBe(false);
    const again = call("POST", "grants/g_2a7c91/revoke");
    expect(body<{ already_revoked: boolean }>(again).already_revoked).toBe(true);
  });

  test("状态不当的动作按码分层（过期不能 resume / 撤销不能 suspend）", () => {
    const expired = call("POST", "grants/g_9d3f22/resume");
    expect(expired!.status).toBe(409);
    expect(body<{ code: string }>(expired).code).toBe("grant_expired");
    const notFound = call("POST", "grants/g_nope/suspend");
    expect(notFound!.status).toBe(404);
    expect(body<{ code: string }>(notFound).code).toBe("grant_not_found");
  });

  test("scope / capacity 未知键 fail-closed（不静默放过）", () => {
    const scope = call("POST", "grants", {
      peer_panel_id: "7c2b8e14-3a55-4f0d-9c21-8be4d7a01c33",
      scope: { node_group_ids: [2], hop_roles: ["egress"], bogus: 1 },
      expires_in_seconds: 600,
    });
    expect(scope!.status).toBe(403);
    expect(body<{ code: string }>(scope).code).toBe("grant_scope_violation");

    const capacity = call("POST", "grants", {
      peer_panel_id: "7c2b8e14-3a55-4f0d-9c21-8be4d7a01c33",
      scope: { node_group_ids: [2], hop_roles: ["egress"] },
      capacity: { bogus: 1 },
      expires_in_seconds: 600,
    });
    expect(capacity!.status).toBe(400);
    expect(body<{ code: string }>(capacity).code).toBe("message_malformed");
  });

  test("配额耗尽 → 429 quota_exhausted，且不产生新 grant（无泄漏）", () => {
    const grantsBefore = state.grants.length;
    const full = call("POST", "grants", {
      peer_panel_id: "7c2b8e14-3a55-4f0d-9c21-8be4d7a01c33",
      scope: { node_group_ids: [2], hop_roles: ["egress"] },
      capacity: { max_legs: 1 }, // 该 peer 已有 2 条 live lease
      expires_in_seconds: 600,
    });
    expect(full!.status).toBe(429);
    expect(body<{ code: string }>(full).code).toBe("quota_exhausted");
    expect(state.grants.length).toBe(grantsBefore);
  });

  test("enable/disable 幂等且报告 changed", () => {
    const first = body<{ enabled: boolean; changed: boolean }>(call("POST", "disable"));
    expect(first).toEqual({ enabled: false, changed: true });
    const second = body<{ enabled: boolean; changed: boolean }>(call("POST", "disable"));
    expect(second).toEqual({ enabled: false, changed: false });
    expect(body<{ enabled: boolean }>(call("POST", "enable")).enabled).toBe(true);
  });

  test("密钥轮转：有不可达 peer 时 502 + 逐 peer 失败明细（部分失败不是整体错误）", () => {
    const res = call("POST", "key/rotate");
    expect(res!.status).toBe(502);
    const out = body<{ ok: boolean; notified: string[]; failed: Array<{ code: string }> }>(res);
    expect(out.ok).toBe(false);
    expect(out.failed.length).toBe(1);
    expect(out.failed[0].code).toBe("peer_unreachable");
    expect(out.notified.length).toBeGreaterThan(0);
  });

  test("usage 种子含 unattributed 记录且归属字段为空（不伪装成已归因）", () => {
    const rows = body<Array<{ attribution: string; forward_ref: string | null; tunnel_id: number | null }>>(call("GET", "usage"));
    const unattributed = rows.filter((r) => r.attribution === "unattributed");
    expect(unattributed.length).toBeGreaterThanOrEqual(2);
    for (const row of unattributed) {
      expect(row.forward_ref).toBeNull();
    }
    expect(rows.some((r) => r.attribution === "attributed" && r.forward_ref !== null)).toBe(true);
  });
});
