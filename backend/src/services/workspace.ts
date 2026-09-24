import type { Prisma } from "@prisma/client";
import { db } from "../db.ts";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { AppVariables } from "../middlewares/auth.ts";
import { assignDefaultPolicy } from "./policy-service.ts";
import { customRoleGrants } from "./workspace-permissions.ts";

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
  /**
   * TEAM-01：成员绑定的自定义角色 id（NULL = 固定四角色）。
   * 路由层需要它来把「管理动作」翻译成细粒度权限时读它。
   */
  customRoleId: number | null;
}

/**
 * 固定四角色的粗粒度动作 → 细粒度权限键的映射。
 *
 * 为什么需要它：`resolveWorkspaceAccess(c, action)` 的入参是粗动作（tunnels.ts 的
 * 中间件只会区分 create/read，node-groups.ts 只会区分 manage/read）。自定义角色
 * 授权的是 11 个细粒度键，因此必须有一张**单向**的翻译表把粗动作落到细粒度键上。
 *
 * 映射取向（保守）：manage 需要该资源族里最高的一档（manage），而不是宽松地
 * 「任何一档都算」；宁可他拿不到，也不要因为翻译表写松而越过自定义角色的本意。
 */
const ACTION_REQUIRED_PERMISSION: Record<WorkspaceAction, string> = {
  read: "read",
  create: "create",
  update: "update",
  delete: "delete",
  manage: "manage",
};

/**
 * 把粗动作翻译成自定义角色的细粒度权限判定。
 *
 * 返回三态，好让调用方区分「没有自定义角色」和「有自定义角色但没授权」：
 *   · `null`   —— 成员没有自定义角色（或角色悬空/跨 workspace），调用方照旧用固定四角色判；
 *   · `true`   —— 自定义角色授予了对应权限；
 *   · `false`  —— 自定义角色存在但未授予（调用方决定是拒绝还是回落到基础角色）。
 *
 * 翻译表按资源族展开，因为不同路由的同一粗动作对应的资源不同：
 *   · tunnels.ts 的 "update"/"delete" → tunnel:update / tunnel:delete；
 *   · node-groups.ts 的 "manage"     → node:manage；
 *   · workspaces.ts 成员的 "manage"  → member:manage。
 * 无法唯一确定资源族时取「该动作在所有资源族里都需要」的并集不存在 → false，
 * 因此未知 resourceFamily 一律拒绝（fail-closed）。
 */
export type WorkspaceResourceFamily = "tunnel" | "node" | "member" | "settings" | "audit";

export function actionFromCustomRole(
  permissions: unknown,
  action: WorkspaceAction,
  resource: WorkspaceResourceFamily = "tunnel",
): boolean | null {
  if (!permissions) return null; // 无权限数据 = 没有生效的自定义角色
  const required = ACTION_REQUIRED_PERMISSION[action];
  if (!required) return false; // 未知 action → 拒绝
  if (resource === "audit") return customRoleGrants(permissions, "audit:read");
  return customRoleGrants(permissions, `${resource}:${required}` as string);
}

/** Missing header selects personal workspace. An explicit invalid/revoked ID never falls back. */
export async function resolveWorkspaceAccess(
  c: Context<{ Variables: AppVariables }>,
  action: WorkspaceAction,
  /** TEAM-01：动作落在哪个资源族上。默认 tunnel（tunnels.ts 的调用不传）。 */
  resource: WorkspaceResourceFamily = "tunnel",
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
    include: { workspace: { select: { kind: true } }, custom_role: { select: { id: true, workspace_id: true, permissions: true } } },
  });
  if (!member?.active) throw new HTTPException(404, { message: "工作空间不存在" });

  // TEAM-01：绑定了自定义角色时，细粒度权限优先于固定四角色判定。
  //
  // fail-closed 兜底（任一成立即视为「没有生效的自定义角色」，回落到 role 列）：
  //   1. role_id 悬空 —— 自定义角色已被删除，Prisma 的 relation 返回 null；
  //   2. 角色不属于本 workspace —— 跨 workspace 的脏引用不能拿来授权；
  //   3. permissions 缺失/不是对象。
  //
  // 回落方向（关键）：自定义角色**无权**时不是直接 403，而是退回用 role 列再判一次。
  // 否则一个 owner 被误绑空角色就会把自己锁在 workspace 外，而 owner 的固定语义
  // （全权）本就不该被一个空角色的疏漏剥夺。owner/admin 的固定权限是上界，
  // 自定义角色只能在上界之内收窄、放大（例如给 viewer 授予 tunnel:create）。
  const customRole = member.custom_role && member.custom_role.workspace_id === id ? member.custom_role : null;
  const granted = customRole ? actionFromCustomRole(customRole.permissions, action, resource) : null;
  const allowedByBaseRole = canWorkspaceAction(member.role, action);
  if (granted === true) {
    // 细粒度授权通过
  } else if (granted === false && allowedByBaseRole) {
    // 自定义角色未授予，但固定角色允许：放行（自定义角色只收窄，不剥夺固定角色的既有权）
  } else if (!allowedByBaseRole) {
    throw new HTTPException(403, { message: "工作空间角色无权操作" });
  }
  return {
    id,
    role: member.role,
    personalWorkspaceId: personal.id,
    kind: member.workspace.kind,
    customRoleId: member.role_id ?? null,
  };
}
