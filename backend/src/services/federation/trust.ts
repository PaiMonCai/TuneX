/**
 * V5.5 Federation —— 信任建立 / 轮转 / 撤销（WP14，契约 §2.2–§2.4）。
 *
 * 复用的是 V4 `node-enrollment` 已经证明有效的模式：一次性 token（只存 sha256、
 * 有 TTL、单次消费、可撤销）+ 带外传递。不同点是**双向**：握手成功之后两边都持有
 * 对方的公钥，之后所有调用都必须签名。
 *
 * 三个刻意的选择：
 *   · 握手响应带 `proof` —— B 用「只有拿到 token 的人才知道的秘密」对响应做 HMAC，
 *     于是 A 不仅信任"B 存在"，还信任"对面真的是 B"（没有它，一次中间人就能冒充 B）。
 *   · 轮转**先通知、后切换**：任一 peer 通知失败就整体放弃轮转（密钥不变）。
 *     代价是"有 peer 离线时不能轮转"，换来的是"不会出现把自己的旧钥匙换成一把
 *     对方根本不认的新钥匙"这种需要人工排查的中间态。
 *   · 撤销不可逆：`revoked` 是终态；重建信任必须重新走带外 token。
 */
import type { JWK } from "jose";
import { db } from "../../db.ts";
import { recordFederationAudit } from "./audit.ts";
import { env } from "../../env.ts";
import { callPeer } from "./client.ts";
import { federationStatus, type FederationErrorCode } from "./errors.ts";
import {
  commitPanelKey,
  ensurePanelIdentity,
  generatePanelKeyPair,
  getPanelIdentity,
  keyIdFor,
  loadSigningKey,
  type PanelIdentity,
} from "./identity.ts";
import { parsePeerKeys, type PeerKeyRecord } from "./signing.ts";
import {
  computeHandshakeProof,
  generateInvitationToken,
  hashInvitationToken,
  verifyHandshakeProof,
  type HandshakeFields,
} from "./tokens.ts";

export { computeHandshakeProof, generateInvitationToken, hashInvitationToken, verifyHandshakeProof };
export type { HandshakeFields };
import { secretEquals as invitationTokenEquals } from "./seal.ts";

/** 邀请 token 的有效期：15 分钟（带外传递通常发生在几分钟内）。 */
export const INVITATION_TTL_SECONDS = 900;
/** 旧密钥的退休宽限期：24 小时内仍可验签（在途请求不会因为轮转而失败）。 */
export const KEY_RETIRE_GRACE_MS = 24 * 60 * 60 * 1000;
/**
 * 本机对外公布的可达地址（peer 用它回呼我们）。
 *
 * 这是**必须**有的：握手只交换公钥，不交换"我怎么找到你"；如果这一步不自报地址，
 * 对端就永远无法回呼（撤销通知、密钥轮转、ping、用量推送全部变成 peer_unreachable），
 * 而现象是"信任建立成功但对方像是不存在"。
 */
export function federationSelfUrl(): string {
  return normalizeSelfUrl(env.federationPublicUrl || env.siteUrl);
}

/** 纯函数：公布地址必须无尾斜杠（否则拼出来是 `//api/...`，peer 侧的 URL 校验会拒）。 */
export function normalizeSelfUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** 默认信任范围：只允许"远端承载一跳链路"，其余能力必须显式授予。 */
export const DEFAULT_TRUST_SCOPE = { hop_roles: ["egress"], can_request_leases: true } as const;

export class FederationTrustError extends Error {
  readonly code: FederationErrorCode;
  readonly status: number;
  constructor(code: FederationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = federationStatus(code);
  }
}

/* ================================================================== */
/* 邀请（B 侧）                                                         */
/* ================================================================== */

export interface Invitation {
  peer_id: number;
  token: string;
  expires_at: Date;
  /** 本机身份，一并返回给管理员（他要把它交给 A 侧作为 peer 的连接信息）。 */
  panel_id: string;
  key_id: string;
  public_jwk: JWK;
}

/**
 * 生成本地信任邀请。此时**还不知道**对方的 panel_id，因此 peer 行先用
 * `pending:<uuid>` 占位，握手成功时再改成真实 id（唯一约束保证不会撞车）。
 */
export async function createInvitation(input: {
  display_name: string;
  /** 对端（受邀方）的 endpoint；管理员通常此刻就知道 A 的地址。 */
  endpoint_url: string;
  ttlSeconds?: number;
  now?: Date;
}): Promise<Invitation> {
  const identity = await ensurePanelIdentity();
  const token = generateInvitationToken();
  const now = input.now ?? new Date();
  const expires_at = new Date(now.getTime() + (input.ttlSeconds ?? INVITATION_TTL_SECONDS) * 1000);
  const placeholder = `pending:${crypto.randomUUID()}`;

  const peer = await db.$transaction(async (tx) => {
    const created = await tx.federationPeer.create({
      data: {
        peer_panel_id: placeholder,
        display_name: input.display_name.slice(0, 120),
        endpoint_url: input.endpoint_url.slice(0, 255),
        public_keys: [] as never,
        status: "pending",
      },
    });
    await tx.federationCredential.create({
      data: {
        peer_id: created.id,
        token_hash: hashInvitationToken(token),
        purpose: "bootstrap",
        expires_at,
      },
    });
    return created;
  });

  await recordFederationAudit({
    action: "trust.invite",
    direction: "local",
    peer_panel_id: peer.peer_panel_id,
    status: 200,
    detail: { peer_id: peer.id, expires_at: expires_at.toISOString() },
  });

  return {
    peer_id: peer.id,
    token,
    expires_at,
    panel_id: identity.panel_id,
    key_id: identity.key_id,
    public_jwk: identity.public_jwk,
  };
}

/* ================================================================== */
/* 握手（B 侧处理）                                                     */
/* ================================================================== */

export interface HandshakeRequest {
  peer_panel_id: string;
  key_id: string;
  public_jwk: JWK;
  endpoint_url: string;
  display_name?: string;
  token: string;
}

export interface HandshakeResponse {
  panel_id: string;
  key_id: string;
  public_jwk: JWK;
  display_name: string;
  trust_scope: unknown;
  proof: string;
}

/**
 * 处理一次入站握手。失败一律抛 `FederationTrustError`（路由层映射成结构化响应）。
 * 幂等性：token 单次消费，重复使用同一 token 一律拒绝 —— 重试必须让管理员重新发邀请。
 */
export async function handleHandshake(input: HandshakeRequest, now = new Date()): Promise<HandshakeResponse> {
  const identity = await ensurePanelIdentity();

  if (!input.token || input.token.length < 16 || input.token.length > 256) {
    throw new FederationTrustError("handshake_invalid", "邀请 token 格式非法");
  }
  if (!input.peer_panel_id || input.peer_panel_id.length > 64) {
    throw new FederationTrustError("handshake_invalid", "peer_panel_id 非法");
  }
  if (keyIdFor(input.public_jwk) !== input.key_id) {
    throw new FederationTrustError("handshake_invalid", "key_id 与公钥不匹配");
  }

  const tokenHash = hashInvitationToken(input.token);
  const credential = await db.federationCredential.findUnique({ where: { token_hash: tokenHash } });
  if (!credential) throw new FederationTrustError("handshake_invalid", "邀请 token 不存在");
  if (credential.revoked_at) throw new FederationTrustError("handshake_invalid", "邀请 token 已被撤销");
  if (credential.used_at) throw new FederationTrustError("handshake_invalid", "邀请 token 已被使用");
  if (credential.expires_at.getTime() <= now.getTime()) {
    throw new FederationTrustError("handshake_invalid", "邀请 token 已过期");
  }

  const peer = await db.federationPeer.findUnique({ where: { id: credential.peer_id } });
  if (!peer) throw new FederationTrustError("handshake_invalid", "邀请对应的 peer 行不存在");
  if (peer.peer_panel_id !== input.peer_panel_id) {
    const clash = await db.federationPeer.findUnique({ where: { peer_panel_id: input.peer_panel_id } });
    if (clash && clash.id !== peer.id) {
      throw new FederationTrustError("handshake_invalid", "该 panel_id 已经建立过信任");
    }
  }

  const keys: PeerKeyRecord[] = [{ key_id: input.key_id, jwk: input.public_jwk, state: "active", not_after: null }];
  const trustScope = peer.trust_scope ?? (DEFAULT_TRUST_SCOPE as unknown);

  await db.$transaction(async (tx) => {
    await tx.federationPeer.update({
      where: { id: peer.id },
      data: {
        peer_panel_id: input.peer_panel_id,
        // 只有对方**确实提供了**才覆盖：空串意味着"我没告诉你我的地址"，
        // 而不是"把我的地址清空"（清空的结果是对端再也回呼不到我们）。
        display_name: input.display_name && input.display_name.trim() !== "" ? input.display_name.slice(0, 120) : peer.display_name,
        endpoint_url:
          input.endpoint_url && input.endpoint_url.trim() !== "" ? input.endpoint_url.slice(0, 255) : peer.endpoint_url,
        public_keys: keys as never,
        status: "trusted",
        trust_scope: trustScope as never,
        last_seen_at: now,
      },
    });
    // 单次消费：令牌用掉即失效，且把该 peer 其它未用令牌一并作废
    // （与 node-enrollment 的 "重签自动作废旧 token" 同口径）。
    await tx.federationCredential.update({ where: { id: credential.id }, data: { used_at: now } });
    await tx.federationCredential.updateMany({
      where: { peer_id: peer.id, used_at: null, revoked_at: null, id: { not: credential.id } },
      data: { revoked_at: now },
    });
  });

  await recordFederationAudit({
    action: "trust.handshake",
    direction: "inbound",
    peer_panel_id: input.peer_panel_id,
    status: 200,
    detail: { key_id: input.key_id, endpoint_url: input.endpoint_url },
  });

  return {
    panel_id: identity.panel_id,
    key_id: identity.key_id,
    public_jwk: identity.public_jwk,
    display_name: "TuneX Panel",
    trust_scope: trustScope,
    proof: computeHandshakeProof(input.token, {
      panel_id: identity.panel_id,
      key_id: identity.key_id,
      public_jwk: identity.public_jwk,
    }),
  };
}

/* ================================================================== */
/* 握手（A 侧发起）                                                     */
/* ================================================================== */

async function postUnsignedJson(url: string, body: unknown, timeoutMs = 10_000): Promise<{ status: number; json: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A 侧：拿管理员带外递来的 token & B 的地址完成握手。
 * 成功后双方互相持有公钥，之后所有调用必须签名。
 */
export async function performHandshake(input: {
  endpoint_url: string;
  token: string;
  display_name: string;
  trust_scope?: unknown;
}): Promise<{ ok: true; peer_id: number; peer_panel_id: string } | { ok: false; code: FederationErrorCode; message: string }> {
  const identity = await ensurePanelIdentity();
  const base = input.endpoint_url.replace(/\/+$/, "");
  const url = `${base}/api/federation/v1/handshake`;

  let res: { status: number; json: unknown };
  try {
    res = await postUnsignedJson(url, {
      peer_panel_id: identity.panel_id,
      key_id: identity.key_id,
      public_jwk: identity.public_jwk,
      // 自报**我们自己的**地址：对端要靠它回呼我们（见 federationSelfUrl 的说明）。
      endpoint_url: federationSelfUrl(),
      display_name: input.display_name,
      token: input.token,
    });
  } catch (e) {
    return { ok: false, code: "peer_unreachable", message: `握手请求失败：${e instanceof Error ? e.message : String(e)}` };
  }

  if (res.status !== 200 || !res.json || typeof res.json !== "object") {
    const rec = (res.json ?? {}) as Record<string, unknown>;
    const code = typeof rec.code === "string" ? (rec.code as FederationErrorCode) : "handshake_invalid";
    const message = typeof rec.message === "string" ? rec.message : `握手失败（HTTP ${res.status}）`;
    return { ok: false, code, message };
  }

  const body = res.json as Record<string, unknown>;
  const panelId = typeof body.panel_id === "string" ? body.panel_id : null;
  const keyId = typeof body.key_id === "string" ? body.key_id : null;
  const publicJwk = body.public_jwk && typeof body.public_jwk === "object" ? (body.public_jwk as JWK) : null;
  if (!panelId || !keyId || !publicJwk || keyIdFor(publicJwk) !== keyId) {
    return { ok: false, code: "handshake_invalid", message: "对端握手响应缺少合法身份" };
  }
  if (!verifyHandshakeProof(input.token, { panel_id: panelId, key_id: keyId, public_jwk: publicJwk }, body.proof)) {
    return { ok: false, code: "handshake_invalid", message: "对端无法证明它持有本次邀请 token（proof 校验失败）" };
  }

  const keys: PeerKeyRecord[] = [{ key_id: keyId, jwk: publicJwk, state: "active", not_after: null }];
  const trustScope = input.trust_scope ?? (body.trust_scope ?? DEFAULT_TRUST_SCOPE);
  const now = new Date();

  const existing = await db.federationPeer.findUnique({ where: { peer_panel_id: panelId } });
  const peer = existing
    ? await db.federationPeer.update({
        where: { id: existing.id },
        data: {
          endpoint_url: input.endpoint_url.slice(0, 255),
          public_keys: keys as never,
          status: "trusted",
          trust_scope: trustScope as never,
          revoked_at: null,
          last_seen_at: now,
        },
      })
    : await db.federationPeer.create({
        data: {
          peer_panel_id: panelId,
          display_name: input.display_name.slice(0, 120),
          endpoint_url: input.endpoint_url.slice(0, 255),
          public_keys: keys as never,
          status: "trusted",
          trust_scope: trustScope as never,
          last_seen_at: now,
        },
      });

  await recordFederationAudit({
    action: "trust.handshake.initiate",
    direction: "outbound",
    peer_panel_id: panelId,
    status: 200,
    detail: { peer_id: peer.id, key_id: keyId },
  });

  return { ok: true, peer_id: peer.id, peer_panel_id: panelId };
}

/* ================================================================== */
/* 密钥轮转                                                             */
/* ================================================================== */

export interface RotateResult {
  ok: boolean;
  key_id: string;
  notified: string[];
  failed: { peer_panel_id: string; code: FederationErrorCode; message: string }[];
}

/**
 * 轮转本机签名密钥：**先让所有可信 peer 接受新公钥，再切换**。
 * 任一 peer 失败 → 整体放弃（密钥不变，返回失败列表）。这样不会出现
 * "自己换了钥匙而对方不认"的中间态 —— 那种状态下所有出站调用都会被拒，
 * 而现象看起来像"签名字段坏了"。
 */
export async function rotatePanelKey(options: { peers?: string[]; now?: Date } = {}): Promise<RotateResult> {
  const { identity: oldIdentity } = await loadSigningKey();
  const next = await generatePanelKeyPair();
  const now = options.now ?? new Date();

  const peers = await db.federationPeer.findMany({ where: { status: "trusted" } });
  const targets = options.peers ? peers.filter((p) => options.peers!.includes(p.peer_panel_id)) : peers;

  const notified: string[] = [];
  const failed: RotateResult["failed"] = [];
  for (const peer of targets) {
    const res = await callPeer({
      peer: { peer_panel_id: peer.peer_panel_id, endpoint_url: peer.endpoint_url },
      method: "POST",
      path: "/api/federation/v1/keys/rotate",
      body: {
        old_key_id: oldIdentity.key_id,
        new_key_id: next.key_id,
        new_public_jwk: next.public_jwk,
        rotate_at: now.toISOString(),
      },
      retries: 1,
    });
    if (res.ok) {
      notified.push(peer.peer_panel_id);
    } else {
      failed.push({ peer_panel_id: peer.peer_panel_id, code: res.code, message: res.message });
    }
  }

  if (failed.length > 0) {
    await recordFederationAudit({
      action: "trust.rotate.aborted",
      direction: "local",
      peer_panel_id: failed[0]!.peer_panel_id,
      status: 502,
      detail: { notified: notified.length, failed: failed.length, new_key_id: next.key_id },
    });
    return { ok: false, key_id: oldIdentity.key_id, notified, failed };
  }

  await commitPanelKey(next);
  await recordFederationAudit({
    action: "trust.rotate",
    direction: "local",
    peer_panel_id: targets[0]?.peer_panel_id ?? "local",
    status: 200,
    detail: { old_key_id: oldIdentity.key_id, new_key_id: next.key_id, notified: notified.length },
  });
  return { ok: true, key_id: next.key_id, notified, failed };
}

/** 处理入站轮转通知：把既有 active key 标为 retiring，新增 active key。 */
export async function applyPeerKeyRotation(
  peerPanelId: string,
  input: { new_key_id: string; new_public_jwk: JWK; now?: Date },
): Promise<{ ok: true; already: boolean }> {
  const peer = await db.federationPeer.findUnique({ where: { peer_panel_id: peerPanelId } });
  if (!peer) throw new FederationTrustError("peer_unknown", "未知的 peer panel");
  if (peer.status === "revoked") throw new FederationTrustError("peer_revoked", "该 peer 的信任已被撤销");
  if (keyIdFor(input.new_public_jwk) !== input.new_key_id) {
    throw new FederationTrustError("handshake_invalid", "key_id 与公钥不匹配");
  }

  const keys = parsePeerKeys(peer.public_keys);
  if (keys.some((k) => k.key_id === input.new_key_id)) {
    return { ok: true, already: true };
  }
  const now = input.now ?? new Date();
  const notAfter = new Date(now.getTime() + KEY_RETIRE_GRACE_MS).toISOString();
  const updated: PeerKeyRecord[] = [
    ...keys.map((k) => (k.state === "active" ? { ...k, state: "retiring" as const, not_after: notAfter } : k)),
    { key_id: input.new_key_id, jwk: input.new_public_jwk, state: "active", not_after: null },
  ];

  await db.federationPeer.update({
    where: { id: peer.id },
    data: { public_keys: updated as never, last_seen_at: now },
  });
  await recordFederationAudit({
    action: "trust.key.rotated",
    direction: "inbound",
    peer_panel_id: peerPanelId,
    status: 200,
    detail: { new_key_id: input.new_key_id, retiring_until: notAfter },
  });
  return { ok: true, already: false };
}

/* ================================================================== */
/* 撤销                                                                 */
/* ================================================================== */

export type RevokedHook = (peerPanelId: string) => Promise<void>;

let revokedHook: RevokedHook | null = null;

/**
 * 注册"peer 被撤销后必须立刻停服"的钩子（由 lease 模块注入）。
 * 这里不做停服本身：trust 只负责信任状态，停服属于租约/编排的职责。
 */
export function setFederationRevokedHook(hook: RevokedHook | null): void {
  revokedHook = hook;
}

async function cascadeRevoke(peerPanelId: string, now: Date): Promise<{ leases: number }> {
  const leases = await db.federationLease.updateMany({
    where: { peer_panel_id: peerPanelId, state: { in: ["reserved", "active", "releasing"] } },
    data: { state: "revoked", released_at: now, last_error_code: "peer_revoked" },
  });
  const placements = await db.federationPlacement.updateMany({
    where: { peer_panel_id: peerPanelId, state: { in: ["pending", "active", "degraded"] } },
    data: { state: "revoked", last_error_code: "peer_revoked" },
  });
  void placements;
  try {
    if (revokedHook) await revokedHook(peerPanelId);
  } catch (e) {
    console.warn("[federation] revoke hook failed:", e instanceof Error ? e.message : e);
  }
  return { leases: leases.count };
}

/** 本机撤销对某个 peer 的信任（不可逆）。 */
export async function revokePeer(peerPanelId: string, reason = "admin_revoked"): Promise<{ ok: true; leases: number }> {
  const peer = await db.federationPeer.findUnique({ where: { peer_panel_id: peerPanelId } });
  if (!peer) throw new FederationTrustError("peer_unknown", "未知的 peer panel");
  const now = new Date();
  await db.federationPeer.update({
    where: { id: peer.id },
    data: { status: "revoked", revoked_at: now },
  });
  const { leases } = await cascadeRevoke(peerPanelId, now);

  // 通知对端（best-effort）：撤销必须双向生效，否则对端会继续尝试用 grant。
  if (peer.status === "trusted") {
    await callPeer({
      peer: { peer_panel_id: peer.peer_panel_id, endpoint_url: peer.endpoint_url },
      method: "POST",
      path: "/api/federation/v1/trust/revoke",
      body: { reason },
      retries: 0,
    }).catch(() => undefined);
  }

  await recordFederationAudit({
    action: "trust.revoke",
    direction: "local",
    peer_panel_id: peerPanelId,
    status: 200,
    detail: { reason, revoked_leases: leases },
  });
  return { ok: true, leases };
}

/** 处理入站撤销通知：对端撤销了我们的信任 → 本地同样置为 revoked 并停服。 */
export async function applyInboundTrustRevoke(peerPanelId: string, reason: string): Promise<{ leases: number }> {
  const peer = await db.federationPeer.findUnique({ where: { peer_panel_id: peerPanelId } });
  if (!peer) throw new FederationTrustError("peer_unknown", "未知的 peer panel");
  const now = new Date();
  await db.federationPeer.update({ where: { id: peer.id }, data: { status: "revoked", revoked_at: now } });
  const { leases } = await cascadeRevoke(peerPanelId, now);
  await recordFederationAudit({
    action: "trust.revoked_by_peer",
    direction: "inbound",
    peer_panel_id: peerPanelId,
    status: 200,
    detail: { reason, revoked_leases: leases },
  });
  return { leases };
}

/* ================================================================== */
/* 查询                                                                 */
/* ================================================================== */

export interface PeerSummary {
  id: number;
  peer_panel_id: string;
  display_name: string;
  endpoint_url: string;
  status: string;
  key_ids: string[];
  trust_scope: unknown;
  last_seen_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export function toPeerSummary(row: {
  id: number;
  peer_panel_id: string;
  display_name: string;
  endpoint_url: string;
  public_keys: unknown;
  status: string;
  trust_scope: unknown;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}): PeerSummary {
  return {
    id: row.id,
    peer_panel_id: row.peer_panel_id,
    display_name: row.display_name,
    endpoint_url: row.endpoint_url,
    status: row.status,
    key_ids: parsePeerKeys(row.public_keys).map((k) => k.key_id),
    trust_scope: row.trust_scope,
    last_seen_at: row.last_seen_at?.toISOString() ?? null,
    revoked_at: row.revoked_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

export async function listPeers(): Promise<PeerSummary[]> {
  const rows = await db.federationPeer.findMany({ orderBy: { id: "asc" } });
  return rows.map(toPeerSummary);
}

/** 供中间件/服务使用的本机身份摘要（不泄露私钥）。 */
export async function localIdentitySummary(): Promise<{ panel_id: string; key_id: string } | null> {
  const identity: PanelIdentity | null = await getPanelIdentity();
  return identity ? { panel_id: identity.panel_id, key_id: identity.key_id } : null;
}
