/**
 * V5.5 Federation —— Admin Console 接口（WP14）。
 *
 * 挂载点：`/api/admin/federation`（需要管理员身份 + `federation` 资源权限，
 * 由 app.ts 的 `/api/admin/*` 两道闸统一保证）。
 *
 * **这些接口只属于 Admin Console**（契约 §9.4.1 / §10）：普通用户永远看不到
 * trust / grant / remote lease。这里不复制任何业务真相：enable/disable 只改开关，
 * 邀请/握手/轮转/撤销都是信任层动作，租约与用量在各自模块里。
 *
 * 返回形状遵循仓库既有约定：前端 request() 会剥一层 data，因此这里直接返回对象。
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { recordFederationAudit } from "../services/federation/audit.ts";
import { callPeer } from "../services/federation/client.ts";
import { federationErrorBody, federationStatus } from "../services/federation/errors.ts";
import {
  ensurePanelIdentity,
  getPanelIdentity,
  isFederationEnabled,
  setFederationEnabled,
} from "../services/federation/identity.ts";
import {
  createGrant,
  resumeGrant,
  revokeGrant,
  suspendGrant,
} from "../services/federation/grant.ts";
import {
  FederationTrustError,
  createInvitation,
  listPeers,
  performHandshake,
  revokePeer,
  rotatePanelKey,
} from "../services/federation/trust.ts";

export const adminFederationRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

function requireUser(c: Ctx): NonNullable<AppVariables["user"]> {
  const user = c.get("user");
  if (!user) throw new Error("federation admin route requires an authenticated admin");
  return user;
}

adminFederationRoutes.get("/status", async (c) => {
  const enabled = await isFederationEnabled();
  const identity = await getPanelIdentity();
  const [peers, revoked, grants, activeLeases] = await Promise.all([
    db.federationPeer.count(),
    db.federationPeer.count({ where: { status: "revoked" } }),
    db.federationGrant.count(),
    db.federationLease.count({ where: { state: { in: ["reserved", "active", "releasing"] } } }),
  ]);
  return c.json({
    enabled,
    panel_id: identity?.panel_id ?? null,
    key_id: identity?.key_id ?? null,
    peers,
    revoked_peers: revoked,
    grants,
    active_leases: activeLeases,
  });
});

adminFederationRoutes.post("/enable", async (c) => {
  const user = requireUser(c);
  const identity = await ensurePanelIdentity();
  const before = await isFederationEnabled();
  if (!before) await setFederationEnabled(true);
  await recordFederationAudit({
    action: "admin.enable",
    direction: "local",
    peer_panel_id: identity.panel_id,
    status: 200,
    detail: { actor_id: user.id ?? null, changed: !before },
  });
  return c.json({ enabled: true, panel_id: identity.panel_id, key_id: identity.key_id, changed: !before });
});

adminFederationRoutes.post("/disable", async (c) => {
  const user = requireUser(c);
  const identity = await getPanelIdentity();
  const before = await isFederationEnabled();
  if (before) await setFederationEnabled(false);
  await recordFederationAudit({
    action: "admin.disable",
    direction: "local",
    peer_panel_id: identity?.panel_id ?? "unknown",
    status: 200,
    detail: { actor_id: user.id ?? null, changed: before },
  });
  return c.json({ enabled: false, changed: before });
});

adminFederationRoutes.get("/peers", async (c) => {
  return c.json({ data: await listPeers() });
});

const inviteSchema = z.object({
  display_name: z.string().trim().min(1).max(120),
  endpoint_url: z.string().trim().min(1).max(255),
  ttl_seconds: z.number().int().min(60).max(3600).optional(),
});

adminFederationRoutes.post("/peers/invite", async (c) => {
  const user = requireUser(c);
  const parsed = inviteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(federationErrorBody("message_malformed", "邀请参数非法"), 400 as never);
  }
  const invitation = await createInvitation({
    display_name: parsed.data.display_name,
    endpoint_url: parsed.data.endpoint_url,
    ttlSeconds: parsed.data.ttl_seconds,
  });
  await recordFederationAudit({
    action: "admin.invite",
    direction: "local",
    peer_panel_id: `pending:${invitation.peer_id}`,
    status: 200,
    detail: { actor_id: user.id ?? null, expires_at: invitation.expires_at.toISOString() },
  });
  // token 只在这一次响应里出现（库里只有 sha256）。
  return c.json({
    peer_id: invitation.peer_id,
    token: invitation.token,
    expires_at: invitation.expires_at.toISOString(),
    panel_id: invitation.panel_id,
    key_id: invitation.key_id,
    public_jwk: invitation.public_jwk,
  });
});

const handshakeSchema = z.object({
  endpoint_url: z.string().trim().min(1).max(255),
  token: z.string().trim().min(16).max(256),
  display_name: z.string().trim().min(1).max(120).default("TuneX Panel"),
});

adminFederationRoutes.post("/peers/handshake", async (c) => {
  const user = requireUser(c);
  const parsed = handshakeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(federationErrorBody("message_malformed", "握手参数非法"), 400 as never);
  }
  const result = await performHandshake({
    endpoint_url: parsed.data.endpoint_url,
    token: parsed.data.token,
    display_name: parsed.data.display_name,
  });
  await recordFederationAudit({
    action: "admin.handshake",
    direction: "outbound",
    peer_panel_id: result.ok ? result.peer_panel_id : parsed.data.endpoint_url,
    status: result.ok ? 200 : federationStatus(result.code),
    detail: { actor_id: user.id ?? null, code: result.ok ? null : result.code },
  });
  if (!result.ok) return c.json(federationErrorBody(result.code, result.message), federationStatus(result.code) as never);
  return c.json({ ok: true, peer_id: result.peer_id, peer_panel_id: result.peer_panel_id });
});

adminFederationRoutes.post("/peers/:id/ping", async (c) => {
  const peer = await db.federationPeer.findUnique({ where: { id: Number(c.req.param("id")) } });
  if (!peer) return c.json(federationErrorBody("peer_unknown", "未知的 peer"), 404 as never);
  const res = await callPeer({
    peer: { peer_panel_id: peer.peer_panel_id, endpoint_url: peer.endpoint_url },
    method: "POST",
    path: "/api/federation/v1/ping",
    body: {},
    retries: 0,
  });
  if (!res.ok) {
    return c.json(federationErrorBody(res.code, res.message, peer.peer_panel_id), federationStatus(res.code) as never);
  }
  await db.federationPeer.update({ where: { id: peer.id }, data: { last_seen_at: new Date() } });
  return c.json({ ok: true, peer_panel_id: peer.peer_panel_id, response: res.body });
});

adminFederationRoutes.post("/peers/:id/rotate", async (c) => {
  const peer = await db.federationPeer.findUnique({ where: { id: Number(c.req.param("id")) } });
  if (!peer) return c.json(federationErrorBody("peer_unknown", "未知的 peer"), 404 as never);
  const result = await rotatePanelKey({ peers: [peer.peer_panel_id] });
  if (!result.ok) {
    const failure = result.failed[0];
    return c.json(
      federationErrorBody(failure?.code ?? "internal_error", failure?.message ?? "轮转失败（对端未接受新公钥）", peer.peer_panel_id),
      502 as never,
    );
  }
  return c.json({ ok: true, key_id: result.key_id, notified: result.notified });
});

adminFederationRoutes.delete("/peers/:id", async (c) => {
  const user = requireUser(c);
  const peer = await db.federationPeer.findUnique({ where: { id: Number(c.req.param("id")) } });
  if (!peer) return c.json(federationErrorBody("peer_unknown", "未知的 peer"), 404 as never);
  try {
    const result = await revokePeer(peer.peer_panel_id);
    await recordFederationAudit({
      action: "admin.revoke",
      direction: "local",
      peer_panel_id: peer.peer_panel_id,
      status: 200,
      detail: { actor_id: user.id ?? null, revoked_leases: result.leases },
    });
    return c.json({ ok: true, peer_panel_id: peer.peer_panel_id, revoked_leases: result.leases });
  } catch (e) {
    if (e instanceof FederationTrustError) {
      return c.json(federationErrorBody(e.code, e.message, peer.peer_panel_id), e.status as never);
    }
    throw e;
  }
});

/** 轮转本机密钥（对所有可信 peer）：任一 peer 不接受则整体放弃。 */
adminFederationRoutes.post("/key/rotate", async (c) => {
  const user = requireUser(c);
  const result = await rotatePanelKey();
  await recordFederationAudit({
    action: "admin.key.rotate",
    direction: "local",
    peer_panel_id: "local",
    status: result.ok ? 200 : 502,
    detail: { actor_id: user.id ?? null, key_id: result.key_id, notified: result.notified.length, failed: result.failed.length },
  });
  if (!result.ok) {
    return c.json({ ok: false, key_id: result.key_id, notified: result.notified, failed: result.failed }, 502 as never);
  }
  return c.json({ ok: true, key_id: result.key_id, notified: result.notified });
});

/* ---------------------------------------------------------------- */
/* WP15 / WP16 —— Admin Console 的授予、租约与用量视图                */
/*                                                                    */
/* 这些端点只服务管理界面与 Gate：它们**不**参与数据面决策，也不复制     */
/* 任何真相（grant/lease 的权威永远是各自的表）。                        */
/* ---------------------------------------------------------------- */

const grantSchema = z.object({
  peer_panel_id: z.string().trim().min(1).max(64),
  workspace_id: z.number().int().positive().nullable().optional(),
  scope: z.unknown(),
  capacity: z.unknown().optional(),
  expires_in_seconds: z.number().int().min(60).max(30 * 24 * 3600),
  quota_reserved: z.boolean().optional(),
});

adminFederationRoutes.post("/grants", async (c) => {
  const user = requireUser(c);
  const parsed = grantSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json(federationErrorBody("message_malformed", "grant 参数非法"), 400 as never);
  const peer = await db.federationPeer.findUnique({ where: { peer_panel_id: parsed.data.peer_panel_id } });
  if (!peer) return c.json(federationErrorBody("peer_unknown", "未知的 peer"), 404 as never);

  const outcome = await createGrant({
    peerPanelId: peer.peer_panel_id,
    workspaceId: parsed.data.workspace_id ?? null,
    scope: parsed.data.scope,
    capacity: parsed.data.capacity ?? null,
    expiresAt: new Date(Date.now() + parsed.data.expires_in_seconds * 1000),
    quotaReserved: parsed.data.quota_reserved ?? false,
    createdById: user.id ?? null,
  });
  if (!outcome.ok) {
    await recordFederationAudit({
      action: "admin.grant.rejected",
      direction: "local",
      peer_panel_id: peer.peer_panel_id,
      status: federationStatus(outcome.code),
      detail: { actor_id: user.id ?? null, code: outcome.code },
    });
    return c.json(federationErrorBody(outcome.code, outcome.message, peer.peer_panel_id), federationStatus(outcome.code) as never);
  }
  return c.json({
    ok: true,
    grant_ref: outcome.grant.grant_ref,
    grant_epoch: outcome.grant.grant_epoch,
    status: outcome.grant.status,
    expires_at: outcome.grant.expires_at.toISOString(),
    scope: outcome.scope,
    capacity: outcome.capacity,
  });
});

adminFederationRoutes.get("/grants", async (c) => {
  const rows = await db.federationGrant.findMany({ orderBy: { id: "desc" }, take: 200 });
  return c.json({
    data: rows.map((g) => ({
      grant_ref: g.grant_ref,
      peer_id: g.peer_id,
      workspace_id: g.workspace_id,
      grant_epoch: g.grant_epoch,
      status: g.status,
      scope: g.scope,
      capacity: g.capacity,
      quota_reserved: g.quota_reserved,
      expires_at: g.expires_at.toISOString(),
      revoked_at: g.revoked_at?.toISOString() ?? null,
    })),
  });
});

function grantActionHandler(action: "revoke" | "suspend" | "resume") {
  return async (c: Ctx) => {
    const user = requireUser(c);
    const ref = c.req.param("ref");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason : `admin_${action}`;
    const outcome =
      action === "revoke"
        ? await revokeGrant({ grantRef: ref, reason })
        : action === "suspend"
          ? await suspendGrant({ grantRef: ref, reason })
          : await resumeGrant({ grantRef: ref });
    if (!outcome.ok) {
      return c.json(federationErrorBody(outcome.code, outcome.message), federationStatus(outcome.code) as never);
    }
    await recordFederationAudit({
      action: `admin.grant.${action}`,
      direction: "local",
      peer_panel_id: `grant:${ref}`,
      status: 200,
      detail: { actor_id: user.id ?? null, revoked_leases: "revoked_leases" in outcome ? outcome.revoked_leases : undefined },
    });
    return c.json(outcome);
  };
}

adminFederationRoutes.post("/grants/:ref/revoke", grantActionHandler("revoke"));
adminFederationRoutes.post("/grants/:ref/suspend", grantActionHandler("suspend"));
adminFederationRoutes.post("/grants/:ref/resume", grantActionHandler("resume"));

adminFederationRoutes.get("/leases", async (c) => {
  const rows = await db.federationLease.findMany({ orderBy: { id: "desc" }, take: 200 });
  return c.json({
    data: rows.map((l) => ({
      lease_ref: l.lease_ref,
      grant_id: l.grant_id,
      peer_panel_id: l.peer_panel_id,
      forward_ref: l.forward_ref,
      intent_id: l.intent_id,
      state: l.state,
      lease_epoch: l.lease_epoch,
      hop_role: l.hop_role,
      node_id: l.node_id,
      listen_port: l.listen_port,
      requested_revision: l.requested_revision,
      applied_revision: l.applied_revision,
      last_error_code: l.last_error_code,
      expires_at: l.expires_at.toISOString(),
      released_at: l.released_at?.toISOString() ?? null,
    })),
  });
});

adminFederationRoutes.get("/placements", async (c) => {
  const rows = await db.federationPlacement.findMany({ orderBy: { id: "desc" }, take: 200 });
  return c.json({
    data: rows.map((p) => ({
      peer_panel_id: p.peer_panel_id,
      forward_ref: p.forward_ref,
      tunnel_id: p.tunnel_id,
      intent_id: p.intent_id,
      lease_ref: p.lease_ref,
      lease_epoch: p.lease_epoch,
      hop_role: p.hop_role,
      desired_revision: p.desired_revision,
      applied_revision: p.applied_revision,
      state: p.state,
      peer_node_ref: p.peer_node_ref,
      peer_port: p.peer_port,
      last_error_code: p.last_error_code,
      expires_at: p.expires_at?.toISOString() ?? null,
    })),
  });
});

adminFederationRoutes.get("/usage", async (c) => {
  const rows = await db.federationUsageRecord.findMany({ orderBy: { id: "desc" }, take: 200 });
  return c.json({
    data: rows.map((u) => ({
      usage_id: u.usage_id,
      peer_panel_id: u.peer_panel_id,
      lease_ref: u.lease_ref,
      forward_ref: u.forward_ref,
      tunnel_id: u.tunnel_id,
      window_start: u.window_start.toISOString(),
      window_end: u.window_end.toISOString(),
      bytes_in: u.bytes_in.toString(),
      bytes_out: u.bytes_out.toString(),
      connections: u.connections,
      attribution: u.attribution,
    })),
  });
});
