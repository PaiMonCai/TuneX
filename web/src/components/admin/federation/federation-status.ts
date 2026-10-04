import { ApiError } from "@/lib/api";
import {
  FEDERATION_ATTRIBUTION_HINTS,
  FEDERATION_ERROR_CODES,
  FEDERATION_LEASE_STATES,
  type FederationAttributionHint,
  type FederationErrorCode,
  type FederationGrantCapacity,
  type FederationGrantScope,
  type FederationLease,
  type FederationUsageRecord,
} from "@/lib/types";

/**
 * Admin Console 的**联邦展示层纯逻辑**（V5-WP14/15/16，§9.4.7 状态分层）。
 *
 * 三条纪律（都由单测钉住）：
 *
 * 1. **不把异常压成一个 ERROR**：后端错误码是闭集（契约 §6），每个码有自己的
 *    「下一步」文案与 `retryable`。网络不可达（`peer_unreachable`，可重试）、
 *    信任被撤销（`peer_revoked`，不可逆）、对端不认识我们的键（`key_unknown`）、
 *    grant 过期（`grant_expired`，要新开一个）、配额耗尽（`quota_exhausted`，
 *    要扩容或撤销旧租约）—— 这些在界面上必须长得不一样。
 * 2. **不做判定**：这里不推导「信任是否成立」「租约该不该过期」。只把后端给的
 *    事实翻译成文案与分组。
 * 3. **不丢精度**：用量字节数是字符串（后端 BigInt 序列化），求和/展示走 BigInt。
 *
 * 本模块不 import 任何 React，可在无浏览器环境下直接单测。
 */

/* ------------------------------------------------------------------ */
/* 错误分层                                                            */
/* ------------------------------------------------------------------ */

export interface FederationErrorInfo {
  /** 后端错误码；`null` = 响应里没有可识别的码（网络层错误等） */
  code: string | null;
  /** `code` 是否在契约闭集内 —— 闭集外的码要显式标成「未知码」，不许冒充已知语义 */
  known: boolean;
  message: string;
  retryable: boolean;
  peer_panel_id: string | null;
  correlation_id: string | null;
  /** HTTP 状态（ApiError.status）；非 ApiError 时为 null */
  status: number | null;
}

/** 从任意抛出的错误里提取**后端原始**联邦错误信息（不猜、不重写 message）。 */
export function federationErrorInfo(error: unknown): FederationErrorInfo {
  if (error instanceof ApiError) {
    const body = (error.data && typeof error.data === "object" ? error.data : {}) as Record<string, unknown>;
    const rawCode = typeof body.code === "string" && body.code.trim() !== "" ? body.code : null;
    return {
      code: rawCode,
      known: rawCode !== null && (FEDERATION_ERROR_CODES as readonly string[]).includes(rawCode),
      message: typeof body.message === "string" && body.message.trim() !== "" ? body.message : error.message,
      retryable: body.retryable === true,
      peer_panel_id: typeof body.peer_panel_id === "string" ? body.peer_panel_id : null,
      correlation_id: typeof body.correlation_id === "string" ? body.correlation_id : null,
      status: error.status,
    };
  }
  return {
    code: null,
    known: false,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    peer_panel_id: null,
    correlation_id: null,
    status: null,
  };
}

/**
 * 每个错误码的「下一步」。
 *
 * 用 `Record<FederationErrorCode, …>` 的穷尽表：后端往闭集里加码而这里没跟上时，
 * **编译失败**，而不是把新码静默渲染成通用错误（这正是 §9.4.7 要防的事）。
 */
export const FEDERATION_ERROR_ACTION: Record<FederationErrorCode, { zh: string; en: string }> = {
  federation_disabled: { zh: "先在本页顶部启用联邦", en: "Enable federation first" },
  peer_unknown: { zh: "对方不在信任列表里：先邀请并完成握手", en: "Unknown peer: invite and handshake first" },
  peer_revoked: { zh: "信任已撤销且不可逆：需要重新建立信任", en: "Trust was revoked (irreversible): re-establish trust" },
  peer_unreachable: { zh: "网络不可达：检查对端地址与网络后重试", en: "Peer unreachable: check endpoint/network and retry" },
  signature_invalid: { zh: "签名校验失败：不要重试，先核对两侧密钥", en: "Signature invalid: verify keys before retrying" },
  clock_skew: { zh: "两侧时钟偏差过大：先同步时间再重试", en: "Clock skew: sync time, then retry" },
  message_expired: { zh: "消息已过期（时序窗口）：可以重试", en: "Message expired: retry" },
  duplicate_message: { zh: "重复消息：已按幂等返回首次结果", en: "Duplicate message: first result returned (idempotent)" },
  message_malformed: { zh: "请求形状不合法：修正输入后重试", en: "Malformed request: fix the input and retry" },
  grant_not_found: { zh: "授予不存在：刷新列表", en: "Grant not found: refresh the list" },
  grant_not_active: { zh: "授予已撤销/挂起：新开一个授予或先恢复", en: "Grant is not active: create a new grant or resume" },
  grant_scope_violation: { zh: "范围不合法（未知键/越界）：按当前节点组与 hop 角色修正", en: "Scope violates the contract: fix node groups/hop roles" },
  grant_expired: { zh: "授予已过期：续期必须新开一个授予", en: "Grant expired: issue a new grant" },
  quota_exhausted: { zh: "配额已用尽：扩容授予或先撤销占用中的租约", en: "Quota exhausted: raise capacity or revoke live leases" },
  lease_not_found: { zh: "租约不存在：刷新列表", en: "Lease not found: refresh the list" },
  lease_expired: { zh: "租约已到期（host 已停服）", en: "Lease expired (host stopped serving)" },
  lease_revoked: { zh: "租约已被撤销", en: "Lease was revoked" },
  intent_revision_stale: { zh: "revision 落后：对账会收敛，无需手工重放", en: "Stale revision: reconcile will converge" },
  unsupported_topology: { zh: "该拓扑当前不支持：改用受支持的 hop 组合", en: "Unsupported topology: use a supported hop layout" },
  handshake_invalid: { zh: "邀请 token 无效或已使用：重新生成邀请", en: "Invitation token invalid/used: create a new invitation" },
  key_unknown: { zh: "对端不认识本机公钥：完成握手或轮转后再试", en: "Peer does not know our key: handshake or rotate first" },
  internal_error: { zh: "对端内部错误：稍后重试", en: "Peer internal error: retry later" },
};

/** 「下一步」文案（未知码回落通用建议，并保留原始码供展示）。 */
export function federationErrorAction(locale: string, code: string | null): string {
  if (code && (FEDERATION_ERROR_CODES as readonly string[]).includes(code)) {
    const entry = FEDERATION_ERROR_ACTION[code as FederationErrorCode];
    return locale === "en" ? entry.en : entry.zh;
  }
  return locale === "en"
    ? "Unknown error code: check the panel log with the correlation id"
    : "未知错误码：拿 correlation id 查面板日志";
}

/* ------------------------------------------------------------------ */
/* 状态词表（peer / grant / lease / placement）                         */
/* ------------------------------------------------------------------ */

export type BadgeTone = "success" | "secondary" | "outline" | "muted" | "destructive";

export interface StatusText {
  label: string;
  tone: BadgeTone;
}

const PEER_STATUS: Record<string, { zh: string; en: string; tone: BadgeTone }> = {
  active: { zh: "已建立信任", en: "Trusted", tone: "success" },
  pending: { zh: "待握手", en: "Awaiting handshake", tone: "outline" },
  revoked: { zh: "已撤销", en: "Revoked", tone: "destructive" },
};

const GRANT_STATUS: Record<string, { zh: string; en: string; tone: BadgeTone }> = {
  active: { zh: "生效中", en: "Active", tone: "success" },
  suspended: { zh: "已挂起", en: "Suspended", tone: "muted" },
  revoked: { zh: "已撤销", en: "Revoked", tone: "destructive" },
  expired: { zh: "已过期", en: "Expired", tone: "outline" },
};

const LEASE_STATE: Record<string, { zh: string; en: string; tone: BadgeTone }> = {
  reserved: { zh: "已预留", en: "Reserved", tone: "outline" },
  active: { zh: "服务中", en: "Active", tone: "success" },
  releasing: { zh: "停服中", en: "Releasing", tone: "muted" },
  released: { zh: "已释放", en: "Released", tone: "secondary" },
  expired: { zh: "已到期", en: "Expired", tone: "outline" },
  revoked: { zh: "已撤销", en: "Revoked", tone: "destructive" },
  failed: { zh: "失败", en: "Failed", tone: "destructive" },
};

function pick(locale: string, table: Record<string, { zh: string; en: string; tone: BadgeTone }>, key: string, fallbackZh: string): StatusText {
  const entry = table[key];
  if (!entry) return { label: `${fallbackZh}: ${key}`, tone: "muted" };
  return { label: locale === "en" ? entry.en : entry.zh, tone: entry.tone };
}

export const peerStatusText = (locale: string, status: string): StatusText => pick(locale, PEER_STATUS, status, "未知状态");
export const grantStatusText = (locale: string, status: string): StatusText => pick(locale, GRANT_STATUS, status, "未知状态");
export const leaseStateText = (locale: string, state: string): StatusText => pick(locale, LEASE_STATE, state, "未知状态");
export const placementStateText = (locale: string, state: string): StatusText => pick(locale, LEASE_STATE, state, "未知状态");

/** 租约是「终态」还是「仍在占用」——决定界面上是否还能对它做动作。 */
export function isLiveLease(lease: Pick<FederationLease, "state">): boolean {
  return ["reserved", "active", "releasing"].includes(String(lease.state));
}

/** 租约状态词表（测试遍历用）。 */
export const FEDERATION_KNOWN_LEASE_STATES: readonly string[] = FEDERATION_LEASE_STATES;

/* ------------------------------------------------------------------ */
/* revision / 时间展示                                                 */
/* ------------------------------------------------------------------ */

export interface LeaseRevisionView {
  requested: number | null;
  applied: number | null;
  /** 已下发的就是请求的那一版 */
  synced: boolean;
  /** 仍有未收敛的差距（applied < requested 或 applied 缺失） */
  lagging: boolean;
  text: string;
}

/**
 * 两个 revision **都摊开**（§9.4.7 要求）：只说「同步/不同步」会让人无法判断
 * 差多少、是不是卡住了。`applied === null` 表示还没下发过，不等于「等于 requested」。
 */
export function leaseRevisionView(lease: Pick<FederationLease, "requested_revision" | "applied_revision">, locale = "zh"): LeaseRevisionView {
  const requested = lease.requested_revision ?? null;
  const applied = lease.applied_revision ?? null;
  const synced = requested !== null && applied !== null && applied === requested;
  const lagging = requested !== null && (applied === null || applied < requested);
  const none = locale === "en" ? "not applied yet" : "尚未下发";
  const text =
    requested === null && applied === null
      ? "—"
      : `${applied === null ? none : applied} / ${requested === null ? "—" : requested}`;
  return { requested, applied, synced, lagging, text };
}

/** 过期与否：后端给的是权威 `expires_at`，前端只做「是否已过」的展示派生。 */
export function isExpired(iso: string | null, now: Date = new Date()): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now.getTime();
}

/* ------------------------------------------------------------------ */
/* 用量：attributed / unattributed 必须分开                             */
/* ------------------------------------------------------------------ */

export interface UsageTotals {
  bytes_in: string;
  bytes_out: string;
  connections: number;
  records: number;
}

export interface UsageSplit {
  attributed: FederationUsageRecord[];
  unattributed: FederationUsageRecord[];
  attributedTotals: UsageTotals;
  unattributedTotals: UsageTotals;
}

const ZERO: UsageTotals = { bytes_in: "0", bytes_out: "0", connections: 0, records: 0 };

function sum(rows: FederationUsageRecord[]): UsageTotals {
  // BigInt：后端把字节数序列化成字符串就是为了不丢精度，前端求和也不许经过 Number
  let bytesIn = 0n;
  let bytesOut = 0n;
  let connections = 0;
  for (const row of rows) {
    try {
      bytesIn += BigInt(row.bytes_in ?? "0");
    } catch {
      /* 非法值不并入（不猜、不静默换成 0 之外的数） */
    }
    try {
      bytesOut += BigInt(row.bytes_out ?? "0");
    } catch {
      /* 同上 */
    }
    connections += Number(row.connections ?? 0) || 0;
  }
  return { bytes_in: bytesIn.toString(), bytes_out: bytesOut.toString(), connections, records: rows.length };
}

/**
 * 把用量记录切成两桶。
 *
 * `unattributed` **必须单独可见**（契约 §4.2：归因不到就进单独桶并告警，绝不静默丢弃、
 * 也绝不混进正常行）。判定完全按后端给的 `attribution` 字段，前端不重新归因。
 */
export function splitUsage(rows: FederationUsageRecord[]): UsageSplit {
  const attributed = rows.filter((r) => r.attribution === "attributed");
  const unattributed = rows.filter((r) => r.attribution !== "attributed");
  return {
    attributed,
    unattributed,
    attributedTotals: attributed.length ? sum(attributed) : { ...ZERO },
    unattributedTotals: unattributed.length ? sum(unattributed) : { ...ZERO },
  };
}

/** BigInt 字节 → 人类可读（不经过 Number，避免 >2^53 丢精度）。 */
export function formatBytesBig(bytes: string | number | null | undefined): string {
  let value: bigint;
  try {
    value = typeof bytes === "bigint" ? bytes : BigInt(bytes ?? 0);
  } catch {
    return "—";
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const units: Array<[bigint, string]> = [
    [1024n * 1024n * 1024n * 1024n, "TB"],
    [1024n * 1024n * 1024n, "GB"],
    [1024n * 1024n, "MB"],
    [1024n, "KB"],
  ];
  for (const [size, unit] of units) {
    if (abs >= size) {
      const whole = abs / size;
      const tenth = (abs % size) * 10n / size;
      return `${negative ? "-" : ""}${whole}.${tenth} ${unit}`;
    }
  }
  return `${value.toString()} B`;
}

/* ------------------------------------------------------------------ */
/* scope / capacity 的可读投影                                          */
/* ------------------------------------------------------------------ */

export function scopeSummary(locale: string, scope: unknown): string {
  const s = (scope && typeof scope === "object" ? scope : {}) as Partial<FederationGrantScope>;
  const groups = Array.isArray(s.node_group_ids) ? s.node_group_ids : [];
  const roles = Array.isArray(s.hop_roles) ? s.hop_roles : [];
  const groupsText = groups.length ? groups.join(", ") : locale === "en" ? "none" : "无";
  const rolesText = roles.length ? roles.join(", ") : locale === "en" ? "none (deny)" : "无（拒绝）";
  const head = locale === "en" ? `node groups [${groupsText}] · hops ${rolesText}` : `节点组 [${groupsText}] · hop ${rolesText}`;
  if (s.allow_target_policy === null || s.allow_target_policy === undefined) return head;
  const policies = Array.isArray(s.allow_target_policy) ? s.allow_target_policy.join(", ") : String(s.allow_target_policy);
  return `${head} · ${locale === "en" ? "target policy" : "目标策略"} ${policies || "—"}`;
}

export function capacitySummary(locale: string, capacity: unknown): string {
  const c = (capacity && typeof capacity === "object" ? capacity : {}) as Partial<FederationGrantCapacity>;
  const n = locale === "en" ? "unlimited" : "不限";
  const legs = c.max_legs === null || c.max_legs === undefined ? n : String(c.max_legs);
  const mbps = c.max_bandwidth_mbps === null || c.max_bandwidth_mbps === undefined ? n : `${c.max_bandwidth_mbps} Mbps`;
  const conns = c.max_connections === null || c.max_connections === undefined ? n : String(c.max_connections);
  return `legs ${legs} · ${mbps} · conns ${conns}`;
}

/**
 * 未归因判据的文案（穷尽表：后端加判据 → 这里编译失败）。
 *
 * 措辞刻意是「可验证的判据」而不是「原因」：管理员能拿 lease_ref 自己去查
 * placement 行来确认，而不是相信一句我们猜的原因。
 */
export const FEDERATION_ATTRIBUTION_HINT_TEXT: Record<FederationAttributionHint, { zh: string; en: string }> = {
  no_local_placement: {
    zh: "本机没有这条租约的放置记录（本地无轨迹）",
    en: "No local placement row for this lease (no local trace)",
  },
  placement_conflict: {
    zh: "本机有放置记录却仍未归因 —— 两侧说法冲突，需要人工核对",
    en: "Local placement exists but attribution failed — the two sides disagree; needs manual review",
  },
};

/** 判据文案（未知值原样回显，不冒充已知判据）。 */
export function attributionHintText(locale: string, hint: string | null | undefined): string | null {
  if (!hint) return null;
  if ((FEDERATION_ATTRIBUTION_HINTS as readonly string[]).includes(hint)) {
    const entry = FEDERATION_ATTRIBUTION_HINT_TEXT[hint as FederationAttributionHint];
    return locale === "en" ? entry.en : entry.zh;
  }
  return hint;
}

/* ------------------------------------------------------------------ */
/* 邀请 token「只显示一次」                                             */
/* ------------------------------------------------------------------ */

/** 邀请响应里**唯一**含明文 token 的那份快照。 */
export interface InvitationOnceState {
  /** 明文 token；`null` = 已经不在内存里了（关闭/刷新后不可能再看到） */
  token: string | null;
  peer_id: number | null;
  expires_at: string | null;
  panel_id: string | null;
  key_id: string | null;
  /** 管理员已确认「已带外传递」 */
  acknowledged: boolean;
}

export const NO_INVITATION: InvitationOnceState = {
  token: null,
  peer_id: null,
  expires_at: null,
  panel_id: null,
  key_id: null,
  acknowledged: false,
};

/** 收到 invite 响应 → 进入「一次性展示」状态。 */
export function revealInvitation(invitation: {
  token: string;
  peer_id: number;
  expires_at: string;
  panel_id: string;
  key_id: string;
}): InvitationOnceState {
  return {
    token: invitation.token,
    peer_id: invitation.peer_id,
    expires_at: invitation.expires_at,
    panel_id: invitation.panel_id,
    key_id: invitation.key_id,
    acknowledged: false,
  };
}

/**
 * 管理员点「我已记录」→ **丢弃明文**。
 *
 * 这里是「只显示一次」的实现点：丢弃后 `token` 必然为 null，
 * 组件据此不再渲染任何明文（后端库里也只有 sha256，不可能再取回）。
 */
export function dismissInvitation(_state: InvitationOnceState): InvitationOnceState {
  return { ...NO_INVITATION, acknowledged: true };
}

/** 当前能否展示明文（唯一的读点，测试直接断言它）。 */
export function invitationTokenForDisplay(state: InvitationOnceState): string | null {
  return state.acknowledged ? null : state.token;
}

/* ------------------------------------------------------------------ */
/* 服务端取数：把失败也当成一等结果（页面 shell 照常渲染）                 */
/* ------------------------------------------------------------------ */

export type Settled<T> = { ok: true; data: T } | { ok: false; error: FederationErrorInfo };

/**
 * 服务端页面用它取数：**失败不抛、不 500**。
 *
 * 联邦列表在「联邦被关闭」（`federation_disabled` 403）或权限不足时本来就会失败，
 * 那是可解释的产品状态，不是崩溃：页面应该渲染错误码 + 下一步，
 * 而不是把整页变成 Next 的错误页。
 */
export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, data: await promise };
  } catch (e) {
    return { ok: false, error: federationErrorInfo(e) };
  }
}

/** 多个取数并行 + 任一失败即整体失败（保留第一个错误的码，便于定位）。 */
export async function settleAll<T extends readonly unknown[]>(
  promises: { [K in keyof T]: Promise<T[K]> },
): Promise<Settled<T>> {
  try {
    return { ok: true, data: (await Promise.all(promises)) as unknown as T };
  } catch (e) {
    return { ok: false, error: federationErrorInfo(e) };
  }
}
