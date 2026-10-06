/**
 * V5.5 Federation —— 出站客户端（WP14，契约 §8「必须新造件」之一）。
 *
 * 事实：本仓库此前**没有**通用的出站 HTTP 封装（唯一的裸 fetch 在 payment/base.ts，
 * 无超时/无重试/无错误分类）。跨面板调用需要这三样，而且需要签名。
 *
 * 三条规则：
 *   1. **重试复用同一个 message_id**：换 id 就把"重试"变成了"新请求"，对端的幂等键
 *      会失效，结果可能是同一件事做两遍。这是这个模块存在的首要理由。
 *   2. 只有网络错误 / 超时 / 5xx 才重试；4xx（尤其是 peer_revoked / grant_*）一律不重试，
 *      因为它们重试多少次结果都一样。
 *   3. 错误必须分层返回（契约 §6 的闭集），绝不把跨面板失败压成一个 500。
 */
import type { JWK } from "jose";
import { isRetryableFederationError, type FederationErrorCode } from "./errors.ts";
import { classifyHttpError, isRetryableStatus, normalizePeerEndpoint } from "./transport.ts";

export { classifyHttpError, normalizePeerEndpoint };
import { loadSigningKey, type PanelIdentity } from "./identity.ts";
import { buildSignatureHeaders, newMessageId } from "./signing.ts";

export interface FederationPeerRef {
  peer_panel_id: string;
  endpoint_url: string;
}

export type FederationCallResult<T> =
  | { ok: true; status: number; body: T; messageId: string }
  | {
      ok: false;
      code: FederationErrorCode;
      status: number;
      message: string;
      retryable: boolean;
      messageId: string;
    };

export interface CallPeerInput {
  peer: FederationPeerRef;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs?: number;
  /** 额外重试次数（默认 2）。总尝试次数 = retries + 1。 */
  retries?: number;
  /** 测试注入点。 */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  nowMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 2;
const BACKOFF_MS = [200, 600];

function payloadString(body: unknown): string {
  if (body === undefined || body === null) return "";
  return JSON.stringify(body);
}

/**
 * 调用一个 peer。返回结构化结果而不是抛异常：调用方必须显式处理"对方不可达"，
 * 因为那与"对方说不行"是两种完全不同的后果（前者要等租约到期，后者要立刻停）。
 */
export async function callPeer<T = unknown>(input: CallPeerInput): Promise<FederationCallResult<T>> {
  const messageId = newMessageId();
  const endpoint = normalizePeerEndpoint(input.peer.endpoint_url);
  if (!endpoint.ok) {
    return {
      ok: false,
      code: "peer_unreachable",
      status: 0,
      message: endpoint.message,
      retryable: false,
      messageId,
    };
  }

  let identity: PanelIdentity | null = null;
  let privateJwk: JWK | null = null;
  try {
    const loaded = await loadSigningKey();
    identity = loaded.identity;
    privateJwk = loaded.privateJwk as JWK;
  } catch (e) {
    return {
      ok: false,
      code: "internal_error",
      status: 0,
      message: `本机联邦身份不可用：${e instanceof Error ? e.message : String(e)}`,
      retryable: false,
      messageId,
    };
  }

  const bodyStr = payloadString(input.body);
  const url = `${endpoint.base}${input.path.startsWith("/") ? input.path : `/${input.path}`}`;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, input.retries ?? DEFAULT_RETRIES);
  const doFetch = input.fetchImpl ?? fetch;
  const sleep = input.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastFailure: FederationCallResult<T> & { ok: false } = {
    ok: false,
    code: "peer_unreachable",
    status: 0,
    message: "未发起调用",
    retryable: true,
    messageId,
  };

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const headers = await buildSignatureHeaders({
      identity,
      privateJwk,
      body: bodyStr,
      method: input.method,
      path: input.path,
      messageId,
      nowMs: input.nowMs,
      ttlSeconds: Math.max(30, Math.ceil(timeoutMs / 1000) * (retries + 1) + 30),
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: input.method,
        headers: { ...headers, "content-type": "application/json", accept: "application/json" },
        body: input.method === "GET" || input.method === "DELETE" ? undefined : bodyStr || undefined,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let parsed: unknown = null;
      if (text.length > 0) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      if (res.ok) return { ok: true, status: res.status, body: parsed as T, messageId };

      const classified = classifyHttpError(res.status, parsed);
      const retryable = isRetryableStatus(res.status, classified.code);
      lastFailure = {
        ok: false,
        code: classified.code,
        status: res.status,
        message: classified.message,
        retryable,
        messageId,
      };
      if (!retryable) return lastFailure;
    } catch (e) {
      clearTimeout(timer);
      const aborted = e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
      lastFailure = {
        ok: false,
        code: "peer_unreachable",
        status: 0,
        message: aborted ? `调用 peer 超时（${timeoutMs}ms）` : `调用 peer 失败：${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
        messageId,
      };
    }
    if (attempt < retries) await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!);
  }
  return lastFailure;
}

export function federationCorrelation(): string {
  return crypto.randomUUID();
}
