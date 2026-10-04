/**
 * V5-WP13.5B —— Route Profile 契约测试（`DEVELOPMENT.md` §9.4.2–§9.4.6 / §3.6 / §12.1）。
 *
 * 契约（FROZEN）：`docs/v5-wp13-5b-route-profile-contract.md`。
 *
 * 覆盖矩阵：
 *   A. selector 解析：fixed node / node group / 缺候选 / 多候选策略边界（failover /
 *      round_robin / random / least_conn / ip_hash）与**确定性**；
 *   B. transit 顺序保持、非法组合 fail-closed（unknown visibility / 空跳位却声明多跳 /
 *      中间跳与端点重合 / 引用不存在或不可用的 NodeGroup / dynamic middle pool 关闭）；
 *   C. Contract test：Route Profile → RoutePlan 的产物与既有 `buildRoutePlan` /
 *      `routeSteps` 的形状**逐字一致**（不存在第二套路由模型）；
 *   D. visibility / entitlement 判定（三类 + 未知值 + 停用）；
 *   E. HTTP（`TUNEX_DB_TEST=1` 才跑）：CRUD 权限、跨 workspace 隔离、impact analysis
 *      **只读**（前后行数不变）、apply 落 provenance、**模板变更不静默重写已应用的
 *      Forward**。
 *
 * 离线用例（A–D）不连 MySQL / Redis / Agent：纯函数层不允许出现"跑不起来"的测试。
 */
import { afterAll, describe, expect, test } from "bun:test";

import {
  EGRESS_STRATEGIES,
  INGRESS_STRATEGIES,
  canConsumeRouteProfile,
  compileRouteProfile,
  parseAssignmentTarget,
  parseRouteProfileTemplate,
  parseRouteProfileVisibility,
  templateBody,
  templateDigest,
  type RouteNodeFacts,
  type RouteProfileTemplate,
} from "../route-profile-compiler.ts";
import { buildRoutePlan, routeSteps } from "../forward-route.ts";

/* ================================================================== */
/* 测试夹具                                                            */
/* ================================================================== */

const facts = (over: Partial<RouteNodeFacts> & { node_id: number }): RouteNodeFacts => ({
  node_id: over.node_id,
  node_group_id: over.node_group_id === undefined ? 10 : over.node_group_id,
  role: over.role === undefined ? "both" : over.role,
  status: over.status === undefined ? "active" : over.status,
  lifecycle: over.lifecycle === undefined ? "active" : over.lifecycle,
  last_seen_at: over.last_seen_at === undefined ? new Date() : over.last_seen_at,
  has_credential: over.has_credential === undefined ? true : over.has_credential,
  credential_revoked: over.credential_revoked ?? false,
  health: over.health === undefined ? "healthy" : over.health,
  capabilities: over.capabilities ?? null,
  load: over.load ?? 0,
  order: over.order ?? 1000,
  label: over.label ?? null,
});

/** 解析模板（走唯一的形状校验入口）。 */
function parse(raw: unknown): RouteProfileTemplate {
  const result = parseRouteProfileTemplate(raw);
  if (!result.ok) throw new Error(`fixture template invalid: ${result.message}`);
  return result.template;
}

const fixed = (nodeId: number) => ({ kind: "fixed_node", node_id: nodeId });
const group = (groupId: number, strategy: string) => ({
  kind: "node_group",
  node_group_id: groupId,
  strategy,
});

/** 编译一个模板 + 候选事实，断言成功并返回产物。 */
function compileOk(template: RouteProfileTemplate, candidates: RouteNodeFacts[], over: Record<string, unknown> = {}) {
  const result = compileRouteProfile({
    template,
    route_profile_id: 7,
    route_profile_version: 3,
    candidates,
    ...over,
  });
  if (!result.ok) throw new Error(`expected compile ok, got ${result.code}: ${result.message}`);
  return result;
}

/* ================================================================== */
/* A. 模板形状与 selector 解析（fail-closed）                          */
/* ================================================================== */

describe("V5-WP13.5B: template shape is closed — unknown input is refused, never defaulted", () => {
  test("visibility is a three-value lexical set; unknown values are refused", () => {
    expect(parseRouteProfileVisibility("PUBLIC")).toBe("PUBLIC");
    expect(parseRouteProfileVisibility(" assigned ")).toBe("ASSIGNED");
    expect(parseRouteProfileVisibility("public-ish")).toBeNull();
    expect(parseRouteProfileVisibility(1)).toBeNull();
    expect(parseRouteProfileVisibility(undefined)).toBeNull();
    expect(parseAssignmentTarget("PLAN")).toBe("plan");
    expect(parseAssignmentTarget("organisation")).toBeNull();
  });

  test("a fixed ingress + ordered fixed transit + fixed egress parse into the frozen field set", () => {
    const template = parse({
      ingress: fixed(1),
      transit: [fixed(2)],
      egress: fixed(3),
      ingress_policy: { listen_protocol: "tcp" },
      egress_policy: { lb: "round_robin" },
      constraints: { allowed_lifecycles: ["active", "maintenance"] },
      required_capabilities: ["relay_v5"],
    });
    expect(template.ingress).toEqual({ kind: "fixed_node", node_id: 1 });
    expect(template.transit).toEqual([{ kind: "fixed_node", node_id: 2 }]);
    expect(template.egress).toEqual({ kind: "fixed_node", node_id: 3 });
    expect(template.required_capabilities).toEqual(["relay_v5"]);
  });

  test("unknown template keys / unknown constraint keys are invalid_input (no silent ignore)", () => {
    const a = parseRouteProfileTemplate({ ingress: fixed(1), shortest_path: true });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe("invalid_input");

    const b = parseRouteProfileTemplate({ ingress: fixed(1), constraints: { allow_regions: ["hk"] } });
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.code).toBe("invalid_input");
      expect(b.message).toContain("allow_regions");
    }
  });

  test("unknown selector kind / unknown strategy is invalid_input", () => {
    const a = parseRouteProfileTemplate({ ingress: { kind: "wildcard" } });
    expect(a.ok).toBe(false);
    const b = parseRouteProfileTemplate({ ingress: group(10, "magic") });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.message).toContain("strategy");
    // 策略域按角色区分：ingress 不接受 egress 专属以外的集合，egress 不接受 failover。
    expect(INGRESS_STRATEGIES).toContain("failover");
    expect(EGRESS_STRATEGIES).not.toContain("failover");
  });

  test("a declared hop slot without a concrete selector is refused (空 transit 但声明多跳)", () => {
    const result = parseRouteProfileTemplate({ ingress: fixed(1), transit: [null], egress: fixed(3) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_input");
      expect(result.message).toContain("transit[0]");
    }
  });

  test("dynamic middle pool stays closed: a node_group inside transit is unsupported_topology", () => {
    const result = parseRouteProfileTemplate({ ingress: fixed(1), transit: [group(10, "round_robin")], egress: fixed(3) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unsupported_topology");
      expect(result.message).toContain("中间跳");
    }
  });

  test("more hops than the frozen 3-hop ceiling is unsupported_topology", () => {
    const result = parseRouteProfileTemplate({ ingress: fixed(1), transit: [fixed(2), fixed(4)], egress: fixed(3) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported_topology");
  });

  test("the same node cannot occupy two middle-hop slots", () => {
    const result = parseRouteProfileTemplate({ ingress: fixed(1), transit: [fixed(2), fixed(2)], egress: fixed(3) });
    expect(result.ok).toBe(false);
  });

  test("templateBody / templateDigest are stable and contain no derived jump facts", () => {
    const template = parse({ ingress: fixed(1), transit: [], egress: null });
    expect(templateBody(template)).toEqual({
      ingress: { kind: "fixed_node", node_id: 1 },
      transit: [],
      egress: null,
      ingress_policy: null,
      egress_policy: null,
      constraints: null,
      required_capabilities: null,
    });
    expect(templateDigest(template)).toBe(templateDigest(parse({ ingress: fixed(1), transit: [], egress: null })));
  });
});

/* ================================================================== */
/* B. 编译：selector → 具体节点（确定性优先）                          */
/* ================================================================== */

describe("V5-WP13.5B: the compiler only resolves selectors — the route model stays forward-route.ts", () => {
  test("a DIRECT template is two hops on ONE node, and the plan is buildRoutePlan's own output", () => {
    const template = parse({ ingress: fixed(3), transit: [], egress: null });
    const compiled = compileOk(template, [facts({ node_id: 3, role: "ingress" })]);

    expect(compiled.tunnel_mode).toBe("direct");
    expect(compiled.placement).toEqual({
      ingress_node_id: 3,
      egress_node_id: null,
      middle_node_id: null,
      tunnel_mode: "direct",
      revision: 0,
    });
    // Contract：与既有纯模型**逐字**一致（不存在第二套路由表示）。
    const expected = buildRoutePlan({
      ingress_node_id: 3,
      egress_node_id: null,
      middle_node_id: null,
      tunnel_mode: "direct",
      revision: 0,
    })!;
    expect(compiled.plan).toEqual(expected);
    expect(compiled.plan.hops.map((h) => [h.hop_index, h.role, h.node_id])).toEqual([
      [0, "ingress", 3],
      [1, "egress", 3],
    ]);
    // 步骤也来自既有 routeSteps：正向**先远后近**。
    expect(compiled.steps).toEqual(routeSteps(expected));
    expect(compiled.steps[0]!.action).toBe("apply_target_dial");
    expect(compiled.steps.at(-1)!.action).toBe("apply_client_front");
  });

  test("transit order is preserved into hop_index order (位置即身份)", () => {
    const template = parse({ ingress: fixed(1), transit: [fixed(2)], egress: fixed(3) });
    const compiled = compileOk(
      template,
      [
        facts({ node_id: 1, role: "ingress" }),
        facts({ node_id: 2, role: "egress" }),
        facts({ node_id: 3, role: "egress" }),
      ],
      // 三跳的相邻段必须先有 Binding（§9 冻结契约第 3 条）。
      { boundPairs: new Set(["1->2", "2->3"]) },
    );
    expect(compiled.tunnel_mode).toBe("relay");
    expect(compiled.plan.hops.map((h) => [h.hop_index, h.role, h.node_id])).toEqual([
      [0, "ingress", 1],
      [1, "middle", 2],
      [2, "egress", 3],
    ]);
    expect(compiled.provenance.resolved_hops).toEqual([
      { hop_index: 0, role: "ingress", node_id: 1 },
      { hop_index: 1, role: "middle", node_id: 2 },
      { hop_index: 2, role: "egress", node_id: 3 },
    ]);
  });

  test("a middle hop that equals an endpoint is refused by buildRoutePlan (route_invalid)", () => {
    const template = parse({ ingress: fixed(1), transit: [fixed(1)], egress: fixed(3) });
    const result = compileRouteProfile({
      template,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates: [facts({ node_id: 1, role: "both" }), facts({ node_id: 3, role: "egress" })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("route_invalid");
  });

  test("a referenced node that does not exist / is not a candidate fails closed with the hop position", () => {
    const template = parse({ ingress: fixed(99), transit: [], egress: null });
    const result = compileRouteProfile({
      template,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates: [facts({ node_id: 1, role: "ingress" })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("no_eligible_node");
      expect(result.hop_index).toBe(0);
    }
  });

  test("an unavailable node group (no candidates) and a disabled one (no eligible node) both fail closed", () => {
    const template = parse({ ingress: group(404, "failover"), transit: [], egress: null });

    const missing = compileRouteProfile({
      template,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates: [facts({ node_id: 1, node_group_id: 10 })],
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("no_eligible_node");

    const disabled = compileRouteProfile({
      template,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates: [
        // 「已禁用的节点组」在判定上等价于「组内没有合格候选」。合格与否**只用既有
        // `nodeAdmission`（§13.4.2 的唯一实现）**：maintenance / disabled / retiring
        // 不接受新业务，未安装凭据（waiting）也不能接 —— 本 WP 不新增第二套准入规则。
        facts({ node_id: 2, node_group_id: 404, lifecycle: "maintenance" }),
        facts({ node_id: 3, node_group_id: 404, lifecycle: "disabled" }),
        facts({ node_id: 4, node_group_id: 404, lifecycle: "retiring" }),
        facts({ node_id: 5, node_group_id: 404, has_credential: false }),
      ],
    });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) {
      expect(disabled.code).toBe("no_eligible_node");
      expect(disabled.rejected?.map((r) => r.node_id)).toEqual([2, 3, 4, 5]);
    }
  });

  test("liveness is expressed through the health constraint, not by a second admission rule", () => {
    // 既有 `nodeAdmission` 允许「离线但已安装」的节点作为候选（它可能在 apply 窗口内重连）。
    // 想让模板只落在活节点上，用显式的 health 约束表达 —— 而不是在本层再写一套规则。
    const template = parse({
      ingress: group(10, "failover"),
      transit: [],
      egress: null,
      constraints: { require_health: ["healthy", "warning"] },
    });
    const offline = compileRouteProfile({
      template,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates: [facts({ node_id: 11, node_group_id: 10, status: "inactive", health: "error" })],
    });
    expect(offline.ok).toBe(false);
    if (!offline.ok) expect(offline.rejected?.[0]?.reason).toBe("health_not_allowed");
  });

  test("a node whose role is undeclared is not treated as an ingress (不猜角色)", () => {
    const template = parse({ ingress: group(10, "failover"), transit: [], egress: null });
    const result = compileRouteProfile({
      template,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates: [facts({ node_id: 5, node_group_id: 10, role: null })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejected?.[0]?.reason).toBe("role_undeclared");
  });

  test("multi-candidate strategies are deterministic and documented", () => {
    const template = parse({ ingress: group(10, "failover"), transit: [], egress: null });
    const candidates = [
      facts({ node_id: 12, node_group_id: 10, order: 20 }),
      facts({ node_id: 11, node_group_id: 10, order: 10 }),
    ];
    expect(compileOk(template, candidates).provenance.resolved_hops[0]!.node_id).toBe(11);

    const least = parse({ ingress: group(10, "least_conn"), transit: [], egress: null });
    const byLoad = [
      facts({ node_id: 11, node_group_id: 10, load: 9 }),
      facts({ node_id: 12, node_group_id: 10, load: 2 }),
    ];
    expect(compileOk(least, byLoad).provenance.resolved_hops[0]!.node_id).toBe(12);

    const rr = parse({ ingress: group(10, "round_robin"), transit: [], egress: null });
    const pool = [
      facts({ node_id: 11, node_group_id: 10 }),
      facts({ node_id: 12, node_group_id: 10 }),
      facts({ node_id: 13, node_group_id: 10 }),
    ];
    // 同一 seed 永远同一节点；不同 seed 走不同候选（可复现，不是"每次随机"）。
    expect(compileOk(rr, pool, { rotation_seed: 7 }).provenance.resolved_hops[0]!.node_id).toBe(
      compileOk(rr, pool, { rotation_seed: 7 }).provenance.resolved_hops[0]!.node_id,
    );
    expect(compileOk(rr, pool, { rotation_seed: 4 }).provenance.resolved_hops[0]!.node_id).toBe(12);
    expect(compileOk(rr, pool, { rotation_seed: 5 }).provenance.resolved_hops[0]!.node_id).toBe(13);

    const hash = parse({ ingress: group(10, "ip_hash"), transit: [], egress: null });
    const a = compileOk(hash, pool, { hash_key: "client-a" }).provenance.resolved_hops[0]!.node_id;
    const b = compileOk(hash, pool, { hash_key: "client-a" }).provenance.resolved_hops[0]!.node_id;
    expect(a).toBe(b);
    // 缺 hash_key ⇒ 失败，不静默降级成轮询。
    const missingKey = compileRouteProfile({
      template: hash,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates: pool,
      hash_key: null,
    });
    expect(missingKey.ok).toBe(false);
    if (!missingKey.ok) expect(missingKey.code).toBe("invalid_input");

    const random = parse({ ingress: group(10, "random"), transit: [], egress: null });
    const drawn = compileOk(random, pool, { random: () => 0.99 }).provenance.resolved_hops[0]!.node_id;
    expect(drawn).toBe(13);
  });

  test("constraints and required capabilities filter candidates (fail-closed)", () => {
    const health = parse({
      ingress: group(10, "failover"),
      transit: [],
      egress: null,
      constraints: { require_health: ["healthy"] },
    });
    const result = compileRouteProfile({
      template: health,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates: [facts({ node_id: 11, node_group_id: 10, health: "error" })],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejected?.[0]?.reason).toBe("health_not_allowed");

    const caps = parse({
      ingress: group(10, "failover"),
      transit: [],
      egress: null,
      required_capabilities: ["relay_v5"],
    });
    const noCaps = compileRouteProfile({
      template: caps,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates: [facts({ node_id: 11, node_group_id: 10, capabilities: [] })],
    });
    expect(noCaps.ok).toBe(false);
    if (!noCaps.ok) expect(noCaps.code).toBe("capability_unavailable");

    const withCaps = compileRouteProfile({
      template: caps,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates: [facts({ node_id: 11, node_group_id: 10, capabilities: ["relay_v5"] })],
    });
    expect(withCaps.ok).toBe(true);

    const excluded = parse({
      ingress: group(10, "failover"),
      transit: [],
      egress: null,
      constraints: { exclude_node_ids: [11] },
    });
    const allExcluded = compileRouteProfile({
      template: excluded,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates: [facts({ node_id: 11, node_group_id: 10 })],
    });
    expect(allExcluded.ok).toBe(false);
  });

  test("a three-hop route without the adjacent bindings is refused before any dispatch (binding_missing)", () => {
    const template = parse({ ingress: fixed(1), transit: [fixed(2)], egress: fixed(3) });
    const candidates = [
      facts({ node_id: 1, role: "ingress" }),
      facts({ node_id: 2, role: "egress" }),
      facts({ node_id: 3, role: "egress" }),
    ];
    const refused = compileRouteProfile({
      template,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates,
      boundPairs: new Set<string>(),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("binding_missing");
      expect(refused.hop_index).toBe(1);
    }

    const allowed = compileRouteProfile({
      template,
      route_profile_id: 7,
      route_profile_version: 1,
      candidates,
      boundPairs: new Set(["1->2", "2->3"]),
    });
    expect(allowed.ok).toBe(true);
  });

  test("provenance records profile id / version and the resolved plan digest", () => {
    const template = parse({ ingress: fixed(3), transit: [], egress: null });
    const compiled = compileOk(template, [facts({ node_id: 3, role: "ingress" })]);
    expect(compiled.provenance.route_profile_id).toBe(7);
    expect(compiled.provenance.route_profile_version).toBe(3);
    expect(compiled.provenance.template_digest).toBe(templateDigest(template));
  });
});

/* ================================================================== */
/* D. visibility / entitlement                                          */
/* ================================================================== */

describe("V5-WP13.5B: visibility decides who may consume a template (fail-closed)", () => {
  const subject = { workspace_id: 5, is_manager: false, plan_ids: [42] };

  test("INTERNAL is manager-only; PUBLIC is open; ASSIGNED needs an active grant", () => {
    const base = { enabled: true, workspace_id: 5, assignments: [] as Array<{ target_type: string; target_id: number; active: boolean }> };
    expect(canConsumeRouteProfile({ ...base, visibility: "INTERNAL" }, subject)).toBe(false);
    expect(canConsumeRouteProfile({ ...base, visibility: "INTERNAL" }, { ...subject, is_manager: true })).toBe(true);
    expect(canConsumeRouteProfile({ ...base, visibility: "PUBLIC" }, subject)).toBe(true);
    expect(canConsumeRouteProfile({ ...base, visibility: "ASSIGNED" }, subject)).toBe(false);
    expect(
      canConsumeRouteProfile(
        { ...base, visibility: "ASSIGNED", assignments: [{ target_type: "plan", target_id: 42, active: true }] },
        subject,
      ),
    ).toBe(true);
    expect(
      canConsumeRouteProfile(
        { ...base, visibility: "ASSIGNED", assignments: [{ target_type: "workspace", target_id: 5, active: true }] },
        subject,
      ),
    ).toBe(true);
  });

  test("disabled templates and unknown visibility values are never consumable", () => {
    const base = { workspace_id: 5, assignments: [] as Array<{ target_type: string; target_id: number; active: boolean }> };
    expect(canConsumeRouteProfile({ ...base, visibility: "PUBLIC", enabled: false }, subject)).toBe(false);
    expect(canConsumeRouteProfile({ ...base, visibility: "EVERYBODY", enabled: true }, subject)).toBe(false);
    // 撤销的授权立刻失效。
    expect(
      canConsumeRouteProfile(
        { ...base, visibility: "ASSIGNED", enabled: true, assignments: [{ target_type: "workspace", target_id: 5, active: false }] },
        subject,
      ),
    ).toBe(false);
    // 跨 workspace 永不可见（即使 visibility=PUBLIC）。
    expect(
      canConsumeRouteProfile({ ...base, workspace_id: 6, visibility: "PUBLIC", enabled: true }, subject),
    ).toBe(false);
  });
});

/* ================================================================== */
/* E. HTTP + DB（TUNEX_DB_TEST=1 才执行）                               */
/* ================================================================== */

if (process.env.TUNEX_DB_TEST !== "1") {
  test("route profile HTTP/DB integration (requires TUNEX_DB_TEST=1)", () => {
    // 本机默认没有 MySQL 时整段跳过：离线用例（A–D）已经覆盖契约本体。
    expect(true).toBe(true);
  });
} else {
  const { app } = await import("../../app.ts");
  const { db } = await import("../../db.ts");
  const { redis } = await import("../../redis.ts");
  const { createHash, randomUUID } = await import("node:crypto");

  afterAll(async () => {
    redis.disconnect();
    await db.$disconnect();
  });

  const nonce = randomUUID().slice(0, 8);
  const password = "ci-only-password-12";
  let seq = 0;
  let registerSeq = 0;

  type AnyBody = { data?: any; code?: string; error?: string; error_layer?: string; retryable?: boolean };
  /** 测试内的最小 JSON 读取（避免 unknown 的逐处断言噪声）。 */
  async function json(res: { json(): Promise<unknown> }): Promise<AnyBody> {
    return (await res.json()) as AnyBody;
  }

  async function request(path: string, method: string, cookie: string, bodyValue?: unknown, workspaceId?: number) {
    return app.request(`http://localhost${path}`, {
      method,
      headers: {
        "x-forwarded-for": `198.51.100.${++seq}`,
        ...(cookie ? { cookie, "x-csrf-token": "test" } : {}),
        ...(workspaceId ? { "x-workspace-id": String(workspaceId) } : {}),
        ...(bodyValue ? { "content-type": "application/json" } : {}),
      },
      ...(bodyValue ? { body: JSON.stringify(bodyValue) } : {}),
    });
  }

  /**
   * 注册 + 登录（走真实 HTTP 路径，与 `tests/workspace-db.test.mjs` 同口径）：
   * 账户凭据、personal workspace、成员行、策略发放全部由生产代码建立 ——
   * 测试不自己拼一份「看起来像用户」的行，否则测的就不是真实装配。
   */
  async function registerUser(label: string) {
    registerSeq += 1;
    const email = `rp-${label}-${nonce}-${registerSeq}@example.test`;
    const created = await request("/api/auth/register", "POST", "", { email, password });
    expect(created.status).toBe(201);
    const login = await request("/api/auth/login", "POST", "", { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie.startsWith("access=")).toBe(true);

    const user = await db.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    const personal = await db.workspace.findUnique({
      where: { personal_user_id: user!.id },
      select: { id: true },
    });
    expect(personal).not.toBeNull();
    return { id: user!.id, email, workspaceId: personal!.id, cookie };
  }

  /** 一个 workspace 内的入口节点（凭据 + 心跳齐全 ⇒ 能过 §13.4.2 准入）。 */
  async function createNode(workspaceId: number, userId: number, label: string, portBase: number) {
    const group = await db.nodeGroup.create({
      data: {
        token: `rp-group-${label}-${nonce}-${randomUUID()}`,
        name: `RP group ${label} ${nonce}`,
        node_type: "in",
        user_id: userId,
        workspace_id: workspaceId,
      },
    });
    const node = await db.node.create({
      data: {
        node_id: `rp-node-${label}-${nonce}-${randomUUID().slice(0, 6)}`,
        agent_id: `rp-agent-${label}-${nonce}-${randomUUID().slice(0, 6)}`,
        node_group_id: group.id,
        role: "both",
        status: "active",
        lifecycle: "active",
        connect_ip: "127.0.0.1",
        port_range_min: portBase,
        port_range_max: portBase + 200,
        last_seen_at: new Date(),
        node_credential_hash: createHash("sha256").update(`cred-${label}-${randomUUID()}`).digest("hex"),
      },
    });
    return { group, node };
  }

  const templateFor = (nodeId: number) => ({ ingress: { kind: "fixed_node", node_id: nodeId }, transit: [], egress: null });

  test("HTTP: CRUD respects workspace RBAC and isolates workspaces", async () => {
    const owner = await registerUser("owner");
    const outsider = await registerUser("outsider");
    const { group, node } = await createNode(owner.workspaceId, owner.id, "in-a", 41000);

    // 未认证：401。
    const anon = await request("/api/route-profiles", "GET", "");
    expect(anon.status).toBe(401);

    // 创建：需要 workspace 的 manage 权限（node 资源族）。
    const created = await request(
      "/api/route-profiles",
      "POST",
      owner.cookie,
      { name: `RP ${nonce}`, description: "test", visibility: "PUBLIC", template: templateFor(node.id) },
      owner.workspaceId,
    );
    expect(created.status).toBe(201);
    const profileId = (await json(created)).data.id as number;
    expect(profileId).toBeGreaterThan(0);

    // 未在本 workspace 的用户：既看不到也读不到（404，不泄露存在性）。
    const foreignGet = await request(`/api/route-profiles/${profileId}`, "GET", outsider.cookie);
    expect(foreignGet.status).toBe(404);
    const foreignPatch = await request(`/api/route-profiles/${profileId}`, "PATCH", outsider.cookie, { enabled: false });
    expect(foreignPatch.status).toBe(404);
    const foreignList = await request("/api/route-profiles", "GET", outsider.cookie);
    expect(foreignList.status).toBe(200);
    expect((await json(foreignList)).data.total).toBe(0);

    // 本 workspace 的只读成员：可以读，不能写（RBAC 分层：read 通过、manage 403）。
    await db.workspaceMember.create({
      data: { workspace_id: owner.workspaceId, user_id: outsider.id, role: "viewer", active: true },
    });
    const viewerRead = await request(`/api/route-profiles/${profileId}`, "GET", outsider.cookie, undefined, owner.workspaceId);
    expect(viewerRead.status).toBe(200);
    const viewerWrite = await request(
      `/api/route-profiles/${profileId}/versions`,
      "POST",
      outsider.cookie,
      { template: templateFor(node.id) },
      owner.workspaceId,
    );
    expect(viewerWrite.status).toBe(403);
    expect((await json(viewerWrite)).error_layer).toBe("rbac");

    // unknown visibility 是 fail-closed 的 400。
    const badVisibility = await request(
      "/api/route-profiles",
      "POST",
      owner.cookie,
      { name: `RP bad ${nonce}`, visibility: "EVERYONE", template: templateFor(node.id) },
      owner.workspaceId,
    );
    expect(badVisibility.status).toBe(400);
    expect((await json(badVisibility)).code).toBe("invalid_input");

    // 组引用不存在：no_eligible_node（409，runtime_admission），不是 500。
    await db.nodeGroup.delete({ where: { id: group.id } }).catch(() => undefined);
  });

  test("HTTP: impact analysis is read-only, apply writes provenance, and publishing never rewrites a running Forward", async () => {
    const owner = await registerUser("apply");
    const ingressA = await createNode(owner.workspaceId, owner.id, "apply-a", 43000);
    const ingressB = await createNode(owner.workspaceId, owner.id, "apply-b", 43500);
    // Forward 起点的入口节点：与模板 v1 解析出的节点**不同**，apply 才是真改动。
    const ingressOrig = await createNode(owner.workspaceId, owner.id, "apply-orig", 43700);

    const created = await request(
      "/api/route-profiles",
      "POST",
      owner.cookie,
      { name: `RP apply ${nonce}`, visibility: "INTERNAL", template: templateFor(ingressA.node.id) },
      owner.workspaceId,
    );
    expect(created.status).toBe(201);
    const profileId = (await json(created)).data.id as number;

    // 一条已存在的 DIRECT Forward（直接落库，避免依赖 Agent 侧创建流程）。
    const forward = await db.tunnel.create({
      data: {
        name: `RP forward ${nonce}`,
        category: "port_forward",
        tunnel_mode: "direct",
        forward_protocol: "tcp",
        tunnel_type: "tcp",
        forward_addresses: ["127.0.0.1:8080"],
        load_balance_type: "round",
        in_node_group_id: ingressOrig.group.id,
        workspace_id: owner.workspaceId,
        user_id: owner.id,
        ingress_node_id: ingressOrig.node.id,
        listen_port: 43100,
        remote_host: "127.0.0.1",
        remote_port: 8080,
        // suspended：§13.3.6「suspended 编辑 = 存 desired 不启 runtime」。
        // 本用例验证的是 Route Profile 的契约（新 revision + provenance + 不静默重写），
        // 不需要 Agent 数据面参与 —— 让 rollout 走 noop 出口，测试才确定、快速。
        // 真实下发由既有 rollout 与 Integration Gate 覆盖，不是本 WP 的责任。
        desired_status: "inactive",
        apply_status: "suspended",
        config_revision: 0,
      },
    });

    const revisionCountBefore = await db.forwardRevision.count({ where: { tunnel_id: forward.id } });
    const rolloutCountBefore = await db.forwardRollout.count({ where: { tunnel_id: forward.id } });
    /** 该 Forward 的「不可变历史」行数快照：只读接口的唯一判据。 */
    const historyCounts = async () => ({
      revisions: await db.forwardRevision.count({ where: { tunnel_id: forward.id } }),
      rollouts: await db.forwardRollout.count({ where: { tunnel_id: forward.id } }),
    });

    // ① 第一次 apply 之前：影响面为**空**且 read_only。
    //    模板是意图，Forward 是否属于它只能由一次显式 apply 建立；按「可能」猜一遍
    //    就是把意图当事实 —— 所以空列表是正确答案，而不是缺失。
    const impactBefore = await request(`/api/route-profiles/${profileId}/impact`, "GET", owner.cookie, undefined, owner.workspaceId);
    expect(impactBefore.status).toBe(200);
    const impactBeforeBody = (await json(impactBefore)).data;
    expect(impactBeforeBody.read_only).toBe(true);
    expect(impactBeforeBody.scope).toBe("referencing_forwards");
    expect(impactBeforeBody.affected).toEqual([]);
    expect(await db.forwardRevision.count({ where: { tunnel_id: forward.id } })).toBe(revisionCountBefore);
    expect(await db.forwardRollout.count({ where: { tunnel_id: forward.id } })).toBe(rolloutCountBefore);

    // ② dry-run：只读预览（不写一行）。
    const dry = await request(
      `/api/route-profiles/${profileId}/apply`,
      "POST",
      owner.cookie,
      { forward_ids: [forward.id], dry_run: true },
      owner.workspaceId,
    );
    expect(dry.status).toBe(200);
    expect((await json(dry)).data.outcomes[0].status).toBe("previewed");
    expect(await db.forwardRevision.count({ where: { tunnel_id: forward.id } })).toBe(revisionCountBefore);

    // ③ 显式 apply：走既有 patchForward（新 revision），并落 provenance。
    const applied = await request(
      `/api/route-profiles/${profileId}/apply`,
      "POST",
      owner.cookie,
      { forward_ids: [forward.id], expected_revisions: { [forward.id]: 0 } },
      owner.workspaceId,
    );
    expect(applied.status).toBe(200);
    const appliedBody = (await json(applied)).data;
    expect(appliedBody.applied_count).toBe(1);
    expect(appliedBody.outcomes[0].runtime_changed).toBe(true);
    const newRevision = appliedBody.outcomes[0].revision as number;
    expect(newRevision).toBeGreaterThan(0);

    const revisionRow = await db.forwardRevision.findFirst({
      where: { tunnel_id: forward.id, revision: newRevision },
      select: { route_profile_id: true, route_profile_version: true, ingress_node_id: true },
    });
    expect(revisionRow?.route_profile_id).toBe(profileId);
    expect(revisionRow?.route_profile_version).toBe(1);
    expect(revisionRow?.ingress_node_id).toBe(ingressA.node.id);

    const afterApply = await db.tunnel.findUnique({ where: { id: forward.id } });
    expect(afterApply?.route_profile_id).toBe(profileId);
    expect(afterApply?.ingress_node_id).toBe(ingressA.node.id);
    const appliedRevision = afterApply?.applied_revision ?? null;
    const configRevision = afterApply?.config_revision ?? 0;

    const ledger = await db.routeProfileApplication.findFirst({
      where: { tunnel_id: forward.id, forward_revision: newRevision },
    });
    expect(ledger?.route_profile_version).toBe(1);

    // ③b 再 apply 同一版本：解析结果与当前放置相同 ⇒ 不产生新 revision
    //     （既有编辑路径判为 metadata-only），但仍如实报告"只是认领来源"。
    const reapply = await request(
      `/api/route-profiles/${profileId}/apply`,
      "POST",
      owner.cookie,
      { forward_ids: [forward.id] },
      owner.workspaceId,
    );
    expect(reapply.status).toBe(200);
    expect((await json(reapply)).data.outcomes[0].runtime_changed).toBe(false);
    expect(await db.forwardRevision.count({ where: { tunnel_id: forward.id } })).toBe(revisionCountBefore + 1);

    // ③b impact analysis 只读：现在这条 Forward 的来源就是该模板，列表必须给出它，
    //     且**一行都不写**（forward_revision / forward_rollout 前后行数相同）。
    const beforeImpact = await historyCounts();
    const impact = await request(`/api/route-profiles/${profileId}/impact`, "GET", owner.cookie, undefined, owner.workspaceId);
    expect(impact.status).toBe(200);
    const impactBody = (await json(impact)).data;
    expect(impactBody.read_only).toBe(true);
    expect(impactBody.affected.map((a: { forward_id: number }) => a.forward_id)).toEqual([forward.id]);
    expect(impactBody.affected[0].change.noop).toBe(true); // 已应用同一版本 ⇒ 不需要动
    expect(await historyCounts()).toEqual(beforeImpact); // 只读：一行都不写

    // ④ 发布新版本（换成另一台入口节点）：**不得**静默重写这条正在运行的 Forward。
    const beforePublish = await historyCounts();
    const published = await request(
      `/api/route-profiles/${profileId}/versions`,
      "POST",
      owner.cookie,
      { template: templateFor(ingressB.node.id), expected_version: 1, change_summary: "switch ingress" },
      owner.workspaceId,
    );
    expect(published.status).toBe(201);
    expect((await json(published)).data.version).toBe(2);

    const afterPublish = await db.tunnel.findUnique({ where: { id: forward.id } });
    expect(afterPublish?.ingress_node_id).toBe(ingressA.node.id); // 运行中的路由没变
    expect(afterPublish?.config_revision).toBe(configRevision);
    expect(afterPublish?.applied_revision).toBe(appliedRevision);
    expect(afterPublish?.route_profile_version).toBe(1); // 指针停在已应用的版本
    // 发布既不产生新 revision，也不产生新 rollout（运行中的 Forward 一个字节没动）。
    expect(await historyCounts()).toEqual(beforePublish);

    // 版本冲突：用过期 expected_version 发布 → 409（不静默覆盖）。
    const stale = await request(
      `/api/route-profiles/${profileId}/versions`,
      "POST",
      owner.cookie,
      { template: templateFor(ingressA.node.id), expected_version: 1 },
      owner.workspaceId,
    );
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe("version_conflict");

    // 新版本的 impact 会指出这条 Forward 将换入口节点。
    const impact2 = await request(
      `/api/route-profiles/${profileId}/impact?version=2`,
      "GET",
      owner.cookie,
      undefined,
      owner.workspaceId,
    );
    const impact2Body = (await json(impact2)).data;
    expect(impact2Body.version).toBe(2);
    expect(impact2Body.affected[0].resolved_hops[0].node_id).toBe(ingressB.node.id);
    expect(impact2Body.affected[0].change.ingress_change).toBe(true);
    expect(await db.forwardRevision.count({ where: { tunnel_id: forward.id } })).toBe(revisionCountBefore + 1);

    // ⑤ PATCH 想改模板内容 ⇒ 400（模板变更只能发新版本）。
    const sneaky = await request(
      `/api/route-profiles/${profileId}`,
      "PATCH",
      owner.cookie,
      { template: templateFor(ingressB.node.id) },
      owner.workspaceId,
    );
    expect(sneaky.status).toBe(400);

    // ⑥ apply 不提供「应用到全部」的隐式形式。
    const implicit = await request(
      `/api/route-profiles/${profileId}/apply`,
      "POST",
      owner.cookie,
      {},
      owner.workspaceId,
    );
    expect(implicit.status).toBe(400);
    expect((await json(implicit)).code).toBe("invalid_input");
  }, 120000);

  test("HTTP: the consumer list is read-only and hides INTERNAL templates from plain members", async () => {
    const owner = await registerUser("consume");
    const member = await registerUser("consume-member");
    const ingress = await createNode(owner.workspaceId, owner.id, "consume-a", 45000);
    await db.workspaceMember.create({
      data: { workspace_id: owner.workspaceId, user_id: member.id, role: "member", active: true },
    });

    const internal = await request(
      "/api/route-profiles",
      "POST",
      owner.cookie,
      { name: `RP internal ${nonce}`, visibility: "INTERNAL", template: templateFor(ingress.node.id) },
      owner.workspaceId,
    );
    expect(internal.status).toBe(201);
    const publicOne = await request(
      "/api/route-profiles",
      "POST",
      owner.cookie,
      { name: `RP public ${nonce}`, visibility: "PUBLIC", template: templateFor(ingress.node.id) },
      owner.workspaceId,
    );
    expect(publicOne.status).toBe(201);
    const publicId = (await json(publicOne)).data.id as number;

    const ownerList = await request("/api/route-profiles/available", "GET", owner.cookie, undefined, owner.workspaceId);
    expect(ownerList.status).toBe(200);
    const ownerVisible = (await json(ownerList)).data.data.map((p: { id: number }) => p.id);
    expect(ownerVisible).toContain(publicId);

    const memberList = await request("/api/route-profiles/available", "GET", member.cookie, undefined, owner.workspaceId);
    expect(memberList.status).toBe(200);
    const memberVisible = (await json(memberList)).data.data.map((p: { id: number }) => p.id);
    expect(memberVisible).toContain(publicId);
    expect(memberVisible).not.toContain((await json(internal)).data.id);
  });
}
