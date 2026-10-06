"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useI18nOptional } from "@/components/providers";
import { DEFAULT_LOCALE, getDictionary, makeT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * 关闭按钮文案的**兜底**：产品默认语言词典里的 `common.close`。
 *
 * 只在没有 `<I18nProvider>` 的渲染环境（隔离单测、错误回退子树）里用到，但仍然
 * 不是空串、也不是写死的英文——旧实现把关闭按钮的 `sr-only` 文案写死成英文
 * "Close"，中文界面下屏幕阅读器读到的就是英文。词典缺键时 `t()` 返回键名本身，
 * 所以这里也永远不会渲染出空标签。
 */
function defaultCloseLabel(): string {
  return makeT(getDictionary(DEFAULT_LOCALE))("common.close");
}

/**
 * 关闭按钮的屏幕阅读器文案：显式 `label` 优先，否则跟随当前语言。
 *
 * 用 `useI18nOptional` 而不是会抛错的 `useI18n`：共享 primitive 可能出现在没有
 * Provider 的渲染里，那种情况回落默认语言文案即可，不该让整棵子树抛异常。
 * 单独导出是为了能被渲染测试直接断言（Radix Portal 在静态渲染下不产出 DOM）。
 */
export function useDialogCloseLabel(label?: string): string {
  const i18n = useI18nOptional();
  const explicit = label?.trim();
  if (explicit) return explicit;
  return i18n ? i18n.t("common.close") : defaultCloseLabel();
}

/**
 * 对话框右上角的关闭按钮：图标由 `X` 画，可访问名称来自 `sr-only` 文案。
 *
 * Radix 的 `Close` 负责关闭行为与焦点管理；文案统一在这里解析，避免每个对话框
 * 各写一份、或在中文界面漏出英文。需要更具体的说法时用 `label` 覆盖。
 */
export function DialogCloseButton({
  className,
  label,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close> & {
  /** 覆盖屏幕阅读器文案；缺省跟随当前语言。 */
  label?: string;
}) {
  const resolved = useDialogCloseLabel(label);
  return (
    <DialogPrimitive.Close
      className={cn(
        "absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100",
        className,
      )}
      {...props}
    >
      <X className="size-4" />
      <span className="sr-only">{resolved}</span>
    </DialogPrimitive.Close>
  );
}

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4",
          "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] p-5 shadow-lg max-h-[90vh] overflow-y-auto",
          className,
        )}
        {...props}
      >
        {children}
        <DialogCloseButton />
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

export function DialogTitle({ className, ...props }: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-lg font-semibold", className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-sm text-[var(--muted-foreground)]", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}
