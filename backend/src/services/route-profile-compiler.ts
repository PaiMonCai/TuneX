/**
 * V5-WP13.5B —— Route Profile 编译器（**纯函数**）。
 *
 * 契约：`docs/v5-wp13-5b-route-profile-contract.md`（FROZEN），
 * 上游定义：`DEVELOPMENT.md` §9.4.2–§9.4.6。
 *
 * 本模块只做一件事：把「模板 selector」解析成「具体节点事实」，然后**原样交给**
 * `services/forward-route.ts` 的 `buildRoutePlan` / `admitRoute` / `routeSteps`。
 * 它刻意不做的事：
 *   · 不新建第二套路由模型（没有 hop 结构体、没有图、没有寻路）；
 *   · 不读数据库（候选节点事实由调用方作为事实传入）；
 *   · 不产生下发命令、不碰 revision、不持有任何状态机；
 *   · 不在运行期重抽随机候选 —— 随机只在编译这一刻抽一次，结果立刻被冻结进
 *     ForwardRevision 快照（§9.4.3：运行时必须用确定的具体节点事实）。
 *
 * 纯函数的第二个理由是可测：`DEVELOPMENT.md` §3.6 要求 selector 解析（fixed node /
 * node group / 缺候选 / 多候选策略边界）、transit 顺序、非法组合 fail-closed 都能
 * 离线断言，不需要 MySQL / Redis / Agent。
 */
import {
  MAX_ROUTE_HOPS,
  admitRoute,
  buildRoutePlan,
  routeSteps,
  type RoutePlacement,
  type RoutePlan,
  type RouteStep,
  type RouteViolation,
} from "./forward-route.ts";
import { nodeAdmission } from "./node-lifecycle.ts";

/* ================================================================== */
/* 1. 产品可见性（§9.4.6）                                             */
/* ================================================================== */

/** 三类可见性。**字符串列 + 应用层校验**：§3.4 禁止用 DB enum 承载会扩展的集合。 */
export const ROUTE_PROFILE_VISIBILITIES = ["INTERNAL", "ASSIGNED", "PUBLIC"] as const;
export type RouteProfileVisibility = (typeof ROUTE_PROFILE_VISIBILITIES)[number];

/** ASSIGNED 的授权对象类型（字符串列；当前只开放这两类）。 */
export const ROUTE_PROFILE_ASSIGNMENT_TARGETS = ["workspace", "plan"] as const;
export type RouteProfileAssignmentTarget = (typeof ROUTE_PROFILE_ASSIGNMENT_TARGETS)[number];

/**
 * 可见性解析：未知值 **fail-closed**（返回 null，由调用方拒绝），
 * 绝不「不认识就当 INTERNAL/PUBLIC」——那会静默改变一条线路的可达范围。
 */
export function parseRouteProfileVisibility(value: unknown): RouteProfileVisibility | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return (ROUTE_PROFILE_VISIBILITIES as readonly string[]).includes(upper)
    ? (upper as RouteProfileVisibility)
    : null;
}

export function parseAssignmentTarget(value: unknown): RouteProfileAssignmentTarget | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (ROUTE_PROFILE_ASSIGNMENT_TARGETS as readonly string[]).includes(lower)
    ? (lower as RouteProfileAssignmentTarget)
    : null;
}

/* ================================================================== */
/* 2. 模板形状（selector / policy / constraints / capabilities）        */
/* ================================================================== */

export interface FixedNodeSelector {
  readonly kind: "fixed_node";
  readonly node_id: number;
}

export interface NodeGroupSelector {
  readonly kind: "node_group";
  readonly node_group_id: number;
  /** 多候选选择策略；`.ts`(transit) 不接受本 selector（见 §9.4.4 第 4 条）。 */
  readonly strategy: string;
}

export type RouteSelector = FixedNodeSelector | NodeGroupSelector;

/**
 * ingress 侧策略：入口组只有一个候选池，出错时**换机**（failover/fencing）。
 * `fallback` 与 `failover` 在本编译器里同义（按确定性顺序取第一个合格候选）。
 */
export const INGRESS_STRATEGIES = [
  "failover",
  "fallback",
  "round_robin",
  "random",
  "least_conn",
  "ip_hash",
] as const;

/** egress 侧策略：§9.4.4 第 3 条冻结的集合。 */
export const EGRESS_STRATEGIES = [
  "fallback",
  "round_robin",
  "random",
  "least_conn",
  "ip_hash",
] as const;

/** health / placement 约束。键集合封闭：未知键 fail-closed（§3.5 unknown/malformed）。 */
export interface RouteProfileConstraints {
  /** 显式排除的节点。 */
  readonly exclude_node_ids?: readonly number[];
  /**
   * 允许的 lifecycle 集合。**缺省 = 只允许 `active`**（fail-closed）：
   * maintenance / disabled / retiring 都「不接受新业务」（§13.4.2），
   * 要让它们参与编排必须显式写出来，而不是靠默认值顺带放行。
   */
  readonly allowed_lifecycles?: readonly string[];
  /**
   * 允许的健康态（取值域与 `node-health.ts` 的 `NODE_HEALTHS` 一致）。
   * 缺省 / 空数组 = 不额外要求（健康事实缺失时不因此拒绝，由 `require_health`
   * 的**显式**声明来收紧）。
   */
  readonly require_health?: readonly string[];
  /**
   * 相邻跳是否必须已存在 NodeBinding（默认 true）。关闭它只影响**准入**：
   * 绑定的创建仍是既有 rollout 的 `ensure_binding` 步骤。
   */
  readonly require_node_binding?: boolean;
}

export interface RouteProfileTemplate {
  readonly ingress: RouteSelector;
  /** **有序**中间跳。第一版只允许 fixed_node，且最多 1 个（最多 3 跳）。 */
  readonly transit: readonly FixedNodeSelector[];
  /** `null` = DIRECT（出口就是 ingress 那一跳，见 `buildRoutePlan`）。 */
  readonly egress: RouteSelector | null;
  readonly ingress_policy?: Record<string, unknown> | null;
  readonly egress_policy?: Record<string, unknown> | null;
  readonly constraints?: RouteProfileConstraints | null;
  readonly required_capabilities?: readonly string[] | null;
}

export type TemplateParseFailure = {
  readonly ok: false;
  readonly code: "invalid_input" | "unsupported_topology";
  readonly message: string;
};

export type TemplateParseResult =
  | { readonly ok: true; readonly template: RouteProfileTemplate }
  | TemplateParseFailure;

const TEMPLATE_KEYS = new Set([
  "ingress",
  "transit",
  "egress",
  "ingress_policy",
  "egress_policy",
  "constraints",
  "required_capabilities",
]);

const CONSTRAINT_KEYS = new Set([
  "exclude_node_ids",
  "allowed_lifecycles",
  "require_health",
  "require_node_binding",
]);

function bad(message: string, code: TemplateParseFailure["code"] = "invalid_input"): TemplateParseFailure {
  return { ok: false, code, message };
}

function isPositiveInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析一个 selector；`position` 决定允许的策略集合。 */
function parseSelector(
  raw: unknown,
  position: "ingress" | "egress" | "transit",
): { ok: true; selector: RouteSelector } | TemplateParseFailure {
  if (!isPlainObject(raw)) return bad(`${position} selector 必须是对象`);
  const kind = raw.kind;
  if (kind === "fixed_node") {
    if (!isPositiveInt(raw.node_id)) return bad(`${position} selector 的 node_id 必须是正整数`);
    return { ok: true, selector: { kind: "fixed_node", node_id: raw.node_id } };
  }
  if (kind === "node_group") {
    if (position === "transit") {
      // §9.4.4 第 4 条：dynamic middle pool 继续**关闭**。
      return bad(
        "中间跳暂不支持节点组候选池（dynamic middle pool 未开放）；请使用固定的 fixed_node 中间跳",
        "unsupported_topology",
      );
    }
    if (!isPositiveInt(raw.node_group_id)) {
      return bad(`${position} selector 的 node_group_id 必须是正整数`);
    }
    const allowed: readonly string[] = position === "ingress" ? INGRESS_STRATEGIES : EGRESS_STRATEGIES;
    if (typeof raw.strategy !== "string" || !allowed.includes(raw.strategy)) {
      return bad(
        `${position} selector 的 strategy 必须是 ${allowed.join(" / ")} 之一`,
      );
    }
    return {
      ok: true,
      selector: { kind: "node_group", node_group_id: raw.node_group_id, strategy: raw.strategy },
    };
  }
  return bad(`${position} selector 的 kind 未知（只接受 fixed_node / node_group）`);
}

function parsePolicy(raw: unknown, name: string): { ok: true; policy: Record<string, unknown> | null } | TemplateParseFailure {
  if (raw === undefined || raw === null) return { ok: true, policy: null };
  if (!isPlainObject(raw)) return bad(`${name} 必须是对象`);
  return { ok: true, policy: raw };
}

function parseConstraints(raw: unknown): { ok: true; constraints: RouteProfileConstraints | null } | TemplateParseFailure {
  if (raw === undefined || raw === null) return { ok: true, constraints: null };
  if (!isPlainObject(raw)) return bad("constraints 必须是对象");
  for (const key of Object.keys(raw)) {
    if (!CONSTRAINT_KEYS.has(key)) return bad(`constraints 含未知键：${key}`);
  }
  const out: {
    exclude_node_ids?: number[];
    allowed_lifecycles?: string[];
    require_health?: string[];
    require_node_binding?: boolean;
  } = {};
  if (raw.exclude_node_ids !== undefined) {
    if (!Array.isArray(raw.exclude_node_ids) || !raw.exclude_node_ids.every(isPositiveInt)) {
      return bad("constraints.exclude_node_ids 必须是正整数数组");
    }
    out.exclude_node_ids = [...raw.exclude_node_ids];
  }
  for (const key of ["allowed_lifecycles", "require_health"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
      return bad(`constraints.${key} 必须是非空字符串数组`);
    }
    out[key] = (value as string[]).map((v) => v.trim());
  }
  if (raw.require_node_binding !== undefined) {
    if (typeof raw.require_node_binding !== "boolean") {
      return bad("constraints.require_node_binding 必须是布尔值");
    }
    out.require_node_binding = raw.require_node_binding;
  }
  return { ok: true, constraints: out };
}

function parseCapabilities(raw: unknown): { ok: true; capabilities: string[] | null } | TemplateParseFailure {
  if (raw === undefined || raw === null) return { ok: true, capabilities: null };
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string" && v.trim() !== "")) {
    return bad("required_capabilities 必须是非空字符串数组");
  }
  return { ok: true, capabilities: [...new Set((raw as string[]).map((v) => v.trim()))] };
}

/**
 * 模板形状校验（唯一实现）。
 *
 * fail-closed 的三条硬规则：
 *   1. 未知顶层键 / 未知约束键 / 未知 kind / 未知 strategy ⇒ `invalid_input`；
 *   2. transit 里出现 `null`/空位（「声明了一个跳位但没有具体节点」）⇒ `invalid_input`；
 *   3. transit 里出现 node_group（dynamic middle pool）⇒ `unsupported_topology`。
 */
export function parseRouteProfileTemplate(raw: unknown): TemplateParseResult {
  if (!isPlainObject(raw)) return bad("模板必须是对象");
  for (const key of Object.keys(raw)) {
    if (!TEMPLATE_KEYS.has(key)) return bad(`模板含未知键：${key}`);
  }

  const ingress = parseSelector(raw.ingress, "ingress");
  if (!ingress.ok) return ingress;

  let transit: FixedNodeSelector[] = [];
  if (raw.transit !== undefined && raw.transit !== null) {
    if (!Array.isArray(raw.transit)) return bad("transit 必须是数组（有序）");
    const maxMiddle = MAX_ROUTE_HOPS - 2; // 3 跳 ⇒ 最多 1 个中间跳
    if (raw.transit.length > maxMiddle) {
      return bad(`transit 最多 ${maxMiddle} 个中间跳（整条路由最多 ${MAX_ROUTE_HOPS} 跳）`, "unsupported_topology");
    }
    const seen = new Set<number>();
    for (let i = 0; i < raw.transit.length; i += 1) {
      const element = raw.transit[i];
      if (element === null || element === undefined) {
        return bad(`transit[${i}] 声明了一个跳位但没有具体节点（缺具体 selector）`);
      }
      const parsed = parseSelector(element, "transit");
      if (!parsed.ok) return parsed;
      if (parsed.selector.kind !== "fixed_node") {
        return bad(`transit[${i}] 只能是 fixed_node`, "unsupported_topology");
      }
      if (seen.has(parsed.selector.node_id)) {
        return bad(`transit[${i}] 与前面的中间跳重复（同一节点不能占两个跳位）`);
      }
      seen.add(parsed.selector.node_id);
      transit.push(parsed.selector);
    }
  }

  let egress: RouteSelector | null = null;
  if (raw.egress !== undefined && raw.egress !== null) {
    const egressSelector = parseSelector(raw.egress, "egress");
    if (!egressSelector.ok) return egressSelector;
    egress = egressSelector.selector;
  }

  const ingressPolicy = parsePolicy(raw.ingress_policy, "ingress_policy");
  if (!ingressPolicy.ok) return ingressPolicy;
  const egressPolicy = parsePolicy(raw.egress_policy, "egress_policy");
  if (!egressPolicy.ok) return egressPolicy;
  const constraints = parseConstraints(raw.constraints);
  if (!constraints.ok) return constraints;
  const capabilities = parseCapabilities(raw.required_capabilities);
  if (!capabilities.ok) return capabilities;

  return {
    ok: true,
    template: {
      ingress: ingress.selector,
      transit,
      egress,
      ingress_policy: ingressPolicy.policy,
      egress_policy: egressPolicy.policy,
      constraints: constraints.constraints,
      required_capabilities: capabilities.capabilities,
    },
  };
}

/** 归一化后的版本快照 body（写入 `route_profile_version.body`，不可变）。 */
export function templateBody(template: RouteProfileTemplate): Record<string, unknown> {
  return {
    ingress: template.ingress,
    transit: template.transit,
    egress: template.egress,
    ingress_policy: template.ingress_policy ?? null,
    egress_policy: template.egress_policy ?? null,
    constraints: template.constraints ?? null,
    required_capabilities: template.required_capabilities ?? null,
  };
}

/** 稳定摘要：用于「这次发布会改变什么」的人类可读比较，不参与任何判定。 */
export function templateDigest(template: RouteProfileTemplate): string {
  return JSON.stringify(templateBody(template));
}

/* ================================================================== */
/* 3. 候选事实与解析（确定性优先）                                      */
/* ================================================================== */

/** 一个候选节点的**事实**（由调用方读库后传入；编译器不读库）。 */
export interface RouteNodeFacts {
  readonly node_id: number;
  readonly node_group_id: number | null;
  /** `NodeRole`：ingress | egress | both | null（null = 尚未声明角色）。 */
  readonly role?: string | null;
  /** `Node.status`（连接态事实）。 */
  readonly status?: string | null;
  /** `Node.lifecycle`（期望管理态）。 */
  readonly lifecycle?: string | null;
  readonly last_seen_at?: Date | string | null;
  readonly has_credential?: boolean;
  readonly credential_revoked?: boolean;
  /** 面板合成出的健康态（`NODE_HEALTHS`）。 */
  readonly health?: string | null;
  /** 已上报能力（advertised）。**不是授权来源**（§14）。 */
  readonly capabilities?: readonly string[] | null;
  /** 存活连接数，供 `least_conn` 使用；缺失按 0 处理。 */
  readonly load?: number | null;
  /** `Node.order_by`（缺省 1000）。 */
  readonly order?: number | null;
  /** 用户可读节点名（错误信息用；不参与判定）。 */
  readonly label?: string | null;
}

export type CompileFailureCode =
  | "invalid_input"
  | "unsupported_topology"
  | "no_eligible_node"
  | "capability_unavailable"
  | "binding_missing"
  | "route_invalid"
  | "route_not_dispatchable";

export interface CompileFailure {
  readonly ok: false;
  readonly code: CompileFailureCode;
  readonly message: string;
  /** 出问题时**哪一跳**（§9.4 的可定位性要求）。 */
  readonly hop_index?: number;
  readonly violation?: RouteViolation;
  /** 被过滤掉的候选与原因（排障用；不参与判定）。 */
  readonly rejected?: ReadonlyArray<{ node_id: number; reason: string }>;
}

export interface CompileRouteProfileInput {
  readonly template: RouteProfileTemplate;
  readonly route_profile_id: number;
  readonly route_profile_version: number;
  /** 候选节点事实。调用方应传入「同一 workspace 可见」的节点，越权过滤不在这里。 */
  readonly candidates: readonly RouteNodeFacts[];
  /** 已存在的相邻绑定集合（`"a->b"`）；缺省空集。 */
  readonly boundPairs?: ReadonlySet<string>;
  /** `round_robin` 的确定性种子（例如 forward_id 或 revision）。 */
  readonly rotation_seed?: number;
  /** `ip_hash` 的键（例如客户端面地址）。缺失时 `ip_hash` 失败而不是退化成轮询。 */
  readonly hash_key?: string | null;
  /** 可注入的随机源（测试用）；缺省 `Math.random`。只在编译期调用一次。 */
  readonly random?: () => number;
  /**
   * 多跳下发是否已实现。V5.4 的计划/执行/补偿/准入四件已齐，既有调用点
   * （`forward-rollout-exec.ts` 的 `registerRollout`）传 true；缺省同样为 true，
   * 但保留开关以便未来回归时能显式关闭。
   */
  readonly multi_hop_implemented?: boolean;
}

export interface ResolvedHop {
  readonly hop_index: number;
  readonly role: "ingress" | "middle" | "egress";
  readonly node_id: number;
}

export interface CompiledRouteProfile {
  readonly ok: true;
  readonly tunnel_mode: "direct" | "relay";
  readonly placement: RoutePlacement;
  readonly plan: RoutePlan;
  readonly steps: RouteStep[];
  readonly provenance: {
    readonly route_profile_id: number;
    readonly route_profile_version: number;
    readonly resolved_hops: ResolvedHop[];
    readonly template_digest: string;
  };
}

export type CompileRouteProfileResult = CompiledRouteProfile | CompileFailure;

/** 角色的能力判定（与 `forward-service.ts` 的创建路径同口径）。 */
function roleAccepts(role: string | null | undefined, position: "ingress" | "egress" | "transit"): boolean {
  if (position === "ingress") return role === "ingress" || role === "both";
  // 中间跳的物理形态是 EGRESS runtime（`forward-rollout.ts` 的三跳准入同口径：
  // middle 必须 role=egress|both），因此这里与出口同一要求。
  return role === "egress" || role === "both";
}

function nodeLabel(facts: RouteNodeFacts): string {
  return facts.label ? `${facts.node_id}(${facts.label})` : String(facts.node_id);
}

/**
 * 单个候选是否合格。返回 null = 合格，否则是拒绝原因（供错误信息与排障）。
 *
 * 判定顺序刻意固定：先「能不能指挥这台机器」（复用 `nodeAdmission`，与 Forward
 * 创建路径同一位），再角色、再 health、再 capabilities —— 任一维度都有**可区分的
 * 原因**，因为 §13 禁止把不同问题压成同一个失败。
 */
function candidateRejection(
  facts: RouteNodeFacts,
  template: RouteProfileTemplate,
  position: "ingress" | "egress" | "transit",
  groupFilter: number | null,
): string | null {
  if (groupFilter !== null && facts.node_group_id !== groupFilter) return "node_group_mismatch";
  const constraints = template.constraints ?? null;
  if (constraints?.exclude_node_ids?.includes(facts.node_id)) return "excluded_by_constraint";

  const admission = nodeAdmission({
    lifecycle: facts.lifecycle ?? null,
    status: facts.status ?? null,
    last_seen_at: facts.last_seen_at == null ? null : new Date(facts.last_seen_at),
    has_credential: facts.has_credential ?? false,
    credential_revoked: facts.credential_revoked ?? false,
  });
  if (!admission.ok) return admission.condition;

  // 缺省只允许 active：显式白名单才放宽（fail-closed，不给默认放行）。
  const allowedLifecycles = constraints?.allowed_lifecycles ?? ["active"];
  if (!allowedLifecycles.includes(facts.lifecycle ?? "")) return "lifecycle_not_allowed";

  if (!roleAccepts(facts.role, position)) {
    return facts.role == null ? "role_undeclared" : "role_mismatch";
  }

  const requireHealth = constraints?.require_health;
  if (requireHealth && requireHealth.length > 0 && !requireHealth.includes(facts.health ?? "unknown")) {
    return "health_not_allowed";
  }

  const required = template.required_capabilities ?? [];
  if (required.length > 0) {
    const advertised = new Set(facts.capabilities ?? []);
    const missing = required.filter((c) => !advertised.has(c));
    if (missing.length > 0) return `capability_missing:${missing.join(",")}`;
  }
  return null;
}

/** 确定性排序：(order, node_id)。并列时 node_id 决胜，保证同一输入永远同一结果。 */
function deterministicOrder(a: RouteNodeFacts, b: RouteNodeFacts): number {
  const oa = a.order ?? 1000;
  const ob = b.order ?? 1000;
  if (oa !== ob) return oa - ob;
  return a.node_id - b.node_id;
}

/** FNV-1a：稳定、无依赖、跨进程一致（`ip_hash` 需要「同一键永远同一节点」）。 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function pickByStrategy(
  eligible: readonly RouteNodeFacts[],
  strategy: string,
  input: CompileRouteProfileInput,
): RouteNodeFacts | null {
  if (eligible.length === 0) return null;
  switch (strategy) {
    // 「按确定性顺序取第一个合格候选」：failover / fallback 都是这个语义。
    case "failover":
    case "fallback":
      return eligible[0]!;
    case "round_robin": {
      const seed = Math.abs(Math.trunc(input.rotation_seed ?? 0));
      return eligible[seed % eligible.length]!;
    }
    case "random": {
      // **编译期**抽一次；结果随即被冻结进快照。运行期不重抽（§9.4.3）。
      const draw = input.random ?? Math.random;
      const raw = draw();
      const bounded = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999) : 0;
      return eligible[Math.floor(bounded * eligible.length)]!;
    }
    case "least_conn": {
      let best = eligible[0]!;
      for (const candidate of eligible) {
        if ((candidate.load ?? 0) < (best.load ?? 0)) best = candidate;
      }
      return best;
    }
    case "ip_hash": {
      const key = input.hash_key;
      if (key == null || key === "") return null; // 缺键 ⇒ 失败，不静默降级
      return eligible[fnv1a(key) % eligible.length]!;
    }
    default:
      return null; // 未知策略 fail-closed（解析层已经拦过一次）
  }
}

function resolveSelector(
  selector: RouteSelector,
  input: CompileRouteProfileInput,
  position: "ingress" | "egress",
): { ok: true; node_id: number } | CompileFailure {
  const template = input.template;
  const hopIndex = position === "ingress" ? 0 : null;
  if (selector.kind === "fixed_node") {
    const facts = input.candidates.find((c) => c.node_id === selector.node_id);
    if (!facts) {
      return {
        ok: false,
        code: "no_eligible_node",
        message: `${position} 指定的节点 ${selector.node_id} 不存在或不在候选事实里`,
        ...(hopIndex === null ? {} : { hop_index: hopIndex }),
      };
    }
    const rejection = candidateRejection(facts, template, position, null);
    if (rejection) {
      return {
        ok: false,
        code: "no_eligible_node",
        message: `${position} 指定的节点 ${nodeLabel(facts)} 不可用（${rejection}）`,
        ...(hopIndex === null ? {} : { hop_index: hopIndex }),
      };
    }
    return { ok: true, node_id: facts.node_id };
  }

  const candidates = input.candidates.filter((c) => c.node_group_id === selector.node_group_id);
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "no_eligible_node",
      message: `${position} 引用的节点组 ${selector.node_group_id} 不存在或没有任何节点`,
      ...(hopIndex === null ? {} : { hop_index: hopIndex }),
    };
  }
  const rejected: Array<{ node_id: number; reason: string }> = [];
  const eligible: RouteNodeFacts[] = [];
  for (const facts of candidates) {
    const reason = candidateRejection(facts, template, position, selector.node_group_id);
    if (reason) rejected.push({ node_id: facts.node_id, reason });
    else eligible.push(facts);
  }
  eligible.sort(deterministicOrder);
  if (eligible.length === 0) {
    const capabilityOnly = rejected.every((r) => r.reason.startsWith("capability_missing"));
    return {
      ok: false,
      code: capabilityOnly ? "capability_unavailable" : "no_eligible_node",
      message: `${position} 节点组 ${selector.node_group_id} 没有合格候选（策略 ${selector.strategy}）`,
      rejected,
      ...(hopIndex === null ? {} : { hop_index: hopIndex }),
    };
  }
  const picked = pickByStrategy(eligible, selector.strategy, input);
  if (!picked) {
    return {
      ok: false,
      code: "invalid_input",
      message: `${position} 的策略 ${selector.strategy} 缺少解析输入（ip_hash 需要 hash_key）`,
    };
  }
  return { ok: true, node_id: picked.node_id };
}

/**
 * 编译一条 Route Profile（模板 + 候选事实 → 具体节点 → 既有 RoutePlan）。
 *
 * 输出里的 `placement` 可以直接喂给 Forward 的创建/编辑路径（`ForwardPatchInput`
 * 的 ingress/egress/middle），`plan` / `steps` 来自既有的纯模型 —— 编译器不新增
 * 任何「第二种路由表示」。
 */
export function compileRouteProfile(input: CompileRouteProfileInput): CompileRouteProfileResult {
  const template = input.template;

  const ingress = resolveSelector(template.ingress, input, "ingress");
  if (!ingress.ok) return ingress;

  let middleNodeId: number | null = null;
  for (let i = 0; i < template.transit.length; i += 1) {
    const hopIndex = i + 1;
    const selector = template.transit[i]!;
    const facts = input.candidates.find((c) => c.node_id === selector.node_id);
    if (!facts) {
      return {
        ok: false,
        code: "no_eligible_node",
        message: `中间跳 ${selector.node_id} 不存在或不在候选事实里`,
        hop_index: hopIndex,
      };
    }
    const rejection = candidateRejection(facts, template, "transit", null);
    if (rejection) {
      return {
        ok: false,
        code: "no_eligible_node",
        message: `中间跳 ${nodeLabel(facts)} 不可用（${rejection}）`,
        hop_index: hopIndex,
      };
    }
    middleNodeId = facts.node_id;
  }

  let egressNodeId: number | null = null;
  if (template.egress) {
    const egress = resolveSelector(template.egress, input, "egress");
    if (!egress.ok) return egress;
    egressNodeId = egress.node_id;
    if (egressNodeId === ingress.node_id) {
      return {
        ok: false,
        code: "invalid_input",
        message: "出口 selector 解析到的节点与入口相同（请用 DIRECT 模板表达单机线路）",
      };
    }
  }

  const tunnelMode: "direct" | "relay" = template.egress ? "relay" : "direct";
  const placement: RoutePlacement = {
    ingress_node_id: ingress.node_id,
    egress_node_id: egressNodeId,
    middle_node_id: middleNodeId,
    tunnel_mode: tunnelMode,
    // 编译阶段不存在「本条路由的 revision」—— revision 属于 Forward。这里传 0 只作为
    // `buildRoutePlan` 的占位输入，调用方拿到 plan 后会用真实 revision 重新构建
    // （`RoutePlan.revision` 是整条路由唯一的 revision，不能由模板编造）。
    revision: 0,
  };

  const plan = buildRoutePlan(placement);
  if (plan === null) {
    return {
      ok: false,
      code: "route_invalid",
      message: "模板解析出的放置事实不合法（缺入口/出口，或中间跳与端点重合）",
    };
  }

  const requireBindings = (template.constraints?.require_node_binding ?? true) && plan.middle_node_id !== null;
  const boundPairs = input.boundPairs ?? new Set<string>();
  if (requireBindings) {
    for (let i = 0; i + 1 < plan.hops.length; i += 1) {
      const from = plan.hops[i]!;
      const to = plan.hops[i + 1]!;
      if (from.node_id === to.node_id) continue;
      if (!boundPairs.has(`${from.node_id}->${to.node_id}`)) {
        return {
          ok: false,
          code: "binding_missing",
          message: `相邻跳 ${from.node_id} -> ${to.node_id} 缺少 NodeBinding（多跳链路必须先有许可）`,
          hop_index: to.hop_index,
        };
      }
    }
  }

  const admission = admitRoute(placement, boundPairs, {
    multiHopImplemented: input.multi_hop_implemented ?? true,
  });
  if (!admission.ok) {
    return {
      ok: false,
      code: admission.code === "route_invalid" ? "route_invalid" : "route_not_dispatchable",
      message: admission.error,
      ...(admission.violation ? { violation: admission.violation } : {}),
    };
  }

  const resolvedHops: ResolvedHop[] = admission.plan.hops.map((hop) => ({
    hop_index: hop.hop_index,
    role: hop.role,
    node_id: hop.node_id,
  }));

  return {
    ok: true,
    tunnel_mode: tunnelMode,
    placement: { ...placement, revision: admission.plan.revision },
    plan: admission.plan,
    steps: routeSteps(admission.plan),
    provenance: {
      route_profile_id: input.route_profile_id,
      route_profile_version: input.route_profile_version,
      resolved_hops: resolvedHops,
      template_digest: templateDigest(template),
    },
  };
}

/* ================================================================== */
/* 4. 可见性判定（§9.4.6）                                             */
/* ================================================================== */

export interface VisibilitySubject {
  readonly workspace_id: number;
  /** 该用户所属 plan 列表（本版只用于 ASSIGNED 判定；计费真相不在本 WP）。 */
  readonly plan_ids?: readonly number[];
  /** 是否是管理面（该 workspace 拥有 manage 权限的人）。 */
  readonly is_manager?: boolean;
}

export interface VisibilityFacts {
  readonly visibility: string;
  readonly enabled: boolean;
  readonly workspace_id: number;
  readonly assignments: ReadonlyArray<{ target_type: string; target_id: number; active: boolean }>;
}

/**
 * 一个 subject 能不能**看见/选择**这条 Route Profile。
 *
 * 顺序固定且 fail-closed：`enabled` → 可见性 → ASSIGNED 命中。
 * 未知 visibility 一律 false（解析层已经拦过，这里是纵深防御）。
 * **管理面例外**：`is_manager` 可以看到本 workspace 的 INTERNAL 模板（编排是管理动作），
 * 但看不到别的 workspace 的（跨域由调用方的查询条件保证）。
 */
export function canConsumeRouteProfile(facts: VisibilityFacts, subject: VisibilitySubject): boolean {
  if (!facts.enabled) return false;
  if (facts.workspace_id !== subject.workspace_id) return false;
  const visibility = parseRouteProfileVisibility(facts.visibility);
  if (visibility === null) return false;
  if (visibility === "INTERNAL") return subject.is_manager === true;
  if (visibility === "PUBLIC") return true;
  // ASSIGNED：必须命中一条 active 授权行（workspace 或 plan）。
  return facts.assignments.some(
    (row) =>
      row.active &&
      ((row.target_type === "workspace" && row.target_id === subject.workspace_id) ||
        (row.target_type === "plan" && (subject.plan_ids ?? []).includes(row.target_id))),
  );
}
