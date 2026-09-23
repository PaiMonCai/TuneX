import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { ADMIN_SEGMENTS, AdminResourceList, type AdminSegment } from "@/components/admin/admin-resource-list";
import { AdminReadonlyTable } from "@/components/admin/admin-readonly-table";
import { serverT } from "@/lib/server-i18n";

/**
 * 管理端资源页（异步服务端组件）：/admin/nodes, /admin/node-groups, /admin/plans,
 * /admin/tunnels, /admin/users, /admin/orders, /admin/tickets
 *
 * params 在 Next 16 是 Promise，这里用 async 函数直接 await（服务端组件不能用 React.use）。
 */
const TITLE_KEYS: Record<AdminSegment, string> = {
  nodes: "admin.nodes",
  "node-groups": "admin.nodeGroups",
  plans: "admin.plans",
  tunnels: "admin.tunnels",
  users: "admin.users",
  orders: "admin.orders",
  tickets: "admin.tickets",
};

const READONLY_SEGMENTS: AdminSegment[] = ["tunnels", "orders", "tickets"];

export function generateStaticParams() {
  return ADMIN_SEGMENTS.map((segment) => ({ segment }));
}

function normalize(segment: string): AdminSegment {
  return (ADMIN_SEGMENTS as readonly string[]).includes(segment) ? (segment as AdminSegment) : "nodes";
}

export default async function AdminResourcePage({ params }: { params: Promise<{ segment: string }> }) {
  const { segment } = await params;
  const seg = normalize(segment);
  const { t } = await serverT();

  return (
    <AppShell title={t(TITLE_KEYS[seg])} subtitle={t("admin.management")} adminMode showToaster={false}>
      <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-[var(--muted)]" />}>
        {READONLY_SEGMENTS.includes(seg) ? (
          <AdminReadonlyTable segment={seg} />
        ) : (
          <AdminResourceList segment={seg} />
        )}
      </Suspense>
    </AppShell>
  );
}
