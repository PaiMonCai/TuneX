import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppShell, shellI18n } from "@/components/app-shell";
import { localizedLabel } from "@/lib/nav";
import { FederationErrorNotice, FederationTabs } from "@/components/admin/federation/federation-ui";
import { FederationLeasesManager } from "@/components/admin/federation/leases-manager";
import { settleAll } from "@/components/admin/federation/federation-status";
import { api } from "@/lib/api";

/** `/admin/federation/remote-leases` —— host 侧权威租约 + home 侧镜像（只读）。 */
async function FederationLeasesBody({ locale }: { locale: "zh" | "en" }) {
  const cookie = (await cookies()).toString();
  const result = await settleAll([api.admin.federation.leases(cookie), api.admin.federation.placements(cookie)] as const);
  if (!result.ok) return <FederationErrorNotice error={result.error} locale={locale} />;
  const [leases, placements] = result.data;
  return <FederationLeasesManager initial={leases} placements={placements} locale={locale} />;
}

export default async function FederationRemoteLeasesPage() {
  const { locale } = await shellI18n();
  return (
    <AppShell
      title={localizedLabel(locale, "admin.federation.remoteLeases", "远端租约", "Remote leases")}
      subtitle={localizedLabel(locale, "admin.federation.subtitle", "跨面板信任、授予与远端租约", "Cross-panel trust, grants and remote leases")}
      adminMode
     
    >
      <div className="flex flex-col gap-4">
        <FederationTabs active="remote-leases" locale={locale} />
        <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-[var(--muted)]" />}>
          <FederationLeasesBody locale={locale} />
        </Suspense>
      </div>
    </AppShell>
  );
}
