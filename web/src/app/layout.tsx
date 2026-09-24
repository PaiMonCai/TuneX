import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, getDictionary, normalizeLocale } from "@/lib/i18n";
import { AppProviders } from "@/components/providers";
import { Toaster } from "sonner";
import "./globals.css";

/**
 * 元信息跟随语言 cookie：`<title>` / description 在 SSR 阶段就按 tunex_locale 输出，
 * 与页面正文语言保持一致（curl 带 Cookie 即可验证中英切换）。
 */
export async function generateMetadata(): Promise<Metadata> {
  const store = await cookies();
  const locale = normalizeLocale(store.get(LOCALE_COOKIE)?.value);
  const dict = getDictionary(locale);
  return {
    title: { default: `TuneX — ${dict.common.tagline}`, template: "%s · TuneX" },
    description:
      locale === "zh"
        ? "TuneX：多协议隧道、节点组编排、流量计费。"
        : "TuneX: multi-protocol tunnels, node groups and usage-based billing.",
    applicationName: "TuneX",
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "oklch(0.99 0.002 250)" },
    { media: "(prefers-color-scheme: dark)", color: "oklch(0.19 0.015 260)" },
  ],
};

/**
 * 根布局（服务端组件）。
 *
 * - `<html lang>` 与词典都由 tunex_locale cookie 决定 → 中英切换体现在 SSR 输出里；
 * - `suppressHydrationWarning` 是 next-themes（class 策略暗色模式）在 <html> 上注入 class 所必需的；
 * - Toaster 全局只挂载一次，AppShell 内不再重复挂载（避免重复弹窗）。
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const locale = normalizeLocale(store.get(LOCALE_COOKIE)?.value);
  const dict = getDictionary(locale);

  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"} suppressHydrationWarning>
      <body className="min-h-screen bg-[var(--background)] text-[var(--foreground)] antialiased">
        <AppProviders locale={locale} dict={dict}>
          {children}
          <Toaster richColors position="top-center" />
        </AppProviders>
      </body>
    </html>
  );
}
