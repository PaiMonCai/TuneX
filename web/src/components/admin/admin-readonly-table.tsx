import { cookies } from "next/headers";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/card";
import { api } from "@/lib/api";
import { serverT } from "@/lib/server-i18n";
import { formatDateTime, formatMoney } from "@/lib/utils";
import type { Paginated } from "@/lib/types";
import type { AdminSegment } from "@/components/admin/admin-resource-list";

type Row = Record<string, unknown>;

interface Column {
  key: string;
  label: string;
  render?: (v: unknown, row: Row) => React.ReactNode;
}

function money(v: unknown) {
  return formatMoney(Number(v ?? 0));
}
function statusBadge(v: unknown, map: Record<string, "success" | "default" | "muted"> = {}) {
  const s = String(v);
  return <Badge variant={map[s] ?? "muted"}>{s}</Badge>;
}

function columnsFor(seg: AdminSegment, t: (k: string) => string): Column[] {
  switch (seg) {
    case "tunnels":
      return [
        { key: "name", label: t("common.name") },
        { key: "tunnel_type", label: t("tunnel.tunnelType") },
        { key: "listen_port", label: t("fields.listenPort") },
        {
          key: "forward_addresses",
          label: t("tunnel.forwardTargets"),
          render: (v) => <span className="font-mono text-xs">{Array.isArray(v) ? (v as string[]).join(", ") : "-"}</span>,
        },
        {
          key: "status",
          label: t("common.status"),
          render: (v) => statusBadge(v, { active: "success" }),
        },
        {
          key: "created_at",
          label: t("common.createdAt"),
          render: (v) => <span className="text-xs text-[var(--muted-foreground)]">{formatDateTime(String(v))}</span>,
        },
      ];
    case "orders":
      return [
        { key: "order_id", label: t("topup.orderNo") },
        { key: "kind", label: t("common.type") },
        { key: "price", label: t("fields.price"), render: money },
        {
          key: "status",
          label: t("common.status"),
          render: (v) => statusBadge(v, { success: "success", pending: "default" }),
        },
        {
          key: "created_at",
          label: t("common.createdAt"),
          render: (v) => <span className="text-xs text-[var(--muted-foreground)]">{formatDateTime(String(v))}</span>,
        },
      ];
    case "tickets":
      return [
        { key: "title", label: t("fields.titleField") },
        {
          key: "status",
          label: t("common.status"),
          render: (v) => statusBadge(v, { open: "default" }),
        },
        {
          key: "replies",
          label: t("fields.replies"),
          render: (v) => (Array.isArray(v) ? (v as unknown[]).length : 0),
        },
        {
          key: "created_at",
          label: t("common.createdAt"),
          render: (v) => <span className="text-xs text-[var(--muted-foreground)]">{formatDateTime(String(v))}</span>,
        },
      ];
    default:
      return [];
  }
}

async function fetchRows(seg: AdminSegment, cookie: string): Promise<Paginated<Row>> {
  try {
    if (seg === "tunnels")
      return (await api.admin.tunnels({ page: 1, page_size: 20 }, cookie)) as unknown as Paginated<Row>;
    if (seg === "orders")
      return (await api.admin.orders({ page: 1, page_size: 20 }, cookie)) as unknown as Paginated<Row>;
    if (seg === "tickets")
      return (await api.admin.tickets({ page: 1, page_size: 20 }, cookie)) as unknown as Paginated<Row>;
  } catch {
    /* 走空表兜底 */
  }
  return { data: [], total: 0, page: 1, page_size: 20 };
}

/** 只读管理列表（服务端组件）：tunnels / orders / tickets —— 无写操作，直接 SSR 渲染 */
export async function AdminReadonlyTable({ segment }: { segment: AdminSegment }) {
  const cookie = (await cookies()).toString();
  const { t } = await serverT();
  const [rows, columns] = [await fetchRows(segment, cookie), columnsFor(segment, t)];

  return (
    <div className="flex flex-col gap-3" data-testid={`admin-${segment}`}>
      <span className="text-xs text-[var(--muted-foreground)]">{t("admin.totalCount", { n: rows.total })}</span>
      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              {columns.map((c) => (
                <TableHead key={c.key}>{c.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.data.length === 0 ? (
              <TableEmpty colSpan={columns.length + 1} text={t("common.noData")} />
            ) : (
              rows.data.map((row) => (
                <TableRow key={String(row.id)}>
                  <TableCell className="font-mono text-xs">{String(row.id)}</TableCell>
                  {columns.map((c) => (
                    <TableCell key={c.key}>
                      {c.render
                        ? c.render(row[c.key], row)
                        : row[c.key] !== undefined && row[c.key] !== null
                          ? String(row[c.key])
                          : "-"}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
