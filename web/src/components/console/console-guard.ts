import type { ConsoleSurface } from "@/lib/nav";

/**
 * 前端控制台边界规则（V5-WP13.5A §9.4.1 要求 3）。
 *
 * **这里的每一条都只是 UX，不是授权。**
 * 真正的 RBAC / workspace scope 真相在后端：
 * - `/api/admin/*` 由后端校验 `super_admin` 或后台角色（`admin_roles`）；
 * - workspace 资源由后端按 `node:read` / `node:manage` 等权限裁剪。
 *
 * 为什么前端**不能**按 `super_admin` 做重定向：
 * `/api/auth/me` 只返回 `super_admin`，不返回 `admin_roles`（见 backend/src/routes/auth.ts
 * 的 `publicUser()`），而后端存在「有后台角色的 admin」（`services/audit.ts` 的
 * `classifyActor()` 明确区分 `super_admin` 与 `admin`）。
 * 若前端用 `super_admin === false` 把用户踢回 `/dashboard`，就会误伤这些合法的角色管理员，
 * 把「前端猜测」变成事实上的授权判定 —— 正是 §9.4.1 禁止的方向。
 * 因此：前端只做「未登录 → /login」，其余交给后端。
 */

/** 未登录时的落点（既有行为） */
export const LOGIN_PATH = "/login";

/** 用户端首页（管理端「返回用户端」入口） */
export const USER_HOME_PATH = "/dashboard";

export type GuardDecision =
  | { action: "render"; surface: ConsoleSurface }
  | { action: "redirect"; to: string; reason: "unauthenticated" };

/**
 * 控制台边界判定（纯函数，可单测）。
 *
 * - 未登录访问需要登录的表面（`user` / `admin`）→ 重定向 `/login`；
 * - `auth`（登录/注册/找回密码/验证邮箱）与 `public`（`/` 落地页）不因登录状态重定向
 *   —— 已登录用户打开 `/login` 保持既有行为；
 * - 已登录 → 一律渲染，**不**根据角色做任何重定向（见文件头注释）。
 */
export function guardConsoleAccess(input: { surface: ConsoleSurface; authenticated: boolean }): GuardDecision {
  if (input.authenticated) return { action: "render", surface: input.surface };
  if (input.surface === "user" || input.surface === "admin") {
    return { action: "redirect", to: LOGIN_PATH, reason: "unauthenticated" };
  }
  return { action: "render", surface: input.surface };
}

/** 会话里的管理端身份状态（仅用于展示 / 埋点，不用于拦截） */
export type AdminAccessState = "super_admin" | "delegated";

/**
 * `delegated` = 「前端判不了，由后端 RBAC 判定」：可能是有后台角色的管理员，
 * 也可能是普通用户 —— 两者在前端看到的数据完全一致，差别由后端 401/403 决定。
 */
export function adminAccessState(user: { super_admin?: boolean } | null | undefined): AdminAccessState {
  return user?.super_admin === true ? "super_admin" : "delegated";
}

/**
 * 某表面的「首页」落点：由 Admin Console 切回 User Console 时用。
 * 保持既有 URL（`/dashboard` / `/admin`），不引入新的跳转路径。
 */
export function consoleHomePath(surface: ConsoleSurface): string {
  if (surface === "admin") return "/admin";
  if (surface === "auth") return LOGIN_PATH;
  return USER_HOME_PATH;
}
