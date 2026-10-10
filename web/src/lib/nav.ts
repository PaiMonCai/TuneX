import type { Locale } from "@/lib/i18n";
import { getDictionary } from "@/lib/i18n";
import type { IconKey } from "@/components/nav-icon";

/**
 * User / Admin Console 导航模型。
 *
 * Route group 不改变外部 URL；内部运维概念只进入 Admin Console。
 * 本文件只定义界面入口，不承担 RBAC；导航项必须保持可序列化。
 */

/** 控制台标识 */
export type ConsoleId = "user" | "admin";

/** 产品表面：两个控制台、认证页和公共页面。 */
export type ConsoleSurface = ConsoleId | "auth" | "public";

export interface NavItem {
  href: string;
  /** 词典 key；词典缺失时用 labelZh / labelEn 回退（`localizedLabel`） */
  labelKey: string;
  iconKey: IconKey;
  /** 新增项的回退文案（词典尚未收录时的中文 / 英文） */
  labelZh?: string;
  labelEn?: string;
  /** 尚未交付的页面以禁用项展示，不产生可点击链接。 */
  status?: "available" | "planned";
  /** 仅在 NEXT_PUBLIC_PAYMENTS_ENABLED=true 时进入可导航列表（保留既有 billing gate 语义） */
  requiresPayments?: boolean;
}

export interface NavGroup {
  /** 稳定 id（测试与 data 属性用） */
  id: string;
  labelKey: string;
  labelZh: string;
  labelEn: string;
  /** true = 不渲染分组标题（控制台首页这种「第一组」用） */
  plain?: boolean;
  items: NavItem[];
}

/**
 * route group 目录名。Next App Router 里带括号的目录**不参与 URL**，
 * 因此把页面搬进 `(user)` / `(admin)` / `(auth)` 不会改变任何对外路径。
 */
export const CONSOLE_ROUTE_GROUPS: Record<ConsoleSurface, string> = {
  user: "(user)",
  admin: "(admin)",
  auth: "(auth)",
  /** `.` = 根布局下的公共页面。 */
  public: ".",
};

/** 认证页路径。 */
export const AUTH_PATHS: readonly string[] = [
  "/login",
  "/register",
  "/reset-password",
  "/forgot-password",
  "/verify-email",
];

/** admin-only 路径前缀：普通用户导航里出现任何一条都视为边界破坏 */
export const ADMIN_ONLY_PREFIXES: readonly string[] = ["/admin"];

/**
 * 内部运维概念路径（§9.4.1 要求 4）：federation / trust / grant / remote lease / audit /
 * license 等只允许出现在 Admin Console 的导航里。
 */
export const INTERNAL_CONCEPT_PREFIXES: readonly string[] = [
  "/federation",
  "/peers",
  "/trust",
  "/grants",
  "/remote-leases",
  "/leases",
  "/audit",
  "/audit-logs",
  "/license",
  "/roles",
  "/capacity",
  "/security",
  "/version",
];

/* -------------------------------------------------------------------------- */
/* User Console（§9.4.1）                                                      */
/* -------------------------------------------------------------------------- */

/** 普通用户控制台导航。/nodes 是 workspace 级节点入口，不是 Admin 节点运维页。 */
export const userConsoleNav: NavGroup[] = [
  {
    id: "overview",
    labelKey: "console.group.overview",
    labelZh: "概览",
    labelEn: "Overview",
    plain: true,
    items: [{ href: "/dashboard", labelKey: "common.dashboard", iconKey: "dashboard" }],
  },
  {
    id: "forwards",
    labelKey: "console.group.forwards",
    labelZh: "转发",
    labelEn: "Forwards",
    items: [{ href: "/forwards", labelKey: "common.forwards", iconKey: "forwards" }],
  },
  {
    id: "routes",
    labelKey: "console.group.routes",
    labelZh: "网络",
    labelEn: "Network",
    items: [
      { href: "/nodes", labelKey: "common.nodes", iconKey: "nodes" },
      {
        href: "/links", labelKey: "links.title", labelZh: "加密连接", labelEn: "Encrypted links", iconKey: "tunnels",
      },
      {
        /** 用户侧只暴露可消费的路由策略，不展示 selector / transit 等编排术语。 */
        href: "/routes",
        labelKey: "common.routingPolicies",
        labelZh: "可用路由策略",
        labelEn: "Available routing policies",
        iconKey: "tunnels",
      },
    ],
  },
  {
    id: "billing",
    labelKey: "console.group.billing",
    labelZh: "计费",
    labelEn: "Billing",
    items: [
      { href: "/plans", labelKey: "common.plans", iconKey: "plans", requiresPayments: true },
      { href: "/topup", labelKey: "common.topup", iconKey: "topup", requiresPayments: true },
    ],
  },
  {
    id: "support",
    labelKey: "console.group.support",
    labelZh: "支持",
    labelEn: "Support",
    items: [{ href: "/tickets", labelKey: "common.tickets", iconKey: "tickets" }],
  },
  {
    id: "settings",
    labelKey: "console.group.settings",
    labelZh: "设置",
    labelEn: "Settings",
    items: [
      { href: "/settings", labelKey: "common.settings", iconKey: "settings" },
      { href: "/settings/workspace", labelKey: "common.workspace", iconKey: "workspace" },
      // DDNS 切片的设置页入口：词条暂放在 `lib/ddns-i18n.ts`（与 node-*-i18n 同一约定），
      // 词典尚未收录，故带 labelZh/labelEn 回退，避免渲染成键名本身。
      {
        href: "/settings/dns",
        labelKey: "ddns.providersTitle",
        labelZh: "DNS 服务商",
        labelEn: "DNS providers",
        iconKey: "tunnels",
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Admin Console（§9.4.1）                                                     */
/* -------------------------------------------------------------------------- */

/** 管理控制台导航；Federation 等内部能力只存在于这里。 */
export const adminConsoleNav: NavGroup[] = [
  {
    id: "overview",
    labelKey: "console.group.overview",
    labelZh: "概览",
    labelEn: "Overview",
    plain: true,
    items: [{ href: "/admin", labelKey: "admin.dashboard", iconKey: "adminDashboard" }],
  },
  {
    id: "infrastructure",
    labelKey: "console.group.infrastructure",
    labelZh: "基础设施",
    labelEn: "Infrastructure",
    items: [
      { href: "/admin/nodes", labelKey: "admin.nodes", iconKey: "nodes" },
      { href: "/admin/node-groups", labelKey: "admin.nodeGroups", iconKey: "nodeGroups" },
      {
        href: "/admin/capacity",
        labelKey: "admin.capacity",
        labelZh: "容量与健康",
        labelEn: "Capacity & Health",
        iconKey: "adminDashboard",
        status: "planned",
      },
    ],
  },
  {
    id: "network",
    labelKey: "console.group.network",
    labelZh: "网络",
    labelEn: "Network",
    items: [
      { href: "/admin/tunnels", labelKey: "admin.tunnels", iconKey: "adminTunnels" },
      {
        href: "/admin/route-profiles",
        labelKey: "admin.routingPolicies",
        labelZh: "路由策略",
        labelEn: "Routing policies",
        iconKey: "tunnels",
      },
    ],
  },
  {
    id: "access",
    labelKey: "console.group.access",
    labelZh: "用户 / 空间 / 权限",
    labelEn: "Users / Workspaces / Permissions",
    items: [
      { href: "/admin/users", labelKey: "admin.users", iconKey: "users" },
      { href: "/admin/roles", labelKey: "admin.roles", iconKey: "roles" },
      {
        href: "/admin/workspaces",
        labelKey: "admin.workspaces",
        labelZh: "工作空间",
        labelEn: "Workspaces",
        iconKey: "workspace",
        status: "planned",
      },
    ],
  },
  {
    id: "commerce",
    labelKey: "console.group.commerce",
    labelZh: "商业化",
    labelEn: "Commerce",
    items: [
      { href: "/admin/plans", labelKey: "admin.plans", iconKey: "plans", requiresPayments: true },
      { href: "/admin/orders", labelKey: "admin.orders", iconKey: "orders", requiresPayments: true },
    ],
  },
  {
    id: "operations",
    labelKey: "console.group.operations",
    labelZh: "运维",
    labelEn: "Operations",
    items: [
      { href: "/admin/tickets", labelKey: "admin.tickets", iconKey: "adminTickets" },
      { href: "/admin/announcements", labelKey: "admin.announcements", iconKey: "announcements" },
      // 平台级通知渠道配置（切片 N2-UI）。词典里还没有 `admin.notificationChannels` ⇒ 用
      // labelZh/labelEn 回退（与 admin.capacity / admin.routeProfiles 同一取向：新页文案先就地，
      // 不在共享词典上收口）。权限真相在后端 RBAC（资源键 `notification_channels`）。
      {
        href: "/admin/notification-channels",
        labelKey: "admin.notificationChannels",
        labelZh: "通知渠道",
        labelEn: "Notification channels",
        iconKey: "announcements",
      },
      { href: "/admin/audit-logs", labelKey: "admin.auditLogs", iconKey: "license" },
      {
        href: "/admin/alerts",
        labelKey: "admin.alerts",
        labelZh: "告警",
        labelEn: "Alerts",
        iconKey: "adminDashboard",
        status: "planned",
      },
    ],
  },
  {
    id: "federation",
    labelKey: "console.group.federation",
    labelZh: "联邦",
    labelEn: "Federation",
    /** Federation 只属于 Admin Console。 */
    items: [
      {
        href: "/admin/federation",
        labelKey: "admin.federation.overview",
        labelZh: "联邦总览",
        labelEn: "Overview",
        iconKey: "nodeGroups",
      },
      {
        href: "/admin/federation/peers",
        labelKey: "admin.federation.peers",
        labelZh: "对等面板",
        labelEn: "Peers",
        iconKey: "adminTunnels",
      },
      {
        href: "/admin/federation/trust",
        labelKey: "admin.federation.trust",
        labelZh: "信任与密钥",
        labelEn: "Trust & Keys",
        iconKey: "roles",
      },
      {
        href: "/admin/federation/grants",
        labelKey: "admin.federation.grants",
        labelZh: "授予",
        labelEn: "Grants",
        iconKey: "license",
      },
      {
        href: "/admin/federation/remote-leases",
        labelKey: "admin.federation.remoteLeases",
        labelZh: "远端租约",
        labelEn: "Remote Leases",
        iconKey: "adminDashboard",
      },
      {
        href: "/admin/federation/usage",
        labelKey: "admin.federation.usage",
        labelZh: "联邦用量",
        labelEn: "Usage",
        iconKey: "plans",
      },
    ],
  },
  {
    id: "system",
    labelKey: "console.group.system",
    labelZh: "系统",
    labelEn: "System",
    items: [
      { href: "/admin/settings", labelKey: "admin.settings", iconKey: "settings" },
      { href: "/admin/license", labelKey: "admin.license", iconKey: "license" },
      {
        href: "/admin/security",
        labelKey: "admin.security",
        labelZh: "安全",
        labelEn: "Security",
        iconKey: "roles",
        status: "planned",
      },
      {
        href: "/admin/version",
        labelKey: "admin.version",
        labelZh: "版本",
        labelEn: "Version",
        iconKey: "adminDashboard",
        status: "planned",
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* 解析 / 过滤                                                                 */
/* -------------------------------------------------------------------------- */

/** 保守默认：未显式传入时读构建期 gate（与 V4 语义一致） */
function paymentsFlag(): boolean {
  return process.env.NEXT_PUBLIC_PAYMENTS_ENABLED === "true";
}

/**
 * 按控制台取可见分组。
 *
 * - `paymentsEnabled=false` 时剔除 `requiresPayments` 项，空分组整体消失
 *   （与 V4 行为一致：计费关闭时不出现套餐 / 充值 / 订单入口）；
 * - `includePlanned=false` 时剔除 `status:"planned"` 项（用于「可导航列表」）。
 */
export function visibleNavGroups(
  console: ConsoleId,
  opts: { paymentsEnabled?: boolean; includePlanned?: boolean } = {},
): NavGroup[] {
  const payments = opts.paymentsEnabled ?? paymentsFlag();
  const includePlanned = opts.includePlanned ?? true;
  const groups = console === "admin" ? adminConsoleNav : userConsoleNav;
  const out: NavGroup[] = [];
  for (const group of groups) {
    const items = group.items.filter((item) => {
      if (item.requiresPayments && !payments) return false;
      if (item.status === "planned" && !includePlanned) return false;
      return true;
    });
    if (items.length === 0) continue;
    out.push({ ...group, items });
  }
  return out;
}

/** 扁平化可导航项（不含 planned 禁用项）。`userNav` / `adminNav` 由它派生。 */
export function visibleNavItems(console: ConsoleId, opts: { paymentsEnabled?: boolean } = {}): NavItem[] {
  return visibleNavGroups(console, { ...opts, includePlanned: false }).flatMap((g) => g.items);
}

/**
 * 兼容导出：既有扁平侧栏列表（保持既有 gate 语义与顺序来源）。
 * 新代码请直接用 `visibleNavGroups("user" | "admin")`（分组版）。
 */
export const userNav: NavItem[] = visibleNavItems("user");
export const adminNav: NavItem[] = visibleNavItems("admin");

/** 分组标题（词典优先，缺失回落内置中英文） */
export function navGroupLabel(locale: Locale, group: NavGroup): string {
  return localizedLabel(locale, group.labelKey, group.labelZh, group.labelEn);
}

/** 规范化 pathname：去掉 query / hash / 尾斜杠（保留根路径 `/`） */
export function normalizePath(pathname: string): string {
  let p = pathname.split("?")[0].split("#")[0];
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((pre) => path === pre || path.startsWith(`${pre}/`));
}

/**
 * 路径属于哪个产品表面。**纯函数**：不读 cookie、不读 env，可直接单测。
 * 注意：这是「界面归属」，不是权限判定（授权真相在后端 RBAC）。
 */
export function consoleSurfaceForPath(pathname: string): ConsoleSurface {
  const p = normalizePath(pathname);
  if (AUTH_PATHS.includes(p)) return "auth";
  if (matchesPrefix(p, ADMIN_ONLY_PREFIXES)) return "admin";
  if (p === "/") return "public";
  return "user";
}

/** 该 href 是否 admin-only（普通用户导航里出现即为边界破坏） */
export function isAdminOnlyHref(href: string): boolean {
  return consoleSurfaceForPath(href) === "admin";
}

/** 该 href 是否触及内部运维概念（lease / trust / grant / federation / audit …） */
export function mentionsInternalConcept(href: string): boolean {
  return matchesPrefix(normalizePath(href), INTERNAL_CONCEPT_PREFIXES);
}

/**
 * 某个路径的**期望源文件路径**（相对 `web/src/app`）。
 *
 * route group 不产生 URL 段：`(user)/dashboard/page.tsx` → URL `/dashboard`。
 * 测试用它做「目录布局不改变 URL」的文件系统断言。
 */
export function expectedConsolePageFile(pathname: string): string {
  const p = normalizePath(pathname);
  const group = CONSOLE_ROUTE_GROUPS[consoleSurfaceForPath(p)];
  const rel = p === "/" ? "" : p.slice(1);
  const file = rel === "" ? "page.tsx" : `${rel}/page.tsx`;
  return group === "." ? file : `${group}/${file}`;
}

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
