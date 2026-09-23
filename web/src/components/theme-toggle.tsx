"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/providers";

/** 暗色模式切换：next-themes + class 策略，服务端渲染时占位避免 hydration 抖动 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const { t } = useI18n();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";
  // mounted 之前保持与 SSR 一致的文案/图标，避免 hydration 抖动
  const label = mounted && isDark ? t("common.light") : t("common.dark");
  return (
    <Button
      variant="ghost"
      size="icon"
      data-testid="theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {mounted && isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}
