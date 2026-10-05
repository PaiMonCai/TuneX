import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppShell, shellI18n } from "@/components/app-shell";
import { localizedLabel } from "@/lib/nav";
import { FederationErrorNotice, FederationTabs } from "@/components/admin/federation/federation-ui";
import { FederationTrustManager } from "@/components/admin/federation/trust-manager";
import { settle } from "@/components/admin/federation/federation-status";
import { api } from "@/lib/api";

/** `/admin/federation/trust` —— 信任范围（scope）与密钥材料（key_id 指纹 / 轮转）。 */
async function FederationTrustBody({ locale }: { locale: "zh" | "en" }) {
  const cookie = (await cookies()).toString();
  const result = await settle(api.admin.federation.peers(cookie));
  if (!result.ok) return <FederationErrorNotice error={result.error} locale={locale} />;
  return <FederationTrustManager initial={result.data} locale={locale} />;
}

export default async function FederationTrustPage() {
  const { locale } = await shellI18n();
  return (
    <AppShell
      title={localizedLabel(locale, "admin.federation.trust", "信任与密钥", "Trust & keys")}
      subtitle={localizedLabel(locale, "admin.federation.subtitle", "跨面板信任、授予与远端租约", "Cross-panel trust, grants and remote leases")}
      adminMode
     
    >
      <div className="flex flex-col gap-4">
        <FederationTabs active="trust" locale={locale} />
        <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-[var(--muted)]" />}>
          <FederationTrustBody locale={locale} />
        </Suspense>
      </div>
    </AppShell>
  );
}
