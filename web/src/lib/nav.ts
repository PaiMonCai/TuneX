import type { Locale } from "@/lib/i18n";
import { getDictionary } from "@/lib/i18n";
import type { IconKey } from "@/components/nav-icon";

/**
 * 侧边栏导航项。
 *
 * 注意：这里存的是可序列化的 `iconKey`（字符串），不是 React 组件本身。
 * `AppShell`（服务端组件）会把 `userNav` / `adminNav` 传给客户端 `Sidebar`，
 * 而函数/组件无法跨「服务端 → 客户端」边界序列化（传组件会直接让页面 500）。
 * 真正的 lucide 图标在客户端组件 `NavIcon` 内按 key 解析。
 */
export interface NavItem {
  href: string;
  labelKey: string;
  iconKey: IconKey;
}

export const userNav: NavItem[] = [
  { href: "/dashboard", labelKey: "common.dashboard", iconKey: "dashboard" },
  { href: "/tunnels", labelKey: "common.tunnels", iconKey: "tunnels" },
  ...(process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true"
    ? ([
        { href: "/plans", labelKey: "common.plans", iconKey: "plans" },
        { href: "/topup", labelKey: "common.topup", iconKey: "topup" },
      ] satisfies NavItem[])
    : []),
  { href: "/tickets", labelKey: "common.tickets", iconKey: "tickets" },
  { href: "/settings", labelKey: "common.settings", iconKey: "settings" },
  // TEN-01：团队空间成员管理（与「设置」同级，切换器下拉亦可进入）
  { href: "/settings/workspace", labelKey: "common.workspace", iconKey: "workspace" },
];

export const adminNav: NavItem[] = [
  { href: "/admin", labelKey: "admin.dashboard", iconKey: "adminDashboard" },
  { href: "/admin/nodes", labelKey: "admin.nodes", iconKey: "nodes" },
  { href: "/admin/node-groups", labelKey: "admin.nodeGroups", iconKey: "nodeGroups" },
  ...(process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true"
    ? ([{ href: "/admin/plans", labelKey: "admin.plans", iconKey: "plans" }] satisfies NavItem[])
    : []),
  { href: "/admin/tunnels", labelKey: "admin.tunnels", iconKey: "adminTunnels" },
  { href: "/admin/users", labelKey: "admin.users", iconKey: "users" },
  { href: "/admin/roles", labelKey: "admin.roles", iconKey: "roles" },
  ...(process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true"
    ? ([{ href: "/admin/orders", labelKey: "admin.orders", iconKey: "orders" }] satisfies NavItem[])
    : []),
  { href: "/admin/tickets", labelKey: "admin.tickets", iconKey: "adminTickets" },
  { href: "/admin/settings", labelKey: "admin.settings", iconKey: "settings" },
  { href: "/admin/audit-logs", labelKey: "admin.auditLogs", iconKey: "license" },
  { href: "/admin/license", labelKey: "admin.license", iconKey: "license" },
];

/** 服务端可用：把 labelKey 解析成当前语言 */
export function labelOf(locale: Locale, key: string): string {
  const dict = getDictionary(locale);
  const parts = key.split(".");
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
    else return key;
  }
  return typeof cur === "string" ? cur : key;
}

/**
 * 选项文案：优先用词典里的 labelKey，缺失时回落到内置的中英文字面量。
 * 供 Select 的下拉项统一取词，避免每个表单各写一套。
 */
export function localizedLabel(
  locale: Locale,
  labelKey: string | undefined,
  zh: string,
  en: string,
): string {
  if (labelKey) {
    const v = labelOf(locale, labelKey);
    if (v !== labelKey) return v;
  }
  return locale === "en" ? en : zh;
}
