import Link from "next/link";
import { ApiError } from "@/lib/api/core";
import type { Locale } from "@/lib/i18n";
import { Button } from "@/components/ui/button";

export function linkedForwardHref(forward: { link_resource_id?: number | null }): string | null {
  const id = forward.link_resource_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? `/links?selected=${id}` : null;
}
export function isLinkManagedError(error: unknown): boolean {
  return error instanceof ApiError && !!error.data && typeof error.data === "object"
    && (error.data as Record<string, unknown>).code === "link_managed_forward";
}
export function linkedForwardText(locale: Locale): string {
  return locale === "en" ? "This rule is managed by an encrypted Link. Edit it and perform actions from the Link resource page."
    : "此规则由加密连接（Link）托管，请到对应连接修改配置或执行操作。";
}
export function LinkedForwardGuide({ forward, locale }: { forward: { name: string; link_resource_id?: number | null }; locale: Locale }) {
  const href = linkedForwardHref(forward);
  if (!href) return null;
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--border)] p-3 text-sm" data-testid="linked-forward-guide">
    <p className="min-w-0 break-all"><span className="font-medium">{forward.name}</span> · {linkedForwardText(locale)}</p>
    <Button variant="outline" size="sm" asChild><Link href={href}>{locale === "en" ? "Manage Link" : "前往连接管理"}</Link></Button>
  </div>;
}
