import Link from "next/link";
import { cookies } from "next/headers";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { LOCALE_COOKIE, getDictionary, normalizeLocale } from "@/lib/i18n";

/** 登录/注册共用的居中外壳（服务端组件，负责 i18n 与语言切换） */
export async function AuthShell({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const locale = normalizeLocale(store.get(LOCALE_COOKIE)?.value);
  const t = getDictionary(locale);
  return (
    <div className="flex min-h-screen flex-col" data-lang={locale}>
      <header className="flex h-14 items-center justify-between border-b border-[var(--border)] px-6">
        <Link href="/" className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-md bg-[var(--primary)] text-sm font-bold text-[var(--primary-foreground)]">
            R
          </div>
          <span className="text-sm font-semibold">{t.common.siteName}</span>
        </Link>
        <div className="flex items-center gap-1">
          <LocaleSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center p-6">{children}</div>
    </div>
  );
}
