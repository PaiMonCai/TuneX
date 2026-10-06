/**
 * DDNS（DNS 前门）读投影契约 —— Web 侧唯一的形状定义。
 *
 * 权威依据（**不要**按想象扩展）：
 *   · `docs/agent/ddns-recon.md` §2 —— D4 交付的最终读投影契约与判定规则；
 *   · `backend/src/services/ddns-binding.ts`（`DnsBindingState` / `dnsBindingState`）；
 *   · `backend/src/routes/ddns.ts`、`backend/src/routes/forwards.ts`（DDNS 段）。
 *
 * ── 三条纪律（都是"禁止前端推断"的具体化）──
 *   1. **五态只读服务端**：`state` 不是这里算出来的，是 `dnsStateFor()` 的投影。
 *      未知/缺失的 `state` ⇒ `unreadable`（**绝不回落成 `unbound`**，那会把
 *      "取不到"渲染成"没有绑定"）。
 *   2. **三个新列 fail-closed**：`auto_resolve` 只有 `=== true` 才算开着；
 *      `attempt_count` 与 `next_attempt_at` 缺失即"没有待重试的计划"，绝不用 `0` 顶替
 *      （`0` 会被读成"重试过 0 次"这种不存在的计划）。
 *   3. **不猜地址**：`expected_values` 是服务端按入口 `connect_ip` 推导的，前端不拼、不补、
 *      不从域名或历史值推测。
 */

/** `dns_state` 的全部取值（与后端 `DNS_STATES` 逐字一致）。 */
export const DNS_STATES = ["unbound", "pending", "synced", "synced_unverified", "error"] as const;
export type DnsState = (typeof DNS_STATES)[number];

/** 协议允许的取值；**CNAME 首发不提供入口**（见 `docs/agent/ddns-recon.md` §3）。 */
export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

/** 协议允许的取值；**multi_entry 首发不提供入口**（今天只写 owner 单地址）。 */
export const DNS_MODES = ["multi_entry", "single_active"] as const;
export type DnsMode = (typeof DNS_MODES)[number];

/** 与 `prisma/schema.prisma` 的 `DNSProviderType` 枚举逐字一致（后端也只收这两个）。 */
export const DNS_PROVIDER_TYPES = ["cloudflare", "huawei"] as const;
export type DnsProviderType = (typeof DNS_PROVIDER_TYPES)[number];

/**
 * `GET/POST/DELETE /api/forwards/:id/dns` 的 `data` 形状（D4 最终契约）。
 *
 * `state === "unbound"` 时**其余字段一律不参与判断**：未绑定行的 `expected_values`
 * 仍可能是"当前 owner 地址"（既有行为），所以它不能当作"已绑定"的证据。
 */
export interface DnsBindingState {
  state: DnsState;
  domain: string | null;
  record_type: DnsRecordType | null;
  mode: DnsMode | null;
  provider_id: number | null;
  expected_values: string[];
  confirmed_values: string[];
  synced_at: string | null;
  verified: boolean;
  /** 后端已脱敏且截断到 ≤120 字符；原样展示，不二次加工。 */
  last_error: string | null;
  /**
   * F5.3 自动同步开关的**服务端真相**。`false` 时执行器第一个分支就 `noop`（零外呼），
   * 所以"界面说会自动切换"在 `false` 时是一句谎。
   */
  auto_resolve: boolean;
  /** 连续失败计数；`null` = 此刻不对应任何可执行的重试。**不是 0**。 */
  attempt_count: number | null;
  /** 下一次允许尝试的最早时刻（ISO-8601）；`null` = 没有待重试的失败。 */
  next_attempt_at: string | null;
}

/** `GET /api/ddns/providers` 的条目形状；**永不含凭据**（连封存态都不给）。 */
export interface DnsProviderView {
  id: number;
  name: string;
  /** 后端这里是 DB 枚举字符串；用 `string` 接住未知值，不假装只有两种。 */
  type: string;
  workspace_id: number | null;
  platform_level: boolean;
  has_credential: boolean;
  created_at: string | null;
}

/**
 * `POST /api/ddns/providers` 的请求体（与后端 `ProviderSchema` 同形，`.strict()`）。
 *
 * `credential.token` 是**只写**字段：提交成功后立刻从组件状态里清掉，不回填、
 * 不进 URL/toast/localStorage/SSR/日志。
 */
export interface DnsProviderInput {
  name: string;
  type: DnsProviderType;
  credential: {
    token: string;
    endpoint?: string;
    zone?: string;
  };
  /** 平台级 provider 只有平台管理员能建；本切片不提供该入口，字段留给契约完整性。 */
  platform_level?: boolean;
}

/**
 * `POST /api/forwards/:id/dns` 的请求体。
 *
 * 首发刻意收窄：`record_type` 只有 `A`/`AAAA`（CNAME 会被执行器写成一个 IP 值）、
 * `mode` 只有 `single_active`（`multi_entry` 今天只写 owner 单地址，不能当 HA 卖）。
 * `ttl_seconds` **不发送**：TTL 被后端接受后即丢弃（无列），UI 不得暴露一个不生效的开关。
 */
export interface DnsBindInput {
  domain: string;
  record_type: "A" | "AAAA";
  mode: "single_active";
  provider_id: number | null;
  auto_resolve: boolean;
}

/** 后端 DDNS 错误码全集（`DDNS_ERROR_CODES`）。UI 按码给"人话 + 下一步"。 */
export const DDNS_ERROR_CODES = {
  ddns_not_found: "ddns_not_found",
  dns_address_unavailable: "dns_address_unavailable",
  dns_domain_invalid: "dns_domain_invalid",
  dns_record_type_mismatch: "dns_record_type_mismatch",
  dns_mode_record_type_conflict: "dns_mode_record_type_conflict",
  dns_ttl_out_of_range: "dns_ttl_out_of_range",
  dns_provider_not_found: "dns_provider_not_found",
  dns_provider_forbidden: "dns_provider_forbidden",
  dns_provider_credential_invalid: "dns_provider_credential_invalid",
  shared_group_dns_denied: "shared_group_dns_denied",
  dns_not_bound: "dns_not_bound",
  dns_unavailable: "dns_unavailable",
} as const;
export type DdnsErrorCode = (typeof DDNS_ERROR_CODES)[keyof typeof DDNS_ERROR_CODES];

const STATE_SET: ReadonlySet<string> = new Set<string>(DNS_STATES);
const RECORD_TYPE_SET: ReadonlySet<string> = new Set<string>(DNS_RECORD_TYPES);
const MODE_SET: ReadonlySet<string> = new Set<string>(DNS_MODES);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function optionalIso(value: unknown): string | null {
  const text = nonEmptyString(value);
  // 契约是 ISO-8601 UTC。除了"能 parse"，还要求它长得像一个日期时间：
  // `Date.parse("0")` 在 V8 里是合法的（2000 年），而那**不是**服务端的时刻。
  if (text === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text)) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

/** 读取结果：要么是一份可以渲染的投影，要么是"读不出来"（**不是** `unbound`）。 */
export type DnsBindingReadResult =
  | { ok: true; state: DnsBindingState }
  | { ok: false; reason: "unreadable"; message: string };

/**
 * 把后端载荷读成 `DnsBindingState`。
 *
 * 这不是"再算一遍服务端判定"，而是**如实搬运 + 缺字段 fail-closed**：
 *   · `state` 必须是五个已知取值之一，否则整份载荷判为不可读（三态纪律：取不到 ≠ 没有）；
 *   · 三个新列缺失（例如运行中的镜像是 D4 之前的）按契约的服务端语义收敛：
 *     列缺失/NULL/非 `true` ⇒ `auto_resolve: false`，退避两列 ⇒ `null`。
 *     **不**用 `0`/空串顶替，也不因此编造"没有绑定"。
 */
export function dnsBindingStateFromPayload(payload: unknown): DnsBindingReadResult {
  const row = asRecord(payload);
  if (!row) return { ok: false, reason: "unreadable", message: "DNS 前门响应不是对象" };
  const state = row.state;
  if (typeof state !== "string" || !STATE_SET.has(state)) {
    return {
      ok: false,
      reason: "unreadable",
      message: typeof state === "string" ? `未知的 DNS 前门状态：${state}` : "DNS 前门响应缺少 state",
    };
  }
  const providerId = typeof row.provider_id === "number" && Number.isInteger(row.provider_id) ? row.provider_id : null;
  return {
    ok: true,
    state: {
      state: state as DnsState,
      domain: nonEmptyString(row.domain),
      record_type: typeof row.record_type === "string" && RECORD_TYPE_SET.has(row.record_type)
        ? (row.record_type as DnsRecordType)
        : null,
      mode: typeof row.mode === "string" && MODE_SET.has(row.mode) ? (row.mode as DnsMode) : null,
      provider_id: providerId,
      expected_values: stringList(row.expected_values),
      confirmed_values: stringList(row.confirmed_values),
      synced_at: optionalIso(row.synced_at),
      verified: row.verified === true,
      last_error: nonEmptyString(row.last_error),
      auto_resolve: row.auto_resolve === true,
      attempt_count: optionalCount(row.attempt_count),
      next_attempt_at: optionalIso(row.next_attempt_at),
    },
  };
}

/** 从 `ApiError`（或任何抛出的东西）里取出后端的 DDNS 错误码；取不到返回 `null`。 */
export function ddnsErrorCodeOf(error: unknown): DdnsErrorCode | null {
  const data = asRecord((error as { data?: unknown } | null)?.data);
  const code = data?.code;
  if (typeof code !== "string") return null;
  return (Object.values(DDNS_ERROR_CODES) as string[]).includes(code) ? (code as DdnsErrorCode) : null;
}

/**
 * 后端返回的 `message`（可读原句）。**不翻译、不改写**：
 * 未知码或未知情形时，原句比"操作失败"有用得多。
 */
export function apiMessageOf(error: unknown): string | null {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.trim() !== "" ? message : null;
}
