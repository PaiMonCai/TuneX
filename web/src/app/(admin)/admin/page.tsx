import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { RevenueAreaChart, TunnelTypePieChart } from "@/components/admin/admin-charts";
import { Users, Server, Waypoints, ShoppingCart, LifeBuoy, CreditCard, Activity } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { api } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { currentLocale } from "@/components/app-shell";
import { formatBytes, formatDateTime, formatMoney } from "@/lib/utils";
import type { AdminDashboardStats, PlanOrder, TopupOrder, User } from "@/lib/types";

const PIE_COLORS = ["oklch(0.55 0.19 258)", "oklch(0.7 0.17 150)", "oklch(0.72 0.18 70)", "oklch(0.65 0.2 25)", "oklch(0.6 0.15 200)"];

async function AdminBody() {
  const [{ cookie }, locale] = await Promise.all([cookies().then((c) => ({ cookie: c.toString() })), currentLocale()]);
  const [stats, recentUsers, recentOrders] = await Promise.all([
    api.admin.stats(cookie),
    api.admin.users({ page: 1, page_size: 8 }, cookie),
    api.admin.orders({ page: 1, page_size: 8, kind: "topup" }, cookie),
  ]);
  void locale;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Users} label="用户总数" value={String(stats.user_count)} />
        <Stat icon={Server} label="节点" value={`${stats.online_node_count}/${stats.node_count}`} sub="在线/总数" />
        <Stat icon={Waypoints} label="隧道" value={String(stats.tunnel_count)} />
        <Stat icon={CreditCard} label="今日收入" value={formatMoney(stats.today_revenue)} sub={`今日流量 ${formatBytes(stats.today_traffic)}`} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>收入趋势</CardTitle>
            <CardDescription>最近 14 天</CardDescription>
          </CardHeader>
          <CardContent>
            <RevenueAreaChart data={stats.revenue_trend} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>隧道类型分布</CardTitle>
          </CardHeader>
          <CardContent>
            <TunnelTypePieChart data={stats.tunnel_type_distribution} />
          </CardContent>
        </Card>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>最近用户</CardTitle>
            <Badge variant="outline">{recentUsers.total} 位</Badge>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>邮箱</TableHead>
                  <TableHead>余额</TableHead>
                  <TableHead>注册时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentUsers.data.slice(0, 6).map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.email}</TableCell>
                    <TableCell>{formatMoney(u.balance)}</TableCell>
                    <TableCell className="text-xs text-[var(--muted-foreground)]">{formatDateTime(u.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>最近订单</CardTitle>
            <Badge variant="outline">{recentOrders.total} 条</Badge>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>订单号</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentOrders.data.slice(0, 6).map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-mono text-xs">{"order_id" in o ? o.order_id : `#${o.id}`}</TableCell>
                    <TableCell>{formatMoney(o.price)}</TableCell>
                    <TableCell>
                      <Badge variant={"status" in o && o.status === "success" ? "success" : "default"}>
                        {"status" in o ? o.status : "plan"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, sub }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-2">
        <CardDescription>{label}</CardDescription>
        <Icon className="size-4 text-[var(--muted-foreground)]" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-xs text-[var(--muted-foreground)]">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default function AdminDashboardPage() {
  return (
    <AppShell titleKey="admin.dashboard" subtitleKey="admin.overview" adminMode>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        <AdminBody />
      </Suspense>
    </AppShell>
  );
}
