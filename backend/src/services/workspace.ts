import type { Prisma } from "@prisma/client";
import { db } from "../db.ts";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { AppVariables } from "../middlewares/auth.ts";
import { assignDefaultPolicy } from "./policy-service.ts";

/** Every new account gets an owned personal workspace + free policy in the SAME transaction. */
export async function createPersonalWorkspace(tx: Prisma.TransactionClient, user: { id: number; email: string }) {
  const workspace = await tx.workspace.create({
    data: {
      slug: `personal-${user.id}`,
      name: `Personal ${user.id}`,
      kind: "personal",
      personal_user_id: user.id,
      created_by_id: user.id,
      members: { create: { user_id: user.id, role: "owner" } },
    },
  });
  await assignDefaultPolicy(tx, workspace);
  return workspace;
}

/** Idempotent seed repair for preexisting administrator accounts. */
export async function ensurePersonalWorkspace(user: { id: number; email: string }) {
  const workspace = await db.$transaction(async (tx) => {
    const ws = await tx.workspace.upsert({
      where: { personal_user_id: user.id },
      create: {
        slug: `personal-${user.id}`,
        name: `Personal ${user.id}`,
        kind: "personal",
        personal_user_id: user.id,
        created_by_id: user.id,
      },
      update: {},
    });
    await tx.workspaceMember.upsert({
      where: { workspace_id_user_id: { workspace_id: ws.id, user_id: user.id } },
      create: { workspace_id: ws.id, user_id: user.id, role: "owner" },
      update: { active: true, role: "owner" },
    });
    await assignDefaultPolicy(tx, ws);
    return ws;
  });
  return workspace;
}

export type WorkspaceAction = "read" | "create" | "update" | "delete" | "manage";

/** Fixed team RBAC, separate from platform AdminRole and billing. */
export function canWorkspaceAction(role: "owner" | "admin" | "member" | "viewer", action: WorkspaceAction, isCreator = false): boolean {
  if (role === "owner" || role === "admin") return true;
  if (role === "viewer") return action === "read";
  if (action === "read" || action === "create") return true;
  return isCreator && (action === "update" || action === "delete");
}
export interface WorkspaceAccess {
  id: number;
  role: "owner" | "admin" | "member" | "viewer";
  personalWorkspaceId: number;
  kind: "personal" | "team";
}

/** Missing header selects personal workspace. An explicit invalid/revoked ID never falls back. */
export async function resolveWorkspaceAccess(
  c: Context<{ Variables: AppVariables }>, action: WorkspaceAction,
): Promise<WorkspaceAccess> {
  const user = c.get("user");
  if (!user) throw new HTTPException(401, { message: "Unauthorized" });
  const personal = await db.workspace.findUnique({ where: { personal_user_id: user.id }, select: { id: true } });
  if (!personal) throw new HTTPException(403, { message: "个人空间不存在" });
  const raw = c.req.header("x-workspace-id");
  const id = raw === undefined ? personal.id : Number(raw);
  if (!Number.isInteger(id) || id < 1) throw new HTTPException(400, { message: "非法工作空间 ID" });
  // Legacy user API keys are account-wide. Until scoped workspace keys are implemented,
  // they can only access their own personal workspace, never another team.
  if (id !== personal.id && c.req.header("authorization")?.toLowerCase().startsWith("bearer ")) {
    throw new HTTPException(403, { message: "团队空间需要工作空间凭证" });
  }
  const member = await db.workspaceMember.findUnique({
    where: { workspace_id_user_id: { workspace_id: id, user_id: user.id } },
    include: { workspace: { select: { kind: true } } },
  });
  if (!member?.active) throw new HTTPException(404, { message: "工作空间不存在" });
  if (!canWorkspaceAction(member.role, action)) throw new HTTPException(403, { message: "工作空间角色无权操作" });
  return { id, role: member.role, personalWorkspaceId: personal.id, kind: member.workspace.kind };
}
