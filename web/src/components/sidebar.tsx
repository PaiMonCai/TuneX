"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { NavIcon } from "@/components/nav-icon";
import { useI18n } from "@/components/providers";
import { cn } from "@/lib/utils";
import { localizedLabel, navGroupLabel, type ConsoleId, type NavGroup, type NavItem } from "@/lib/nav";
import type { Locale } from "@/lib/i18n";
import type { User } from "@/lib/types";
import { api } from "@/lib/api";
import { toast } from "sonner";

/**
 * User / Admin Console 共用侧栏实现。导航项只携带可序列化数据；
 * `status:"planned"` 项显示为禁用入口，避免链接到尚未交付的页面。
 */
export function Sidebar({
  groups,
  locale,
  user,
  console: consoleId = "user",
  activeHref,
}: {
  groups: NavGroup[];
  locale: Locale;
  user: User;
  console?: ConsoleId;
  activeHref?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, locale: cur } = useI18n();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const mobilePanel = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const isAdmin = consoleId === "admin";
  const collapseLabel = cur === "zh" ? "收起侧栏" : "Collapse sidebar";
  const expandLabel = cur === "zh" ? "展开侧栏" : "Expand sidebar";

  useEffect(() => {
    try { setCollapsed(window.localStorage.getItem("tunex.sidebar.collapsed") === "true"); } catch { /* Storage is optional. */ }
  }, []);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try { window.localStorage.setItem("tunex.sidebar.collapsed", String(next)); } catch { /* Storage is optional. */ }
  }

  // 路由变化后自动收起移动端抽屉
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 抽屉打开时：Esc 关闭 + 锁定背景滚动
  useEffect(() => {
    if (!open) return;
    const desktop = window.matchMedia("(min-width: 1024px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    const content = document.querySelector<HTMLElement>("[data-console-content]");
    const previousInert = content?.inert ?? false;
    if (content) content.inert = true;
    mobilePanel.current?.querySelector<HTMLElement>("button, a[href]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key !== "Tab") return;
      const items = mobilePanel.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), [tabindex="0"]');
      if (!items?.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      if (content) content.inert = previousInert;
      window.removeEventListener("keydown", onKey);
      desktop.removeEventListener("change", closeOnDesktop);
      if (!desktop.matches) menuButton.current?.focus();
      else content?.querySelector<HTMLElement>("a[href], button")?.focus();
    };
  }, [open]);

  async function logout() {
    try {
      await api.auth.logout();
    } catch {
      /* 忽略 */
    }
    toast.success(t("common.logout"));
    router.push("/login");
    router.refresh();
  }

  const brand = (
    <div className={cn("flex h-16 shrink-0 items-center gap-3 border-b border-[var(--border)] px-5", collapsed && "lg:justify-center lg:px-2")}>
      <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--primary)] text-sm font-bold tracking-tight text-[var(--primary-foreground)]">
        TX
      </div>
      <div className={cn("min-w-0 leading-tight", collapsed && "lg:sr-only")}>
        <div className="text-base font-semibold tracking-tight">{t("common.siteName")}</div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--muted-foreground)]">
          {isAdmin ? t("admin.title") : t("common.tagline")}
        </div>
      </div>
    </div>
  );

  const renderItem = (group: NavGroup, item: NavItem) => {
    const label = localizedLabel(cur, item.labelKey, item.labelZh ?? item.labelKey, item.labelEn ?? item.labelKey);
    const at = activeHref ?? pathname;
    const active = at === item.href || (item.href !== "/admin" && at.startsWith(`${item.href}/`));

    // 未交付页面只展示禁用状态，不生成可点击链接。
    if (item.status === "planned") {
      return (
        <span
          key={item.href}
          aria-label={label}
          aria-disabled="true"
          data-nav-href={item.href}
          data-nav-group={group.id}
          data-nav-status="planned"
          title={localizedLabel(
            cur,
            "console.plannedHint",
            "该页面尚未开放（后续 WP 落地）",
            "Not available yet (landing in a later WP)",
          )}
          className={cn(
            "relative flex cursor-not-allowed items-center gap-2.5 rounded-md px-3 text-sm text-[var(--muted-foreground)]/60",
            "min-h-10 py-2",
            collapsed && "lg:justify-center lg:px-0",
          )}
        >
          <NavIcon name={item.iconKey} className="size-4 shrink-0" />
          <span className={cn("truncate", collapsed && "lg:sr-only")}>{label}</span>
          <span className={cn("ml-auto rounded-sm border border-[var(--border)] px-1 text-[10px] leading-4", collapsed && "lg:hidden")}>
            {localizedLabel(cur, "console.planned", "未开放", "Soon")}
          </span>
        </span>
      );
    }

    return (
      <Link
        key={item.href}
        href={item.href}
        aria-label={label}
        title={collapsed ? label : undefined}
        aria-current={active ? "page" : undefined}
        data-nav-href={item.href}
        data-nav-group={group.id}
        data-nav-status="available"
        onClick={() => setOpen(false)}
        className={cn(
          "relative flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
          collapsed && "lg:justify-center lg:px-0",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          active
            ? "bg-[var(--sidebar-accent)] font-semibold text-[var(--foreground)]"
            : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
        )}
      >
        <NavIcon name={item.iconKey} className="size-[18px] shrink-0" />
        <span className={cn("truncate", collapsed && "lg:sr-only")}>{label}</span>
      </Link>
    );
  };

  const renderNav = (testId: string) => (
    <nav
      className={cn("flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-4", collapsed && "lg:px-2")}
      id={testId}
      aria-label={isAdmin ? t("admin.title") : t("common.menu")}
      data-testid={testId}
      data-lang={locale}
      data-console={consoleId}
      data-nav-console={consoleId}
    >
      {groups.map((group) => (
        <div key={group.id} className="flex flex-col gap-0.5" data-nav-group-section={group.id}>
          {!group.plain && (
            <div
              className={cn(
                "px-3 pb-1 text-[11px] font-medium text-[var(--muted-foreground)]",
                collapsed && "lg:sr-only",
              )}
            >
              {navGroupLabel(locale, group)}
            </div>
          )}
          {group.items.map((item) => renderItem(group, item))}
        </div>
      ))}
    </nav>
  );

  const footer = (
    <div className={cn("shrink-0 border-t border-[var(--border)] p-3", collapsed && "lg:px-2")}>
      <div className={cn("mb-2 flex items-center gap-3 rounded-lg px-1 py-2", collapsed && "lg:justify-center")}>
        <div className="grid size-7 place-items-center rounded-full bg-[var(--muted)] text-xs font-medium">
          {user.email.slice(0, 1).toUpperCase()}
        </div>
        <div className={cn("min-w-0 flex-1", collapsed && "lg:sr-only")}>
          <div className="truncate text-xs font-medium">{user.email}</div>
          <div className="text-[11px] text-[var(--muted-foreground)]">
            {process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true" ? `¥${user.balance.toFixed(2)}` : user.super_admin ? t("common.admin") : t("common.tagline")}
          </div>
        </div>
      </div>
      <Button variant="ghost" size="sm" className={cn("w-full justify-start", collapsed && "lg:justify-center lg:px-0")} onClick={logout} data-testid="logout" aria-label={t("common.logout")} title={collapsed ? t("common.logout") : undefined}>
        <LogOut className="size-4" />
        <span className={cn(collapsed && "lg:sr-only")}>{t("common.logout")}</span>
      </Button>
    </div>
  );

  return (
    <>
      <a href="#console-main" className="sr-only fixed left-4 top-4 z-[60] rounded-lg bg-[var(--card)] p-3 text-sm shadow-lg focus:not-sr-only focus:outline-2 focus:outline-[var(--ring)]">
        {cur === "zh" ? "跳至主要内容" : "Skip to content"}
      </a>
      {/* 移动端菜单按钮 */}
      <Button
        variant="ghost"
        size="icon"
        ref={menuButton}
        className="fixed left-3 top-3 z-40 lg:hidden"
        aria-expanded={open}
        aria-controls="app-sidebar-mobile"
        // 图标按钮没有可见文字：这个可访问名称就是它的全部语义，必须跟随语言
        // （旧实现写死英文 "menu"，中文界面下屏幕阅读器读英文）。
        aria-label={t("common.menu")}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </Button>

      {/* 桌面侧栏 */}
      <aside
        data-testid="sidebar"
        data-nav-console={consoleId}
        data-collapsed={collapsed}
        className={cn(
          "sticky top-0 hidden h-svh shrink-0 flex-col border-r border-[var(--border)] bg-[var(--sidebar)] transition-[width] duration-200 motion-reduce:transition-none lg:flex",
          collapsed ? "w-[76px]" : "w-64",
        )}
      >
        {brand}
        {renderNav("sidebar-nav")}
        <div className="px-3 pb-3">
          <Button variant="ghost" size="sm" onClick={toggleCollapsed} className={cn("w-full justify-start text-[var(--muted-foreground)]", collapsed && "justify-center px-0")}
            aria-label={collapsed ? expandLabel : collapseLabel} title={collapsed ? expandLabel : collapseLabel}
            aria-expanded={!collapsed} aria-controls="sidebar-nav" data-testid="sidebar-collapse">
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            {!collapsed && <span>{collapseLabel}</span>}
          </Button>
        </div>
        {footer}
      </aside>

      {/* 移动端侧栏 */}
      {open && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            id="app-sidebar-mobile"
            ref={mobilePanel}
            role="dialog"
            aria-modal="true"
            aria-label={t("common.menu")}
            className={cn(
              "relative flex h-svh w-72 max-w-[85vw] flex-col border-r border-[var(--border)] bg-[var(--sidebar)] shadow-xl",
            )}
          >
            <Button variant="ghost" size="icon" className="absolute right-2 top-3" aria-label={t("common.closeMenu")} onClick={() => setOpen(false)}><X /></Button>
            {brand}
            {renderNav("sidebar-nav-mobile")}
            {footer}
          </div>
          <SidebarBackdrop onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}

/**
 * 移动端抽屉的遮罩层按钮（点击关闭抽屉）。
 *
 * 单独导出有两个原因：它**没有可见文字**，其 `aria-label` 就是它的全部语义，必须
 * 跟随语言（旧实现写死英文 "close"）；而抽屉本身只在 `open` 时才渲染，静态渲染拿不到
 * 它，抽出来才能在不依赖浏览器的情况下断言这条行为。
 */
export function SidebarBackdrop({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      aria-label={t("common.closeMenu")}
      tabIndex={-1}
      className="flex-1 bg-black/40 backdrop-blur-[1px]"
      onClick={onClose}
    />
  );
}
