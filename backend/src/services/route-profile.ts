/**
 * Route Profile service.
 *
 * Profiles are templates only: they do not own runtime state, leases, traffic,
 * reconciliation or a second route truth. Applying a profile resolves concrete
 * nodes and delegates the actual Forward change to the existing Forward service,
 * preserving its revision, rollout and compensation semantics. Template content
 * changes are versioned explicitly; metadata edits never mutate live Forwards.
 */
import { Prisma } from "@prisma/client";
import { db } from "../db.ts";
import { buildAuditEntry, classifyActor, writeAudit } from "./audit.ts";
import {
  compileRouteProfile,
  parseAssignmentTarget,
  parseRouteProfileTemplate,
  parseRouteProfileVisibility,
  canConsumeRouteProfile,
  templateBody,
  templateDigest,
  type CompiledRouteProfile,
  type CompileRouteProfileResult,
  type RouteNodeFacts,
  type RouteProfileTemplate,
  type ResolvedHop,
} from "./route-profile-compiler.ts";
import { patchForward, type ForwardPatchInput } from "./forward-service.ts";
import { listNodeHealth } from "./node-health-service.ts";

/* ================================================================== */
/* Error model                                                        */
/* ================================================================== */

export const ROUTE_PROFILE_ERROR_CODES = {
  /** 形状 / 语义不合法的输入（未知 visibility、未知 selector kind、未知约束键…）。 */
  invalid_input: "invalid_input",
  /** 形状合法但不在第一阶段支持边界内（dynamic middle pool / 超跳数）。 */
  unsupported_topology: "unsupported_topology",
  profile_not_found: "profile_not_found",
  forbidden: "forbidden",
  profile_not_visible: "profile_not_visible",
  profile_disabled: "profile_disabled",
  version_conflict: "version_conflict",
  profile_in_use: "profile_in_use",
  no_eligible_node: "no_eligible_node",
  capability_unavailable: "capability_unavailable",
  binding_missing: "binding_missing",
  route_invalid: "route_invalid",
  rollout_conflict: "rollout_conflict",
  db_unavailable: "db_unavailable",
} as const;

export type RouteProfileErrorCode =
  (typeof ROUTE_PROFILE_ERROR_CODES)[keyof typeof ROUTE_PROFILE_ERROR_CODES];

export type RouteProfileErrorLayer =
  | "rbac"
  | "resource_scope"
  | "capability"
  | "runtime_admission"
  | "data_plane";

/** 错误码 → HTTP 状态码（路由层只查这张表，不再自己判断）。 */
export const ROUTE_PROFILE_ERROR_STATUS: Record<RouteProfileErrorCode, 400 | 403 | 404 | 409 | 422 | 503> = {
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

/** Error code -> product layer where the failure occurred. */
export const ROUTE_PROFILE_ERROR_LAYER: Record<RouteProfileErrorCode, RouteProfileErrorLayer> = {
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

/** Whether retrying the same operation may succeed. */
export const ROUTE_PROFILE_ERROR_RETRYABLE: Record<RouteProfileErrorCode, boolean> = {
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

/** User-facing next action for each failure. */
export const ROUTE_PROFILE_ERROR_NEXT_ACTION: Record<RouteProfileErrorCode, string> = {
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

export type RouteProfileServiceError = {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 503;
  code: RouteProfileErrorCode;
  message: string;
  error_layer: RouteProfileErrorLayer;
  retryable: boolean;
  next_action: string;
  data?: unknown;
};

export type RouteProfileResult<T> = { ok: true; data: T } | RouteProfileServiceError;

/** 构造一个分层错误（不要直接抛 HTTPException：服务层只返回结构化结果）。 */
export function routeProfileError(
  code: RouteProfileErrorCode,
  message: string,
  options: { data?: unknown } = {},
): RouteProfileServiceError {
  return {
    ok: false,
    status: ROUTE_PROFILE_ERROR_STATUS[code],
    code,
    message,
    error_layer: ROUTE_PROFILE_ERROR_LAYER[code],
    retryable: ROUTE_PROFILE_ERROR_RETRYABLE[code],
    next_action: ROUTE_PROFILE_ERROR_NEXT_ACTION[code],
    ...(options.data === undefined ? {} : { data: options.data }),
  };
}

/** Prisma 已知错误 → 本模块错误（P2002 唯一冲突 / P2025 行不存在）。 */
export function toRouteProfileError(e: unknown, fallback = "操作失败，请稍后重试"): RouteProfileServiceError {
  const code = (e as { code?: string } | null)?.code;
  if (code === "P2002") return routeProfileError("version_conflict", "并发发布冲突，请读取最新版本后重试");
  if (code === "P2025") return routeProfileError("profile_not_found", "线路模板不存在");
  return routeProfileError("db_unavailable", fallback);
}

const ok = <T>(data: T): RouteProfileResult<T> => ({ ok: true, data });
const fail = (e: RouteProfileServiceError): RouteProfileResult<never> => e;

/* ================================================================== */
/* 2. 视图（对外形状；不泄露内部列）                                    */
/* ================================================================== */

export interface RouteProfileView {
  id: number;
  workspace_id: number;
  name: string;
  description: string | null;
  visibility: string;
  enabled: boolean;
  version: number;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  template: RouteProfileTemplate;
  template_digest: string;
  assignments: Array<{ target_type: string; target_id: number; active: boolean }>;
}

type ProfileRow = {
  id: number;
  workspace_id: number;
  name: string;
  description: string | null;
  visibility: string;
  enabled: boolean;
  version: number;
  ingress_selector: unknown;
  transit_selectors: unknown;
  egress_selector: unknown;
  ingress_policy: unknown;
  egress_policy: unknown;
  constraints: unknown;
  required_capabilities: unknown;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
  assignments?: Array<{ target_type: string; target_id: number; active: boolean }>;
};

/**
 * 投影列 → 模板对象。
 *
 * 投影列是**当前版本**的投影（权威是 `route_profile_version.body`），因此这里读它
 * 只用于「列表/详情展示当前内容」，任何判定（编译/impact/apply）都必须先取版本行。
 */
function templateFromProjection(row: ProfileRow): RouteProfileTemplate | null {
  const parsed = parseRouteProfileTemplate({
    ingress: row.ingress_selector ?? undefined,
    transit: row.transit_selectors ?? undefined,
    egress: row.egress_selector ?? undefined,
    ingress_policy: row.ingress_policy ?? undefined,
    egress_policy: row.egress_policy ?? undefined,
    constraints: row.constraints ?? undefined,
    required_capabilities: row.required_capabilities ?? undefined,
  });
  return parsed.ok ? parsed.template : null;
}

export function routeProfileView(row: ProfileRow): RouteProfileView {
  const template = templateFromProjection(row);
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
    // 投影损坏时不编造模板：返回空壳并由调用方按「不可用」处理（fail-closed）。
    template: template ?? { ingress: { kind: "fixed_node", node_id: 0 }, transit: [], egress: null },
    template_digest: template ? templateDigest(template) : "",
    assignments: (row.assignments ?? []).map((a) => ({
      target_type: a.target_type,
      target_id: a.target_id,
      active: a.active,
    })),
  };
}

/* ================================================================== */
/* 3. 审计（走既有通道 services/audit.ts；永不抛）                       */
/* ================================================================== */

export interface RouteProfileAuditContext {
  actorId?: number | null;
  actorEmail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

type AuditAction =
  | "route_profile.created"
  | "route_profile.updated"
  | "route_profile.version_published"
  | "route_profile.applied";

async function audit(
  action: AuditAction,
  resourceId: number | string,
  ctx: RouteProfileAuditContext | undefined,
  status: number,
  metadata: Record<string, unknown> | null,
): Promise<void> {
  await writeAudit({
    actor_type: classifyActor({ id: ctx?.actorId ?? null, email: ctx?.actorEmail ?? null }),
    actor_id: ctx?.actorId ?? null,
    actor_email: ctx?.actorEmail ?? null,
    action,
    resource: "route_profile",
    resource_id: String(resourceId),
    method: "POST",
    path: `/api/route-profiles/${resourceId}`,
    status,
    ip: ctx?.ip ?? null,
    user_agent: ctx?.userAgent ?? null,
    metadata,
  });
}

/* ================================================================== */
/* 4. 输入解析                                                          */
/* ================================================================== */

/** 授权行的最小投影。 */
export type AssignmentView = { target_type: string; target_id: number; active: boolean };

/**
 * 授权行单独查询后合并（避免 N+1）。
 *
 * 为什么不 `include`：`route_profile` 与 `route_profile_assignment` 之间**刻意没有
 * Prisma 关系** —— schema 只做最小 diff（不改共享 model），且授权行有自己的生命周期
 * （`target_id` 无外键，授权对象被删除不得改写历史）。因此这里显式一次 `IN` 查询。
 */
async function withAssignments<T extends { id: number }>(
  rows: T[],
): Promise<Array<T & { assignments: AssignmentView[] }>> {
  if (rows.length === 0) return [];
  const list = await db.routeProfileAssignment.findMany({
    where: { route_profile_id: { in: rows.map((r) => r.id) } },
    select: { route_profile_id: true, target_type: true, target_id: true, active: true },
  });
  const byProfile = new Map<number, AssignmentView[]>();
  for (const row of list) {
    const bucket = byProfile.get(row.route_profile_id) ?? [];
    bucket.push({ target_type: row.target_type, target_id: row.target_id, active: row.active });
    byProfile.set(row.route_profile_id, bucket);
  }
  return rows.map((row) => ({ ...row, assignments: byProfile.get(row.id) ?? [] }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 模板内容键：出现在 metadata-only 的 PATCH 里就是「想静默改模板」⇒ 400。 */
const TEMPLATE_BODY_KEYS = [
  "template",
  "ingress",
  "transit",
  "egress",
  "ingress_policy",
  "egress_policy",
  "constraints",
  "required_capabilities",
] as const;

interface AssignmentInput {
  target_type: string;
  target_id: number;
  active: boolean;
}

function parseAssignments(raw: unknown): { ok: true; rows: AssignmentInput[] } | RouteProfileServiceError {
  if (raw === undefined || raw === null) return { ok: true, rows: [] };
  if (!Array.isArray(raw)) return routeProfileError("invalid_input", "assignments 必须是数组");
  const rows: AssignmentInput[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!isPlainObject(item)) return routeProfileError("invalid_input", `assignments[${i}] 必须是对象`);
    const targetType = parseAssignmentTarget(item.target_type);
    if (targetType === null) {
      return routeProfileError("invalid_input", `assignments[${i}].target_type 只能是 workspace / plan`);
    }
    if (!Number.isInteger(item.target_id) || (item.target_id as number) <= 0) {
      return routeProfileError("invalid_input", `assignments[${i}].target_id 必须是正整数`);
    }
    if (item.active !== undefined && typeof item.active !== "boolean") {
      return routeProfileError("invalid_input", `assignments[${i}].active 必须是布尔值`);
    }
    rows.push({
      target_type: targetType,
      target_id: item.target_id as number,
      active: item.active === undefined ? true : (item.active as boolean),
    });
  }
  return { ok: true, rows };
}

function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 120) return null;
  return trimmed;
}

function normalizeDescription(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed.slice(0, 500);
}

/* ================================================================== */
/* 5. 候选事实装载（编译器不读库；这里负责把事实读出来）                 */
/* ================================================================== */

const NODE_FACTS_SELECT = {
  id: true,
  node_id: true,
  node_group_id: true,
  role: true,
  status: true,
  lifecycle: true,
  last_seen_at: true,
  node_credential_hash: true,
  credential_revoked: true,
  order_by: true,
  node_group: { select: { workspace_id: true } },
} as const;

/**
 * 模板引用到的节点 / 节点组 → 事实。
 *
 * **跨 workspace 一律读不到**（`node_group.workspace_id` 过滤）：模板引用别的
 * workspace 的节点组与「引用不存在的组」在判定上同义 —— 都是 `no_eligible_node`，
 * 不泄露对方是否存在（与 route 层「跨域 404」同一口径）。
 */
async function loadCandidateFacts(
  workspaceId: number,
  template: RouteProfileTemplate,
): Promise<RouteNodeFacts[]> {
  const nodeIds = new Set<number>();
  const groupIds = new Set<number>();
  const selectors = [template.ingress, ...template.transit, template.egress];
  for (const selector of selectors) {
    if (!selector) continue;
    if (selector.kind === "fixed_node") nodeIds.add(selector.node_id);
    else groupIds.add(selector.node_group_id);
  }
  if (nodeIds.size === 0 && groupIds.size === 0) return [];

  const rows = await db.node.findMany({
    where: {
      node_group: { workspace_id: workspaceId },
      OR: [
        ...(nodeIds.size > 0 ? [{ id: { in: [...nodeIds] } }] : []),
        ...(groupIds.size > 0 ? [{ node_group_id: { in: [...groupIds] } }] : []),
      ],
    },
    select: NODE_FACTS_SELECT,
  });

  // 健康态用既有 fleet 合成（唯一实现，不在这里重算）。读失败 ⇒ "unknown"：
  // 只对**显式声明** require_health 的模板产生影响（那时它的语义就是 fail-closed）。
  const health = new Map<number, string>();
  try {
    const fleet = await listNodeHealth({});
    if (fleet.ok) for (const item of fleet.items) health.set(item.node_id, item.health);
  } catch {
    /* health 缺失 ⇒ unknown，不静默放行 */
  }

  return rows.map((row) => ({
    node_id: row.id,
    node_group_id: row.node_group_id,
    role: row.role,
    status: row.status,
    lifecycle: row.lifecycle,
    last_seen_at: row.last_seen_at,
    has_credential: typeof row.node_credential_hash === "string" && row.node_credential_hash.length > 0,
    credential_revoked: row.credential_revoked,
    health: health.get(row.id) ?? "unknown",
    capabilities: null,
    order: row.order_by,
    label: row.node_id,
  }));
}

/** 已存在的相邻绑定（"a->b"）。三跳准入需要它（§9 冻结契约第 3 条）。 */
async function loadBoundPairs(nodeIds: readonly number[]): Promise<Set<string>> {
  if (nodeIds.length === 0) return new Set();
  const rows = await db.nodeBinding.findMany({
    where: { ingress_node_id: { in: [...nodeIds] }, egress_node_id: { in: [...nodeIds] } },
    select: { ingress_node_id: true, egress_node_id: true },
  });
  return new Set(rows.map((r) => `${r.ingress_node_id}->${r.egress_node_id}`));
}

/**
 * 把下游服务层的 `error_layer`（更宽的联合）收窄到本模块的六层取值。
 *
 * 收窄而不是透传：路由层按本模块的联合做穷尽分支，出现未知层会让前端拿不到
 * 可行动提示 —— 未知一律落到 `runtime_admission`（apply 的实际失败面）。
 */
function asRouteProfileLayer(layer: string | null | undefined): RouteProfileErrorLayer {
  switch (layer) {
    case "rbac":
    case "resource_scope":
    case "capability":
    case "runtime_admission":
    case "data_plane":
      return layer;
    default:
      return "runtime_admission";
  }
}

/** 把编译失败翻译成服务层错误（错误码一一对应，不压成 500）。 */
function compileFailureToError(
  result: Extract<CompileRouteProfileResult, { ok: false }>,
  forwardId?: number,
): RouteProfileServiceError {
  const code: RouteProfileErrorCode =
    result.code === "invalid_input" ||
    result.code === "unsupported_topology" ||
    result.code === "no_eligible_node" ||
    result.code === "capability_unavailable" ||
    result.code === "binding_missing" ||
    result.code === "route_invalid"
      ? result.code
      : "route_invalid";
  return routeProfileError(code, result.message, {
    data: {
      ...(forwardId === undefined ? {} : { forward_id: forwardId }),
      ...(result.hop_index === undefined ? {} : { hop_index: result.hop_index }),
      ...(result.rejected === undefined ? {} : { rejected: result.rejected }),
    },
  });
}

/* ================================================================== */
/* 6. CRUD（管理面：workspace 域）                                      */
/* ================================================================== */

export interface ListRouteProfilesInput {
  page?: number;
  page_size?: number;
  keyword?: string;
  visibility?: string | null;
  enabled?: boolean | null;
}

export async function listRouteProfiles(
  workspaceId: number,
  input: ListRouteProfilesInput = {},
): Promise<RouteProfileResult<{ data: RouteProfileView[]; total: number; page: number; page_size: number }>> {
  const page = Math.max(1, Math.trunc(input.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Math.trunc(input.page_size ?? 20) || 20));

  const where: Prisma.RouteProfileWhereInput = { workspace_id: workspaceId };
  const keyword = (input.keyword ?? "").trim();
  if (keyword) where.name = { contains: keyword };
  if (typeof input.enabled === "boolean") where.enabled = input.enabled;
  if (input.visibility !== undefined && input.visibility !== null && String(input.visibility) !== "") {
    const visibility = parseRouteProfileVisibility(input.visibility);
    if (visibility === null) {
      return fail(routeProfileError("invalid_input", "visibility 只能是 INTERNAL / ASSIGNED / PUBLIC"));
    }
    where.visibility = visibility;
  }

  try {
    const [found, total] = await Promise.all([
      db.routeProfile.findMany({
        where,
        orderBy: [{ id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.routeProfile.count({ where }),
    ]);
    const rows = await withAssignments(found);
    return ok({ data: rows.map(routeProfileView), total, page, page_size: pageSize });
  } catch {
    return fail(routeProfileError("db_unavailable", "读取线路模板失败，请稍后重试"));
  }
}

export async function getRouteProfileDetail(
  id: number,
  workspaceId: number,
): Promise<RouteProfileResult<RouteProfileView & { versions: Array<{ version: number; created_at: Date; change_summary: string | null }>; used_by_forwards: number }>> {
  try {
    const found = await db.routeProfile.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!found) return fail(routeProfileError("profile_not_found", "线路模板不存在"));
    const [withRows, versions, usedBy] = await Promise.all([
      withAssignments([found]),
      db.routeProfileVersion.findMany({
        where: { route_profile_id: id },
        orderBy: [{ version: "desc" }],
        take: 50,
        select: { version: true, created_at: true, change_summary: true },
      }),
      db.tunnel.count({ where: { route_profile_id: id, workspace_id: workspaceId } }),
    ]);
    return ok({ ...routeProfileView(withRows[0]!), versions, used_by_forwards: usedBy });
  } catch {
    return fail(routeProfileError("db_unavailable", "读取线路模板失败，请稍后重试"));
  }
}

export interface CreateRouteProfileInput {
  workspaceId: number;
  name: unknown;
  description?: unknown;
  visibility?: unknown;
  enabled?: unknown;
  template: unknown;
  assignments?: unknown;
  change_summary?: unknown;
  audit?: RouteProfileAuditContext;
}

export async function createRouteProfile(
  input: CreateRouteProfileInput,
): Promise<RouteProfileResult<RouteProfileView & { version_id: number }>> {
  const name = normalizeName(input.name);
  if (name === null) return fail(routeProfileError("invalid_input", "名称必须是 1–120 个字符"));

  const visibility =
    input.visibility === undefined || input.visibility === null
      ? "INTERNAL"
      : parseRouteProfileVisibility(input.visibility);
  if (visibility === null) {
    return fail(routeProfileError("invalid_input", "visibility 只能是 INTERNAL / ASSIGNED / PUBLIC"));
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    return fail(routeProfileError("invalid_input", "enabled 必须是布尔值"));
  }

  const parsedTemplate = parseRouteProfileTemplate(input.template);
  if (!parsedTemplate.ok) {
    return fail(routeProfileError(parsedTemplate.code, parsedTemplate.message));
  }
  const assignments = parseAssignments(input.assignments);
  if (!assignments.ok) return fail(assignments);

  const description = normalizeDescription(input.description) ?? null;
  const body = templateBody(parsedTemplate.template) as Prisma.InputJsonValue;
  const changeSummary =
    typeof input.change_summary === "string" && input.change_summary.trim() !== ""
      ? input.change_summary.trim().slice(0, 500)
      : "initial version";

  try {
    const created = await db.$transaction(async (tx) => {
      const profile = await tx.routeProfile.create({
        data: {
          workspace_id: input.workspaceId,
          user_id: input.audit?.actorId ?? 0,
          name,
          description,
          visibility,
          enabled: input.enabled === undefined ? true : (input.enabled as boolean),
          version: 1,
          ingress_selector: parsedTemplate.template.ingress as unknown as Prisma.InputJsonValue,
          transit_selectors: parsedTemplate.template.transit as unknown as Prisma.InputJsonValue,
          egress_selector:
            parsedTemplate.template.egress === null
              ? Prisma.JsonNull
              : (parsedTemplate.template.egress as unknown as Prisma.InputJsonValue),
          ingress_policy: (parsedTemplate.template.ingress_policy ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          egress_policy: (parsedTemplate.template.egress_policy ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          constraints: (parsedTemplate.template.constraints ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          required_capabilities: (parsedTemplate.template.required_capabilities ??
            Prisma.JsonNull) as Prisma.InputJsonValue,
          published_at: new Date(),
        },
      });
      const version = await tx.routeProfileVersion.create({
        data: {
          route_profile_id: profile.id,
          version: 1,
          body,
          change_summary: changeSummary,
          created_by_id: input.audit?.actorId ?? null,
        },
        select: { id: true },
      });
      if (assignments.rows.length > 0) {
        await tx.routeProfileAssignment.createMany({
          data: assignments.rows.map((row) => ({ route_profile_id: profile.id, ...row })),
        });
      }
      return { profile, versionId: version.id };
    });

    await audit("route_profile.created", created.profile.id, input.audit, 201, {
      version: 1,
      visibility,
      enabled: created.profile.enabled,
    });

    const view = routeProfileView({
      ...created.profile,
      assignments: assignments.rows,
    });
    return ok({ ...view, version_id: created.versionId });
  } catch (e) {
    const mapped = toRouteProfileError(e, "创建线路模板失败，请稍后重试");
    if (mapped.code === "version_conflict") {
      return fail(routeProfileError("invalid_input", "同一工作空间内已存在同名线路模板"));
    }
    return fail(mapped);
  }
}

export interface PatchRouteProfileInput {
  name?: unknown;
  description?: unknown;
  visibility?: unknown;
  enabled?: unknown;
  assignments?: unknown;
  expected_version?: unknown;
  audit?: RouteProfileAuditContext;
}

/**
 * 只改 metadata（name / description / visibility / enabled / assignments）。
 *
 * **模板内容不在这里改**：收到任何模板键 → 400 并指向「发布新版本」。
 * 这条不是风格问题：它是「编辑共享模板不得静默重写正在运行的 Forward」在
 * 实现层的第一道闸 —— 想让本次编辑不生效都做不到，因为这里根本改不了模板。
 */
export async function patchRouteProfile(
  id: number,
  workspaceId: number,
  patch: PatchRouteProfileInput,
): Promise<RouteProfileResult<RouteProfileView>> {
  for (const key of TEMPLATE_BODY_KEYS) {
    if (key in patch && (patch as Record<string, unknown>)[key] !== undefined) {
      return fail(
        routeProfileError(
          "invalid_input",
          `PATCH 只能修改 metadata；模板内容变更必须发布新版本（POST /api/route-profiles/${id}/versions）`,
        ),
      );
    }
  }

  let name: string | undefined;
  if (patch.name !== undefined) {
    const normalized = normalizeName(patch.name);
    if (normalized === null) return fail(routeProfileError("invalid_input", "名称必须是 1–120 个字符"));
    name = normalized;
  }
  let visibility: string | undefined;
  if (patch.visibility !== undefined) {
    const parsed = parseRouteProfileVisibility(patch.visibility);
    if (parsed === null) return fail(routeProfileError("invalid_input", "visibility 只能是 INTERNAL / ASSIGNED / PUBLIC"));
    visibility = parsed;
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    return fail(routeProfileError("invalid_input", "enabled 必须是布尔值"));
  }
  const description = normalizeDescription(patch.description);
  const assignments = parseAssignments(patch.assignments);
  if (!assignments.ok) return fail(assignments);

  try {
    const current = await db.routeProfile.findFirst({
      where: { id, workspace_id: workspaceId },
      select: { id: true, version: true },
    });
    if (!current) return fail(routeProfileError("profile_not_found", "线路模板不存在"));

    if (patch.expected_version !== undefined && patch.expected_version !== null) {
      const expected = Number(patch.expected_version);
      if (!Number.isInteger(expected) || expected !== current.version) {
        return fail(
          routeProfileError("version_conflict", "该线路模板已被他人修改，请刷新后重试", {
            data: { latest_version: current.version },
          }),
        );
      }
    }

    const updated = await db.$transaction(async (tx) => {
      const row = await tx.routeProfile.update({
        where: { id },
        data: {
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
          ...(visibility === undefined ? {} : { visibility }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled as boolean }),
        },
      });
      if (patch.assignments !== undefined) {
        await tx.routeProfileAssignment.deleteMany({ where: { route_profile_id: id } });
        if (assignments.rows.length > 0) {
          await tx.routeProfileAssignment.createMany({
            data: assignments.rows.map((a) => ({ route_profile_id: id, ...a })),
          });
        }
      }
      const list = await tx.routeProfileAssignment.findMany({
        where: { route_profile_id: id },
        select: { target_type: true, target_id: true, active: true },
      });
      return { row, assignments: list };
    });

    await audit("route_profile.updated", id, patch.audit, 200, {
      version: updated.row.version,
      visibility: updated.row.visibility,
      enabled: updated.row.enabled,
      metadata_only: true,
    });
    return ok(routeProfileView({ ...updated.row, assignments: updated.assignments }));
  } catch (e) {
    const mapped = toRouteProfileError(e, "更新线路模板失败，请稍后重试");
    if (mapped.code === "version_conflict") {
      return fail(routeProfileError("invalid_input", "同一工作空间内已存在同名线路模板"));
    }
    return fail(mapped);
  }
}

/* ================================================================== */
/* 7. 版本发布与查询                                                    */
/* ================================================================== */

export interface PublishRouteProfileVersionInput {
  template: unknown;
  expected_version?: unknown;
  change_summary?: unknown;
  audit?: RouteProfileAuditContext;
}

export async function publishRouteProfileVersion(
  id: number,
  workspaceId: number,
  input: PublishRouteProfileVersionInput,
): Promise<RouteProfileResult<{ profile: RouteProfileView; version: number; version_id: number; template_digest: string }>> {
  const parsed = parseRouteProfileTemplate(input.template);
  if (!parsed.ok) return fail(routeProfileError(parsed.code, parsed.message));

  const changeSummary =
    typeof input.change_summary === "string" && input.change_summary.trim() !== ""
      ? input.change_summary.trim().slice(0, 500)
      : null;

  try {
    const current = await db.routeProfile.findFirst({
      where: { id, workspace_id: workspaceId },
      select: { id: true, version: true },
    });
    if (!current) return fail(routeProfileError("profile_not_found", "线路模板不存在"));

    if (input.expected_version !== undefined && input.expected_version !== null) {
      const expected = Number(input.expected_version);
      if (!Number.isInteger(expected) || expected !== current.version) {
        return fail(
          routeProfileError("version_conflict", "该线路模板已被他人修改，请刷新后重试", {
            data: { latest_version: current.version },
          }),
        );
      }
    }

    const nextVersion = current.version + 1;
    const body = templateBody(parsed.template) as Prisma.InputJsonValue;
    const created = await db.$transaction(async (tx) => {
      const version = await tx.routeProfileVersion.create({
        data: {
          route_profile_id: id,
          version: nextVersion,
          body,
          change_summary: changeSummary,
          created_by_id: input.audit?.actorId ?? null,
        },
        select: { id: true },
      });
      const row = await tx.routeProfile.update({
        where: { id },
        data: {
          version: nextVersion,
          ingress_selector: parsed.template.ingress as unknown as Prisma.InputJsonValue,
          transit_selectors: parsed.template.transit as unknown as Prisma.InputJsonValue,
          egress_selector:
            parsed.template.egress === null
              ? Prisma.JsonNull
              : (parsed.template.egress as unknown as Prisma.InputJsonValue),
          ingress_policy: (parsed.template.ingress_policy ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          egress_policy: (parsed.template.egress_policy ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          constraints: (parsed.template.constraints ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          required_capabilities: (parsed.template.required_capabilities ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          published_at: new Date(),
        },
      });
      return { row, versionId: version.id };
    });

    await audit("route_profile.version_published", id, input.audit, 201, {
      version: nextVersion,
      previous_version: current.version,
    });

    return ok({
      profile: routeProfileView(created.row),
      version: nextVersion,
      version_id: created.versionId,
      template_digest: templateDigest(parsed.template),
    });
  } catch (e) {
    return fail(toRouteProfileError(e, "发布新版本失败，请稍后重试"));
  }
}

export async function listRouteProfileVersions(
  id: number,
  workspaceId: number,
  limit = 50,
): Promise<RouteProfileResult<Array<{ version: number; change_summary: string | null; created_by_id: number | null; created_at: Date }>>> {
  try {
    const profile = await db.routeProfile.findFirst({ where: { id, workspace_id: workspaceId }, select: { id: true } });
    if (!profile) return fail(routeProfileError("profile_not_found", "线路模板不存在"));
    const rows = await db.routeProfileVersion.findMany({
      where: { route_profile_id: id },
      orderBy: [{ version: "desc" }],
      take: Math.max(1, Math.min(200, limit)),
      select: { version: true, change_summary: true, created_by_id: true, created_at: true },
    });
    return ok(rows);
  } catch {
    return fail(routeProfileError("db_unavailable", "读取版本历史失败，请稍后重试"));
  }
}

/** 取某个版本的模板（缺省 = 当前版本）。判定路径（impact/apply）必须先走这里。 */
export async function loadRouteProfileVersion(
  id: number,
  workspaceId: number,
  version?: number | null,
): Promise<RouteProfileResult<{ profile: ProfileRow; version: number; template: RouteProfileTemplate; body: unknown }>> {
  try {
    const found = await db.routeProfile.findFirst({
      where: { id, workspace_id: workspaceId },
    });
    if (!found) return fail(routeProfileError("profile_not_found", "线路模板不存在"));
    const profile = (await withAssignments([found]))[0]!;

    let target = version;
    if (target === undefined || target === null) target = profile.version;
    if (!Number.isInteger(target) || target < 1) {
      return fail(routeProfileError("invalid_input", "version 必须是正整数"));
    }
    const row = await db.routeProfileVersion.findUnique({
      where: { route_profile_id_version: { route_profile_id: id, version: target } },
      select: { version: true, body: true },
    });
    if (!row) {
      return fail(
        routeProfileError("invalid_input", `线路模板不存在版本 ${target}`, { data: { latest_version: profile.version } }),
      );
    }
    const parsed = parseRouteProfileTemplate(row.body);
    if (!parsed.ok) {
      // 库里的版本内容坏了：fail-closed，绝不拿半份模板去下发。
      return fail(routeProfileError("invalid_input", `版本 ${target} 的模板内容已损坏：${parsed.message}`));
    }
    return ok({ profile, version: row.version, template: parsed.template, body: row.body });
  } catch {
    return fail(routeProfileError("db_unavailable", "读取线路模板版本失败，请稍后重试"));
  }
}

/* ================================================================== */
/* 8. Impact Analysis（**严格只读**）                                    */
/* ================================================================== */

/**
 * 放置事实的**规范化比较**（唯一实现，impact 与 apply 共用，防止两边漂移）。
 *
 * 为什么需要规范化：DIRECT 的 `RoutePlan.egress_node_id` 在**计划里**等于 ingress
 * 自己（`buildRoutePlan` 的 DIRECT 语义：同一台机器上的客户端面与目标面），而
 * `tunnel.egress_node_id` 列按定义是 NULL。直接比字段会把每一次 DIRECT 的重新
 * 编译都判成「出口变了」。这里统一把 DIRECT 的出口规约成 null 后再比较。
 */
interface PlacementLike {
  tunnel_mode: string;
  ingress_node_id: number | null;
  egress_node_id: number | null;
  middle_node_id: number | null;
}

function normalizedPlacement(row: PlacementLike): { ingress: number | null; egress: number | null; middle: number | null } {
  const relay = row.tunnel_mode === "relay";
  return {
    ingress: row.ingress_node_id ?? null,
    egress: relay ? (row.egress_node_id ?? null) : null,
    middle: row.middle_node_id ?? null,
  };
}

function samePlacement(a: PlacementLike, b: PlacementLike): {
  same: boolean;
  ingress_change: boolean;
  egress_change: boolean;
  middle_change: boolean;
} {
  const left = normalizedPlacement(a);
  const right = normalizedPlacement(b);
  const ingressChange = left.ingress !== right.ingress;
  const egressChange = left.egress !== right.egress;
  const middleChange = left.middle !== right.middle;
  return {
    same: !ingressChange && !egressChange && !middleChange,
    ingress_change: ingressChange,
    egress_change: egressChange,
    middle_change: middleChange,
  };
}

export interface RouteProfileImpactEntry {
  forward_id: number;
  name: string;
  tunnel_mode: string;
  current_revision: number;
  applied_revision: number | null;
  apply_status: string | null;
  source_version: number | null;
  current_hops: ResolvedHop[];
  /** 以目标版本重新解析的结果（ok=false 时带可行动错误）。 */
  resolves: boolean;
  resolved_hops: ResolvedHop[] | null;
  change: {
    ingress_change: boolean;
    egress_change: boolean;
    middle_change: boolean;
    noop: boolean;
  } | null;
  error?: { code: RouteProfileErrorCode; message: string; error_layer: RouteProfileErrorLayer };
}

export interface RouteProfileImpact {
  profile_id: number;
  version: number;
  read_only: true;
  /**
   * 影响面的口径（唯一）：**来源指针指向本模板**的 Forward。
   *
   * 为什么不是「所有可能被这个模板铺到的 Forward」：模板是意图，Forward 是否属于它
   * 只能由一次显式 apply 建立（§9.4.5）。按「可能」猜一遍等于把意图当事实 ——
   * 运维会看到一份他没同意过的受影响清单。因此第一次 apply 之前该列表为空，
   * 这是正确的答案而不是缺失：此时还没有任何 Forward 的来源是这个模板。
   */
  scope: "referencing_forwards";
  affected: RouteProfileImpactEntry[];
  total: number;
  /** 有多少条会在 apply 后真的改变放置（noop 的不需要动）。 */
  changing: number;
}

/**
 * 受影响 Forward 列表（只读）。
 *
 * **它不触发任何下发、不写任何行**：只读 profile / version / tunnel / node / binding。
 * 测试里对 `forward_revision` 与 `forward_rollout` 做前后行数断言，就是为了钉住这一点
 * （§9.4.5 把 impact analysis 与 apply 明确分成两步）。
 */
export async function analyzeRouteProfileImpact(
  id: number,
  workspaceId: number,
  version?: number | null,
): Promise<RouteProfileResult<RouteProfileImpact>> {
  const loaded = await loadRouteProfileVersion(id, workspaceId, version);
  if (!loaded.ok) return fail(loaded);

  try {
    const forwards = await db.tunnel.findMany({
      where: { route_profile_id: id, workspace_id: workspaceId, category: "port_forward" },
      orderBy: [{ id: "asc" }],
      select: {
        id: true,
        name: true,
        tunnel_mode: true,
        ingress_node_id: true,
        egress_node_id: true,
        middle_node_id: true,
        config_revision: true,
        applied_revision: true,
        apply_status: true,
        route_profile_version: true,
      },
    });

    const candidates = await loadCandidateFacts(workspaceId, loaded.data.template);
    const boundPairs = await loadBoundPairs(candidates.map((c) => c.node_id));

    const affected: RouteProfileImpactEntry[] = [];
    let changing = 0;
    for (const forward of forwards) {
      // 当前路由事实来自 tunnel 行（运行时真相），用同一个纯模型还原成 hop 列表。
      const { buildRoutePlan } = await import("./forward-route.ts");
      const currentPlan = buildRoutePlan({
        ingress_node_id: forward.ingress_node_id ?? null,
        egress_node_id: forward.egress_node_id ?? null,
        middle_node_id: forward.middle_node_id ?? null,
        tunnel_mode: forward.tunnel_mode === "relay" ? "relay" : "direct",
        revision: Number(forward.config_revision ?? 0),
      });
      const currentHops: ResolvedHop[] = currentPlan
        ? currentPlan.hops.map((h) => ({ hop_index: h.hop_index, role: h.role, node_id: h.node_id }))
        : [];

      const compiled: CompileRouteProfileResult = compileRouteProfile({
        template: loaded.data.template,
        route_profile_id: id,
        route_profile_version: loaded.data.version,
        candidates,
        boundPairs,
        rotation_seed: forward.id,
        hash_key: String(forward.id),
      });

      if (!compiled.ok) {
        const mapped = compileFailureToError(compiled, forward.id);
        affected.push({
          forward_id: forward.id,
          name: forward.name,
          tunnel_mode: forward.tunnel_mode === "relay" ? "relay" : "direct",
          current_revision: Number(forward.config_revision ?? 0),
          applied_revision: forward.applied_revision,
          apply_status: forward.apply_status,
          source_version: forward.route_profile_version,
          current_hops: currentHops,
          resolves: false,
          resolved_hops: null,
          change: null,
          error: { code: mapped.code, message: mapped.message, error_layer: mapped.error_layer },
        });
        continue;
      }

      const resolvedHops = compiled.provenance.resolved_hops;
      const diff = samePlacement(
        {
          tunnel_mode: forward.tunnel_mode === "relay" ? "relay" : "direct",
          ingress_node_id: forward.ingress_node_id,
          egress_node_id: forward.egress_node_id,
          middle_node_id: forward.middle_node_id,
        },
        {
          tunnel_mode: compiled.tunnel_mode,
          ingress_node_id: compiled.plan.ingress_node_id,
          egress_node_id: compiled.placement.egress_node_id,
          middle_node_id: compiled.placement.middle_node_id,
        },
      );
      const change = {
        ingress_change: diff.ingress_change,
        egress_change: diff.egress_change,
        middle_change: diff.middle_change,
        noop: diff.same,
      };
      if (!change.noop) changing += 1;

      affected.push({
        forward_id: forward.id,
        name: forward.name,
        tunnel_mode: compiled.tunnel_mode,
        current_revision: Number(forward.config_revision ?? 0),
        applied_revision: forward.applied_revision,
        apply_status: forward.apply_status,
        source_version: forward.route_profile_version,
        current_hops: currentHops,
        resolves: true,
        resolved_hops: resolvedHops,
        change,
      });
    }

    return ok({
      profile_id: id,
      version: loaded.data.version,
      read_only: true,
      scope: "referencing_forwards",
      affected,
      total: affected.length,
      changing,
    });
  } catch {
    return fail(routeProfileError("db_unavailable", "影响面分析失败，请稍后重试"));
  }
}

/* ================================================================== */
/* 9. Apply（显式 rollout 入口）                                        */
/* ================================================================== */

export interface ApplyRouteProfileInput {
  profileId: number;
  workspaceId: number;
  version?: unknown;
  forward_ids: unknown;
  expected_revisions?: unknown;
  dry_run?: unknown;
  audit?: RouteProfileAuditContext;
}

export interface RouteProfileApplyOutcome {
  forward_id: number;
  name?: string;
  revision?: number;
  /** 本次 apply 是否真的改动了执行路径（false = 只认领了来源模板）。 */
  runtime_changed?: boolean;
  resolved_hops?: ResolvedHop[];
  status: "applied" | "previewed" | "failed";
  error?: { code: RouteProfileErrorCode; message: string; error_layer: RouteProfileErrorLayer; retryable: boolean; next_action: string };
}

export interface RouteProfileApplyResult {
  profile_id: number;
  version: number;
  dry_run: boolean;
  outcomes: RouteProfileApplyOutcome[];
  applied_count: number;
  failed_count: number;
}

/**
 * 显式 apply：把某个版本的模板铺到**调用方显式列出的** Forward 上。
 *
 * 三条硬约束（§9.4.5）：
 *   1. 不提供「应用到全部」的隐式形式（`forward_ids` 必须非空且显式）；
 *   2. 每个 Forward 逐条过 `expected_revision` 闸门，冲突 409 而不是覆盖；
 *   3. 实际生效必须经过既有 `patchForward`（新 revision + rollout），本函数不写
 *      runtime、不发命令、不碰 lease。
 *
 * 写入顺位：先把「来源模板指针」写到 tunnel 行，再调用既有编辑路径 ——
 * 这样 `createForwardRevision` 在同一个事实基础上把 provenance 冻进快照；
 * 编辑失败则把指针恢复原值（补偿），不留半套状态。
 */
export async function applyRouteProfile(
  input: ApplyRouteProfileInput,
): Promise<RouteProfileResult<RouteProfileApplyResult>> {
  if (!Array.isArray(input.forward_ids) || input.forward_ids.length === 0) {
    return fail(
      routeProfileError(
        "invalid_input",
        "apply 必须显式给出 forward_ids（不提供「应用到全部」的隐式形式）",
      ),
    );
  }
  const forwardIds: number[] = [];
  for (const raw of input.forward_ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) return fail(routeProfileError("invalid_input", "forward_ids 必须是正整数数组"));
    if (!forwardIds.includes(id)) forwardIds.push(id);
  }
  const dryRun = input.dry_run === true;
  if (input.dry_run !== undefined && typeof input.dry_run !== "boolean") {
    return fail(routeProfileError("invalid_input", "dry_run 必须是布尔值"));
  }

  const expected = new Map<number, number>();
  if (input.expected_revisions !== undefined && input.expected_revisions !== null) {
    if (!isPlainObject(input.expected_revisions)) {
      return fail(routeProfileError("invalid_input", "expected_revisions 必须是对象 { forward_id: revision }"));
    }
    for (const [key, value] of Object.entries(input.expected_revisions)) {
      const forwardId = Number(key);
      const revision = Number(value);
      if (!Number.isInteger(forwardId) || forwardId <= 0 || !Number.isInteger(revision) || revision < 0) {
        return fail(routeProfileError("invalid_input", "expected_revisions 的键值必须是「正整数 forward_id: 非负 revision」"));
      }
      expected.set(forwardId, revision);
    }
  }

  const loaded = await loadRouteProfileVersion(
    input.profileId,
    input.workspaceId,
    input.version === undefined || input.version === null ? null : Number(input.version),
  );
  if (!loaded.ok) return fail(loaded);
  if (!loaded.data.profile.enabled) {
    return fail(routeProfileError("profile_disabled", "该线路模板已停用，不能应用到 Forward"));
  }
  if (forwardIds.length > 100) {
    return fail(routeProfileError("invalid_input", "一次 apply 最多 100 条 Forward"));
  }

  const candidates = await loadCandidateFacts(input.workspaceId, loaded.data.template);
  const boundPairs = await loadBoundPairs(candidates.map((c) => c.node_id));

  const outcomes: RouteProfileApplyOutcome[] = [];
  let appliedCount = 0;

  for (const forwardId of forwardIds) {
    const forward = await db.tunnel.findFirst({
      where: { id: forwardId, workspace_id: input.workspaceId, category: "port_forward" },
      select: {
        id: true,
        name: true,
        tunnel_mode: true,
        ingress_node_id: true,
        egress_node_id: true,
        middle_node_id: true,
        config_revision: true,
        route_profile_id: true,
        route_profile_version: true,
      },
    });
    if (!forward) {
      outcomes.push({
        forward_id: forwardId,
        status: "failed",
        error: {
          code: "profile_not_found",
          message: "端口转发不存在",
          error_layer: "resource_scope",
          retryable: false,
          next_action: "刷新后重试",
        },
      });
      continue;
    }

    const gate = expected.get(forwardId);
    if (gate !== undefined && gate !== Number(forward.config_revision ?? 0)) {
      outcomes.push({
        forward_id: forwardId,
        name: forward.name,
        status: "failed",
        error: {
          code: "version_conflict",
          message: "该转发已被他人修改，请刷新后重新确认",
          error_layer: "resource_scope",
          retryable: true,
          next_action: "读取最新 revision 后重新 apply",
        },
      });
      continue;
    }

    const compiled = compileRouteProfile({
      template: loaded.data.template,
      route_profile_id: input.profileId,
      route_profile_version: loaded.data.version,
      candidates,
      boundPairs,
      rotation_seed: forward.id,
      hash_key: String(forward.id),
    });
    if (!compiled.ok) {
      const mapped = compileFailureToError(compiled, forwardId);
      outcomes.push({
        forward_id: forwardId,
        name: forward.name,
        status: "failed",
        error: {
          code: mapped.code,
          message: `${mapped.message}（hop ${compiled.hop_index ?? "-"}）`,
          error_layer: mapped.error_layer,
          retryable: mapped.retryable,
          next_action: mapped.next_action,
        },
      });
      continue;
    }

    if (dryRun) {
      outcomes.push({
        forward_id: forwardId,
        name: forward.name,
        status: "previewed",
        resolved_hops: compiled.provenance.resolved_hops,
      });
      continue;
    }

    // 指针先写：这样既有编辑路径创建 revision 时，「来源模板」已是确定事实。
    const previousPointer = {
      route_profile_id: forward.route_profile_id,
      route_profile_version: forward.route_profile_version,
    };
    try {
      await db.tunnel.update({
        where: { id: forwardId },
        data: {
          route_profile_id: input.profileId,
          route_profile_version: loaded.data.version,
        },
      });
    } catch {
      outcomes.push({
        forward_id: forwardId,
        name: forward.name,
        status: "failed",
        error: {
          code: "db_unavailable",
          message: "写入来源模板指针失败，请稍后重试",
          error_layer: "data_plane",
          retryable: true,
          next_action: "稍后重试",
        },
      });
      continue;
    }

    const patch: ForwardPatchInput = {
      mode: compiled.tunnel_mode,
      // `plan`（而不是 placement）取值：plan 已经过 `buildRoutePlan` 的合法性校验，
      // 它的 ingress/egress 一定是确定数字，不会把 null 带给编辑路径。
      ingress_node_id: compiled.plan.ingress_node_id,
      egress_node_id: compiled.tunnel_mode === "relay" ? compiled.plan.egress_node_id : null,
      middle_node_id: compiled.plan.middle_node_id,
    };
    const patched = await patchForward(forwardId, input.workspaceId, patch, input.audit?.actorId ?? undefined);
    if (!patched.ok) {
      // 补偿：恢复指针，避免「指针说来自模板、但放置事实没变」的半套状态。
      await db.tunnel
        .update({
          where: { id: forwardId },
          data: {
            route_profile_id: previousPointer.route_profile_id,
            route_profile_version: previousPointer.route_profile_version,
          },
        })
        .catch(() => undefined);
      outcomes.push({
        forward_id: forwardId,
        name: forward.name,
        status: "failed",
        error: {
          code: patched.code === "revision_conflict" ? "rollout_conflict" : "route_invalid",
          message: patched.message,
          error_layer: asRouteProfileLayer(patched.error_layer),
          retryable: patched.code === "revision_conflict",
          next_action:
            patched.code === "revision_conflict"
              ? "等待该 Forward 正在进行的更新结束后重试"
              : "检查该 Forward 的配置（模式/目标）是否与模板解析结果相容",
        },
      });
      continue;
    }

    const revision = Number((patched.data as { config_revision?: number } | null)?.config_revision ?? 0);
    // 「解析结果与当前放置完全相同」是一个**合法且常见**的 apply：它不产生新 revision
    // （既有编辑路径会判成 metadata-only），但「这条 Forward 从此来自模板 P vN」这个
    // 事实仍然要落地 —— 否则第一次 apply 到一台本来就选对的节点上会查无此事。
    // 因此这里用 `runtime_changed` 明确区分「换了路径」与「只是认领来源」。
    const runtimeChanged = !samePlacement(
      {
        tunnel_mode: forward.tunnel_mode === "relay" ? "relay" : "direct",
        ingress_node_id: forward.ingress_node_id,
        egress_node_id: forward.egress_node_id,
        middle_node_id: forward.middle_node_id,
      },
      {
        tunnel_mode: compiled.tunnel_mode,
        ingress_node_id: compiled.plan.ingress_node_id,
        egress_node_id: compiled.placement.egress_node_id,
        middle_node_id: compiled.placement.middle_node_id,
      },
    ).same;

    try {
      await db.routeProfileApplication.create({
        data: {
          route_profile_id: input.profileId,
          route_profile_version: loaded.data.version,
          tunnel_id: forwardId,
          // 纯认领来源时该 Forward 可能还没有 revision（0 = 尚无 revision 的既有行），
          // 账本仍记录这次申请（模板/版本/解析出的跳），这是它的主要价值。
          forward_revision: revision,
          resolved_hops: compiled.provenance.resolved_hops as unknown as Prisma.InputJsonValue,
          applied_by_id: input.audit?.actorId ?? null,
        },
      });
    } catch {
      // apply 已经生效（revision + rollout 已落库），账本写失败只降级为「解释链缺失」，
      // 不能把一次成功的 apply 报成失败。
    }

    appliedCount += 1;
    outcomes.push({
      forward_id: forwardId,
      name: forward.name,
      status: "applied",
      revision,
      runtime_changed: runtimeChanged,
      resolved_hops: compiled.provenance.resolved_hops,
    });
  }

  if (!dryRun && appliedCount > 0) {
    await audit("route_profile.applied", input.profileId, input.audit, 200, {
      version: loaded.data.version,
      forward_ids: outcomes.filter((o) => o.status === "applied").map((o) => o.forward_id),
      applied_count: appliedCount,
      runtime_changed_count: outcomes.filter((o) => o.runtime_changed === true).length,
    });
  }

  return ok({
    profile_id: input.profileId,
    version: loaded.data.version,
    dry_run: dryRun,
    outcomes,
    applied_count: appliedCount,
    failed_count: outcomes.filter((o) => o.status === "failed").length,
  });
}

/* ================================================================== */
/* 10. 消费侧（只读；visibility / entitlement 判定）                    */
/* ================================================================== */

export interface ConsumableRouteProfileView {
  id: number;
  name: string;
  description: string | null;
  visibility: string;
  version: number;
  template: RouteProfileTemplate;
  /** 该用户此刻能不能选它（enabled + 可见性判定）。 */
  selectable: boolean;
}

export interface ConsumptionSubject {
  workspaceId: number;
  /** 管理面（该 workspace 有 manage 权限）：可以看到 INTERNAL。 */
  isManager: boolean;
  planIds?: readonly number[];
}

/**
 * 消费者可见/可选的线路模板列表（**只读**）。
 *
 * 判定只用 `canConsumeRouteProfile`（单一实现）：enabled → 可见性 → ASSIGNED 命中。
 * 本版**不做**计费/schema 落库：套餐侧的 entitlement 接入属于后续 WP，
 * 这里只保证「没有显式授权就看不到」这个 fail-closed 方向。
 */
export async function listConsumableRouteProfiles(
  subject: ConsumptionSubject,
): Promise<RouteProfileResult<ConsumableRouteProfileView[]>> {
  try {
    const found = await db.routeProfile.findMany({
      where: { workspace_id: subject.workspaceId, enabled: true },
      orderBy: [{ id: "asc" }],
    });
    const rows = await withAssignments(found);
    const out: ConsumableRouteProfileView[] = [];
    for (const row of rows) {
      const allowed = canConsumeRouteProfile(
        {
          visibility: row.visibility,
          enabled: row.enabled,
          workspace_id: row.workspace_id,
          assignments: row.assignments,
        },
        {
          workspace_id: subject.workspaceId,
          is_manager: subject.isManager,
          plan_ids: subject.planIds ?? [],
        },
      );
      if (!allowed) continue;
      out.push({
        id: row.id,
        name: row.name,
        description: row.description,
        visibility: row.visibility,
        version: row.version,
        template: routeProfileView(row).template,
        selectable: true,
      });
    }
    return ok(out);
  } catch {
    return fail(routeProfileError("db_unavailable", "读取可用线路失败，请稍后重试"));
  }
}

/* ================================================================== */
/* 11. 内部：编译预览（给路由层做 dry-run 展示）                         */
/* ================================================================== */

export async function compileRouteProfilePreview(
  id: number,
  workspaceId: number,
  version?: number | null,
): Promise<RouteProfileResult<{ version: number; resolution: CompiledRouteProfile | null }>> {
  const loaded = await loadRouteProfileVersion(id, workspaceId, version);
  if (!loaded.ok) return fail(loaded);
  const candidates = await loadCandidateFacts(workspaceId, loaded.data.template);
  const boundPairs = await loadBoundPairs(candidates.map((c) => c.node_id));
  const compiled = compileRouteProfile({
    template: loaded.data.template,
    route_profile_id: id,
    route_profile_version: loaded.data.version,
    candidates,
    boundPairs,
  });
  if (!compiled.ok) return fail(compileFailureToError(compiled));
  return ok({ version: loaded.data.version, resolution: compiled });
}

/** 供路由层构造「谁在管理这个 workspace」判定用的审计辅助。 */
export function auditContextFrom(
  actor: { id?: number | null; email?: string | null } | null | undefined,
  req: { ip?: string | null; userAgent?: string | null } = {},
): RouteProfileAuditContext {
  return {
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    ip: req.ip ?? null,
    userAgent: req.userAgent ?? null,
  };
}

/** 显式 re-export：路由层只依赖本模块即可（不需要知道编译器细节）。 */
export { parseRouteProfileTemplate, parseRouteProfileVisibility, buildAuditEntry };
