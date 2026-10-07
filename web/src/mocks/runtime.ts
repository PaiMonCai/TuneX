/**
 * 手写 mock 路由：签名与真实后端 REST 契约一一对应。
 * 前端只依赖 (method, path, query, body, cookie) → { status, body }，
 * 因此将来把 src/lib/api.ts 的 API_MOCK 分支删掉即可切到真后端，页面零改动。
 *
 * 状态：所有读写都走 ./state 的进程内单例（globalThis 挂载）。
 * 原先直接改 `data.ts` 导出的模块级数组，Next.js 会把同一份源码打进多个 bundle
 * （服务端组件 / 客户端组件 / HMR 重载），模块被重新求值后模块级变量会被重置，
 * 于是「上一条请求新建的隧道」在下一条请求里消失。挂到 globalThis 后，
 * create/update/delete 的结果在同一次 dev/build 运行期间持续可见。
 */
import type {
  AdminRole,
  AttentionItem,
  AttentionReasonCode,
  AttentionSummary,
  BillingCycle,
  BalanceLog,
  EgressPool,
  EgressTarget,
  ID,
  LBStrategy,
  ListQuery,
  Node,
  NodeCredentialIssued,
  NodeCredentialRevoked,
  NodeEnrollmentIssued,
  NodeBinding,
  NodeGroup,
  NodeType,
  Plan,
  PlanOrder,
  PortForward,
  Ticket,
  TicketReply,
  TopupOrder,
  TrafficPoint,
  Tunnel,
  TunnelEgressPoolOption,
  TunnelMode,
  TunnelRuntimeAction,
  User,
  UserNode,
  UserPlan,
  Workspace,
  WorkspaceInvite,
  WorkspaceMember,
  WorkspaceRole,
  WorkspaceTrafficSummary,
} from "@/lib/types";
import * as seed from "./data";
// V5.2 §7：目标健康视图的契约镜像（状态/理由码的 closed set 与展示派生都在那一处）。
import { poolTargetKey } from "@/lib/target-health";
import type {
  TargetHealthTargetView,
  TargetPoolHealth,
} from "@/lib/target-health";
import { getStore, resetStore, type MockNodeBinding, type MockWorkspaceInvite } from "./state";
// V5.5：联邦 mock（自包含实现 + 错误码镜像）；路由分发在下面 admin 分支的 federation 段。
import { handleFederationMock } from "./federation";
// V5.5/WP13.5B：线路模板 mock（自包含实现 + 错误码镜像）；路由分发见下面的 route-profiles 段。
import { handleRouteProfileMock } from "./route-profiles";
// V4-WP6 §13.4.4：health 投影（mock 无法 import 后端，形状与规则镜像在这里）
import {
  mockFleetHealth,
  mockNodeHealth,
  mockResolveNode,
  type MockHealthWorld,
} from "./node-health";
import {
  MOCK_LIFECYCLES,
  MOCK_LIFECYCLE_NOTE_MAX,
  mockAllowedTransitions,
  mockCanTransition,
  mockDeleteGates,
  mockImpact,
  mockLifecycleChange,
  mockLifecycleOf,
  mockLifecycleView,
  mockRoleCheck,
  mockUserNodeStatus,
  type MockImpactWorld,
} from "./node-lifecycle";
import {
  applyMockForwardPatch,
  injectMockForwardView,
  previewMockForwardUpdate,
} from "./forward-edit";
// V4-WP8：可重试结论**复用** `lib/forward-status.ts` 的 `applyErrorIsRetryable`。
// 那是本项目里对后端 `scheduler.ts` 的 `RETRYABLE` 集合的**唯一**镜像，且由
// `components/forwards/__tests__/wp8-forward-status.test.ts` 直接读后端源码做集合断言。
// mock 里再抄一份「哪些码可重试」就是第三份判据 —— 报告 N1 记的正是这种形态。
import { applyErrorIsRetryable } from "@/lib/forward-status";
// V5-WP5-A1：协议契约（白名单 + tls 路径规则）只保留**一份**实现。
// mock 无法 import 后端，因此复用前端的契约镜像（与 `forward-status` 同一处理方式），
// 而不是在 mock 里再抄一遍 `["tcp","tls","ws"]` —— 抄一份就是第三处白名单。
import {
  DEFAULT_FORWARD_PROTOCOL,
  forwardProtocolFact,
  forwardProtocolSupported,
  isForwardProtocol,
  tlsPathFieldErrors,
  type ForwardProtocol,
} from "@/lib/forward-protocol";
import type { ForwardPatchInput } from "@/lib/types";
import { mockEffectivePermissions, mockBasePermissions, mockGrantSubset, validMockRolePermissions } from "./workspace-permissions";

/**
 * V5-WP5-A1：`lib/forward-protocol.ts` 的预检 key → 人话错误体。
 *
 * 后端对应文案在 `forward-contract.ts` 的 `tlsPathsForProtocol`（reason 字段）。
 * mock 需要一个可直接显示的 message（toast 会照原样画出来），所以这里做一次映射，
 * 而不是把 i18n key 当错误信息发出去。
 */
export const TLS_PATH_ERROR_MESSAGES: Record<string, string> = {
  "forward.tlsPathRequired": "tls 转发必须提供证书与私钥路径",
  "forward.tlsPathAbsolute": "证书/私钥路径必须是节点本地绝对路径",
  "forward.tlsPathTooLong": "证书/私钥路径不能超过 512 个字符",
  "forward.tlsPathNotAllowed": "只有 tls 转发可以携带证书/私钥路径",
};

// forward-edit.ts 需要 handler 的 forward 投影（避免反向依赖），在这里注入一次。
injectMockForwardView((_db, tunnel) => mockForwardView(_db, tunnel));

export interface MockRequest {
  body?: unknown;
  query?: ListQuery;
  cookie?: string;
  workspaceId?: number;
}

export interface MockResponse {
  status: number;
  body: unknown;
}

export const SESSION_COOKIE = "tunex_session";
export const GB = 1024 * 1024 * 1024;

/** 会话 cookie 值：`u<id>` 指定用户；用 id 而非邮箱，避免用户改邮箱后会话失效 */
export function sessionCookieValue(userId: number): string {
  return `${SESSION_COOKIE}=u${userId}; Path=/; Max-Age=${60 * 60 * 12}; SameSite=Lax`;
}

export const CYCLE_DAYS: Record<BillingCycle, number> = {
  month: 30,
  quarter: 90,
  half_year: 180,
  year: 365,
  lifetime: 36500,
};

/** 优惠码（演示用） */
export const COUPONS: Record<string, { type: "percent" | "amount"; value: number }> = {
  TUNEX10: { type: "percent", value: 10 },
  TUNEX50: { type: "amount", value: 50 },
};

/**
 * 权限元数据（镜像 backend/src/permissions.ts 的 ADMIN_RESOURCES）。
 * mock 只用于渲染角色编辑器的资源清单，键必须与后端一致。
 */
export const ADMIN_RESOURCES: { key: string; label: string; group: string; url: string; business: boolean }[] = [
  { key: "dashboard", label: "首页", group: "概览", url: "/admin", business: false },
  { key: "node_groups", label: "节点组配置", group: "基础", url: "/admin/node-groups", business: false },
  { key: "nodes", label: "节点配置", group: "基础", url: "/admin/nodes", business: false },
  { key: "plans", label: "套餐配置", group: "基础", url: "/admin/plans", business: false },
  { key: "plan_coupons", label: "优惠券配置", group: "财务", url: "/admin/plan-coupons", business: true },
  { key: "payments", label: "支付配置", group: "财务", url: "/admin/payments", business: true },
  { key: "topups", label: "充值记录", group: "财务", url: "/admin/topups", business: true },
  { key: "topup_activities", label: "充值活动", group: "财务", url: "/admin/topup-activities", business: true },
  { key: "orders", label: "购买记录", group: "财务", url: "/admin/orders", business: false },
  { key: "balance_logs", label: "余额记录", group: "财务", url: "/admin/balance-logs", business: false },
  { key: "commission_logs", label: "佣金记录", group: "推广", url: "/admin/commission-logs", business: true },
  { key: "withdraw", label: "提现管理", group: "推广", url: "/admin/withdraw", business: true },
  { key: "users", label: "用户管理", group: "用户", url: "/admin/users", business: false },
  { key: "user_plans", label: "用户套餐", group: "用户", url: "/admin/user-plans", business: false },
  { key: "tunnels", label: "用户隧道", group: "用户", url: "/admin/tunnels", business: false },
  { key: "tunnel_stats", label: "隧道统计", group: "用户", url: "/admin/tunnels/stats", business: false },
  { key: "tickets", label: "工单管理", group: "用户", url: "/admin/tickets", business: true },
  { key: "settings", label: "系统设置", group: "系统", url: "/admin/settings", business: false },
  { key: "license", label: "License 管理", group: "系统", url: "/admin/license", business: false },
  { key: "audit", label: "审计日志", group: "系统", url: "/admin/audit-logs", business: false },
];
export const ADMIN_RESOURCE_KEYS = ADMIN_RESOURCES.map((r) => r.key);

/** 角色权限入库前清洗：仅保留已知 key 且值为 read/write */
export function sanitizePermissions(input: unknown): Record<string, "read" | "write"> {
  const result: Record<string, "read" | "write"> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (ADMIN_RESOURCE_KEYS.includes(k) && (v === "read" || v === "write")) result[k] = v;
  }
  return result;
}

/** 新建充值单后多久自动「收到支付回调」（毫秒），0 表示关闭自动结算 */
export const TOPUP_AUTO_SETTLE_MS = (() => {
  if (typeof process === "undefined" || !process.env) return 15000;
  return Number(process.env.MOCK_TOPUP_AUTO_SETTLE_MS ?? 15000);
})();

export type Store = ReturnType<typeof getStore>;

// ---------------------------------------------------------------- 基础工具

export const nowIso = () => new Date().toISOString();

export function ok(body: unknown): MockResponse {
  return { status: 200, body };
}
export function fail(status: number, message: string, code?: string, data?: unknown): MockResponse {
  return { status, body: { message, ...(code ? { code } : {}), ...(data ? { data } : {}) } };
}
export function badRequest(message: string, code = "VALIDATION_ERROR"): MockResponse {
  return fail(400, message, code);
}
export function notFound(message: string): MockResponse {
  return fail(404, message, "NOT_FOUND");
}

/**
 * V4-WP7：错误体把 extras 放在**顶层**。
 *
 * 后端 `routes/node-lifecycle.ts` 的拒绝响应形状是
 * `{ error, message, code, condition?, dependencies? }`（condition 与
 * dependencies 与 code 平级）。通用 `fail()` 会把 extras 塞进 `data`，
 * 于是 UI 读 `ApiError.data.condition` 在 mock 模式下拿不到值——错误码
 * 退化成一视同仁的「操作失败」，正好破坏 §13.5「可区分错误码」的要求。
 * 新增端点用本函数保持与真实后端同形；不改 `fail()`（大量既有调用方依赖
 * 它的 `data` 嵌套）。
 */
export function failFlat(
  status: number,
  message: string,
  code: string,
  extras: Record<string, unknown> = {},
): MockResponse {
  return { status, body: { error: message, message, code, ...extras } };
}

export function isLoggedIn(cookie?: string): boolean {
  return !!cookie && new RegExp(`${SESSION_COOKIE}=`).test(cookie);
}

/** 会话 cookie 支持 `u<id>` 指定用户（便于多账号演示），否则映射到 demo 用户 */
export function userFromCookie(db: Store, cookie?: string): User {
  const m = cookie ? new RegExp(`${SESSION_COOKIE}=u(\\d+)`).exec(cookie) : null;
  if (m) {
    const found = db.users.find((u) => u.id === Number(m[1]));
    if (found) return found;
  }
  return db.user;
}

export function paginate<T>(items: T[], query?: ListQuery) {
  const page = Math.max(1, Number(query?.page ?? 1) || 1);
  const page_size = Math.min(200, Math.max(1, Number(query?.page_size ?? 20) || 20));
  const start = (page - 1) * page_size;
  return { data: items.slice(start, start + page_size), total: items.length, page, page_size };
}

/**
 * V4-WP9 §13.6：Forward 列表的服务端排序口径（mock 版）。
 *
 * 与后端 `services/forward-list-query.ts` 的 `FORWARD_SORT_COLUMNS` 一一对应：
 *   · 白名单外的 sort 键回落 `order_by`（不报错，也不产出未定义列名）；
 *   · 永远追加 `id desc` 兜底，让分页稳定（同名行不会在两页间跳动）；
 *   · `order` 只认 asc/desc。
 * 保持两份实现是 mock 的固有代价，因此这里的取值刻意写成与后端同名的映射表，
 * 差异一眼可见；契约测试（forward-scale.test.ts）钉住两者的可见行为。
 */
export const MOCK_FORWARD_SORT_FIELDS: Record<string, keyof PortForward> = {
  order_by: "listen_port",
  name: "name",
  status: "apply_status",
  mode: "mode",
  listen_port: "listen_port",
  traffic: "traffic",
  created_at: "created_at",
  updated_at: "updated_at",
};

export function sortMockForwards(
  rows: PortForward[],
  sort: string | undefined,
  order: string | undefined,
): PortForward[] {
  const key = sort?.trim().toLowerCase() ?? "";
  const field = MOCK_FORWARD_SORT_FIELDS[key] ?? "listen_port";
  const direction = order?.trim().toLowerCase() === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    let cmp: number;
    if (typeof av === "number" && typeof bv === "number") {
      cmp = av - bv;
    } else {
      cmp = String(av ?? "").localeCompare(String(bv ?? ""));
    }
    if (cmp !== 0) return cmp * direction;
    // id desc 兜底：分页稳定性依赖它（与后端 orderBy 的第二项一致）。
    return Number(b.id) - Number(a.id);
  });
}

/** 关键字过滤：接受任意实体数组（Prisma 模型无索引签名，内部按 record 取值） */
export function filterByKeyword<T extends object>(items: T[], query: ListQuery | undefined, keys: string[]): T[] {
  const kw = String(query?.keyword ?? "").trim().toLowerCase();
  if (!kw) return items;
  return items.filter((it) =>
    keys.some((k) => String((it as Record<string, unknown>)[k] ?? "").toLowerCase().includes(kw)),
  );
}

export function filterByStatus<T extends object>(items: T[], query?: ListQuery): T[] {
  const s = query?.status;
  if (!s || s === "all") return items;
  return items.filter((it) => String((it as Record<string, unknown>).status ?? "") === s);
}

export function nextId(items: { id: number }[]): number {
  return items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}

export function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function reqStr(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

/** 数字解析：空 / 非法 → null */
export function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 必填数字：空 / 非法 → undefined */
export function reqNum(v: unknown): number | undefined {
  const n = numOrNull(v);
  return n === undefined || n === null ? undefined : n;
}

/** 必填字符串 */
export function required(
  body: Record<string, unknown>,
  key: string,
  label: string,
  max = 200,
): { value: string } | MockResponse {
  const v = reqStr(body[key]);
  if (!v) return badRequest(`${label}不能为空`);
  if (v.length > max) return badRequest(`${label}长度不能超过 ${max} 字符`);
  return { value: v };
}

/** 收集请求体里出现过的键（区分「未传」与「显式传 null」） */
export function pick<T extends object>(body: Record<string, unknown>, keys: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in body) out[k] = body[k];
  return out as Partial<T>;
}

/** 字符串数组字段：接受数组或逗号/换行分隔的字符串；空值 → null */
export function parseList(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v).trim();
  if (!s) return null;
  return s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function isResponse(x: unknown): x is MockResponse {
  return (
    !!x && typeof x === "object" && "status" in (x as Record<string, unknown>) && "body" in (x as Record<string, unknown>)
  );
}

export function parseId(seg: string | undefined): number | null {
  return seg && /^\d+$/.test(seg) ? Number(seg) : null;
}

export const groupRef = (db: Store, id: number | null | undefined): Pick<NodeGroup, "id" | "name" | "node_type"> | undefined => {
  if (!id) return undefined;
  const g = db.nodeGroups.find((x) => x.id === id);
  return g ? { id: g.id, name: g.name, node_type: g.node_type } : undefined;
};

export function withGroupStats<T extends NodeGroup>(db: Store, g: T): T {
  const nodes = db.nodes.filter((n) => n.node_group_id === g.id);
  return { ...g, node_count: nodes.length, online_node_count: nodes.filter((n) => n.online).length };
}

/**
 * 隧道流量序列：由隧道累计流量确定性派生（同一隧道每次返回一致，便于断言）。
 * 与 /dashboard/traffic 的返回结构一致：字节数 + 计费流量（GB）。
 */
export function tunnelTrafficSeries(tunnelId: number, totalBytes: number, days: number): TrafficPoint[] {
  const gbTotal = totalBytes / GB;
  const out: TrafficPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const wave = 0.6 + Math.abs(Math.sin((tunnelId + 1) * 1.3 + i * 0.9)) * 0.8;
    const dailyGb = Number(((gbTotal / days) * wave).toFixed(3));
    out.push({
      date: new Date(seed.now.getTime() - i * 86400000).toISOString().slice(0, 10),
      traffic: Math.round(dailyGb * GB),
      traffic_cost: dailyGb,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 结算/记账

export function creditBalance(db: Store, user: User, amount: number, type: BalanceLog["type"]): BalanceLog {
  user.balance = Number((user.balance + amount).toFixed(2));
  user.updated_at = nowIso();
  const log: BalanceLog = {
    id: nextId(db.balanceLogs),
    user_id: user.id,
    balance: user.balance,
    amount: Number(amount.toFixed(2)),
    type,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.balanceLogs.unshift(log);
  return log;
}

/** 把 pending 充值单置为成功并加余额（模拟支付网关回调） */
export function settleTopup(db: Store, order: TopupOrder): TopupOrder {
  if (order.status !== "pending") return order;
  const user = db.users.find((u) => u.id === order.user_id);
  order.status = "success";
  order.trade_id = `${Date.now()}${Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, "0")}`;
  order.balance = Number((order.price + order.bonus).toFixed(2));
  order.updated_at = nowIso();
  if (user) creditBalance(db, user, order.balance, "topup");
  return order;
}

/** 懒结算：GET /topups 时把「创建后超过阈值仍是 pending」的单子自动结算，模拟回调 */
export function autoSettleTopups(db: Store) {
  if (!(TOPUP_AUTO_SETTLE_MS > 0)) return;
  const deadline = Date.now() - TOPUP_AUTO_SETTLE_MS;
  for (const o of db.topupOrders) {
    if (o.status !== "pending") continue;
    const created = Date.parse(o.created_at);
    if (Number.isFinite(created) && created <= deadline) settleTopup(db, o);
  }
}

export function payUrlFor(order_id: string, payment: { method: string; url: string }): string {
  const trade = Math.random().toString(36).slice(2, 14);
  switch (payment.method) {
    case "bepusdt":
      return `https://bepusdt.example.com/pay/${trade}?order_id=${order_id}`;
    case "heleket":
      return `https://heleket.com/pay/${trade}?order=${order_id}`;
    default:
      return `https://pay.example.com/pay/submit/${trade}?out_trade_no=${order_id}`;
  }
}

/** 充值单号：TU + yyyyMMdd + 4 位序号 */
export function topupOrderNo(db: Store): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const today = db.topupOrders.filter((o) => o.order_id.startsWith(`TU${ymd}`)).length + 1;
  return `TU${ymd}${String(today).padStart(4, "0")}`;
}

// ---------------------------------------------------------------- 统计

export function dashboardStats(db: Store, user: User) {
  const plan = db.userPlans.find((p) => p.user_id === user.id) ?? null;
  const planDef = plan ? db.plans.find((p) => p.id === plan.plan_id) ?? null : null;
  const tunnels = db.tunnels.filter((t) => t.user_id === user.id);
  const points = seed.mockTrafficPoints;
  return {
    balance: user.balance,
    commission_balance: user.commission_balance,
    tunnel_count: tunnels.length,
    max_tunnels: plan?.max_tunnels ?? null,
    traffic_used: plan?.traffic_used ?? 0,
    traffic_limit: plan?.traffic ?? null,
    plan_name: planDef?.name ?? null,
    expired_at: plan?.expired_at ?? null,
    active_nodes: db.nodes.filter((n) => n.online).length,
    total_nodes: db.nodes.length,
    today_traffic: points[points.length - 1]?.traffic ?? 0,
    month_traffic: plan?.traffic_used ?? 0,
  };
}

export function adminStats(db: Store) {
  return {
    user_count: db.users.length,
    tunnel_count: db.tunnels.length,
    node_count: db.nodes.length,
    online_node_count: db.nodes.filter((n) => n.online).length,
    order_count: db.planOrders.length + db.topupOrders.length,
    pending_topup_count: db.topupOrders.filter((o) => o.status === "pending").length,
    open_ticket_count: db.tickets.filter((t) => t.status === "open").length,
    total_balance: Number(db.users.reduce((s, u) => s + u.balance, 0).toFixed(2)),
    today_revenue: Number(
      db.topupOrders
        .filter((o) => o.status === "success" && o.created_at.slice(0, 10) === nowIso().slice(0, 10))
        .reduce((s, o) => s + o.price, 0)
        .toFixed(2),
    ),
    today_traffic: seed.mockTrafficPoints[seed.mockTrafficPoints.length - 1]?.traffic ?? 0,
    tunnel_type_distribution: ["tcp", "mtcp", "udp", "tunex", "mtls", "mwss", "wss", "tls", "quic"].map((type) => ({
      type,
      count: db.tunnels.filter((t) => t.tunnel_type === type).length,
    })),
    revenue_trend: seed.mockTrafficPoints.map((p, i) => ({
      date: p.date,
      amount: Number((60 + Math.abs(Math.cos(i * 1.3)) * 240).toFixed(2)),
    })),
  };
}

// ---------------------------------------------------------------- 载荷校验

/** 套餐载荷解析（POST/PUT /admin/plans[/id] 共用，partial=true 时只校验出现的字段） */
export function readPlanPayload(
  db: Store,
  body: Record<string, unknown>,
  partial: boolean,
): { patch: Partial<Plan> } | MockResponse {
  const patch: Partial<Plan> = {};

  if (!partial || body.name !== undefined) {
    const r = required(body, "name", "套餐名称", 60);
    if (isResponse(r)) return r;
    patch.name = r.value;
  }
  if (!partial || body.price !== undefined) {
    const price = reqNum(body.price);
    if (price === undefined) return badRequest("价格必须是数字");
    if (price < 0) return badRequest("价格不能为负数");
    patch.price = price;
  }
  if (body.description !== undefined) patch.description = reqStr(body.description) || null;
  if (body.original_price !== undefined) patch.original_price = numOrNull(body.original_price);
  if (body.max_tunnels !== undefined) patch.max_tunnels = numOrNull(body.max_tunnels);
  if (body.traffic !== undefined) patch.traffic = numOrNull(body.traffic);
  if (body.ip_limit !== undefined) patch.ip_limit = numOrNull(body.ip_limit);
  if (body.client_limit !== undefined) patch.client_limit = numOrNull(body.client_limit);
  if (body.bandwidth_limit !== undefined) patch.bandwidth_limit = numOrNull(body.bandwidth_limit);
  if (body.whitelist_limit !== undefined) patch.whitelist_limit = numOrNull(body.whitelist_limit);
  if (body.setup_fee !== undefined) patch.setup_fee = numOrNull(body.setup_fee);
  if (body.order_by !== undefined) patch.order_by = numOrNull(body.order_by) ?? patch.order_by;
  if (body.stock !== undefined) {
    const stock = numOrNull(body.stock);
    if (stock !== null && stock < 0) return badRequest("库存不能为负数");
    patch.stock = stock;
  }
  if (body.billing_cycle !== undefined) {
    const cycle = reqStr(body.billing_cycle) as BillingCycle;
    if (!Object.prototype.hasOwnProperty.call(CYCLE_DAYS, cycle)) return badRequest("账单周期不合法");
    patch.billing_cycle = cycle;
  }
  if (body.status !== undefined) {
    const status = reqStr(body.status);
    if (status !== "active" && status !== "inactive") return badRequest("状态不合法");
    patch.status = status;
  }
  for (const key of [
    "renewable",
    "allow_custom_in_node_group",
    "allow_custom_out_node_group",
    "all_in_node_groups",
    "all_out_node_groups",
  ] as const) {
    if (body[key] !== undefined) patch[key] = Boolean(body[key]);
  }
  if (body.node_group_ids !== undefined) {
    const ids = Array.isArray(body.node_group_ids) ? body.node_group_ids.map(Number) : [];
    const missing = ids.find((id) => !db.nodeGroups.some((g) => g.id === id));
    if (missing !== undefined) return badRequest(`节点组 ${missing} 不存在`);
    patch.node_groups = ids
      .map((id) => db.nodeGroups.find((g) => g.id === id))
      .filter((g): g is NodeGroup => !!g)
      .map((g) => ({ id: g.id, name: g.name }));
  }
  return { patch };
}

export function readNodeGroupPayload(
  db: Store,
  body: Record<string, unknown>,
  partial: boolean,
  /** 编辑时传入自身 id：Token 唯一性校验必须排除自己，否则「不改 Token 直接保存」会误报重复 */
  selfId?: ID,
): { patch: Partial<NodeGroup> } | MockResponse {
  const patch: Partial<NodeGroup> = {};

  if (!partial || body.name !== undefined) {
    const r = required(body, "name", "节点组名称", 60);
    if (isResponse(r)) return r;
    patch.name = r.value;
  }
  if (!partial || body.node_type !== undefined) {
    const type = reqStr(body.node_type) as NodeType;
    if (type !== "in" && type !== "out") return badRequest("节点类型必须是 in 或 out");
    patch.node_type = type;
  }
  if (body.token !== undefined || !partial) {
    const token = reqStr(body.token) || `ng_${Math.random().toString(36).slice(2, 10)}`;
    if (!/^[a-zA-Z0-9_-]{3,64}$/.test(token)) return badRequest("Token 只允许字母、数字、下划线和连字符（3-64 位）");
    if (db.nodeGroups.some((g) => g.token === token && g.id !== selfId)) return badRequest("Token 已存在");
    patch.token = token;
  }
  if (body.connect_ip !== undefined) patch.connect_ip = reqStr(body.connect_ip) || null;
  if (body.port_range !== undefined) patch.port_range = reqStr(body.port_range) || null;
  if (body.load_balance_type !== undefined) {
    patch.load_balance_type = (reqStr(body.load_balance_type) || "round") as NodeGroup["load_balance_type"];
  }
  if (body.traffic_rate !== undefined) {
    const rate = numOrNull(body.traffic_rate);
    if (rate === null || rate < 0) return badRequest("流量倍率不合法");
    patch.traffic_rate = rate;
  }
  if (body.order_by !== undefined) patch.order_by = numOrNull(body.order_by) ?? 0;
  if (body.bypass_type !== undefined) {
    const t = reqStr(body.bypass_type);
    if (t !== "whitelist" && t !== "blacklist") return badRequest("bypass_type 不合法");
    patch.bypass_type = t;
  }
  for (const key of ["allow_listen_protocol", "admission", "need_out_node_group"] as const) {
    if (body[key] !== undefined) patch[key] = Boolean(body[key]);
  }
  if (body.allow_listen_protocols !== undefined) patch.allow_listen_protocols = parseList(body.allow_listen_protocols);
  if (body.allow_tunnel_types !== undefined) {
    patch.allow_tunnel_types = parseList(body.allow_tunnel_types) as NodeGroup["allow_tunnel_types"];
  }
  if (body.bypass_list !== undefined) patch.bypass_list = parseList(body.bypass_list);
  if (body.block_protocols !== undefined) patch.block_protocols = parseList(body.block_protocols);
  for (const key of ["allow_out_node_groups", "allow_in_node_groups"] as const) {
    if (body[key] !== undefined) {
      patch[key] = body[key] === null || body[key] === undefined ? null : Array.isArray(body[key]) ? body[key].map(Number) : null;
    }
  }
  return { patch };
}

export function readNodePayload(
  db: Store,
  body: Record<string, unknown>,
  partial: boolean,
  /** 编辑时传入自身 id：节点 ID 唯一性校验须排除自己，否则「不改节点 ID 直接保存」会误报重复 */
  selfId?: ID,
): { patch: Partial<Node> } | MockResponse {
  const patch: Partial<Node> = {};

  if (!partial || body.node_id !== undefined) {
    const r = required(body, "node_id", "节点 ID", 64);
    if (isResponse(r)) return r;
    if (db.nodes.some((n) => n.node_id === r.value && n.id !== selfId)) return badRequest("节点 ID 已存在");
    patch.node_id = r.value;
  }
  if (!partial || body.node_group_id !== undefined) {
    const gid = numOrNull(body.node_group_id);
    if (gid === null) return badRequest("必须指定节点组");
    const g = db.nodeGroups.find((x) => x.id === gid);
    if (!g) return notFound("节点组不存在");
    patch.node_group_id = g.id;
    patch.node_group = { id: g.id, name: g.name, node_type: g.node_type };
  }
  if (!partial || body.connect_ip !== undefined) {
    const r = required(body, "connect_ip", "连接 IP", 64);
    if (isResponse(r)) return r;
    patch.connect_ip = r.value;
  }
  if (body.weight !== undefined) {
    const w = numOrNull(body.weight);
    if (w === null || w < 0) return badRequest("权重不合法");
    patch.weight = w;
  }
  if (body.status !== undefined) {
    const s = reqStr(body.status);
    if (s !== "active" && s !== "inactive") return badRequest("状态不合法");
    patch.status = s;
  }
  if (body.version !== undefined) patch.version = reqStr(body.version) || "1.0.0";
  if (body.custom_line !== undefined) patch.custom_line = reqStr(body.custom_line) || null;
  if (body.order_by !== undefined) patch.order_by = numOrNull(body.order_by) ?? 0;
  // v3 角色三元：ingress / egress / both；「未声明」是 null 而非默认值——
  // mock 必须与 schema 一致：显式 null 就是 null，不能偷偷填 ingress。
  if (body.role !== undefined) {
    if (body.role === null) {
      patch.role = null;
    } else {
      const r = reqStr(body.role);
      if (r !== "ingress" && r !== "egress" && r !== "both") return badRequest("节点角色不合法");
      patch.role = r;
    }
  }
  if (body.port_range_min !== undefined) patch.port_range_min = numOrNull(body.port_range_min);
  if (body.port_range_max !== undefined) patch.port_range_max = numOrNull(body.port_range_max);
  if (body.lb_strategy !== undefined) {
    if (body.lb_strategy === null) {
      patch.lb_strategy = null;
    } else {
      const s = reqStr(body.lb_strategy);
      if (s !== "round" && s !== "rand") return badRequest("出口策略不合法");
      patch.lb_strategy = s;
    }
  }
  for (const key of ["backup", "dns_status"] as const) {
    if (body[key] !== undefined) patch[key] = Boolean(body[key]);
  }
  return { patch };
}

/**
 * V5.2 §7：池的目标健康响应（**mock 侧**）。
 *
 * 这里只做三件事，都不属于「合成」：
 *   1. 期望清单 → 行集（顺序照期望；没夹具 → 契约事实「没有证据」）；
 *   2. 夹具里的 `age_ms` → `last_observed_at` 时间戳（按本次请求时刻回填，
 *      否则种子写死的日期会让一切在演示里显得过期）；
 *   3. `observers`（响应级）= 本次真的参与观测的节点 id 升序去重。
 *
 * 真实状态由 `backend/src/services/target-health.ts` 合成；mock 复制的是**结论**，
 * 不是规则（复制阈值表必然与后端分叉）。
 */
export function mockPoolTargetHealth(
  desired: readonly { host: string; port: number }[],
  fixtures: readonly TargetHealthTargetView[],
  now: number,
): TargetPoolHealth {
  const byTarget = new Map(fixtures.map((row) => [row.target, row]));
  const stamp = (ageMs: number | null) =>
    ageMs === null ? null : new Date(now - ageMs).toISOString();
  const observers = new Set<number>();

  const targets = desired.map((target) => {
    const key = poolTargetKey(target) ?? `${target.host}:${target.port}`;
    const fixture = byTarget.get(key);
    if (!fixture) {
      // 从未被观测过：契约里只能是 `unknown`（不能假定健康，也不是「故障」）。
      return noEvidenceTargetView(key);
    }
    const rows = fixture.observers.map((observer) => {
      if (typeof observer.observer?.node_id === "number") {
        observers.add(observer.observer.node_id);
      }
      return { ...observer, last_observed_at: stamp(observer.age_ms) };
    });
    return {
      ...fixture,
      target: key,
      observers: rows,
      facts: { ...fixture.facts, last_observed_at: stamp(fixture.facts.age_ms) },
    };
  });

  return {
    targets,
    observers: [...observers].sort((a, b) => a - b),
    observed_at: new Date(now).toISOString(),
  };
}

/** 「没有证据」视图：与后端未观测目标的合成结果同形（无观测者、无年龄事实）。 */
export function noEvidenceTargetView(target: string): TargetHealthTargetView {
  return {
    target,
    state: "unknown",
    reasons: ["no_observation"],
    flapping: false,
    observers: [],
    facts: {
      evidence: false,
      observers: 0,
      fresh_observers: 0,
      stale_observers: 0,
      unusable_observers: 0,
      worst_observer: null,
      reachable: null,
      latency_ms: null,
      consecutive_success: null,
      consecutive_failure: null,
      success_rate: null,
      last_observed_at: null,
      age_ms: null,
      disagreement: false,
    },
    recent_flips: [],
  };
}

// ------------------------------------------------- WP12 出口池 / 目标（mock）

/** 出口池 CRUD + 嵌套目标 CRUD：真实单数路径 /admin/node/:id/pools 与 /admin/node/pools/:poolId[...]（node 解析后喂进来） */
export function handleEgressPools(
  db: Store,
  node: Node,
  method: string,
  rest: string[],
  req: MockRequest,
): MockResponse {
  const pools = db.egressPools.get(node.id) ?? [];

  // /pools 列表路由
  if (rest.length === 0) {
    if (method === "GET") {
      // 与真实后端同一信封：`{ data: { data, total } }`
      // （`node-admin.ts:143` 的 `get("/node/:id/pools")` → `db.nodeGroup` 风格的
      //  `{data:{data,total}}`）。客户端 `api.admin.pools` 解一层拿到 `{data,total}`，
      // 再取 `.data`；mock 这里必须给出**内层的 `{data,total}`**，否则解完是数组，
      // 客户端按信封读取会得到空列表——「mock 与真实不同形」正是本文件被反复修的原因。
      const rows = pools.map((p) => ({ ...p, targets: db.egressTargets.get(p.id) ?? [] }));
      return ok({ data: rows, total: rows.length });
    }
    if (method === "POST") {
      const body = asRecord(req.body);
      const name = reqStr(body.name);
      if (!name) return badRequest("池名称不能为空");
      const strategy = body.lb_strategy === undefined || body.lb_strategy === null ? null : reqStr(body.lb_strategy);
      if (strategy !== null && strategy !== "round" && strategy !== "rand") return badRequest("出口策略不合法");
      const pool: EgressPool = {
        id: nextPoolId(pools),
        node_id: node.id,
        name,
        // NULL = 回落 node.lb_strategy → round（契约语义）
        lb_strategy: strategy as LBStrategy | null,
        status: "active",
        created_at: nowIso(),
        updated_at: nowIso(),
        targets: [],
      };
      pools.push(pool);
      db.egressPools.set(node.id, pools);
      db.egressTargets.set(pool.id, []);
      return ok(pool);
    }
    return badRequest("方法不允许");
  }

  const poolId = parseId(rest[0]);
  const pool = poolId === null ? undefined : pools.find((p) => p.id === poolId);
  if (!pool) return notFound("出口池不存在");

  // /pools/:poolId
  if (rest.length === 1) {
    if (method === "GET") return ok({ ...pool, targets: db.egressTargets.get(pool.id) ?? [] });
    if ((method === "PUT" || method === "PATCH")) {
      const body = asRecord(req.body);
      if (body.name !== undefined) {
        const name = reqStr(body.name);
        if (!name) return badRequest("池名称不能为空");
        pool.name = name;
      }
      if (body.lb_strategy !== undefined) {
        if (body.lb_strategy === null) {
          pool.lb_strategy = null;
        } else {
          const s = reqStr(body.lb_strategy);
          if (s !== "round" && s !== "rand") return badRequest("出口策略不合法");
          pool.lb_strategy = s;
        }
      }
      if (body.status !== undefined) {
        const s = reqStr(body.status);
        if (s !== "active" && s !== "inactive") return badRequest("状态不合法");
        pool.status = s;
      }
      pool.updated_at = nowIso();
      return ok(pool);
    }
    if (method === "DELETE") {
      pools.splice(pools.indexOf(pool), 1);
      db.egressTargets.delete(pool.id);
      return ok({ ok: true, id: pool.id });
    }
    return badRequest("方法不允许");
  }

  // /pools/:poolId/targets[...]
  if (rest[1] === "targets") {
    const targets = db.egressTargets.get(pool.id) ?? [];
    if (rest.length === 2) {
      if (method === "GET") return ok(targets);
      if (method === "POST") {
        const body = asRecord(req.body);
        const host = reqStr(body.host);
        if (!host) return badRequest("目标地址不能为空");
        const port = numOrNull(body.port);
        if (port === null || port <= 0 || port > 65535) return badRequest("端口不合法");
        const weight = numOrNull(body.weight);
        if (weight !== null && weight < 0) return badRequest("权重不合法");
        if (targets.some((t) => t.host === host && t.port === port)) return badRequest("同一地址端口已存在");
        const target: EgressTarget = {
          // 全局唯一（真实后端按 targetId 全局寻址，见 `nextTargetId` 的说明）
          id: nextTargetId(targets, [...db.egressTargets.values()]),
          pool_id: pool.id,
          host,
          port,
          weight: weight ?? 1,
          order_by: numOrNull(body.order_by) ?? targets.length * 10,
          remark: reqStr(body.remark) || null,
          status: body.status === undefined ? "active" : reqStr(body.status) === "inactive" ? "inactive" : "active",
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        targets.push(target);
        db.egressTargets.set(pool.id, targets);
        return ok(target);
      }
      return badRequest("方法不允许");
    }
    const tid = parseId(rest[2]);
    const target = tid === null ? undefined : targets.find((x) => x.id === tid);
    if (!target) return notFound("出口目标不存在");
    if (rest.length === 3) {
      if (method === "GET") return ok(target);
      if (method === "PUT" || method === "PATCH") {
        const body = asRecord(req.body);
        if (body.host !== undefined) {
          const h = reqStr(body.host);
          if (!h) return badRequest("目标地址不能为空");
          target.host = h;
        }
        if (body.port !== undefined) {
          const p = numOrNull(body.port);
          if (p === null || p <= 0 || p > 65535) return badRequest("端口不合法");
          target.port = p;
        }
        if (body.weight !== undefined) {
          const w = numOrNull(body.weight);
          if (w === null || w < 0) return badRequest("权重不合法");
          target.weight = w;
        }
        if (body.order_by !== undefined) target.order_by = numOrNull(body.order_by) ?? target.order_by;
        if (body.remark !== undefined) target.remark = reqStr(body.remark) || null;
        if (body.status !== undefined) {
          const s = reqStr(body.status);
          if (s !== "active" && s !== "inactive") return badRequest("状态不合法");
          target.status = s;
        }
        target.updated_at = nowIso();
        return ok(target);
      }
      if (method === "DELETE") {
        targets.splice(targets.indexOf(target), 1);
        return ok({ ok: true, id: target.id });
      }
      return badRequest("方法不允许");
    }
  }

  return notFound("接口不存在");
}

export function nextPoolId(pools: EgressPool[]): ID {
  return pools.reduce((m, p) => Math.max(m, p.id), 0) + 1;
}

/**
 * 新出口目标 ID —— **全局唯一**，与真实后端的寻址方式一致。
 *
 * 真实后端的目标是全局地址：`PATCH|DELETE /api/admin/node/targets/:targetId`
 * （`node-admin.ts:291/308`）里没有 pool，只有 targetId。所以 targetId 必须在
 * **所有池**之间唯一，否则"按 id 找目标"会命中另一个池里的同号目标。
 *
 * 曾经这里按**单个池**分配（`max(本池) + 1`），于是每个池都有 id=1：mock 一旦
 * 按真实路径寻址，就会删/改到别的池的目标（实测：DELETE 返回 ok，但被删的是
 * 种子池里的同号目标，PATCH 那个"已删"目标仍然 200）。id 空间与真实契约不符
 * 属于 mock 撒谎的一种，故改为全局。
 *
 * 入参仍是"当前池的目标"（调用点已持有），这里再叠加**所有池**的最大值——
 * 纯函数、不改调用方语义。
 */
export function nextTargetId(targets: EgressTarget[], allPools?: EgressTarget[][]): ID {
  const poolMax = targets.reduce((m, x) => Math.max(m, x.id), 0);
  const globalMax = (allPools ?? []).reduce(
    (m, list) => list.reduce((mm, x) => Math.max(mm, x.id), m),
    poolMax,
  );
  return globalMax + 1;
}

/* ------------------------------------------------------------------ *
 * WP11 / WP13 隧道 v3 编排运行态（mock）
 *
 * 镜像**冻结的 WP11 契约**（后端 feature/v3-wp11-tunnel-api 未合入 main）：
 *   - `apply_status` 状态机 pending/applying/active/error/suspended
 *     （DEVELOPMENT.md §4.1，schema 注释同口径）；
 *   - retry / suspend / resume 三个运行操作统一走「编排器」语义：
 *       retry     —— error/suspended → pending（revision 保持，不抬高）
 *       suspend   —— active → suspended（通知两端，Tunnel 保留）
 *       resume    —— suspended → pending →（编排完成）active
 *   - **绝不发明字段**：返回体就是 TunnelRuntimeAction + Tunnel 增量列。
 *
 * mock 的「Agent」是同步假ACK：resume/retry 半秒内把状态推到 active，
 * 这样 UI 的重试→轮询闭环可跑通。真实后端走 async orchestrator，
 * 前端轮询 `GET /tunnels/:id` 直到终态，UI 逻辑两侧一致。
 * ------------------------------------------------------------------ */

export const APPLY_STATUSES = ["pending", "applying", "active", "error", "suspended"] as const;
export const TUNNEL_MODES = ["direct", "relay"] as const;

/**
 * V4-WP9 §13.6：批量动作白名单（mock 侧镜像）。
 *
 * 与后端 `services/forward-batch.ts` 的 `FORWARD_BATCH_ACTIONS` **必须一致**：
 * 不含 delete（不可逆动作不提供批量入口）。上限同理——mock 必须拒绝同样的
 * 请求，否则本地开发会通过、线上 400。
 */
export const FORWARD_BATCH_ACTIONS = ["retry", "suspend", "resume"] as const;
export const FORWARD_BATCH_MAX_IDS = 50;

export type MockForwardBatchAction = (typeof FORWARD_BATCH_ACTIONS)[number];

/** 逐条结果形状：与后端 `ForwardBatchItemResult` 对齐（字段名即契约）。 */
export interface MockForwardBatchItemResult {
  id: number;
  ok: boolean;
  apply_status: string | null;
  code?: string;
  message?: string;
}

export function applyStatusOf(t: Tunnel): Tunnel["apply_status"] {
  return t.apply_status ?? null;
}

/** v3 增量列是否存在（存量 mock 行没有这些键 = legacy DIRECT） */
export function hasV3Columns(t: Tunnel): boolean {
  return t.tunnel_mode !== undefined && t.apply_status !== undefined;
}

/** 把一条 relay 隧道推进到「编排完成」（mock 的假 Agent ACK） */
export function completeOrchestration(t: Tunnel): void {
  t.apply_status = "active";
  t.desired_status = "active";
  t.applied_revision = t.config_revision ?? null;
  t.apply_error = null;
  t.apply_error_code = null;
  t.last_applied_at = nowIso();
  t.updated_at = nowIso();
}

/** 池 id → 挂它的 node id（RELAY 编排器按池反查出口节点） */
export function poolOfNode(db: Store, poolId: ID): ID | null {
  for (const [, pools] of db.egressPools) {
    const hit = pools.find((p) => p.id === poolId);
    if (hit) return hit.node_id;
  }
  return null;
}

/** 池 id → 展示用引用（Tunnel.egress_pool） */
export function poolRef(db: Store, poolId: ID | null): Tunnel["egress_pool"] {
  if (poolId === null) return null;
  for (const [, pools] of db.egressPools) {
    const hit = pools.find((p) => p.id === poolId);
    if (hit) return { id: hit.id, name: hit.name, lb_strategy: hit.lb_strategy ?? null, status: hit.status };
  }
  return null;
}

/** 运行操作网关：校验来源状态 → 推进 → 返回 TunnelRuntimeAction */
export function tunnelRuntimeAction(
  db: Store,
  t: Tunnel,
  action: "retry" | "suspend" | "resume",
): MockResponse {
  const current = applyStatusOf(t);
  if (action === "retry") {
    if (current !== "error" && current !== "suspended") {
      return badRequest(`当前状态 ${current ?? "legacy"} 不允许重试（仅 error / suspended 可重试）`, "INVALID_STATE");
    }
    if (!hasV3Columns(t)) return badRequest("该隧道未参与 v3 编排（legacy DIRECT），无编排可重放", "NOT_V3");
    t.apply_status = "pending";
    // retry 重放相同 desired revision：mock 里同步完成后 revision 不变，
    // 与 WP8 的 dispatchIngress 相同 revision 语义一致（不抬高）。
    completeOrchestration(t);
    return ok({ tunnel: t, apply_status: t.apply_status, config_revision: t.config_revision ?? null, reentered: true } satisfies TunnelRuntimeAction);
  }
  if (action === "suspend") {
    if (current !== "active") {
      return badRequest(`当前状态 ${current ?? "legacy"} 不允许暂停（仅 active 可暂停）`, "INVALID_STATE");
    }
    t.desired_status = "inactive";
    t.apply_status = "suspended";
    t.status = "inactive";
    t.online = false;
    t.client_count = 0;
    t.updated_at = nowIso();
    return ok({ tunnel: t, apply_status: t.apply_status, config_revision: t.config_revision ?? null } satisfies TunnelRuntimeAction);
  }
  // resume
  if (current !== "suspended") {
    return badRequest(`当前状态 ${current ?? "legacy"} 不允许恢复（仅 suspended 可恢复）`, "INVALID_STATE");
  }
  t.desired_status = "active";
  t.apply_status = "pending";
  t.status = "active";
  // resume 重新走编排：revision +1（与 WP8「revision 必须继续前进」一致）
  t.config_revision = (t.config_revision ?? 0) + 1;
  completeOrchestration(t);
  t.online = true;
  return ok({ tunnel: t, apply_status: t.apply_status, config_revision: t.config_revision } satisfies TunnelRuntimeAction);
}

/** 与后端 `services/attention.ts` 的 `ATTENTION_MAX_ITEMS` 同值（契约测试钉住）。 */
export const MOCK_ATTENTION_MAX_ITEMS = 25;

/**
 * V4-WP8 §13.7 Wave 4 —— Dashboard 待办的 mock 投影。
 *
 * **判定逻辑与后端 `services/attention.ts` 一一对应**，因为 mock 在这个项目里
 * 就是"离线可跑的后端"（WP6/WP7 同一先例）：形状或优先级漂移会让前端契约测试
 * 通过、真实后端却不一致。四处复用既有判定，不新造：
 *   · 节点三层 → `mockUserNodeStatus`（镜像 deriveConnection / nodeAdmission）
 *   · Forward 视图 → `mockForwardView`（与列表页同一投影）
 *   · 可重试结论 → `applyErrorIsRetryable`（lib/forward-status.ts，已有后端集合断言）
 *   · 上限 → `MOCK_ATTENTION_MAX_ITEMS`（与后端常量同值，测试钉住）
 *
 * 排序同样照抄后端：severity(error→warning→info) → kind(node 先) → id。
 */
export function mockAttention(db: Store) {
  const items: AttentionItem[] = [];
  const summary: AttentionSummary = {
    nodes_offline: 0,
    nodes_waiting_install: 0,
    nodes_restricted: 0,
    forwards_error: 0,
    forwards_pending: 0,
  };

  for (const node of db.nodes) {
    const status = mockUserNodeStatus(db, node);
    const base = { kind: "node" as const, id: node.id, name: node.node_id };
    if (status.connection === "waiting") {
      summary.nodes_waiting_install++;
      items.push({ ...base, severity: "warning", reason_code: "node_waiting_install", retryable: null });
      continue;
    }
    if (status.accepts_new_business === false && status.admission_rejection) {
      summary.nodes_restricted++;
      items.push({
        ...base,
        severity: "info",
        reason_code: status.admission_rejection as AttentionReasonCode,
        retryable: null,
      });
      continue;
    }
    if (status.connection === "offline") {
      summary.nodes_offline++;
      items.push({ ...base, severity: "warning", reason_code: "connection_offline", retryable: null });
    }
  }

  for (const tunnel of db.tunnels) {
    // 与后端 `collectAttention` 的 where 同一口径：只聚合 `port_forward`。
    // legacy 的 `remote_port_forward` 不在 V4 产品面上，混进来会让「待办数量」
    // 永远不等于用户在转发页看到的行数。
    if (tunnel.category !== "port_forward") continue;
    const forward = mockForwardView(db, tunnel);
    const base = { kind: "forward" as const, id: forward.id, name: forward.name };
    const status = forward.apply_status ?? null;
    if (status === "error") {
      summary.forwards_error++;
      const code = forward.apply_error_code ?? null;
      items.push({
        ...base,
        severity: "error",
        reason_code: "forward_apply_error",
        apply_error_code: code,
        retryable: code === null ? null : applyErrorIsRetryable(code),
      });
      continue;
    }
    const desired = forward.config_revision ?? null;
    const applied = forward.applied_revision ?? null;
    if (status === "active" && desired !== null && applied !== null && applied < desired) {
      summary.forwards_pending++;
      items.push({ ...base, severity: "warning", reason_code: "runtime_revision_behind", retryable: null });
      continue;
    }
    if (status === "pending" || status === "applying") {
      summary.forwards_pending++;
      items.push({ ...base, severity: "info", reason_code: "forward_pending_apply", retryable: null });
    }
  }

  const weight = { error: 0, warning: 1, info: 2 } as const;
  items.sort((a, b) => {
    const bySeverity = weight[a.severity] - weight[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.kind !== b.kind) return a.kind === "node" ? -1 : 1;
    return Number(a.id) - Number(b.id);
  });

  return {
    items: items.slice(0, MOCK_ATTENTION_MAX_ITEMS),
    summary,
    total: items.length,
    generated_at: nowIso(),
  };
}

/**
 * 用户侧节点投影（V4-WP8 三层状态）：与真实后端 `nodeView()` 同形。
 *
 * 判定集中在 `mocks/node-lifecycle.ts`（镜像后端 deriveConnection /
 * nodeAdmission），本函数只做「去掉 credential hash + 摊平三层」。
 */
export function mockUserNode(db: Store, node: Node): UserNode {
  const group = db.nodeGroups.find((g) => g.id === node.node_group_id);
  // Compatibility shim for legacy mock fixtures whose v3 role is still NULL:
  // the user-facing V4 surface projects the old group direction so the demo
  // remains operable without mutating the admin/source fixture.
  const role =
    node.role ??
    (group?.node_type === "in"
      ? "ingress"
      : group?.node_type === "out"
        ? "egress"
        : null);
  return {
    ...node,
    agent_id: node.agent_id ?? `mock-agent-${node.id}`,
    role,
    registered: Boolean(node.has_credential) && !node.credential_revoked,
    // V4-WP8 §13.4.1：三层状态与真实后端同形（判定集中在 mocks/node-lifecycle.ts）。
    ...mockUserNodeStatus(db, node),
  };
}

/**
 * V4-WP9 §13.6「Binding usage」：绑定使用量是**响应投影**，不是存储字段。
 *
 * 与后端 `services/binding-usage.ts` 同一口径：统计以该 pair 为 (ingress, egress)
 * 的 relay 转发条数；> 0 即解绑阻塞。mock 里逐绑定计算即可（数据量小），
 * 真实后端用一次 groupBy 避免 N+1。
 */
export function mockBindingUsage(db: Store, ingressNodeId: number, egressNodeId: number) {
  const used = db.tunnels.filter((tunnel) => {
    const ingress = mockIngressNode(db, tunnel);
    return (
      tunnel.tunnel_mode === "relay" &&
      ingress?.id === ingressNodeId &&
      tunnel.egress_node_id === egressNodeId
    );
  }).length;
  return { used_by_forward_count: used, unbind_blocked: used > 0 };
}

export function mockBindingView(db: Store, binding: MockNodeBinding): NodeBinding | null {
  const egress = db.nodes.find((node) => node.id === binding.egress_node_id);
  if (!egress) return null;
  return {
    ...binding,
    egress_node: mockUserNode(db, egress),
    ...mockBindingUsage(db, binding.ingress_node_id, binding.egress_node_id),
  };
}

/**
 * V4-WP6：把 store 投影成 health 模块需要的「世界」。
 *
 * 入口解析复用 `mockIngressNode`——转发视图与健康视图必须对「这条隧道落在哪个
 * 节点上」给出**同一个答案**，否则面板会出现「转发在 node 3，但 health 说
 * node 1 的 runtime 缺失」这种自相矛盾。
 */
export function healthWorld(db: Store): MockHealthWorld {
  return {
    nodes: db.nodes,
    tunnels: db.tunnels,
    nodeStates: db.nodeStates,
    ingressNodeIdFor: (tunnel) => mockIngressNode(db, tunnel)?.id ?? null,
    // 时钟基准用 **seed.now**（与整套演示数据同一个基准）：否则固定时间戳的
    // fixture 会随真实时间流逝整体变旧，演示页在一次会话里前后自相矛盾
    // （列表说在线、健康卡说上报过期）。真实后端用服务器时钟，这一处只是
    // mock 的自洽选择。
    now: seed.now,
  };
}

/**
 * V4-WP7：把 store 投影成 impact 统计需要的「世界」。
 *
 * 入口解析复用 `mockIngressNode`——转发视图、健康视图与依赖统计必须对
 * 「这条隧道落在哪个节点上」给出**同一个答案**，否则依赖预览会说
 * 「没有入口转发」而转发列表里明明列着一条。
 */
export function impactWorld(db: Store): MockImpactWorld {
  return {
    nodes: db.nodes,
    tunnels: db.tunnels,
    poolsForNode: (nodeId) => (db.egressPools.get(nodeId) ?? []).length,
    bindingsForNode: (nodeId) =>
      db.nodeBindings.filter((b) => b.ingress_node_id === nodeId || b.egress_node_id === nodeId).length,
    leasesForNode: (nodeId) => db.nodeLeases.get(nodeId) ?? [],
    ingressNodeIdFor: (tunnel) => mockIngressNode(db, tunnel)?.id ?? null,
  };
}

export function mockIngressNode(db: Store, tunnel: Tunnel): UserNode | null {
  const explicit = tunnel.ingress_node_id
    ? db.nodes.find((node) => node.id === tunnel.ingress_node_id)
    : null;
  const fallback =
    explicit ??
    db.nodes.find(
      (node) =>
        node.node_group_id === tunnel.in_node_group_id &&
        (mockUserNode(db, node).role === "ingress" ||
          mockUserNode(db, node).role === "both"),
    ) ??
    db.nodes.find((node) => node.node_group_id === tunnel.in_node_group_id);
  return fallback ? mockUserNode(db, fallback) : null;
}

export function parseMockTarget(address: string | undefined): { host: string; port: number } | null {
  if (!address) return null;
  const match =
    /^\[([^\]]+)\]:(\d+)$/.exec(address) ??
    /^([^:]+):(\d+)$/.exec(address);
  if (!match) return null;
  const port = Number(match[2]);
  return Number.isInteger(port) ? { host: match[1]!, port } : null;
}

export function mockForwardView(db: Store, tunnel: Tunnel): PortForward {
  const ingress = mockIngressNode(db, tunnel);
  const egressRaw = tunnel.egress_node_id
    ? db.nodes.find((node) => node.id === tunnel.egress_node_id)
    : null;
  const egress = egressRaw ? mockUserNode(db, egressRaw) : null;
  const pooled =
    tunnel.egress_pool_id != null
      ? (db.egressTargets.get(tunnel.egress_pool_id) ?? []).find(
          (target) => target.status === "active",
        ) ?? null
      : null;
  const fallback = parseMockTarget(tunnel.forward_addresses[0]);
  const target =
    pooled ??
    (tunnel.remote_host && tunnel.remote_port
      ? { host: tunnel.remote_host, port: tunnel.remote_port, weight: 1 }
      : fallback
        ? { ...fallback, weight: 1 }
        : null);
  const protocol = forwardProtocolFact(tunnel.forward_protocol, tunnel.tunnel_type);

  return {
    id: tunnel.id,
    creator_user_id: tunnel.user_id ?? null,
    name: tunnel.name,
    /*
     * V5-WP5-A1：协议事实来自行（`forward_protocol` 优先，回落 legacy
     * `tunnel_type`），与后端 `persistedForwardProtocol` 同一口径。
     *
     * 这里曾经硬编码 `"tcp"`：那条投影把 seed 里的 `tls` / `wss` 行全部谎报成
     * TCP，于是前端在 mock 下**永远看不到**新协议面（V5-G0 在真实下发面上抓到的
     * 正是同一种「投影忘了选协议列」）。`protocol_supported` 由同一个契约模块判定，
     * mock 不另立一份白名单。
     */
    protocol,
    protocol_supported: forwardProtocolSupported(
      tunnel.forward_protocol,
      tunnel.tunnel_type,
    ),
    /*
     * V5-WP5-A1 后续修订：后端 `forwardView` 现在**投影** tls 的两列路径（只有路径，
     * 永远没有密钥内容），否则详情页只能说「TLS」而说不出用哪张证书。mock 必须同形，
     * 否则「详情页显示证书路径」在开发环境里永远是空的 —— 这正是 mock 存在的意义：
     * 形状与真实投影一致，前端才不会只在线上才发现字段缺失。
     */
    tls_cert_path: protocol === "tls" ? (tunnel.tls_cert_path ?? null) : null,
    tls_key_path: protocol === "tls" ? (tunnel.tls_key_path ?? null) : null,
    mode: tunnel.tunnel_mode === "relay" ? "relay" : "direct",
    ingress_node_id: ingress?.id ?? tunnel.in_node_group_id,
    ingress_node: ingress,
    egress_node_id: egress?.id ?? null,
    egress_node: egress,
    listen_ip: tunnel.listen_ip,
    listen_port: tunnel.listen_port,
    target_host: target?.host ?? null,
    target_port: target?.port ?? null,
    target_weight: target && "weight" in target ? target.weight : 1,
    traffic: tunnel.traffic,
    traffic_cost: tunnel.traffic_cost,
    online: tunnel.apply_status === "active",
    desired_status: tunnel.desired_status ?? null,
    apply_status: tunnel.apply_status ?? null,
    config_revision: tunnel.config_revision ?? null,
    applied_revision: tunnel.applied_revision ?? null,
    // V4-WP1：desired 指针 + 最新 revision 号。mock 的 desired 指针由 tunnel 行
    // 自身承担，因此这里投影出稳定的派生值；UI 只消费形状，不解析语义。
    desired_revision_id:
      tunnel.config_revision == null ? null : tunnel.id * 10000 + tunnel.config_revision,
    latest_revision: tunnel.config_revision ?? 0,
    apply_error_code: tunnel.apply_error_code ?? null,
    apply_error: tunnel.apply_error ?? null,
    last_applied_at: tunnel.last_applied_at ?? null,
    created_at: tunnel.created_at,
    updated_at: tunnel.updated_at,
  };
}

export function mockEnrollment(node: UserNode): NodeEnrollmentIssued {
  const token = `mock_enroll_${node.agent_id}_${Math.random().toString(36).slice(2, 10)}`;
  return {
    token,
    node_id: node.id,
    node_key: node.node_id,
    agent_id: node.agent_id,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    install_command:
      `docker run -d --name tunex-agent --restart unless-stopped ` +
      `-e TUNEX_ENROLLMENT_TOKEN=${token} ghcr.io/paimoncai/tunex-agent:latest`,
  };
}

// ---------------------------------------------------------------- 路由


export interface MockAuthedRouteContext {
  method: string;
  clean: string;
  seg: string[];
  q: ListQuery | undefined;
  db: Store;
  user: User;
  req: MockRequest;
  scopeId: number | undefined;
}

export {
  seed,
  poolTargetKey,
  getStore,
  resetStore,
  handleFederationMock,
  handleRouteProfileMock,
  mockFleetHealth,
  mockNodeHealth,
  mockResolveNode,
  MOCK_LIFECYCLES,
  MOCK_LIFECYCLE_NOTE_MAX,
  mockAllowedTransitions,
  mockCanTransition,
  mockDeleteGates,
  mockImpact,
  mockLifecycleChange,
  mockLifecycleOf,
  mockLifecycleView,
  mockRoleCheck,
  mockUserNodeStatus,
  applyMockForwardPatch,
  injectMockForwardView,
  previewMockForwardUpdate,
  applyErrorIsRetryable,
  DEFAULT_FORWARD_PROTOCOL,
  forwardProtocolFact,
  forwardProtocolSupported,
  isForwardProtocol,
  tlsPathFieldErrors,
  mockEffectivePermissions,
  mockBasePermissions,
  mockGrantSubset,
  validMockRolePermissions,
};
