"use client";

import Link from "next/link";
import { Bell, ExternalLink, LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { useI18n } from "@/components/providers";

/**
 * 顶栏（客户端组件）：页面标题 + 通知/语言/主题/入口切换。
 * 标题由服务端 `AppShell` 按 cookie 语言解析后传入，保证 SSR 文案正确。
 */
export function Topbar({ title, subtitle, adminMode = false }: { title: string; subtitle?: string; adminMode?: boolean }) {
  const { t } = useI18n();
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--background)]/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-[var(--background)]/70 lg:px-6">
      <div className="min-w-0 pl-12 lg:pl-0">
        <h1 className="truncate text-base font-semibold leading-tight" data-testid="page-title">
          {title}
        </h1>
        {subtitle && <p className="truncate text-xs text-[var(--muted-foreground)]">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon" aria-label={t("common.tickets")} className="hidden sm:inline-flex">
          <Bell className="size-4" />
        </Button>
        <LocaleSwitcher />
        <ThemeToggle />
        <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-[var(--border)] sm:block" />
        {adminMode ? (
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
