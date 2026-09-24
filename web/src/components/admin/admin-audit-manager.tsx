"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/card";
import { AdminToolbar } from "@/components/admin/admin-ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime } from "@/lib/utils";
import type { AuditLog, AuditLogQuery, Paginated } from "@/lib/types";

const ACTOR_OPTIONS = ["super_admin", "admin", "user", "anonymous", "system"] as const;
const METHOD_OPTIONS = ["POST", "PATCH", "PUT", "DELETE", "GET"] as const;

const ACTOR_LABEL: Record<string, string> = {
  super_admin: "超级管理员",
  admin: "管理员",
  user: "用户",
  anonymous: "匿名",
  system: "系统",
};

function statusVariant(status: number): "success" | "default" | "destructive" {
  if (status >= 500) return "destructive";
  if (status >= 400) return "destructive";
  if (status >= 200 && status < 300) return "success";
  return "default";
}

/**
 * 审计日志只读列表（客户端组件，仅超级管理员）。
 *
 * 支持关键字（路径 / action / 操作者邮箱 / 资源）、操作者类型、HTTP 方法过滤 + 刷新。
 * 不含任何写操作 —— 审计日志 append-only，后端也不提供删除端点。
 */
export function AdminAuditManager({ initialData }: { initialData: Paginated<AuditLog> }) {
  const { t } = useI18n();
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [actorType, setActorType] = useState("all");
  const [method, setMethod] = useState("all");

  async function load(kw = keyword, at = actorType, m = method) {
    setLoading(true);
    try {
      setData(
        await api.admin.auditLogs({
          page: 1,
          page_size: 30,
          keyword: kw || undefined,
          actor_type: at === "all" ? undefined : at,
          method: m === "all" ? undefined : m,
        } satisfies AuditLogQuery),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.noData"));
    } finally {
      setLoading(false);
    }
  }

  const columns = [
    { key: "created_at", label: t("common.createdAt") },
    { key: "actor", label: t("admin.actor") },
    { key: "action", label: t("admin.method") },
    { key: "resource", label: t("admin.resource") },
    { key: "status", label: t("common.status") },
    { key: "ip", label: "IP" },
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="admin-audit-logs">
      <AdminToolbar
        keyword={keyword}
        onKeywordChange={setKeyword}
        onSearch={() => load()}
        onRefresh={() => load()}
        loading={loading}
        total={data.total}
      />

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--muted-foreground)]">{t("admin.actorType")}</span>
        <Select
          value={actorType}
          onValueChange={(v) => {
            setActorType(v);
            load(keyword, v, method);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder={t("admin.selectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.unlimited")}</SelectItem>
            {ACTOR_OPTIONS.map((o) => (
              <SelectItem key={o} value={o}>
                {ACTOR_LABEL[o] ?? o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={method}
          onValueChange={(v) => {
            setMethod(v);
            load(keyword, actorType, v);
          }}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Method" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All methods</SelectItem>
            {METHOD_OPTIONS.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
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
                  <TableCell className="whitespace-nowrap text-xs text-[var(--muted-foreground)]">
                    {formatDateTime(row.created_at)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.actor_type === "anonymous" ? "muted" : "default"}>
                      {ACTOR_LABEL[row.actor_type] ?? row.actor_type}
                    </Badge>
                    <span className="ml-2 text-xs text-[var(--muted-foreground)]">
                      {row.actor_email ?? (row.actor_id != null ? `#${row.actor_id}` : "-")}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.action}</TableCell>
                  <TableCell className="text-xs">
                    {row.resource}
                    {row.resource_id ? `#${row.resource_id}` : ""}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(row.status)}>{row.status}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-[var(--muted-foreground)]">{row.ip ?? "-"}</TableCell>
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
