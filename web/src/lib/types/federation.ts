/** Domain types extracted from the legacy flat types.ts facade. */
/* ================================================================== */
/* V5.5 Federation（WP14 / WP15 / WP16）—— **只属于 Admin Console**     */
/*                                                                    */
/* 字段与形状逐一对齐 backend/src/routes/admin-federation.ts 的响应体   */
/* （该文件是唯一真相；前端不猜字段名，也不做二次推导）。                  */
/* ================================================================== */

/**
 * 联邦错误码**闭集**（契约 §6 = `backend/src/services/federation/errors.ts`
 * 的 `FEDERATION_ERROR_CODES`）。
 *
 * 这里刻意全量罗列而不是 `string`：新页面必须能对每个码给出「下一步」，
 * 后端加码而前端没跟上时，`Record<FederationErrorCode, ...>` 的穷尽查表会
 * 直接编译失败，而不是把新错误静默显示成通用 ERROR。
 */
export const FEDERATION_ERROR_CODES = [
  "federation_disabled",
  "peer_unknown",
  "peer_revoked",
  "peer_unreachable",
  "signature_invalid",
  "clock_skew",
  "message_expired",
  "duplicate_message",
  "message_malformed",
  "grant_not_found",
  "grant_not_active",
  "grant_scope_violation",
  "grant_expired",
  "quota_exhausted",
  "lease_not_found",
  "lease_expired",
  "lease_revoked",
  "intent_revision_stale",
  "unsupported_topology",
  "handshake_invalid",
  "key_unknown",
  "internal_error",
] as const;

export type FederationErrorCode = (typeof FEDERATION_ERROR_CODES)[number];

/** 后端联邦错误体（`federationErrorBody()`）的**原始**形状：`ApiError.data` 里就是它。 */
export interface FederationErrorBody {
  code: FederationErrorCode | string;
  message: string;
  retryable: boolean;
  peer_panel_id: string | null;
  correlation_id: string;
}

/** `GET /api/admin/federation/status` */
export interface FederationStatus {
  enabled: boolean;
  panel_id: string | null;
  key_id: string | null;
  peers: number;
  revoked_peers: number;
  grants: number;
  active_leases: number;
}

/** `POST .../enable` */
export interface FederationEnableResult {
  enabled: boolean;
  panel_id: string;
  key_id: string;
  changed: boolean;
}

/** `POST .../disable` */
export interface FederationDisableResult {
  enabled: boolean;
  changed: boolean;
}

/** `GET .../peers` 的条目（后端 `PeerSummary`）。 */
export interface FederationPeer {
  id: number;
  peer_panel_id: string;
  display_name: string;
  endpoint_url: string;
  status: string;
  /** 指纹：对端公钥的 key_id 列表（**不是**公钥原文）。 */
  key_ids: string[];
  trust_scope: unknown;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** `POST .../peers/invite`：`token` 只在这**一次**响应里出现（库里只有 sha256）。 */
export interface FederationInvitation {
  peer_id: number;
  token: string;
  expires_at: string;
  panel_id: string;
  key_id: string;
  public_jwk: unknown;
}

/** `POST .../peers/handshake` */
export interface FederationHandshakeResult {
  ok: true;
  peer_id: number;
  peer_panel_id: string;
}

/** `POST .../peers/:id/ping` */
export interface FederationPingResult {
  ok: true;
  peer_panel_id: string;
  response: unknown;
}

/** `POST .../peers/:id/rotate` */
export interface FederationPeerRotateResult {
  ok: true;
  key_id: string;
  notified: string[];
}

/** `DELETE .../peers/:id`：`revoked_leases` 是被这次撤销**连带**失效的租约数。 */
export interface FederationPeerRevokeResult {
  ok: true;
  peer_panel_id: string;
  revoked_leases: number;
}

/**
 * `POST .../key/rotate`。
 *
 * 注意这不是单纯的错误而是**部分失败事实**：任一 peer 不接受新公钥则整体放弃，
 * 此时 HTTP 是 502 但响应体仍是这个形状（`ok:false` + 逐 peer 失败明细），
 * 因此页面必须按 `ok` 分支而不是只看 HTTP 状态码。
 */
export interface FederationKeyRotateResult {
  ok: boolean;
  key_id: string;
  notified: string[];
  failed?: Array<{ peer_panel_id: string; code: string; message: string }>;
}

/** `scope`：`{ node_group_ids, hop_roles, allow_target_policy }`（缺省 = 不允许任何项，fail-closed）。 */
export interface FederationGrantScope {
  node_group_ids: number[];
  hop_roles: string[];
  allow_target_policy: string[] | null;
}

/** `capacity`：三项都可为 null = 该维度不限。 */
export interface FederationGrantCapacity {
  max_legs: number | null;
  max_bandwidth_mbps: number | null;
  max_connections: number | null;
}

/** grant 状态词表（后端 `GRANT_STATUSES`）。 */
export type FederationGrantStatus = "active" | "suspended" | "revoked" | "expired";

/** `GET .../grants` 的条目。 */
export interface FederationGrant {
  grant_ref: string;
  peer_id: number;
  workspace_id: number | null;
  grant_epoch: number;
  status: FederationGrantStatus | string;
  scope: FederationGrantScope | unknown;
  capacity: FederationGrantCapacity | unknown;
  quota_reserved: boolean;
  expires_at: string;
  revoked_at: string | null;
}

/** `POST .../grants` 成功响应。 */
export interface FederationGrantCreateResult {
  ok: true;
  grant_ref: string;
  grant_epoch: number;
  status: string;
  expires_at: string;
  scope: FederationGrantScope;
  capacity: FederationGrantCapacity;
}

/** `POST .../grants/:ref/{revoke,suspend,resume}` 成功响应（三动作的并集）。 */
export interface FederationGrantActionResult {
  ok: true;
  grant_epoch: number;
  /** revoke 独有 */
  already_revoked?: boolean;
  leases_revoked?: number;
  teardown_ok?: number;
  teardown_failed?: number;
  ports_released?: number;
  /** 停服没成功 → 端口不还（交给 reconcile 重试）。 */
  ports_pending?: number;
  quota_released?: boolean;
  raced?: number;
  /** suspend / resume 独有 */
  already_suspended?: boolean;
}

/** 远端租约状态词表（后端 `LEASE_STATES`）。 */
export const FEDERATION_LEASE_STATES = [
  "reserved",
  "active",
  "releasing",
  "released",
  "expired",
  "revoked",
  "failed",
] as const;

export type FederationLeaseState = (typeof FEDERATION_LEASE_STATES)[number];

/** hop 角色（后端 `HOP_ROLES`）。 */
export const FEDERATION_HOP_ROLES = ["ingress", "egress", "transit"] as const;
export type FederationHopRole = (typeof FEDERATION_HOP_ROLES)[number];

/** `GET .../leases` 的条目（host 侧权威：**本机**已经建了什么）。 */
export interface FederationLease {
  lease_ref: string;
  grant_id: number;
  peer_panel_id: string;
  forward_ref: string;
  intent_id: string;
  state: FederationLeaseState | string;
  lease_epoch: number;
  hop_role: string;
  node_id: number | null;
  listen_port: number | null;
  requested_revision: number | null;
  applied_revision: number | null;
  last_error_code: string | null;
  expires_at: string;
  released_at: string | null;
}

/** `GET .../placements` 的条目（home 侧镜像：**对端**应该给了什么）。 */
export interface FederationPlacement {
  peer_panel_id: string;
  forward_ref: string;
  tunnel_id: number | null;
  intent_id: string;
  lease_ref: string;
  lease_epoch: number;
  hop_role: string;
  desired_revision: number | null;
  applied_revision: number | null;
  state: string;
  peer_node_ref: string | null;
  peer_port: number | null;
  last_error_code: string | null;
  expires_at: string | null;
}

/** 用量归因（后端 `UsageAttribution`）：`unattributed` 必须单独可见。 */
export type FederationUsageAttribution = "attributed" | "unattributed";

/**
 * 未归因行的**可验证判据**（后端 `attribution_hint`）。
 *
 * 注意它不是「猜出来的原因码」，而是读者能自己复核的两分法：
 *   · `no_local_placement` —— 本机没有这条 lease_ref 的任何 placement 行（本地没有它的轨迹）；
 *   · `placement_conflict` —— 本机**有** placement 行却仍未归因（两侧说法冲突，才是要人工看的那类）。
 * attributed 行恒为 `null`。
 */
export const FEDERATION_ATTRIBUTION_HINTS = ["no_local_placement", "placement_conflict"] as const;
export type FederationAttributionHint = (typeof FEDERATION_ATTRIBUTION_HINTS)[number];

/** `GET .../usage` 的条目。字节数是**字符串**（后端 BigInt 序列化，前端不许 parseFloat 后丢精度）。 */
export interface FederationUsageRecord {
  usage_id: string;
  peer_panel_id: string;
  lease_ref: string;
  forward_ref: string | null;
  tunnel_id: number | null;
  window_start: string;
  window_end: string;
  bytes_in: string;
  bytes_out: string;
  connections: number;
  attribution: FederationUsageAttribution | string;
  /** 仅未归因行非空（见 `FederationAttributionHint`） */
  attribution_hint: FederationAttributionHint | string | null;
  /** 面板**收到**这条用量事实的时刻（与数据面窗口无关，不要混用） */
  received_at: string;
}

/* ---- 写操作入参（形状 = backend/src/routes/admin-federation.ts 的 zod schema） ---- */

/** `POST .../peers/invite`：`ttl_seconds` 由后端限 60–3600。 */
export interface FederationInviteInput {
  display_name: string;
  endpoint_url: string;
  ttl_seconds?: number;
}

/** `POST .../peers/handshake`。 */
export interface FederationHandshakeInput {
  endpoint_url: string;
  token: string;
  display_name?: string;
}

/**
 * `POST .../grants`。
 *
 * `scope` / `capacity` 是**整对象**提交：后端对未知键 fail-closed
 * （`grant_scope_violation` / `message_malformed`），所以表单只允许构造
 * 契约里存在的键，绝不做「透传用户 JSON」。
 */
export interface FederationGrantInput {
  peer_panel_id: string;
  workspace_id?: number | null;
  scope: FederationGrantScope;
  capacity?: FederationGrantCapacity;
  expires_in_seconds: number;
  quota_reserved?: boolean;
}

