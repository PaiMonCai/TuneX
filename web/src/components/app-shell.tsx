import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LOCALE_COOKIE, getDictionary, normalizeLocale, type Dictionary, type Locale } from "@/lib/i18n";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";
import { adminNav, userNav, labelOf } from "@/lib/nav";

/** 服务端 Auth 守卫：读取 cookie 转发给后端/mock 校验会话 */
export async function requireSession(): Promise<{ user: User; cookie: string }> {
  const store = await cookies();
  const cookie = store.toString();
  try {
    const session = await api.auth.session(cookie);
    return { user: session.user, cookie };
  } catch {
    redirect("/login");
  }
}

/**
 * 当前语言（服务端读取 cookie）。
 * /admin 等页面会单独调用它，因此必须保持导出。
 */
export async function currentLocale(): Promise<Locale> {
  const store = await cookies();
  return normalizeLocale(store.get(LOCALE_COOKIE)?.value);
}

/** 服务端 i18n：locale + 词典 + 点号取词的 t（统一的 SSR 取词入口） */
export async function shellI18n(): Promise<{ locale: Locale; dict: Dictionary; t: (key: string) => string }> {
  const locale = await currentLocale();
  const dict = getDictionary(locale);
  return { locale, dict, t: (key: string) => labelOf(locale, key) };
}

/**
 * 应用外壳（服务端组件）：侧边栏 + 顶栏，用户端/管理端共用。
 * 会话从 cookie 解析；mock 模式下 cookie=relayx_session 即视为已登录。
 *
 * 传给客户端组件的 props 必须可序列化：`Sidebar` 收到的是 `iconKey` 字符串，
 * 不能是 React 组件函数（否则整页 500）。
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
  adminMode?: boolean;
  /** 覆盖侧边栏高亮项（隧道详情等子页面用） */
  activeHref?: string;
  /** @deprecated Toast 由根 layout 统一挂载，此参数已无实际作用，仅为兼容页面调用 */
  showToaster?: boolean;
  children: React.ReactNode;
}) {
  const [{ user, cookie }, { locale, t }] = await Promise.all([requireSession(), shellI18n()]);
  void cookie;
  void _showToaster;
  const resolvedTitle = title ?? (titleKey ? t(titleKey) : "");
  const resolvedSubtitle = subtitle ?? (subtitleKey ? t(subtitleKey) : undefined);
  return (
    <div className="flex min-h-screen bg-[var(--background)]" data-lang={locale}>
      <Sidebar
        items={adminMode ? adminNav : userNav}
        locale={locale}
        user={user}
        adminMode={adminMode}
        activeHref={activeHref}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar title={resolvedTitle} subtitle={resolvedSubtitle} adminMode={adminMode} />
        <main className="mx-auto w-full max-w-[1400px] flex-1 p-4 pt-16 lg:p-6 lg:pt-6">
          {children}
        </main>
      </div>
    </div>
  );
}
