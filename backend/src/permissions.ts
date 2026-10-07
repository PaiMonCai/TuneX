/**
 * RBAC 资源权限表 —— 严格复刻原版 `packages/shared/src/permissions.ts`
 * 19 个资源键 + 2 个特殊键，来源：
 * auth-rbac-source-verification-report.md §4
 */

export type PermissionLevel = "read" | "write";

export interface AdminResource {
  key: string;
  label: string;
  group: string;
  url: string;
  /** 该资源是否属于「商业授权」功能（原版 business 字段） */
  business: boolean;
  apiPrefixes: string[];
}

export const ADMIN_RESOURCES: AdminResource[] = [
  {
    key: "dashboard",
    label: "首页",
    group: "概览",
    url: "/admin",
    business: false,
    apiPrefixes: ["/admin/stats", "/admin/plan/stats", "/admin/topup/stats"],
  },
  { key: "node_groups", label: "节点组配置", group: "基础", url: "/admin/node-groups", business: false, apiPrefixes: ["/admin/node/group", "/admin/node-groups"] },
  // `/admin/node` 前缀同时覆盖 WP10 的 role/credential/pools 与 WP5 的
  // lifecycle/impact 端点（二者都注册在 node-admin.ts / node-lifecycle.ts，
  // 路径互不重叠）。因此这里**不新增** `node_lifecycle` 资源键：多一个键就
  // 多一处「谁该看到什么」的分叉，而生命周期与角色管理同属节点管理面。
  { key: "nodes", label: "节点配置", group: "基础", url: "/admin/nodes", business: false, apiPrefixes: ["/admin/node", "/admin/nodes"] },
  { key: "plans", label: "套餐配置", group: "基础", url: "/admin/plans", business: false, apiPrefixes: ["/admin/plan", "/admin/plans"] },
  { key: "plan_coupons", label: "优惠券配置", group: "财务", url: "/admin/plan_coupons", business: true, apiPrefixes: ["/admin/plan/coupon", "/admin/plan_coupons"] },
  { key: "payments", label: "支付配置", group: "财务", url: "/admin/payments", business: true, apiPrefixes: ["/admin/pay", "/admin/payments"] },
  { key: "topups", label: "充值记录", group: "财务", url: "/admin/topups", business: true, apiPrefixes: ["/admin/topup", "/admin/topups"] },
  { key: "topup_activities", label: "充值活动", group: "财务", url: "/admin/topup_activities", business: true, apiPrefixes: ["/admin/topup/activity", "/admin/topup_activities"] },
  { key: "orders", label: "购买记录", group: "财务", url: "/admin/orders", business: false, apiPrefixes: ["/admin/plan/orders", "/admin/orders"] },
  { key: "balance_logs", label: "余额记录", group: "财务", url: "/admin/balance-logs", business: false, apiPrefixes: ["/admin/user/balance/log", "/admin/balance-logs"] },
  { key: "commission_logs", label: "佣金记录", group: "推广", url: "/admin/commission-logs", business: true, apiPrefixes: ["/admin/user/commission/log", "/admin/commission-logs"] },
  { key: "withdraw", label: "提现管理", group: "推广", url: "/admin/withdraw", business: true, apiPrefixes: ["/admin/withdraw"] },
  { key: "users", label: "用户管理", group: "用户", url: "/admin/users", business: false, apiPrefixes: ["/admin/user", "/admin/users"] },
  { key: "user_plans", label: "用户套餐", group: "用户", url: "/admin/user_plans", business: false, apiPrefixes: ["/admin/user_plan", "/admin/user_plans"] },
  { key: "tunnels", label: "用户隧道", group: "用户", url: "/admin/tunnels", business: false, apiPrefixes: ["/admin/tunnel", "/admin/tunnels"] },
  { key: "tunnel_stats", label: "隧道统计", group: "用户", url: "/admin/tunnels/stats", business: false, apiPrefixes: ["/admin/tunnel/stats", "/admin/tunnels/stats"] },
  { key: "tickets", label: "工单管理", group: "用户", url: "/admin/tickets", business: true, apiPrefixes: ["/admin/ticket", "/admin/tickets"] },
  { key: "settings", label: "系统设置", group: "系统", url: "/admin/settings", business: false, apiPrefixes: ["/admin/system/config"] },
  { key: "license", label: "License 管理", group: "系统", url: "/admin/license", business: false, apiPrefixes: ["/admin/license"] },
  { key: "audit", label: "审计日志", group: "系统", url: "/admin/audit-logs", business: false, apiPrefixes: ["/admin/audit-logs"] },
  // V5-WP18.6（契约 F7）：平台公告（发布 / 撤回 / 列全部）。
  //
  // 为什么**单独**一个资源键、而不是复用 `settings`：面向全体租户的**对外内容**与站点设置
  // 是两种风险面 —— "能改站点名字"不该顺带等于"能以平台名义对所有人发布公告"。
  // 登记这一步本身就是契约 F7 的可执行形式：**未登记前缀 = 只有超管**（fail-closed），
  // 登记之后被授权的管理员角色才能用它；`tests/v5-wp18-announcement-rbac.test.mjs`
  // 显式断言"登记生效"（键可授权 / 读写得按方法分级 / 别的资源键仍然拦得住）。
  // 租户侧的公告走的是**既有** `settings:read` / `settings:manage`（不新增租户权限键）。
  { key: "announcements", label: "公告管理", group: "运营", url: "/admin/announcements", business: false, apiPrefixes: ["/admin/announcements"] },
  // V5.5 WP14：联邦（Panel↔Panel 信任 / 授予 / 远端租约 / 用量）。
  // 只属于 Admin Console：普通用户永远看不到 trust / grant / lease 概念（§9.4.1）。
  // 用独立的资源键而不是挂到 "nodes" 上：联邦是跨安装的安全边界，
  // 「能看节点」与「能建立跨面板信任」不该是同一种授权。
  { key: "federation", label: "联邦", group: "联邦", url: "/admin/federation", business: false, apiPrefixes: ["/admin/federation"] },
  // 专项切片 N2（退出条件 #6）：**平台级**通知渠道配置（telegram bot token / webhook 端点）。
  //
  // 为什么单独一个资源键、而不是复用 `settings` 或 `announcements`：这里的写操作会把**出站凭据**
  // 落进 `notification_channel.secret_enc`（封装后的 bot token）与 webhook URL（URL 本身就是凭据）。
  // "能改站点名字"（settings）或"能以平台名义发公告"（announcements）都不该顺带等于
  // "能配置平台往哪儿发、用谁的凭据发"。
  // 登记这一步本身就是纪律的可执行形式：**未登记前缀 = 只有超管**（`adminPermissionGuard` 的
  // fail-closed 分支，见 permissions.ts 的 `resolveAdminRoute`），登记之后被授权的管理员角色才能用它。
  // 测试 `src/routes/__tests__/notification-channels.test.ts` 用**真实中间件**断言了这一变化：
  // 持该键 read 只能 GET、write 才能 PUT/DELETE，别的资源键仍然被挡在 403。
  { key: "notification_channels", label: "通知渠道配置", group: "系统", url: "/admin/notification-channels", business: false, apiPrefixes: ["/admin/notification-channels"] },
];

export const ADMIN_RESOURCE_KEYS: string[] = ADMIN_RESOURCES.map((r) => r.key);

export const STAFF_SHARED_PREFIXES = ["/admin/node/group/summary"];
export const STAFF_SHARED_KEY = "$staff";
export const SUPER_ADMIN_KEY = "$super";

export function isAdminResourceKey(key: string): boolean {
  return ADMIN_RESOURCE_KEYS.includes(key);
}

interface RouteEntry {
  prefix: string;
  key: string;
}

/** 路由表：按 prefix 长度降序（最长前缀优先，保证 /admin/plan/coupon 先于 /admin/plan） */
function buildAdminRouteTable(): RouteEntry[] {
  const table: RouteEntry[] = [];
  for (const resource of ADMIN_RESOURCES) {
    for (const prefix of resource.apiPrefixes) table.push({ prefix, key: resource.key });
  }
  for (const prefix of STAFF_SHARED_PREFIXES) table.push({ prefix, key: STAFF_SHARED_KEY });
  table.push({ prefix: "/admin/role", key: SUPER_ADMIN_KEY });
  return table.sort((a, b) => b.prefix.length - a.prefix.length);
}

const ADMIN_ROUTE_TABLE = buildAdminRouteTable();

function prefixMatches(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/** 路径 → 资源 key；未登记返回 undefined（fail-closed） */
export function resolveAdminRoute(path: string): RouteEntry | undefined {
  return ADMIN_ROUTE_TABLE.find((e) => prefixMatches(path, e.prefix));
}

/** 前端菜单高亮：最长 url 优先 */
export function resolveResourceByUrl(pathname: string): AdminResource | undefined {
  let matched: AdminResource | undefined;
  for (const resource of ADMIN_RESOURCES) {
    if (prefixMatches(pathname, resource.url)) {
      if (!matched || resource.url.length > matched.url.length) matched = resource;
    }
  }
  return matched;
}

export function requiredLevel(method: string): PermissionLevel {
  return method === "GET" || method === "HEAD" ? "read" : "write";
}

export function levelSatisfies(granted: PermissionLevel, required: PermissionLevel): boolean {
  return granted === "write" || granted === required;
}

export interface AdminRoleLike {
  id?: number;
  name?: string;
  permissions: unknown;
}

export interface AccessUserLike {
  super_admin: boolean;
  admin_roles?: AdminRoleLike[] | null;
}

/**
 * 多角色权限合并：write 优先，read 不降级；super_admin 全量 write。
 * 与原版语义一致（顺序无关）。
 */
export function getEffectiveAccess(user: AccessUserLike | null | undefined): Map<string, PermissionLevel> {
  const access = new Map<string, PermissionLevel>();

  if (user?.super_admin) {
    for (const key of ADMIN_RESOURCE_KEYS) access.set(key, "write");
    return access;
  }

  for (const role of user?.admin_roles ?? []) {
    const perms = role?.permissions;
    if (!perms || typeof perms !== "object" || Array.isArray(perms)) continue; // 脏数据防御
    for (const [key, level] of Object.entries(perms as Record<string, unknown>)) {
      if (!isAdminResourceKey(key)) continue; // 未知 key 丢弃
      if (level === "write") access.set(key, "write");
      else if (level === "read" && access.get(key) !== "write") access.set(key, "read");
    }
  }
  return access;
}

/** 角色权限入库前的白名单过滤（防注入任意 key） */
export function sanitizePermissions(input: unknown): Record<string, PermissionLevel> {
  const result: Record<string, PermissionLevel> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [key, level] of Object.entries(input as Record<string, unknown>)) {
    if (!isAdminResourceKey(key)) continue;
    if (level === "read" || level === "write") result[key] = level;
  }
  return result;
}
