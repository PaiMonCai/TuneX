"use client";

import {
  ArrowLeftRight,
  BadgeCheck,
  BarChart3,
  Boxes,
  Building2,
  CreditCard,
  LayoutDashboard,
  LifeBuoy,
  Network,
  Package,
  Server,
  Settings,
  Shield,
  ShoppingCart,
  Users,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

/**
 * 侧边栏图标注册表：把「图标」收敛成一个可序列化的字符串键。
 *
 * 关键约束（Next 16 App Router）：`AppShell` 是服务端组件，`Sidebar` 是客户端组件。
 * 服务端向客户端传 props 时，**函数/组件（React 组件本质是函数）无法被序列化**，
 * 直接传 `icon: LayoutDashboard` 会抛
 * "Functions cannot be passed directly to Client Components" 并让整页 500。
 * 因此这里只传 `iconKey` 字符串，由本客户端组件在客户端完成映射与渲染。
 */
export const NAV_ICONS = {
  dashboard: LayoutDashboard,
  forwards: ArrowLeftRight,
  tunnels: Waypoints,
  plans: Package,
  topup: CreditCard,
  tickets: LifeBuoy,
  settings: Settings,
  workspace: Building2,
  adminDashboard: BarChart3,
  nodes: Server,
  nodeGroups: Boxes,
  adminTunnels: Network,
  users: Users,
  roles: Shield,
  orders: ShoppingCart,
  adminTickets: LifeBuoy,
  license: BadgeCheck,
} satisfies Record<string, LucideIcon>;

export type IconKey = keyof typeof NAV_ICONS;

export function NavIcon({ name, className }: { name: IconKey; className?: string }) {
  const Icon = NAV_ICONS[name] ?? LayoutDashboard;
  return <Icon className={className} aria-hidden="true" />;
}
