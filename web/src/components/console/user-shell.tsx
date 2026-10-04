import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { requireSession, shellI18n } from "@/components/console/session";
import { visibleNavGroups } from "@/lib/nav";

/**
 * UserShell —— 普通用户控制台外壳（服务端组件，V5-WP13.5A §9.4.1）。
 *
 * 与 `AdminShell` 分离：sidebar 分组、topbar 内容、内容区信息密度各自设计，
 * 但底层 UI / form / table / chart 组件与视觉 token 完全复用，不复制 design system。
 *
 * 用户体验取向：**宽间距、少而大的入口**。不出现 raw Node / Agent / lease / revision /
 * Federation 等运维概念（那些属于 Admin Console）。
 *
 * `AppShell`（兼容入口）按 `adminMode` 分发到这里；route group `(user)` 的 layout 负责边界。
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
