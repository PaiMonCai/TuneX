import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { requireSession, shellI18n } from "@/components/console/session";
import { visibleNavGroups } from "@/lib/nav";

/**
 * 普通用户控制台外壳。用户侧保持较低信息密度，不暴露 lease / revision /
 * Federation 等内部运维概念。
 */
export async function UserShell({
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
  /** 覆盖侧边栏高亮项（转发详情等子页面用） */
  activeHref?: string;
  children: React.ReactNode;
}) {
  const [{ user }, { locale, t }] = await Promise.all([requireSession(), shellI18n()]);
  const resolvedTitle = title ?? (titleKey ? t(titleKey) : "");
  const resolvedSubtitle = subtitle ?? (subtitleKey ? t(subtitleKey) : undefined);

  return (
    <div className="flex min-h-screen bg-[var(--background)]" data-lang={locale} data-console="user">
      <Sidebar
        groups={visibleNavGroups("user")}
        locale={locale}
        user={user}
        console="user"
        activeHref={activeHref}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar title={resolvedTitle} subtitle={resolvedSubtitle} console="user" />
        <main className="mx-auto w-full max-w-[1400px] flex-1 p-4 pt-16 lg:p-6 lg:pt-6">{children}</main>
      </div>
    </div>
  );
}
