import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppShell, shellI18n } from "@/components/app-shell";
import { localizedLabel } from "@/lib/nav";
import { FederationErrorNotice, FederationTabs } from "@/components/admin/federation/federation-ui";
import { FederationGrantsManager } from "@/components/admin/federation/grants-manager";
import { settleAll } from "@/components/admin/federation/federation-status";
import { api } from "@/lib/api";

/** `/admin/federation/grants` —— 授予列表 + 新建 + revoke / suspend / resume。 */
async function FederationGrantsBody({ locale }: { locale: "zh" | "en" }) {
  const cookie = (await cookies()).toString();
  const [grants, peers] = [api.admin.federation.grants(cookie), api.admin.federation.peers(cookie)];
  const result = await settleAll([grants, peers] as const);
  if (!result.ok) return <FederationErrorNotice error={result.error} locale={locale} />;
  const [grantRows, peerRows] = result.data;
  return <FederationGrantsManager initial={grantRows} peers={peerRows} locale={locale} />;
}

export default async function FederationGrantsPage() {
  const { locale } = await shellI18n();
  return (
    <AppShell
      title={localizedLabel(locale, "admin.federation.grants", "授予", "Grants")}
      subtitle={localizedLabel(locale, "admin.federation.subtitle", "跨面板信任、授予与远端租约", "Cross-panel trust, grants and remote leases")}
      adminMode
     
    >
      <div className="flex flex-col gap-4">
        <FederationTabs active="grants" locale={locale} />
        <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-[var(--muted)]" />}>
          <FederationGrantsBody locale={locale} />
        </Suspense>
      </div>
    </AppShell>
  );
}
