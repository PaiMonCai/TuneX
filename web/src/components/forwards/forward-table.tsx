"use client";

import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, Copy, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { ForwardProtocolBadge } from "@/components/forwards/forward-protocol-badge";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { forwardAccessAddress } from "@/components/forwards/forward-copy";
import { applyErrorAction, forwardProductBadgeVariant, forwardProductStatus } from "@/lib/forward-status";
import { formatDateTime } from "@/lib/utils";
import { forwardTransportFor } from "@/lib/forward-protocol";
import type { Locale } from "@/lib/i18n";
import type { PortForward } from "@/lib/types";
import type { ForwardSortKey, ForwardSortOrder } from "@/components/forwards/forward-list-model";

import type { ForwardListTextKey } from "@/components/forwards/forward-list-model";
type Translate = (key: string, params?: Record<string, string | number>) => string;
type ListText = (key: ForwardListTextKey, params?: Record<string, string | number>) => string;
type ForwardAction = "retry" | "suspend" | "resume";

function SortableHead({ label, sortKey, sort, order, onSort }: {
  label: string; sortKey: ForwardSortKey; sort: ForwardSortKey; order: ForwardSortOrder;
  onSort: (key: ForwardSortKey) => void;
}) {
  const active = sort === sortKey;
  return (
    <TableHead aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="inline-flex items-center gap-1 text-left hover:underline"
        onClick={() => onSort(sortKey)} data-testid={`forward-sort-${sortKey}`}>
        {label}
        {active ? (order === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />) : <ArrowUpDown className="size-3 opacity-40" />}
      </button>
    </TableHead>
  );
}

export function ForwardTable({ forwards, loading, sort, order, selectedIds, allPageSelected, canUpdateAny, canCreate,
  actionBusy, locale, t, text, canUpdate, canDelete, canSelect, selectionBusy = false, onSort, onSelectAll, onSelect, onAction, onEdit, onCopy, onDelete }: {
  forwards: PortForward[]; loading: boolean; sort: ForwardSortKey; order: ForwardSortOrder; selectedIds: Set<number>;
  allPageSelected: boolean; canUpdateAny: boolean; canCreate: boolean; actionBusy: number | null; locale: Locale;
  t: Translate; text: ListText; canUpdate: (forward: PortForward) => boolean; canDelete: (forward: PortForward) => boolean;
  canSelect?: (forward: PortForward) => boolean; selectionBusy?: boolean;
  onSort: (key: ForwardSortKey) => void; onSelectAll: (checked: boolean) => void; onSelect: (id: number, checked: boolean) => void;
  onAction: (forward: PortForward, action: ForwardAction) => void; onEdit: (forward: PortForward) => void;
  onCopy: (forward: PortForward) => void; onDelete: (forward: PortForward) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
      <Table>
        <TableHeader><TableRow>
          <TableHead className="w-10"><input type="checkbox" className="size-4 cursor-pointer" data-testid="forward-select-all"
            aria-label={text("forward.selectAll")} disabled={!canUpdateAny || forwards.length === 0}
            checked={allPageSelected} onChange={(event) => onSelectAll(event.target.checked)} /></TableHead>
          <SortableHead label={t("common.name")} sortKey="name" sort={sort} order={order} onSort={onSort} />
          <SortableHead label={t("forward.mode")} sortKey="mode" sort={sort} order={order} onSort={onSort} />
          <TableHead>{t("forward.protocol")}</TableHead><TableHead>{t("forward.ingressNode")}</TableHead><TableHead>{t("forward.egressNode")}</TableHead>
          <SortableHead label={t("forward.listenPort")} sortKey="listen_port" sort={sort} order={order} onSort={onSort} />
          <TableHead>{t("forward.accessAddress")}</TableHead><TableHead>{t("forward.target")}</TableHead>
          <SortableHead label={t("common.status")} sortKey="status" sort={sort} order={order} onSort={onSort} />
          <SortableHead label={t("common.createdAt")} sortKey="created_at" sort={sort} order={order} onSort={onSort} />
          <TableHead className="w-12" />
        </TableRow></TableHeader>
        <TableBody>
          {loading ? <TableRow><TableCell colSpan={12} className="h-24 text-center text-[var(--muted-foreground)]">{t("common.loading")}</TableCell></TableRow>
          : forwards.length === 0 ? <TableEmpty colSpan={12} text={t("common.noData")} />
          : forwards.map((forward) => {
            const product = forwardProductStatus(forward);
            return <TableRow key={String(forward.id)}>
              <TableCell><input type="checkbox" className="size-4 cursor-pointer" data-testid={`forward-select-${forward.id}`}
                aria-label={text("forward.selectRow")} disabled={selectionBusy || !(canSelect ? canSelect(forward) : canUpdate(forward))} checked={selectedIds.has(Number(forward.id))}
                onChange={(event) => onSelect(Number(forward.id), event.target.checked)} /></TableCell>
              <TableCell className="font-medium"><Link href={"/forwards/" + forward.id} className="hover:underline">{forward.name}</Link></TableCell>
              <TableCell><Badge variant={forward.mode === "relay" ? "outline" : "secondary"}>{forward.mode === "relay" ? t("forward.relay") : t("forward.direct")}</Badge></TableCell>
              <TableCell><ForwardProtocolBadge forward={forward} />{forwardTransportFor(forward.protocol) === "mixed" ? <p data-testid="forward-row-mixed" className="text-xs text-[var(--muted-foreground)]">{locale === "en" ? "TCP streams + UDP mappings · one shared budget" : "TCP 流 + UDP 映射 · 一条共享预算"}</p> : null}</TableCell>
              <TableCell>{forward.ingress_node?.node_id ?? forward.ingress_node_id}</TableCell>
              <TableCell>{forward.egress_node?.node_id ?? "—"}</TableCell>
              <TableCell className="font-mono text-xs">{forward.listen_port == null ? t("forward.addressPending") : `:${forward.listen_port}`}</TableCell>
              <TableCell className="font-mono text-xs">{forwardAccessAddress(forward) ?? t("forward.addressPending")}</TableCell>
              <TableCell className="font-mono text-xs">{forward.target_host ?? "—"}{forward.target_port ? ":" + forward.target_port : ""}</TableCell>
              <TableCell><div className="flex flex-col gap-1">
                <Badge variant={forwardProductBadgeVariant(product.state)} data-testid={`forward-status-${forward.id}`}>{t(`forward.product.${product.state}`)}</Badge>
                {forward.apply_error ? <span className="max-w-52 text-xs text-[var(--destructive)]">
                  {applyErrorAction(locale, forward.apply_error_code) ? <span className="block">{applyErrorAction(locale, forward.apply_error_code)}</span> : null}
                  <span className="block truncate font-mono opacity-70">{forward.apply_error}</span>
                </span> : null}
              </div></TableCell>
              <TableCell className="text-xs text-[var(--muted-foreground)]">{formatDateTime(forward.created_at)}</TableCell>
              <TableCell><DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" disabled={actionBusy === Number(forward.id)}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canUpdate(forward) && forward.apply_status === "error" ? <DropdownMenuItem onClick={() => onAction(forward, "retry")}>{t("forward.retry")}</DropdownMenuItem> : null}
                  {canUpdate(forward) && forward.apply_status === "active" ? <DropdownMenuItem onClick={() => onAction(forward, "suspend")}>{t("forward.suspend")}</DropdownMenuItem> : null}
                  {canUpdate(forward) && forward.apply_status === "suspended" ? <DropdownMenuItem onClick={() => onAction(forward, "resume")}>{t("forward.resume")}</DropdownMenuItem> : null}
                  <DropdownMenuItem disabled={!canUpdate(forward)} onClick={() => onEdit(forward)}><Pencil className="size-4" />{t("forward.editForward")}</DropdownMenuItem>
                  <DropdownMenuItem disabled={!canCreate} data-testid={`forward-copy-${forward.id}`} onClick={() => onCopy(forward)}><Copy className="size-4" />{text("forward.copyForward")}</DropdownMenuItem>
                  <DropdownMenuItem disabled={!canDelete(forward)} className="text-[var(--destructive)]" onClick={() => onDelete(forward)}><Trash2 className="size-4" />{t("common.delete")}</DropdownMenuItem>
                </DropdownMenuContent></DropdownMenu></TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
    </div>
  );
}
