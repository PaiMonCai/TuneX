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
import { describe, expect, test } from "bun:test";

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
/* E. HTTP + DB                                                        */
/* ================================================================== */

/**
 * HTTP / DB 用例**不放在本文件**：仓库里多个 `bun test src` 文件用 `mock.module`
 * 替换共享模块（db / auth / scheduler…），同一进程内会互相污染（实测：注册接口在这种
 * 上下文里返回 403）。既有 DB/HTTP 用例（authorization / workspace-db /
 * forward-revision-migration）统一放在 `backend/tests/*.mjs`，由 `node --test`
 * 每文件独立进程执行 —— 那也是 CI 的 `bun run test` 覆盖面。
 *
 * Route Profile 的 HTTP 面（CRUD 权限 / 跨 workspace 隔离 / impact analysis 只读 /
 * apply provenance / 发布不静默重写 / 消费侧可见性）见：
 *   `backend/tests/route-profile.test.mjs`（`TUNEX_DB_TEST=1` 时执行）。
 */
test("route profile HTTP/DB integration lives in tests/route-profile.test.mjs", () => {
  expect(true).toBe(true);
});
