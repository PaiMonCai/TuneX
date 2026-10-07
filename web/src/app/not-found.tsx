import Link from "next/link";
import { cookies } from "next/headers";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LOCALE_COOKIE, normalizeLocale } from "@/lib/i18n";

/**
 * 受控的 404 面（App Router `not-found.js`）。
 *
 * 在此之前全站没有 `not-found.tsx`：`notFound()` 与不存在的地址都会渲染 Next 的默认
 * 404 —— 没有站点外观，也没有回去的路。这里给一个**说真话**的空态：
 * 只说「这个地址没有对应页面」，不猜是拼错还是已删除，也不把它说成任何形式的故障。
 */
const COPY = {
  zh: {
    title: "这个地址没有对应的页面",
    reason: "TuneX 没有匹配这个 URL 的页面。可能是链接拼写有误，或者被访问的资源已经改名/删除。",
    home: "返回首页",
    console: "进入控制台",
  },
  en: {
    title: "No page matches this address",
    reason: "TuneX has no page for this URL. The link may be misspelled, or the resource was renamed or removed.",
    home: "Back to home",
    console: "Open console",
  },
} as const;

export default async function NotFound() {
  const locale = normalizeLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  const copy = COPY[locale];

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-4" data-testid="not-found-surface">
      <Card className="w-full max-w-lg">
        <CardHeader className="flex-row items-start gap-3">
          <Compass className="mt-0.5 size-5 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />
          <div className="min-w-0">
            <CardTitle>{copy.title}</CardTitle>
            <CardDescription className="mt-2">{copy.reason}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button size="sm" asChild>
            <Link href="/" data-testid="not-found-home">
              {copy.home}
            </Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href="/dashboard" data-testid="not-found-console">
              {copy.console}
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
