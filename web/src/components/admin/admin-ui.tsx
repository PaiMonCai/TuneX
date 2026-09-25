"use client";

import { useState } from "react";
import { Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/components/providers";

/** 管理端列表页顶部工具条：搜索 + 刷新 + 新建 */
export function AdminToolbar({
  keyword,
  onKeywordChange,
  onSearch,
  onRefresh,
  loading,
  total,
  onCreate,
  createLabel,
  createTestId,
}: {
  keyword: string;
  onKeywordChange: (v: string) => void;
  onSearch: () => void;
  onRefresh: () => void;
  loading: boolean;
  total?: number;
  onCreate?: () => void;
  createLabel?: string;
  createTestId?: string;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Input
          value={keyword}
          onChange={(e) => onKeywordChange(e.target.value)}
          placeholder={t("common.search")}
          className="w-48 sm:w-64"
          onKeyDown={(e) => e.key === "Enter" && onSearch()}
          data-testid="admin-search"
        />
        <Button size="sm" variant="outline" onClick={onSearch}>
          <Search className="size-4" />
          {t("common.search")}
        </Button>
        <Button size="icon" variant="ghost" onClick={onRefresh} disabled={loading} aria-label={t("common.refresh")}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </Button>
        {typeof total === "number" && (
          <span className="text-xs text-[var(--muted-foreground)]">{t("admin.totalCount", { n: total })}</span>
        )}
      </div>
      {onCreate && (
        <Button size="sm" onClick={onCreate} data-testid={createTestId ?? "admin-create"}>
          <Plus className="size-4" />
          {createLabel ?? t("common.create")}
        </Button>
      )}
    </div>
  );
}

/** 删除确认弹窗：所有管理端资源共用，文案由调用方提供 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending} data-testid="admin-confirm-delete">
            {pending && <Loader2 className="size-4 animate-spin" />}
            {t("common.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 行内操作按钮组：编辑 + 删除（extra 供调用方追加入口，如「详情」跳转） */
export function RowActions({ onEdit, onDelete, extra }: { onEdit: () => void; onDelete: () => void; extra?: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-end gap-1">
      {extra}
      <Button size="sm" variant="ghost" onClick={onEdit} data-testid="row-edit">
        {t("common.edit")}
      </Button>
      <Button size="sm" variant="ghost" className="text-[var(--destructive)]" onClick={onDelete} data-testid="row-delete">
        {t("common.delete")}
      </Button>
    </div>
  );
}

/** 管理端 Dialog 表单的外壳：统一宽度、滚动与底部按钮 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  onSubmit,
  submitLabel,
  pending,
  wide,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  onSubmit: () => void;
  submitLabel: string;
  pending: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={wide ? "max-w-2xl" : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={pending} data-testid="admin-form-submit">
              {pending && <Loader2 className="size-4 animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 受控表单 state 的极简 helper：避免每个表单写一堆 setXxx */
export function useForm<T extends object>(initial: T) {
  const [form, setForm] = useState<T>(initial);
  function set<K extends keyof T>(key: K, value: T[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }
  return { form, set, setForm, reset: (next?: T) => setForm(next ?? initial) };
}
