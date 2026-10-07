import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppShell, shellI18n } from "@/components/app-shell";
import { localizedLabel } from "@/lib/nav";
import { api } from "@/lib/api";
import { RouteProfileErrorNotice, type Locale } from "@/components/admin/route-profiles/route-profile-ui";
import { RouteProfilesManager } from "@/components/admin/route-profiles/route-profiles-manager";
import { routeProfileErrorInfo } from "@/components/admin/route-profiles/route-profile-status";
import type { RouteProfileView } from "@/lib/types";

/**
 * `/admin/route-profiles` —— 路由策略编排（V5-WP13.5B，Admin Console → Network）。
 *
 * §9.4.7：外壳先响应，列表在 `Suspense` 里取；取数失败（例如角色无 `node:read`）
 * **不抛**，而是把后端 code / 失败层 / next_action 渲染出来。
 */
async function RouteProfilesBody({ locale }: { locale: Locale }) {
  const cookie = (await cookies()).toString();
  try {
    const page = await api.routeProfiles.list({ page: 1, page_size: 50 }, cookie);
    return <RouteProfilesManager initial={page.data as RouteProfileView[]} locale={locale} />;
  } catch (e) {
    return <RouteProfileErrorNotice error={routeProfileErrorInfo(e)} locale={locale} />;
  }
}

export default async function RouteProfilesPage() {
  const { locale } = await shellI18n();
  return (
    <AppShell
      title={localizedLabel(locale, "admin.routingPolicies", "路由策略", "Routing policies")}
      subtitle={localizedLabel(
        locale,
        "admin.routingPoliciesSubtitle",
        "可复用、可版本化的路径选择规则；转发是业务实例，策略只决定流量怎么走",
        "Reusable, versioned path-selection rules; forwards are the service instances, policies decide how traffic moves",
      )}
      adminMode
     
    >
      <Suspense fallback={<div className="h-64 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <RouteProfilesBody locale={locale} />
      </Suspense>
    </AppShell>
  );
}
