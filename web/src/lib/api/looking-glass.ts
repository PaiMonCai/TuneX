/**
 * Looking Glass（用户侧主动诊断）Web 契约 + API 客户端。
 *
 * 权威依据（都读过源码，不是推断）：
 *   · `backend/src/routes/looking-glass.ts`（两条路由与 RBAC：都是 `node:read` + 工作空间作用域，
 *     **不用** `node:manage` 代理执行权——把"能改节点"变成"能对任意公网目标发包"是权限放大）；
 *   · `backend/src/services/looking-glass.ts`（开关/上限/caveats/拒绝顺序/报告形状）；
 *   · `agent/internal/diag/looking-glass.go` + `probe.go`（七个结果状态是**闭集**）。
 *
 * ── 三个本模块必须如实搬运的事实 ──
 *  1. **缺省关闭**：`enabled` 只由 `LOOKING_GLASS_ENABLED` 显式真值决定（拼错=关）。缺省部署下
 *     这个能力是**关着的**，而**平台管理员仍有例外**（`platform_admin_override`）。
 *     `enabled:false` 读成"测试失败"、或把取不到状态读成"没开启"，都是本模块要拦住的误读。
 *  2. **能力边界**：只有 `tcp_connect`；`caps.max_targets` / `max_pinned_addresses` /
 *     `default_timeout_ms` / `max_timeout_ms` 全部**读服务端**（前端不许硬编码 4/3000/5000）。
 *  3. **发起是写操作**：`POST` 会让**那个节点**向目标发起 TCP 连接并写审计。
 *     因此"没发起"与"发起了但没拿到结果"必须是两个状态（见 `lookingGlassFailureKind`）。
 */
import { get, post, request } from "./core";

/* ================================================================== */
/* 形状（服务端逐字）                                                    */
/* ================================================================== */

/** `GET /api/looking-glass/status` 的 `data`。 */
export interface LookingGlassCaps {
  max_targets: number;
  max_pinned_addresses: number;
  default_timeout_ms: number;
  max_timeout_ms: number;
  methods: string[];
}

export interface LookingGlassStatus {
  enabled: boolean;
  /** 开关名（缺省关闭时界面要能告诉用户"哪个开关"）。 */
  switch_env: string;
  /** 关闭时平台管理员仍可发起（真实响应里 super_admin 为 true）。 */
  platform_admin_override: boolean;
  method: string;
  caps: LookingGlassCaps;
  /** 服务端对目标范围的结论（**中文散文**，界面据此写自己的 zh/en 文案，不照搬这句）。 */
  targets: string;
  /** 服务端口径声明（中文）。界面用自己的 zh/en 结论呈现，数量不符时把原始声明也列出来。 */
  caveats: string[];
}

export interface LookingGlassTarget {
  host: string;
  port: number;
}

export interface LookingGlassPinnedTarget {
  address: string;
  port: number;
}

/**
 * 单条探测结果。`status` 是 Agent 侧的**闭集**（`agent/internal/diag/probe.go`）。
 *
 * 界面按状态分支，**不许**把未知状态渲染成 `reachable`：
 *   · `reachable` —— TCP 握手完成（**只**证明这一跳的 L3/L4 通，不证明对端业务可用）；
 *   · `refused`   —— 对端（或前面某层）主动拒绝；
 *   · `timeout`   —— 死线内没有应答（静默丢包/防火墙）；
 *   · `dns_error` —— 名字无法解析（注意：域名是**面板**解析的，所以这一条在实践中出现于
 *                    节点被要求解析时；面板侧解析失败走 `target_unresolved` 拒绝）；
 *   · `invalid_target` / `error` / `unsupported`。
 */
export const LOOKING_GLASS_RESULT_STATUSES = [
  "reachable",
  "refused",
  "timeout",
  "dns_error",
  "invalid_target",
  "error",
  "unsupported",
] as const;
export type LookingGlassResultStatus = (typeof LOOKING_GLASS_RESULT_STATUSES)[number];

export interface LookingGlassResultRow {
  address: string;
  port: number;
  /** 闭集之外的取值照原样带着（界面写"服务端返回了未知状态"），**不**降级成 reachable。 */
  status: string;
  elapsed_ms: number;
  detail?: string;
}

export interface LookingGlassReport {
  node: { id: number; node_key: string };
  generated_at: string;
  method: string;
  /** 这次为什么能跑：`enabled` 开关本身，还是**管理员例外**（透明化，别让例外看起来像常态）。 */
  entry: { enabled: boolean; admin_override: boolean };
  requested: LookingGlassTarget[];
  /** 面板解析后**钉死**的地址：节点只拨这些字面地址，不做任何名称解析。 */
  pinned: LookingGlassPinnedTarget[];
  pinned_by_host: Array<{ host: string; addresses: string[] }>;
  results: LookingGlassResultRow[];
  caveats: string[];
}

/** POST 的请求体。`timeout_ms` 省略 = 服务端默认（`caps.default_timeout_ms`）。 */
export interface LookingGlassRunInput {
  targets: LookingGlassTarget[];
  method?: string;
  timeout_ms?: number;
}

/* ================================================================== */
/* 拒绝码（真实 HTTP 逐条核对过）                                        */
/* ================================================================== */

export const LOOKING_GLASS_CODES = {
  disabled: "looking_glass_disabled",
  busy: "looking_glass_busy",
  notFound: "not_found",
  tooManyTargets: "too_many_targets",
  tooManyAddresses: "too_many_pinned_addresses",
  duplicateTarget: "duplicate_target",
  invalidPort: "invalid_port",
  addressNotCanonical: "address_not_canonical",
  specialUseName: "special_use_name",
  invalidHostname: "invalid_hostname",
  targetNotPublic: "target_not_public",
  targetUnresolved: "target_unresolved",
  resolverInvalid: "resolver_returned_invalid_address",
  methodNotSupported: "method_not_supported",
  timeoutOutOfRange: "timeout_out_of_range",
  auditUnavailable: "audit_unavailable",
  agentFailed: "agent_failed",
  incompleteResult: "incomplete_result",
  invalidResult: "invalid_result",
  invalidBody: "invalid_body",
  /** ACK 预算内没等到节点回话（`agent-command-bus.ts` 的 `ack_timeout`）。 */
  ackTimeout: "ack_timeout",
  /** 旧 Agent 没广告这个动作（能力协商拒绝，`runtime-admission.ts`）。 */
  upgradeRequired: "upgrade_required",
  incompatibleAgent: "incompatible_agent",
  runtimeFeatureNotSupported: "runtime_feature_not_supported",
  malformedCapabilityManifest: "malformed_capability_manifest",
  protocolNotSupported: "protocol_not_supported",
  transportNotSupported: "transport_not_supported",
  invalidPayload: "invalid_payload",
  /** 工作空间作用域/角色不足（中间件层，码可能不同；未知码走原句回落）。 */
  permissionDenied: "permission_denied",
} as const;

/**
 * 「这次有没有真的发出测试」——**这是本功能最容易说错的一句**。
 *
 * `runLookingGlass` 的拒绝顺序（`services/looking-glass.ts:978+`）保证：
 * 开关 → 节点归属 → 方法/超时 → 目标写法与公网判定 → 单飞 → 能力协商 → **审计** → 下发。
 * 也就是说上面这些拒绝**全部发生在发包之前**；只有下发之后的失败才可能"已经拨过"。
 * 而"下发之后失败"（ACK 超时 / Agent 报错 / 结果不合规）里，面板**无法确认**到底拨没拨
 * ——所以 `issued_without_result` 的说法必须是"没有拿到结果"，不是"没有发出"。
 */
export type LookingGlassFailureKind =
  | "not_issued"
  | "issued_without_result"
  | "unknown";

const NOT_ISSUED_CODES = new Set<string>([
  LOOKING_GLASS_CODES.disabled,
  LOOKING_GLASS_CODES.busy,
  LOOKING_GLASS_CODES.notFound,
  LOOKING_GLASS_CODES.tooManyTargets,
  LOOKING_GLASS_CODES.tooManyAddresses,
  LOOKING_GLASS_CODES.duplicateTarget,
  LOOKING_GLASS_CODES.invalidPort,
  LOOKING_GLASS_CODES.addressNotCanonical,
  LOOKING_GLASS_CODES.specialUseName,
  LOOKING_GLASS_CODES.invalidHostname,
  LOOKING_GLASS_CODES.targetNotPublic,
  LOOKING_GLASS_CODES.targetUnresolved,
  LOOKING_GLASS_CODES.resolverInvalid,
  LOOKING_GLASS_CODES.methodNotSupported,
  LOOKING_GLASS_CODES.timeoutOutOfRange,
  LOOKING_GLASS_CODES.auditUnavailable,
  LOOKING_GLASS_CODES.invalidBody,
  LOOKING_GLASS_CODES.upgradeRequired,
  LOOKING_GLASS_CODES.incompatibleAgent,
  LOOKING_GLASS_CODES.runtimeFeatureNotSupported,
  LOOKING_GLASS_CODES.malformedCapabilityManifest,
  LOOKING_GLASS_CODES.protocolNotSupported,
  LOOKING_GLASS_CODES.transportNotSupported,
  LOOKING_GLASS_CODES.invalidPayload,
  LOOKING_GLASS_CODES.permissionDenied,
]);

const ISSUED_WITHOUT_RESULT_CODES = new Set<string>([
  LOOKING_GLASS_CODES.ackTimeout,
  LOOKING_GLASS_CODES.agentFailed,
  LOOKING_GLASS_CODES.incompleteResult,
  LOOKING_GLASS_CODES.invalidResult,
]);

export function lookingGlassFailureKind(code: string | null | undefined): LookingGlassFailureKind {
  const normalized = typeof code === "string" ? code.trim().toLowerCase() : "";
  if (normalized === "") return "unknown";
  if (NOT_ISSUED_CODES.has(normalized)) return "not_issued";
  if (ISSUED_WITHOUT_RESULT_CODES.has(normalized)) return "issued_without_result";
  return "unknown";
}

/* ================================================================== */
/* 读取（fail-closed）                                                  */
/* ================================================================== */

export type LookingGlassReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "unreadable"; message: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * 读 `GET /status` 的载荷。
 *
 * **`enabled` 缺失/非布尔 ⇒ 整份判不可读**：把它当 `false` 会让"取不到状态"变成
 * "平台没开启这项诊断"——那是两件完全不同的事（后者是一个可行动的产品结论）。
 */
export function lookingGlassStatusFromPayload(payload: unknown): LookingGlassReadResult<LookingGlassStatus> {
  const row = asRecord(payload);
  if (!row) return { ok: false, reason: "unreadable", message: "响应不是对象" };
  if (typeof row.enabled !== "boolean") {
    return { ok: false, reason: "unreadable", message: "响应缺少布尔字段 enabled" };
  }
  const caps = asRecord(row.caps);
  const maxTargets = positiveInt(caps?.max_targets);
  const maxPinned = positiveInt(caps?.max_pinned_addresses);
  const defaultTimeout = positiveInt(caps?.default_timeout_ms);
  const maxTimeout = positiveInt(caps?.max_timeout_ms);
  if (!caps || maxTargets === null || defaultTimeout === null || maxTimeout === null) {
    return { ok: false, reason: "unreadable", message: "响应缺少 caps（max_targets / 超时上限）" };
  }
  const caveats = Array.isArray(row.caveats) ? row.caveats.filter((item): item is string => typeof item === "string") : null;
  if (caveats === null) return { ok: false, reason: "unreadable", message: "响应缺少 caveats 数组" };
  return {
    ok: true,
    value: {
      enabled: row.enabled,
      switch_env: nonEmptyString(row.switch_env) ?? "LOOKING_GLASS_ENABLED",
      platform_admin_override: row.platform_admin_override === true,
      method: nonEmptyString(row.method) ?? "tcp_connect",
      caps: {
        max_targets: maxTargets,
        max_pinned_addresses: maxPinned ?? maxTargets,
        default_timeout_ms: defaultTimeout,
        max_timeout_ms: maxTimeout,
        methods: Array.isArray(caps.methods) ? caps.methods.filter((item): item is string => typeof item === "string") : [],
      },
      targets: typeof row.targets === "string" ? row.targets : "",
      caveats,
    },
  };
}

/**
 * 读 `POST .../tests` 的报告。
 *
 * `results` 里每条的 `status` **原样保留**（包括闭集之外的取值）：闭集之外的答案
 * 说明协议漂移，界面要能说"未知状态"，绝不降级成 `reachable`。
 */
export function lookingGlassReportFromPayload(payload: unknown): LookingGlassReadResult<LookingGlassReport> {
  const row = asRecord(payload);
  if (!row) return { ok: false, reason: "unreadable", message: "报告不是对象" };
  const node = asRecord(row.node);
  const entry = asRecord(row.entry);
  if (!node || positiveInt(node.id) === null || !entry || typeof entry.enabled !== "boolean") {
    return { ok: false, reason: "unreadable", message: "报告缺少 node/entry" };
  }
  if (!Array.isArray(row.results)) return { ok: false, reason: "unreadable", message: "报告缺少 results 数组" };
  const results: LookingGlassResultRow[] = [];
  for (const item of row.results) {
    const result = asRecord(item);
    if (!result) return { ok: false, reason: "unreadable", message: "结果条目不是对象" };
    const address = nonEmptyString(result.address);
    const port = positiveInt(result.port);
    const status = nonEmptyString(result.status);
    const elapsed = typeof result.elapsed_ms === "number" && Number.isFinite(result.elapsed_ms) ? result.elapsed_ms : null;
    if (address === null || port === null || status === null || elapsed === null) {
      return { ok: false, reason: "unreadable", message: "结果条目缺 address/port/status/elapsed_ms" };
    }
    results.push({
      address,
      port,
      status,
      elapsed_ms: elapsed,
      ...(nonEmptyString(result.detail) === null ? {} : { detail: nonEmptyString(result.detail)! }),
    });
  }
  const generatedAt = nonEmptyString(row.generated_at);
  if (generatedAt === null) return { ok: false, reason: "unreadable", message: "报告缺少 generated_at" };
  return {
    ok: true,
    value: {
      node: { id: Number(node.id), node_key: nonEmptyString(node.node_key) ?? String(node.id) },
      generated_at: generatedAt,
      method: nonEmptyString(row.method) ?? "tcp_connect",
      entry: { enabled: entry.enabled, admin_override: entry.admin_override === true },
      requested: Array.isArray(row.requested) ? (row.requested as LookingGlassTarget[]) : [],
      pinned: Array.isArray(row.pinned) ? (row.pinned as LookingGlassPinnedTarget[]) : [],
      pinned_by_host: Array.isArray(row.pinned_by_host)
        ? (row.pinned_by_host as LookingGlassReport["pinned_by_host"])
        : [],
      results,
      caveats: Array.isArray(row.caveats) ? row.caveats.filter((item): item is string => typeof item === "string") : [],
    },
  };
}

/** 从 `ApiError` 里取拒绝码（未知码返回 null，界面回落后端原句）。 */
export function lookingGlassErrorCodeOf(error: unknown): string | null {
  const data = asRecord((error as { data?: unknown } | null)?.data);
  const code = nonEmptyString(data?.code);
  return code === null ? null : code.toLowerCase();
}

export function lookingGlassErrorMessageOf(error: unknown): string | null {
  return nonEmptyString((error as { message?: unknown } | null)?.message);
}

/** 判定这次失败属于"服务端拒绝了"还是"没有权限"（403 且不是 disabled）。 */
export function lookingGlassIsPermissionFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 && lookingGlassErrorCodeOf(error) !== LOOKING_GLASS_CODES.disabled;
}

/* ================================================================== */
/* API                                                                 */
/* ================================================================== */

export const lookingGlassApi = {
  /**
   * 开关与线形上限。**不带 workspace 作用域**：服务端这条路由只读开关本身，
   * 不碰任何工作空间数据（真机实测：不带/带上 `x-workspace-id` 都是 200）。
   */
  status: (cookie?: string) => get<unknown>("/looking-glass/status", undefined, cookie),
  /**
   * 对某个节点发起一次有界测试（**写操作**：该节点会真的拨目标 + 写审计）。
   * 节点标识既可以是数字主键，也可以是 `node_id` 字符串（服务端 `resolveNodeId` 两种都收）。
   */
  runTests: (input: { workspaceId: number; nodeId: number | string; payload: LookingGlassRunInput; cookie?: string }) =>
    request<unknown>(`/looking-glass/nodes/${input.nodeId}/tests`, {
      method: "POST",
      workspaceId: input.workspaceId,
      body: input.payload,
      cookie: input.cookie,
    }),
  /** 便捷包装：直接读成校验过的状态（失败时给"取不到"而不是"没开启"）。 */
  readStatus: async (cookie?: string): Promise<LookingGlassReadResult<LookingGlassStatus>> => {
    const payload = await lookingGlassApi.status(cookie);
    return lookingGlassStatusFromPayload(payload);
  },
  /** 便捷包装：发起并读成校验过的报告。 */
  runAndRead: async (input: {
    workspaceId: number;
    nodeId: number | string;
    payload: LookingGlassRunInput;
    cookie?: string;
  }): Promise<LookingGlassReadResult<LookingGlassReport>> => {
    const payload = await lookingGlassApi.runTests(input);
    return lookingGlassReportFromPayload(payload);
  },
};

// `post` 目前不需要（POST 走 request 是为了显式带 workspaceId）；保留导入会让 lint 抱怨，
// 因此这里显式引用一次以免误删：本模块的写路径就是 request(..., { method: "POST" })。
void post;

export { asRecord as lookingGlassAsRecord };
