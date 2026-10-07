import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppShell, shellI18n } from "@/components/app-shell";
import { localizedLabel } from "@/lib/nav";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import type { ConsumableRouteProfileView } from "@/lib/types";
import type { Locale } from "@/lib/i18n";

/**
 * `/routes` —— 用户侧「可用路由策略」（V5-WP13.5B，User Console）。
 *
 * 这一页是**只读**的消费面（产品边界 §9.4.1）：
 *  - 只展示普通用户该看到的东西：策略名称、描述、能不能用、怎么用；
 *  - **不出现** INTERNAL / version / selector / transit / revision / lease / profile_id /
 *    「模板」等内部概念 —— 后端 `/available` 返回的是管理面形状（含 version 与 template），
 *    前端在这里只取用户需要的字段，多余的字段**不渲染**（有渲染回归测试钉住）；
 *  - 不造假入口：后端目前没有「创建 Forward 时直接选择路由策略」的 API，所以本页不提供创建按钮，
 *    而是明确写出下一步动作（由管理员编排 / 后续版本支持）。
 */
async function AvailableRoutesBody({ locale }: { locale: Locale }) {
  const cookie = (await cookies()).toString();
  const zh = locale !== "en";

  // 只取用户需要的三个字段：后端 `/available` 返回的是管理面形状（含 version 与 template），
  // 把整对象丢进渲染树/serialized payload 就等于把 selector / transit 一起送到浏览器。
  // 这里做一次**显式收窄**，多出来的字段根本不进页面。
  let routes: Array<Pick<ConsumableRouteProfileView, "name" | "description" | "selectable">> = [];
  let failed = false;
  try {
    const page = await api.routeProfiles.available(cookie);
    routes = page.data.map((route) => ({
      name: route.name,
      description: route.description,
      selectable: route.selectable,
    }));
  } catch {
    failed = true;
  }

  if (failed) {
    return (
      <Card data-testid="routes-error">
        <CardHeader>
          <CardTitle>{zh ? "暂时无法读取可用路由策略" : "Cannot load available routing policies right now"}</CardTitle>
          <CardDescription>
            {zh
              ? "这不是权限结论，只是这次读取失败。请稍后重试；若持续失败请联系管理员。"
              : "This is a read failure, not a permission verdict. Retry later; contact your admin if it persists."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (routes.length === 0) {
    return (
      <Card data-testid="routes-empty">
        <CardHeader>
          <CardTitle>{zh ? "你目前没有可用路由策略" : "No routing policies available to you yet"}</CardTitle>
          <CardDescription>
            {zh
              ? "路由策略由管理员配置并对你开放。需要新的路径方案时请联系管理员。"
              : "Routing policies are configured by an administrator and granted to you. Ask your admin for a new path policy."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="routes-list">
      {routes.map((route, index) => (
        <Card key={`${route.name}-${index}`} data-testid="route-card">
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle>{route.name}</CardTitle>
              {route.description && <CardDescription>{route.description}</CardDescription>}
            </div>
            <Badge variant={route.selectable ? "success" : "muted"} data-testid="route-selectable" data-selectable={route.selectable ? "true" : "false"}>
              {route.selectable ? (zh ? "可用" : "Available") : zh ? "暂不可选" : "Not selectable"}
            </Badge>
          </CardHeader>
          <CardContent className="text-sm text-[var(--muted-foreground)]">
            <p data-testid="route-availability-hint">
              {route.selectable
                ? zh
                  ? "这条路由策略现在可以用于你的转发业务。"
                  : "This routing policy can be used for your forwards right now."
                : zh
                  ? "这条路由策略暂时不可用（未授权或已停用）。需要时请联系管理员。"
                  : "This routing policy is not available to you right now (not granted or turned off). Contact your admin."}
            </p>
            <p className="mt-2 text-xs" data-testid="route-next-step">
              {zh
                ? "路由策略由管理员配置，并作用在已经存在的转发上；当前版本创建转发时不需要（也无法）选择策略。某一转发需要调整路径时请联系管理员。"
                : "Routing policies are configured by an admin and applied to forwards that already exist. In this version you neither need nor can pick one while creating a forward. Ask your admin if a forward needs a different path."}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default async function RoutesPage() {
  const { locale } = await shellI18n();
  return (
    <AppShell
      title={localizedLabel(locale, "common.routingPolicies", "可用路由策略", "Available routing policies")}
      subtitle={localizedLabel(locale, "routes.subtitle", "管理员为你开放的路径选择策略", "Path-selection policies your administrator made available")}
    >
      <Suspense fallback={<div className="h-48 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <AvailableRoutesBody locale={locale} />
      </Suspense>
    </AppShell>
  );
}
