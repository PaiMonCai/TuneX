import Link from "next/link";
import { cookies } from "next/headers";
import { ArrowRight, Gauge, Layers, Network, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LOCALE_COOKIE, getDictionary, normalizeLocale } from "@/lib/i18n";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";

export default async function LandingPage() {
  const store = await cookies();
  const locale = normalizeLocale(store.get(LOCALE_COOKIE)?.value);
  const t = getDictionary(locale);
  const loggedIn = !!store.get("tunex_session");

  const features = [
    { icon: Network, title: t.landing.feature1Title, desc: t.landing.feature1Desc },
    { icon: Layers, title: t.landing.feature2Title, desc: t.landing.feature2Desc },
    { icon: Gauge, title: t.landing.feature3Title, desc: t.landing.feature3Desc },
  ];

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b border-[var(--border)] px-6">
        <div className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-md bg-[var(--primary)] text-sm font-bold text-[var(--primary-foreground)]">
            T
          </div>
          <span className="text-sm font-semibold">{t.common.siteName}</span>
        </div>
        <div className="flex items-center gap-1">
          <LocaleSwitcher />
          <ThemeToggle />
          <Button variant="ghost" size="sm" asChild>
            <Link href={loggedIn ? "/dashboard" : "/login"} data-testid="header-login">
              {loggedIn ? t.common.dashboard : t.common.login}
            </Link>
          </Button>
          <Button size="sm" asChild>
            <Link href="/register">{t.common.register}</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-16" data-lang={locale} data-testid="landing">
        <div className="flex flex-col items-center text-center">
          <span className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--muted-foreground)]">
            <ShieldCheck className="size-3.5" /> Next.js 16 · App Router
          </span>
          <h1 className="max-w-3xl text-balance text-4xl font-bold tracking-tight sm:text-5xl" data-testid="landing-title">
            {t.landing.title}
          </h1>
          <p className="mt-4 max-w-2xl text-pretty text-[var(--muted-foreground)]">{t.landing.subtitle}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button size="lg" asChild>
              <Link href="/dashboard">
                {t.landing.ctaPrimary} <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button size="lg" variant="outline" asChild>
              <Link href={process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true" ? "/plans" : "/tunnels"}>
                {process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true" ? t.landing.ctaSecondary : t.common.tunnels}
              </Link>
            </Button>
          </div>
        </div>

        <div className="mt-16 grid gap-5 sm:grid-cols-3">
          {features.map((f) => (
            <Card key={f.title}>
              <CardHeader>
                <f.icon className="mb-2 size-5 text-[var(--primary)]" />
                <CardTitle>{f.title}</CardTitle>
                <CardDescription>{f.desc}</CardDescription>
              </CardHeader>
              <CardContent />
            </Card>
          ))}
        </div>
      </main>

      <footer className="border-t border-[var(--border)] px-6 py-6 text-center text-xs text-[var(--muted-foreground)]">
        TuneX · {t.common.tagline}
      </footer>
    </div>
  );
}
