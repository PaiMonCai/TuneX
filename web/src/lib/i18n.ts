/**
 * Lightweight i18n facade used by server and client code.
 *
 * Dictionary payloads live in ./i18n/dictionaries; locale persistence lives
 * in ./i18n/locale. Existing "@/lib/i18n" imports remain compatible.
 */
import { DEFAULT_LOCALE, type Locale } from "./i18n/locale";
import { dictionaries, type Dict } from "./i18n/dictionaries";

export * from "./i18n/locale";
export type { Dict as Dictionary } from "./i18n/dictionaries";

export function getDictionary(locale: Locale): Dict {
  return dictionaries[locale] ?? dictionaries[DEFAULT_LOCALE];
}

/** 点号路径取值：t("tunnel.createTitle") */
export function translate(dict: Dict, key: string): string {
  const parts = key.split(".");
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return key;
    }
  }
  return typeof cur === "string" ? cur : key;
}

/** 占位符替换：t("admin.deleteConfirm", { name: "套餐 A" }) → 词条里的 {name} 被替换 */
export function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (raw, name: string) =>
    name in params ? String(params[name]) : raw,
  );
}

/** 合并「取词 + 占位符替换」：服务端/客户端通用的 t 实现 */
export function makeT(dict: Dict): (key: string, params?: Record<string, string | number>) => string {
  return (key, params) => interpolate(translate(dict, key), params);
}
