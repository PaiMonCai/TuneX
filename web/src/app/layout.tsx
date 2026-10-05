import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, getDictionary, normalizeLocale } from "@/lib/i18n";
import { AppProviders } from "@/components/providers";
import { WorkspaceProvider } from "@/components/workspace/workspace-context";
import { Toaster } from "sonner";
import "./globals.css";

/** 元信息跟随语言 cookie，在 SSR 阶段与页面正文保持一致。 */
export async function generateMetadata(): Promise<Metadata> {
  const store = await cookies();
  const locale = normalizeLocale(store.get(LOCALE_COOKIE)?.value);
  const dict = getDictionary(locale);
  return {
    title: { default: `TuneX — ${dict.common.tagline}`, template: "%s · TuneX" },
    description:
      locale === "zh"
        ? "TuneX：多协议网络转发、线路编排与流量计费。"
        : "TuneX: multi-protocol forwarding, route orchestration and usage-based billing.",
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

/** 根布局：语言、主题 Provider、workspace 上下文和全局 Toaster。 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const locale = normalizeLocale(store.get(LOCALE_COOKIE)?.value);
  const dict = getDictionary(locale);

  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"} suppressHydrationWarning>
      <body className="min-h-screen bg-[var(--background)] text-[var(--foreground)] antialiased">
        <AppProviders locale={locale} dict={dict}>
          <WorkspaceProvider>{children}</WorkspaceProvider>
          <Toaster richColors position="top-center" />
        </AppProviders>
      </body>
    </html>
  );
}
