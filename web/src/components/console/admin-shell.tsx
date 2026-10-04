import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { requireSession, shellI18n } from "@/components/console/session";
import { adminAccessState } from "@/components/console/console-guard";
import { visibleNavGroups } from "@/lib/nav";

/**
 * AdminShell —— 管理控制台外壳（服务端组件，V5-WP13.5A §9.4.1）。
 *
 * 与 `UserShell` 分离，信息密度明显更高：
 * - 侧栏更宽（w-64）、导航按 §9.4.1 分八组（Infrastructure / Network / … / Federation / System）；
 * - topbar 常驻 ADMIN 标识与环境徽章，去掉面向用户的 workspace 切换器；
 * - 内容区更宽（max-w-[1800px]）且纵向更紧凑 —— 管理页是「扫表 + 就地编辑」场景。
 *
 * Federation / trust / grant / remote lease / audit / license 等内部概念只在这里出现；
 * 管理端页面可以展开 revision / lease / Agent ACK / diagnostics（§9.4.7）。
 *
 * `data-admin-access` 只表达「前端能否判定超管」（`super_admin` / `delegated`），
 * **不做任何拦截**：授权真相在后端 RBAC（见 console-guard.ts 文件头说明）。
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
