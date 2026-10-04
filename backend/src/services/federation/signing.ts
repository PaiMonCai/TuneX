/**
 * V5.5 Federation —— 跨面板签名与验签（WP14，契约 §2.3）。
 *
 * 事实与理由：节点控制协议的信封（`services/control-protocol/types.ts`）**没有**签名/nonce
 * 字段 —— 它对 Agent 是可用的，因为 Agent 用节点凭据走 Bearer；但 Panel-to-Panel 之间
 * 不能被 `AUTH_SECRET`（每个安装不同）保护，也不能只靠网络边界。因此联邦自己带一层
 * 请求签名，原语用 Ed25519（jose 的 EdDSA），**不自创密码学**。
 *
 * 校验顺序（与契约 §2.3 完全一致，任一步失败都**不改任何状态**）：
 *   peer 已知 → 信任未撤销 → key 可验签 → 时间窗 → 签名（对 raw body）→ 回执去重（调用方）。
 *
 * 回执去重放在中间件里而不是这里：它需要"返回首次响应快照"的能力，属于 HTTP 层。
 */
import { CompactSign, compactVerify, importJWK, type JWK } from "jose";
import { db } from "../../db.ts";
import { FEDERATION_ERROR_CODES, federationStatus, type FederationErrorCode } from "./errors.ts";
import type { PanelIdentity } from "./identity.ts";

/* ================================================================== */
/* 头部与常量                                                          */
/* ================================================================== */

export const HDR = {
  panelId: "x-tunex-panel-id",
  keyId: "x-tunex-key-id",
  messageId: "x-tunex-message-id",
  issuedAt: "x-tunex-issued-at",
  expiresAt: "x-tunex-expires-at",
  signature: "x-tunex-signature",
} as const;

/** 时钟偏移容忍：60s（契约 §2.3）。超过就拒，且错误码是 clock_skew（可重试）。 */
export const CLOCK_SKEW_SECONDS = 60;
/** 允许的最大有效期：即便对端把 expires_at 设到很远的将来，这里也兜住上限。 */
export const MAX_MESSAGE_TTL_SECONDS = 300;
/** 默认有效期：一次请求的合理窗口。 */
export const DEFAULT_MESSAGE_TTL_SECONDS = 60;

export interface PeerKeyRecord {
  key_id: string;
  jwk: JWK;
  state: "active" | "retiring" | "retired";
  /** retiring 密钥的最后可验签时刻（ISO8601），state=active 时为 null。 */
  not_after?: string | null;
}

const KEY_STATES = new Set(["active", "retiring", "retired"]);

/**
 * 解析 peer 的公钥集合。**fail-closed**：任何结构错误都返回空数组 ——
 * 调用方会因为"没有可验签的 key"而拒绝请求，这正是我们想要的方向。
 * （不做"跳过坏条目继续用剩下的"：那会让一次被篡改的公钥表变成静默的部分信任。）
 */
export function parsePeerKeys(raw: unknown): PeerKeyRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: PeerKeyRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return [];
    const rec = item as Record<string, unknown>;
    const key_id = rec.key_id;
    const state = rec.state;
    const jwk = rec.jwk;
    if (typeof key_id !== "string" || key_id.length === 0 || key_id.length > 64) return [];
    if (typeof state !== "string" || !KEY_STATES.has(state)) return [];
    if (!jwk || typeof jwk !== "object") return [];
    const not_after = typeof rec.not_after === "string" && rec.not_after.length > 0 ? rec.not_after : null;
    out.push({ key_id, jwk: jwk as JWK, state: state as PeerKeyRecord["state"], not_after });
  }
  return out;
}

/** 某个 key 在当前时刻是否可用于验签（retiring 在 not_after 之前仍可验签）。 */
export function isKeyUsable(key: PeerKeyRecord, nowMs: number): boolean {
  if (key.state === "active") return true;
  if (key.state === "retired") return false;
  if (!key.not_after) return true; // retiring 但未声明截止：仍接受（宁可接受旧钥匙也不能静默拒绝在途请求）
  const ts = Date.parse(key.not_after);
  return Number.isFinite(ts) ? nowMs <= ts : true;
}

export function findUsableKey(keys: readonly PeerKeyRecord[], keyId: string, nowMs: number): PeerKeyRecord | null {
  for (const k of keys) {
    if (k.key_id === keyId && isKeyUsable(k, nowMs)) return k;
  }
  return null;
}

/* ================================================================== */
/* 时间窗（纯函数，便于无 DB 单测）                                     */
/* ================================================================== */

export type TimeWindowVerdict = { ok: true } | { ok: false; code: FederationErrorCode; message: string };

export function checkTimeWindow(input: { issuedAt: number; expiresAt: number; nowMs: number }): TimeWindowVerdict {
  const { issuedAt, expiresAt, nowMs } = input;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    return { ok: false, code: "message_malformed", message: "签名时间戳不是合法整数" };
  }
  const nowSec = Math.floor(nowMs / 1000);
  // 1) 过期：先判这条，否则"很久以前的消息"会被报成 clock_skew，误导排查方向。
  if (nowSec > expiresAt) return { ok: false, code: "message_expired", message: "消息已过期" };
  // 2) 未来时间：容忍 60s。
  if (issuedAt > nowSec + CLOCK_SKEW_SECONDS) {
    return { ok: false, code: "clock_skew", message: `签名时间在未来（容忍 ${CLOCK_SKEW_SECONDS}s）` };
  }
  // 3) 窗口上限：防止对端用一个"永远有效"的消息绕过 replay 防护的道德风险。
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_MESSAGE_TTL_SECONDS) {
    return { ok: false, code: "message_malformed", message: `签名有效期必须在 1..${MAX_MESSAGE_TTL_SECONDS}s 之内` };
  }
  return { ok: true };
}

/* ================================================================== */
/* 出站签名                                                            */
/* ================================================================== */

export function newMessageId(): string {
  return crypto.randomUUID();
}

export interface SignatureInput {
  identity: PanelIdentity;
  privateJwk: JWK;
  /** 原始请求体（无 body 时传空字符串 —— 空串也要签，否则空 body 请求可被替换）。 */
  body: string;
  messageId: string;
  nowMs?: number;
  ttlSeconds?: number;
}

/**
 * 生成签名头。**同一个 messageId 在重试时必须复用**（client.ts 的职责）——
 * 换 id 等于把一次重试变成一次新请求，对端的幂等键就失效了。
 */
export async function buildSignatureHeaders(input: SignatureInput): Promise<Record<string, string>> {
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const ttl = Math.min(Math.max(input.ttlSeconds ?? DEFAULT_MESSAGE_TTL_SECONDS, 1), MAX_MESSAGE_TTL_SECONDS);
  const jws = await new CompactSign(new TextEncoder().encode(input.body))
    .setProtectedHeader({ alg: "EdDSA", kid: input.identity.key_id })
    .sign(input.privateJwk);
  return {
    [HDR.panelId]: input.identity.panel_id,
    [HDR.keyId]: input.identity.key_id,
    [HDR.messageId]: input.messageId,
    [HDR.issuedAt]: String(nowSec),
    [HDR.expiresAt]: String(nowSec + ttl),
    [HDR.signature]: jws,
  };
}

/* ================================================================== */
/* 入站验签                                                            */
/* ================================================================== */

export interface VerifiedPeer {
  id: number;
  peer_panel_id: string;
  status: string;
  keys: PeerKeyRecord[];
}

export type InboundVerification =
  | { ok: true; peer: VerifiedPeer; messageId: string }
  | { ok: false; code: FederationErrorCode; status: number; message: string; peer_panel_id: string | null; messageId: string | null };

function fail(code: FederationErrorCode, message: string, peer_panel_id: string | null, messageId: string | null): InboundVerification {
  return { ok: false, code, status: federationStatus(code), message, peer_panel_id, messageId };
}

function headerOf(headers: Headers | Record<string, string | undefined>, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return typeof direct === "string" ? direct : null;
}

/**
 * 校验一条入站请求。**只验身份与完整性，不做去重**（去重在中间件里，因为它要写快照）。
 */
export async function verifyInboundRequest(input: {
  headers: Headers | Record<string, string | undefined>;
  rawBody: string;
  path?: string;
  nowMs?: number;
}): Promise<InboundVerification> {
  const { headers, rawBody } = input;
  const peerPanelId = headerOf(headers, HDR.panelId);
  const keyId = headerOf(headers, HDR.keyId);
  const messageId = headerOf(headers, HDR.messageId);
  const issuedAtRaw = headerOf(headers, HDR.issuedAt);
  const expiresAtRaw = headerOf(headers, HDR.expiresAt);
  const signature = headerOf(headers, HDR.signature);

  if (!peerPanelId || !keyId || !messageId || !issuedAtRaw || !expiresAtRaw || !signature) {
    return fail("message_malformed", "缺少联邦签名头", peerPanelId, messageId);
  }
  if (peerPanelId.length > 64 || keyId.length > 64 || messageId.length > 96) {
    return fail("message_malformed", "联邦签名头超长", peerPanelId, messageId);
  }

  const row = await db.federationPeer.findUnique({ where: { peer_panel_id: peerPanelId } });
  if (!row) return fail("peer_unknown", "未知的 peer panel", peerPanelId, messageId);
  if (row.status === "revoked") return fail("peer_revoked", "该 peer 的信任已被撤销", peerPanelId, messageId);
  if (row.status !== "trusted") {
    return fail("peer_unknown", `该 peer 尚未建立信任（status=${row.status}）`, peerPanelId, messageId);
  }

  const keys = parsePeerKeys(row.public_keys);
  const nowMs = input.nowMs ?? Date.now();
  const key = findUsableKey(keys, keyId, nowMs);
  if (!key) return fail("key_unknown", "签名密钥未知或已退役", peerPanelId, messageId);

  const verdict = checkTimeWindow({
    issuedAt: Number(issuedAtRaw),
    expiresAt: Number(expiresAtRaw),
    nowMs,
  });
  if (!verdict.ok) return fail(verdict.code, verdict.message, peerPanelId, messageId);

  try {
    const verifyKey = await importJWK(key.jwk, "EdDSA");
    const result = await compactVerify(signature, verifyKey);
    const payload = new TextDecoder().decode(result.payload);
    // JWS 的 kid 必须与头部一致：否则可以用一个 key_id 声明 + 另一把钥匙的签名蒙混。
    if (result.protectedHeader.kid && result.protectedHeader.kid !== keyId) {
      return fail("signature_invalid", "签名 kid 与头部不一致", peerPanelId, messageId);
    }
    if (payload !== rawBody) {
      return fail("signature_invalid", "签名载荷与请求体不一致", peerPanelId, messageId);
    }
  } catch {
    return fail("signature_invalid", "签名校验失败", peerPanelId, messageId);
  }

  return { ok: true, peer: { id: row.id, peer_panel_id: row.peer_panel_id, status: row.status, keys }, messageId };
}

export function isFederationErrorCode(value: string): value is FederationErrorCode {
  return (FEDERATION_ERROR_CODES as readonly string[]).includes(value);
}
