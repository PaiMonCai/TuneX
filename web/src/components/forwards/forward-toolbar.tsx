"use client";

import { Plus, RefreshCw, Route, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { UserNode } from "@/lib/types";
import type { ForwardListTextKey, ForwardModeFilter, ForwardStatusFilter } from "./forward-list-model";

type Translate = (key: string, params?: Record<string, string | number>) => string;
type ListText = (key: ForwardListTextKey, params?: Record<string, string | number>) => string;

export function ForwardToolbar({
  mode, status, ingress, egress, keyword, ingressNodes, egressNodes, canCreate, t, text,
  onMode, onStatus, onIngress, onEgress, onKeyword, onCreate, onRefresh, onReset, loading = false,
}: {
  mode: ForwardModeFilter; status: ForwardStatusFilter; ingress: string; egress: string; keyword: string;
  ingressNodes: UserNode[]; egressNodes: UserNode[]; canCreate: boolean; t: Translate; text: ListText;
  onMode: (value: ForwardModeFilter) => void; onStatus: (value: ForwardStatusFilter) => void;
  onIngress: (value: string) => void; onEgress: (value: string) => void; onKeyword: (value: string) => void;
  onCreate: (mode: "direct" | "relay") => void; onRefresh?: () => void; onReset?: () => void; loading?: boolean;
}) {
  const filtered = !!keyword.trim() || mode !== "all" || status !== "all" || ingress !== "all" || egress !== "all";
  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)]" data-testid="forward-toolbar">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 sm:p-4">
        <div className="console-segmented" role="group" aria-label={t("forward.mode")}>
          {(["all", "direct", "relay"] as const).map((value) => (
            <Button key={value} size="sm" variant="ghost" aria-pressed={mode === value} onClick={() => onMode(value)}
              className={mode === value ? "bg-[var(--card)] text-[var(--foreground)] shadow-sm hover:bg-[var(--card)]" : "text-[var(--muted-foreground)]"}>
              {t(value === "all" ? "forward.all" : `forward.${value}`)}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onRefresh && <Button size="icon" variant="outline" disabled={loading} onClick={onRefresh} aria-label={t("common.refresh")} title={t("common.refresh")}>
            <RefreshCw className={loading ? "animate-spin motion-reduce:animate-none" : ""} />
          </Button>}
          <Button disabled={!canCreate} variant="outline" onClick={() => onCreate("direct")}><Plus />{t("forward.createDirect")}</Button>
          <Button disabled={!canCreate} onClick={() => onCreate("relay")}><Route />{t("forward.createRelay")}</Button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2 border-t border-[var(--border)] bg-[var(--background)]/40 p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-[minmax(180px,1.5fr)_repeat(3,minmax(140px,1fr))_auto]">
        <div className="relative min-w-0">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 size-4 text-[var(--muted-foreground)]" />
          <Input className="h-9 w-full pl-9" value={keyword} onChange={(event) => onKeyword(event.target.value)}
            placeholder={t("forward.searchPlaceholder")} aria-label={t("forward.searchPlaceholder")} data-testid="forward-keyword" />
        </div>
        <Select value={status} onValueChange={(value) => onStatus(value as ForwardStatusFilter)}>
          <SelectTrigger className="h-9 w-full" aria-label={t("common.status")}><SelectValue /></SelectTrigger>
          <SelectContent>{(["all", "active", "pending", "applying", "suspended", "error"] as const).map((value) =>
            <SelectItem key={value} value={value}>{t(value === "all" ? "forward.statusAll" : value === "applying" ? "tunnel.v3ApplyApplying" : `forward.status${value[0].toUpperCase() + value.slice(1)}`)}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={ingress} onValueChange={onIngress}>
          <SelectTrigger className="h-9 w-full" aria-label={t("forward.allIngress")}><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">{t("forward.allIngress")}</SelectItem>
            {ingressNodes.map((node) => <SelectItem key={String(node.id)} value={String(node.id)}>{node.node_id}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={egress} onValueChange={onEgress}>
          <SelectTrigger className="h-9 w-full" aria-label={text("forward.allEgress")} data-testid="forward-egress-filter"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">{text("forward.allEgress")}</SelectItem>
            {egressNodes.map((node) => <SelectItem key={String(node.id)} value={String(node.id)}>{node.node_id}</SelectItem>)}
          </SelectContent>
        </Select>
        {onReset && <Button variant="ghost" disabled={!filtered} onClick={onReset} data-testid="forward-filters-reset" className="text-[var(--muted-foreground)]"><X />{t("forward.resetFilters")}</Button>}
      </div>
    </div>
  );
}
