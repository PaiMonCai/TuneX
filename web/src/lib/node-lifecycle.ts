/**
 * V4-WP7 §13.4.2/§13.4.3 —— Node 生命周期的**纯展示逻辑**（无 React / 无网络 / 无 IO）。
 *
 * ── 边界（本模块存在的唯一理由）──
 * 迁移合法性、准入、依赖闸门的**判定权全在服务端**（`services/node-lifecycle.ts`）。
 * 本模块只做「后端结论 → 界面元素」的翻译：
 *   · 把 `allowed_transitions` 排成固定顺序的按钮集合；
 *   · 把 `impact` 五类计数摆成可读条目；
 *   · 把 `connection` 映射成安装等待闭环的阶段。
 *
 * 前端**绝不**重新实现 `canTransition` / `nodeAdmission` / `deleteGates`：
 * 服务层加一个状态而前端没跟上时，复刻的判据会给出「按钮能点但 PATCH 409」，
 * 正是 §13.4.2 要消除的漂移形态。
 *
 * ── 唯一的例外（且已标注为预览）──
 * `deletePreview()` 复制了后端 deleteGates 的**顺序**用于提前禁用按钮并列出
 * 要清什么。它**不是**安全边界：真正的裁决永远是 `DELETE` 返回的
 * `code` / `condition` / `dependencies`（见设计决策 D3）。
 */
import type {
  NodeAdmissionRejection,
  NodeConnectionValue,
  NodeImpact,
  NodeLifecycleConditionCode,
  NodeLifecycleValue,
} from "./types";

/** 生命周期枚举（后端 schema `enum NodeLifecycle` 的镜像）。 */
export const NODE_LIFECYCLES: NodeLifecycleValue[] = ["active", "maintenance", "disabled", "retiring"];

/** 界面展示顺序：正常 → 降级 → 终止（与健康徽章的严重度方向一致）。 */
export const LIFECYCLE_ORDER: NodeLifecycleValue[] = NODE_LIFECYCLES;

/** 连接态枚举（§13.4.1 Connection 层）。 */
export const NODE_CONNECTIONS: NodeConnectionValue[] = ["waiting", "online", "offline"];

export function isLifecycleValue(v: unknown): v is NodeLifecycleValue {
  return typeof v === "string" && (NODE_LIFECYCLES as string[]).includes(v);
}

/**
 * `retiring` 是单向门：进入后唯一出口是物理删除（WP5 契约显式拒绝
 * `retiring → *`）。
 *
 * 因此 UI **不得**渲染「取消退役」按钮——一个必然 409 的按钮比没有按钮更糟：
 * 用户会以为是自己操作错了。
 */
export function isTerminalLifecycle(lifecycle: string | null | undefined): boolean {
  return lifecycle === "retiring";
}

/** 非 `active` 即「不接受新业务」的管理态（维护/停用/退役）。 */
export function isRestrictedLifecycle(lifecycle: string | null | undefined): boolean {
  return lifecycle !== null && lifecycle !== undefined && lifecycle !== "active";
}

/** 最小可渲染视图形状（避免本模块依赖完整的 NodeLifecycleView）。 */
export interface LifecycleTransitionsInput {
  lifecycle: string;
  allowed_transitions?: string[] | null;
}

/**
 * 推导可用的生命周期操作按钮。
 *
 * 三条纪律：
 *   1. **只信 `allowed_transitions`**（服务端 `canTransition` 的输出）；
 *   2. 顺序按 `LIFECYCLE_ORDER` 固定，不受后端数组顺序影响（否则按钮会跳位）；
 *   3. 去掉当前值——同值写是合法的幂等操作，但作为按钮没有意义。
 *
 * 后端字段缺失（旧后端 / 空响应）时返回空数组：宁可没有按钮，也不猜一个。
 */
export function lifecycleActionTargets(view: LifecycleTransitionsInput | null | undefined): NodeLifecycleValue[] {
  if (!view || !Array.isArray(view.allowed_transitions)) return [];
  const allowed = view.allowed_transitions.filter(isLifecycleValue);
  const out: NodeLifecycleValue[] = [];
  for (const target of LIFECYCLE_ORDER) {
    if (target === view.lifecycle) continue;
    if (!allowed.includes(target)) continue;
    out.push(target);
  }
  return out;
}

/* ================================================================== */
/* 依赖影响（§13.4.3 impact check）                                     */
/* ================================================================== */

/** 五类依赖计数的键（`blockers` 是描述文本，不属于计数）。 */
export type ImpactCountKey = Exclude<keyof NodeImpact, "blockers">;

export const IMPACT_COUNT_KEYS: ImpactCountKey[] = [
  "ingress_forward_count",
  "egress_forward_count",
  "binding_count",
  "active_port_lease_count",
  "egress_pool_count",
];

export interface ImpactEntry {
  key: ImpactCountKey;
  count: number;
}

/** 影响统计 → 展示条目（非数字按 0，避免渲染出 `undefined`）。 */
export function impactEntries(impact: NodeImpact | null | undefined): ImpactEntry[] {
  if (!impact || typeof impact !== "object") return [];
  const out: ImpactEntry[] = [];
  for (const key of IMPACT_COUNT_KEYS) {
    const raw = impact[key];
    out.push({ key, count: typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0 });
  }
  return out;
}

/** 是否没有任何依赖（空节点：删除的唯一额外前提就是先进入 retiring）。 */
export function impactIsEmpty(impact: NodeImpact | null | undefined): boolean {
  return impactEntries(impact).every((e) => e.count === 0);
}

/**
 * 删除预览闸门（**仅用于提前禁用按钮**，最终以 DELETE 的响应为准）。
 *
 * 判定顺序镜像后端 `deleteGates`（顺序即错误优先级）：
 *   1. 未进入 retiring → `node_not_retiring`；
 *   2. ingress / egress Forward 未清 → `node_still_used_as_*`；
 *   3. binding / 端口租约 / 出口池未清 → `dependency_blocked`。
 *
 * 「先要求退役再看依赖」是有意为之：没退役就删说明用户跳过了流程，
 * 此时给 `node_not_retiring` 比给一串依赖更有指导意义。
 */
export function deletePreview(
  lifecycle: string | null | undefined,
  impact: NodeImpact | null | undefined,
): { ok: true } | { ok: false; condition: NodeLifecycleConditionCode } {
  if (lifecycle !== "retiring") return { ok: false, condition: "node_not_retiring" };
  if (!impact) return { ok: true }; // 拿不到统计时不拦——服务端仍会裁决
  if ((impact.ingress_forward_count ?? 0) > 0) return { ok: false, condition: "node_still_used_as_ingress" };
  if ((impact.egress_forward_count ?? 0) > 0) return { ok: false, condition: "node_still_used_as_egress" };
  if (
    (impact.binding_count ?? 0) > 0 ||
    (impact.active_port_lease_count ?? 0) > 0 ||
    (impact.egress_pool_count ?? 0) > 0
  ) {
    return { ok: false, condition: "dependency_blocked" };
  }
  return { ok: true };
}

/* ================================================================== */
/* 安装等待闭环（§13.4.3 重新安装 Agent / waiting → online）             */
/* ================================================================== */

/**
 * 安装阶段（由 Connection 层 + 凭据存在性推导，**不新增在线判定**）。
 *
 *   awaiting_install —— 还没有凭据（`connection === "waiting"`）：等待安装
 *   online           —— 已连接：闭环达成
 *   installed_offline—— 有凭据但掉线（`offline`）：安装过了，是连接问题
 *   unknown          —— 缺少事实（新节点尚未上报 lifecycle 视图）
 *
 * 为什么区分「等待安装」与「已安装但掉线」：两者的下一步动作完全不同
 *（去执行安装命令 vs 去查机器/网络），§13.5 要求 Web 给用户正确下一步。
 */
export type InstallPhase = "awaiting_install" | "online" | "installed_offline" | "unknown";

export function installPhase(input: {
  connection?: string | null;
  has_credential?: boolean | null;
} | null | undefined): InstallPhase {
  if (!input) return "unknown";
  const connection = input.connection ?? null;
  if (connection === "online") return "online";
  if (connection === "waiting") return "awaiting_install";
  if (connection === "offline") {
    // 凭据存在性是「装过没有」的唯一事实；缺字段时按离线处理更好——
    // 说「等待安装」会让用户重复执行安装命令（而 rotate 会把线上 Agent 踢掉）。
    return input.has_credential === false ? "awaiting_install" : "installed_offline";
  }
  return "unknown";
}

/** 安装等待闭环是否已达成（轮询的终止条件）。 */
export function installClosureReached(phase: InstallPhase): boolean {
  return phase === "online";
}

/** 准入拒绝码 → 是否属于「去安装」这一类。
 *
 * `waiting` 的节点拒绝新业务是对的，但它的下一步是安装而不是改生命周期；
 * 把两者混在一句「该节点不可用」里，用户会去改一个没错的地方。
 */
export function isInstallAdmissionRejection(rejection: NodeAdmissionRejection | null | undefined): boolean {
  return rejection === "node_waiting_install";
}

/* ================================================================== */
/* 错误解析（把服务端拒绝码喂给文案表）                                  */
/* ================================================================== */

/** 从接口错误里抽出的生命周期拒绝信息。 */
export interface LifecycleErrorInfo {
  status: number | null;
  /** 管理端错误码（`invalid_input` / `invalid_state` / `dependency_blocked` / …）。 */
  code: string | null;
  /** 运行条件的具体拒绝码（`invalid_transition` / `node_still_used_as_ingress` / …）。 */
  condition: NodeLifecycleConditionCode | null;
  /** 面向用户的句子（后端 message；缺失时给兜底）。 */
  message: string;
  /** 未清空的依赖清单（`dependency_blocked` 时才有）。 */
  dependencies: NodeImpact | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readImpact(v: unknown): NodeImpact | null {
  if (!isRecord(v)) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    ingress_forward_count: num(v.ingress_forward_count),
    egress_forward_count: num(v.egress_forward_count),
    binding_count: num(v.binding_count),
    active_port_lease_count: num(v.active_port_lease_count),
    egress_pool_count: num(v.egress_pool_count),
    blockers: Array.isArray(v.blockers) ? v.blockers.filter((b): b is string => typeof b === "string") : [],
  };
}

/**
 * 把 `ApiError`（或任意抛出的值）解析成生命周期 UI 能用的拒绝信息。
 *
 * 后端契约（`routes/node-lifecycle.ts` 的 `lifecycleError`）把 `condition` /
 * `dependencies` 与 `code` **平级**放在响应顶层，前端从 `error.data.*` 读。
 * 这里额外容忍一层 `data.data` 嵌套：mock 的通用 `fail()` 用的是那种形状，
 * 而 mock 模式是前端演示与契约测试的运行环境——与其让界面在 mock 下退化成
 * 「操作失败」，不如让解析器容忍两种已知形状。**契约仍以后端顶层为准**。
 *
 * `condition` 缺失（例如旧后端 / 500）时返回 null，调用方回落 message。
 */
export function lifecycleErrorInfo(error: unknown): LifecycleErrorInfo {
  const status =
    isRecord(error) && typeof error.status === "number" && Number.isFinite(error.status) ? error.status : null;
  const message =
    isRecord(error) && typeof error.message === "string"
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const payload = isRecord(error) && isRecord(error.data) ? error.data : null;
  // 顶层优先；再容忍一层 `data.data`（见函数注释）。
  const nested = payload && isRecord(payload.data) ? payload.data : null;
  const read = (key: string): unknown => payload?.[key] ?? nested?.[key];
  const rawCondition = read("condition");
  const condition =
    typeof rawCondition === "string" && (NODE_LIFECYCLE_CONDITION_CODES as string[]).includes(rawCondition)
      ? (rawCondition as NodeLifecycleConditionCode)
      : null;
  return {
    status,
    code: typeof read("code") === "string" ? (read("code") as string) : null,
    condition,
    message,
    dependencies: readImpact(read("dependencies")),
  };
}

/** 已知条件码全集（与后端 `LifecycleConditionCode` + `node_waiting_install` 对齐）。 */
export const NODE_LIFECYCLE_CONDITION_CODES: string[] = [
  "invalid_transition",
  "node_in_maintenance",
  "node_disabled",
  "node_retiring",
  "node_not_retiring",
  "node_still_used_as_ingress",
  "node_still_used_as_egress",
  "dependency_blocked",
  "port_range_would_orphan_leases",
  "node_waiting_install",
];
