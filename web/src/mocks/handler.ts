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
  BillingCycle,
  BalanceLog,
  ID,
  ListQuery,
  Node,
  NodeGroup,
  NodeType,
  Plan,
  PlanOrder,
  Ticket,
  TicketReply,
  TopupOrder,
  TrafficPoint,
  Tunnel,
  User,
  UserPlan,
} from "@/lib/types";
import * as seed from "./data";
import { getStore, resetStore } from "./state";

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
function fail(status: number, message: string, code?: string): MockResponse {
  return { status, body: code ? { message, code } : { message } };
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
  for (const key of ["backup", "dns_status"] as const) {
    if (body[key] !== undefined) patch[key] = Boolean(body[key]);
  }
  return { patch };
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
    if (seg[1] === "session" && method === "GET") {
      if (!logged) return fail(401, "Unauthorized");
      const u = userFromCookie(db, req.cookie);
      return ok({ user: { ...u, user_plan: db.userPlans.find((p) => p.user_id === u.id) ?? null } });
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
        user: found,
        token: `mock-jwt-${found.id}`,
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
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.users.push(created);
      db.passwords[id] = password;
      return ok({ user: created, token: `mock-jwt-${id}`, session_cookie: sessionCookieValue(id) });
    }
    if (seg[1] === "logout" && method === "POST") return ok({ ok: true });
  }

  // 以下全部需要登录
  if (!logged) return fail(401, "Unauthorized");
  const user = userFromCookie(db, req.cookie);

  // ---------- dashboard ----------
  if (seg[0] === "dashboard") {
    if (seg[1] === "stats") return ok(dashboardStats(db, user));
    if (seg[1] === "traffic") {
      const days = Math.max(1, Number(q?.days ?? 14) || 14);
      return ok(seed.mockTrafficPoints.slice(-days));
    }
  }

  // ---------- tunnels ----------
  if (seg[0] === "tunnels") {
    const id = parseId(seg[1]);
    const sub = seg[2];

    if (method === "GET" && seg[1] === undefined) {
      const mine = db.tunnels.filter((t) => t.user_id === user.id);
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

      const forward = Array.isArray(body.forward_addresses)
        ? body.forward_addresses.map((s) => reqStr(s)).filter(Boolean)
        : parseList(body.forward_addresses) ?? [];
      if (forward.length === 0) return badRequest("至少需要一个转发目标");
      const badAddr = forward.find((a) => !/^(\[[0-9a-fA-F:]+\]|[^:\s]+):\d{1,5}$/.test(a));
      if (badAddr) return badRequest(`转发目标格式应为 host:port（${badAddr}）`);

      const tunnelType = (reqStr(body.tunnel_type) || "tcp") as Tunnel["tunnel_type"];
      const newId = nextId(db.tunnels);
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
      if (method === "POST" && sub === "reset-traffic") {
        t.traffic = 0;
        t.traffic_cost = 0;
        t.updated_at = nowIso();
        return ok(t);
      }
    }
    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  // ---------- node groups（用户侧：仅返回可用） ----------
  if (seg[0] === "node-groups" && method === "GET") {
    const items = filterByStatus(db.nodeGroups, q).map((g) => withGroupStats(db, g));
    return ok(paginate(items, q));
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
    if (seg[1] === "api-key" && method === "POST") {
      const rand = () => Math.random().toString(16).slice(2, 10);
      const key = `rk_live_${rand()}${rand()}`;
      user.api_key = key;
      user.updated_at = nowIso();
      return ok({ ok: true, api_key: key, user });
    }
    if (seg[1] === "subscription-key" && method === "POST") {
      const rand = () => Math.random().toString(16).slice(2, 10);
      const key = `sk_sub_${rand()}${rand()}`;
      user.subscription_key = key;
      user.updated_at = nowIso();
      return ok({ ok: true, subscription_key: key, user });
    }
  }

  // ---------- admin ----------
  if (seg[0] === "admin") {
    if (!user.super_admin) return fail(403, "需要管理员权限");

    if (seg[1] === "stats" && method === "GET") return ok(adminStats(db));

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
        };
        db.nodes.push(node);
        return ok(node);
      }
      const id = parseId(seg[2]);
      if (id !== null) {
        const node = db.nodes.find((n) => n.id === id);
        if (!node) return notFound("节点不存在");
        if (method === "GET" && seg[3] === undefined) return ok(node);
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
          return ok({ ok: true, id: node.id });
        }
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

    return notFound(`Mock route not found: ${method} /${clean}`);
  }

  return notFound(`Mock route not found: ${method} /${clean}`);
}
