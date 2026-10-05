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
}: {
  title: string;
  subtitle?: string;
  /** 控制台变体；缺省时按 `adminMode` 推断（兼容既有调用） */
  console?: ConsoleId;
  /** @deprecated 用 `console`；保留以兼容既有 `AppShell(adminMode)` 调用 */
  adminMode?: boolean;
}) {
  const { t } = useI18n();
  const variant: ConsoleId = consoleId ?? (adminMode ? "admin" : "user");
  const isAdmin = variant === "admin";

  return (
    <header
      data-console={variant}
      className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--background)]/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-[var(--background)]/70 lg:px-6"
    >
      <div className="min-w-0 pl-12 lg:pl-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-base font-semibold leading-tight" data-testid="page-title">
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
      <div className="flex shrink-0 items-center gap-1">
        {!isAdmin && <WorkspaceSwitcher />}
        <LocaleSwitcher />
        <ThemeToggle />
        <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-[var(--border)] sm:block" />
        {isAdmin ? (
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard">
              <ExternalLink className="size-4" />
              <span className="hidden sm:inline">{t("admin.backToSite")}</span>
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin">
              <LayoutGrid className="size-4" />
              <span className="hidden sm:inline">{t("common.admin")}</span>
            </Link>
          </Button>
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
