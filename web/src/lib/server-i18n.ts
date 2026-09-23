import { cookies } from "next/headers";
import { LOCALE_COOKIE, getDictionary, makeT, normalizeLocale, type Dictionary, type Locale } from "@/lib/i18n";

export interface ServerI18n {
  locale: Locale;
  dict: Dictionary;
  /** 点号路径取词：t("tunnel.createTitle")，也支持占位符 t("admin.createSuccess", { name }) */
  t: (key: string, params?: Record<string, string | number>) => string;
}

/** 服务端组件统一入口：按 Cookie 里的 relayx_locale 取词典（curl 带 cookie 即可验证中英切换） */
export async function serverT(): Promise<ServerI18n> {
  const store = await cookies();
  const locale = normalizeLocale(store.get(LOCALE_COOKIE)?.value);
  const dict = getDictionary(locale);
  return { locale, dict, t: makeT(dict) };
}
