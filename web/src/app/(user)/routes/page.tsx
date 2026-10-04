import { cookies } from "next/headers";
import { Suspense } from "react";
import { AppShell, shellI18n } from "@/components/app-shell";
import { localizedLabel } from "@/lib/nav";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import type { ConsumableRouteProfileView } from "@/lib/types";
import type { Locale } from "@/lib/i18n";

/**
 * `/routes` —— 用户侧「可用线路」（V5-WP13.5B，User Console）。
 *
 * 这一页是**只读**的消费面（产品边界 §9.4.1）：
 *  - 只展示普通用户该看到的东西：线路名称、描述、能不能选、怎么用；
 *  - **不出现** INTERNAL / version / selector / transit / revision / lease / profile_id /
 *    「模板」等内部概念 —— 后端 `/available` 返回的是管理面形状（含 version 与 template），
 *    前端在这里只取用户需要的字段，多余的字段**不渲染**（有渲染回归测试钉住）；
 *  - 不造假入口：后端目前没有「用线路创建 Forward」的 API，所以本页不提供创建按钮，
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
          <CardTitle>{zh ? "暂时无法读取可用线路" : "Cannot load available routes right now"}</CardTitle>
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
          <CardTitle>{zh ? "你目前没有可用线路" : "No routes available to you yet"}</CardTitle>
          <CardDescription>
            {zh
              ? "可用线路由管理员编排并对你开放。需要新线路时请联系管理员。"
              : "Routes are authored by an administrator and granted to you. Ask your admin for a new route."}
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
                  ? "这条线路现在可以用于你的转发业务。"
                  : "This route can be used for your forwards right now."
                : zh
                  ? "这条线路暂时不可用（未授权或已停用）。需要时请联系管理员。"
                  : "Not available to you right now (not granted or turned off). Contact your admin."}
            </p>
            <p className="mt-2 text-xs" data-testid="route-next-step">
              {zh
                ? "下一步：在创建转发时选择合适的线路。目前还不支持从线路直接创建转发，如需调整请联系管理员。"
                : "Next: pick a route when creating a forward. Creating a forward from a route is not supported yet; contact your admin to adjust."}
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
      title={localizedLabel(locale, "common.routes", "可用线路", "Available routes")}
      subtitle={localizedLabel(locale, "routes.subtitle", "管理员为你开放的线路", "Routes your administrator made available")}
    >
      <Suspense fallback={<div className="h-48 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <AvailableRoutesBody locale={locale} />
      </Suspense>
    </AppShell>
  );
}
