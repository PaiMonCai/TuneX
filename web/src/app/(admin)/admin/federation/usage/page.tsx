import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppShell, shellI18n } from "@/components/app-shell";
import { localizedLabel } from "@/lib/nav";
import { FederationErrorNotice, FederationTabs } from "@/components/admin/federation/federation-ui";
import { FederationUsageManager } from "@/components/admin/federation/usage-manager";
import { settle } from "@/components/admin/federation/federation-status";
import { api } from "@/lib/api";

/** `/admin/federation/usage` —— 用量记录；`unattributed` 单独成桶展示。 */
async function FederationUsageBody({ locale }: { locale: "zh" | "en" }) {
  const cookie = (await cookies()).toString();
  const result = await settle(api.admin.federation.usage(cookie));
  if (!result.ok) return <FederationErrorNotice error={result.error} locale={locale} />;
  return <FederationUsageManager initial={result.data} locale={locale} />;
}

export default async function FederationUsagePage() {
  const { locale } = await shellI18n();
  return (
    <AppShell
      title={localizedLabel(locale, "admin.federation.usage", "联邦用量", "Federation usage")}
      subtitle={localizedLabel(locale, "admin.federation.subtitle", "跨面板信任、授予与远端租约", "Cross-panel trust, grants and remote leases")}
      adminMode
     
    >
      <div className="flex flex-col gap-4">
        <FederationTabs active="usage" locale={locale} />
        <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-[var(--muted)]" />}>
          <FederationUsageBody locale={locale} />
        </Suspense>
      </div>
    </AppShell>
  );
}
