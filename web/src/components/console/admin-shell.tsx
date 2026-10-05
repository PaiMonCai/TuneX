import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { requireSession, shellI18n } from "@/components/console/session";
import { adminAccessState } from "@/components/console/console-guard";
import { visibleNavGroups } from "@/lib/nav";

/**
 * 管理控制台外壳。管理端允许展示 revision / lease / Agent ACK / diagnostics 等内部事实；
 * `data-admin-access` 仅用于展示和诊断，授权真相始终在后端 RBAC。
 */
export async function AdminShell({
  titleKey,
  title,
  subtitleKey,
  subtitle,
  activeHref,
  children,
}: {
  titleKey?: string;
  title?: string;
  subtitleKey?: string;
  subtitle?: string;
  /** 覆盖侧边栏高亮项（节点详情等子页面用） */
  activeHref?: string;
  children: React.ReactNode;
}) {
  const [{ user }, { locale, t }] = await Promise.all([requireSession(), shellI18n()]);
  const resolvedTitle = title ?? (titleKey ? t(titleKey) : "");
  const resolvedSubtitle = subtitle ?? (subtitleKey ? t(subtitleKey) : undefined);

  return (
    <div
      className="flex min-h-screen bg-[var(--background)]"
      data-lang={locale}
      data-console="admin"
      data-admin-access={adminAccessState(user)}
    >
      <Sidebar
        groups={visibleNavGroups("admin")}
        locale={locale}
        user={user}
        console="admin"
        activeHref={activeHref}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar title={resolvedTitle} subtitle={resolvedSubtitle} console="admin" />
        <main className="mx-auto w-full max-w-[1800px] flex-1 p-4 pt-16 lg:px-6 lg:py-4 lg:pt-4">
          {children}
        </main>
      </div>
    </div>
  );
}
