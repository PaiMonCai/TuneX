import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppShell, shellI18n } from "@/components/app-shell";
import { localizedLabel } from "@/lib/nav";
import { FederationErrorNotice, FederationTabs } from "@/components/admin/federation/federation-ui";
import { FederationPeersManager } from "@/components/admin/federation/peers-manager";
import { settle } from "@/components/admin/federation/federation-status";
import { api } from "@/lib/api";

/** `/admin/federation/peers` —— 对等面板：信任列表 + 邀请 + 握手 + ping + 轮转 + 撤销。 */
async function FederationPeersBody({ locale }: { locale: "zh" | "en" }) {
  const cookie = (await cookies()).toString();
  const result = await settle(api.admin.federation.peers(cookie));
  if (!result.ok) return <FederationErrorNotice error={result.error} locale={locale} />;
  return <FederationPeersManager initial={result.data} locale={locale} />;
}

export default async function FederationPeersPage() {
  const { locale } = await shellI18n();
  return (
    <AppShell
      title={localizedLabel(locale, "admin.federation.peers", "对等面板", "Peers")}
      subtitle={localizedLabel(locale, "admin.federation.subtitle", "跨面板信任、授予与远端租约", "Cross-panel trust, grants and remote leases")}
      adminMode
      showToaster={false}
    >
      <div className="flex flex-col gap-4">
        <FederationTabs active="peers" locale={locale} />
        <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-[var(--muted)]" />}>
          <FederationPeersBody locale={locale} />
        </Suspense>
      </div>
    </AppShell>
  );
}
