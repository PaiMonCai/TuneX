/**
 * TuneX HTTP client core: workspace scope, CSRF, session handling and transport.
 */
import type { AuthSession, ListQuery } from "../types";
import { shouldRedirectToLogin } from "../workspace-permissions";

export const API_MOCK = process.env.NEXT_PUBLIC_API_MOCK === "1";
const SERVER_BASE = process.env.SERVER_API_BASE ?? "http://backend:3000";
export const API_BASE = API_MOCK ? "" : typeof window === "undefined" ? SERVER_BASE : "";

export const WORKSPACE_HEADER = "x-workspace-id";
export const WORKSPACE_COOKIE = "tunex_workspace";
let activeWorkspaceId: number | null = null;

export function setActiveWorkspace(id: number | null): void {
  activeWorkspaceId = id && Number.isFinite(id) && id > 0 ? id : null;
}
export function getActiveWorkspace(): number | null { return activeWorkspaceId; }
export function workspaceIdFromCookie(cookie: string): number | null {
  const m = new RegExp(`${WORKSPACE_COOKIE}=w(\\d+)`).exec(cookie);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}
export function workspaceCookieString(id: number): string {
  return `${WORKSPACE_COOKIE}=w${id}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message); this.name = "ApiError"; this.status = status; this.data = data;
  }
}
export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: ListQuery;
  cookie?: string;
  noRedirect?: boolean;
  cache?: RequestCache;
  workspaceId?: number;
  unwrap?: boolean;
}

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
export function applyMockSessionCookie(session: AuthSession | null): void {
  if (typeof document === "undefined") return;
  if (session?.session_cookie) document.cookie = session.session_cookie;
}
export function clearMockSessionCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = "tunex_session=; Path=/; Max-Age=0; SameSite=Lax";
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, cookie, noRedirect, cache, workspaceId, unwrap = true } = options;
  const url = `/api${path.startsWith("/") ? path : `/${path}`}${buildQuery(query)}`;
  if (API_MOCK) {
    const { handleMock } = await import("@/mocks/handler");
    const reqCookie = cookie ?? (typeof document !== "undefined" ? document.cookie : undefined);
    const res = await handleMock(method, path, {
      body, query, cookie: reqCookie,
      workspaceId: workspaceId ?? (typeof window !== "undefined"
        ? activeWorkspaceId ?? undefined
        : reqCookie ? workspaceIdFromCookie(reqCookie) ?? undefined : undefined),
    });
    if (res.status === 401 && !noRedirect) redirectToLogin();
    if (res.status >= 400) throw new ApiError(res.status, (res.body as { message?: string })?.message ?? "Request failed", res.body);
    return res.body as T;
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers["Cookie"] = cookie;
  const wsId = workspaceId ?? (typeof window !== "undefined" ? activeWorkspaceId : null);
  if (wsId !== null) headers[WORKSPACE_HEADER] = String(wsId);
  const isMutating = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  if (isMutating) headers[CSRF_TOKEN_HEADER] = "1";
  const res = await fetch(`${API_BASE}${url}`, {
    method, headers, credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: cache ?? "no-store",
  });
  return await finalize<T>(res, noRedirect, unwrap);
}

async function finalize<T>(res: Response, noRedirect?: boolean, unwrap = true): Promise<T> {
  if (shouldRedirectToLogin(res.status) && !noRedirect) redirectToLogin();
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const body = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const pick = (key: string): string | null => {
      const value = body?.[key];
      return typeof value === "string" && value.trim() !== "" ? value : null;
    };
    const msg = pick("message") ?? pick("error") ?? `Request failed with status ${res.status}`;
    throw new ApiError(res.status, msg, data);
  }
  return unwrap ? unwrapData<T>(data) : (data as T);
}
function unwrapData<T>(data: unknown): T {
  const payload = data && typeof data === "object" && "data" in (data as Record<string, unknown>)
    ? (data as Record<string, unknown>).data : data;
  return payload as T;
}

export const get = <T>(path: string, query?: ListQuery, cookie?: string) =>
  request<T>(path, { method: "GET", query, cookie, workspaceId: cookie ? workspaceIdFromCookie(cookie) ?? undefined : undefined });
export const post = <T>(path: string, body?: unknown, cookie?: string) => request<T>(path, { method: "POST", body, cookie });
export const put = <T>(path: string, body?: unknown, cookie?: string) => request<T>(path, { method: "PUT", body, cookie });
export const patch = <T>(path: string, body?: unknown, cookie?: string) => request<T>(path, { method: "PATCH", body, cookie });
export const del = <T>(path: string, cookie?: string) => request<T>(path, { method: "DELETE", cookie });
