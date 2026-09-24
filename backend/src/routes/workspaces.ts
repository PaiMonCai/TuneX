/** Workspace membership, team creation and single-use invitations. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { canWorkspaceAction } from "../services/workspace.ts";
import { assignDefaultPolicy, getEffectivePolicy } from "../services/policy-service.ts";
import { checkMemberAddition } from "../services/capability-policy.ts";

export const workspaceRoutes = new Hono<{ Variables: AppVariables }>();
// Legacy account-wide API keys are not scoped to a workspace. Team management
// requires a session until WorkspaceApiKey authorization is implemented.
workspaceRoutes.use("*", async (c, next) => {
  if (c.req.header("authorization")?.toLowerCase().startsWith("bearer ")) {
    throw new HTTPException(403, { message: "工作空间管理需要会话凭证" });
  }
  await next();
});
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const createTeam = z.object({ name: z.string().trim().min(1).max(120) });
const inviteSchema = z.object({
  email: z.email().transform((s) => s.trim().toLowerCase()),
  role: z.enum(["admin", "member", "viewer"]).default("member"),
});

function actorId(c: { get: (key: "user") => AppVariables["user"] }): number {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  return user.id;
}
function workspaceId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new HTTPException(400, { message: "非法工作空间 ID" });
  return id;
}
async function membership(id: number, userId: number) {
  const member = await db.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: id, user_id: userId } },
    include: { workspace: true },
  });
  if (!member?.active) throw new HTTPException(404, { message: "工作空间不存在" });
  return member;
}

workspaceRoutes.get("/", async (c) => {
  const userId = actorId(c);
  const rows = await db.workspaceMember.findMany({
    where: { user_id: userId, active: true },
    include: { workspace: { select: { id: true, name: true, slug: true, kind: true, created_at: true } } },
    orderBy: { workspace_id: "asc" },
  });
  return c.json({ data: rows.map((row) => ({ ...row.workspace, role: row.role })) });
});

workspaceRoutes.post("/", async (c) => {
  const userId = actorId(c);
  const parsed = createTeam.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "工作空间名称必须为 1–120 个字符" }, 400);
  const team = await db.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        slug: `team-${randomUUID()}`,
        name: parsed.data.name,
        kind: "team",
        created_by_id: userId,
        members: { create: { user_id: userId, role: "owner" } },
      },
      select: { id: true, name: true, slug: true, kind: true, created_at: true },
    });
    await assignDefaultPolicy(tx, { id: workspace.id, kind: "team" });
    await tx.auditEvent.create({ data: { workspace_id: workspace.id, actor_user_id: userId, action: "workspace.created", resource_type: "workspace", resource_id: String(workspace.id) } });
    return workspace;
  });
  return c.json({ data: { ...team, role: "owner" } }, 201);
});

workspaceRoutes.get("/:id", async (c) => {
  const member = await membership(workspaceId(c.req.param("id")), actorId(c));
  const { id, name, slug, kind, created_at } = member.workspace;
  return c.json({ data: { id, name, slug, kind, created_at, role: member.role } });
});

workspaceRoutes.get("/:id/members", async (c) => {
  const member = await membership(workspaceId(c.req.param("id")), actorId(c));
  if (!canWorkspaceAction(member.role, "read")) throw new HTTPException(403);
  const rows = await db.workspaceMember.findMany({
    where: { workspace_id: member.workspace_id, active: true },
    select: { user_id: true, role: true, created_at: true, user: { select: { email: true } } },
    orderBy: { id: "asc" },
  });
  return c.json({ data: rows.map(({ user, ...row }) => ({ ...row, email: user.email })) });
});

workspaceRoutes.post("/:id/invites", async (c) => {
  const userId = actorId(c);
  const member = await membership(workspaceId(c.req.param("id")), userId);
  if (member.workspace.kind !== "team" || !canWorkspaceAction(member.role, "manage")) throw new HTTPException(403);
  const parsed = inviteSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "邮箱或角色不合法" }, 400);
  const { email, role } = parsed.data;
  const existing = await db.workspaceMember.findFirst({ where: { workspace_id: member.workspace_id, user: { email }, active: true } });
  if (existing) return c.json({ error: "该用户已经是工作空间成员" }, 409);

  // 成员额度：active 成员 + 未过期未使用的邀请，合计不得越过策略上限。
  const policy = await getEffectivePolicy(member.workspace_id);
  const [memberCount, pendingInvites] = await Promise.all([
    db.workspaceMember.count({ where: { workspace_id: member.workspace_id, active: true } }),
    db.workspaceInvite.count({ where: { workspace_id: member.workspace_id, accepted_at: null, revoked_at: null, expires_at: { gt: new Date() } } }),
  ]);
  const decision = checkMemberAddition(policy, memberCount + pendingInvites);
  if (!decision.allowed) {
    return c.json({ error: decision.message, code: decision.reason, limit: policy.limits.max_members }, 403);
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 86400_000);
  const invite = await db.$transaction(async (tx) => {
    await tx.workspaceInvite.updateMany({ where: { workspace_id: member.workspace_id, email, accepted_at: null, revoked_at: null }, data: { revoked_at: new Date() } });
    const created = await tx.workspaceInvite.create({ data: { workspace_id: member.workspace_id, email, role, token_hash: hash(token), invited_by_id: userId, expires_at: expiresAt } });
    await tx.auditEvent.create({ data: { workspace_id: member.workspace_id, actor_user_id: userId, action: "member.invited", resource_type: "workspace_invite", resource_id: String(created.id) } });
    return created;
  });
  // Display exactly once over authenticated TLS; only its hash is stored.
  return c.json({ data: { id: invite.id, token, email, role, expires_at: expiresAt } }, 201);
});

workspaceRoutes.post("/invites/accept", async (c) => {
  const userId = actorId(c);
  const parsed = z.object({ token: z.string().min(30).max(128) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "邀请口令不合法" }, 400);
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  const tokenHash = hash(parsed.data.token);
  const invite = await db.workspaceInvite.findUnique({ where: { token_hash: tokenHash } });
  if (!invite || invite.email !== user.email.toLowerCase() || invite.revoked_at || invite.accepted_at || invite.expires_at <= new Date()) {
    return c.json({ error: "邀请不存在或已失效" }, 404);
  }
  const accepted = await db.$transaction(async (tx) => {
    // Never let a stale invite rewrite an existing member's role.
    const prior = await tx.workspaceMember.findUnique({ where: { workspace_id_user_id: { workspace_id: invite.workspace_id, user_id: userId } } });
    if (prior?.active) return false;
    const used = await tx.workspaceInvite.updateMany({
      where: { id: invite.id, accepted_at: null, revoked_at: null, expires_at: { gt: new Date() } },
      data: { accepted_at: new Date() },
    });
    if (!used.count) return false;
    await tx.workspaceMember.upsert({
      where: { workspace_id_user_id: { workspace_id: invite.workspace_id, user_id: userId } },
      create: { workspace_id: invite.workspace_id, user_id: userId, role: invite.role },
      update: { role: invite.role, active: true },
    });
    await tx.auditEvent.create({ data: { workspace_id: invite.workspace_id, actor_user_id: userId, action: "member.joined", resource_type: "workspace_member", resource_id: String(userId) } });
    return true;
  });
  return accepted ? c.json({ data: { workspace_id: invite.workspace_id } }) : c.json({ error: "邀请已使用" }, 409);
});

workspaceRoutes.delete("/:id/members/:userId", async (c) => {
  const actor = actorId(c);
  const groupId = workspaceId(c.req.param("id"));
  const targetId = workspaceId(c.req.param("userId"));
  const member = await membership(groupId, actor);
  const target = await db.workspaceMember.findUnique({ where: { workspace_id_user_id: { workspace_id: groupId, user_id: targetId } } });
  if (!target?.active) return c.json({ error: "成员不存在" }, 404);
  if (target.role === "owner") throw new HTTPException(403, { message: "不能移除 owner" });
  if (actor !== targetId && !canWorkspaceAction(member.role, "manage")) throw new HTTPException(403);
  await db.$transaction(async (tx) => {
    await tx.workspaceMember.update({ where: { id: target.id }, data: { active: false } });
    await tx.auditEvent.create({ data: { workspace_id: groupId, actor_user_id: actor, action: "member.removed", resource_type: "workspace_member", resource_id: String(targetId) } });
  });
  return c.json({ data: { ok: true } });
});
