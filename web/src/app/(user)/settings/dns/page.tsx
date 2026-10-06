import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { DnsProvidersManager } from "@/components/ddns/dns-providers-manager";
import { currentLocale } from "@/components/console/session";
import { ddnsText } from "@/lib/ddns-i18n";

/**
 * 设置 · DNS 服务商（Workspace 级）。
 *
 * 为什么单独一页而不是塞进 `/settings`（个人资料）或 `/settings/workspace`（成员）：
 * 凭据属于**设置域**（后端 `settings:read` / `settings:manage`，`routes/ddns.ts:28-34`），
 * 它是"这个工作空间跨转发复用的资源"，与个人资料、成员管理是三种不同的权限面。
 *
 * 页面本身是服务端组件：只解析标题语言，数据由客户端组件按 `x-workspace-id`
 * 拉取——切 Workspace 后同一页自动刷新为新作用域，且晚到的旧响应会被丢弃。
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await currentLocale();
  return { title: ddnsText(locale).title };
}

export default async function DnsProvidersSettingsPage() {
  const locale = await currentLocale();
  const text = ddnsText(locale);
  return (
    <AppShell title={text.title} subtitle={text.subtitle} activeHref="/settings/dns">
      <DnsProvidersManager />
    </AppShell>
  );
}
