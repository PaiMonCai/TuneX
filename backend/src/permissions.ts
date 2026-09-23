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
