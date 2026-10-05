/**
 * API 层：统一 fetch wrapper。
 * - 自动携带 Cookie（credentials: "include"，兼容 SSR 转发 cookie）
 * - SEC-02 CSRF：所有写操作统一带 `X-CSRF-Token: 1` 自定义头
 *   （后端 middlewares/csrf.ts 凭此 + Origin/Referer 挡跨站写）
 * - 仅 401 时跳转登录页（403 保留权限错误）（携带 next 参数）
 * - NEXT_PUBLIC_API_MOCK=1 时改为调用 src/mocks/handler.ts 的手写响应
 */
import type {
  DiagnoseReport,
  NodeDiagnosticsReport,
  NodeUpgradeCommand,
  AdminDashboardStats,
  AdminListInput,
  AdminResourceMeta,
  AdminRole,
  AdminRoleInput,
  AdminUserInput,
  AttentionPayload,
  AuditLog,
  AuditLogQuery,
  AuthSession,
  BalanceLog,
  DashboardStats,
  EgressPool,
  EgressPoolInput,
  EgressTarget,
  EgressTargetInput,
  FederationDisableResult,
  FederationEnableResult,
  FederationGrant,
  FederationGrantActionResult,
  FederationGrantCreateResult,
  FederationGrantInput,
  FederationHandshakeInput,
  FederationHandshakeResult,
  FederationInvitation,
  FederationInviteInput,
  FederationKeyRotateResult,
  FederationLease,
  FederationPeer,
  FederationPeerRevokeResult,
  FederationPeerRotateResult,
  FederationPingResult,
  FederationPlacement,
  FederationStatus,
  FederationUsageRecord,
  ID,
  LicenseInfo,
  ListQuery,
  LBStrategy,
  Node,
  NodeCredentialIssued,
  NodeCredentialRevoked,
  NodeEnrollmentIssued,
  NodeBinding,
  NodeDetail,
  NodeGroup,
  NodeGroupInput,
  NodeHealthList,
  NodeHealthSummary,
  NodeHealthValue,
  NodeHealthView,
  NodeImpactResult,
  NodeInput,
  NodeLifecycleChangeResult,
  NodeLifecycleValue,
  NodeLifecycleView,
  NodeRole,
  NodeStateReport,
  ConsumableRouteProfileList,
  Paginated,
  PasswordChangeInput,
  RouteProfileApplyInput,
  RouteProfileApplyResult,
  RouteProfileCreateInput,
  RouteProfileDetail,
  RouteProfileImpact,
  RouteProfilePatchInput,
  RouteProfilePublishInput,
  RouteProfilePublishResult,
  RouteProfileVersionBody,
  RouteProfileVersionEntry,
  RouteProfileView,
  PortForward,
  ForwardCreateInput,
  ForwardPatchInput,
  ForwardPreviewResult,
  ForwardListQuery,
  ForwardBatchInput,
  ForwardBatchResult,
  ForwardSummary,
  ProvisionNodeResult,
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
  TunnelUpdateInput,
  User,
  UserNode,
  Workspace,
  WorkspaceAcceptInviteResult,
  WorkspaceCreateInput,
  WorkspaceInvite,
  WorkspaceInviteInput,
  WorkspaceMember,
  WorkspaceTrafficSummary,
} from "./types";
import { normalizeHealthSummary } from "./node-health";
// 公告类型单独维护在 announcements.ts。
import type { Announcement } from "./announcements";
// 目标健康状态与理由码在 target-health.ts 维护。
import type { TargetPoolHealth } from "./target-health";
import { shouldRedirectToLogin } from "./workspace-permissions";
import type { EffectiveWorkspacePermissions, WorkspaceCustomRole, WorkspaceCustomRoleInput, WorkspaceMemberRoleInput } from "./workspace-permissions";

export const API_MOCK = process.env.NEXT_PUBLIC_API_MOCK === "1";

// SSR 与浏览器走不同基址：
//   - SSR (Node)：API_BASE = SERVER_API_BASE（默认 http://backend:3000），直接打后端容器，
//     避免 fetch("/api/*") 打到 Next 自身（Next 没有 /api 路由 → 404 → 被当成未认证）。
//   - 浏览器：API_BASE = ""（同源相对路径），经 Caddy /api/* → backend:3000。
const SERVER_BASE = process.env.SERVER_API_BASE ?? "http://backend:3000";
export const API_BASE =
  API_MOCK ? "" : typeof window === "undefined" ? SERVER_BASE : "";

/**
 * 当前工作空间通过 `x-workspace-id` 传给后端；缺省时后端回落到个人空间。
 * 浏览器使用模块级状态，SSR 使用 `tunex_workspace` cookie。
 */
export const WORKSPACE_HEADER = "x-workspace-id";
export const WORKSPACE_COOKIE = "tunex_workspace";

let activeWorkspaceId: number | null = null;

/** 切换 workspace 时调用（浏览器侧）；同时由调用方写入 cookie 以覆盖 SSR */
export function setActiveWorkspace(id: number | null): void {
  activeWorkspaceId = id && Number.isFinite(id) && id > 0 ? id : null;
}

/** 当前 workspace（客户端单例） */
export function getActiveWorkspace(): number | null {
  return activeWorkspaceId;
}

/** 服务端组件读 cookie 里的 workspace（`w<id>`，解析失败返回 null） */
export function workspaceIdFromCookie(cookie: string): number | null {
  const m = new RegExp(`${WORKSPACE_COOKIE}=w(\\d+)`).exec(cookie);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 切换 workspace 时写入 cookie（供 SSR / 后续刷新使用） */
export function workspaceCookieString(id: number): string {
  return `${WORKSPACE_COOKIE}=w${id}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}


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
  /** 服务端组件可显式指定作用域工作空间；缺失时后端回落个人空间。 */
  workspaceId?: number;
  /**
   * 是否剥掉响应的一层 `{ data }`（默认 true）。
   *
   * 只有「信封带旁路字段」的端点才需要 false：通用解包认识 `data`，但会把
   * `total` / `summary` 一起丢掉（如 `/admin/node/health`）。
   * 拿原始信封的调用方**必须自己**判空，不能假定字段一定存在。
   */
  unwrap?: boolean;
}

/* ================================================================== */
/* SEC-02：CSRF 防护                                                      */
/* ================================================================== */

/**
 * 写操作携带的自定义头（`X-CSRF-Token: 1`）。
 *
 * 后端 middlewares/csrf.ts 对「非安全方法 + 携带会话 cookie」的请求做 CSRF
 * 判定：带此自定义头即放行，否则要求 Origin/Referer 的 host 与请求 Host 一致。
 * 跨站页面无法在不触发 CORS 预检的情况下设置自定义头，而生产环境 CORS 关闭、
 * 预检必败——因此「这个头存在」本身就是凭证。值固定为 1（无需与任何服务端
 * 状态绑定，也就不存在令牌被读走/过期/轮换的问题）。
 */
export const CSRF_TOKEN_HEADER = "X-CSRF-Token";

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
  const { method = "GET", body, query, cookie, noRedirect, cache, workspaceId, unwrap = true } = options;
  const url = `/api${path.startsWith("/") ? path : `/${path}`}${buildQuery(query)}`;

  if (API_MOCK) {
    const { handleMock } = await import("@/mocks/handler");
    // 浏览器端的 mock「请求」也要带上真实 cookie，否则 SSR 里能看到的会话在客户端丢失
    const reqCookie = cookie ?? (typeof document !== "undefined" ? document.cookie : undefined);
    const res = await handleMock(method, path, { body, query, cookie: reqCookie, workspaceId: workspaceId ?? (typeof window !== "undefined" ? activeWorkspaceId ?? undefined : reqCookie ? workspaceIdFromCookie(reqCookie) ?? undefined : undefined) });
    if (res.status === 401 && !noRedirect) redirectToLogin();
    if (res.status >= 400) {
      throw new ApiError(res.status, (res.body as { message?: string })?.message ?? "Request failed", res.body);
    }
    // mock 响应没有 { data } 包装，直接用 body（与既有接口约定一致）。
    // 注意：mock 里也没有「解包」这一步，因此 `unwrap: false` 的端点在两种
    // 模式下拿到的是同一形状——mock 必须自己造出 `{ data, total, summary }`。
    return res.body as T;
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;
  // TEN-01：把当前 workspace 作为请求头传给后端（resolveWorkspaceAccess 的作用域）。
  // 优先级：显式 workspaceId > 浏览器单例。SSR 未指定时不带头 = 后端回落个人空间。
  const wsId = workspaceId ?? (typeof window !== "undefined" ? activeWorkspaceId : null);
  if (wsId !== null) headers[WORKSPACE_HEADER] = String(wsId);

  // SEC-02 CSRF：写操作带上自定义头凭证。后端 middlewares/csrf.ts 对
  // 「非安全方法 + 携带会话 cookie」的请求要求它（或同源 Origin）。
  const isMutating = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  if (isMutating) headers[CSRF_TOKEN_HEADER] = "1";

  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers,
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: cache ?? "no-store",
  });

  return await finalize<T>(res, noRedirect, unwrap);
}

/**
 * 统一解析响应：错误时抛 ApiError，成功时剥掉一层 { data }。
 *
 * `unwrap === false` 用于带旁路字段的信封（例如
 * `{ data, total, summary }`）：通用解包只认识 `data`，会把 summary/total
 * 一起丢掉，所以这类端点必须自己拿原始信封。
 */
async function finalize<T>(res: Response, noRedirect?: boolean, unwrap = true): Promise<T> {
  if (shouldRedirectToLogin(res.status)) {
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
    // 后端错误体可能用 message 或 error；优先保留可行动的人读原因。
    const body = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const pick = (key: string): string | null => {
      const value = body?.[key];
      return typeof value === "string" && value.trim() !== "" ? value : null;
    };
    const msg = pick("message") ?? pick("error") ?? `Request failed with status ${res.status}`;
    throw new ApiError(res.status, msg, data);
  }
  return (unwrap ? unwrapData<T>(data) : (data as T));
}

/** 剥掉后端的一层 { data }（mock 模式没有这层，按有无 data 字段兼容）。 */
function unwrapData<T>(data: unknown): T {
  const payload =
    data && typeof data === "object" && "data" in (data as Record<string, unknown>)
      ? (data as Record<string, unknown>).data
      : data;
  return payload as T;
}

const get = <T>(path: string, query?: ListQuery, cookie?: string) =>
  request<T>(path, { method: "GET", query, cookie, workspaceId: cookie ? workspaceIdFromCookie(cookie) ?? undefined : undefined });
const post = <T>(path: string, body?: unknown, cookie?: string) =>
  request<T>(path, { method: "POST", body, cookie });
const put = <T>(path: string, body?: unknown, cookie?: string) => request<T>(path, { method: "PUT", body, cookie });
const patch = <T>(path: string, body?: unknown, cookie?: string) =>
  request<T>(path, { method: "PATCH", body, cookie });
const del = <T>(path: string, cookie?: string) => request<T>(path, { method: "DELETE", cookie });
export const api = {
  // 工作空间（个人/团队切换、成员、邀请）；浏览器使用会话 cookie 鉴权。
  workspaces: {
    permissions: (id: number) => request<EffectiveWorkspacePermissions>(`/workspaces/${id}/permissions`, { noRedirect: true, workspaceId: id }),
    roles: (id: number) => get<WorkspaceCustomRole[]>(`/workspaces/${id}/roles`),
    createRole: (id: number, input: WorkspaceCustomRoleInput) => post<WorkspaceCustomRole>(`/workspaces/${id}/roles`, input),
    updateRole: (id: number, roleId: number, input: WorkspaceCustomRoleInput) => patch<WorkspaceCustomRole>(`/workspaces/${id}/roles/${roleId}`, input),
    deleteRole: (id: number, roleId: number) => del<{ ok: boolean }>(`/workspaces/${id}/roles/${roleId}`),
    assignRole: (id: number, userId: number, input: WorkspaceMemberRoleInput) => patch<WorkspaceMember>(`/workspaces/${id}/members/${userId}/role`, input),
    /** 当前用户可见的全部工作空间（含个人空间），带上各自角色 */
    list: (cookie?: string) => get<Workspace[]>("/workspaces", undefined, cookie),
    /** 创建团队空间（后端事务内发放默认策略），创建者成为 owner */
    create: (input: WorkspaceCreateInput, cookie?: string) =>
      post<Workspace>("/workspaces", input, cookie),
    members: (id: number, cookie?: string) =>
      get<WorkspaceMember[]>(`/workspaces/${id}/members`, undefined, cookie),
    /** 邀请成员；返回的 token 只出现一次，需当场展示 */
    invite: (id: number, input: WorkspaceInviteInput, cookie?: string) =>
      post<WorkspaceInvite>(`/workspaces/${id}/invites`, input, cookie),
    /** 用邀请 token 加入团队（按当前登录用户邮箱匹配） */
    acceptInvite: (token: string, cookie?: string) =>
      post<WorkspaceAcceptInviteResult>("/workspaces/invites/accept", { token }, cookie),
    /** 移除成员（owner 不可移除；也可用于「退出」：actor == targetId 时无需 manage 权限） */
    removeMember: (id: number, userId: number, cookie?: string) =>
      del<{ ok: boolean }>(`/workspaces/${id}/members/${userId}`, cookie),
    /**
     * workspace 流量聚合（口径与策略流量一致）。
     * 返回总流量 + 按隧道排行 + 按日界补齐的趋势序列。
     * @param id workspace id
     * @param params.days 趋势天数（1–90，默认 14，后端 `TRAFFIC_DEFAULT_DAYS`）
     * @param params.period 计量周期（day/month/total）；缺省取该空间生效策略的 traffic_period
     */
    traffic: (
      id: number,
      params?: { days?: number; period?: "day" | "month" | "total" },
      cookie?: string,
    ) =>
      get<WorkspaceTrafficSummary>(`/workspaces/${id}/traffic`, params as ListQuery, cookie),
  },
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
    /** 点击邮件链接验证邮箱。 */
    verifyEmail: (token: string) =>
      request<{ status: "verified" | "invalid"; message: string }>(
        `/auth/verify-email?token=${encodeURIComponent(token)}`,
        { method: "GET", noRedirect: true },
      ),
    /** 重新发送验证邮件（需登录）。 */
    resendVerification: async () => post<{ ok: boolean; expires_in: number }>("/auth/resend-verification"),
    /**
     * 忘记密码响应与邮箱是否存在无关，避免账号枚举。
     * 故前端不做「该邮箱未注册」的错误分支。
     */
    forgotPassword: async (email: string) =>
      post<{ ok: boolean; expires_in: number }>("/auth/forgot-password", { email }),
    /** 用邮件 token 设置新密码。 */
    resetPassword: async (token: string, password: string) =>
      post<{ ok: boolean }>("/auth/reset-password", { token, password }),
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
    /**
     * 需要处理的节点/转发（离线、等待安装、管理态、
     * 下发失败、未收敛）。
     *
     * 后端在聚合失败时会返回**空清单 + `degraded: true`**（不是 5xx：Dashboard
     * 是首页，一个聚合查询失败不该让整页打不开）。因此调用方必须看
     * `degraded`，不能把空清单当成「一切正常」—— 面板文案据此分流。
     */
    attention: (cookie?: string) =>
      get<AttentionPayload>("/dashboard/attention", undefined, cookie),
  },
  /**
   * 用户侧公告。
   *
   * 只有两个方法：读列表、标记已读。**没有**免打扰偏好的读写 —— 契约 §9.5 明确本期
   * 不做通知中心前端（渠道偏好矩阵 UI），后端那两个端点由后端契约测试覆盖；
   * 没有 UI 的客户端方法就是死代码。
   *
   * 可见性（platform ∪ 本 workspace、未撤回）与"我是否已读"都由后端算好，
   * 前端不重判（`lib/announcements.ts` 只做形状校验与展示排序）。
   */
  announcements: {
    list: (cookie?: string) => get<Announcement[]>("/announcements", undefined, cookie),
    dismiss: (id: ID, cookie?: string) =>
      post<{ announcement_id: number; already: boolean; dismissed_at: string }>(
        `/announcements/${id}/dismiss`,
        {},
        cookie,
      ),
  },
  // 用户产品面统一使用 /forwards；/api/tunnels 仅保留后端兼容。
  forwards: {
    summary: (cookie?: string) =>
      get<ForwardSummary>("/forwards/summary", undefined, cookie),
    /**
     * 列表支持服务端分页、排序和过滤。
     *
     * 带 `page` / `page_size` / `sort` / `order` 任一参数时后端返回
     * `Paginated<PortForward>`；不带则返回裸数组（冻结的旧契约）。
     * 用两个方法把这两种形态分开，调用点就无法"忘了带 page 却按分页读"。
     */
    list: (query?: ForwardListQuery, cookie?: string) =>
      get<PortForward[]>("/forwards", query, cookie),
    /** 分页形态：必须有分页/排序参数，响应为 `Paginated<PortForward>`。 */
    page: (query: ForwardListQuery, cookie?: string) =>
      get<Paginated<PortForward>>("/forwards", query, cookie),
    /**
     * 批量 retry / suspend / resume。
     *
     * 逐条结果 + 200（部分失败不改整体状态码），因此调用方必须读
     * `succeeded` / `failed` 而不是只看 promise 是否 reject。
     */
    batch: (
      input: ForwardBatchInput,
      cookie?: string,
    ) => post<ForwardBatchResult>("/forwards/batch", input, cookie),
    detail: (id: ID, cookie?: string) =>
      get<PortForward>(`/forwards/${id}`, undefined, cookie),
    traffic: (id: ID, days = 14, cookie?: string) =>
      get<TrafficPoint[]>(`/forwards/${id}/traffic`, { days }, cookie),
    create: (input: ForwardCreateInput, cookie?: string) =>
      post<PortForward>("/forwards", input, cookie),
    update: (id: ID, input: ForwardPatchInput, cookie?: string) =>
      patch<PortForward>(`/forwards/${id}`, input, cookie),
    /**
     * 保存前影响预览（不写库）。
     *
     * 与 update 共用后端同一个 candidate resolver，因此本方法放行 ⇔ update 接受。
     * UI 在每次字段变更后调用它渲染 impact warning。
     */
    preview: (id: ID, input: ForwardPatchInput, cookie?: string) =>
      post<ForwardPreviewResult>(`/forwards/${id}/preview`, input, cookie),
    action: (
      id: ID,
      action: "retry" | "suspend" | "resume",
      cookie?: string,
    ) => post<PortForward>(`/forwards/${id}/${action}`, {}, cookie),
    remove: (id: ID, cookie?: string) =>
      del<{ ok: true }>(`/forwards/${id}`, cookie),
    /**
     * Forward 诊断（只读）。
     *
     * 探针目标由**后端**从该转发的已授权期望状态推导，请求体不带 host/port ——
     * 因此这里刻意不接受任何参数：一个"带目标参数的诊断"就是把客户端变成内网扫描器。
     */
    diagnose: (id: ID, cookie?: string) =>
      post<DiagnoseReport>(`/forwards/${id}/diagnose`, {}, cookie),
  },
  nodes: {
    list: (cookie?: string) => get<UserNode[]>("/nodes", undefined, cookie),
    enrollment: (id: ID, cookie?: string) =>
      post<NodeEnrollmentIssued>(`/nodes/${id}/enrollment`, {}, cookie),
    bindings: (ingressId: ID, cookie?: string) =>
      get<NodeBinding[]>(`/nodes/${ingressId}/bindings`, undefined, cookie),
    bindEgress: (ingressId: ID, egress_node_id: ID, cookie?: string) =>
      post<NodeBinding>(`/nodes/${ingressId}/bindings`, { egress_node_id }, cookie),
    unbindEgress: (ingressId: ID, egressId: ID, cookie?: string) =>
      del<{ ok: boolean }>(`/nodes/${ingressId}/bindings/${egressId}`, cookie),
    /**
     * Node 级诊断；上报过期时后端返回 offline，不下发命令。
     */
    diagnostics: (id: ID, cookie?: string) =>
      get<NodeDiagnosticsReport>(`/nodes/${id}/diagnostics`, undefined, cookie),
    /**
     * Support Bundle 使用白名单采集和脱敏，返回 JSON 产物。
     */
    supportBundle: (id: ID, cookie?: string) =>
      get<Record<string, unknown>>(`/nodes/${id}/support-bundle`, undefined, cookie),
    /**
     * 渲染 Agent 升级脚本。
     *
     * 返回的是**操作者需要在节点上执行**的脚本；控制面不会远程替换 Agent。
     * `allow_active` 为 false 时后端会拒绝非 maintenance 节点（409）。
     */
    upgradeCommand: (id: ID, input: { agent_image: string; allow_active?: boolean }, cookie?: string) =>
      post<NodeUpgradeCommand>(`/nodes/${id}/upgrade-command`, input, cookie),
  },
  nodeGroups: {
    list: (query?: ListQuery, cookie?: string) => get<Paginated<NodeGroup>>("/node-groups", query, cookie),
    provisionNode: (
      groupId: ID,
      input: {
        node_id: string;
        connect_ip?: string | null;
        role?: NodeRole;
        targets?: { host: string; port: number; weight?: number }[];
      },
      cookie?: string,
    ) => post<ProvisionNodeResult>(`/node-groups/${groupId}/nodes`, input, cookie),
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
  /**
   * V5-WP13.5B Route Profile（线路模板）—— **不走 `/api/admin/*`**。
   *
   * 后端刻意复用 workspace 域 RBAC（`resolveWorkspaceAccess` 的 `node` 资源族，
   * 与 node-groups 同口径）、读写闸门 read/manage；Admin 与 User 只是**同一套资源
   * 的两个 UX 面**（§9.4.1：前端 guard 只做 UX）。因此这里用普通路径。
   *
   * 失败形状：`{ error, code, error_layer, retryable, next_action }`（注意人读原因是
   * `error` 而非 `message`）；`ApiError.data` 就是它，页面用 next_action 直接展示「下一步」。
   */
  routeProfiles: {
    list: (query?: ListQuery, cookie?: string) => get<Paginated<RouteProfileView>>("/route-profiles", query, cookie),
    detail: (id: ID, cookie?: string) =>
      get<RouteProfileDetail>(`/route-profiles/${id}`, undefined, cookie),
    create: (input: RouteProfileCreateInput, cookie?: string) =>
      post<RouteProfileView & { version_id: number }>("/route-profiles", input, cookie),
    /** 只改 metadata；模板内容变更必须走 publishVersion。 */
    patch: (id: ID, input: RouteProfilePatchInput, cookie?: string) =>
      patch<RouteProfileView>(`/route-profiles/${id}`, input, cookie),
    /** 发布**新版本**（模板内容变更的唯一路径）。 */
    publishVersion: (id: ID, input: RouteProfilePublishInput, cookie?: string) =>
      post<RouteProfilePublishResult>(`/route-profiles/${id}/versions`, input, cookie),
    versions: (id: ID, limit = 50, cookie?: string) =>
      get<RouteProfileVersionEntry[]>(`/route-profiles/${id}/versions`, { limit }, cookie),
    version: (id: ID, version: number, cookie?: string) =>
      get<RouteProfileVersionBody>(`/route-profiles/${id}/versions/${version}`, undefined, cookie),
    /** Impact Analysis：**只读**，不触发任何下发（后端保证并有用例钉住）。 */
    impact: (id: ID, version?: number, cookie?: string) =>
      get<RouteProfileImpact>(`/route-profiles/${id}/impact`, version === undefined ? undefined : { version }, cookie),
    /** 显式 rollout：必须给出 forward_ids；dry_run=true 时只预览。 */
    apply: (id: ID, input: RouteProfileApplyInput, cookie?: string) =>
      post<RouteProfileApplyResult>(`/route-profiles/${id}/apply`, input, cookie),
    /** 消费侧可见/可选列表（普通用户；fail-closed：没有显式授权就看不到）。 */
    available: (cookie?: string) =>
      get<ConsumableRouteProfileList>("/route-profiles/available", undefined, cookie),
  },

  admin: {
    stats: (cookie?: string) => get<AdminDashboardStats>("/admin/stats", undefined, cookie),
    users: (query?: ListQuery, cookie?: string) => get<Paginated<User>>("/admin/users", query, cookie),
    createUser: (input: AdminUserInput, cookie?: string) => post<User>("/admin/users", input, cookie),
    updateUser: (id: number, input: Partial<AdminUserInput>, cookie?: string) =>
      patch<User>(`/admin/users/${id}`, input, cookie),
    removeUser: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/users/${id}`, cookie),
    /**
     * 平台公告管理；授权由后端 RBAC 判定，前端直接展示后端失败原因。
     */
    announcements: {
      list: (cookie?: string) => get<Announcement[]>("/admin/announcements", undefined, cookie),
      create: (input: { type: string; title: string; body: string }, cookie?: string) =>
        post<Announcement>("/admin/announcements", input, cookie),
      revoke: (id: ID, cookie?: string) =>
        post<Announcement>(`/admin/announcements/${id}/revoke`, {}, cookie),
    },
    nodes: (query?: ListQuery, cookie?: string) => get<Paginated<Node>>("/admin/nodes", query, cookie),
    createNode: (input: NodeInput, cookie?: string) => post<Node>("/admin/nodes", input, cookie),
    updateNode: (id: number, input: Partial<NodeInput>, cookie?: string) =>
      patch<Node>(`/admin/nodes/${id}`, input, cookie),
    removeNode: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/nodes/${id}`, cookie),
    /**
     * 节点凭据端点：`/node/:id/credential[/rotate|/revoke]`。
     *
     * 三条端点都只接受节点主键（数字）或字符串 node_id 作 :id。
     * 其中 issue 已在上面那段注释之外额外多一条约束：**已持有有效凭据的节点
     * 只能 rotate**（issue 对有效凭据返回 409），否则误点两次「签发」会让
     * 线上 Agent 静默失联；revoke 保留哈希仅置 revoked 位；想彻底换钥匙只有
     * rotate 一条路（它覆盖哈希列）。
     *
     * 轮换/撤销是敏感写操作，后端挂了 60s/5 次的 user 维度限流
     * （`node-credential-rotation`），连续点击会被 429 挡回。
     */
    /** 生成/重新生成短时一键安装命令（会撤销尚未使用的旧 enrollment）。 */
    createNodeEnrollment: (id: ID, cookie?: string) =>
      post<NodeEnrollmentIssued>(`/admin/node/${id}/enrollment`, {}, cookie),
    /** 签发凭据（明文只此一次可见）。已有有效凭据 → 409 */
    issueNodeCredential: (id: ID, cookie?: string) =>
      post<NodeCredentialIssued>(`/admin/node/${id}/credential`, {}, cookie),
    /** 轮换凭据：覆盖哈希列，旧明文立即失效；从未签发 → 404 */
    rotateNodeCredential: (id: ID, cookie?: string) =>
      post<NodeCredentialIssued>(`/admin/node/${id}/credential/rotate`, {}, cookie),
    /** 撤销凭据：保留哈希 + 置 revoked 位，重连一律拒绝 */
    revokeNodeCredential: (id: ID, cookie?: string) =>
      post<NodeCredentialRevoked>(`/admin/node/${id}/credential/revoke`, {}, cookie),
    /**
     * 节点详情：列表字段 + 出口池 + 运行态快照。
     */
    nodeDetail: (id: ID, cookie?: string) => get<NodeDetail>(`/admin/nodes/${id}`, undefined, cookie),
    /**
     * 出口池 / 出口目标 CRUD。
     *
     * 不变式由后端保证、前端必须如实展示的两条：
     *   1. 池内至少一个 active 且 weight>0 的目标（删到空 = 拒绝，属于服务层
     *      而非 DB 约束）；
     *   2. 目标修改只更新快照，不重建 ingress listener（热更新）。
     */
    pools: (nodeId: ID, cookie?: string) => get<EgressPool[]>(`/admin/nodes/${nodeId}/pools`, undefined, cookie),
    createPool: (nodeId: ID, input: EgressPoolInput, cookie?: string) =>
      post<EgressPool>(`/admin/nodes/${nodeId}/pools`, input, cookie),
    updatePool: (nodeId: ID, poolId: ID, input: Partial<EgressPoolInput>, cookie?: string) =>
      patch<EgressPool>(`/admin/nodes/${nodeId}/pools/${poolId}`, input, cookie),
    removePool: (nodeId: ID, poolId: ID, cookie?: string) =>
      del<{ ok: boolean }>(`/admin/nodes/${nodeId}/pools/${poolId}`, cookie),
    createTarget: (nodeId: ID, poolId: ID, input: EgressTargetInput, cookie?: string) =>
      post<EgressTarget>(`/admin/nodes/${nodeId}/pools/${poolId}/targets`, input, cookie),
    updateTarget: (nodeId: ID, poolId: ID, targetId: ID, input: Partial<EgressTargetInput>, cookie?: string) =>
      patch<EgressTarget>(`/admin/nodes/${nodeId}/pools/${poolId}/targets/${targetId}`, input, cookie),
    removeTarget: (nodeId: ID, poolId: ID, targetId: ID, cookie?: string) =>
      del<{ ok: boolean }>(`/admin/nodes/${nodeId}/pools/${poolId}/targets/${targetId}`, cookie),
    /** 运行态诊断（WP7 上报 → NodeStateReport；无上报时 404/空） */
    nodeState: (id: ID, cookie?: string) => get<NodeStateReport>(`/admin/nodes/${id}/state`, undefined, cookie),
    /**
     * V4-WP6 §13.4.4：节点健康视图（后端 `routes/node-health.ts`）。
     *
     * 端点用**单数** `/admin/node/:id/health`（与 WP7 凭据端点同一前缀），
     * 返回 `{ data: NodeHealthView }`（单层信封 → 走通用解包）。
     * health / connection / reasons / telemetry 全部由后端合成，前端不重算：
     * §13.4.1 明文「Agent 只上报原始状态，不允许一句 health=healthy 成为
     * 最终真相」。
     *
     * 未上报的节点返回 200 + `telemetry = null`（不是 404）：新节点还没事实
     * 是正常状态，页面据此显示「等待首次上报」。
     */
    nodeHealth: (id: ID, cookie?: string) =>
      get<NodeHealthView>(`/admin/node/${id}/health`, undefined, cookie),
    /**
     * V5.2 §7（WP5/WP6）：出口池的**目标健康**视图。
     *
     * 路径用后端的**真实**路径 `/admin/node/pools/:poolId/health`（单数 `node`，
     * 与 `POST/PUT .../targets` 同一前缀；见 `backend/src/routes/node-admin.ts`）。
     * 响应 `{ data: { targets, observers, observed_at } }` 是单层信封 → 走通用解包。
     *
     * 与 `.../targets` 分开取，是因为两者是两类事实：那是**期望**（用户要什么），
     * 这是**观测 + 合成**（我们看到了什么、据此判断什么）。状态 / 理由 / 逐观测者
     * 明细全部由后端给出；前端只展示，并把 age 按本地时钟现算，**不重算、不取平均、
     * 不改 desired**。
     */
    poolTargetHealth: (poolId: ID, cookie?: string) =>
      get<TargetPoolHealth>(`/admin/node/pools/${poolId}/health`, undefined, cookie),
    /**
     * V4-WP6 §13.4.4：全量巡检（`?health=` / `?lifecycle=`）。
     *
     * 响应是单层信封 `{ data, total, summary }`，`summary` 是**过滤前**的
     * 四态计数——「有多少节点是 error」不需要先拉全部节点。通用解包会丢掉
     * summary，因此这里用 `unwrap: false` 并自己解出三个字段。
     */
    nodeHealthList: async (
      query?: { health?: NodeHealthValue | "all"; lifecycle?: NodeLifecycleValue | "all" },
      cookie?: string,
    ): Promise<NodeHealthList> => {
      const envelope = await request<NodeHealthList & { data?: NodeHealthView[] }>(
        "/admin/node/health",
        { method: "GET", query: query as ListQuery, cookie, unwrap: false },
      );
      return {
        data: Array.isArray(envelope?.data) ? envelope.data : [],
        total: typeof envelope?.total === "number" ? envelope.total : 0,
        summary: normalizeHealthSummary(envelope?.summary),
      };
    },
    /**
     * V4-WP5 §13.4.2：节点生命周期视图（后端 `routes/node-lifecycle.ts`）。
     *
     * 返回 `{ data: NodeLifecycleView }`，含三层状态里的 **Lifecycle** 层与
     * **Connection** 层：`lifecycle`（管理期望态）、`connection`（事实推导）、
     * `accepts_new_business`（准入谓词）、`admission_rejection`（拒绝原因码）、
     * `allowed_transitions`（当前状态下合法的迁移目标）。
     *
     * Health 层不在这里——它由 WP6 的 `/admin/node/:id/health` 给出。
     * UI 一律直接消费这三个字段，**不自行推导**：`allowed_transitions` 是
     * 「哪些按钮能点」的唯一依据，前端复刻一遍 `canTransition` 就会在
     * 服务层加状态时出现「按钮能点但 PATCH 409」。
     */
    nodeLifecycle: (id: ID, cookie?: string) =>
      get<NodeLifecycleView>(`/admin/node/${id}/lifecycle`, undefined, cookie),
    /**
     * V4-WP5 §13.4.2：变更生命周期（进入/退出 maintenance、disabled、
     * 进入 retiring）。
     *
     * body `{ lifecycle, note? }`：`note` 键缺失 = 不动备注，`null`/空串 =
     * 显式清空。响应 `{ data: { node, view } }`——`node` 是写后整行，
     * `view` 是同一行的新生命周期视图，两者同源不会不一致。
     *
     * 非法迁移由服务端以 409 `code=invalid_state` + `condition=
     * invalid_transition` 拒绝（附合法目标清单）；UI 必须按 `condition`
     * 给出下一步，不能只说「操作失败」。
     */
    setNodeLifecycle: (
      id: ID,
      input: { lifecycle?: NodeLifecycleValue; note?: string | null },
      cookie?: string,
    ) => patch<NodeLifecycleChangeResult>(`/admin/node/${id}/lifecycle`, input, cookie),
    /**
     * V4-WP5 §13.4.3：依赖影响检查（删除/收缩前的预览）。
     *
     * 返回五类依赖计数 + `role_check`。可选传 `next_role` / `port_min` +
     * `port_max`（+ `current_role`）让后端把「收缩是否可行」一并判了——
     * 判定与真正写入同源，前端**不复制** `checkRoleChange` 的规则。
     */
    nodeImpact: (
      id: ID,
      query?: { next_role?: string; port_min?: number; port_max?: number; current_role?: string },
      cookie?: string,
    ) => get<NodeImpactResult>(`/admin/node/${id}/impact`, query as ListQuery, cookie),
    /**
     * V4-WP5 §13.4.3：物理删除节点。
     *
     * 前置条件：`lifecycle === "retiring"` 且无任何依赖（§13.4.3「Node 删除
     * 永远不隐式级联删除 Forward」）。未退役 → 409 `invalid_state`；有依赖 →
     * 409 `dependency_blocked` + `dependencies` 清单。UI 用 impact 做**预览**，
     * 但最终裁决权在服务端。
     */
    deleteNodeLifecycle: (id: ID, cookie?: string) =>
      del<{ id: ID; deleted: true }>(`/admin/node/${id}/lifecycle`, cookie),
    nodeGroups: (query?: ListQuery, cookie?: string) => get<Paginated<NodeGroup>>("/admin/node-groups", query, cookie),
    createNodeGroup: (input: NodeGroupInput, cookie?: string) =>
      post<NodeGroup>("/admin/node-groups", input, cookie),
    updateNodeGroup: (id: number, input: Partial<NodeGroupInput>, cookie?: string) =>
      patch<NodeGroup>(`/admin/node-groups/${id}`, input, cookie),
    removeNodeGroup: (id: number, cookie?: string) => del<{ ok: boolean }>(`/admin/node-groups/${id}`, cookie),
    plans: (query?: ListQuery, cookie?: string) => get<Paginated<Plan>>("/admin/plans", query, cookie),
    /// V5-WP20-4b：套餐表单的「绑定策略」下拉只用可绑集合（后端同一口径：
    /// 启用中且非平台上限模板），避免"UI 能选、保存 400"。
    planPolicyOptions: (cookie?: string) =>
      get<{ id: number; key: string; name: string; status: string; is_ceiling: boolean }[]>(
        "/admin/plan-policy-options",
        undefined,
        cookie,
      ),
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
    /**
     * V5.5 Federation（WP14/WP15/WP16）—— **只属于 Admin Console**。
     *
     * 路径与响应形状对齐 `backend/src/routes/admin-federation.ts`（唯一真相）。
     * 两条前端纪律：
     *   1. 列表端点返回 `{ data: [...] }` 信封 —— 通用解包会剥掉 `data`，这里拿到的
     *      就是数组本身；不要在这里再包一层或改成裸数组；
     *   2. 失败一律抛 `ApiError`，其 `data` 是后端 `federationErrorBody()` 的原始
     *      `{ code, message, retryable, peer_panel_id, correlation_id }`。
     *      页面必须按 `code` 分层展示「下一步」，不要压成一个 ERROR
     *      （见 `components/admin/federation/federation-status.ts`）。
     */
    federation: {
      status: (cookie?: string) => get<FederationStatus>("/admin/federation/status", undefined, cookie),
      enable: (cookie?: string) => post<FederationEnableResult>("/admin/federation/enable", {}, cookie),
      disable: (cookie?: string) => post<FederationDisableResult>("/admin/federation/disable", {}, cookie),

      peers: (cookie?: string) => get<FederationPeer[]>("/admin/federation/peers", undefined, cookie),
      /** 生成邀请：响应里的 `token` **只出现这一次**（库里只有 sha256），必须一次性展示。 */
      invitePeer: (input: FederationInviteInput, cookie?: string) =>
        post<FederationInvitation>("/admin/federation/peers/invite", input, cookie),
      handshake: (input: FederationHandshakeInput, cookie?: string) =>
        post<FederationHandshakeResult>("/admin/federation/peers/handshake", input, cookie),
      pingPeer: (id: number, cookie?: string) =>
        post<FederationPingResult>(`/admin/federation/peers/${id}/ping`, {}, cookie),
      rotatePeerKey: (id: number, cookie?: string) =>
        post<FederationPeerRotateResult>(`/admin/federation/peers/${id}/rotate`, {}, cookie),
      /** 撤销信任：**不可逆**；响应给出被连带失效的租约数。 */
      revokePeer: (id: number, cookie?: string) =>
        del<FederationPeerRevokeResult>(`/admin/federation/peers/${id}`, cookie),
      /** 轮转本机密钥（对所有可信 peer）。部分失败时 HTTP 502，体仍是 `FederationKeyRotateResult`。 */
      rotateLocalKey: (cookie?: string) => post<FederationKeyRotateResult>("/admin/federation/key/rotate", {}, cookie),

      grants: (cookie?: string) => get<FederationGrant[]>("/admin/federation/grants", undefined, cookie),
      createGrant: (input: FederationGrantInput, cookie?: string) =>
        post<FederationGrantCreateResult>("/admin/federation/grants", input, cookie),
      revokeGrant: (ref: string, cookie?: string) =>
        post<FederationGrantActionResult>(`/admin/federation/grants/${encodeURIComponent(ref)}/revoke`, {}, cookie),
      suspendGrant: (ref: string, cookie?: string) =>
        post<FederationGrantActionResult>(`/admin/federation/grants/${encodeURIComponent(ref)}/suspend`, {}, cookie),
      resumeGrant: (ref: string, cookie?: string) =>
        post<FederationGrantActionResult>(`/admin/federation/grants/${encodeURIComponent(ref)}/resume`, {}, cookie),

      leases: (cookie?: string) => get<FederationLease[]>("/admin/federation/leases", undefined, cookie),
      placements: (cookie?: string) => get<FederationPlacement[]>("/admin/federation/placements", undefined, cookie),
      usage: (cookie?: string) => get<FederationUsageRecord[]>("/admin/federation/usage", undefined, cookie),
    },
  },
};

export default api;
