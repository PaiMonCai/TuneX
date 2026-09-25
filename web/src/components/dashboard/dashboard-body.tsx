import Link from "next/link";
import { cookies } from "next/headers";
import { CreditCard, Package, Plus, Waypoints, Waves } from "lucide-react";
import { TrafficChart } from "@/components/traffic-chart";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, workspaceIdFromCookie } from "@/lib/api";
import { serverT } from "@/lib/server-i18n";
import { formatBytes, formatDate, formatMoney } from "@/lib/utils";
import { loadDashboardTraffic, TRAFFIC_TREND_DAYS } from "@/components/dashboard/dashboard-traffic";
import type { DashboardStats, Tunnel } from "@/lib/types";

/** 仪表盘数据体（服务端组件，AppShell 内由 Suspense 包裹） */
export async function DashboardBody() {
  const cookie = (await cookies()).toString();
  const { t, dict } = await serverT();

  // OPS-03：流量改为 workspace 级聚合（/workspaces/:id/traffic）。workspace id
  // 从 `tunex_workspace` cookie 解析（顶栏切换器切换时写入，与客户端上下文同源），
  // 缺失时不猜个人空间、直接进入空态——让页面显示「未选择空间」而非别的空间的流量。
  const workspaceId = workspaceIdFromCookie(cookie);

  const [stats, traffic, tunnels] = await Promise.all([
    api.dashboard.stats(cookie).catch(() => null as DashboardStats | null),
    loadDashboardTraffic({
      workspaceId,
      fetchTraffic: (id, days) => api.workspaces.traffic(id, { days }),
    }).catch(() => null),
    api.tunnels
      .list({ page: 1, page_size: 5 }, cookie)
      .catch(() => ({ data: [] as Tunnel[], total: 0, page: 1, page_size: 5 })),
  ]);
  const paymentsEnabled = process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true";
  const usedPct = stats?.traffic_limit ? (stats.traffic_used / stats.traffic_limit) * 100 : 0;

  return (
    <div className="flex flex-col gap-5" data-testid="dashboard-body">
      <div className={`grid gap-4 sm:grid-cols-2 ${paymentsEnabled ? "xl:grid-cols-4" : "xl:grid-cols-3"}`}>
        {paymentsEnabled && <StatCard
          title={t("dashboard.balance")}
          value={formatMoney(stats?.balance ?? 0)}
          hint={`${t("dashboard.commission")}: ${formatMoney(stats?.commission_balance ?? 0)}`}
          icon={CreditCard}
          testId="stat-balance"
        />}
        <StatCard
          title={t("dashboard.tunnelCount")}
          value={`${stats?.tunnel_count ?? 0}${stats?.max_tunnels ? ` / ${stats.max_tunnels}` : ""}`}
          hint={paymentsEnabled ? `${t("dashboard.currentPlan")}: ${stats?.plan_name ?? t("dashboard.noPlan")}` : undefined}
          icon={Waypoints}
          testId="stat-tunnels"
        />
        <StatCard
          title={t("dashboard.monthTraffic")}
          value={formatBytes(traffic?.summary?.total_traffic ?? stats?.month_traffic ?? 0)}
          hint={traffic?.summary ? `${t("dashboard.trafficPeriod")}: ${t(`dashboard.period.${traffic.summary.period}`)}` : undefined}
          icon={Waves}
          testId="stat-traffic"
        />
        <StatCard
          title={t("dashboard.nodesOnline")}
          value={`${stats?.active_nodes ?? 0} / ${stats?.total_nodes ?? 0}`}
          hint={paymentsEnabled ? `${t("dashboard.expiresAt")}: ${formatDate(stats?.expired_at ?? null)}` : undefined}
          icon={Package}
          testId="stat-nodes"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className={paymentsEnabled ? "lg:col-span-2" : "lg:col-span-3"}>
          <CardHeader>
            <CardTitle>{t("dashboard.trafficTrend")}</CardTitle>
            <CardDescription>
              {traffic?.status === "error"
                ? traffic.message ?? dict.common.noData
                : t("dashboard.trafficTrendDesc", { days: TRAFFIC_TREND_DAYS })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {traffic && traffic.points.length > 0 ? (
              <TrafficChart data={traffic.points} />
            ) : traffic?.status === "error" ? (
              <div
                className="flex h-64 items-center justify-center rounded-md border border-dashed border-[var(--border)] text-sm text-[var(--muted-foreground)]"
                data-testid="traffic-error"
              >
                {traffic.message ?? dict.common.noData}
              </div>
            ) : (
              <div
                className="flex h-64 items-center justify-center rounded-md border border-dashed border-[var(--border)] text-sm text-[var(--muted-foreground)]"
                data-testid="traffic-empty"
              >
                {dict.common.noData}
              </div>
            )}
          </CardContent>
        </Card>

        {paymentsEnabled && <Card>
          <CardHeader>
            <CardTitle>{t("dashboard.currentPlan")}</CardTitle>
            <CardDescription>{stats?.plan_name ?? t("dashboard.noPlan")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-[var(--muted-foreground)]">
                <span>{t("dashboard.trafficUsed")}</span>
                <span>
                  {formatBytes(stats?.traffic_used ?? 0)} / {formatBytes(stats?.traffic_limit ?? 0)}
                </span>
              </div>
              <Progress value={usedPct} />
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--muted-foreground)]">{t("dashboard.expiresAt")}</span>
              <span>{formatDate(stats?.expired_at ?? null)}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-[var(--muted-foreground)]">{t("dashboard.todayTraffic")}</span>
              <span>{formatBytes(stats?.today_traffic ?? 0)}</span>
            </div>
            <div className="flex flex-col gap-2 pt-1">
              <Button size="sm" asChild>
                <Link href="/forwards">
                  <Plus className="size-4" /> {t("forward.createDirect")}
                </Link>
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link href="/plans">{t("dashboard.buyPlan")}</Link>
              </Button>
              <Button size="sm" variant="outline" asChild>
                <Link href="/topup">{t("common.topup")}</Link>
              </Button>
            </div>
          </CardContent>
        </Card>}
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle>{t("dashboard.tunnelRanking")}</CardTitle>
            <CardDescription>
              {traffic?.summary
                ? `${t("dashboard.totalTraffic")}: ${formatBytes(traffic.summary.total_traffic)}`
                : dict.common.tagline}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link href="/forwards">{t("common.forwards")}</Link>
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("fields.id")}</TableHead>
                <TableHead>{t("tunnel.name")}</TableHead>
                <TableHead>{t("tunnel.tunnelType")}</TableHead>
                <TableHead>{t("fields.listenPort")}</TableHead>
                <TableHead>{t("tunnel.traffic")}</TableHead>
                <TableHead>{t("common.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tunnels.data.length === 0 && <TableEmpty colSpan={6} text={dict.tunnel.empty} />}
              {tunnels.data.map((tn) => (
                <TableRow key={tn.id}>
                  <TableCell className="text-[var(--muted-foreground)]">{tn.id}</TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/forwards/${tn.id}`} className="hover:underline">
                      {tn.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{tn.tunnel_type}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{tn.listen_port ?? "-"}</TableCell>
                  <TableCell>{formatBytes(tn.traffic)}</TableCell>
                  <TableCell>
                    <Badge variant={tn.status === "active" ? "success" : "muted"}>
                      {tn.status === "active" ? t("common.active") : t("common.inactive")}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
