"use client";

import Link from "next/link";
import { ExternalLink, LayoutGrid, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { useI18n } from "@/components/providers";
import type { ConsoleId } from "@/lib/nav";

/** 顶栏：页面标题、语言/主题和 User/Admin Console 切换。 */
export function Topbar({
  title,
  subtitle,
  console: consoleId,
  adminMode,
  showAdminEntry = true,
}: {
  title: string;
  subtitle?: string;
  /** 控制台变体；缺省时按 `adminMode` 推断（兼容既有调用） */
  console?: ConsoleId;
  /** @deprecated 用 `console`；保留以兼容既有 `AppShell(adminMode)` 调用 */
  adminMode?: boolean;
  /**
   * 用户控制台里「管理后台」入口是否可见。
   *
   * 由 `UserShell` 按**真实权限读数**决定（`canEnterAdminConsole(readAdminPersona())`）；
   * 缺省 `true` 是刻意的 fail-open：读数取不到（`unknown`）时宁可多显示一个入口
   * （点进去有受控错误面），也不凭一次失败隐藏合法管理员入口。
   */
  showAdminEntry?: boolean;
}) {
  const { t } = useI18n();
  const variant: ConsoleId = consoleId ?? (adminMode ? "admin" : "user");
  const isAdmin = variant === "admin";

  return (
    <header
      data-console={variant}
      className="sticky top-0 z-20 flex min-h-16 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-[var(--border)] bg-[var(--card)]/95 px-3 py-3 backdrop-blur sm:flex-nowrap sm:px-6 lg:px-8"
    >
      <div className="min-w-0 flex-1 pl-11 lg:pl-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg" data-testid="page-title">
            {title}
          </h1>
          {isAdmin && (
            <Badge variant="outline" className="hidden shrink-0 md:inline-flex" data-testid="console-badge">
              <ShieldCheck className="size-3" />
              ADMIN
            </Badge>
          )}
        </div>
        {subtitle && (
          <p
            className={
              isAdmin
                ? "truncate text-[11px] text-[var(--muted-foreground)]"
                : "truncate text-xs text-[var(--muted-foreground)]"
            }
          >
            {subtitle}
          </p>
        )}
      </div>
      <div className="flex min-w-0 max-w-full shrink-0 items-center gap-1 max-sm:w-full" data-testid="topbar-actions">
        {!isAdmin && <WorkspaceSwitcher />}
        <LocaleSwitcher />
        <ThemeToggle />
        <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-[var(--border)] sm:block" />
        {isAdmin ? (
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard" aria-label={t("admin.backToSite")}>
              <ExternalLink className="size-4" />
              <span className="hidden sm:inline">{t("admin.backToSite")}</span>
            </Link>
          </Button>
        ) : (
          showAdminEntry && (
            <Button variant="outline" size="sm" asChild data-testid="topbar-admin-entry">
              <Link href="/admin" aria-label={t("common.admin")}>
                <LayoutGrid className="size-4" />
                <span className="hidden sm:inline">{t("common.admin")}</span>
              </Link>
            </Button>
          )
        )}
        {process.env.NEXT_PUBLIC_API_MOCK === "1" && (
          <Badge variant="outline" className="hidden md:inline-flex" data-testid="mock-badge">
            MOCK API
          </Badge>
        )}
      </div>
    </header>
  );
}
