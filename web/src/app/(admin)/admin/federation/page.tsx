import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppShell, shellI18n } from "@/components/app-shell";
import { localizedLabel } from "@/lib/nav";
import { FederationTabs } from "@/components/admin/federation/federation-ui";
import { FederationOverviewManager } from "@/components/admin/federation/overview-manager";
import { FederationErrorNotice } from "@/components/admin/federation/federation-ui";
import { settle } from "@/components/admin/federation/federation-status";
import { api } from "@/lib/api";

/**
 * `/admin/federation` —— 联邦总览（V5.5，Admin Console）。
 *
 * §9.4.7：外壳先响应，身份与计数在 `Suspense` 里并行取；取数失败（例如联邦被关闭
 * 返回 403 `federation_disabled`）**不抛**，而是把后端错误码渲染出来。
 */
async function FederationOverviewBody({ locale }: { locale: "zh" | "en" }) {
  const cookie = (await cookies()).toString();
  const result = await settle(api.admin.federation.status(cookie));
  if (!result.ok) return <FederationErrorNotice error={result.error} locale={locale} />;
  return <FederationOverviewManager initial={result.data} locale={locale} />;
}

export default async function FederationOverviewPage() {
  const { locale } = await shellI18n();
  return (
    <AppShell
      title={localizedLabel(locale, "admin.federation.overview", "联邦总览", "Federation overview")}
      subtitle={localizedLabel(locale, "admin.federation.subtitle", "跨面板信任、授予与远端租约", "Cross-panel trust, grants and remote leases")}
      adminMode
      showToaster={false}
    >
      <div className="flex flex-col gap-4">
        <FederationTabs active="overview" locale={locale} />
        <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-[var(--muted)]" />}>
          <FederationOverviewBody locale={locale} />
        </Suspense>
      </div>
    </AppShell>
  );
}
