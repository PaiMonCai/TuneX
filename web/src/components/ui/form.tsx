import * as React from "react";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/input";

/** 表单行：label + 控件 + 提示，所有表单（用户端/管理端）共用，保证间距与文案位置一致 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && <Label htmlFor={htmlFor}>{label}</Label>}
      {children}
      {hint && !error && <p className="field-hint">{hint}</p>}
      {error && (
        <p className="text-xs text-[var(--destructive)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** 只读键值展示行：用于详情页的「基础信息」网格 */
export function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="field-label">{label}</span>
      <span className="min-w-0 text-right text-sm">{children}</span>
    </div>
  );
}

/** 开关（无 Radix switch 依赖，用原生 checkbox + 样式，保持键盘可达） */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-[var(--primary)]" : "bg-[var(--muted-foreground)]/40",
      )}
    >
      <span
        className={cn(
          "inline-block size-5 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

/** 开关 + 说明文案的一行 */
export function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-[var(--border)] px-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="field-hint">{description}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
