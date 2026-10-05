import { AdminShell } from "@/components/console/admin-shell";
import { UserShell } from "@/components/console/user-shell";

/** 兼容入口：按 `adminMode` 分发到 UserShell / AdminShell，并保留既有导入路径。 */
export { getSession, requireSession, enforceConsoleBoundary, currentLocale, shellI18n } from "@/components/console/session";

/** 应用外壳。Toast 由根 layout 统一挂载。 */
export async function AppShell({
  titleKey,
  title,
  subtitleKey,
  subtitle,
  adminMode = false,
  activeHref,
  children,
}: {
  titleKey?: string;
  title?: string;
  subtitleKey?: string;
  subtitle?: string;
  /** true = Admin Console（AdminShell），false = User Console（UserShell） */
  adminMode?: boolean;
  /** 覆盖侧边栏高亮项（详情页等子页面用） */
  activeHref?: string;
  children: React.ReactNode;
}) {
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
