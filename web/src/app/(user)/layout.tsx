import { enforceConsoleBoundary } from "@/components/console/session";

/**
 * `(user)` route group —— **User Console**（V5-WP13.5A §9.4.1）。
 *
 * route group 目录名带括号，**不产生 URL 段**：`(user)/dashboard/page.tsx` 仍然是 `/dashboard`。
 * 这里只承担控制台边界（未登录 → `/login`，见 `console-guard.ts`），
 * 页面 chrome 仍由 `UserShell`（经兼容入口 `AppShell`）渲染 —— 标题是页面级信息，
 * 放在 shell 里比塞进 layout 更不容易出错。
 *
 * `display:contents` 让这层包装不影响既有 flex/min-h-screen 布局。
 */
export default async function UserConsoleLayout({ children }: { children: React.ReactNode }) {
  await enforceConsoleBoundary("user");
  return (
    <div data-console-group="user" className="contents">
      {children}
    </div>
  );
}
