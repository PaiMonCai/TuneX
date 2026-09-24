"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/card";
import { AdminToolbar } from "@/components/admin/admin-ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { STATUS_OPTIONS } from "@/lib/constants";
import { formatBytes, formatDateTime, formatMoney } from "@/lib/utils";
import type { Paginated } from "@/lib/types";

export type ReadonlySegment = "tunnels" | "orders" | "tickets";

type Row = Record<string, unknown>;

interface Column {
  key: string;
  label: string;
  render?: (v: unknown, row: Row) => React.ReactNode;
}

function statusBadge(v: unknown, map: Record<string, "success" | "default" | "muted"> = {}) {
  const s = String(v);
  return <Badge variant={map[s] ?? "muted"}>{s}</Badge>;
}

function money(v: unknown) {
  return formatMoney(Number(v ?? 0));
}

async function fetchRows(
  seg: ReadonlySegment,
  query: { page: number; page_size: number; keyword?: string; status?: string },
): Promise<Paginated<Row>> {
  if (seg === "tunnels") return (await api.admin.tunnels(query)) as unknown as Paginated<Row>;
  if (seg === "orders") return (await api.admin.orders(query)) as unknown as Paginated<Row>;
  return (await api.admin.tickets(query)) as unknown as Paginated<Row>;
}

/**
 * 只读资源列表（客户端组件）：tunnels / orders / tickets。
 * 提供搜索 + 状态过滤 + 刷新，但不含任何写操作；如需修改请前往对应资源页。
 */
export function AdminReadonlyManager({
  segment,
  initialData,
}: {
  segment: ReadonlySegment;
  initialData: Paginated<Row>;
}) {
  const { t } = useI18n();
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState("all");

  const columns: Column[] = (() => {
    switch (segment) {
      case "tunnels":
        return [
          { key: "name", label: t("common.name") },
          { key: "tunnel_type", label: t("tunnel.tunnelType") },
          { key: "listen_port", label: t("fields.listenPort") },
          {
            key: "forward_addresses",
            label: t("tunnel.forwardTargets"),
            render: (v) => (
              <span className="font-mono text-xs">
                {Array.isArray(v) ? (v as string[]).join(", ") : "-"}
              </span>
            ),
          },
          { key: "traffic", label: t("tunnel.traffic"), render: (v) => formatBytes(Number(v ?? 0)) },
          { key: "status", label: t("common.status"), render: (v) => statusBadge(v, { active: "success" }) },
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
          { key: "status", label: t("common.status"), render: (v) => statusBadge(v, { success: "success", pending: "default" }) },
          {
            key: "created_at",
            label: t("common.createdAt"),
            render: (v) => <span className="text-xs text-[var(--muted-foreground)]">{formatDateTime(String(v))}</span>,
          },
        ];
      case "tickets":
        return [
          { key: "title", label: t("fields.titleField") },
          { key: "status", label: t("common.status"), render: (v) => statusBadge(v, { open: "default" }) },
          { key: "replies", label: t("fields.replies"), render: (v) => (Array.isArray(v) ? (v as unknown[]).length : 0) },
          {
            key: "created_at",
            label: t("common.createdAt"),
            render: (v) => <span className="text-xs text-[var(--muted-foreground)]">{formatDateTime(String(v))}</span>,
          },
        ];
    }
  })();

  async function load(kw = keyword, st = status) {
    setLoading(true);
    try {
      setData(
        await fetchRows(segment, {
          page: 1,
          page_size: 20,
          keyword: kw || undefined,
          status: st === "all" ? undefined : st,
        }),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.noData"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid={`admin-${segment}`}>
      <AdminToolbar
        keyword={keyword}
        onKeywordChange={setKeyword}
        onSearch={() => load()}
        onRefresh={() => load()}
        loading={loading}
        total={data.total}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--muted-foreground)]">{t("common.status")}</span>
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            load(keyword, v);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t("admin.selectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.unlimited")}</SelectItem>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.zh}
              </SelectItem>
            ))}
            {segment === "tickets" && <SelectItem value="closed">closed</SelectItem>}
          </SelectContent>
        </Select>
        <Badge variant="outline">{t("admin.readOnly")}</Badge>
      </div>

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
            {loading && data.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length + 1} className="h-24 text-center text-[var(--muted-foreground)]">
                  {t("common.loading")}
                </TableCell>
              </TableRow>
            ) : data.data.length === 0 ? (
              <TableEmpty colSpan={columns.length + 1} text={t("common.noData")} />
            ) : (
              data.data.map((row) => (
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

      <p className="field-hint">{t("admin.readOnlyHint")}</p>
    </div>
  );
}
