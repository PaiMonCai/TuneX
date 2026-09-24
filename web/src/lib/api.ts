/**
 * API 层：统一 fetch wrapper。
 * - 自动携带 Cookie（credentials: "include"，兼容 SSR 转发 cookie）
 * - 401/403 时跳转登录页（携带 next 参数）
 * - NEXT_PUBLIC_API_MOCK=1 时改为调用 src/mocks/handler.ts 的手写响应
 */
import type {
  AdminDashboardStats,
  AdminListInput,
  AdminResourceMeta,
  AdminRole,
  AdminRoleInput,
  AdminUserInput,
  AuditLog,
  AuditLogQuery,
  AuthSession,
  BalanceLog,
  DashboardStats,
  LicenseInfo,
  ListQuery,
  Node,
  NodeGroup,
  NodeGroupInput,
  NodeInput,
  Paginated,
  PasswordChangeInput,
  Payment,
  Plan,
  PlanInput,
  PlanOrder,
  ProfileUpdateInput,
  SystemConfigItem,
  Ticket,
  TopupOrder,
  TrafficPoint,
  Tunnel,
  TunnelCreateInput,
  TunnelUpdateInput,
  User,
} from "./types";

export const API_MOCK = process.env.NEXT_PUBLIC_API_MOCK === "1";

// SSR 与浏览器走不同基址：
//   - SSR (Node)：API_BASE = SERVER_API_BASE（默认 http://backend:3000），直接打后端容器，
//     避免 fetch("/api/*") 打到 Next 自身（Next 没有 /api 路由 → 404 → 被当成未认证）。
//   - 浏览器：API_BASE = ""（同源相对路径），经 Caddy /api/* → backend:3000。
const SERVER_BASE = process.env.SERVER_API_BASE ?? "http://backend:3000";
export const API_BASE =
  API_MOCK ? "" : typeof window === "undefined" ? SERVER_BASE : "";


export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: ListQuery;
  /** cookie 透传（服务端组件用） */
  cookie?: string;
  /** 401 时不跳转（用于登录接口自身、静默探测） */
  noRedirect?: boolean;
  cache?: RequestCache;
}

function buildQuery(query?: ListQuery): string {
  if (!query) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

function redirectToLogin() {
  if (typeof window === "undefined") return;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  if (window.location.pathname.startsWith("/login")) return;
  window.location.href = `/login?next=${next}`;
}

/**
 * mock 模式下把会话 cookie 落到浏览器（真实后端由响应头 Set-Cookie 完成，无需此步）。
 * 服务端组件里也调用 handleMock，但那里没有 document，直接跳过。
 */
function applyMockSessionCookie(session: AuthSession | null): void {
  if (typeof document === "undefined") return;
  if (session?.session_cookie) {
    document.cookie = session.session_cookie;
  }
}

/** 退出登录：清掉会话 cookie（两种模式都要做，mock 下没有后端清 cookie） */
export function clearMockSessionCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = "tunex_session=; Path=/; Max-Age=0; SameSite=Lax";
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, cookie, noRedirect, cache } = options;
  const url = `/api${path.startsWith("/") ? path : `/${path}`}${buildQuery(query)}`;

  if (API_MOCK) {
    const { handleMock } = await import("@/mocks/handler");
    // 浏览器端的 mock「请求」也要带上真实 cookie，否则 SSR 里能看到的会话在客户端丢失
    const reqCookie = cookie ?? (typeof document !== "undefined" ? document.cookie : undefined);
    const res = await handleMock(method, path, { body, query, cookie: reqCookie });
    if (res.status === 401 && !noRedirect) redirectToLogin();
    if (res.status >= 400) {
      throw new ApiError(res.status, (res.body as { message?: string })?.message ?? "Request failed", res.body);
    }
    return res.body as T;
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;

  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers,
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: cache ?? "no-store",
  });

  if (res.status === 401 || res.status === 403) {
    if (!noRedirect) redirectToLogin();
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const msg =
      (data && typeof data === "object" && "message" in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).message)
        : null) ?? `Request failed with status ${res.status}`;
    throw new ApiError(res.status, msg, data);
  }
  // 真实后端把业务数据包在 { data: T } 里，mock 模式没有这层包装，按有无 data 字段兼容
  const payload =
    data && typeof data === "object" && "data" in (data as Record<string, unknown>)
      ? (data as Record<string, unknown>).data
      : data;
  return payload as T;
}

const get = <T>(path: string, query?: ListQuery, cookie?: string) =>
  request<T>(path, { method: "GET", query, cookie });
const post = <T>(path: string, body?: unknown, cookie?: string) =>
  request<T>(path, { method: "POST", body, cookie });
const put = <T>(path: string, body?: unknown, cookie?: string) => request<T>(path, { method: "PUT", body, cookie });
const patch = <T>(path: string, body?: unknown, cookie?: string) =>
  request<T>(path, { method: "PATCH", body, cookie });
const del = <T>(path: string, cookie?: string) => request<T>(path, { method: "DELETE", cookie });

export const api = {
  // 认证
  auth: {
    session: async (cookie?: string): Promise<AuthSession> => {
      const data = await request<User>("/auth/me", { cookie });
      // 真实后端 /me 返回平铺的用户对象，包装成 AuthSession.user 以匹配前端类型
      return { user: data, token: undefined };
    },
    login: async (email: string, password: string, cookie?: string) => {
      const session = await request<AuthSession>("/auth/login", {
        method: "POST",
        body: { email, password },
        noRedirect: true,
        cookie,
      });
      applyMockSessionCookie(session);
      return session;
    },
    register: async (email: string, password: string, cookie?: string) => {
      const session = await request<AuthSession>("/auth/register", {
        method: "POST",
        body: { email, password },
        noRedirect: true,
        cookie,
      });
      applyMockSessionCookie(session);
      return session;
    },
    logout: async () => {
      const res = await post<{ ok: boolean }>("/auth/logout");
      clearMockSessionCookie();
      return res;
    },
  },
  // 个人设置
  settings: {
    profile: (cookie?: string) => get<User>("/settings/profile", undefined, cookie),
    updateProfile: (input: ProfileUpdateInput, cookie?: string) => patch<User>("/settings/profile", input, cookie),
    changePassword: (input: PasswordChangeInput, cookie?: string) =>
      post<{ ok: boolean }>("/settings/password", input, cookie),
    regenerateApiKey: (cookie?: string) =>
      post<{ ok: boolean; api_key: string; user: User }>("/settings/api-key", {}, cookie),
    regenerateSubscriptionKey: (cookie?: string) =>
      post<{ ok: boolean; subscription_key: string; user: User }>("/settings/subscription-key", {}, cookie),
  },
  // 用户端
  dashboard: {
    stats: (cookie?: string) => get<DashboardStats>("/dashboard/stats", undefined, cookie),
    traffic: (days = 14, cookie?: string) => get<TrafficPoint[]>("/dashboard/traffic", { days }, cookie),
  },
  tunnels: {
    list: (query?: ListQuery, cookie?: string) => get<Paginated<Tunnel>>("/tunnels", query, cookie),
    detail: (id: number, cookie?: string) => get<Tunnel>(`/tunnels/${id}`, undefined, cookie),
    traffic: (id: number, days = 14, cookie?: string) => get<TrafficPoint[]>(`/tunnels/${id}/traffic`, { days }, cookie),
    create: (input: TunnelCreateInput, cookie?: string) => post<Tunnel>("/tunnels", input, cookie),
    update: (id: number, input: TunnelUpdateInput, cookie?: string) => patch<Tunnel>(`/tunnels/${id}`, input, cookie),
    remove: (id: number, cookie?: string) => del<{ ok: boolean }>(`/tunnels/${id}`, cookie),
    toggle: (id: number, cookie?: string) => post<Tunnel>(`/tunnels/${id}/toggle`, {}, cookie),
  },
  nodeGroups: {
    list: (query?: ListQuery, cookie?: string) => get<Paginated<NodeGroup>>("/node-groups", query, cookie),
  },
  plans: {
    list: (query?: ListQuery, cookie?: string) => get<Paginated<Plan>>("/plans", query, cookie),
    purchase: (plan_id: number, coupon?: string, cookie?: string) =>
      post<{ ok: boolean; order_id: number }>("/plans/purchase", { plan_id, coupon }, cookie),
  },
  topups: {
    list: (query?: ListQuery, cookie?: string) => get<Paginated<TopupOrder>>("/topups", query, cookie),
    create: (amount: number, payment_id: number, cookie?: string) =>
      post<TopupOrder>("/topups", { amount, payment_id }, cookie),
    payments: (cookie?: string) => get<{ id: number; name: string; method: string }[]>("/payments", undefined, cookie),
  },
  tickets: {
    list: (query?: ListQuery, cookie?: string) => get<Paginated<Ticket>>("/tickets", query, cookie),
    create: (input: { title: string; content: string }, cookie?: string) =>
      post<Ticket>("/tickets", input, cookie),
  },
  // 管理端
  admin: {
    stats: (cookie?: string) => get<AdminDashboardStats>("/admin/stats", undefined, cookie),
    users: (query?: ListQuery, cookie?: string) => get<Paginated<User>>("/admin/users", query, cookie),
    createUser: (input: AdminUserInput, cookie?: string) => post<User>("/admin/users", input, cookie),
    updateUser: (id: number, input: Partial<AdminUserInput>, cookie?: string) =>
      patch<User>(`/admin/users/${id}`, input, cookie),
    removeUser: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/users/${id}`, cookie),
    nodes: (query?: ListQuery, cookie?: string) => get<Paginated<Node>>("/admin/nodes", query, cookie),
    createNode: (input: NodeInput, cookie?: string) => post<Node>("/admin/nodes", input, cookie),
    updateNode: (id: number, input: Partial<NodeInput>, cookie?: string) =>
      patch<Node>(`/admin/nodes/${id}`, input, cookie),
    removeNode: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/nodes/${id}`, cookie),
    nodeGroups: (query?: ListQuery, cookie?: string) => get<Paginated<NodeGroup>>("/admin/node-groups", query, cookie),
    createNodeGroup: (input: NodeGroupInput, cookie?: string) =>
      post<NodeGroup>("/admin/node-groups", input, cookie),
    updateNodeGroup: (id: number, input: Partial<NodeGroupInput>, cookie?: string) =>
      patch<NodeGroup>(`/admin/node-groups/${id}`, input, cookie),
    removeNodeGroup: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/node-groups/${id}`, cookie),
    plans: (query?: ListQuery, cookie?: string) => get<Paginated<Plan>>("/admin/plans", query, cookie),
    createPlan: (input: PlanInput, cookie?: string) => post<Plan>("/admin/plans", input, cookie),
    updatePlan: (id: number, input: Partial<PlanInput>, cookie?: string) =>
      patch<Plan>(`/admin/plans/${id}`, input, cookie),
    removePlan: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/plans/${id}`, cookie),
    tunnels: (query?: ListQuery, cookie?: string) => get<Paginated<Tunnel>>("/admin/tunnels", query, cookie),
    orders: (query?: ListQuery, cookie?: string) => get<Paginated<PlanOrder | TopupOrder>>("/admin/orders", query, cookie),
    tickets: (query?: ListQuery, cookie?: string) => get<Paginated<Ticket>>("/admin/tickets", query, cookie),
    /** 只读资源写操作（有对应后端端点时使用；无端点时由界面提示只读） */
    updateTunnel: (id: number, input: TunnelUpdateInput, cookie?: string) =>
      patch<Tunnel>(`/admin/tunnels/${id}`, input, cookie),
    removeTunnel: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/tunnels/${id}`, cookie),
    /** 余额流水（管理端全量） */
    balanceLogs: (query?: AdminListInput, cookie?: string) =>
      get<Paginated<BalanceLog>>("/admin/balance-logs", query as ListQuery, cookie),
    /** 支付方式列表（管理端） */
    payments: (cookie?: string) => get<Payment[]>("/payments", undefined, cookie),
    // —— RBAC 角色（仅超管）——
    roles: (cookie?: string) => get<AdminRole[]>("/admin/role", undefined, cookie),
    createRole: (input: AdminRoleInput, cookie?: string) => post<AdminRole>("/admin/role", input, cookie),
    updateRole: (id: number, input: Partial<AdminRoleInput>, cookie?: string) =>
      put<AdminRole>(`/admin/role/${id}`, input, cookie),
    removeRole: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/role/${id}`, cookie),
    updateUserRoles: (id: number, admin_role_ids: number[], cookie?: string) =>
      put<{ id: number; admin_roles: AdminRole[] }>(`/admin/user/${id}/roles`, { admin_role_ids }, cookie),
    /** 权限元数据（渲染角色编辑器） */
    metaResources: (cookie?: string) =>
      get<{ resources: AdminResourceMeta[] }>("/admin/meta/resources", undefined, cookie),
    // —— 系统配置 / License（仅具权限者）——
    systemConfig: (cookie?: string) => get<SystemConfigItem[]>("/admin/system/config", undefined, cookie),
    setSystemConfig: (name: string, value: string, cookie?: string) =>
      put<{ name: string; value: string }>(`/admin/system/config/${name}`, { value }, cookie),
    license: (cookie?: string) => get<LicenseInfo>("/admin/license", undefined, cookie),
    /** 审计日志（仅超级管理员可读） */
    auditLogs: (query?: AuditLogQuery, cookie?: string) =>
      get<Paginated<AuditLog>>("/admin/audit-logs", query as ListQuery, cookie),
  },
};

export default api;
