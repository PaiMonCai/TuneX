/**
 * V5-WP13.5B Route Profile —— mock 契约镜像（线路模板的编排面与消费面）。
 *
 * **唯一真相在后端**：`backend/src/routes/route-profiles.ts` +
 * `backend/src/services/route-profile.ts` + `route-profile-compiler.ts`；
 * 契约文本 `docs/v5-wp13-5b-route-profile-contract.md`。
 *
 * 本文件把那三张错误码表（状态码 / 失败层 / 可重试 / 下一步）与模板解析规则
 * **逐字镜像**过来，`components/admin/__tests__/route-profile-contract.test.ts`
 * 会直接读后端源码比对 —— 后端改了而这里没跟上就会红。
 *
 * 四条与后端刻意保持一致的行为：
 *  1. **PATCH 只改 metadata**：带任何模板键 → 400 `invalid_input`（模板变更只能发新版本）；
 *  2. **发布新版本**受 `expected_version` 乐观闸门保护，冲突 → 409 `version_conflict`
 *     且 `data.latest_version` 给出真实版本（前端据此提示刷新）；
 *  3. **Impact Analysis 只读**：`read_only: true`，不写任何行、不触发下发；
 *     适用范围是「来源指针指向本模板的 Forward」，第一次 apply 之前为空是**正确答案**；
 *  4. **apply 必须显式给 forward_ids**（没有「应用到全部」的隐式形式），
 *     `expected_revisions` 不一致 → 该条 `rollout_conflict` 而不是静默覆盖。
 */
import {
  ROUTE_PROFILE_ERROR_CODES,
  type RouteProfileErrorCode,
  type RouteProfileErrorLayer,
  type RouteProfileTemplate,
  type ResolvedHop,
  type RouteSelector,
} from "@/lib/types";

/* ------------------------------------------------------------------ */
/* 错误模型镜像（§13：状态码 / 层 / 可重试 / 下一步）                    */
/* ------------------------------------------------------------------ */

export { ROUTE_PROFILE_ERROR_CODES };
export type { RouteProfileErrorCode };

/** 镜像 `services/route-profile.ts` 的 `ROUTE_PROFILE_ERROR_STATUS`。 */
export const ROUTE_PROFILE_ERROR_STATUS: Record<string, number> = {
  invalid_input: 400,
  unsupported_topology: 422,
  profile_not_found: 404,
  forbidden: 403,
  profile_not_visible: 403,
  profile_disabled: 409,
  version_conflict: 409,
  profile_in_use: 409,
  no_eligible_node: 409,
  capability_unavailable: 409,
  binding_missing: 409,
  route_invalid: 409,
  rollout_conflict: 409,
  db_unavailable: 503,
};

/** 镜像 `ROUTE_PROFILE_ERROR_LAYER`。 */
export const ROUTE_PROFILE_ERROR_LAYER: Record<string, string> = {
  invalid_input: "resource_scope",
  unsupported_topology: "capability",
  profile_not_found: "resource_scope",
  forbidden: "rbac",
  profile_not_visible: "capability",
  profile_disabled: "capability",
  version_conflict: "resource_scope",
  profile_in_use: "resource_scope",
  no_eligible_node: "runtime_admission",
  capability_unavailable: "capability",
  binding_missing: "runtime_admission",
  route_invalid: "runtime_admission",
  rollout_conflict: "runtime_admission",
  db_unavailable: "data_plane",
};

/** 镜像 `ROUTE_PROFILE_ERROR_RETRYABLE`。 */
export const ROUTE_PROFILE_ERROR_RETRYABLE: Record<string, boolean> = {
  invalid_input: false,
  unsupported_topology: false,
  profile_not_found: false,
  forbidden: false,
  profile_not_visible: false,
  profile_disabled: false,
  version_conflict: true,
  profile_in_use: false,
  no_eligible_node: true,
  capability_unavailable: false,
  binding_missing: false,
  route_invalid: false,
  rollout_conflict: true,
  db_unavailable: true,
};

/** 镜像 `ROUTE_PROFILE_ERROR_NEXT_ACTION`（前端直接展示这句，不自己编）。 */
export const ROUTE_PROFILE_ERROR_NEXT_ACTION: Record<string, string> = {
  invalid_input: "修正请求内容后重试",
  unsupported_topology: "把中间跳改为固定的具体节点（动态中间池未开放）",
  profile_not_found: "刷新列表后重试",
  forbidden: "向工作空间管理员申请相应角色",
  profile_not_visible: "向管理员申请该线路的授权（ASSIGNED）",
  profile_disabled: "先启用该线路模板",
  version_conflict: "读取最新版本后重新发布",
  profile_in_use: "先解除引用该模板的 Forward",
  no_eligible_node: "修复节点状态/生命周期，或调整模板约束",
  capability_unavailable: "改用具备所需能力的节点，或降低能力要求",
  binding_missing: "先建立相邻节点绑定（由 rollout PREPARE 或管理面创建）",
  route_invalid: "修正模板解析出的跳拓扑",
  rollout_conflict: "等待该 Forward 正在进行的更新结束后重试",
  db_unavailable: "稍后重试",
};

/** 与后端 `send()` 的失败体同形状（注意人读原因是 `error`，没有 `message`）。 */
export function routeProfileErrorBody(
  code: RouteProfileErrorCode | string,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  return {
    error: message,
    code,
    error_layer: ROUTE_PROFILE_ERROR_LAYER[code] ?? "resource_scope",
    retryable: ROUTE_PROFILE_ERROR_RETRYABLE[code] ?? false,
    next_action: ROUTE_PROFILE_ERROR_NEXT_ACTION[code] ?? "稍后重试",
    ...(data === undefined ? {} : { data }),
  };
}

export function routeProfileErrorStatus(code: string): number {
  return ROUTE_PROFILE_ERROR_STATUS[code] ?? 500;
}

/* ------------------------------------------------------------------ */
/* mock 状态                                                           */
/* ------------------------------------------------------------------ */

export interface MockRouteProfileVersionRow {
  version: number;
  change_summary: string | null;
  created_by_id: number | null;
  created_at: string;
}

export interface MockRouteProfileRow {
  id: number;
  workspace_id: number;
  name: string;
  description: string | null;
  visibility: string;
  enabled: boolean;
  version: number;
  template: RouteProfileTemplate;
  /** 与后端 `templateDigest()` 同用途：内容指纹（mock 用确定性哈希模拟）。 */
  template_digest: string;
  published_at: string;
  created_at: string;
  updated_at: string;
  assignments: Array<{ target_type: string; target_id: number; active: boolean }>;
  versions: MockRouteProfileVersionRow[];
}

/** 「来源指针指向本模板」的 Forward（impact 的唯一范围口径）。 */
export interface MockReferencingForward {
  forward_id: number;
  name: string;
  tunnel_mode: string;
  current_revision: number;
  applied_revision: number | null;
  apply_status: string | null;
  source_version: number | null;
  current_hops: ResolvedHop[];
}

export interface MockRouteProfileState {
  profiles: MockRouteProfileRow[];
  referencing: Map<number, MockReferencingForward[]>;
  /** 存在的节点组（模板引用不存在的组 → 解析失败，用来演示 no_eligible_node）。 */
  node_group_ids: number[];
  /** 存在的节点（fixed_node selector 的合法性域）。 */
  node_ids: number[];
}

const MAX_ROUTE_HOPS = 3;

/* ------------------------------------------------------------------ */
/* 模板解析（镜像 parseRouteProfileTemplate）                           */
/* ------------------------------------------------------------------ */

const TEMPLATE_KEYS = new Set([
  "ingress",
  "transit",
  "egress",
  "ingress_policy",
  "egress_policy",
  "constraints",
  "required_capabilities",
]);
const CONSTRAINT_KEYS = new Set(["exclude_node_ids", "allowed_lifecycles", "require_health", "require_node_binding"]);

/**
 * PATCH 拒绝的键（镜像后端 `TEMPLATE_BODY_KEYS`）。
 *
 * 注意它比模板键多一个 `"template"` 本身：整体替换模板与逐个替换模板键**都是**
 * 模板内容变更，两条路都必须堵死（否则「PATCH 只能改 metadata」就有后门）。
 */
const TEMPLATE_BODY_KEYS = new Set([...TEMPLATE_KEYS, "template"]);

type ParseResult = { ok: true; template: RouteProfileTemplate } | { ok: false; code: "invalid_input" | "unsupported_topology"; message: string };

const bad = (message: string, code: "invalid_input" | "unsupported_topology" = "invalid_input"): ParseResult => ({
  ok: false,
  code,
  message,
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSelector(raw: unknown, field: string): { ok: true; selector: RouteSelector } | { ok: false; code: "invalid_input"; message: string } {
  if (!isPlainObject(raw)) return { ok: false, code: "invalid_input", message: `${field} 必须是对象` };
  const kind = raw.kind;
  if (kind === "fixed_node") {
    if (!Number.isInteger(raw.node_id) || (raw.node_id as number) <= 0) {
      return { ok: false, code: "invalid_input", message: `${field}.node_id 必须是正整数` };
    }
    return { ok: true, selector: { kind: "fixed_node", node_id: raw.node_id as number } };
  }
  if (kind === "node_group") {
    if (!Number.isInteger(raw.node_group_id) || (raw.node_group_id as number) <= 0) {
      return { ok: false, code: "invalid_input", message: `${field}.node_group_id 必须是正整数` };
    }
    if (typeof raw.strategy !== "string" || raw.strategy.trim() === "") {
      return { ok: false, code: "invalid_input", message: `${field}.strategy 必须是非空字符串` };
    }
    return { ok: true, selector: { kind: "node_group", node_group_id: raw.node_group_id as number, strategy: raw.strategy } };
  }
  return { ok: false, code: "invalid_input", message: `${field}.kind 只能是 fixed_node 或 node_group` };
}

/** 与后端 `parseRouteProfileTemplate` 同规则的解析（fail-closed）。 */
export function parseMockRouteProfileTemplate(raw: unknown): ParseResult {
  if (!isPlainObject(raw)) return bad("模板必须是对象");
  for (const key of Object.keys(raw)) {
    if (!TEMPLATE_KEYS.has(key)) return bad(`模板含未知键：${key}`);
  }
  const ingress = parseSelector(raw.ingress, "ingress");
  if (!ingress.ok) return bad(ingress.message);

  const transit: Array<{ kind: "fixed_node"; node_id: number }> = [];
  if (raw.transit !== undefined && raw.transit !== null) {
    if (!Array.isArray(raw.transit)) return bad("transit 必须是数组（有序）");
    const maxMiddle = MAX_ROUTE_HOPS - 2;
    if (raw.transit.length > maxMiddle) {
      return bad(`transit 最多 ${maxMiddle} 个中间跳（整条路由最多 ${MAX_ROUTE_HOPS} 跳）`, "unsupported_topology");
    }
    const seen = new Set<number>();
    for (let i = 0; i < raw.transit.length; i += 1) {
      const element = raw.transit[i];
      if (element === null || element === undefined) return bad(`transit[${i}] 声明了一个跳位但没有具体节点（缺具体 selector）`);
      const parsed = parseSelector(element, "transit");
      if (!parsed.ok) return bad(parsed.message);
      if (parsed.selector.kind !== "fixed_node") return bad(`transit[${i}] 只能是 fixed_node`, "unsupported_topology");
      if (seen.has(parsed.selector.node_id)) return bad(`transit[${i}] 与前面的中间跳重复（同一节点不能占两个跳位）`);
      seen.add(parsed.selector.node_id);
      transit.push(parsed.selector);
    }
  }

  let egress: RouteSelector | null = null;
  if (raw.egress !== undefined && raw.egress !== null) {
    const parsed = parseSelector(raw.egress, "egress");
    if (!parsed.ok) return bad(parsed.message);
    egress = parsed.selector;
  }

  for (const [key, field] of [
    [raw.ingress_policy, "ingress_policy"],
    [raw.egress_policy, "egress_policy"],
  ] as const) {
    if (key !== undefined && key !== null && !isPlainObject(key)) return bad(`${field} 必须是对象`);
  }

  let constraints: RouteProfileTemplate["constraints"] = null;
  if (raw.constraints !== undefined && raw.constraints !== null) {
    if (!isPlainObject(raw.constraints)) return bad("constraints 必须是对象");
    for (const key of Object.keys(raw.constraints)) {
      if (!CONSTRAINT_KEYS.has(key)) return bad(`constraints 含未知键：${key}`);
    }
    constraints = raw.constraints as RouteProfileTemplate["constraints"];
  }

  let capabilities: string[] | null = null;
  if (raw.required_capabilities !== undefined && raw.required_capabilities !== null) {
    if (!Array.isArray(raw.required_capabilities)) return bad("required_capabilities 必须是字符串数组");
    capabilities = [];
    for (const cap of raw.required_capabilities) {
      if (typeof cap !== "string" || cap.trim() === "") return bad("required_capabilities 必须是非空字符串数组");
      if (!capabilities.includes(cap)) capabilities.push(cap);
    }
  }

  return {
    ok: true,
    template: {
      ingress: ingress.selector,
      transit,
      egress,
      ingress_policy: (raw.ingress_policy as Record<string, unknown> | undefined) ?? null,
      egress_policy: (raw.egress_policy as Record<string, unknown> | undefined) ?? null,
      constraints,
      required_capabilities: capabilities,
    },
  };
}

/** 内容指纹（mock 里是确定性哈希，与后端 sha256 同用途：标识「内容是否变过」）。 */
export function mockTemplateDigest(template: RouteProfileTemplate): string {
  const text = JSON.stringify(template);
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return `mock${h.toString(16).padStart(8, "0")}`;
}

export function mockRouteProfileView(row: MockRouteProfileRow): Record<string, unknown> {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    enabled: row.enabled,
    version: row.version,
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    template: row.template,
    template_digest: row.template_digest,
    assignments: row.assignments,
  };
}

/* ------------------------------------------------------------------ */
/* 种子                                                                */
/* ------------------------------------------------------------------ */

const T0 = Date.now();
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const fixed = (node_id: number) => ({ kind: "fixed_node" as const, node_id });

/**
 * 三条款路模板 + 一条被引用中的模板。
 *
 * 演示覆盖：
 *  - #1 PUBLIC + 被 2 条 Forward 引用（impact 有内容、能演示 change 与 revision 闸门）；
 *  - #2 ASSIGNED（授权给 workspace 2）→ 非管理员消费者看不到；
 *  - #3 INTERNAL → 只有管理面可见；
 *  - #4 PUBLIC 但 `enabled: false` → 消费者看不到（fail-closed），管理面可见且标停用。
 */
export function buildMockRouteProfiles(): MockRouteProfileState {
  const profiles: MockRouteProfileRow[] = [
    {
      id: 1,
      workspace_id: 1,
      name: "HK → SG → JP（三跳加速）",
      description: "香港入口 / 新加坡中转 / 日本出口，日本出口按最少连接挑选。",
      visibility: "PUBLIC",
      enabled: true,
      version: 3,
      template: {
        ingress: { kind: "node_group", node_group_id: 2, strategy: "failover" },
        transit: [fixed(4)],
        egress: { kind: "node_group", node_group_id: 3, strategy: "least_conn" },
        ingress_policy: null,
        egress_policy: null,
        constraints: { require_health: ["healthy"], allowed_lifecycles: ["active"] },
        required_capabilities: ["relay"],
      },
      template_digest: "mock00000001",
      published_at: at(-60 * 24 * 5),
      created_at: at(-60 * 24 * 30),
      updated_at: at(-60 * 24 * 5),
      assignments: [],
      versions: [
        { version: 3, change_summary: "出口改为 least_conn", created_by_id: 1, created_at: at(-60 * 24 * 5) },
        { version: 2, change_summary: "中转改为 SG-01 固定跳", created_by_id: 1, created_at: at(-60 * 24 * 12) },
        { version: 1, change_summary: "初始版本", created_by_id: 1, created_at: at(-60 * 24 * 30) },
      ],
    },
    {
      id: 2,
      workspace_id: 1,
      name: "HK → TW 直连（团队专用）",
      description: "仅授权给运营团队（workspace 2）的线路。",
      visibility: "ASSIGNED",
      enabled: true,
      version: 2,
      template: {
        ingress: fixed(1),
        transit: [],
        egress: fixed(6),
        ingress_policy: null,
        egress_policy: null,
        constraints: { allowed_lifecycles: ["active", "maintenance"] },
        required_capabilities: null,
      },
      template_digest: "mock00000002",
      published_at: at(-60 * 24 * 2),
      created_at: at(-60 * 24 * 20),
      updated_at: at(-60 * 24 * 2),
      assignments: [{ target_type: "workspace", target_id: 2, active: true }],
      versions: [
        { version: 2, change_summary: "允许维护中的节点参与（计划内换机）", created_by_id: 1, created_at: at(-60 * 24 * 2) },
        { version: 1, change_summary: "初始版本", created_by_id: 1, created_at: at(-60 * 24 * 20) },
      ],
    },
    {
      id: 3,
      workspace_id: 1,
      name: "内部：实验线路（仅管理面）",
      description: "管理面内部验证用，不对普通消费者开放。",
      visibility: "INTERNAL",
      enabled: true,
      version: 1,
      template: {
        ingress: fixed(1),
        transit: [],
        egress: null,
        ingress_policy: null,
        egress_policy: null,
        constraints: null,
        required_capabilities: null,
      },
      template_digest: "mock00000003",
      published_at: at(-60 * 24 * 9),
      created_at: at(-60 * 24 * 9),
      updated_at: at(-60 * 24 * 9),
      assignments: [],
      versions: [{ version: 1, change_summary: "初始版本", created_by_id: 1, created_at: at(-60 * 24 * 9) }],
    },
    {
      id: 4,
      workspace_id: 1,
      name: "已停用：旧的三跳线路",
      description: "下线中的线路，enabled=false，不再对消费者可见。",
      visibility: "PUBLIC",
      enabled: false,
      version: 5,
      template: {
        ingress: fixed(1),
        transit: [fixed(4)],
        egress: fixed(5),
        ingress_policy: null,
        egress_policy: null,
        constraints: null,
        required_capabilities: null,
      },
      template_digest: "mock00000004",
      published_at: at(-60 * 24 * 40),
      created_at: at(-60 * 24 * 60),
      updated_at: at(-60 * 24 * 40),
      assignments: [],
      versions: [{ version: 5, change_summary: "停用前的最后一次发布", created_by_id: 1, created_at: at(-60 * 24 * 40) }],
    },
  ];

  const referencing = new Map<number, MockReferencingForward[]>();
  referencing.set(1, [
    {
      forward_id: 101,
      name: "hk-web-01",
      tunnel_mode: "relay",
      current_revision: 7,
      applied_revision: 7,
      apply_status: "active",
      source_version: 2,
      current_hops: [
        { hop_index: 0, role: "ingress", node_id: 2 },
        { hop_index: 1, role: "middle", node_id: 4 },
        { hop_index: 2, role: "egress", node_id: 5 },
      ],
    },
    {
      forward_id: 102,
      name: "hk-api-02",
      tunnel_mode: "relay",
      current_revision: 4,
      applied_revision: 3,
      apply_status: "applying",
      source_version: 3,
      current_hops: [
        { hop_index: 0, role: "ingress", node_id: 2 },
        { hop_index: 1, role: "middle", node_id: 4 },
        { hop_index: 2, role: "egress", node_id: 5 },
      ],
    },
  ]);
  referencing.set(2, []);

  return { profiles, referencing, node_group_ids: [2, 3, 4], node_ids: [1, 2, 4, 5, 6] };
}

/* ------------------------------------------------------------------ */
/* 路由实现                                                            */
/* ------------------------------------------------------------------ */

export interface RouteProfileMockResponse {
  status: number;
  body: unknown;
}

export interface RouteProfileMockContext {
  /** 当前会话用户（审计归属；mock 不建真实审计行） */
  userId: number;
  /** 当前 workspace 作用域（由 handler 解出） */
  workspaceId: number;
  /** 该用户在作用域内是否有 `node:manage`（决定能否看到 INTERNAL） */
  isManager: boolean;
}

export interface RouteProfileMockRequest {
  method: string;
  /** 去掉 `route-profiles` 之后的路径段，例如 `["1","versions"]` */
  seg: string[];
  query?: Record<string, unknown>;
  body?: unknown;
  state: MockRouteProfileState;
  ctx: RouteProfileMockContext;
  now?: () => Date;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
function reqStr(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}
function parseId(seg: string | undefined): number | null {
  if (seg === undefined) return null;
  const n = Number(seg);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 模板是否能在「本机事实」上解析出具体跳（impact 的 resolves 口径）。 */
function resolveTemplate(
  state: MockRouteProfileState,
  template: RouteProfileTemplate,
): { ok: true; hops: ResolvedHop[] } | { ok: false; code: RouteProfileErrorCode; message: string } {
  const hopNode = (selector: RouteSelector | null): number | { code: RouteProfileErrorCode; message: string } => {
    if (selector === null) return { code: "route_invalid", message: "缺少出口 selector" };
    if (selector.kind === "fixed_node") {
      if (!state.node_ids.includes(selector.node_id)) {
        return { code: "route_invalid", message: `节点 ${selector.node_id} 不存在` };
      }
      return selector.node_id;
    }
    if (!state.node_group_ids.includes(selector.node_group_id)) {
      return { code: "no_eligible_node", message: `节点组 ${selector.node_group_id} 没有可用节点` };
    }
    // mock 里用一个稳定的「组内代表节点」代替真实候选解析
    return 100 + selector.node_group_id;
  };

  const ingress = hopNode(template.ingress);
  if (typeof ingress !== "number") return { ok: false, ...ingress };
  const hops: ResolvedHop[] = [{ hop_index: 0, role: "ingress", node_id: ingress }];
  template.transit.forEach((t, i) => {
    hops.push({ hop_index: i + 1, role: "middle", node_id: t.node_id });
  });
  if (template.egress === null) {
    // DIRECT：出口就是 ingress 那一跳
    hops.push({ hop_index: hops.length, role: "egress", node_id: ingress });
    return { ok: true, hops };
  }
  const egress = hopNode(template.egress);
  if (typeof egress !== "number") return { ok: false, ...egress };
  hops.push({ hop_index: hops.length, role: "egress", node_id: egress });
  return { ok: true, hops };
}

/** 处理一条 `/api/route-profiles/*` 请求；`null` = 不属于本模块。 */
export function handleRouteProfileMock(req: RouteProfileMockRequest): RouteProfileMockResponse | null {
  const { method, seg, state, ctx } = req;
  const now = req.now ?? (() => new Date());
  const nowIso = () => now().toISOString();
  const query = req.query ?? {};

  const ok = (body: unknown, status = 200): RouteProfileMockResponse => ({ status, body });
  const failWith = (
    code: RouteProfileErrorCode,
    message: string,
    opts: { status?: number; data?: unknown } = {},
  ): RouteProfileMockResponse => ({
    status: opts.status ?? routeProfileErrorStatus(code),
    body: routeProfileErrorBody(code, message, opts.data),
  });

  const findInScope = (id: number) => state.profiles.find((p) => p.id === id && p.workspace_id === ctx.workspaceId);

  /** 列表 / 详情只暴露本 workspace 的行；跨 workspace 一律 404（不泄露存在性）。 */
  const sub = seg[0];

  if (sub === undefined) {
    if (method === "GET") {
      const keyword = reqStr(query.keyword).toLowerCase();
      const visibility = reqStr(query.visibility);
      const enabledParam = query.enabled;
      let rows = state.profiles.filter((p) => p.workspace_id === ctx.workspaceId);
      if (keyword) rows = rows.filter((p) => p.name.toLowerCase().includes(keyword));
      if (visibility) rows = rows.filter((p) => p.visibility === visibility);
      if (enabledParam === "true" || enabledParam === true) rows = rows.filter((p) => p.enabled);
      if (enabledParam === "false" || enabledParam === false) rows = rows.filter((p) => !p.enabled);
      const page = Math.max(1, Math.trunc(Number(query.page ?? 1) || 1));
      const pageSize = Math.min(200, Math.max(1, Math.trunc(Number(query.page_size ?? 20) || 20)));
      const start = (page - 1) * pageSize;
      return ok({
        data: rows.slice(start, start + pageSize).map(mockRouteProfileView),
        total: rows.length,
        page,
        page_size: pageSize,
      });
    }
    if (method === "POST") {
      const payload = asRecord(req.body);
      const name = reqStr(payload.name);
      if (name.length === 0 || name.length > 120) return failWith("invalid_input", "名称必须是 1–120 个字符");
      const visibility = payload.visibility === undefined || payload.visibility === null ? "INTERNAL" : reqStr(payload.visibility);
      if (!["INTERNAL", "ASSIGNED", "PUBLIC"].includes(visibility)) {
        return failWith("invalid_input", "visibility 只能是 INTERNAL / ASSIGNED / PUBLIC");
      }
      if (payload.enabled !== undefined && typeof payload.enabled !== "boolean") {
        return failWith("invalid_input", "enabled 必须是布尔值");
      }
      const parsed = parseMockRouteProfileTemplate(payload.template);
      if (!parsed.ok) return failWith(parsed.code, parsed.message);
      const id = state.profiles.reduce((m, p) => Math.max(m, p.id), 0) + 1;
      const row: MockRouteProfileRow = {
        id,
        workspace_id: ctx.workspaceId,
        name,
        description: reqStr(payload.description) || null,
        visibility,
        enabled: payload.enabled === undefined ? true : payload.enabled === true,
        version: 1,
        template: parsed.template,
        template_digest: mockTemplateDigest(parsed.template),
        published_at: nowIso(),
        created_at: nowIso(),
        updated_at: nowIso(),
        assignments: Array.isArray(payload.assignments)
          ? (payload.assignments as Array<Record<string, unknown>>).map((a) => ({
              target_type: reqStr(a.target_type),
              target_id: Number(a.target_id),
              active: a.active === undefined ? true : a.active === true,
            }))
          : [],
        versions: [
          {
            version: 1,
            change_summary: reqStr(payload.change_summary) || null,
            created_by_id: ctx.userId,
            created_at: nowIso(),
          },
        ],
      };
      state.profiles.push(row);
      return ok({ ...mockRouteProfileView(row), version_id: 1 }, 201);
    }
  }

  /** 消费侧可用线路（**只读**；fail-closed：没有授权就看不到）。 */
  if (sub === "available" && method === "GET") {
    const out = state.profiles
      .filter((p) => p.workspace_id === ctx.workspaceId && p.enabled)
      .filter((p) => {
        if (p.visibility === "PUBLIC") return true;
        if (p.visibility === "INTERNAL") return ctx.isManager;
        return p.assignments.some((a) => a.active && a.target_type === "workspace" && a.target_id === ctx.workspaceId);
      })
      .map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        visibility: p.visibility,
        version: p.version,
        template: p.template,
        selectable: true,
      }));
    return ok({ data: out, total: out.length, user_id: ctx.userId });
  }

  const id = parseId(sub);
  if (id !== null) {
    const row = findInScope(id);
    if (!row) return failWith("profile_not_found", "线路模板不存在", { status: 404 });

    // 详情
    if (method === "GET" && seg[1] === undefined) {
      return ok({
        ...mockRouteProfileView(row),
        // 与后端详情端点的 select 一致：只给 version / created_at / change_summary
        versions: [...row.versions]
          .sort((a, b) => b.version - a.version)
          .slice(0, 50)
          .map((v) => ({ version: v.version, created_at: v.created_at, change_summary: v.change_summary })),
        used_by_forwards: (state.referencing.get(row.id) ?? []).length,
      });
    }

    // metadata 编辑（模板键一律拒绝）
    if (method === "PATCH" && seg[1] === undefined) {
      const payload = asRecord(req.body);
      for (const key of TEMPLATE_BODY_KEYS) {
        if (key in payload && payload[key] !== undefined) {
          return failWith(
            "invalid_input",
            `PATCH 只能修改 metadata；模板内容变更必须发布新版本（POST /api/route-profiles/${row.id}/versions）`,
          );
        }
      }
      if (payload.expected_version !== undefined && payload.expected_version !== null) {
        if (Number(payload.expected_version) !== row.version) {
          return failWith("version_conflict", "该线路模板已被他人修改，请刷新后重试", {
            data: { latest_version: row.version },
          });
        }
      }
      if (payload.name !== undefined) {
        const name = reqStr(payload.name);
        if (name.length === 0 || name.length > 120) return failWith("invalid_input", "名称必须是 1–120 个字符");
        row.name = name;
      }
      if (payload.description !== undefined) row.description = reqStr(payload.description) || null;
      if (payload.visibility !== undefined) {
        const visibility = reqStr(payload.visibility);
        if (!["INTERNAL", "ASSIGNED", "PUBLIC"].includes(visibility)) {
          return failWith("invalid_input", "visibility 只能是 INTERNAL / ASSIGNED / PUBLIC");
        }
        row.visibility = visibility;
      }
      if (payload.enabled !== undefined) {
        if (typeof payload.enabled !== "boolean") return failWith("invalid_input", "enabled 必须是布尔值");
        row.enabled = payload.enabled;
      }
      if (payload.assignments !== undefined) {
        row.assignments = Array.isArray(payload.assignments)
          ? (payload.assignments as Array<Record<string, unknown>>).map((a) => ({
              target_type: reqStr(a.target_type),
              target_id: Number(a.target_id),
              active: a.active === undefined ? true : a.active === true,
            }))
          : [];
      }
      row.updated_at = nowIso();
      return ok(mockRouteProfileView(row));
    }

    // 版本：发布 / 列表 / 取某版
    if (seg[1] === "versions") {
      if (method === "POST" && seg[2] === undefined) {
        const payload = asRecord(req.body);
        const parsed = parseMockRouteProfileTemplate(payload.template);
        if (!parsed.ok) return failWith(parsed.code, parsed.message);
        if (payload.expected_version !== undefined && payload.expected_version !== null) {
          if (Number(payload.expected_version) !== row.version) {
            return failWith("version_conflict", "该线路模板已被他人修改，请刷新后重试", {
              data: { latest_version: row.version },
            });
          }
        }
        row.version += 1;
        row.template = parsed.template;
        row.template_digest = mockTemplateDigest(parsed.template);
        row.published_at = nowIso();
        row.updated_at = nowIso();
        const versionRow = {
          version: row.version,
          change_summary: reqStr(payload.change_summary) || null,
          created_by_id: ctx.userId,
          created_at: nowIso(),
        };
        row.versions.push(versionRow);
        return ok({ profile: mockRouteProfileView(row), version: row.version, version_id: row.version, template_digest: row.template_digest }, 201);
      }
      if (method === "GET" && seg[2] === undefined) {
        const limit = Math.max(1, Math.min(200, Math.trunc(Number(query.limit ?? 50) || 50)));
        return ok(
          [...row.versions]
            .sort((a, b) => b.version - a.version)
            .slice(0, limit)
            .map((v) => ({
              version: v.version,
              change_summary: v.change_summary,
              created_by_id: v.created_by_id,
              created_at: v.created_at,
            })),
        );
      }
      const version = Number(seg[2]);
      if (method === "GET" && Number.isInteger(version) && version >= 1) {
        const found = row.versions.find((v) => v.version === version);
        if (!found) return failWith("profile_not_found", "该版本不存在", { status: 404 });
        return ok({
          route_profile_id: row.id,
          version,
          body: { version, template: version === row.version ? row.template : undefined, change_summary: found.change_summary },
          template: version === row.version ? row.template : row.template,
        });
      }
    }

    // Impact Analysis（**只读**：不改任何状态）
    if (seg[1] === "impact" && method === "GET") {
      const versionParam = query.version;
      const version = versionParam === undefined || versionParam === "" ? row.version : Number(versionParam);
      if (!Number.isInteger(version) || version < 1) return failWith("invalid_input", "version 必须是正整数");
      const referencing = state.referencing.get(row.id) ?? [];
      const affected = referencing.map((f) => {
        const resolved = resolveTemplate(state, row.template);
        const change = resolved.ok
          ? (() => {
              const ingressSame = resolved.hops[0].node_id === (f.current_hops[0]?.node_id ?? -1);
              const egressSame =
                resolved.hops[resolved.hops.length - 1].node_id ===
                (f.current_hops[f.current_hops.length - 1]?.node_id ?? -1);
              const middleSame =
                resolved.hops.slice(1, -1).map((h) => h.node_id).join(",") ===
                f.current_hops.slice(1, -1).map((h) => h.node_id).join(",");
              return {
                ingress_change: !ingressSame,
                egress_change: !egressSame,
                middle_change: !middleSame,
                noop: ingressSame && egressSame && middleSame,
              };
            })()
          : null;
        return {
          forward_id: f.forward_id,
          name: f.name,
          tunnel_mode: f.tunnel_mode,
          current_revision: f.current_revision,
          applied_revision: f.applied_revision,
          apply_status: f.apply_status,
          source_version: f.source_version,
          current_hops: f.current_hops,
          resolves: resolved.ok,
          resolved_hops: resolved.ok ? resolved.hops : null,
          change,
          ...(resolved.ok ? {} : { error: { code: resolved.code, message: resolved.message, error_layer: ROUTE_PROFILE_ERROR_LAYER[resolved.code] } }),
        };
      });
      return ok({
        profile_id: row.id,
        version,
        read_only: true,
        scope: "referencing_forwards",
        affected,
        total: affected.length,
        changing: affected.filter((a) => a.change && !a.change.noop).length,
      });
    }

    // apply（显式 rollout）
    if (seg[1] === "apply" && method === "POST") {
      const payload = asRecord(req.body);
      const version = Number(payload.version);
      if (!Number.isInteger(version) || version < 1) return failWith("invalid_input", "version 必须是正整数");
      if (!Array.isArray(payload.forward_ids) || payload.forward_ids.length === 0) {
        return failWith("invalid_input", "forward_ids 必须显式给出（至少一个），没有「应用到全部」的隐式形式");
      }
      const dryRun = payload.dry_run === true;
      const expected = new Map<number, number>();
      if (Array.isArray(payload.expected_revisions)) {
        for (const entry of payload.expected_revisions as Array<Record<string, unknown>>) {
          expected.set(Number(entry.forward_id), Number(entry.revision));
        }
      }
      const referencing = state.referencing.get(row.id) ?? [];
      const outcomes = (payload.forward_ids as unknown[]).map((rawId) => {
        const forwardId = Number(rawId);
        const found = referencing.find((f) => f.forward_id === forwardId);
        if (!found) {
          return {
            forward_id: forwardId,
            status: "failed" as const,
            error: routeProfileErrorBody("profile_not_found", `Forward ${forwardId} 不存在或不属于本 workspace`),
          };
        }
        if (expected.has(forwardId) && expected.get(forwardId) !== found.current_revision) {
          return {
            forward_id: forwardId,
            name: found.name,
            status: "failed" as const,
            error: routeProfileErrorBody(
              "rollout_conflict",
              `Forward ${forwardId} 的 revision 已变化（期望 ${expected.get(forwardId)}，当前 ${found.current_revision}）`,
            ),
          };
        }
        const resolved = resolveTemplate(state, row.template);
        if (!resolved.ok) {
          return {
            forward_id: forwardId,
            name: found.name,
            status: "failed" as const,
            error: routeProfileErrorBody(resolved.code, resolved.message),
          };
        }
        if (!dryRun) {
          found.current_revision += 1;
          found.source_version = version;
          found.current_hops = resolved.hops;
        }
        return {
          forward_id: forwardId,
          name: found.name,
          revision: dryRun ? found.current_revision : found.current_revision,
          runtime_changed: true,
          resolved_hops: resolved.hops,
          status: dryRun ? ("previewed" as const) : ("applied" as const),
        };
      });
      return ok({
        profile_id: row.id,
        version,
        dry_run: dryRun,
        outcomes,
        applied_count: outcomes.filter((o) => o.status === "applied").length,
        failed_count: outcomes.filter((o) => o.status === "failed").length,
      });
    }
  }

  return null;
}
