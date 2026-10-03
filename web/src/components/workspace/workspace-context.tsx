"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, request, setActiveWorkspace, WORKSPACE_COOKIE, workspaceCookieString } from "@/lib/api";
import { canMutateForward, createPermissionRequestFence, hasWorkspacePermission, validPermissionProjection } from "@/lib/workspace-permissions";
import type { EffectiveWorkspacePermissions, WorkspacePermission } from "@/lib/workspace-permissions";
import type { PortForward, User, Workspace, WorkspaceCreateInput, WorkspaceKind, WorkspaceRole } from "@/lib/types";

export interface WorkspaceContextValue {
  workspaces: Workspace[];
  current: Workspace | null;
  currentId: number | null;
  role: WorkspaceRole | null;
  kind: WorkspaceKind | null;
  me: { id: number; email: string } | null;
  canManage: boolean;
  permissions: EffectiveWorkspacePermissions | null;
  permissionsLoading: boolean;
  can: (permission: WorkspacePermission) => boolean;
  canForward: (forward: PortForward, action: "update" | "delete") => boolean;
  loading: boolean;
  error: string | null;
  select: (id: number) => void;
  createTeam: (name: string) => Promise<Workspace | null>;
  refresh: () => Promise<void>;
}
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
function workspaceIdFromCookieClient(): number | null {
  if (typeof document === "undefined") return null;
  const m = new RegExp(`${WORKSPACE_COOKIE}=w(\\d+)`).exec(document.cookie);
  const id = m ? Number(m[1]) : 0;
  return Number.isInteger(id) && id > 0 ? id : null;
}
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(workspaceIdFromCookieClient);
  const [me, setMe] = useState<{ id: number; email: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projection, setProjection] = useState<EffectiveWorkspacePermissions | null>(null);
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const [permissionRefresh, setPermissionRefresh] = useState(0);
  const listFence = useRef(createPermissionRequestFence());
  const permissionFence = useRef(createPermissionRequestFence());

  const load = useCallback(async () => {
    const ticket = listFence.current.next();
    permissionFence.current.next();
    setProjection(null); // Refresh invalidates privileges immediately, even if role name did not change.
    setPermissionsLoading(true);
    setLoading(true);
    try {
      const [list, session] = await Promise.all([
        request<Workspace[]>("/workspaces", { noRedirect: true }),
        request<User>("/auth/me", { noRedirect: true }).catch(() => null),
      ]);
      if (!listFence.current.current(ticket)) return;
      setWorkspaces(list);
      setMe(session ? { id: session.id, email: session.email } : null);
      setError(null);
      setCurrentId((prev) => prev !== null && list.some((w) => w.id === prev) ? prev : list[0]?.id ?? null);
    } catch (err) {
      if (!listFence.current.current(ticket)) return;
      setWorkspaces([]);
      setMe(null);
      setCurrentId(null);
      setError(err instanceof Error ? err.message : "工作空间加载失败");
    } finally {
      if (listFence.current.current(ticket)) {
        setLoading(false);
        setPermissionRefresh((n) => n + 1);
      }
    }
  }, []);
  useEffect(() => { void load(); return () => { listFence.current.next(); permissionFence.current.next(); }; }, [load]);

  useEffect(() => {
    setActiveWorkspace(currentId);
    if (currentId !== null) document.cookie = workspaceCookieString(currentId);
    else document.cookie = `${WORKSPACE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  }, [currentId]);
  useEffect(() => {
    const ticket = permissionFence.current.next();
    setProjection(null);
    if (loading || currentId === null || !me || !workspaces.some((w) => w.id === currentId)) {
      setPermissionsLoading(loading);
      return;
    }
    setPermissionsLoading(true);
    void api.workspaces.permissions(currentId).then((value) => {
      if (!permissionFence.current.current(ticket)) return;
      if (!validPermissionProjection(value, currentId, me.id)) throw new Error("有效权限响应无效，已按只读处理");
      setProjection(value);
      setError(null);
    }).catch((err) => {
      if (!permissionFence.current.current(ticket)) return;
      setProjection(null);
      setError(err instanceof Error ? err.message : "有效权限加载失败，已拒绝操作");
    }).finally(() => {
      if (permissionFence.current.current(ticket)) setPermissionsLoading(false);
    });
    return () => { permissionFence.current.next(); };
  }, [currentId, me, loading, workspaces, permissionRefresh]);

  const select = useCallback((id: number) => {
    if (!workspaces.some((w) => w.id === id)) return;
    permissionFence.current.next();
    setProjection(null);
    setPermissionsLoading(true);
    setPermissionRefresh((n) => n + 1);
    setActiveWorkspace(id); // Before any descendant effect issues its new-scope request.
    document.cookie = workspaceCookieString(id);
    setCurrentId(id);
  }, [workspaces]);
  const createTeam = useCallback(async (name: string) => {
    try {
      const created = await request<Workspace>("/workspaces", { method: "POST", body: { name } satisfies WorkspaceCreateInput });
      permissionFence.current.next();
      setProjection(null);
      setPermissionsLoading(true);
      setActiveWorkspace(created.id);
      document.cookie = workspaceCookieString(created.id);
      setWorkspaces((prev) => [...prev, created]);
      setCurrentId(created.id);
      return created;
    } catch (err) { toast.error(err instanceof Error ? err.message : "创建工作空间失败"); return null; }
  }, []);
  const current = workspaces.find((w) => w.id === currentId) ?? null;
  const permissions = !loading && !permissionsLoading && validPermissionProjection(projection, currentId, me?.id ?? null) ? projection : null;
  const value = useMemo<WorkspaceContextValue>(() => ({
    workspaces, current, currentId, role: permissions?.role ?? null, kind: current?.kind ?? null, me,
    permissions, permissionsLoading: loading || permissionsLoading,
    can: (key) => hasWorkspacePermission(permissions, key),
    canForward: (forward, action) => canMutateForward(permissions, forward, action),
    canManage: hasWorkspacePermission(permissions, "member:manage"),
    loading, error, select, createTeam, refresh: load,
  }), [workspaces, current, currentId, me, permissions, permissionsLoading, loading, error, select, createTeam, load]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return ctx;
}
