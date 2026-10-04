/**
 * V5.5 Federation —— 面板到面板（M2M）端点（WP14，契约 §2/§3）。
 *
 * 挂载点：`/api/federation/v1`。安全边界：
 *   · 免**用户**认证（无 cookie/会话），但除握手外**全部**要求 Ed25519 签名；
 *   · 握手本身由一次性 token 保护（带外传递），响应带 proof；
 *   · 路由白名单在 `middlewares/auth.ts` / `middlewares/csrf.ts`（Lead 维护），
 *     真实身份判定在本文件与中间件里。
 *
 * 这里**不**包含 Admin Console 的接口（那些在 routes/admin-federation.ts，需要管理员身份）。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { federationErrorBody, federationStatus, type FederationErrorCode } from "../services/federation/errors.ts";
import { isFederationEnabled } from "../services/federation/identity.ts";
import {
  FederationTrustError,
  applyInboundTrustRevoke,
  applyPeerKeyRotation,
  handleHandshake,
  localIdentitySummary,
} from "../services/federation/trust.ts";
import { recordFederationAudit } from "../services/federation/audit.ts";
import type { FederationContext, FederationVariables } from "../middlewares/federation-auth.ts";
import { federationAuth } from "../middlewares/federation-auth.ts";
import { db } from "../db.ts";
import {
  applyRemoteLease,
  renewRemoteLease,
  reserveRemoteLease,
  releaseRemoteLease,
  type ApplyRemoteLeaseInput,
  type LeaseIntent,
} from "../services/federation/lease.ts";
import { attributeUsage, parseUsageReport, persistUsageReport } from "../services/federation/usage.ts";
import type { JWK } from "jose";

export const federationRoutes = new Hono<{ Variables: FederationVariables }>();

function errorResponse(c: Context, code: FederationErrorCode, message: string, peer: string | null = null) {
  return c.json(federationErrorBody(code, message, peer), federationStatus(code) as never);
}

/** 把 `FederationTrustError` 映射成结构化响应：不同原因必须给出不同码（§13）。 */
function trustErrorResponse(c: Context, e: unknown, peer: string | null): Response {
  if (e instanceof FederationTrustError) {
    return c.json(federationErrorBody(e.code, e.message, peer), e.status as never) as unknown as Response;
  }
  return c.json(
    federationErrorBody("internal_error", e instanceof Error ? e.message : String(e), peer),
    federationStatus("internal_error") as never,
  ) as unknown as Response;
}

function peerOf(c: Context): FederationContext["peer"] | null {
  const ctx = c.get("federation") as FederationContext | undefined;
  return ctx?.peer ?? null;
}

/* ---------------------------------------------------------------- */
/* 握手（唯一的免签名端点，由一次性 token 保护）                      */
/* ---------------------------------------------------------------- */

federationRoutes.post("/handshake", async (c) => {
  if (!(await isFederationEnabled())) {
    return c.json(
      federationErrorBody("federation_disabled", "本机联邦功能未开启"),
      federationStatus("federation_disabled") as never,
    );
  }
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(federationErrorBody("message_malformed", "请求体不是合法 JSON"), 400 as never);
  }
  const body = (payload ?? {}) as Record<string, unknown>;
  try {
    const response = await handleHandshake({
      peer_panel_id: String(body.peer_panel_id ?? ""),
      key_id: String(body.key_id ?? ""),
      public_jwk: (body.public_jwk ?? {}) as JWK,
      endpoint_url: String(body.endpoint_url ?? ""),
      display_name: typeof body.display_name === "string" ? body.display_name : undefined,
      token: String(body.token ?? ""),
    });
    return c.json(response, 200);
  } catch (e) {
    return trustErrorResponse(c, e, typeof body.peer_panel_id === "string" ? body.peer_panel_id : null);
  }
});

/* ---------------------------------------------------------------- */
/* 以下全部要求签名                                                   */
/* ---------------------------------------------------------------- */

federationRoutes.get("/whoami", federationAuth(), async (c) => {
  const peer = peerOf(c);
  const identity = await localIdentitySummary();
  return c.json({
    panel_id: identity?.panel_id ?? null,
    key_id: identity?.key_id ?? null,
    peer_panel_id: peer?.peer_panel_id ?? null,
    trusted: peer !== null,
  });
});

/** 无副作用的连通性与信任自检：G5 与运维用它区分"网络不通"和"信任不成立"。 */
federationRoutes.post("/ping", federationAuth(), async (c) => {
  const peer = peerOf(c)!;
  const ctx = c.get("federation") as FederationContext;
  await db.federationPeer.update({
    where: { peer_panel_id: peer.peer_panel_id },
    data: { last_seen_at: new Date() },
  });
  await recordFederationAudit({
    action: "trust.ping",
    direction: "inbound",
    peer_panel_id: peer.peer_panel_id,
    message_id: ctx.messageId,
    status: 200,
  });
  return c.json({ ok: true, peer_panel_id: peer.peer_panel_id, at: new Date().toISOString() });
});

federationRoutes.post("/keys/rotate", federationAuth(), async (c) => {
  const peer = peerOf(c)!;
  const ctx = c.get("federation") as FederationContext;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const newKeyId = typeof body.new_key_id === "string" ? body.new_key_id : "";
  const newJwk = body.new_public_jwk as JWK | undefined;
  if (!newKeyId || !newJwk || typeof newJwk !== "object") {
    return c.json(federationErrorBody("message_malformed", "缺少 new_key_id / new_public_jwk"), 400 as never);
  }
  try {
    const res = await applyPeerKeyRotation(peer.peer_panel_id, { new_key_id: newKeyId, new_public_jwk: newJwk });
    return c.json({ ok: true, already: res.already, key_id: newKeyId }, 200);
  } catch (e) {
    return trustErrorResponse(c, e, peer.peer_panel_id);
  } finally {
    void ctx;
  }
});

federationRoutes.post("/trust/revoke", federationAuth(), async (c) => {
  const peer = peerOf(c)!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reason = typeof body.reason === "string" ? body.reason : "peer_revoked";
  const res = await applyInboundTrustRevoke(peer.peer_panel_id, reason);
  return c.json({ ok: true, revoked_leases: res.leases }, 200);
});

/* ---------------------------------------------------------------- */
/* WP15：远端租约端点（host 侧权威）                                  */
/*                                                                    */
/* 契约 §3.2 两阶段：POST /leases 预留（分配端口 → reserved），        */
/* POST /leases/:ref/apply 应用（下发到自己的 Agent → active）。       */
/* host 是这些行与端口租约的**唯一写者**；home 侧只持镜像。            */
/* ---------------------------------------------------------------- */

/** 从 grant 的 scope 里挑一台**真实存在且在线**的节点：远端不参与选点，host 自己决定。 */
async function selectGrantNode(input: {
  scope: { node_group_ids?: number[] };
  hopRole: string;
}): Promise<
  | { ok: true; nodeId: number; nodeGroupId: number; nodeAddress: string | null }
  | { ok: false; code: FederationErrorCode; message: string }
> {
  const groupIds = Array.isArray(input.scope.node_group_ids) ? input.scope.node_group_ids : [];
  if (groupIds.length === 0) {
    return { ok: false, code: "grant_scope_violation", message: "该 grant 未授权任何节点组" };
  }
  const freshCutoff = new Date(Date.now() - 120_000);
  const wantedRole: Array<"ingress" | "egress" | "both"> =
    input.hopRole === "egress" ? ["egress", "both"] : ["ingress", "both"];
  const candidates = await db.node.findMany({
    where: {
      node_group_id: { in: groupIds },
      lifecycle: "active",
      role: { in: wantedRole },
      state_report: { reported_at: { gt: freshCutoff } },
    },
    select: { id: true, node_group_id: true, connect_ip: true },
    orderBy: { id: "asc" },
  });
  if (candidates.length === 0) {
    return { ok: false, code: "quota_exhausted", message: "授权范围内没有在线且角色匹配的节点" };
  }
  // 负载均衡：选当前联邦腿最少的那台（平票按 id 升序，保证确定性）。
  const load = await db.federationLease.groupBy({
    by: ["node_id"],
    where: { node_id: { in: candidates.map((c) => c.id) }, state: { in: ["reserved", "active", "releasing"] } },
    _count: { _all: true },
  });
  const busy = new Map<number, number>();
  for (const row of load) if (row.node_id !== null) busy.set(row.node_id, row._count._all);
  let best = candidates[0]!;
  for (const cand of candidates) {
    if ((busy.get(cand.id) ?? 0) < (busy.get(best.id) ?? 0)) best = cand;
  }
  // 回给 home 的**必须是 host 自己的事实**：远端腿的下一条跳地址。home 不可能知道
  // host 的节点地址，而"猜 IP"在这个项目里已经证明过一次是每个新连接都连不上的静默故障。
  const address = typeof best.connect_ip === "string" ? best.connect_ip.split(",")[0]!.trim() : "";
  return { ok: true, nodeId: best.id, nodeGroupId: best.node_group_id, nodeAddress: address === "" ? null : address };
}

federationRoutes.post("/leases", federationAuth(), async (c) => {
  const peer = peerOf(c)!;
  const ctx = c.get("federation") as FederationContext;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !body.intent || typeof body.intent !== "object") {
    return c.json(federationErrorBody("message_malformed", "缺少 intent"), 400 as never);
  }
  const intent = body.intent as LeaseIntent;

  // grant 的解析顺序（home 侧在**重连重发**时不可能记得 grant_ref，所以不能强制要求它）：
  //   1. 显式给了 grant_ref → 用它（并校验属于调用方 peer）；
  //   2. 没给，但同 (peer, intent_id) 已有非终态 lease → 沿用那条 lease 的 grant；
  //   3. 都没有 → 若该 peer 恰有一条覆盖本 hop_role 的 active grant 就用它，
  //      多于一条则拒绝并点名"必须显式指定"（含糊地替调用方选一条 = 用错额度）。
  const explicitGrantRef = typeof body.grant_ref === "string" && body.grant_ref.trim() !== "" ? body.grant_ref.trim() : null;
  let grant = explicitGrantRef
    ? await db.federationGrant.findUnique({
        where: { grant_ref: explicitGrantRef },
        include: { peer: { select: { peer_panel_id: true } } },
      })
    : null;

  // **显式引用必须被尊重**：给了 grant_ref 但查不到 → 404，绝不"回落到自动解析"。
  // 静默回落会让调用方以为自己在用某张特定的授予（例如刚被撤销的那张），实际用的是另一张 ——
  // 那正是 §13 里"不同的问题不许混成一个"的反面案例（Gate 的探针实测踩到过：显式给了不存在的
  // grant_ref，host 却回落到该 peer 唯一一条 active grant 并真的分配了租约）。
  if (explicitGrantRef && !grant) {
    return c.json(federationErrorBody("grant_not_found", "显式指定的 grant_ref 不存在"), 404 as never);
  }

  if (!grant) {
    const liveLease = await db.federationLease.findFirst({
      where: { peer_panel_id: peer.peer_panel_id, intent_id: intent.intent_id, state: { in: ["reserved", "active", "releasing"] } },
      orderBy: { id: "desc" },
    });
    if (liveLease) {
      grant = await db.federationGrant.findUnique({
        where: { id: liveLease.grant_id },
        include: { peer: { select: { peer_panel_id: true } } },
      });
    }
  }

  if (!grant) {
    const candidates = await db.federationGrant.findMany({
      where: { peer_id: peer.id, status: "active", expires_at: { gt: new Date() } },
      include: { peer: { select: { peer_panel_id: true } } },
    });
    const hopRoleWanted = typeof intent.hop_role === "string" ? intent.hop_role : "";
    const usable = candidates.filter((g) => {
      const scope = g.scope as { hop_roles?: unknown };
      const roles = Array.isArray(scope?.hop_roles) ? (scope.hop_roles as string[]) : [];
      return roles.length === 0 || roles.includes(hopRoleWanted);
    });
    if (usable.length === 0) {
      return c.json(federationErrorBody("grant_not_found", "该 peer 没有覆盖本次 hop_role 的有效 grant"), 404 as never);
    }
    if (usable.length > 1) {
      return c.json(
        federationErrorBody("grant_scope_violation", "该 peer 有多条可用 grant，必须在请求里显式指定 grant_ref"),
        403 as never,
      );
    }
    grant = usable[0]!;
  }

  if (!grant) return c.json(federationErrorBody("grant_not_found", "grant 不存在"), 404 as never);
  // 跨面板身份：grant 必须属于**调用方这个 peer**（grant.peer_id → peer.peer_panel_id）。
  // 别人拿到 grant_ref 也不能用：grant_ref 是引用，不是凭据。
  const grantPeerPanelId = grant.peer.peer_panel_id;
  if (grantPeerPanelId !== peer.peer_panel_id) {
    return c.json(federationErrorBody("grant_scope_violation", "该 grant 不属于当前 peer"), 403 as never);
  }

  const scope = grant.scope as { node_group_ids?: number[] };
  const hopRole = typeof intent.hop_role === "string" ? intent.hop_role : "";
  const selected = await selectGrantNode({ scope, hopRole });
  if (!selected.ok) {
    return c.json(federationErrorBody(selected.code, selected.message, peer.peer_panel_id), federationStatus(selected.code) as never);
  }

  const lineage = await db.federationLease.findFirst({
    where: { peer_panel_id: peer.peer_panel_id, forward_ref: intent.forward_ref, hop_role: hopRole },
    orderBy: { lease_epoch: "desc" },
  });
  const existing = await db.federationLease.findFirst({
    where: { peer_panel_id: peer.peer_panel_id, intent_id: intent.intent_id, state: { in: ["reserved", "active", "releasing"] } },
    orderBy: { id: "desc" },
  });

  const outcome = await reserveRemoteLease({
    intent,
    grant: {
      id: grant.id,
      grant_ref: grant.grant_ref,
      peer_panel_id: grantPeerPanelId,
      workspace_id: grant.workspace_id,
      grant_epoch: grant.grant_epoch,
      status: grant.status,
      scope: grant.scope,
      capacity: grant.capacity,
      expires_at: grant.expires_at,
    },
    workspaceId: grant.workspace_id,
    resolvedNodeId: selected.nodeId,
    resolvedNodeGroupId: selected.nodeGroupId,
    appliedRevision: existing?.applied_revision ?? null,
    previousEpoch: lineage?.lease_epoch ?? null,
    auditDirection: "inbound",
    messageId: ctx.messageId,
  });

  if (!outcome.ok) {
    return c.json(federationErrorBody(outcome.code, outcome.message, peer.peer_panel_id), federationStatus(outcome.code) as never);
  }
  return c.json(
    {
      lease_ref: outcome.lease.lease_ref,
      lease_epoch: outcome.lease_epoch,
      state: outcome.lease.state,
      node_ref: outcome.lease.node_id === null ? null : String(outcome.lease.node_id),
      node_address: selected.nodeAddress,
      port: outcome.port,
      expires_at: outcome.expires_at.toISOString(),
      applied_revision: outcome.lease.applied_revision,
      replayed: outcome.replayed,
      reused: outcome.reused === true,
    },
    200,
  );
});

federationRoutes.post("/leases/:ref/apply", federationAuth(), async (c) => {
  const peer = peerOf(c)!;
  const ctx = c.get("federation") as FederationContext;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.intent_id !== "string" || !Number.isFinite(Number(body.revision))) {
    return c.json(federationErrorBody("message_malformed", "缺少 intent_id / revision"), 400 as never);
  }
  const lease = await db.federationLease.findUnique({ where: { lease_ref: c.req.param("ref") } });
  if (!lease || lease.peer_panel_id !== peer.peer_panel_id) {
    return c.json(federationErrorBody("lease_not_found", "租约不存在"), 404 as never);
  }
  // 请求形状以**契约 §3.2** 为准：`{ intent_id, revision, link: { targets, protocol, lb_strategy } }`。
  // 顶层同名字段保留为别名（早期实现用过），但 `link` 优先 —— 两种形状都接受是为了不让
  // 一个历史客户端因为字段搬家而静默下发不出去，而不是为了维持两套契约。
  const link = (body.link && typeof body.link === "object" ? body.link : {}) as Record<string, unknown>;
  const rawTargets = Array.isArray(link.targets) ? link.targets : Array.isArray(body.targets) ? body.targets : [];
  const targets = rawTargets as ApplyRemoteLeaseInput["targets"];
  // next_hop 只对**入口腿**有意义（它要拨向下一跳）；出口腿靠 targets。
  // 之前这里既没有转发 next_hop、又无条件要求 targets，于是"远端入口腿"经 HTTP 永远过不去 ——
  // 服务层是支持的（有单测），红的却是那条真实通路。这正是"绿灯不等于那条路通"。
  const nextHopRaw = link.next_hop ?? body.next_hop;
  const nextHop = typeof nextHopRaw === "string" && nextHopRaw.trim() !== "" ? nextHopRaw.trim() : null;

  if (lease.hop_role === "ingress") {
    if (nextHop === null) {
      return c.json(federationErrorBody("message_malformed", "入口腿的 apply 必须携带 link.next_hop"), 400 as never);
    }
  } else if (targets.length === 0) {
    // 出口腿没有目标等于一条永远不通的链路：拒绝，而不是发一条空配置上去。
    return c.json(federationErrorBody("message_malformed", "apply 必须携带至少一个 target（link.targets）"), 400 as never);
  }
  const outcome = await applyRemoteLease({
    lease_ref: lease.lease_ref,
    intent_id: body.intent_id,
    revision: Number(body.revision),
    targets,
    next_hop: nextHop,
    lb_strategy:
      typeof link.lb_strategy === "string" ? link.lb_strategy : typeof body.lb_strategy === "string" ? body.lb_strategy : null,
    protocol: typeof link.protocol === "string" ? link.protocol : typeof body.protocol === "string" ? body.protocol : null,
    auditDirection: "inbound",
    messageId: ctx.messageId,
  });
  if (!outcome.ok) {
    return c.json(federationErrorBody(outcome.code, outcome.message, peer.peer_panel_id), federationStatus(outcome.code) as never);
  }
  return c.json(outcome, 200);
});

federationRoutes.post("/leases/:ref/renew", federationAuth(), async (c) => {
  const peer = peerOf(c)!;
  const ctx = c.get("federation") as FederationContext;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const lease = await db.federationLease.findUnique({ where: { lease_ref: c.req.param("ref") } });
  if (!lease || lease.peer_panel_id !== peer.peer_panel_id) {
    return c.json(federationErrorBody("lease_not_found", "租约不存在"), 404 as never);
  }
  const outcome = await renewRemoteLease({
    lease_ref: lease.lease_ref,
    intent_id: typeof body.intent_id === "string" ? body.intent_id : lease.intent_id,
    revision: Number.isFinite(Number(body.revision)) ? Number(body.revision) : lease.requested_revision,
    ttlSeconds: Number.isFinite(Number(body.ttl_seconds)) ? Number(body.ttl_seconds) : undefined,
    auditDirection: "inbound",
    messageId: ctx.messageId,
  });
  if (!outcome.ok) {
    return c.json(federationErrorBody(outcome.code, outcome.message, peer.peer_panel_id), federationStatus(outcome.code) as never);
  }
  return c.json(outcome, 200);
});

federationRoutes.get("/leases/:ref", federationAuth(), async (c) => {
  const peer = peerOf(c)!;
  const lease = await db.federationLease.findUnique({ where: { lease_ref: c.req.param("ref") } });
  if (!lease || lease.peer_panel_id !== peer.peer_panel_id) {
    return c.json(federationErrorBody("lease_not_found", "租约不存在"), 404 as never);
  }
  return c.json({
    lease_ref: lease.lease_ref,
    state: lease.state,
    lease_epoch: lease.lease_epoch,
    node_ref: lease.node_id === null ? null : String(lease.node_id),
    port: lease.listen_port,
    requested_revision: lease.requested_revision,
    applied_revision: lease.applied_revision,
    expires_at: lease.expires_at.toISOString(),
    last_error_code: lease.last_error_code,
  });
});

federationRoutes.delete("/leases/:ref", federationAuth(), async (c) => {
  const peer = peerOf(c)!;
  const ctx = c.get("federation") as FederationContext;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const lease = await db.federationLease.findUnique({ where: { lease_ref: c.req.param("ref") } });
  if (!lease || lease.peer_panel_id !== peer.peer_panel_id) {
    return c.json(federationErrorBody("lease_not_found", "租约不存在"), 404 as never);
  }
  const outcome = await releaseRemoteLease({
    intent_id: typeof body.intent_id === "string" ? body.intent_id : lease.intent_id,
    revision: Number.isFinite(Number(body.revision)) ? Number(body.revision) : lease.requested_revision,
    lease_ref: lease.lease_ref,
    lease_id: lease.id,
    reason: "released",
    auditDirection: "inbound",
    messageId: ctx.messageId,
  });
  if (!outcome.ok) {
    return c.json(federationErrorBody(outcome.code, outcome.message, peer.peer_panel_id), federationStatus(outcome.code) as never);
  }
  return c.json(outcome, 200);
});

/* ---------------------------------------------------------------- */
/* WP16：用量端点（home 侧接收事实）                                  */
/*                                                                    */
/* 用量是**事实**不是期望状态：按 usage_id 去重、首写胜、无法归因时进        */
/* unattributed 桶并告警，绝不静默丢弃或补 0。                          */
/* ---------------------------------------------------------------- */

federationRoutes.post("/usage", federationAuth(), async (c) => {
  const peer = peerOf(c)!;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return c.json(federationErrorBody("message_malformed", "请求体不是合法 JSON"), 400 as never);
  }
  // 契约 §4.1 写的是**顶层**字段；早期实现要求外面再包一层 `{report: …}`。两种都接受：
  // 上报是机器到机器的周期动作，"因为少包/多包一层就永远推不进来"是最没必要的一种失败。
  const raw = body.report && typeof body.report === "object" ? body.report : body;
  const parsed = parseUsageReport(raw);
  if (!parsed.ok) {
    return c.json(federationErrorBody(parsed.code, parsed.message, peer.peer_panel_id), federationStatus(parsed.code) as never);
  }
  const report = parsed.value;
  const placements = await db.federationPlacement.findMany({
    where: { peer_panel_id: peer.peer_panel_id },
    select: { lease_ref: true, forward_ref: true, tunnel_id: true },
  });
  const leases = new Map<string, { forward_ref: string | null; tunnel_id: number | null }>();
  for (const p of placements) {
    if (p.lease_ref) leases.set(p.lease_ref, { forward_ref: p.forward_ref, tunnel_id: p.tunnel_id });
  }
  const attribution = attributeUsage(report, { leases, forwards: new Map() });
  const outcome = await persistUsageReport({ report, peer_panel_id: peer.peer_panel_id, attribution });
  if (!outcome.ok) {
    return c.json(federationErrorBody(outcome.code, outcome.message, peer.peer_panel_id), federationStatus(outcome.code) as never);
  }
  if (attribution.attribution === "unattributed") {
    console.warn(
      `[federation] usage unattributed peer=${peer.peer_panel_id} lease=${report.lease_ref} reason=${attribution.reason}`,
    );
  }
  return c.json(outcome, 200);
});
