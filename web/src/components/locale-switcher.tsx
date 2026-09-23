"use client";

import { Check, Globe } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers";
import { LOCALES } from "@/lib/i18n";

export function LocaleSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t("common.language")} data-testid="locale-switcher">
          <Globe className="size-4" />
          <span className="hidden sm:inline">{locale === "zh" ? "中文" : "EN"}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("common.language")}</DropdownMenuLabel>
        {LOCALES.map((l) => (
          <DropdownMenuItem
            key={l.value}
            data-testid={`locale-${l.value}`}
            onSelect={() => setLocale(l.value)}
            className={locale === l.value ? "bg-[var(--accent)]" : undefined}
          >
            <Check className={locale === l.value ? "size-4 opacity-100" : "size-4 opacity-0"} />
            {l.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
