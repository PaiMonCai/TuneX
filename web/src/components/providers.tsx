"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Dictionary, Locale } from "@/lib/i18n";
import { LOCALE_COOKIE, getDictionary, makeT } from "@/lib/i18n";
import { ThemeProvider } from "next-themes";

interface I18nContextValue {
  locale: Locale;
  dict: Dictionary;
  t: (key: string, params?: Record<string, string | number>) => string;
  setLocale: (l: Locale) => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({
  locale,
  dict,
  children,
}: {
  locale: Locale;
  dict: Dictionary;
  children: React.ReactNode;
}) {
  const [current, setCurrent] = useState<Locale>(locale);

  const setLocale = useCallback((l: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${l};path=/;max-age=${60 * 60 * 24 * 365}`;
    setCurrent(l);
    // SSR 输出（curl 可见的 HTML）需要跟随 cookie，故刷新一次
    window.location.reload();
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale: current,
      dict,
      t: makeT(dict),
      setLocale,
    }),
    [current, dict, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}

export function AppProviders({ locale, dict, children }: { locale: Locale; dict: Dictionary; children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <I18nProvider locale={locale} dict={dict}>
        {children}
      </I18nProvider>
    </ThemeProvider>
  );
}

export { getDictionary };
