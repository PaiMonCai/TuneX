import { enforceConsoleBoundary } from "@/components/console/session";

/**
 * `(admin)` route group —— **Admin Console**（V5-WP13.5A §9.4.1）。
 *
 * 只有管理端产品表面落在这里；Federation / trust / grant / remote lease / audit /
 * license 等内部概念从结构上就出不去这个 group。
 * URL 不变：`(admin)/admin/nodes/page.tsx` 仍然是 `/admin/nodes`。
 *
 * 边界只做「未登录 → /login」：**不按 `super_admin` 拦截**。
 * `/api/auth/me` 不返回 `admin_roles`，前端无法区分超管与后台角色管理员，
 * 用它做重定向会误伤合法管理员并把前端猜测变成事实授权 —— 授权真相在后端 RBAC
 * （见 `components/console/console-guard.ts` 文件头）。
 */
export default async function AdminConsoleLayout({ children }: { children: React.ReactNode }) {
  await enforceConsoleBoundary("admin");
  return (
    <div data-console-group="admin" className="contents">
      {children}
    </div>
  );
}
