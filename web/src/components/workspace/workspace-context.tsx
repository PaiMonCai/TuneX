"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { request, setActiveWorkspace, WORKSPACE_COOKIE, workspaceCookieString } from "@/lib/api";
import type { User, Workspace, WorkspaceCreateInput, WorkspaceKind, WorkspaceRole } from "@/lib/types";

/**
 * TEN-01 workspace 上下文（客户端）。
 *
 * 为什么需要它：切换 workspace 后，tunnels / node-groups / dashboard 的读写必须
 * 带 `x-workspace-id` 请求头（后端 resolveWorkspaceAccess 的作用域），而顶栏下拉、
 * 成员管理页、邀请弹窗是三处独立组件，需要共享同一份「当前空间 + 可访问列表」。
 *
 * 存储：
 *   - 内存：lib/api.ts 的模块级 activeWorkspaceId（请求头注入用），由本 provider 同步；
 *   - cookie：`tunex_workspace=w<id>`，刷新/SSR 后据此恢复（见 lib/api.ts workspaceIdFromCookie）。
 */

export interface WorkspaceContextValue {
  /** 可访问的全部 workspace（含个人空间），按后端返回顺序 */
  workspaces: Workspace[];
  /** 当前选中的 workspace；null = 列表为空或仍在加载 */
  current: Workspace | null;
  currentId: number | null;
  role: WorkspaceRole | null;
  kind: WorkspaceKind | null;
  /** 当前登录用户（会话解析），用于「移除自己 = 退出」等场景 */
  me: { id: number; email: string } | null;
  /** owner/admin 才有（与后端 canWorkspaceAction(role, "manage") 对齐）：成员管理、邀请 */
  canManage: boolean;
  loading: boolean;
  error: string | null;
  /** 切换 workspace：更新上下文 + 请求头 + cookie，页面数据随之刷新 */
  select: (id: number) => void;
  /** 创建团队空间并自动切过去（返回新空间，失败返回 null） */
  createTeam: (name: string) => Promise<Workspace | null>;
  /** 重新拉取列表（成员变更 / 接受邀请后调用） */
  refresh: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** 从 cookie 恢复上次选中的 workspace（SSR 首帧就要正确，避免闪烁） */
function workspaceIdFromCookieClient(): number | null {
  if (typeof document === "undefined") return null;
  const m = new RegExp(`${WORKSPACE_COOKIE}=w(\\d+)`).exec(document.cookie);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(() => workspaceIdFromCookieClient());
  const [me, setMe] = useState<{ id: number; email: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      // noRedirect：provider 挂在根布局上，未登录访问时静默失败，不把用户踹去登录页
      const [list, session] = await Promise.all([
        request<Workspace[]>("/workspaces", { method: "GET", noRedirect: true }),
        request<User>("/auth/me", { method: "GET", noRedirect: true }).catch(() => null),
      ]);
      setWorkspaces(list);
      setError(null);
      setMe(session ? { id: session.id, email: session.email } : null);
      // 当前值失效（被移出 / 空间已删）时回落到第一个（通常是个人空间）
      setCurrentId((prev) => (prev !== null && list.some((w) => w.id === prev) ? prev : (list[0]?.id ?? null)));
    } catch {
      // 未登录时列表为空：下拉不渲染，登录页也不受影响
      setWorkspaces([]);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 同步 current → 请求头（后续所有 api 请求自动携带）+ cookie（刷新 / SSR 恢复）
  useEffect(() => {
    setActiveWorkspace(currentId);
    if (currentId !== null) document.cookie = workspaceCookieString(currentId);
  }, [currentId]);

  const select = useCallback((id: number) => {
    setCurrentId((prev) => (prev === id ? prev : id));
  }, []);

  const createTeam = useCallback(async (name: string) => {
    try {
      const created = await request<Workspace>("/workspaces", {
        method: "POST",
        body: { name } satisfies WorkspaceCreateInput,
      });
      setWorkspaces((prev) => [...prev, created]);
      setCurrentId(created.id);
      return created;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      toast.error(msg || "创建工作空间失败");
      return null;
    }
  }, []);

  const current = useMemo(() => workspaces.find((w) => w.id === currentId) ?? null, [workspaces, currentId]);

  const value = useMemo<WorkspaceContextValue>(() => {
    const canManage = current?.role === "owner" || current?.role === "admin";
    return {
      workspaces,
      current,
      currentId,
      role: current?.role ?? null,
      kind: current?.kind ?? null,
      me,
      canManage,
      loading,
      error,
      select,
      createTeam,
      refresh: () => load(true),
    };
  }, [workspaces, current, currentId, me, loading, error, select, createTeam, load]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return ctx;
}
