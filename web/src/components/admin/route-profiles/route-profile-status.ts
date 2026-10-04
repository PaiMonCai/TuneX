import { ApiError } from "@/lib/api";
import {
  ROUTE_PROFILE_ERROR_CODES,
  ROUTE_PROFILE_VISIBILITIES,
  type RouteFixedNodeSelector,
  type RouteProfileConstraints,
  type RouteProfileErrorCode,
  type RouteProfileErrorLayer,
  type RouteProfileImpactEntry,
  type RouteProfileTemplate,
  type RouteSelector,
} from "@/lib/types";

/**
 * Admin Console Route Profile 的**纯逻辑层**（V5-WP13.5B，§9.4.2–§9.4.7）。
 *
 * 三条纪律：
 *
 * 1. **版本语义由后端定义，前端只展示**：
 *    - 改 name / description / visibility / enabled / assignments → `PATCH`（原地改，**不** bump version）；
 *    - 改模板内容（ingress / transit / egress / policies / constraints / capabilities）
 *      → `POST /:id/versions`（**发新版本**）。后端对 PATCH 带模板键直接 400，
 *      前端把这条规则前置成「保存」与「发布新版本」两个不同按钮，
 *      而不是让用户点了才发现（`templateContentChanged()` 是这条分界的判定点）。
 * 2. **不做运行时状态机**：Route Profile 没有 runtime、没有 applied revision、没有 lease。
 *    这里不出现 `applied_revision` / `lease` / `epoch` 之类字段（有测试钉住）。
 * 3. **不做资源判定**：可见性/授权判定在后端（`canConsumeRouteProfile`）；前端只展示。
 *
 * 本模块不 import React，可在无浏览器环境下直接单测。
 */

/* ------------------------------------------------------------------ */
/* 错误分层                                                            */
/* ------------------------------------------------------------------ */

export interface RouteProfileErrorInfo {
  code: string | null;
  /** 在契约闭集内 */
  known: boolean;
  /** 人读原因（后端字段名是 `error`，不是 `message`） */
  message: string;
  error_layer: RouteProfileErrorLayer | string | null;
  retryable: boolean;
  /** 后端给的「下一步」原文（前端直接展示，不自己编） */
  next_action: string | null;
  status: number | null;
  data: unknown;
}

export function routeProfileErrorInfo(error: unknown): RouteProfileErrorInfo {
  if (error instanceof ApiError) {
    const body = (error.data && typeof error.data === "object" ? error.data : {}) as Record<string, unknown>;
    const rawCode = typeof body.code === "string" && body.code.trim() !== "" ? body.code : null;
    const human =
      typeof body.error === "string" && body.error.trim() !== ""
        ? body.error
        : typeof body.message === "string" && body.message.trim() !== ""
          ? body.message
          : error.message;
    return {
      code: rawCode,
      known: rawCode !== null && (ROUTE_PROFILE_ERROR_CODES as readonly string[]).includes(rawCode),
      message: human,
      error_layer: typeof body.error_layer === "string" ? body.error_layer : null,
      retryable: body.retryable === true,
      next_action: typeof body.next_action === "string" && body.next_action.trim() !== "" ? body.next_action : null,
      status: error.status,
      data: body.data,
    };
  }
  return {
    code: null,
    known: false,
    message: error instanceof Error ? error.message : String(error),
    error_layer: null,
    retryable: false,
    next_action: null,
    status: null,
    data: undefined,
  };
}

/** 失败层的中文/英文标签（§13 六层模型里的五层会影响这里）。 */
const LAYER_TEXT: Record<string, { zh: string; en: string }> = {
  rbac: { zh: "权限层", en: "RBAC" },
  resource_scope: { zh: "资源作用域", en: "Resource scope" },
  capability: { zh: "能力层", en: "Capability" },
  runtime_admission: { zh: "运行准入", en: "Runtime admission" },
  data_plane: { zh: "数据面", en: "Data plane" },
};

export function errorLayerText(locale: string, layer: string | null): string | null {
  if (!layer) return null;
  const entry = LAYER_TEXT[layer];
  if (!entry) return layer;
  return locale === "en" ? entry.en : entry.zh;
}

/** 未知码的兜底「下一步」（闭集内的码一律用后端给的 next_action）。 */
export const UNKNOWN_ERROR_NEXT_ACTION = {
  zh: "未知错误码：拿 code 查面板日志与审计",
  en: "Unknown error code: check panel logs/audit with this code",
};

/** 每个闭集码一句能力描述（用于测试穷尽性与界面 tooltip；下一步仍以后端为准）。 */
export const ROUTE_PROFILE_ERROR_MEANING: Record<RouteProfileErrorCode, { zh: string; en: string }> = {
  invalid_input: { zh: "输入不合法（形状/取值）", en: "Invalid input (shape/value)" },
  unsupported_topology: { zh: "超出第一阶段拓扑能力", en: "Beyond phase-1 topology support" },
  profile_not_found: { zh: "模板不存在或不在本 workspace", en: "Profile missing / not in this workspace" },
  forbidden: { zh: "当前角色无此操作权限", en: "Role lacks permission" },
  profile_not_visible: { zh: "对该消费者不可见", en: "Not visible to this consumer" },
  profile_disabled: { zh: "模板已停用", en: "Profile disabled" },
  version_conflict: { zh: "并发版本冲突", en: "Concurrent version conflict" },
  profile_in_use: { zh: "仍被引用", en: "Still referenced" },
  no_eligible_node: { zh: "没有满足约束的候选节点", en: "No eligible candidate node" },
  capability_unavailable: { zh: "节点缺少所需能力", en: "Required capability unavailable" },
  binding_missing: { zh: "相邻节点缺少绑定", en: "Adjacent node binding missing" },
  route_invalid: { zh: "解析出的跳拓扑不合法", en: "Resolved hop topology invalid" },
  rollout_conflict: { zh: "该 Forward 正在更新中", en: "Forward rollout in progress" },
  db_unavailable: { zh: "控制面数据库不可用", en: "Control-plane DB unavailable" },
};

/* ------------------------------------------------------------------ */
/* 可见性 / selector / 模板摘要                                        */
/* ------------------------------------------------------------------ */

export interface VisibilityText {
  label: string;
  /** 面向管理员的一句解释（谁能看到 / 谁能选） */
  hint: string;
  tone: "success" | "secondary" | "outline" | "muted";
}

export function visibilityText(locale: string, visibility: string): VisibilityText {
  const zh = locale !== "en";
  switch (visibility) {
    case "PUBLIC":
      return {
        label: zh ? "公开" : "PUBLIC",
        hint: zh ? "所有满足条件的用户可选" : "Selectable by every eligible user",
        tone: "success",
      };
    case "ASSIGNED":
      return {
        label: zh ? "指定授权" : "ASSIGNED",
        hint: zh ? "仅被显式授权的 Workspace / Plan 可选" : "Only explicitly assigned Workspace / Plan",
        tone: "secondary",
      };
    case "INTERNAL":
      return {
        label: zh ? "内部" : "INTERNAL",
        hint: zh ? "仅本 workspace 管理面可见可用" : "Manager-only inside this workspace",
        tone: "outline",
      };
    default:
      return { label: visibility, hint: zh ? "未知可见性（后端 fail-closed）" : "Unknown visibility", tone: "muted" };
  }
}

export function isKnownVisibility(v: string): boolean {
  return (ROUTE_PROFILE_VISIBILITIES as readonly string[]).includes(v);
}

/** 单个 selector 的人读描述。 */
export function selectorLabel(selector: RouteSelector | null | undefined): string {
  if (!selector) return "—";
  if (selector.kind === "fixed_node") return `node#${selector.node_id}`;
  return `group#${selector.node_group_id} (${selector.strategy})`;
}

export interface HopDisplay {
  index: number;
  role: "ingress" | "middle" | "egress";
  /** 角色标签（入口 / 中转 / 出口） */
  roleLabel: string;
  selector: string;
}

/**
 * 有序跳链（**顺序即执行顺序**）。
 *
 * 中间跳的顺序是模板语义的一部分（§9.4.3：RoutePlan 必须是确定的具体路径），
 * 所以这里返回的是数组而不是集合，界面按 index 明确标号。
 */
export function hopChain(locale: string, template: RouteProfileTemplate | null | undefined): HopDisplay[] {
  if (!template) return [];
  const zh = locale !== "en";
  const out: HopDisplay[] = [
    { index: 0, role: "ingress", roleLabel: zh ? "入口" : "ingress", selector: selectorLabel(template.ingress) },
  ];
  (template.transit ?? []).forEach((t, i) => {
    out.push({ index: i + 1, role: "middle", roleLabel: zh ? `中转 ${i + 1}` : `transit ${i + 1}`, selector: selectorLabel(t) });
  });
  out.push({
    index: out.length,
    role: "egress",
    roleLabel: zh ? "出口" : "egress",
    selector: template.egress === null ? (zh ? "同入口（直连）" : "same as ingress (direct)") : selectorLabel(template.egress),
  });
  return out;
}

/** 一句话摘要（列表列用）。 */
export function templateSummary(locale: string, template: RouteProfileTemplate | null | undefined): string {
  return hopChain(locale, template)
    .map((h) => h.selector)
    .join(" → ");
}

/* ------------------------------------------------------------------ */
/* 模板编辑（有序 transit 的操作都是纯函数，便于单测）                   */
/* ------------------------------------------------------------------ */

/** 第一阶段：整条路由最多 3 跳 ⇒ 最多 1 个中间跳（与后端 `MAX_ROUTE_HOPS` 同口径）。 */
export const MAX_TRANSIT = 1;

export const EMPTY_TEMPLATE: RouteProfileTemplate = {
  ingress: { kind: "fixed_node", node_id: 0 },
  transit: [],
  egress: null,
  ingress_policy: null,
  egress_policy: null,
  constraints: null,
  required_capabilities: null,
};

/** 追加一个中间跳（超出第一阶段上限时原样返回，由 UI 禁用按钮）。 */
export function addTransit(template: RouteProfileTemplate, nodeId: number): RouteProfileTemplate {
  if (template.transit.length >= MAX_TRANSIT) return template;
  return { ...template, transit: [...template.transit, { kind: "fixed_node", node_id: nodeId }] };
}

export function removeTransit(template: RouteProfileTemplate, index: number): RouteProfileTemplate {
  if (index < 0 || index >= template.transit.length) return template;
  return { ...template, transit: template.transit.filter((_, i) => i !== index) };
}

/**
 * 上移 / 下移中间跳。
 *
 * 第一版最多 1 个中间跳，因此当前是「空操作」；但函数语义与顺序模型已经就位：
 * 放开多中间跳时，编辑器不需要重写（顺序变更即版本内容变更）。
 */
export function moveTransit(template: RouteProfileTemplate, index: number, delta: number): RouteProfileTemplate {
  const target = index + delta;
  if (index < 0 || index >= template.transit.length) return template;
  if (target < 0 || target >= template.transit.length) return template;
  const next = [...template.transit];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return { ...template, transit: next };
}

/** 稳定序列化（比较内容是否变过；键顺序固定，避免「看着没变其实变了」）。 */
export function stableTemplateJson(template: RouteProfileTemplate): string {
  const norm = {
    ingress: template.ingress,
    transit: (template.transit ?? []).map((t: RouteFixedNodeSelector) => ({ kind: t.kind, node_id: t.node_id })),
    egress: template.egress,
    ingress_policy: template.ingress_policy ?? null,
    egress_policy: template.egress_policy ?? null,
    constraints: template.constraints ?? null,
    required_capabilities: template.required_capabilities ?? null,
  };
  return JSON.stringify(norm);
}

/**
 * 模板内容是否真的变了 —— **这是「原地改」与「发新版本」的分界点**。
 *
 * 变了就必须走 `POST /:id/versions`（新版本），不能走 PATCH：共享模板的编辑
 * 不得静默重写正在运行的 Forward（§9.4.5）。
 */
export function templateContentChanged(current: RouteProfileTemplate | null | undefined, next: RouteProfileTemplate): boolean {
  if (!current) return true;
  return stableTemplateJson(current) !== stableTemplateJson(next);
}

/** constraints 的键集合（未知键 fail-closed，编辑器只允许这几项）。 */
export const CONSTRAINT_FIELDS = ["exclude_node_ids", "allowed_lifecycles", "require_health", "require_node_binding"] as const;

/** capabilities 归一化：去空、去重、null = 不要求。 */
export function normalizeCapabilities(raw: string[] | string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  const list = (Array.isArray(raw) ? raw : String(raw).split(","))
    .map((s) => String(s).trim())
    .filter((s) => s !== "");
  const unique: string[] = [];
  for (const cap of list) if (!unique.includes(cap)) unique.push(cap);
  return unique.length ? unique : null;
}

export function normalizeNumberList(raw: string | number[] | null | undefined): number[] | null {
  if (raw === null || raw === undefined) return null;
  const list = (Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/))
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  const unique: number[] = [];
  for (const n of list) if (!unique.includes(n)) unique.push(n);
  return unique.length ? unique : null;
}

export function normalizeConstraints(raw: {
  exclude_node_ids?: string | number[];
  allowed_lifecycles?: string | string[];
  require_health?: string | string[];
  require_node_binding?: boolean;
}): RouteProfileConstraints | null {
  const constraints: RouteProfileConstraints = {};
  const exclude = normalizeNumberList(raw.exclude_node_ids);
  if (exclude) constraints.exclude_node_ids = exclude;
  const lifecycles = normalizeCapabilities(raw.allowed_lifecycles ?? null);
  if (lifecycles) constraints.allowed_lifecycles = lifecycles;
  const health = normalizeCapabilities(raw.require_health ?? null);
  if (health) constraints.require_health = health;
  if (raw.require_node_binding === false) constraints.require_node_binding = false;
  return Object.keys(constraints).length ? constraints : null;
}

/* ------------------------------------------------------------------ */
/* Impact / apply 展示                                                 */
/* ------------------------------------------------------------------ */

/** impact 条目「会发生什么」的一句话（change 为 null 表示本次无法解析）。 */
export function impactChangeText(locale: string, entry: Pick<RouteProfileImpactEntry, "change" | "resolves">): string {
  const zh = locale !== "en";
  if (!entry.resolves) return zh ? "按目标版本无法解析（见错误码）" : "Cannot resolve with the target version";
  if (!entry.change) return zh ? "无变化信息" : "No change info";
  const c = entry.change;
  if (c.noop) return zh ? "不需要改动（解析结果相同）" : "No-op (same resolution)";
  const parts: string[] = [];
  if (c.ingress_change) parts.push(zh ? "入口变" : "ingress");
  if (c.middle_change) parts.push(zh ? "中转变" : "middle");
  if (c.egress_change) parts.push(zh ? "出口变" : "egress");
  return zh ? `${parts.join(" / ")} → 会重下发` : `${parts.join(" / ")} will be re-dispatched`;
}

/** 把跳链渲染成 `node#1 → node#4 → group#3`（impact 的 before/after 对比用）。 */
export function hopsLabel(hops: Array<{ role: string; node_id: number }> | null | undefined): string {
  if (!hops || hops.length === 0) return "—";
  return hops.map((h) => `${h.role === "middle" ? "mid" : h.role}#${h.node_id}`).join(" → ");
}

/**
 * apply 的逐条结果摘要。
 *
 * `runtime_changed === false` 是**正常的**：只认领来源模板（路径没变），
 * 界面必须把「认领」与「重下发」分开说，否则运维会以为每次 apply 都在动流量。
 */
export function applyOutcomeText(locale: string, outcome: { status: string; runtime_changed?: boolean; revision?: number }): string {
  const zh = locale !== "en";
  if (outcome.status === "failed") return zh ? "失败" : "failed";
  if (outcome.status === "previewed") return zh ? "预览（未下发）" : "previewed (no dispatch)";
  if (outcome.runtime_changed === false) {
    return zh ? `已认领来源模板（路径未变，revision ${outcome.revision ?? "—"}）` : "source claimed (path unchanged)";
  }
  return zh ? `已下发（revision ${outcome.revision ?? "—"}）` : `dispatched (revision ${outcome.revision ?? "—"})`;
}
