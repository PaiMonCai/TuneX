/**
 * V5.5 Federation —— 错误码闭集与响应形状（契约 §6）。
 *
 * 与 V4/V5 既有分层一致：**不同的问题不许压成同一个 500**。
 * 联邦的错误还必须告诉调用方「重试有没有用」——因为跨面板调用的失败绝大多数是
 * 网络/时序问题，重试语义是调用方唯一能依赖的信息。
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

export interface FederationErrorBody {
  code: FederationErrorCode;
  message: string;
  retryable: boolean;
  peer_panel_id: string | null;
  correlation_id: string;
}

/** 重试有没有用：只有"对方不可达/自己太快/时序过期"这三类值得重试。 */
const RETRYABLE: ReadonlySet<FederationErrorCode> = new Set<FederationErrorCode>([
  "peer_unreachable",
  "clock_skew",
  "message_expired",
  "duplicate_message",
  "internal_error",
]);

const STATUS: Record<FederationErrorCode, number> = {
  federation_disabled: 403,
  peer_unknown: 403,
  peer_revoked: 403,
  peer_unreachable: 502,
  signature_invalid: 401,
  clock_skew: 401,
  message_expired: 401,
  // 409：重复消息不是"错误"，是幂等通道的一个正常状态（首次结果会被返回或
  // 告知稍后重试），所以它不能是 4xx 里那种"你做错了"的 400。
  duplicate_message: 409,
  message_malformed: 400,
  grant_not_found: 404,
  grant_not_active: 409,
  grant_scope_violation: 403,
  grant_expired: 409,
  quota_exhausted: 429,
  lease_not_found: 404,
  lease_expired: 409,
  lease_revoked: 409,
  intent_revision_stale: 409,
  unsupported_topology: 422,
  handshake_invalid: 403,
  key_unknown: 401,
  internal_error: 500,
};

export function federationStatus(code: FederationErrorCode): number {
  return STATUS[code];
}

export function isRetryableFederationError(code: FederationErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** 关联 id：两侧日志/审计用同一个值互查（不承载任何业务含义）。 */
export function newCorrelationId(): string {
  return crypto.randomUUID();
}

export function federationErrorBody(
  code: FederationErrorCode,
  message: string,
  peerPanelId: string | null = null,
  correlationId: string = newCorrelationId(),
): FederationErrorBody {
  return {
    code,
    message,
    retryable: isRetryableFederationError(code),
    peer_panel_id: peerPanelId,
    correlation_id: correlationId,
  };
}
