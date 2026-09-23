import Link from "next/link";
import { cookies } from "next/headers";
import { CreditCard, Package, Plus, Waypoints, Waves } from "lucide-react";
import { TrafficChart } from "@/components/traffic-chart";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { serverT } from "@/lib/server-i18n";
import { formatBytes, formatDate, formatMoney } from "@/lib/utils";
import type { DashboardStats, TrafficPoint, Tunnel } from "@/lib/types";

/** 仪表盘数据体（服务端组件，AppShell 内由 Suspense 包裹） */
export async function DashboardBody() {
  const cookie = (await cookies()).toString();
  const { t, dict } = await serverT();
  const [stats, traffic, tunnels] = await Promise.all([
    api.dashboard.stats(cookie).catch(() => null as DashboardStats | null),
    api.dashboard.traffic(14, cookie).catch(() => [] as TrafficPoint[]),
    api.tunnels
      .list({ page: 1, page_size: 5 }, cookie)
      .catch(() => ({ data: [] as Tunnel[], total: 0, page: 1, page_size: 5 })),
  ]);
  const usedPct = stats?.traffic_limit ? (stats.traffic_used / stats.traffic_limit) * 100 : 0;

  return (
    <div className="flex flex-col gap-5" data-testid="dashboard-body">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title={t("dashboard.balance")}
          value={formatMoney(stats?.balance ?? 0)}
          hint={`${t("dashboard.commission")}: ${formatMoney(stats?.commission_balance ?? 0)}`}
          icon={CreditCard}
          testId="stat-balance"
        />
        <StatCard
          title={t("dashboard.tunnelCount")}
          value={`${stats?.tunnel_count ?? 0}${stats?.max_tunnels ? ` / ${stats.max_tunnels}` : ""}`}
          hint={`${t("dashboard.currentPlan")}: ${stats?.plan_name ?? t("dashboard.noPlan")}`}
          icon={Waypoints}
          testId="stat-tunnels"
        />
        <StatCard
          title={t("dashboard.monthTraffic")}
          value={formatBytes(stats?.month_traffic ?? 0)}
          hint={`${t("dashboard.trafficUsed")}: ${formatBytes(stats?.traffic_limit ?? 0)}`}
          icon={Waves}
          testId="stat-traffic"
        />
        <StatCard
          title={t("dashboard.nodesOnline")}
          value={`${stats?.active_nodes ?? 0} / ${stats?.total_nodes ?? 0}`}
          hint={`${t("dashboard.expiresAt")}: ${formatDate(stats?.expired_at ?? null)}`}
          icon={Package}
          testId="stat-nodes"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("dashboard.trafficTrend")}</CardTitle>
            <CardDescription>{t("dashboard.subtitle")}</CardDescription>
          </CardHeader>
          <CardContent>{traffic.length > 0 ? <TrafficChart data={traffic} /> : <div className="h-64 rounded-md bg-[var(--muted)]" />}</CardContent>
        </Card>

        <Card>
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
                <Link href="/tunnels">
                  <Plus className="size-4" /> {t("tunnel.createButton")}
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
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-start justify-between">
          <div>
            <CardTitle>{t("dashboard.recentTunnels")}</CardTitle>
            <CardDescription>{dict.common.tagline}</CardDescription>
          </div>
          <Button size="sm" variant="outline" asChild>
            <Link href="/tunnels">{t("common.tunnels")}</Link>
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
                    <Link href={`/tunnels/${tn.id}`} className="hover:underline">
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
