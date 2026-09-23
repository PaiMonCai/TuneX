"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { NavIcon } from "@/components/nav-icon";
import { useI18n } from "@/components/providers";
import { cn } from "@/lib/utils";
import { labelOf, type NavItem } from "@/lib/nav";
import type { Locale } from "@/lib/i18n";
import type { User } from "@/lib/types";
import { api } from "@/lib/api";
import { toast } from "sonner";

/**
 * 侧边栏（客户端组件）。
 *
 * 重要：`items` 里只能有可序列化字段（href / labelKey / iconKey），
 * 图标由客户端 `NavIcon` 按 key 解析 —— 服务端组件不能把组件函数当 props 传过来。
 */
export function Sidebar({
  items,
  locale,
  user,
  adminMode = false,
  activeHref,
}: {
  items: NavItem[];
  locale: Locale;
  user: User;
  adminMode?: boolean;
  activeHref?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { t, locale: cur } = useI18n();
  const [open, setOpen] = useState(false);

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
    <div className="flex items-center gap-2 px-3 py-4">
      <div className="grid size-8 place-items-center rounded-md bg-[var(--primary)] text-sm font-bold text-[var(--primary-foreground)]">
        R
      </div>
      <div className="leading-tight">
        <div className="text-sm font-semibold">{t("common.siteName")}</div>
        <div className="text-[11px] text-[var(--muted-foreground)]">
          {adminMode ? t("admin.title") : t("common.tagline")}
        </div>
      </div>
    </div>
  );

  const renderNav = (testId: string) => (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 py-1" data-testid={testId} data-lang={locale}>
      {items.map((item) => {
        const at = activeHref ?? pathname;
        const active = at === item.href || (item.href !== "/admin" && at.startsWith(`${item.href}/`));
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={() => setOpen(false)}
            className={cn(
              "relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
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
            <span className="truncate">{labelOf(cur, item.labelKey)}</span>
          </Link>
        );
      })}
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
        className="hidden w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--card)] lg:flex"
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
            className="flex w-64 flex-col border-r border-[var(--border)] bg-[var(--card)] shadow-xl"
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
