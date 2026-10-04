"use client";

import Link from "next/link";
import { Bell, ExternalLink, LayoutGrid, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { useI18n } from "@/components/providers";
import type { ConsoleId } from "@/lib/nav";

/**
 * 顶栏（客户端组件）：页面标题 + 通知/语言/主题/控制台切换。
 * 标题由服务端 shell 按 cookie 语言解析后传入，保证 SSR 文案正确。
 *
 * User / Admin 变体（§9.4.1「topbar 分别设计」）：
 * - user：workspace 切换器 + 通知铃 + 「管理后台」入口；
 * - admin：ADMIN 标识 + 环境徽章 + 「返回用户端」入口，无 workspace 语境（管理端不参与 workspace scope）。
 */
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
        {/* TEN-01：工作空间切换器（仅用户端；管理后台不参与 workspace 作用域） */}
        {!isAdmin && <WorkspaceSwitcher />}
        {!isAdmin && (
          <Button variant="ghost" size="icon" aria-label={t("common.tickets")} className="hidden sm:inline-flex">
            <Bell className="size-4" />
          </Button>
        )}
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
        <Badge variant="outline" className="hidden md:inline-flex" data-testid="mock-badge">
          {process.env.NEXT_PUBLIC_API_MOCK === "1" ? "MOCK API" : "LIVE API"}
        </Badge>
      </div>
    </header>
  );
}
