"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Locale } from "@/lib/i18n";
import { localizedLabel } from "@/lib/nav";
import type { OptionMeta } from "@/lib/constants";

/** 由常量表驱动的下拉：中英自动跟随 locale，管理端表单统一使用 */
export function OptionSelect<V extends string = string>({
  value,
  onValueChange,
  options,
  locale,
  placeholder,
  disabled,
  testId,
}: {
  value: string;
  onValueChange: (v: V) => void;
  options: readonly OptionMeta[] | readonly { value: V; zh: string; en: string; labelKey?: string }[];
  locale: Locale;
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onValueChange(v as V)} disabled={disabled}>
      <SelectTrigger data-testid={testId}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {localizedLabel(locale, o.labelKey, o.zh, o.en)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
