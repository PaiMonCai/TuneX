import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";
import { LOCALE_COOKIE, getDictionary, normalizeLocale, type Dictionary, type Locale } from "@/lib/i18n";
import { labelOf, type ConsoleSurface } from "@/lib/nav";
import { guardConsoleAccess, LOGIN_PATH } from "@/components/console/console-guard";

/**
 * 服务端会话 / i18n（从 `components/app-shell.tsx` 抽出，供 UserShell / AdminShell / route group
 * layout 共用；`app-shell.tsx` 原样再导出，保持既有导入路径兼容）。
 *
 * 一次请求内的重复调用由 React `cache` 去重：route group layout 与 shell 都调用
 * `requireSession()` / `getSession()` 时，实际只打一次 `/api/auth/me`
 * —— §9.4.7「页面 shell 先响应」不允许为一次渲染重复请求会话。
 */

export interface ConsoleSession {
  user: User;
  cookie: string;
}

/**
 * 读取会话；未登录返回 `null`（不重定向）。
 * 供 route group layout 做边界判定，避免「守卫即重定向」写死在底层函数里。
 */
export const getSession = cache(async (): Promise<ConsoleSession | null> => {
  const store = await cookies();
  const cookie = store.toString();
  try {
    const session = await api.auth.session(cookie);
    return { user: session.user, cookie };
  } catch {
    return null;
  }
});

/** 服务端 Auth 守卫：未登录 → /login（保持既有行为） */
export const requireSession = cache(async (): Promise<ConsoleSession> => {
  const session = await getSession();
  if (!session) redirect(LOGIN_PATH);
  return session;
});

/**
 * route group 边界：把「未登录 → /login」交给纯函数 `guardConsoleAccess` 决策。
 * 认证页（`auth`）与落地页（`public`）不会被重定向。
 */
export async function enforceConsoleBoundary(surface: ConsoleSurface): Promise<ConsoleSession | null> {
  const session = await getSession();
  const decision = guardConsoleAccess({ surface, authenticated: session !== null });
  if (decision.action === "redirect") redirect(decision.to);
  return session;
}

/**
 * 当前语言（服务端读取 cookie）。
 * /admin 等页面会单独调用它，因此必须保持导出。
 */
export async function currentLocale(): Promise<Locale> {
  const store = await cookies();
  return normalizeLocale(store.get(LOCALE_COOKIE)?.value);
}

/** 服务端 i18n：locale + 词典 + 点号取词的 t（统一的 SSR 取词入口） */
export async function shellI18n(): Promise<{ locale: Locale; dict: Dictionary; t: (key: string) => string }> {
  const locale = await currentLocale();
  const dict = getDictionary(locale);
  return { locale, dict, t: (key: string) => labelOf(locale, key) };
}
