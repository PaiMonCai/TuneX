/**
 * Locale identity and persistence constants.
 */
export type Locale = "zh" | "en";

export const LOCALE_COOKIE = "tunex_locale";
export const DEFAULT_LOCALE: Locale = "zh";
export const LOCALES: { value: Locale; label: string }[] = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
];

export function normalizeLocale(v: string | undefined | null): Locale {
  return v === "en" ? "en" : "zh";
}
