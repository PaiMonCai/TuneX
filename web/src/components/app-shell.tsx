import { AdminShell } from "@/components/console/admin-shell";
import { UserShell } from "@/components/console/user-shell";

/**
 * 兼容入口：既有页面全部通过 `AppShell` 渲染。
 *
 * V5-WP13.5A（§9.4.1）后，外壳分成了 `UserShell` / `AdminShell`（`components/console/`），
 * 本文件只保留「按 `adminMode` 分发 + 原导入路径继续可用」的职责：
 * 页面无需改动即可享受新的导航边界，后续新页面可以直接用对应 shell 或 route group layout。
 *
 * 会话 / i18n 辅助函数仍从这里再导出（`admin/page.tsx` 等既有代码依赖
 * `currentLocale` 的导入路径），真正实现移到了 `components/console/session.ts`。
 */
export { getSession, requireSession, enforceConsoleBoundary, currentLocale, shellI18n } from "@/components/console/session";

/**
 * 应用外壳（服务端组件）。
 *
 * 会话从 cookie 解析；mock 模式下 cookie=tunex_session 即视为已登录。
 * 传给客户端组件的 props 必须可序列化（导航里传的是 `iconKey` 字符串，不是组件函数）。
 *
 * `showToaster` 仅为兼容既有页面调用而保留；Toast 容器统一由根 layout 挂载。
 */
export async function AppShell({
  titleKey,
  title,
  subtitleKey,
  subtitle,
  adminMode = false,
  activeHref,
  showToaster: _showToaster = true,
  children,
}: {
  titleKey?: string;
  title?: string;
  subtitleKey?: string;
  subtitle?: string;
  /** true = Admin Console（AdminShell），false = User Console（UserShell） */
  adminMode?: boolean;
  /** 覆盖侧边栏高亮项（隧道详情等子页面用） */
  activeHref?: string;
  /** @deprecated Toast 由根 layout 统一挂载，此参数已无实际作用，仅为兼容页面调用 */
  showToaster?: boolean;
  children: React.ReactNode;
}) {
  void _showToaster;
  const Shell = adminMode ? AdminShell : UserShell;
  return (
    <Shell
      titleKey={titleKey}
      title={title}
      subtitleKey={subtitleKey}
      subtitle={subtitle}
      activeHref={activeHref}
    >
      {children}
    </Shell>
  );
}
