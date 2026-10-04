import { enforceConsoleBoundary } from "@/components/console/session";

/**
 * `(auth)` route group —— 认证页（登录 / 注册 / 重置密码 / 忘记密码 / 验证邮箱）。
 *
 * URL 不变（`(auth)/login/page.tsx` → `/login`）。
 * 认证页自带 `AuthShell`（居中外壳，无 sidebar）；这里只钉住两件事：
 * 1. 认证页不做「已登录就跳走」的重定向（保持既有行为，`console-guard.ts` 的 `auth` 分支恒为 render）；
 * 2. group 归属在 DOM 上可见（`data-console-group`），供边界测试与排查使用。
 */
export default async function AuthConsoleLayout({ children }: { children: React.ReactNode }) {
  await enforceConsoleBoundary("auth");
  return (
    <div data-console-group="auth" className="contents">
      {children}
    </div>
  );
}
