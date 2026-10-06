/** Domain types extracted from the legacy flat types.ts facade. */
import type { User } from "./base";
/* ================================================================== */
/* V5-WP13.5B Route Profile —— 线路模板（Admin 编排 / User 消费）        */
/*                                                                    */
/* 字段与形状逐一对齐 backend/src/routes/route-profiles.ts 与            */
/* services/route-profile.ts（唯一真相）；契约：                         */
/* docs/v5-wp13-5b-route-profile-contract.md。                          */
/* ================================================================== */

/**
 * 错误码闭集（契约 §8 = `ROUTE_PROFILE_ERROR_CODES`）。
 *
 * 全量罗列而非 `string`：每个码在前端都有一处展示归类，后端加码而这里没跟上时，
 * 穷尽表会**编译失败**，而不是把新错误静默渲染成通用 ERROR。
 */
export const ROUTE_PROFILE_ERROR_CODES = [
  "invalid_input",
  "unsupported_topology",
  "profile_not_found",
  "forbidden",
  "profile_not_visible",
  "profile_disabled",
  "version_conflict",
  "profile_in_use",
  "no_eligible_node",
  "capability_unavailable",
  "binding_missing",
  "route_invalid",
  "rollout_conflict",
  "db_unavailable",
] as const;

export type RouteProfileErrorCode = (typeof ROUTE_PROFILE_ERROR_CODES)[number];

/** 失败发生在哪一层（§13 的六层模型；后端 `error_layer`）。 */
export type RouteProfileErrorLayer =
  | "rbac"
  | "resource_scope"
  | "capability"
  | "runtime_admission"
  | "data_plane";

/**
 * 线路模板错误体（路由层 `send()` 的失败形状）。
 *
 * 注意人读原因是 **`error`** 而不是 `message`（与联邦错误体不同），
 * `next_action` 由后端给出、前端直接展示（不自己编「下一步」）。
 * 路由层的 `invalid_input`（例如 id 非法）只有 `error` + `code`，其余字段可能缺失。
 */
export interface RouteProfileErrorBody {
  error: string;
  code: RouteProfileErrorCode | string;
  error_layer?: RouteProfileErrorLayer | string;
  retryable?: boolean;
  next_action?: string;
  data?: unknown;
}

/** 可见性三类（字符串列 + 应用层校验；未知值 fail-closed）。 */
export const ROUTE_PROFILE_VISIBILITIES = ["INTERNAL", "ASSIGNED", "PUBLIC"] as const;
export type RouteProfileVisibility = (typeof ROUTE_PROFILE_VISIBILITIES)[number];

/** 固定节点 selector。 */
export interface RouteFixedNodeSelector {
  kind: "fixed_node";
  node_id: number;
}

/** 节点组 selector（带多候选策略）。 */
export interface RouteNodeGroupSelector {
  kind: "node_group";
  node_group_id: number;
  strategy: string;
}

export type RouteSelector = RouteFixedNodeSelector | RouteNodeGroupSelector;

/** ingress 侧策略（入口组换机）。 */
export const ROUTE_INGRESS_STRATEGIES = [
  "failover",
  "fallback",
  "round_robin",
  "random",
  "least_conn",
  "ip_hash",
] as const;

/** egress 侧策略（§9.4.4 第 3 条冻结集合）。 */
export const ROUTE_EGRESS_STRATEGIES = ["fallback", "round_robin", "random", "least_conn", "ip_hash"] as const;

/** health / placement 约束（键集合封闭：未知键 fail-closed）。 */
export interface RouteProfileConstraints {
  exclude_node_ids?: number[];
  /** 缺省 = 只允许 active（fail-closed）。 */
  allowed_lifecycles?: string[];
  require_health?: string[];
  require_node_binding?: boolean;
}

/**
 * 模板本体（契约 §2）。
 *
 * `transit` 是**有序**数组：顺序即执行顺序，第一版只允许 `fixed_node`、最多 1 个。
 */
export interface RouteProfileTemplate {
  ingress: RouteSelector;
  transit: RouteFixedNodeSelector[];
  /** `null` = DIRECT（出口就是 ingress 那一跳）。 */
  egress: RouteSelector | null;
  ingress_policy?: Record<string, unknown> | null;
  egress_policy?: Record<string, unknown> | null;
  constraints?: RouteProfileConstraints | null;
  required_capabilities?: string[] | null;
}

/** 授权行（`route_profile_assignment`）：target_type ∈ {workspace, plan}。 */
export interface RouteProfileAssignment {
  target_type: string;
  target_id: number;
  active: boolean;
}

/** 列表 / 详情里的模板视图（`routeProfileView`）。 */
export interface RouteProfileView {
  id: number;
  workspace_id: number;
  name: string;
  description: string | null;
  visibility: RouteProfileVisibility | string;
  enabled: boolean;
  version: number;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  template: RouteProfileTemplate;
  template_digest: string;
  assignments: RouteProfileAssignment[];
}

/**
 * 详情 = 列表视图 + 版本历史 + **被多少 Forward 引用**。
 *
 * 列表端点**不**返回引用计数（后端刻意避免 N+1），所以界面把「被引用数」
 * 放在详情面板里，而不是在列表里编一个数。
 */
export interface RouteProfileDetail extends RouteProfileView {
  versions: Array<{ version: number; created_at: string; change_summary: string | null }>;
  used_by_forwards: number;
}

/** 版本历史条目（`GET /:id/versions`）。 */
export interface RouteProfileVersionEntry {
  version: number;
  change_summary: string | null;
  created_by_id: number | null;
  created_at: string;
}

/** 某个版本的完整内容（`GET /:id/versions/:version`）。 */
export interface RouteProfileVersionBody {
  route_profile_id: number;
  version: number;
  body: unknown;
  template: RouteProfileTemplate;
}

/** 解析出的具体跳（impact / apply 回执）。 */
export interface ResolvedHop {
  hop_index: number;
  role: "ingress" | "middle" | "egress";
  node_id: number;
}

/** Impact Analysis 的单条受影响 Forward（**只读**）。 */
export interface RouteProfileImpactEntry {
  forward_id: number;
  name: string;
  tunnel_mode: string;
  current_revision: number;
  applied_revision: number | null;
  apply_status: string | null;
  /** 该 Forward 当前的来源版本（null = 还没被本模板铺过）。 */
  source_version: number | null;
  current_hops: ResolvedHop[];
  /** 用目标版本重解析后是否仍然可解析。 */
  resolves: boolean;
  resolved_hops: ResolvedHop[] | null;
  change: {
    ingress_change: boolean;
    egress_change: boolean;
    middle_change: boolean;
    noop: boolean;
  } | null;
  error?: { code: RouteProfileErrorCode | string; message: string; error_layer?: string };
}

/** Impact Analysis 响应（`read_only: true` 由后端保证：不触发下发、不写行）。 */
export interface RouteProfileImpact {
  profile_id: number;
  version: number;
  read_only: true;
  scope: "referencing_forwards";
  affected: RouteProfileImpactEntry[];
  total: number;
  /** apply 后真的会改变放置的条数（noop 的不需要动）。 */
  changing: number;
}

/** apply 回执的逐条结果。 */
export interface RouteProfileApplyOutcome {
  forward_id: number;
  name?: string;
  revision?: number;
  /** false = 本次只认领了来源模板，执行路径没有变。 */
  runtime_changed?: boolean;
  resolved_hops?: ResolvedHop[];
  status: "applied" | "previewed" | "failed";
  error?: {
    code: RouteProfileErrorCode | string;
    message: string;
    error_layer?: string;
    retryable?: boolean;
    next_action?: string;
  };
}

export interface RouteProfileApplyResult {
  profile_id: number;
  version: number;
  dry_run: boolean;
  outcomes: RouteProfileApplyOutcome[];
  applied_count: number;
  failed_count: number;
}

/** 消费侧（普通用户）看到的可选线路。 */
export interface ConsumableRouteProfileView {
  id: number;
  name: string;
  description: string | null;
  visibility: RouteProfileVisibility | string;
  version: number;
  template: RouteProfileTemplate;
  /** 该用户此刻能不能选它（后端判定：enabled → 可见性 → 授权命中）。 */
  selectable: boolean;
}

/** `GET /route-profiles/available` 的信封（剥一层 data 后的形状）。 */
export interface ConsumableRouteProfileList {
  data: ConsumableRouteProfileView[];
  total: number;
  user_id: number;
}

/** 创建入参。 */
export interface RouteProfileCreateInput {
  name: string;
  description?: string | null;
  visibility?: RouteProfileVisibility;
  enabled?: boolean;
  template: RouteProfileTemplate;
  assignments?: Array<{ target_type: string; target_id: number; active?: boolean }>;
  change_summary?: string;
}

/**
 * PATCH 只能改 metadata（name / description / visibility / enabled / assignments）。
 *
 * 传任何模板键 → 后端 400 `invalid_input` 并指向「发布新版本」——这是
 * 「编辑共享模板不得静默重写正在运行的 Forward」在实现层的第一道闸。
 * 类型上就不给模板字段，避免调用方误传。
 */
export interface RouteProfilePatchInput {
  name?: string;
  description?: string | null;
  visibility?: RouteProfileVisibility;
  enabled?: boolean;
  assignments?: Array<{ target_type: string; target_id: number; active?: boolean }>;
  /** 乐观并发闸：与服务端当前版本不一致 → 409 version_conflict。 */
  expected_version?: number;
}

/** 发布新版本入参（模板内容变更的唯一路径）。 */
export interface RouteProfilePublishInput {
  template: RouteProfileTemplate;
  expected_version?: number;
  change_summary?: string;
}

/** 发布结果。 */
export interface RouteProfilePublishResult {
  profile: RouteProfileView;
  version: number;
  version_id: number;
  template_digest: string;
}

/** apply 入参：**必须显式列出 forward_ids**（没有「应用到全部」的隐式形式）。 */
export interface RouteProfileApplyInput {
  version: number;
  forward_ids: number[];
  expected_revisions?: Array<{ forward_id: number; revision: number }>;
  dry_run?: boolean;
}

