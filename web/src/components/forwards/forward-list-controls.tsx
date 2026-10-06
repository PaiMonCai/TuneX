"use client";

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  FORWARD_PAGE_SIZE_OPTIONS,
  type ForwardSortKey,
  type ForwardSortOrder,
} from "@/components/forwards/forward-list-model";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function ForwardListControls({
  loading,
  total,
  page,
  pageCount,
  pageSize,
  sort,
  order,
  t,
  text,
  onPageChange,
  onPageSizeChange,
  onSortChange,
  onOrderChange,
}: {
  loading: boolean;
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  sort: ForwardSortKey;
  order: ForwardSortOrder;
  t: Translate;
  text: Translate;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onSortChange: (sort: ForwardSortKey) => void;
  onOrderChange: (order: ForwardSortOrder) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] p-3"
      data-testid="forward-list-controls"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--muted-foreground)]">{t("fields.orderBy")}</span>
        <Select value={sort} onValueChange={(value) => onSortChange(value as ForwardSortKey)}>
          <SelectTrigger className="h-9 w-36" data-testid="forward-sort-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="order_by">{t("fields.orderBy")}</SelectItem>
            <SelectItem value="name">{t("common.name")}</SelectItem>
            <SelectItem value="mode">{t("forward.mode")}</SelectItem>
            <SelectItem value="listen_port">{t("forward.listenPort")}</SelectItem>
            <SelectItem value="status">{t("common.status")}</SelectItem>
            <SelectItem value="created_at">{t("common.createdAt")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          data-testid="forward-sort-order"
          aria-label={order === "asc" ? text("forward.sortAsc") : text("forward.sortDesc")}
          onClick={() => onOrderChange(order === "asc" ? "desc" : "asc")}
        >
          {order === "asc" ? <ArrowUp className="size-4" /> : <ArrowDown className="size-4" />}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-[var(--muted-foreground)]" data-testid="forward-total">
          {t("common.total")} {total} {t("common.items")}
        </span>
        <span className="text-xs text-[var(--muted-foreground)]">{text("forward.pageSize")}</span>
        <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
          <SelectTrigger className="h-9 w-24" data-testid="forward-page-size">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FORWARD_PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="icon"
          variant="outline"
          data-testid="forward-page-prev"
          aria-label={text("forward.pagePrev")}
          disabled={loading || page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-xs text-[var(--muted-foreground)]" data-testid="forward-page-info">
          {text("forward.pageInfo", { page, pages: pageCount })}
        </span>
        <Button
          size="icon"
          variant="outline"
          data-testid="forward-page-next"
          aria-label={text("forward.pageNext")}
          disabled={loading || page >= pageCount}
          onClick={() => onPageChange(Math.min(pageCount, page + 1))}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
