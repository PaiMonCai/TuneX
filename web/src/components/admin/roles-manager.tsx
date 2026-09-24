"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ShieldCheck } from "lucide-react";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AdminToolbar, ConfirmDeleteDialog, FormDialog, RowActions, useForm } from "@/components/admin/admin-ui";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime } from "@/lib/utils";
import type { AdminResourceMeta, AdminRole, AdminRoleInput, PermissionLevel } from "@/lib/types";

interface RoleForm {
  name: string;
  description: string;
  permissions: Record<string, PermissionLevel>;
}

const EMPTY: RoleForm = { name: "", description: "", permissions: {} };

function toForm(r: AdminRole): RoleForm {
  return { name: r.name, description: r.description ?? "", permissions: { ...r.permissions } };
}

function toPayload(f: RoleForm): AdminRoleInput {
  return {
    name: f.name.trim(),
    description: f.description.trim() || null,
    permissions: f.permissions,
  };
}

/** 权限级别选项（值 none 表示「无权限」，提交时剔除） */
const LEVELS = [
  { value: "none", zh: "无权限", en: "None" },
  { value: "read", zh: "只读", en: "Read" },
  { value: "write", zh: "读写", en: "Write" },
] as const;

const LEVEL_BADGE: Record<PermissionLevel, "success" | "default" | "muted"> = {
  write: "success",
  read: "default",
};

export function AdminRolesManager({
  initialData,
  resources,
}: {
  initialData: AdminRole[];
  resources: AdminResourceMeta[];
}) {
  const { t, locale } = useI18n();
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [editing, setEditing] = useState<AdminRole | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminRole | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { form, set, setForm } = useForm<RoleForm>(EMPTY);

  // 按资源分组渲染权限矩阵
  const grouped = useMemo(() => {
    const map = new Map<string, AdminResourceMeta[]>();
    for (const r of resources) {
      const arr = map.get(r.group) ?? [];
      arr.push(r);
      map.set(r.group, arr);
    }
    return [...map.entries()];
  }, [resources]);

  async function load(kw = keyword) {
    setLoading(true);
    try {
      const rows = await api.admin.roles();
      const filtered = kw
        ? rows.filter((r) => r.name.toLowerCase().includes(kw.trim().toLowerCase()))
        : rows;
      setData(filtered);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.deleteFailed"));
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }

  function openEdit(r: AdminRole) {
    setEditing(r);
    setForm(toForm(r));
    setOpen(true);
  }

  function setLevel(key: string, level: string) {
    setForm((prev) => {
      const next = { ...prev.permissions };
      if (level === "none") delete next[key];
      else next[key] = level as PermissionLevel;
      return { ...prev, permissions: next };
    });
  }

  function clearAll() {
    setForm((prev) => ({ ...prev, permissions: {} }));
  }

  async function submit() {
    const payload = toPayload(form);
    if (!payload.name) {
      toast.error(t("admin.saveFailed"));
      return;
    }
    setPending(true);
    try {
      if (editing) {
        await api.admin.updateRole(editing.id, payload);
        toast.success(t("admin.updateSuccess", { name: payload.name }));
      } else {
        await api.admin.createRole(payload);
        toast.success(t("admin.createSuccess", { name: payload.name }));
      }
      setOpen(false);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.saveFailed"));
    } finally {
      setPending(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.admin.removeRole(deleteTarget.id);
      toast.success(t("admin.deleteSuccess", { name: deleteTarget.name }));
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  const permCount = (r: AdminRole) => Object.keys(r.permissions).length;
  const selectedCount = Object.keys(form.permissions).length;

  return (
    <div className="flex flex-col gap-4" data-testid="admin-roles">
      <AdminToolbar
        keyword={keyword}
        onKeywordChange={setKeyword}
        onSearch={() => load()}
        onRefresh={() => load()}
        loading={loading}
        total={data.length}
        onCreate={openCreate}
        createTestId="create-role-btn"
      />

      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>{t("admin.roleName")}</TableHead>
              <TableHead>{t("admin.roleDesc")}</TableHead>
              <TableHead>{t("admin.permissions")}</TableHead>
              <TableHead>{t("admin.roleUsers")}</TableHead>
              <TableHead>{t("common.updatedAt")}</TableHead>
              <TableHead className="text-right">{t("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-[var(--muted-foreground)]">
                  {t("common.loading")}
                </TableCell>
              </TableRow>
            ) : data.length === 0 ? (
              <TableEmpty colSpan={7} text={t("common.noData")} />
            ) : (
              data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.id}</TableCell>
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      <ShieldCheck className="size-4 text-[var(--muted-foreground)]" />
                      {r.name}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-[var(--muted-foreground)]">{r.description ?? "-"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{t("admin.permissionCount", { n: permCount(r) })}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">{r._count?.users ?? 0}</TableCell>
                  <TableCell className="text-xs text-[var(--muted-foreground)]">{formatDateTime(r.updated_at)}</TableCell>
                  <TableCell>
                    <RowActions onEdit={() => openEdit(r)} onDelete={() => setDeleteTarget(r)} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={
          editing
            ? t("admin.editTitle", { name: t("admin.roleTitle") })
            : t("admin.createTitle", { name: t("admin.roleTitle") })
        }
        onSubmit={submit}
        submitLabel={t("common.save")}
        pending={pending}
        wide
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("admin.roleName")}>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} required data-testid="role-name" />
          </Field>
          <Field label={t("admin.roleDesc")} hint={t("common.optional")}>
            <Input value={form.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-sm font-medium">{t("admin.permissions")}</div>
              <p className="field-hint">{t("admin.permGroupHint")}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{t("admin.permissionCount", { n: selectedCount })}</Badge>
              <Button type="button" size="sm" variant="outline" onClick={clearAll}>
                {t("admin.permNone")}
              </Button>
            </div>
          </div>

          <div className="max-h-[46vh] overflow-y-auto rounded-md border border-[var(--border)]">
            {grouped.map(([group, items]) => (
              <div key={group} className="border-b border-[var(--border)] last:border-0">
                <div className="bg-[var(--muted)]/40 px-3 py-1.5 text-xs font-medium text-[var(--muted-foreground)]">
                  {group}
                </div>
                <div className="divide-y divide-[var(--border)]">
                  {items.map((res) => (
                    <div key={res.key} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm">{res.label}</div>
                        <div className="truncate font-mono text-[11px] text-[var(--muted-foreground)]">{res.key}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        {res.business && <Badge variant="muted">business</Badge>}
                        <Select
                          value={form.permissions[res.key] ?? "none"}
                          onValueChange={(v) => setLevel(res.key, v)}
                        >
                          <SelectTrigger className="w-28" data-testid={`perm-${res.key}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {LEVELS.map((l) => (
                              <SelectItem key={l.value} value={l.value}>
                                {locale === "en" ? l.en : l.zh}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </FormDialog>

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title={t("common.delete")}
        description={t("admin.deleteConfirm", { name: deleteTarget?.name ?? "" })}
        onConfirm={confirmDelete}
        pending={deleting}
      />
    </div>
  );
}
