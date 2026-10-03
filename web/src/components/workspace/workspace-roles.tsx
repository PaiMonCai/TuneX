"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, getActiveWorkspace } from "@/lib/api";
import { useWorkspace } from "./workspace-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WORKSPACE_PERMISSION_KEYS, PERMISSION_DENIED } from "@/lib/workspace-permissions";
import type { WorkspaceCustomRole } from "@/lib/workspace-permissions";

/** UX only; grant subset, owner protection and role-in-use decisions belong to the server. */
export function WorkspaceRoles({ onChanged }: { onChanged: () => void }) {
  const { currentId, current, permissions, canManage, refresh } = useWorkspace();
  const [roles, setRoles] = useState<WorkspaceCustomRole[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const allowed = canManage && current?.kind === "team";
  async function load() {
    const ticket = ++seq.current;
    setRoles([]); setError(null);
    if (!allowed || currentId === null) return;
    setLoading(true);
    try {
      const rows = await api.workspaces.roles(currentId);
      if (ticket === seq.current && getActiveWorkspace() === currentId) setRoles(rows);
    } catch (err) {
      if (ticket === seq.current) setError(err instanceof Error ? err.message : PERMISSION_DENIED);
    } finally { if (ticket === seq.current) setLoading(false); }
  }
  useEffect(() => { setOpen(false); void load(); return () => { seq.current++; }; }, [currentId, permissions]);
  function edit(role?: WorkspaceCustomRole) {
    if (!allowed) return;
    setEditing(role?.id ?? null); setName(role?.name ?? ""); setDescription(role?.description ?? "");
    setSelected(WORKSPACE_PERMISSION_KEYS.filter((key) => role?.permissions[key] === true)); setError(null); setOpen(true);
  }
  async function save() {
    if (!allowed || currentId === null || busy || !name.trim()) return;
    const scope = currentId;
    setBusy(true); setError(null);
    try {
      const input = { name: name.trim(), description: description.trim() || null, permissions: Object.fromEntries(WORKSPACE_PERMISSION_KEYS.map((key) => [key, selected.includes(key)])) };
      if (editing === null) await api.workspaces.createRole(scope, input);
      else await api.workspaces.updateRole(scope, editing, input);
      if (getActiveWorkspace() !== scope) return;
      setOpen(false); toast.success("角色已保存"); onChanged(); await refresh();
    } catch (err) {
      if (getActiveWorkspace() === scope) setError(err instanceof Error ? err.message : PERMISSION_DENIED);
    } finally { setBusy(false); }
  }
  async function remove(role: WorkspaceCustomRole) {
    if (!allowed || currentId === null || busy || !confirm(`删除角色「${role.name}」？正在使用的角色会被服务端拒绝。`)) return;
    const scope = currentId;
    setBusy(true); setError(null);
    try {
      await api.workspaces.deleteRole(scope, role.id);
      if (getActiveWorkspace() !== scope) return;
      toast.success("角色已删除"); onChanged(); await refresh();
    } catch (err) { if (getActiveWorkspace() === scope) setError(err instanceof Error ? err.message : PERMISSION_DENIED); }
    finally { setBusy(false); }
  }
  if (!allowed) return null;
  return <Card>
    <CardHeader>
      <CardTitle>自定义角色</CardTitle>
      <CardDescription>自定义角色替代基础角色权限，不叠加。可授予权限的子集由服务端裁决；拒绝时不会保存。</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">
      <Button size="sm" className="self-start" onClick={() => edit()} disabled={busy} data-testid="workspace-role-create">创建角色</Button>
      {error && <p role="alert" className="text-sm text-[var(--destructive)]">操作被拒绝：{error}</p>}
      {loading ? <p>加载角色…</p> : roles.length === 0 ? <p className="text-sm">暂无自定义角色</p> : roles.map((role) => <div key={role.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] p-3">
        <div><p className="font-medium">{role.name}</p><p className="text-xs text-[var(--muted-foreground)]">{role.description || "无说明"}</p><p className="text-xs break-all">{WORKSPACE_PERMISSION_KEYS.filter((key) => role.permissions[key] === true).join(" · ") || "无权限"}</p></div>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => edit(role)}>编辑</Button><Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(role)}>删除</Button></div>
      </div>)}
      <Dialog open={open && allowed} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing === null ? "创建角色" : "编辑角色"}</DialogTitle></DialogHeader>
          <Label htmlFor="workspace-role-name">名称</Label><Input id="workspace-role-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
          <Label htmlFor="workspace-role-description">说明</Label><Input id="workspace-role-description" value={description} onChange={(e) => setDescription(e.target.value)} />
          <fieldset className="grid grid-cols-2 gap-2"><legend className="mb-2 text-sm">有效权限</legend>{WORKSPACE_PERMISSION_KEYS.map((key) => <label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={selected.includes(key)} onChange={(e) => setSelected((keys) => e.target.checked ? [...keys, key] : keys.filter((k) => k !== key))} />{key}</label>)}</fieldset>
          {error && <p role="alert" className="text-sm text-[var(--destructive)]">操作被拒绝：{error}</p>}
          <DialogFooter><Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>取消</Button><Button onClick={() => void save()} disabled={busy || !name.trim()}>保存</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </CardContent>
  </Card>;
}
