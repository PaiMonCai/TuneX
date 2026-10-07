"use client";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ForwardBatchAction } from "@/lib/types";
import type { ForwardListTextKey } from "@/components/forwards/forward-list-model";

type ListText = (key: ForwardListTextKey, params?: Record<string, string | number>) => string;

export function ForwardBatchBar({ count, busy, error, text, onRun, onClear, canUpdate = true, canDelete = false }: {
  count: number;
  busy: boolean;
  error: string | null;
  text: ListText;
  onRun: (action: ForwardBatchAction) => void;
  onClear: () => void;
  canUpdate?: boolean;
  canDelete?: boolean;
}) {
  if (count === 0) {
    if (!error) return null;
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--destructive)]/50 bg-[var(--muted)]/40 p-3" data-testid="forward-batch-bar">
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs text-[var(--destructive)]" role="alert" data-testid="forward-batch-error">{error}</p>
        <Button size="sm" variant="ghost" onClick={onClear}>{text("forward.batchClear")}</Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--muted)]/40 p-3" data-testid="forward-batch-bar">
      <span className="text-sm font-medium" data-testid="forward-batch-count">{text("forward.batchSelected", { count })}</span>
      <Button size="sm" variant="outline" data-testid="forward-batch-retry" disabled={busy || !canUpdate} onClick={() => onRun("retry")}>
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}{text("forward.batchRetry")}
      </Button>
      <Button size="sm" variant="outline" data-testid="forward-batch-suspend" disabled={busy || !canUpdate} onClick={() => onRun("suspend")}>{text("forward.batchSuspend")}</Button>
      <Button size="sm" variant="outline" data-testid="forward-batch-resume" disabled={busy || !canUpdate} onClick={() => onRun("resume")}>{text("forward.batchResume")}</Button>
      {canDelete ? <Button size="sm" variant="destructive" data-testid="forward-batch-delete" disabled={busy} onClick={() => onRun("delete")}>{text("forward.batchDelete")}</Button> : null}
      <Button size="sm" variant="ghost" data-testid="forward-batch-clear" disabled={busy} onClick={onClear}>{text("forward.batchClear")}</Button>
      {error ? <p className="w-full whitespace-pre-wrap text-xs text-[var(--destructive)]" role="alert" data-testid="forward-batch-error">{error}</p> : null}
    </div>
  );
}
