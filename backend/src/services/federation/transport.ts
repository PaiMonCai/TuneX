/**
 * V5.5 Federation —— 出站调用的**纯**辅助（地址校验 + 错误分类）。
 *
 * 单独成文件是为了让这些判定可以在没有 DB/环境的情况下被测到：
 * "把一个 peer 的 4xx 误判成可重试"这类错误的代价是调用方长期空转，
 * 而它在生产里非常难被发现。
 */
import { federationStatus, isRetryableFederationError, type FederationErrorCode } from "./errors.ts";

/** endpoint 必须是一个干净的 origin（可带一段固定路径）：不接受查询/片段/用户信息。 */
export function normalizePeerEndpoint(raw: string): { ok: true; base: string } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, message: "peer endpoint 不是合法 URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "peer endpoint 必须是 http/https" };
  }
  if (url.username || url.password) return { ok: false, message: "peer endpoint 不得包含用户信息" };
  if (url.search || url.hash) return { ok: false, message: "peer endpoint 不得包含查询串或片段" };
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, base: `${url.origin}${path}` };
}

/** 从错误响应体里取结构化错误码；取不到就按状态码归类（不猜具体业务错误）。 */
export function classifyHttpError(status: number, parsed: unknown): { code: FederationErrorCode; message: string } {
  if (parsed && typeof parsed === "object") {
    const rec = parsed as Record<string, unknown>;
    const code = typeof rec.code === "string" ? rec.code : null;
    const message = typeof rec.message === "string" ? rec.message : typeof rec.error === "string" ? rec.error : null;
    if (code && /^[a-z_]+$/.test(code) && federationStatus(code as FederationErrorCode) !== undefined) {
      return { code: code as FederationErrorCode, message: message ?? `peer 返回 ${status}` };
    }
    if (message) return { code: status >= 500 ? "internal_error" : "message_malformed", message };
  }
  if (status === 401 || status === 403) return { code: "signature_invalid", message: `peer 拒绝鉴权（${status}）` };
  if (status === 404) return { code: "lease_not_found", message: "peer 上找不到对应资源（404）" };
  if (status === 409) return { code: "duplicate_message", message: "peer 报告冲突（409）" };
  if (status === 429) return { code: "quota_exhausted", message: "peer 报告容量/配额耗尽（429）" };
  return { code: "internal_error", message: `peer 返回未分类错误（${status}）` };
}

/** 只有网络/超时/5xx 才值得重试；其余重试多少次结果都一样。 */
export function isRetryableStatus(status: number, code: FederationErrorCode): boolean {
  return status >= 500 || status === 0 || isRetryableFederationError(code);
}
