"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
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
 * 侧边栏（客户端组件），User Console / Admin Console 共用同一实现、不同参数。
 *
 * 重要：`groups` 里只能有可序列化字段（href / labelKey / iconKey 字符串），
 * 图标由客户端 `NavIcon` 按 key 解析 —— 服务端组件不能把组件函数当 props 传过来。
 *
 * 控制台差异（V5-WP13.5A §9.4.1）：
 * - admin：更宽（w-64）、分组标题常显、行更紧凑（py-1.5）、无 workspace 语境；
 * - user：w-60、行距更松（py-2）、首页分组不显示标题。
 *
 * `status:"planned"` 的项（Route Profiles / Federation …）渲染为**禁用项**：不是链接，
 * 因此不会产生 404，也不会把未落位的内部概念做成可点击入口。
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
  const isAdmin = consoleId === "admin";

  // 路由变化后自动收起移动端抽屉
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // 抽屉打开时：Esc 关闭 + 锁定背景滚动
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
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
    <div className={cn("flex items-center gap-2 px-3", isAdmin ? "py-3" : "py-4")}>
      <div className="grid size-8 place-items-center rounded-md bg-[var(--primary)] text-sm font-bold text-[var(--primary-foreground)]">
        R
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold">{t("common.siteName")}</div>
        <div className="text-[11px] text-[var(--muted-foreground)]">
          {isAdmin ? t("admin.title") : t("common.tagline")}
        </div>
      </div>
    </div>
  );

  const renderItem = (group: NavGroup, item: NavItem) => {
    const label = localizedLabel(cur, item.labelKey, item.labelZh ?? item.labelKey, item.labelEn ?? item.labelKey);
    const at = activeHref ?? pathname;
    const active = at === item.href || (item.href !== "/admin" && at.startsWith(`${item.href}/`));

    // planned：§9.4.1 已冻结但页面未落位 —— 只用禁用项表达，绝不生成 404 链接
    if (item.status === "planned") {
      return (
        <span
          key={item.href}
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
            isAdmin ? "py-1.5" : "py-2",
          )}
        >
          <NavIcon name={item.iconKey} className="size-4 shrink-0" />
          <span className="truncate">{label}</span>
          <span className="ml-auto rounded-sm border border-[var(--border)] px-1 text-[10px] leading-4">
            {localizedLabel(cur, "console.planned", "未开放", "Soon")}
          </span>
        </span>
      );
    }

    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        data-nav-href={item.href}
        data-nav-group={group.id}
        data-nav-status="available"
        onClick={() => setOpen(false)}
        className={cn(
          "relative flex items-center gap-2.5 rounded-md px-3 text-sm transition-colors",
          isAdmin ? "py-1.5" : "py-2",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          active
            ? "bg-[var(--accent)] font-medium text-[var(--accent-foreground)]"
            : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
        )}
      >
        {active && (
          <span
            aria-hidden="true"
            className="absolute inset-y-1.5 -left-2 w-0.5 rounded-full bg-[var(--primary)]"
          />
        )}
        <NavIcon name={item.iconKey} className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
      </Link>
    );
  };

  const renderNav = (testId: string) => (
    <nav
      className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-1"
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
                "px-3 pt-3 text-[10px] font-medium tracking-wide text-[var(--muted-foreground)]",
                isAdmin ? "uppercase" : "",
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
    <div className="border-t border-[var(--border)] p-3">
      <div className="mb-2 flex items-center gap-2 px-1">
        <div className="grid size-7 place-items-center rounded-full bg-[var(--muted)] text-xs font-medium">
          {user.email.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{user.email}</div>
          <div className="text-[11px] text-[var(--muted-foreground)]">
            ¥{user.balance.toFixed(2)}
            {user.super_admin ? " · admin" : ""}
          </div>
        </div>
      </div>
      <Button variant="ghost" size="sm" className="w-full justify-start" onClick={logout} data-testid="logout">
        <LogOut className="size-4" />
        {t("common.logout")}
      </Button>
    </div>
  );

  return (
    <>
      {/* 移动端顶部按钮（仅在 < lg 显示，和 Topbar 同高对齐） */}
      <Button
        variant="ghost"
        size="icon"
        className="fixed left-3 top-2.5 z-40 lg:hidden"
        aria-expanded={open}
        aria-controls="app-sidebar-mobile"
        aria-label="menu"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X className="size-5" /> : <Menu className="size-5" />}
      </Button>

      {/* 桌面端固定侧栏 */}
      <aside
        data-testid="sidebar"
        data-nav-console={consoleId}
        className={cn(
          "hidden shrink-0 flex-col border-r border-[var(--border)] bg-[var(--card)] lg:flex",
          isAdmin ? "w-64" : "w-60",
        )}
      >
        {brand}
        {renderNav("sidebar-nav")}
        {footer}
      </aside>

      {/* 移动端抽屉 */}
      {open && (
        <div className="fixed inset-0 z-30 flex lg:hidden">
          <div
            id="app-sidebar-mobile"
            role="dialog"
            aria-modal="true"
            className={cn(
              "flex flex-col border-r border-[var(--border)] bg-[var(--card)] shadow-xl",
              isAdmin ? "w-72" : "w-64",
            )}
          >
            {brand}
            {renderNav("sidebar-nav-mobile")}
            {footer}
          </div>
          <button
            type="button"
            aria-label="close"
            tabIndex={-1}
            className="flex-1 bg-black/40 backdrop-blur-[1px]"
            onClick={() => setOpen(false)}
          />
        </div>
      )}
    </>
  );
}
