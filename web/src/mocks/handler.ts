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
import { getStore, resetStore, type MockNodeBinding, type MockWorkspaceInvite } from "./state";
import {
  applyMockForwardPatch,
  injectMockForwardView,
  previewMockForwardUpdate,
} from "./forward-edit";
import type { ForwardPatchInput } from "@/lib/types";

// forward-edit.ts 需要 handler 的 forward 投影（避免反向依赖），在这里注入一次。
injectMockForwardView((_db, tunnel) => mockForwardView(_db, tunnel));

export interface MockRequest {
  body?: unknown;
  query?: ListQuery;
  cookie?: string;
}

export interface MockResponse {
  status: number;
  body: unknown;
}

const SESSION_COOKIE = "tunex_session";
const GB = 1024 * 1024 * 1024;

/** 会话 cookie 值：`u<id>` 指定用户；用 id 而非邮箱，避免用户改邮箱后会话失效 */
function sessionCookieValue(userId: number): string {
  return `${SESSION_COOKIE}=u${userId}; Path=/; Max-Age=${60 * 60 * 12}; SameSite=Lax`;
}

const CYCLE_DAYS: Record<BillingCycle, number> = {
  month: 30,
  quarter: 90,
  half_year: 180,
  year: 365,
  lifetime: 36500,
};

/** 优惠码（演示用） */
const COUPONS: Record<string, { type: "percent" | "amount"; value: number }> = {
  TUNEX10: { type: "percent", value: 10 },
  TUNEX50: { type: "amount", value: 50 },
};

/**
 * 权限元数据（镜像 backend/src/permissions.ts 的 ADMIN_RESOURCES）。
 * mock 只用于渲染角色编辑器的资源清单，键必须与后端一致。
 */
const ADMIN_RESOURCES: { key: string; label: string; group: string; url: string; business: boolean }[] = [
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
const ADMIN_RESOURCE_KEYS = ADMIN_RESOURCES.map((r) => r.key);

/** 角色权限入库前清洗：仅保留已知 key 且值为 read/write */
function sanitizePermissions(input: unknown): Record<string, "read" | "write"> {
  const result: Record<string, "read" | "write"> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (ADMIN_RESOURCE_KEYS.includes(k) && (v === "read" || v === "write")) result[k] = v;
  }
  return result;
}

/** 新建充值单后多久自动「收到支付回调」（毫秒），0 表示关闭自动结算 */
const TOPUP_AUTO_SETTLE_MS = (() => {
  if (typeof process === "undefined" || !process.env) return 15000;
  return Number(process.env.MOCK_TOPUP_AUTO_SETTLE_MS ?? 15000);
})();

type Store = ReturnType<typeof getStore>;

// ---------------------------------------------------------------- 基础工具

const nowIso = () => new Date().toISOString();

function ok(body: unknown): MockResponse {
  return { status: 200, body };
}
function fail(status: number, message: string, code?: string, data?: unknown): MockResponse {
  return { status, body: { message, ...(code ? { code } : {}), ...(data ? { data } : {}) } };
}
function badRequest(message: string, code = "VALIDATION_ERROR"): MockResponse {
  return fail(400, message, code);
}
function notFound(message: string): MockResponse {
  return fail(404, message, "NOT_FOUND");
}

function isLoggedIn(cookie?: string): boolean {
  return !!cookie && new RegExp(`${SESSION_COOKIE}=`).test(cookie);
}

/** 会话 cookie 支持 `u<id>` 指定用户（便于多账号演示），否则映射到 demo 用户 */
function userFromCookie(db: Store, cookie?: string): User {
  const m = cookie ? new RegExp(`${SESSION_COOKIE}=u(\\d+)`).exec(cookie) : null;
  if (m) {
    const found = db.users.find((u) => u.id === Number(m[1]));
    if (found) return found;
  }
  return db.user;
}

function paginate<T>(items: T[], query?: ListQuery) {
  const page = Math.max(1, Number(query?.page ?? 1) || 1);
  const page_size = Math.min(200, Math.max(1, Number(query?.page_size ?? 20) || 20));
  const start = (page - 1) * page_size;
  return { data: items.slice(start, start + page_size), total: items.length, page, page_size };
}

/** 关键字过滤：接受任意实体数组（Prisma 模型无索引签名，内部按 record 取值） */
function filterByKeyword<T extends object>(items: T[], query: ListQuery | undefined, keys: string[]): T[] {
  const kw = String(query?.keyword ?? "").trim().toLowerCase();
  if (!kw) return items;
  return items.filter((it) =>
    keys.some((k) => String((it as Record<string, unknown>)[k] ?? "").toLowerCase().includes(kw)),
  );
}

function filterByStatus<T extends object>(items: T[], query?: ListQuery): T[] {
  const s = query?.status;
  if (!s || s === "all") return items;
  return items.filter((it) => String((it as Record<string, unknown>).status ?? "") === s);
}

function nextId(items: { id: number }[]): number {
  return items.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function reqStr(v: unknown): string {
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

/** 数字解析：空 / 非法 → null */
function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 必填数字：空 / 非法 → undefined */
function reqNum(v: unknown): number | undefined {
  const n = numOrNull(v);
  return n === undefined || n === null ? undefined : n;
}

/** 必填字符串 */
function required(
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
function pick<T extends object>(body: Record<string, unknown>, keys: readonly string[]): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in body) out[k] = body[k];
  return out as Partial<T>;
}

/** 字符串数组字段：接受数组或逗号/换行分隔的字符串；空值 → null */
function parseList(v: unknown): string[] | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v).trim();
  if (!s) return null;
  return s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function isResponse(x: unknown): x is MockResponse {
  return (
    !!x && typeof x === "object" && "status" in (x as Record<string, unknown>) && "body" in (x as Record<string, unknown>)
  );
}

function parseId(seg: string | undefined): number | null {
  return seg && /^\d+$/.test(seg) ? Number(seg) : null;
}

const groupRef = (db: Store, id: number | null | undefined): Pick<NodeGroup, "id" | "name" | "node_type"> | undefined => {
  if (!id) return undefined;
  const g = db.nodeGroups.find((x) => x.id === id);
  return g ? { id: g.id, name: g.name, node_type: g.node_type } : undefined;
};

function withGroupStats<T extends NodeGroup>(db: Store, g: T): T {
  const nodes = db.nodes.filter((n) => n.node_group_id === g.id);
  return { ...g, node_count: nodes.length, online_node_count: nodes.filter((n) => n.online).length };
}

/**
 * 隧道流量序列：由隧道累计流量确定性派生（同一隧道每次返回一致，便于断言）。
 * 与 /dashboard/traffic 的返回结构一致：字节数 + 计费流量（GB）。
 */
function tunnelTrafficSeries(tunnelId: number, totalBytes: number, days: number): TrafficPoint[] {
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

function creditBalance(db: Store, user: User, amount: number, type: BalanceLog["type"]): BalanceLog {
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
function settleTopup(db: Store, order: TopupOrder): TopupOrder {
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
function autoSettleTopups(db: Store) {
  if (!(TOPUP_AUTO_SETTLE_MS > 0)) return;
  const deadline = Date.now() - TOPUP_AUTO_SETTLE_MS;
  for (const o of db.topupOrders) {
    if (o.status !== "pending") continue;
    const created = Date.parse(o.created_at);
    if (Number.isFinite(created) && created <= deadline) settleTopup(db, o);
  }
}

function payUrlFor(order_id: string, payment: { method: string; url: string }): string {
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
function topupOrderNo(db: Store): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const today = db.topupOrders.filter((o) => o.order_id.startsWith(`TU${ymd}`)).length + 1;
  return `TU${ymd}${String(today).padStart(4, "0")}`;
}

// ---------------------------------------------------------------- 统计

function dashboardStats(db: Store, user: User) {
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

function adminStats(db: Store) {
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
function readPlanPayload(
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

function readNodeGroupPayload(
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

function readNodePayload(
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

// ------------------------------------------------- WP12 出口池 / 目标（mock）

/** 出口池 CRUD + 嵌套目标 CRUD：/admin/nodes/:id/pools[...]（node 解析后喂进来） */
function handleEgressPools(
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
      return ok(pools.map((p) => ({ ...p, targets: db.egressTargets.get(p.id) ?? [] })));
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
          id: nextTargetId(targets),
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

function nextPoolId(pools: EgressPool[]): ID {
  return pools.reduce((m, p) => Math.max(m, p.id), 0) + 1;
}

function nextTargetId(targets: EgressTarget[]): ID {
  return targets.reduce((m, x) => Math.max(m, x.id), 0) + 1;
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

const APPLY_STATUSES = ["pending", "applying", "active", "error", "suspended"] as const;
const TUNNEL_MODES = ["direct", "relay"] as const;

function applyStatusOf(t: Tunnel): Tunnel["apply_status"] {
  return t.apply_status ?? null;
}

/** v3 增量列是否存在（存量 mock 行没有这些键 = legacy DIRECT） */
function hasV3Columns(t: Tunnel): boolean {
  return t.tunnel_mode !== undefined && t.apply_status !== undefined;
}

/** 把一条 relay 隧道推进到「编排完成」（mock 的假 Agent ACK） */
function completeOrchestration(t: Tunnel): void {
  t.apply_status = "active";
  t.desired_status = "active";
  t.applied_revision = t.config_revision ?? null;
  t.apply_error = null;
  t.apply_error_code = null;
  t.last_applied_at = nowIso();
  t.updated_at = nowIso();
}

/** 池 id → 挂它的 node id（RELAY 编排器按池反查出口节点） */
function poolOfNode(db: Store, poolId: ID): ID | null {
  for (const [, pools] of db.egressPools) {
    const hit = pools.find((p) => p.id === poolId);
    if (hit) return hit.node_id;
  }
  return null;
}

/** 池 id → 展示用引用（Tunnel.egress_pool） */
function poolRef(db: Store, poolId: ID | null): Tunnel["egress_pool"] {
  if (poolId === null) return null;
  for (const [, pools] of db.egressPools) {
    const hit = pools.find((p) => p.id === poolId);
    if (hit) return { id: hit.id, name: hit.name, lb_strategy: hit.lb_strategy ?? null, status: hit.status };
  }
  return null;
}

/** 运行操作网关：校验来源状态 → 推进 → 返回 TunnelRuntimeAction */
function tunnelRuntimeAction(
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

function mockUserNode(db: Store, node: Node): UserNode {
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
    online: Boolean(node.online) && node.status === "active",
  };
}

function mockBindingView(db: Store, binding: MockNodeBinding): NodeBinding | null {
  const egress = db.nodes.find((node) => node.id === binding.egress_node_id);
  if (!egress) return null;
  return {
    ...binding,
    egress_node: mockUserNode(db, egress),
  };
}

function mockIngressNode(db: Store, tunnel: Tunnel): UserNode | null {
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

function parseMockTarget(address: string | undefined): { host: string; port: number } | null {
  if (!address) return null;
  const match =
    /^\[([^\]]+)\]:(\d+)$/.exec(address) ??
    /^([^:]+):(\d+)$/.exec(address);
  if (!match) return null;
  const port = Number(match[2]);
  return Number.isInteger(port) ? { host: match[1]!, port } : null;
}

function mockForwardView(db: Store, tunnel: Tunnel): PortForward {
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

  return {
    id: tunnel.id,
    name: tunnel.name,
    protocol: "tcp",
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

function mockEnrollment(node: UserNode): NodeEnrollmentIssued {
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

export async function handleMock(method: string, path: string, req: MockRequest): Promise<MockResponse> {
  const clean = path.split("?")[0].replace(/^\/+|\/+$/g, "");
  const seg = clean.split("/");
  const q = req.query;
  const db = getStore();
  const logged = isLoggedIn(req.cookie);

  // ---------- mock 自管理 ----------
  if (seg[0] === "_mock" && seg[1] === "reset" && method === "POST") {
    resetStore();
    return ok({ ok: true, boot_at: getStore().boot_at });
  }

  // ---------- auth ----------
  if (seg[0] === "auth") {
    // api 层用 `GET /auth/me`（与真实后端对齐），返回裸用户；`/auth/session` 为兼容旧调用返回 { user }
    if ((seg[1] === "session" || seg[1] === "me") && method === "GET") {
      if (!logged) return fail(401, "Unauthorized");
      const u = userFromCookie(db, req.cookie);
      const withPlan = { ...u, user_plan: db.userPlans.find((p) => p.user_id === u.id) ?? null };
      return ok(seg[1] === "me" ? withPlan : { user: withPlan });
    }
    if (seg[1] === "login" && method === "POST") {
      const body = asRecord(req.body);
      const email = reqStr(body.email).toLowerCase();
      const password = reqStr(body.password);
      if (!email || !password) return badRequest("邮箱和密码不能为空");
      const found = db.users.find((u) => u.email.toLowerCase() === email);
      const expected = found ? db.passwords[found.id] : undefined;
      const isDemo = email === seed.DEMO_CREDENTIALS.email.toLowerCase() && password === seed.DEMO_CREDENTIALS.password;
      if (!found || (password !== expected && !isDemo)) return fail(401, "邮箱或密码错误");
      if (found.status !== "active") return fail(403, "账号已被禁用");
      return ok({
        user: { ...found, email_verified_at: found.email_verified_at ?? null },
        token: `mock-jwt-${found.id}`,
        email_verified: Boolean(found.email_verified_at),
        expires_at: new Date(Date.now() + 6048e5).toISOString(),
        // mock 模式下没有真实响应头，浏览器端无法拿到 Set-Cookie，
        // 故把会话 cookie 值随 body 下发，由 api 层在客户端写入 document.cookie。
        // 切到真实后端时这个字段会被忽略（后端走真正的 Set-Cookie）。
        session_cookie: sessionCookieValue(found.id),
      });
    }
    if (seg[1] === "register" && method === "POST") {
      const body = asRecord(req.body);
      const email = reqStr(body.email).toLowerCase();
      const password = reqStr(body.password);
      if (!email) return badRequest("邮箱不能为空");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("邮箱格式不正确");
      if (password.length < 6) return badRequest("密码至少 6 位");
      if (db.users.some((u) => u.email.toLowerCase() === email)) return badRequest("该邮箱已注册");
      const id = nextId(db.users);
      const created: User = {
        id,
        email,
        super_admin: false,
        balance: 0,
        commission_balance: 0,
        tg_id: null,
        uid: `RX-${100000 + id}`,
        note: null,
        parent_id: null,
        referral_commission_rate: null,
        auto_renew: false,
        api_key: `rk_live_${Math.random().toString(16).slice(2, 18)}`,
        subscription_key: `sk_sub_${Math.random().toString(16).slice(2, 18)}`,
        status: "active",
        email_verified_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.users.push(created);
      db.passwords[id] = password;
      // TEN-03：注册即发一封 24h 验证邮件（mock 侧落内存 token，语义对齐后端）
      const now = Date.now();
      db.emailTokens.push({
        token: `mock-verify-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        email,
        purpose: "email_verify",
        expires_at: now + 24 * 60 * 60 * 1000,
        used_at: null,
        created_at: now,
      });
      return ok({
        user: created,
        token: `mock-jwt-${id}`,
        email_verified: false,
        session_cookie: sessionCookieValue(id),
      });
    }
    if (seg[1] === "logout" && method === "POST") return ok({ ok: true });

    /* -------------------- TEN-03 邮箱验证 / 密码重置 -------------------- */
    // 这三个端点与后端 /api/auth/* 同在免认证白名单内（前端可能未登录就点邮件链接），
    // 但各自的业务约束与后端严格一致：
    //   · verify-email：token 单次使用、过期即失效；用途不符拒绝
    //   · forgot-password：**存在与不存在的邮箱返回同一响应**（防枚举）
    //   · resend-verification：需要登录态（后端同理），已验证 → 409，60s 内 → 429
    //   · reset-password：token 单次使用；成功后所有未用 token 一并作废
    if (seg[1] === "verify-email" && method === "GET") {
      const token = reqStr(q?.token);
      if (!token) return fail(400, "验证链接无效");
      const row = db.emailTokens.find((x) => x.token === token && x.purpose === "email_verify");
      if (!row || row.used_at !== null || row.expires_at <= Date.now()) {
        return fail(400, "验证链接无效或已使用");
      }
      row.used_at = Date.now();
      const target = db.users.find((u) => u.email.toLowerCase() === row.email);
      if (target) target.email_verified_at = nowIso();
      return ok({ status: "verified", message: "邮箱验证成功" });
    }

    if (seg[1] === "forgot-password" && method === "POST") {
      const body = asRecord(req.body);
      const email = reqStr(body.email).toLowerCase();
      if (!email) return badRequest("邮箱不能为空");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("邮箱格式不正确");
      // 防枚举：无论邮箱是否存在都返回同一响应，且已发出未过期重置信时不重复发
      const unused = db.emailTokens.find(
        (x) => x.email === email && x.purpose === "password_reset" && x.used_at === null,
      );
      if (!unused || unused.expires_at <= Date.now()) {
        const now = Date.now();
        for (const t of db.emailTokens) {
          if (t.email === email && t.purpose === "password_reset" && t.used_at === null) t.used_at = now;
        }
        db.emailTokens.push({
          token: `mock-reset-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          email,
          purpose: "password_reset",
          expires_at: now + 60 * 60 * 1000, // 1h，与后端一致
          used_at: null,
          created_at: now,
        });
      }
      return ok({ ok: true, expires_in: 3600 });
    }

    if (seg[1] === "resend-verification" && method === "POST") {
      if (!logged) return fail(401, "Unauthorized");
      // 注意：`user` 常量在下方登录闸之后才声明，这里显式取一次会话用户
      const me = userFromCookie(db, req.cookie);
      if (me.email_verified_at) return fail(409, "邮箱已完成验证");
      const now = Date.now();
      const last = db.emailTokens
        .filter((x) => x.email === me.email.toLowerCase() && x.purpose === "email_verify" && x.used_at === null)
        .sort((a, b) => b.created_at - a.created_at)[0];
      if (last && now - last.created_at < 60_000) return fail(429, "请求过于频繁，请稍后再试");
      for (const t of db.emailTokens) {
        if (t.email === me.email.toLowerCase() && t.purpose === "email_verify" && t.used_at === null) t.used_at = now;
      }
      db.emailTokens.push({
        token: `mock-verify-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        email: me.email.toLowerCase(),
        purpose: "email_verify",
        expires_at: now + 24 * 60 * 60 * 1000, // 24h，与后端一致
        used_at: null,
        created_at: now,
      });
      return ok({ ok: true, expires_in: 24 * 60 * 60 });
    }

    if (seg[1] === "reset-password" && method === "POST") {
      const body = asRecord(req.body);
      const token = reqStr(body.token);
      const password = reqStr(body.password);
      if (!token) return fail(400, "重置链接无效或已过期");
      if (password.length < 8) return fail(400, "密码至少 8 位");
      const row = db.emailTokens.find((x) => x.token === token && x.purpose === "password_reset");
      if (!row || row.used_at !== null || row.expires_at <= Date.now()) {
        return fail(400, "重置链接无效或已过期");
      }
      const target = db.users.find((u) => u.email.toLowerCase() === row.email);
      if (!target) return fail(400, "重置链接无效或已过期");
      row.used_at = Date.now();
      db.passwords[target.id] = password;
      // 所有未用 token（含邮箱验证信）一并作废
      const now = Date.now();
      for (const t of db.emailTokens) {
        if (target && t.email === target.email.toLowerCase() && t.used_at === null) t.used_at = now;
      }
      return ok({ ok: true });
    }
  }

  // 以下全部需要登录
  if (!logged) return fail(401, "Unauthorized");
  const user = userFromCookie(db, req.cookie);

  // ---------- TEN-01 workspaces ----------
  // 镜像 backend/src/routes/workspaces.ts 的契约：列表按会话过滤、邀请只返回一次 token、
  // 邀请接受要求邮箱匹配且单次使用、owner 不可移除、成员可自行退出。
  if (seg[0] === "workspaces") {
    // POST /workspaces/invites/accept（注意：必须早于 /:id 分支，避免 "invites" 被当成 ID）
    if (seg[1] === "invites" && seg[2] === "accept" && method === "POST") {
      const body = asRecord(req.body);
      const token = reqStr(body.token);
      const invite = db.workspaceInvites.find(
        (x) => x.token === token && x.accepted_at === null && x.revoked_at === null && x.expires_at > Date.now(),
      );
      if (!invite || invite.email !== user.email.toLowerCase()) {
        return fail(404, "邀请不存在或已失效", "INVITE_INVALID");
      }
      const prior = db.workspaceMembers.find(
        (m) => m.workspace_id === invite.workspace_id && m.user_id === user.id,
      );
      if (prior?.active) return fail(409, "邀请已使用", "INVITE_ALREADY_MEMBER");
      invite.accepted_at = Date.now();
      db.workspaceMembers.push({
        id: nextId(db.workspaceMembers),
        workspace_id: invite.workspace_id,
        user_id: user.id,
        role: invite.role,
        active: true,
        created_at: nowIso(),
      });
      return ok({ workspace_id: invite.workspace_id });
    }

    // GET /workspaces：当前用户的所有 active 成员关系（含个人空间），带 role
    if (method === "GET" && seg[1] === undefined) {
      const mine = db.workspaceMembers.filter((m) => m.user_id === user.id && m.active);
      const rows: Workspace[] = [];
      for (const m of mine) {
        const ws = db.workspaces.find((w) => w.id === m.workspace_id);
        if (!ws) continue;
        rows.push({
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          kind: ws.kind,
          role: m.role,
          created_at: ws.created_at,
        });
      }
      rows.sort((a, b) => a.id - b.id);
      return ok(rows);
    }

    // POST /workspaces：创建团队空间，创建者为 owner（mock 同步发默认策略由后端负责）
    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const name = reqStr(body.name);
      if (!name || name.length > 120) return badRequest("工作空间名称必须为 1–120 个字符");
      const id = nextId(db.workspaces);
      const ws: Workspace = {
        id,
        name,
        slug: `team-${Date.now().toString(36)}`,
        kind: "team",
        created_at: nowIso(),
        role: "owner",
      };
      db.workspaces.push({
        id,
        slug: ws.slug,
        name,
        kind: "team",
        personal_user_id: null,
        created_by_id: user.id,
        created_at: nowIso(),
      });
      db.workspaceMembers.push({
        id: nextId(db.workspaceMembers),
        workspace_id: id,
        user_id: user.id,
        role: "owner",
        active: true,
        created_at: nowIso(),
      });
      return ok(ws);
    }

    // /workspaces/:id[/...]
    const id = parseId(seg[1]);
    if (id !== null) {
      const membership = db.workspaceMembers.find(
        (m) => m.workspace_id === id && m.user_id === user.id && m.active,
      );
      const ws = db.workspaces.find((w) => w.id === id);
      if (!membership || !ws) return notFound("工作空间不存在");

      // GET /:id/members：任一 active 成员可读
      if (method === "GET" && seg[2] === "members") {
        const rows: WorkspaceMember[] = db.workspaceMembers
          .filter((m) => m.workspace_id === id && m.active)
          .map((m) => {
            const u = db.users.find((x) => x.id === m.user_id);
            return { user_id: m.user_id, email: u?.email ?? "", role: m.role, created_at: m.created_at };
          })
          .sort((a, b) => a.user_id - b.user_id);
        return ok(rows);
      }

      // GET /:id/traffic：workspace 流量聚合（OPS-03，与后端 /workspaces/:id/traffic 同构）
      if (method === "GET" && seg[2] === "traffic") {
        const days = Math.max(1, Math.min(90, Number(q?.days ?? 14) || 14));
        // mock 里没有 workspace_id 归属的隧道集合，用 demo 用户的隧道近似：
        // 按隧道累计流量 {traffic, traffic_cost} 拆分到各隧道分组 + 补齐日界序列。
        const mine = db.tunnels.filter((t) => t.user_id === user.id);
        const rows: WorkspaceTrafficSummary["by_tunnel"] = mine.map((t) => ({
          tunnel_id: t.id,
          name: t.name,
          tunnel_type: t.tunnel_type,
          in_node_group_id: t.in_node_group_id,
          in_node_group_name: t.in_node_group?.name ?? null,
          traffic: Number((t.traffic / GB).toFixed(2)),
          traffic_cost: Number((t.traffic_cost ?? t.traffic / GB).toFixed(2)),
        }));
        const by_tunnel: WorkspaceTrafficSummary["by_tunnel"] = [...rows].sort(
          (a, b) => b.traffic - a.traffic || a.tunnel_id - b.tunnel_id,
        );
        const total_traffic = Number(by_tunnel.reduce((s, x) => s + x.traffic, 0).toFixed(2));
        const total_traffic_cost = Number(by_tunnel.reduce((s, x) => s + x.traffic_cost, 0).toFixed(2));
        const gb = (n: number) => Math.round(n * 1024 * 1024 * 1024);
        const by_day = Array.from({ length: days }, (_, i) => {
          const wave = 0.6 + Math.abs(Math.sin(i * 0.9)) * 0.8;
          const t = gb(Number(((total_traffic / days) * wave).toFixed(3)));
          return {
            date: new Date(seed.now.getTime() - (days - 1 - i) * 86400000).toISOString().slice(0, 10),
            traffic: t,
            traffic_cost: Number(((total_traffic_cost / days) * wave).toFixed(4)),
          };
        });
        const summary: WorkspaceTrafficSummary = {
          workspace_id: id,
          period: "total",
          since: new Date(seed.now.getTime() - (days - 1) * 86400000).toISOString(),
          total_traffic: gb(total_traffic),
          total_traffic_cost: total_traffic_cost,
          by_tunnel: by_tunnel.map((x) => ({ ...x, traffic: gb(x.traffic), traffic_cost: x.traffic_cost })),
          by_day,
          orphan_rows: 0,
        };
        return ok(summary);
      }

      // POST /:id/invites：仅 team + owner/admin；重复邮箱 409；成员+待接受邀请上限 5
      if (method === "POST" && seg[2] === "invites") {
        if (ws.kind !== "team" || (membership.role !== "owner" && membership.role !== "admin")) {
          return fail(403, "没有邀请权限", "FORBIDDEN");
        }
        const body = asRecord(req.body);
        const email = reqStr(body.email).toLowerCase();
        const role = (reqStr(body.role) || "member") as WorkspaceRole;
        if (!email || !/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email)) return badRequest("邮箱或角色不合法");
        if (role !== "admin" && role !== "member" && role !== "viewer") return badRequest("邮箱或角色不合法");
        if (db.workspaceMembers.some((m) => {
          const u = db.users.find((x) => x.id === m.user_id);
          return m.workspace_id === id && m.active && u?.email.toLowerCase() === email;
        })) {
          return fail(409, "该用户已经是工作空间成员", "ALREADY_MEMBER");
        }
        const activeCount = db.workspaceMembers.filter((m) => m.workspace_id === id && m.active).length;
        const pendingCount = db.workspaceInvites.filter(
          (x) => x.workspace_id === id && x.accepted_at === null && x.revoked_at === null && x.expires_at > Date.now(),
        ).length;
        const limit = 5;
        if (activeCount + pendingCount >= limit) {
          return fail(403, `工作空间成员数已达上限（${limit}）`, "MAX_MEMBERS");
        }
        // 重新邀请会把该邮箱旧的未用邀请作废（与后端 updateMany 语义一致）
        for (const old of db.workspaceInvites) {
          if (old.workspace_id === id && old.email === email && old.accepted_at === null && old.revoked_at === null) {
            old.revoked_at = Date.now();
          }
        }
        const token = `inv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
        const invite: MockWorkspaceInvite = {
          id: nextId(db.workspaceInvites),
          workspace_id: id,
          email,
          role,
          token,
          invited_by_id: user.id,
          expires_at: Date.now() + 7 * 86400000,
          accepted_at: null,
          revoked_at: null,
          created_at: Date.now(),
        };
        db.workspaceInvites.push(invite);
        const created: WorkspaceInvite = {
          id: invite.id,
          email,
          role,
          expires_at: new Date(invite.expires_at).toISOString(),
          token,
        };
        return ok(created);
      }

      // DELETE /:id/members/:userId：manage 角色，或 actor===target（退出）；owner 不可移除
      if (method === "DELETE" && seg[2] === "members" && parseId(seg[3]) !== null) {
        const targetId = parseId(seg[3])!;
        const target = db.workspaceMembers.find(
          (m) => m.workspace_id === id && m.user_id === targetId && m.active,
        );
        if (!target) return notFound("成员不存在");
        if (target.role === "owner") return fail(403, "不能移除 owner", "FORBIDDEN");
        if (user.id !== targetId && membership.role !== "owner" && membership.role !== "admin") {
          return fail(403, "没有移除权限", "FORBIDDEN");
        }
        target.active = false;
        return ok({ ok: true });
      }

      // GET /:id：当前空间详情（前端暂未使用，保留以对齐后端契约）
      if (method === "GET" && seg[2] === undefined) {
        return ok({
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          kind: ws.kind,
          created_at: ws.created_at,
          role: membership.role,
        });
      }
    }
  }

  // ---------- dashboard ----------
  if (seg[0] === "dashboard") {
    if (seg[1] === "stats") return ok(dashboardStats(db, user));
    if (seg[1] === "traffic") {
      const days = Math.max(1, Number(q?.days ?? 14) || 14);
      return ok(seed.mockTrafficPoints.slice(-days));
    }
  }

  // ---------- nodes（V4 user-facing） ----------
  if (seg[0] === "nodes") {
    if (method === "GET" && seg[1] === undefined) {
      return ok(db.nodes.map((node) => mockUserNode(db, node)));
    }

    const nodeId = parseId(seg[1]);
    if (nodeId !== null) {
      const node = db.nodes.find((row) => row.id === nodeId);
      if (!node) return notFound("节点不存在");
      const projected = mockUserNode(db, node);

      if (method === "POST" && seg[2] === "enrollment") {
        return ok(mockEnrollment(projected));
      }

      if (seg[2] === "bindings") {
        if (projected.role !== "ingress" && projected.role !== "both") {
          return badRequest("该节点不具备入口能力");
        }

        if (method === "GET" && seg[3] === undefined) {
          return ok(
            db.nodeBindings
              .filter((binding) => binding.ingress_node_id === nodeId)
              .map((binding) => mockBindingView(db, binding))
              .filter((binding): binding is NodeBinding => binding !== null),
          );
        }

        if (method === "POST" && seg[3] === undefined) {
          const body = asRecord(req.body);
          const egressId = reqNum(body.egress_node_id);
          if (egressId === undefined) return badRequest("出口节点 ID 不合法");
          const egressRaw = db.nodes.find((row) => row.id === egressId);
          if (!egressRaw) return notFound("出口节点不存在");
          const egress = mockUserNode(db, egressRaw);
          if (egress.id === projected.id) return badRequest("入口和出口不能是同一节点");
          if (egress.role !== "egress" && egress.role !== "both") {
            return badRequest("出口节点角色必须是 egress 或 both");
          }

          let binding = db.nodeBindings.find(
            (row) =>
              row.ingress_node_id === nodeId &&
              row.egress_node_id === egressId,
          );
          if (!binding) {
            binding = {
              id: nextId(db.nodeBindings),
              ingress_node_id: nodeId,
              egress_node_id: egressId,
              created_at: nowIso(),
            };
            db.nodeBindings.push(binding);
          }
          return ok(mockBindingView(db, binding));
        }

        const egressId = parseId(seg[3]);
        if (method === "DELETE" && egressId !== null) {
          const used = db.tunnels.filter((tunnel) => {
            const ingress = mockIngressNode(db, tunnel);
            return (
              tunnel.tunnel_mode === "relay" &&
              ingress?.id === nodeId &&
              tunnel.egress_node_id === egressId
            );
          }).length;
          if (used > 0) {
            return fail(
              409,
              `该出口仍被 ${used} 条端口转发使用，请先删除或改为其它出口`,
              "BINDING_IN_USE",
            );
          }
          db.nodeBindings = db.nodeBindings.filter(
            (row) =>
              !(
                row.ingress_node_id === nodeId &&
                row.egress_node_id === egressId
              ),
          );
          return ok({ ok: true });
        }
      }
    }

    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- forwards（V4 product API） ----------
  if (seg[0] === "forwards") {
    const id = parseId(seg[1]);

    if (method === "GET" && seg[1] === "summary") {
      const rows = db.tunnels
        .filter((tunnel) => tunnel.user_id === user.id && tunnel.category === "port_forward")
        .map((tunnel) => mockForwardView(db, tunnel));
      return ok({
        total: rows.length,
        direct: rows.filter((row) => row.mode === "direct").length,
        relay: rows.filter((row) => row.mode === "relay").length,
        active: rows.filter((row) => row.apply_status === "active").length,
        error: rows.filter((row) => row.apply_status === "error").length,
        suspended: rows.filter((row) => row.apply_status === "suspended").length,
        pending: rows.filter(
          (row) => row.apply_status === "pending" || row.apply_status === "applying",
        ).length,
        traffic: rows.reduce((sum, row) => sum + row.traffic, 0),
        traffic_cost: rows.reduce((sum, row) => sum + row.traffic_cost, 0),
      });
    }

    if (method === "GET" && seg[1] === undefined) {
      const mode = reqStr(q?.mode);
      const applyStatus = reqStr(q?.apply_status);
      const ingressNodeId = Number(q?.ingress_node_id);
      const egressNodeId = Number(q?.egress_node_id);
      const keyword = reqStr(q?.keyword).toLowerCase();
      let rows = db.tunnels
        .filter((tunnel) => tunnel.user_id === user.id && tunnel.category === "port_forward")
        .map((tunnel) => mockForwardView(db, tunnel));
      if (mode === "direct" || mode === "relay") {
        rows = rows.filter((row) => row.mode === mode);
      }
      if (Number.isInteger(ingressNodeId) && ingressNodeId > 0) {
        rows = rows.filter((row) => Number(row.ingress_node_id) === ingressNodeId);
      }
      if (Number.isInteger(egressNodeId) && egressNodeId > 0) {
        rows = rows.filter((row) => Number(row.egress_node_id) === egressNodeId);
      }
      if (APPLY_STATUSES.includes(applyStatus as (typeof APPLY_STATUSES)[number])) {
        rows = rows.filter((row) => row.apply_status === applyStatus);
      }
      if (keyword) {
        rows = rows.filter((row) =>
          [
            row.name,
            row.ingress_node?.node_id ?? "",
            row.egress_node?.node_id ?? "",
            row.target_host ?? "",
            String(row.target_port ?? ""),
          ].some((value) => value.toLowerCase().includes(keyword)),
        );
      }
      return ok(rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)));
    }

    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const name = reqStr(body.name);
      const mode = reqStr(body.mode);
      const ingressId = reqNum(body.ingress_node_id);
      const egressId = numOrNull(body.egress_node_id);
      const targetHost = reqStr(body.target_host);
      const targetPort = reqNum(body.target_port);
      const listenPort = numOrNull(body.listen_port);

      if (
        !name ||
        (mode !== "direct" && mode !== "relay") ||
        ingressId === undefined ||
        !targetHost ||
        targetPort === undefined ||
        targetPort < 1 ||
        targetPort > 65535 ||
        (listenPort !== null && (listenPort < 1 || listenPort > 65535))
      ) {
        return badRequest("端口转发参数不合法");
      }

      const ingressRaw = db.nodes.find((node) => node.id === ingressId);
      if (!ingressRaw) return notFound("入口节点不存在");
      const ingress = mockUserNode(db, ingressRaw);
      if (ingress.role !== "ingress" && ingress.role !== "both") {
        return badRequest("该节点不具备入口能力");
      }

      let egress: UserNode | null = null;
      if (mode === "relay") {
        if (egressId === null) return badRequest("RELAY 转发必须指定出口节点");
        const egressRaw = db.nodes.find((node) => node.id === egressId);
        if (!egressRaw) return notFound("出口节点不存在");
        egress = mockUserNode(db, egressRaw);
        if (egress.role !== "egress" && egress.role !== "both") {
          return badRequest("选择的节点不具备出口能力");
        }
        const bound = db.nodeBindings.some(
          (binding) =>
            binding.ingress_node_id === ingress.id &&
            binding.egress_node_id === egress!.id,
        );
        if (!bound) return fail(409, "该出口尚未绑定到当前入口节点", "BINDING_REQUIRED");
      } else if (egressId !== null) {
        return badRequest("DIRECT 转发不能指定出口节点");
      }

      const effectiveListenPort = listenPort ?? 20000 + nextId(db.tunnels);
      const conflict = db.tunnels.some((tunnel) => {
        const rowIngress = mockIngressNode(db, tunnel);
        return rowIngress?.id === ingress.id && tunnel.listen_port === effectiveListenPort;
      });
      if (conflict) return fail(409, "该入口端口已被占用", "PORT_CONFLICT");

      const newId = nextId(db.tunnels);
      const target =
        targetHost.includes(":") && !targetHost.startsWith("[")
          ? `[${targetHost}]:${targetPort}`
          : `${targetHost}:${targetPort}`;
      const created: Tunnel = {
        id: newId,
        name,
        tunnel_type: "tcp",
        category: "port_forward",
        listen_ip: "0.0.0.0",
        listen_port: effectiveListenPort,
        listen_protocol: ["tcp"],
        status: "active",
        forward_addresses: [target],
        forward_addresses_protocol: ["tcp"],
        load_balance_type: "round",
        ip_type: "ipv4",
        order_by: db.tunnels.reduce((max, row) => Math.max(max, row.order_by), 0) + 10,
        ip_limit: null,
        client_limit: null,
        bandwidth_limit: null,
        traffic: 0,
        traffic_cost: 0,
        proxy_protocol: false,
        in_node_group_id: ingress.node_group_id,
        in_node_group: groupRef(db, ingress.node_group_id) ?? undefined,
        out_node_group_id: egress?.node_group_id ?? null,
        out_node_group: egress ? groupRef(db, egress.node_group_id) ?? null : null,
        user_id: user.id,
        port_conflict_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        online: false,
        client_count: 0,
        tunnel_mode: mode,
        ingress_node_id: ingress.id,
        egress_node_id: egress?.id ?? null,
        egress_port: mode === "relay" ? 30000 + newId : null,
        egress_pool_id: null,
        egress_pool: null,
        remote_host: mode === "direct" ? targetHost : null,
        remote_port: mode === "direct" ? targetPort : null,
        desired_status: "active",
        apply_status: "pending",
        config_revision: 1,
        applied_revision: 0,
        apply_error_code: null,
        apply_error: null,
        last_applied_at: null,
      };
      db.tunnels.unshift(created);
      completeOrchestration(created);
      created.online = true;
      return ok(mockForwardView(db, created));
    }

    if (id !== null) {
      const tunnel = db.tunnels.find(
        (row) =>
          row.id === id &&
          row.user_id === user.id &&
          row.category === "port_forward",
      );
      if (!tunnel) return notFound("端口转发不存在");

      if (method === "GET" && seg[2] === "traffic") {
        const days = Math.max(1, Math.min(90, Number(q?.days ?? 14) || 14));
        return ok(tunnelTrafficSeries(tunnel.id, tunnel.traffic, days));
      }
      if (method === "GET" && seg[2] === undefined) {
        return ok(mockForwardView(db, tunnel));
      }
      if (method === "PATCH" && seg[2] === undefined) {
        // V4-WP4（镜像 V4-WP1 契约）：编辑 = 全字段 patch + expected_revision。
        // 校验只有一个实现：applyMockForwardPatch 与 preview 共用
        // resolveMockForwardCandidate，因此 preview 放行 ⇔ PATCH 接受。
        const body = asRecord(req.body);
        const patched = applyMockForwardPatch(db, tunnel, body as ForwardPatchInput);
        if (!patched.ok) {
          const e = patched.error;
          // 与后端 send() 的错误体同形：{ message, code, data }，
          // data.latest_revision 让 UI 能给出「最新 revision 是多少」。
          return fail(e.status, e.message, e.code, e.data);
        }
        return ok(patched.view);
      }
      if (method === "POST" && seg[2] === "preview") {
        // V4-WP1 §13.3.3 preview：保存前影响面，不写库。
        const body = asRecord(req.body);
        const previewed = previewMockForwardUpdate(db, tunnel, body as ForwardPatchInput);
        if (!previewed.ok) {
          const e = previewed.error;
          return fail(e.status, e.message, e.code, e.data);
        }
        return ok(previewed.result);
      }
      if (
        method === "POST" &&
        (seg[2] === "retry" ||
          seg[2] === "suspend" ||
          seg[2] === "resume")
      ) {
        const result = tunnelRuntimeAction(db, tunnel, seg[2]);
        if (result.status >= 400) return result;
        return ok(mockForwardView(db, tunnel));
      }
      if (method === "DELETE" && seg[2] === undefined) {
        db.tunnels.splice(db.tunnels.indexOf(tunnel), 1);
        return ok({ ok: true });
      }
    }

    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- tunnels ----------
  if (seg[0] === "tunnels") {
    const id = parseId(seg[1]);
    const sub = seg[2];

    if (method === "GET" && seg[1] === undefined) {
      // WP13：v3 过滤维度（apply_status / tunnel_mode / pending_only）叠加在
      // legacy 过滤之上；未知值一律忽略而不是返回空集（防 UI 传错值静默全空）。
      const applyFilter = reqStr(q?.apply_status);
      const modeFilter = reqStr(q?.tunnel_mode);
      const pendingOnly = q?.pending_only === true || q?.pending_only === "true" || q?.pending_only === "1";
      let mine = db.tunnels.filter((t) => t.user_id === user.id);
      if (APPLY_STATUSES.includes(applyFilter as (typeof APPLY_STATUSES)[number])) {
        mine = mine.filter((t) => applyStatusOf(t) === applyFilter);
      }
      if (TUNNEL_MODES.includes(modeFilter as (typeof TUNNEL_MODES)[number])) {
        mine = mine.filter((t) => t.tunnel_mode === modeFilter);
      }
      if (pendingOnly) {
        mine = mine.filter((t) => {
          const desired = t.config_revision ?? null;
          const applied = t.applied_revision ?? null;
          return desired !== null && applied !== null && applied < desired;
        });
      }
      return ok(paginate(filterByStatus(filterByKeyword(mine, q, ["name"]), q), q));
    }

    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const nameR = required(body, "name", "隧道名称", 60);
      if (isResponse(nameR)) return nameR;
      const ngId = reqNum(body.in_node_group_id);
      if (ngId === undefined) return badRequest("必须指定入口节点组");
      const ng = db.nodeGroups.find((g) => g.id === ngId);
      if (!ng) return notFound("入口节点组不存在");

      const outId = numOrNull(body.out_node_group_id);
      if (outId !== null && !db.nodeGroups.some((g) => g.id === outId)) return notFound("出口节点组不存在");

      const listenPort = numOrNull(body.listen_port);
      if (listenPort !== null && (listenPort < 1 || listenPort > 65535)) return badRequest("监听端口必须在 1-65535 之间");
      if (listenPort !== null && db.tunnels.some((t) => t.in_node_group_id === ng.id && t.listen_port === listenPort)) {
        return badRequest("监听端口已被占用", "PORT_CONFLICT");
      }

      // WP13：DIRECT / RELAY mode + 出口池选择。缺省 tunnel_mode 时：
      //   · 有 out_node_group_id 或 egress_pool_id → relay
      //   · 否则 legacy direct（存量路径不变）
      const rawMode = reqStr(body.tunnel_mode);
      const poolId = numOrNull(body.egress_pool_id);
      const outIdParsed = numOrNull(body.out_node_group_id);
      const mode: Tunnel["tunnel_mode"] =
        rawMode === "relay" || rawMode === "direct"
          ? (rawMode as TunnelMode)
          : poolId !== null || outIdParsed !== null
            ? "relay"
            : "direct";
      const relay = mode === "relay";

      const tunnelType = (reqStr(body.tunnel_type) || "tcp") as Tunnel["tunnel_type"];
      const newId = nextId(db.tunnels);

      // forward 目标只在 DIRECT 下必填；RELAY 的目标在 EgressTarget 上（池内），
      // 因此 RELAY 允许 forward_addresses 为空数组（与 backend WP11 契约一致）。
      const forward = Array.isArray(body.forward_addresses)
        ? body.forward_addresses.map((s) => reqStr(s)).filter(Boolean)
        : parseList(body.forward_addresses) ?? [];
      if (!relay && forward.length === 0) return badRequest("至少需要一个转发目标");
      const badAddr = forward.find((a) => !/^(\[[0-9a-fA-F:]+\]|[^:\s]+):\d{1,5}$/.test(a));
      if (badAddr) return badRequest(`转发目标格式应为 host:port（${badAddr}）`);
      const remoteHost = reqStr(body.remote_host) || null;
      const remotePort = numOrNull(body.remote_port);
      // 直连目标可写在 forward_addresses（存量契约）或 remote_host/remote_port
      // （v3 列）；后者缺失时从 forward[0] 拆一份，保证 DIRECT 详情可展示。
      const derivedFromForward = forward[0]?.match(/^(?:\[([^\]]+)\]|([^:\s]+)):(\d{1,5})$/) ?? null;
      const finalRemoteHost = remoteHost ?? (derivedFromForward ? (derivedFromForward[1] ?? derivedFromForward[2]) : null);
      const finalRemotePort = remotePort ?? (derivedFromForward ? Number(derivedFromForward[3]) : null);
      const created: Tunnel = {
        id: newId,
        name: nameR.value,
        tunnel_type: tunnelType,
        category: reqStr(body.category) === "remote_port_forward" ? "remote_port_forward" : "port_forward",
        listen_ip: reqStr(body.listen_ip) || "0.0.0.0",
        listen_port: listenPort ?? 20000 + newId,
        listen_protocol: [tunnelType],
        status: "active",
        forward_addresses: forward,
        forward_addresses_protocol: forward.map(() => tunnelType),
        load_balance_type: (reqStr(body.load_balance_type) || "round") as Tunnel["load_balance_type"],
        ip_type: (reqStr(body.ip_type) || "ipv4") as Tunnel["ip_type"],
        order_by: db.tunnels.reduce((m, x) => Math.max(m, x.order_by), 0) + 10,
        ip_limit: numOrNull(body.ip_limit),
        client_limit: numOrNull(body.client_limit),
        bandwidth_limit: numOrNull(body.bandwidth_limit),
        traffic: 0,
        traffic_cost: 0,
        proxy_protocol: Boolean(body.proxy_protocol),
        in_node_group_id: ng.id,
        in_node_group: { id: ng.id, name: ng.name, node_type: ng.node_type },
        out_node_group_id: outId,
        out_node_group: outId ? groupRef(db, outId) ?? null : null,
        user_id: user.id,
        port_conflict_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
        online: true,
        client_count: 0,
        // ── v3 增量列（WP13）：新行总是显式声明模式，不留给「未声明」──
        tunnel_mode: mode,
        remote_host: relay ? null : finalRemoteHost,
        remote_port: relay ? null : finalRemotePort,
        desired_status: "active",
        // 真实链路（§4.1）：persist_desired → pending → applying → active。
        // mock 创建后停在 pending（不做假 ACK），与后端的「期望状态已落库、
        // 尚未下发」一致；编排推进由后续运行操作/重算驱动。
        apply_status: "pending",
        config_revision: 1,
        applied_revision: 0,
        apply_error_code: null,
        apply_error: null,
        last_applied_at: null,
        egress_node_id: relay ? (poolId !== null ? poolOfNode(db, poolId) : null) : null,
        egress_port: relay ? 30000 + newId : null,
        egress_pool_id: relay ? poolId : null,
        egress_pool: relay ? poolRef(db, poolId) : null,
      };
      db.tunnels.push(created);
      return ok(created);
    }

    if (id !== null) {
      const t = db.tunnels.find((x) => x.id === id && x.user_id === user.id);
      if (!t) return notFound("隧道不存在");

      if (method === "GET" && sub === "traffic") {
        const days = Math.max(1, Number(q?.days ?? 14) || 14);
        return ok(tunnelTrafficSeries(t.id, t.traffic, days));
      }
      if (method === "GET" && sub === undefined) {
        return ok({ ...t, user: { id: t.user_id, email: db.users.find((u) => u.id === t.user_id)?.email ?? user.email } });
      }
      if (method === "PUT" || method === "PATCH") {
        if (sub === "toggle") {
          // 容错：部分客户端用 PUT 调 toggle
          t.status = t.status === "active" ? "inactive" : "active";
          t.online = t.status === "active";
          if (!t.online) t.client_count = 0;
          t.updated_at = nowIso();
          return ok(t);
        }
        const body = asRecord(req.body);
        if (body.name !== undefined) {
          const r = required(body, "name", "隧道名称", 60);
          if (isResponse(r)) return r;
          t.name = r.value;
        }
        if (body.in_node_group_id !== undefined) {
          const gid = numOrNull(body.in_node_group_id);
          const g = gid === null ? undefined : db.nodeGroups.find((x) => x.id === gid);
          if (!g) return notFound("入口节点组不存在");
          t.in_node_group_id = g.id;
          t.in_node_group = { id: g.id, name: g.name, node_type: g.node_type };
        }
        if (body.out_node_group_id !== undefined) {
          const oid = numOrNull(body.out_node_group_id);
          if (oid !== null && !db.nodeGroups.some((g) => g.id === oid)) return notFound("出口节点组不存在");
          t.out_node_group_id = oid;
          t.out_node_group = oid ? groupRef(db, oid) ?? null : null;
        }
        if (body.listen_port !== undefined) {
          const port = numOrNull(body.listen_port);
          if (port !== null && (port < 1 || port > 65535)) return badRequest("监听端口必须在 1-65535 之间");
          if (port !== null && db.tunnels.some((x) => x.id !== t.id && x.in_node_group_id === t.in_node_group_id && x.listen_port === port)) {
            return badRequest("监听端口已被占用", "PORT_CONFLICT");
          }
          t.listen_port = port;
        }
        if (body.forward_addresses !== undefined) {
          const forward = Array.isArray(body.forward_addresses)
            ? body.forward_addresses.map((s) => reqStr(s)).filter(Boolean)
            : parseList(body.forward_addresses) ?? [];
          if (forward.length === 0) return badRequest("至少需要一个转发目标");
          t.forward_addresses = forward;
          t.forward_addresses_protocol = forward.map(() => t.tunnel_type);
        }
        if (body.tunnel_type !== undefined) {
          t.tunnel_type = reqStr(body.tunnel_type) as Tunnel["tunnel_type"];
          t.listen_protocol = [t.tunnel_type];
          t.forward_addresses_protocol = t.forward_addresses.map(() => t.tunnel_type);
        }
        if (body.load_balance_type !== undefined) t.load_balance_type = reqStr(body.load_balance_type) as Tunnel["load_balance_type"];
        if (body.ip_type !== undefined) t.ip_type = reqStr(body.ip_type) as Tunnel["ip_type"];
        if (body.category !== undefined) {
          t.category = reqStr(body.category) === "remote_port_forward" ? "remote_port_forward" : "port_forward";
        }
        if (body.status !== undefined) {
          const s = reqStr(body.status);
          if (s !== "active" && s !== "inactive") return badRequest("状态不合法");
          t.status = s;
          t.online = s === "active";
        }
        if (body.order_by !== undefined) t.order_by = numOrNull(body.order_by) ?? t.order_by;
        for (const key of ["ip_limit", "client_limit", "bandwidth_limit"] as const) {
          if (body[key] !== undefined) t[key] = numOrNull(body[key]);
        }
        if (body.proxy_protocol !== undefined) t.proxy_protocol = Boolean(body.proxy_protocol);
        // WP13 v3 列：只写 desired state；revision 自增/编排重入归 WP11 orchestrator
        if (body.tunnel_mode !== undefined) {
          const m = reqStr(body.tunnel_mode);
          if (m !== "direct" && m !== "relay") return badRequest("tunnel_mode 只能是 direct / relay");
          t.tunnel_mode = m;
        }
        if (body.out_node_group_id !== undefined) {
          const oid = numOrNull(body.out_node_group_id);
          if (oid !== null && !db.nodeGroups.some((g) => g.id === oid)) return notFound("出口节点组不存在");
          t.out_node_group_id = oid;
          t.out_node_group = oid ? groupRef(db, oid) ?? null : null;
        }
        if (body.egress_pool_id !== undefined) {
          const pid = numOrNull(body.egress_pool_id);
          t.egress_pool_id = pid;
          t.egress_pool = poolRef(db, pid);
          if (pid !== null) t.egress_node_id = poolOfNode(db, pid);
        }
        if (body.egress_node_id !== undefined) {
          t.egress_node_id = numOrNull(body.egress_node_id);
        }
        if (body.remote_host !== undefined) t.remote_host = reqStr(body.remote_host) || null;
        if (body.remote_port !== undefined) t.remote_port = numOrNull(body.remote_port);
        if (body.desired_status !== undefined) {
          const ds = reqStr(body.desired_status);
          if (ds !== "active" && ds !== "inactive") return badRequest("desired_status 只能是 active / inactive");
          t.desired_status = ds;
          // resume 语义：期望重新启用 → 重新入编排（revision 前进）
          if (ds === "active" && applyStatusOf(t) === "suspended") {
            t.config_revision = (t.config_revision ?? 0) + 1;
            t.apply_status = "pending";
            completeOrchestration(t);
          }
        }
        // 任何 desired/配置变更都让隧道「待下发」：applied < config
        if (t.config_revision !== undefined && t.config_revision !== null) {
          t.config_revision = t.config_revision + 1;
        }
        t.updated_at = nowIso();
        return ok(t);
      }
      if (method === "DELETE" && sub === undefined) {
        db.tunnels.splice(db.tunnels.indexOf(t), 1);
        return ok({ ok: true, id: t.id });
      }
      if (method === "POST" && sub === "toggle") {
        t.status = t.status === "active" ? "inactive" : "active";
        t.online = t.status === "active";
        if (!t.online) t.client_count = 0;
        t.updated_at = nowIso();
        return ok(t);
      }
      // WP11 运行操作：retry / suspend / resume（统一走编排器语义）
      if (method === "POST" && (sub === "retry" || sub === "suspend" || sub === "resume")) {
        return tunnelRuntimeAction(db, t, sub);
      }
      if (method === "POST" && sub === "reset-traffic") {
        t.traffic = 0;
        t.traffic_cost = 0;
        t.updated_at = nowIso();
        return ok(t);
      }
    }
    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- node groups（用户侧：列表 + V4 节点部署） ----------
  if (seg[0] === "node-groups") {
    if (method === "GET" && seg[1] === undefined) {
      const items = filterByStatus(db.nodeGroups, q).map((g) => withGroupStats(db, g));
      return ok(paginate(items, q));
    }

    const groupId = parseId(seg[1]);
    if (method === "POST" && groupId !== null && seg[2] === "nodes") {
      const group = db.nodeGroups.find((row) => row.id === groupId);
      if (!group) return notFound("节点组不存在");
      const body = asRecord(req.body);
      const nodeKey = reqStr(body.node_id);
      if (!nodeKey) return badRequest("node_id / connect_ip / role 不合法");
      if (db.nodes.some((node) => node.node_id === nodeKey)) {
        return fail(409, "节点 ID 已存在", "NODE_EXISTS");
      }

      const roleRaw = reqStr(body.role);
      const role =
        roleRaw === "ingress" || roleRaw === "egress" || roleRaw === "both"
          ? roleRaw
          : group.node_type === "out"
            ? "egress"
            : "ingress";
      const range = group.port_range?.split("-").map(Number) ?? [];
      const portMin = range.length === 2 && Number.isInteger(range[0]) ? range[0]! : null;
      const portMax = range.length === 2 && Number.isInteger(range[1]) ? range[1]! : null;
      if (
        portMin === null ||
        portMax === null ||
        portMin < 1 ||
        portMax > 65535 ||
        portMin > portMax
      ) {
        return fail(409, "节点组未配置可用于 v3 的连续端口范围", "PORT_RANGE_REQUIRED");
      }

      const id = nextId(db.nodes);
      const created: Node = {
        id,
        node_id: nodeKey,
        agent_id: `mock-agent-${id}-${Math.random().toString(36).slice(2, 8)}`,
        weight: 10,
        status: "active",
        connect_ip: reqStr(body.connect_ip) || null,
        version: "pending",
        backup: false,
        order_by: db.nodes.reduce((max, node) => Math.max(max, node.order_by), 0) + 10,
        custom_line: null,
        dns_status: false,
        node_group_id: group.id,
        node_group: { id: group.id, name: group.name, node_type: group.node_type },
        created_at: nowIso(),
        updated_at: nowIso(),
        online: false,
        traffic: 0,
        role,
        last_seen_at: null,
        port_range_min: portMin,
        port_range_max: portMax,
        lb_strategy: "round",
        has_credential: false,
        credential_revoked: false,
        credential_rotated_at: null,
        credential_last_rejected_at: null,
      };
      db.nodes.push(created);
      const projected = mockUserNode(db, created);
      return ok({
        node: projected,
        enrollment: mockEnrollment(projected),
      });
    }

    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- WP11 / WP13：用户侧可用出口池（创建 RELAY 隧道时选池） ----------
  // admin 侧 WP10 的 /admin/node/pools 是管理端全量视图（需要 admin 权限）；
  // 用户侧只暴露「有出口能力节点上的 active 池」，且只读池内目标摘要，
  // 不下发 node 主键之外的管理字段（不发明字段：字段名与 EgressPool/EgressTarget 对齐）。
  if (seg[0] === "egress-pools" && method === "GET") {
    const options: TunnelEgressPoolOption[] = [];
    for (const [nodeId, pools] of db.egressPools) {
      const node = db.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      // 出口能力：role=egress|both（ingress 节点不配池，§2.2 硬规则）
      if (node.role !== "egress" && node.role !== "both") continue;
      for (const p of pools) {
        if (p.status !== "active") continue;
        options.push({
          id: p.id,
          name: p.name,
          node_id: nodeId,
          node_label: `${node.node_id} (${node.connect_ip})`,
          lb_strategy: p.lb_strategy ?? null,
          status: p.status,
          targets: (db.egressTargets.get(p.id) ?? [])
            .filter((t) => t.status === "active")
            .map((t) => ({ host: t.host, port: t.port, weight: t.weight, status: t.status })),
        });
      }
    }
    const sorted = options.sort((a, b) => a.node_id - b.node_id || a.id - b.id);
    if (q?.pool_id !== undefined) {
      const want = Number(q.pool_id);
      return ok(sorted.filter((p) => p.id === want));
    }
    return ok(sorted);
  }

  // ---------- plans ----------
  if (seg[0] === "plans") {
    if (seg[1] === "purchase" && method === "POST") {
      const body = asRecord(req.body);
      const planId = reqNum(body.plan_id);
      if (planId === undefined) return badRequest("缺少 plan_id");
      const plan = db.plans.find((p) => p.id === planId);
      if (!plan) return notFound("套餐不存在");
      if (plan.status !== "active") return badRequest("该套餐已下架");
      if (plan.stock !== null && plan.stock <= 0) return badRequest("库存不足");

      const setupFee = plan.setup_fee ?? 0;
      let total = plan.price + setupFee;
      const couponCode = reqStr(body.coupon).toUpperCase();
      let couponId: number | null = null;
      if (couponCode) {
        const coupon = COUPONS[couponCode];
        if (!coupon) return badRequest("优惠码无效");
        couponId = 1;
        total = coupon.type === "percent" ? total * (1 - coupon.value / 100) : total - coupon.value;
        total = Number(Math.max(0, total).toFixed(2));
      }
      if (user.balance < total) return badRequest("余额不足，请先充值");

      // 1) 扣款 + 记账
      creditBalance(db, user, -total, "plan");
      if (plan.stock !== null) plan.stock = Math.max(0, plan.stock - 1);

      // 2) 订单
      const order: PlanOrder = {
        id: nextId(db.planOrders),
        user_id: user.id,
        user: { id: user.id, email: user.email },
        plan_id: plan.id,
        plan: { id: plan.id, name: plan.name, price: plan.price, billing_cycle: plan.billing_cycle },
        price: total,
        balance: user.balance,
        coupon_id: couponId,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.planOrders.unshift(order);

      // 3) 订阅：同套餐续期，否则换新
      const days = CYCLE_DAYS[plan.billing_cycle];
      const existing = db.userPlans.find((p) => p.user_id === user.id);
      let userPlan: UserPlan;
      if (existing && existing.plan_id === plan.id) {
        const base = Math.max(Date.now(), existing.expired_at ? Date.parse(existing.expired_at) : Date.now());
        existing.expired_at = plan.billing_cycle === "lifetime" ? null : new Date(base + days * 86400000).toISOString();
        existing.traffic = plan.traffic === null ? null : plan.traffic * GB;
        existing.max_tunnels = plan.max_tunnels;
        existing.plan = plan;
        existing.updated_at = nowIso();
        userPlan = existing;
      } else if (existing) {
        existing.plan_id = plan.id;
        existing.plan = plan;
        existing.expired_at = plan.billing_cycle === "lifetime" ? null : new Date(Date.now() + days * 86400000).toISOString();
        existing.traffic = plan.traffic === null ? null : plan.traffic * GB;
        existing.traffic_used = 0;
        existing.max_tunnels = plan.max_tunnels;
        if (existing.whitelist_ips && plan.whitelist_limit !== null) {
          existing.whitelist_ips = existing.whitelist_ips.slice(0, plan.whitelist_limit);
        }
        existing.updated_at = nowIso();
        userPlan = existing;
      } else {
        userPlan = {
          id: nextId(db.userPlans),
          user_id: user.id,
          traffic: plan.traffic === null ? null : plan.traffic * GB,
          traffic_used: 0,
          max_tunnels: plan.max_tunnels,
          whitelist_ips: null,
          expired_at: plan.billing_cycle === "lifetime" ? null : new Date(Date.now() + days * 86400000).toISOString(),
          plan_id: plan.id,
          plan,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        db.userPlans.push(userPlan);
      }
      user.user_plan = userPlan;

      return ok({
        ok: true,
        order_id: order.id,
        plan_id: plan.id,
        price: total,
        balance: user.balance,
        user_plan: userPlan,
      });
    }

    if (method === "GET" && seg[1] === undefined) {
      return ok(paginate(filterByStatus(filterByKeyword(db.plans, q, ["name"]), q), q));
    }
    const id = parseId(seg[1]);
    if (method === "GET" && id !== null) {
      const plan = db.plans.find((p) => p.id === id);
      return plan ? ok(plan) : notFound("套餐不存在");
    }
  }

  // ---------- payments / topups ----------
  if (seg[0] === "payments" && method === "GET") {
    return ok(
      db.payments
        .filter((p) => p.status === "active")
        .sort((a, b) => a.order_by - b.order_by)
        .map((p) => ({ id: p.id, name: p.name, method: p.method })),
    );
  }

  if (seg[0] === "topups") {
    if (method === "GET" && seg[1] === undefined) {
      autoSettleTopups(db);
      const mine = db.topupOrders.filter((o) => o.user_id === user.id);
      return ok(paginate(filterByStatus(filterByKeyword(mine, q, ["order_id"]), q), q));
    }

    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const amount = numOrNull(body.amount);
      if (amount === null) return badRequest("充值金额必须是数字");
      if (amount < 1) return badRequest("单次充值最少 ¥1.00");
      if (amount > 100000) return badRequest("单次充值最多 ¥100000.00");
      const payment = db.payments.find((p) => p.id === reqNum(body.payment_id));
      if (!payment) return badRequest("支付方式不可用");
      if (payment.status !== "active") return badRequest("支付方式已停用");

      const bonus = amount >= 100 ? Number((amount * 0.05).toFixed(2)) : 0;
      const order_id = topupOrderNo(db);
      const order: TopupOrder = {
        id: nextId(db.topupOrders),
        user_id: user.id,
        user: { id: user.id, email: user.email },
        price: Number(amount.toFixed(2)),
        balance: 0,
        bonus,
        payment_id: payment.id,
        payment: { id: payment.id, name: payment.name, method: payment.method },
        pay_url: payUrlFor(order_id, payment),
        status: "pending",
        order_id,
        trade_id: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.topupOrders.unshift(order);
      // auto_pay / settle=true：立即模拟支付成功（便于自动化与演示）
      if (Boolean(body.auto_pay) || Boolean(body.settle)) settleTopup(db, order);
      return ok(order);
    }

    const id = parseId(seg[1]);
    if (id !== null) {
      const order = db.topupOrders.find((o) => o.id === id && o.user_id === user.id);
      if (!order) return notFound("充值订单不存在");
      if (method === "GET" && seg[2] === undefined) return ok(order);
      if (method === "POST" && (seg[2] === "pay" || seg[2] === "settle")) {
        if (order.status !== "pending") return badRequest("该订单已结束，无法支付");
        return ok(settleTopup(db, order));
      }
      if (method === "POST" && seg[2] === "cancel") {
        if (order.status !== "pending") return badRequest("该订单已结束，无法取消");
        order.status = "cancelled";
        order.updated_at = nowIso();
        return ok(order);
      }
    }
    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- tickets ----------
  if (seg[0] === "tickets") {
    if (method === "GET" && seg[1] === undefined) {
      const mine = db.tickets.filter((t) => t.user_id === user.id);
      return ok(paginate(filterByStatus(filterByKeyword(mine, q, ["title"]), q), q));
    }
    if (method === "POST" && seg[1] === undefined) {
      const body = asRecord(req.body);
      const titleR = required(body, "title", "工单标题", 100);
      if (isResponse(titleR)) return titleR;
      const contentR = required(body, "content", "工单内容", 5000);
      if (isResponse(contentR)) return contentR;
      const ticket: Ticket = {
        id: nextId(db.tickets),
        title: titleR.value,
        content: contentR.value,
        status: "open",
        user_id: user.id,
        user: { id: user.id, email: user.email },
        replies: [],
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.tickets.unshift(ticket);
      return ok(ticket);
    }
    const id = parseId(seg[1]);
    if (id !== null) {
      const ticket = db.tickets.find((t) => t.id === id && t.user_id === user.id);
      if (!ticket) return notFound("工单不存在");
      if (method === "GET" && seg[2] === undefined) return ok(ticket);
      if ((method === "PUT" || method === "PATCH") && seg[2] === undefined) {
        const body = asRecord(req.body);
        if (body.status !== undefined) {
          const s = reqStr(body.status);
          if (s !== "open" && s !== "closed") return badRequest("工单状态不合法");
          ticket.status = s;
        }
        if (body.title !== undefined) {
          const r = required(body, "title", "工单标题", 100);
          if (isResponse(r)) return r;
          ticket.title = r.value;
        }
        ticket.updated_at = nowIso();
        return ok(ticket);
      }
      if (method === "DELETE" && seg[2] === undefined) {
        db.tickets.splice(db.tickets.indexOf(ticket), 1);
        return ok({ ok: true, id: ticket.id });
      }
      if (method === "POST" && seg[2] === "replies") {
        const body = asRecord(req.body);
        const contentR = required(body, "content", "回复内容", 5000);
        if (isResponse(contentR)) return contentR;
        if (ticket.status === "closed") return badRequest("工单已关闭，无法回复");
        const reply: TicketReply = {
          id: nextId(ticket.replies ?? []),
          content: contentR.value,
          is_admin: Boolean(body.is_admin) || user.super_admin,
          ticket_id: ticket.id,
          user_id: user.id,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        ticket.replies = [...(ticket.replies ?? []), reply];
        ticket.updated_at = nowIso();
        return ok(reply);
      }
    }
    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- settings（个人中心） ----------
  if (seg[0] === "settings") {
    if (seg[1] === "profile" && method === "GET") return ok(user);
    if (seg[1] === "profile" && (method === "PATCH" || method === "PUT")) {
      const body = asRecord(req.body);
      if (typeof body.email === "string") {
        const email = body.email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("邮箱格式不正确");
        if (db.users.some((x) => x.id !== user.id && x.email.toLowerCase() === email)) return badRequest("该邮箱已被占用");
        user.email = email;
      }
      Object.assign(user, pick<User>(body, ["note", "tg_id", "auto_renew"]));
      user.updated_at = nowIso();
      return ok(user);
    }
    if (seg[1] === "password" && method === "POST") {
      const body = asRecord(req.body);
      const current = reqStr(body.current_password);
      const next = reqStr(body.new_password);
      if (!current || !next) return badRequest("缺少必填字段");
      const expected = db.passwords[user.id] ?? seed.DEMO_CREDENTIALS.password;
      if (current !== expected) return badRequest("当前密码不正确");
      if (next.length < 6) return badRequest("新密码至少 6 位");
      db.passwords[user.id] = next;
      return ok({ ok: true });
    }
    // SEC-02 对齐：mock 轮换后明文列同样「只出现一次」——
    // 响应里回明文，但 user 对象上的 api_key 归 null（后端只存 sha256 哈希列）。
    // 前端一次性展示区读的是响应顶层字段，不是 user.*，故此形状即真实契约。
    if (seg[1] === "api-key" && method === "POST") {
      const rand = () => Math.random().toString(16).slice(2, 10);
      const key = `rk_live_${rand()}${rand()}`;
      user.api_key = null;
      user.updated_at = nowIso();
      return ok({ ok: true, api_key: key, user });
    }
    if (seg[1] === "subscription-key" && method === "POST") {
      const rand = () => Math.random().toString(16).slice(2, 10);
      const key = `sk_sub_${rand()}${rand()}`;
      user.subscription_key = null;
      user.updated_at = nowIso();
      return ok({ ok: true, subscription_key: key, user });
    }
  }

  // ---------- admin ----------
  if (seg[0] === "admin") {
    if (!user.super_admin) return fail(403, "需要管理员权限");

    if (seg[1] === "stats" && method === "GET") return ok(adminStats(db));

    // ----- meta/resources（权限元数据，渲染角色编辑器） -----
    if (seg[1] === "meta" && seg[2] === "resources" && method === "GET") {
      const isSuper = user.super_admin;
      return ok({
        resources: ADMIN_RESOURCES.map((r) => ({
          ...r,
          apiPrefixes: [] as string[],
          granted: isSuper ? "write" : null,
        })),
      });
    }

    // ----- role（RBAC 角色，仅超管） -----
    if (seg[1] === "role") {
      const userCount = (roleId: number) => db.users.filter((u) => (u.admin_roles ?? []).some((r) => r.id === roleId)).length;
      if (method === "GET" && seg[2] === undefined) {
        return ok(db.adminRoles.map((r) => ({ ...r, _count: { users: userCount(r.id) } })));
      }
      if (method === "POST" && seg[2] === undefined) {
        const body = asRecord(req.body);
        const name = reqStr(body.name);
        if (!name) return badRequest("名称不能为空");
        if (db.adminRoles.some((r) => r.name === name)) return fail(409, "角色名称已存在");
        const role: AdminRole = {
          id: nextId(db.adminRoles),
          name,
          description: reqStr(body.description) || null,
          permissions: sanitizePermissions(body.permissions),
          _count: { users: 0 },
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        db.adminRoles.push(role);
        return ok(role);
      }
      const rid = parseId(seg[2]);
      if (rid !== null) {
        const role = db.adminRoles.find((r) => r.id === rid);
        if (!role) return notFound("角色不存在");
        if (method === "PUT" || method === "PATCH") {
          const body = asRecord(req.body);
          if (body.name !== undefined) {
            const name = reqStr(body.name);
            if (!name) return badRequest("名称不能为空");
            if (db.adminRoles.some((r) => r.id !== rid && r.name === name)) return fail(409, "角色名称已存在");
            role.name = name;
          }
          if (body.description !== undefined) role.description = reqStr(body.description) || null;
          if (body.permissions !== undefined) role.permissions = sanitizePermissions(body.permissions);
          role.updated_at = nowIso();
          return ok(role);
        }
        if (method === "DELETE") {
          const using = userCount(rid);
          if (using > 0) return fail(409, `该角色仍被 ${using} 个用户使用，请先解除分配`);
          db.adminRoles.splice(db.adminRoles.indexOf(role), 1);
          return ok({ ok: true, id: rid });
        }
      }
    }

    // ----- user/:id/roles（给用户分配角色，仅超管） -----
    if (seg[1] === "user" && parseId(seg[2]) !== null && seg[3] === "roles" && (method === "PUT" || method === "PATCH")) {
      const uid = parseId(seg[2])!;
      const target = db.users.find((u) => u.id === uid);
      if (!target) return notFound("用户不存在");
      const body = asRecord(req.body);
      const ids: number[] = Array.isArray(body.admin_role_ids) ? (body.admin_role_ids as number[]) : [];
      target.admin_roles = db.adminRoles.filter((r) => ids.includes(r.id));
      target.updated_at = nowIso();
      return ok({ id: target.id, admin_roles: target.admin_roles });
    }

    // ----- system/config（系统设置） -----
    if (seg[1] === "system" && seg[2] === "config") {
      if (method === "GET" && seg[3] === undefined) return ok(db.systemConfig);
      if (method === "PUT" && seg[3] !== undefined) {
        const name = seg[3];
        const body = asRecord(req.body);
        if (typeof body.value !== "string") return badRequest("value 必须为字符串");
        const row = db.systemConfig.find((c) => c.name === name);
        if (row) {
          row.value = body.value;
          row.updated_at = nowIso();
          return ok({ name, value: body.value });
        }
        const created = {
          id: nextId(db.systemConfig),
          name,
          value: body.value,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        db.systemConfig.push(created);
        return ok({ name, value: body.value });
      }
    }

    // ----- license -----
    if (seg[1] === "license" && seg[2] === undefined && method === "GET") {
      return ok(db.license ?? { type: "none" });
    }

    // ----- balance-logs（管理端全量余额流水） -----
    if (seg[1] === "balance-logs" && method === "GET") {
      return ok(paginate(filterByStatus(db.balanceLogs, q), q));
    }

    // ----- users -----
    if (seg[1] === "users") {
      if (method === "GET" && seg[2] === undefined) {
        const items = filterByStatus(filterByKeyword(db.users, q, ["email", "uid"]), q);
        return ok(paginate(items, q));
      }
      if (method === "POST" && seg[2] === undefined) {
        const body = asRecord(req.body);
        const emailR = required(body, "email", "邮箱", 120);
        if (isResponse(emailR)) return emailR;
        const email = emailR.value.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("邮箱格式不正确");
        if (db.users.some((u) => u.email.toLowerCase() === email)) return badRequest("该邮箱已存在");
        const id = nextId(db.users);
        const created: User = {
          id,
          email,
          super_admin: Boolean(body.super_admin),
          balance: numOrNull(body.balance) ?? 0,
          commission_balance: numOrNull(body.commission_balance) ?? 0,
          tg_id: reqStr(body.tg_id) || null,
          uid: reqStr(body.uid) || `RX-${100000 + id}`,
          note: reqStr(body.note) || null,
          parent_id: numOrNull(body.parent_id),
          referral_commission_rate: numOrNull(body.referral_commission_rate),
          auto_renew: Boolean(body.auto_renew),
          api_key: `rk_live_${Math.random().toString(16).slice(2, 18)}`,
          subscription_key: `sk_sub_${Math.random().toString(16).slice(2, 18)}`,
          status: reqStr(body.status) === "inactive" ? "inactive" : "active",
          email_verified_at: null,
          created_at: nowIso(),
          updated_at: nowIso(),
        };
        db.users.push(created);
        if (reqStr(body.password)) db.passwords[id] = reqStr(body.password);
        return ok(created);
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const target = db.users.find((u) => u.id === id);
        if (!target) return notFound("用户不存在");
        if (method === "GET" && seg[3] === undefined) {
          return ok({ ...target, user_plan: db.userPlans.find((p) => p.user_id === target.id) ?? null });
        }
        if ((method === "PUT" || method === "PATCH") && seg[3] === undefined) {
          const body = asRecord(req.body);
          if (body.email !== undefined) {
            const emailR = required(body, "email", "邮箱", 120);
            if (isResponse(emailR)) return emailR;
            const email = emailR.value.toLowerCase();
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return badRequest("邮箱格式不正确");
            if (db.users.some((u) => u.id !== target.id && u.email.toLowerCase() === email)) return badRequest("该邮箱已注册");
            target.email = email;
          }
          if (body.status !== undefined) {
            const s = reqStr(body.status);
            if (s !== "active" && s !== "inactive") return badRequest("状态不合法");
            target.status = s;
          }
          if (body.balance !== undefined) {
            const nb = numOrNull(body.balance);
            if (nb === null) return badRequest("余额必须是数字");
            creditBalance(db, target, Number((nb - target.balance).toFixed(2)), "admin_adjust");
          }
          if (body.commission_balance !== undefined) {
            const cb = numOrNull(body.commission_balance);
            if (cb === null) return badRequest("佣金余额必须是数字");
            target.commission_balance = cb;
          }
          if (body.note !== undefined) target.note = reqStr(body.note) || null;
          if (body.uid !== undefined) target.uid = reqStr(body.uid) || null;
          if (body.tg_id !== undefined) target.tg_id = reqStr(body.tg_id) || null;
          if (body.super_admin !== undefined) target.super_admin = Boolean(body.super_admin);
          if (body.auto_renew !== undefined) target.auto_renew = Boolean(body.auto_renew);
          if (body.referral_commission_rate !== undefined) {
            target.referral_commission_rate = numOrNull(body.referral_commission_rate);
          }
          if (body.password !== undefined) {
            const pwd = reqStr(body.password);
            if (pwd.length < 6) return badRequest("密码至少 6 位");
            db.passwords[target.id] = pwd;
          }
          target.updated_at = nowIso();
          return ok(target);
        }
        if (method === "DELETE" && seg[3] === undefined) {
          if (target.id === user.id) return badRequest("不能删除当前登录账号");
          if (db.tunnels.some((t) => t.user_id === target.id)) return badRequest("该用户仍有隧道，请先删除隧道");
          db.users.splice(db.users.indexOf(target), 1);
          const planIdx = db.userPlans.findIndex((p) => p.user_id === target.id);
          if (planIdx >= 0) db.userPlans.splice(planIdx, 1);
          delete db.passwords[target.id];
          return ok({ ok: true, id: target.id });
        }
      }
    }

    // ----- nodes -----
    if (seg[1] === "nodes") {
      if (method === "GET" && seg[2] === undefined) {
        return ok(paginate(filterByStatus(filterByKeyword(db.nodes, q, ["node_id", "connect_ip"]), q), q));
      }
      if (method === "POST" && seg[2] === undefined) {
        const parsed = readNodePayload(db, asRecord(req.body), false);
        if (isResponse(parsed)) return parsed;
        const id = nextId(db.nodes);
        const node: Node = {
          id,
          node_id: parsed.patch.node_id ?? `node-${id}`,
          weight: parsed.patch.weight ?? 10,
          status: parsed.patch.status ?? "active",
          connect_ip: parsed.patch.connect_ip ?? "0.0.0.0",
          version: parsed.patch.version ?? "1.0.0",
          backup: parsed.patch.backup ?? false,
          order_by: parsed.patch.order_by ?? db.nodes.reduce((m, x) => Math.max(m, x.order_by), 0) + 10,
          custom_line: parsed.patch.custom_line ?? null,
          dns_status: parsed.patch.dns_status ?? false,
          node_group_id: parsed.patch.node_group_id ?? db.nodeGroups[0]?.id ?? 1,
          node_group: parsed.patch.node_group,
          created_at: nowIso(),
          updated_at: nowIso(),
          online: (parsed.patch.status ?? "active") === "active",
          traffic: 0,
          // v3 新列：未声明就是 null（存量节点迁移进来的行就是空值，mock 必须复刻这一点）
          role: parsed.patch.role ?? null,
          port_range_min: parsed.patch.port_range_min ?? null,
          port_range_max: parsed.patch.port_range_max ?? null,
          lb_strategy: parsed.patch.lb_strategy ?? null,
          last_seen_at: null,
          // v3 凭据派生字段：新节点 = 从未签发（hash 为 null → has_credential=false）
          has_credential: false,
          credential_revoked: false,
          credential_rotated_at: null,
          credential_last_rejected_at: null,
        };
        db.nodes.push(node);
        return ok(node);
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const node = db.nodes.find((n) => n.id === id);
        if (!node) return notFound("节点不存在");
        if (method === "GET" && seg[3] === undefined) {
          // GET /admin/nodes/:id —— WP12 详情页聚合契约（NodeDetail）：
          // 基础字段（含凭据派生字段） + 出口池 + 最近一条状态上报。
          // 后端 WP10 未合并前 mock 直接按这个形状返回，前端零改动切换真实 API。
          return ok({
            ...node,
            pools: (db.egressPools.get(node.id) ?? []).map((p) => ({
              ...p,
              targets: db.egressTargets.get(p.id) ?? [],
            })),
            state: db.nodeStates.get(node.id) ?? null,
          });
        }
        if ((method === "PUT" || method === "PATCH") && seg[3] === undefined) {
          const parsed = readNodePayload(db, asRecord(req.body), true, id);
          if (isResponse(parsed)) return parsed;
          Object.assign(node, parsed.patch);
          if (parsed.patch.status !== undefined) node.online = parsed.patch.status === "active";
          node.updated_at = nowIso();
          return ok(node);
        }
        if (method === "DELETE" && seg[3] === undefined) {
          db.nodes.splice(db.nodes.indexOf(node), 1);
          db.nodeCredentials.delete(node.id);
          db.egressPools.delete(node.id);
          return ok({ ok: true, id: node.id });
        }
        // ----- WP12 出口池：/admin/nodes/:id/pools[/:poolId[/targets[/:targetId]]] -----
        if (seg[3] === "pools") return handleEgressPools(db, node, method, seg.slice(4), req);
        // ----- WP12 运行态：/admin/nodes/:id/state -----
        if (seg[3] === "state" && method === "GET") {
          return ok(db.nodeStates.get(node.id) ?? null);
        }
      }
    }

    // ----- WP12 凭据：/admin/node/:id/credential[/rotate|/revoke] -----
    // 路径是单数 node（不是 nodes），与后端已合并的 WP7 路由一致。
    // 注意 path 已被 split("/")，所以 action 是 seg[3]，rotate/revoke 在 seg[4]。
    if (seg[1] === "node" && method === "POST" && seg[3] === "credential") {
      const id = parseId(seg[2]);
      if (id !== null) {
        const node = db.nodes.find((n) => n.id === id);
        if (!node) return notFound("节点不存在");
        const action = seg[4]; // undefined | "rotate" | "revoke"
        if (action === "revoke") {
          // 吊销：哈希保留 + revoked 位置位。响应只回 { revoked: true }，
          // 绝不把明文再吐出来一次（契约：NodeCredentialRevoked）
          if (!node.has_credential) return badRequest("该节点尚未签发凭据，无法吊销");
          if (node.credential_revoked) return badRequest("凭据已处于吊销状态");
          node.credential_revoked = true;
          node.credential_last_rejected_at = nowIso();
          node.updated_at = nowIso();
          const revokedBody: NodeCredentialRevoked = { revoked: true, node_id: node.id, node_key: node.node_id };
          return ok(revokedBody);
        }
        // 签发（/credential）或轮转（/credential/rotate）：明文只在本次响应可见
        const isRotate = action === "rotate";
        if (action !== undefined && !isRotate) return notFound("接口不存在");
        const issued = db.nodeCredentials.get(node.id);
        if (isRotate && !node.has_credential) {
          return badRequest("当前没有生效凭据，无法轮转（请先签发）");
        }
        const rotation = (issued?.rotation_count ?? (node.has_credential ? 1 : 0)) + 1;
        const issuedAt = nowIso();
        db.nodeCredentials.set(node.id, {
          rotation_count: rotation,
          issued_at: issuedAt,
          last_rejected_at: issued?.last_rejected_at ?? null,
        });
        node.has_credential = true;
        node.credential_revoked = false;
        node.credential_rotated_at = issuedAt;
        node.credential_last_rejected_at = null;
        node.updated_at = issuedAt;
        // mock 假 token：真实后端也只在该响应里给一次明文（NodeCredentialIssued）
        const credential = `tunx_mock_${node.node_id}_${rotation}_${Math.random().toString(36).slice(2, 10)}`;
        const issuedBody: NodeCredentialIssued = {
          credential,
          node_id: node.id,
          node_key: node.node_id,
          ...(isRotate ? { rotated_at: issuedAt } : { issued_at: issuedAt }),
        };
        return ok(issuedBody);
      }
    }

    // ----- node-groups -----
    if (seg[1] === "node-groups") {
      if (method === "GET" && seg[2] === undefined) {
        const items = filterByStatus(filterByKeyword(db.nodeGroups, q, ["name", "token"]), q).map((g) => withGroupStats(db, g));
        return ok(paginate(items, q));
      }
      if (method === "POST" && seg[2] === undefined) {
        const parsed = readNodeGroupPayload(db, asRecord(req.body), false);
        if (isResponse(parsed)) return parsed;
        const id = nextId(db.nodeGroups);
        const group: NodeGroup = {
          id,
          token: parsed.patch.token ?? `ng_${id}`,
          name: parsed.patch.name ?? `节点组 ${id}`,
          port_range: parsed.patch.port_range ?? null,
          connect_ip: parsed.patch.connect_ip ?? null,
          node_type: parsed.patch.node_type ?? "in",
          load_balance_type: parsed.patch.load_balance_type ?? "round",
          allow_listen_protocol: parsed.patch.allow_listen_protocol ?? false,
          allow_listen_protocols: parsed.patch.allow_listen_protocols ?? null,
          allow_tunnel_types: parsed.patch.allow_tunnel_types ?? null,
          bypass_type: parsed.patch.bypass_type ?? "blacklist",
          bypass_list: parsed.patch.bypass_list ?? null,
          admission: parsed.patch.admission ?? false,
          block_protocols: parsed.patch.block_protocols ?? null,
          traffic_rate: parsed.patch.traffic_rate ?? 1,
          need_out_node_group: parsed.patch.need_out_node_group ?? false,
          allow_out_node_groups: parsed.patch.allow_out_node_groups ?? null,
          allow_in_node_groups: parsed.patch.allow_in_node_groups ?? null,
          order_by: parsed.patch.order_by ?? db.nodeGroups.reduce((m, x) => Math.max(m, x.order_by), 0) + 100,
          user_id: user.id,
          created_at: nowIso(),
          updated_at: nowIso(),
          node_count: 0,
          online_node_count: 0,
        };
        db.nodeGroups.push(group);
        return ok(group);
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const group = db.nodeGroups.find((g) => g.id === id);
        if (!group) return notFound("节点组不存在");
        if (method === "GET" && seg[3] === undefined) return ok(withGroupStats(db, group));
        if ((method === "PUT" || method === "PATCH") && seg[3] === undefined) {
          const parsed = readNodeGroupPayload(db, asRecord(req.body), true, id);
          if (isResponse(parsed)) return parsed;
          Object.assign(group, parsed.patch);
          group.updated_at = nowIso();
          return ok(withGroupStats(db, group));
        }
        if (method === "DELETE" && seg[3] === undefined) {
          if (db.nodes.some((n) => n.node_group_id === group.id)) return badRequest("请先移除该节点组下的节点");
          if (db.tunnels.some((t) => t.in_node_group_id === group.id || t.out_node_group_id === group.id)) {
            return badRequest("该节点组仍被隧道引用，无法删除");
          }
          db.nodeGroups.splice(db.nodeGroups.indexOf(group), 1);
          return ok({ ok: true, id: group.id });
        }
      }
    }

    // ----- plans -----
    if (seg[1] === "plans") {
      if (method === "GET" && seg[2] === undefined) {
        return ok(paginate(filterByStatus(filterByKeyword(db.plans, q, ["name"]), q), q));
      }
      if (method === "POST" && seg[2] === undefined) {
        const parsed = readPlanPayload(db, asRecord(req.body), false);
        if (isResponse(parsed)) return parsed;
        const id = nextId(db.plans);
        const plan: Plan = {
          id,
          name: parsed.patch.name ?? `套餐 ${id}`,
          description: parsed.patch.description ?? null,
          original_price: parsed.patch.original_price ?? null,
          price: parsed.patch.price ?? 0,
          max_tunnels: parsed.patch.max_tunnels ?? null,
          traffic: parsed.patch.traffic ?? null,
          ip_limit: parsed.patch.ip_limit ?? null,
          client_limit: parsed.patch.client_limit ?? null,
          bandwidth_limit: parsed.patch.bandwidth_limit ?? null,
          whitelist_limit: parsed.patch.whitelist_limit ?? null,
          allow_custom_in_node_group: parsed.patch.allow_custom_in_node_group ?? false,
          allow_custom_out_node_group: parsed.patch.allow_custom_out_node_group ?? false,
          all_in_node_groups: parsed.patch.all_in_node_groups ?? false,
          all_out_node_groups: parsed.patch.all_out_node_groups ?? false,
          setup_fee: parsed.patch.setup_fee ?? null,
          billing_cycle: parsed.patch.billing_cycle ?? "month",
          status: parsed.patch.status ?? "active",
          renewable: parsed.patch.renewable ?? true,
          stock: parsed.patch.stock ?? null,
          order_by: parsed.patch.order_by ?? db.plans.reduce((m, x) => Math.max(m, x.order_by), 0) + 100,
          created_at: nowIso(),
          updated_at: nowIso(),
          node_groups: parsed.patch.node_groups ?? [],
        };
        db.plans.push(plan);
        return ok(plan);
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const plan = db.plans.find((p) => p.id === id);
        if (!plan) return notFound("套餐不存在");
        if (method === "GET" && seg[3] === undefined) return ok(plan);
        if ((method === "PUT" || method === "PATCH") && seg[3] === undefined) {
          const parsed = readPlanPayload(db, asRecord(req.body), true);
          if (isResponse(parsed)) return parsed;
          Object.assign(plan, parsed.patch);
          plan.updated_at = nowIso();
          return ok(plan);
        }
        if (method === "DELETE" && seg[3] === undefined) {
          if (db.userPlans.some((p) => p.plan_id === plan.id)) return badRequest("该套餐仍有用户订阅，无法删除");
          db.plans.splice(db.plans.indexOf(plan), 1);
          return ok({ ok: true, id: plan.id });
        }
      }
    }

    // ----- tunnels（管理端全量） -----
    if (seg[1] === "tunnels") {
      if (method === "GET" && seg[2] === undefined) {
        return ok(paginate(filterByStatus(filterByKeyword(db.tunnels, q, ["name"]), q), q));
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const tunnel = db.tunnels.find((t) => t.id === id);
        if (!tunnel) return notFound("隧道不存在");
        if (method === "GET" && seg[3] === undefined) return ok(tunnel);
        if (method === "DELETE" && seg[3] === undefined) {
          db.tunnels.splice(db.tunnels.indexOf(tunnel), 1);
          return ok({ ok: true, id: tunnel.id });
        }
        if (method === "POST" && seg[3] === "toggle") {
          tunnel.status = tunnel.status === "active" ? "inactive" : "active";
          tunnel.online = tunnel.status === "active";
          tunnel.updated_at = nowIso();
          return ok(tunnel);
        }
      }
    }

    // ----- orders -----
    if (seg[1] === "orders" && method === "GET") {
      const kind = String(q?.kind ?? "all");
      const planOrders = db.planOrders.map((o) => ({ ...o, kind: "plan" as const }));
      const topOrders = db.topupOrders.map((o) => ({ ...o, kind: "topup" as const }));
      const all = kind === "plan" ? planOrders : kind === "topup" ? topOrders : [...planOrders, ...topOrders];
      return ok(paginate(all, q));
    }

    // ----- tickets（管理端全量） -----
    if (seg[1] === "tickets") {
      if (method === "GET" && seg[2] === undefined) {
        return ok(paginate(filterByStatus(filterByKeyword(db.tickets, q, ["title"]), q), q));
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const ticket = db.tickets.find((t) => t.id === id);
        if (!ticket) return notFound("工单不存在");
        if (method === "GET" && seg[3] === undefined) return ok(ticket);
        if ((method === "PUT" || method === "PATCH") && seg[3] === undefined) {
          const body = asRecord(req.body);
          if (body.status !== undefined) {
            const s = reqStr(body.status);
            if (s !== "open" && s !== "closed") return badRequest("工单状态不合法");
            ticket.status = s;
          }
          ticket.updated_at = nowIso();
          return ok(ticket);
        }
        if (method === "POST" && seg[3] === "replies") {
          const body = asRecord(req.body);
          const contentR = required(body, "content", "回复内容", 5000);
          if (isResponse(contentR)) return contentR;
          const reply: TicketReply = {
            id: nextId(ticket.replies ?? []),
            content: contentR.value,
            is_admin: true,
            ticket_id: ticket.id,
            user_id: user.id,
            created_at: nowIso(),
            updated_at: nowIso(),
          };
          ticket.replies = [...(ticket.replies ?? []), reply];
          ticket.updated_at = nowIso();
          return ok(reply);
        }
      }
    }

    // ----- balance logs -----
    if (seg[1] === "balance-logs" && method === "GET") {
      return ok(paginate(db.balanceLogs, q));
    }

    // ----- audit-logs（审计日志，只读；列表倒序）-----
    if (seg[1] === "audit-logs" && method === "GET" && seg[2] === undefined) {
      let items = [...db.auditLogs].sort((a, b) => b.id - a.id);
      const kw = String(q?.keyword ?? "").trim().toLowerCase();
      if (kw) {
        items = items.filter((a) =>
          [a.path, a.action, a.actor_email ?? "", a.resource].some((v) =>
            String(v).toLowerCase().includes(kw),
          ),
        );
      }
      const actorType = q?.actor_type;
      if (actorType && actorType !== "all") items = items.filter((a) => a.actor_type === actorType);
      const meth = q?.method;
      if (meth && meth !== "all") items = items.filter((a) => a.method === meth);
      return ok(paginate(items, q));
    }

    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  return notFound(`Mock route not found: ${method} /${clean}`);
}
