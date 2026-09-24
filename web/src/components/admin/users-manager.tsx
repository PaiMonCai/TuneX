"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Info, Loader2 } from "lucide-react";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Field, InfoRow, ToggleRow } from "@/components/ui/form";
import { OptionSelect } from "@/components/ui/option-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AdminToolbar, ConfirmDeleteDialog, FormDialog, RowActions, useForm } from "@/components/admin/admin-ui";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { STATUS_OPTIONS } from "@/lib/constants";
import { formatDateTime, formatMoney, strOf, toNumOrNull } from "@/lib/utils";
import type { AdminRole, AdminUserInput, Paginated, User } from "@/lib/types";

interface UserForm {
  email: string;
  uid: string;
  balance: string;
  commission_balance: string;
  referral_commission_rate: string;
  note: string;
  status: User["status"];
  super_admin: boolean;
  auto_renew: boolean;
}

const EMPTY: UserForm = {
  email: "",
  uid: "",
  balance: "0",
  commission_balance: "0",
  referral_commission_rate: "",
  note: "",
  status: "active",
  super_admin: false,
  auto_renew: false,
};

function toForm(u: User): UserForm {
  return {
    email: u.email,
    uid: u.uid ?? "",
    balance: strOf(u.balance),
    commission_balance: strOf(u.commission_balance),
    referral_commission_rate: strOf(u.referral_commission_rate),
    note: u.note ?? "",
    status: u.status,
    super_admin: u.super_admin,
    auto_renew: u.auto_renew,
  };
}

function toPayload(f: UserForm): AdminUserInput {
  return {
    email: f.email.trim(),
    uid: f.uid.trim() || null,
    balance: toNumOrNull(f.balance) ?? 0,
    commission_balance: toNumOrNull(f.commission_balance) ?? 0,
    referral_commission_rate: toNumOrNull(f.referral_commission_rate),
    note: f.note.trim() || null,
    status: f.status,
    super_admin: f.super_admin,
    auto_renew: f.auto_renew,
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AdminUsersManager({ initialData }: { initialData: Paginated<User> }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [editing, setEditing] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { form, set, setForm } = useForm<UserForm>(EMPTY);

  // 详情 / 角色分配
  const [detail, setDetail] = useState<User | null>(null);
  const [rolesTarget, setRolesTarget] = useState<User | null>(null);
  const [allRoles, setAllRoles] = useState<AdminRole[]>([]);
  const [selectedRoles, setSelectedRoles] = useState<number[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [rolesPending, setRolesPending] = useState(false);

  async function load(kw = keyword) {
    setLoading(true);
    try {
      setData(await api.admin.users({ page: 1, page_size: 20, keyword: kw || undefined }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.deleteFailed"));
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setError(null);
    setOpen(true);
  }

  function openEdit(u: User) {
    setEditing(u);
    setForm(toForm(u));
    setError(null);
    setOpen(true);
  }

  async function submit() {
    const payload = toPayload(form);
    if (!EMAIL_RE.test(payload.email)) {
      setError(t("settings.emailInvalid"));
      return;
    }
    setError(null);
    setPending(true);
    try {
      if (editing) {
        await api.admin.updateUser(editing.id, payload);
        toast.success(t("admin.updateSuccess", { name: payload.email }));
      } else {
        await api.admin.createUser(payload);
        toast.success(t("admin.createSuccess", { name: payload.email }));
      }
      setOpen(false);
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("admin.saveFailed");
      setError(msg);
      toast.error(msg);
    } finally {
      setPending(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.admin.removeUser(deleteTarget.id);
      toast.success(t("admin.deleteSuccess", { name: deleteTarget.email }));
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  async function openRoles(u: User) {
    setRolesTarget(u);
    setRolesLoading(true);
    try {
      const roles = await api.admin.roles();
      setAllRoles(roles);
      const mine = (u.admin_roles ?? u.roles ?? []).map((r) => r.id);
      setSelectedRoles(mine);
    } catch {
      // 无角色读取权限（非超管）时降级为只读：列表为空
      setAllRoles([]);
      setSelectedRoles([]);
    } finally {
      setRolesLoading(false);
    }
  }

  function toggleRole(id: number) {
    setSelectedRoles((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function saveRoles() {
    if (!rolesTarget) return;
    setRolesPending(true);
    try {
      await api.admin.updateUserRoles(rolesTarget.id, selectedRoles);
      toast.success(t("admin.updateSuccess", { name: rolesTarget.email }));
      setRolesTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.saveFailed"));
    } finally {
      setRolesPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="admin-users">
      <AdminToolbar
        keyword={keyword}
        onKeywordChange={setKeyword}
        onSearch={() => load()}
        onRefresh={() => load()}
        loading={loading}
        total={data.total}
        onCreate={openCreate}
        createTestId="create-user-btn"
      />

      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>{t("common.email")}</TableHead>
              <TableHead>{t("fields.balance")}</TableHead>
              <TableHead>{t("fields.commissionBalance")}</TableHead>
              <TableHead>{t("common.role")}</TableHead>
              <TableHead>{t("common.status")}</TableHead>
              <TableHead>{t("common.createdAt")}</TableHead>
              <TableHead className="text-right">{t("common.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && data.data.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-[var(--muted-foreground)]">
                  {t("common.loading")}
                </TableCell>
              </TableRow>
            ) : data.data.length === 0 ? (
              <TableEmpty colSpan={8} text={t("common.noData")} />
            ) : (
              data.data.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-mono text-xs">{u.id}</TableCell>
                  <TableCell className="font-medium">{u.email}</TableCell>
                  <TableCell>{formatMoney(u.balance)}</TableCell>
                  <TableCell>{formatMoney(u.commission_balance)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant={u.super_admin ? "default" : "outline"}>
                        {u.super_admin ? t("fields.superAdmin") : t("common.profile")}
                      </Badge>
                      {(u.admin_roles ?? u.roles ?? []).map((r) => (
                        <Badge key={r.id} variant="muted">
                          {r.name}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.status === "active" ? "success" : "muted"}>{u.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-[var(--muted-foreground)]">{formatDateTime(u.created_at)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setDetail(u)} data-testid="user-detail">
                        <Info className="size-4" />
                        {t("admin.userDetail")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => openRoles(u)} data-testid="user-roles">
                        {t("admin.roles")}
                      </Button>
                      <RowActions onEdit={() => openEdit(u)} onDelete={() => setDeleteTarget(u)} />
                    </div>
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
            ? t("admin.editTitle", { name: t("admin.users") })
            : t("admin.createTitle", { name: t("admin.users") })
        }
        onSubmit={submit}
        submitLabel={t("common.save")}
        pending={pending}
        wide
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("common.email")} error={error ?? undefined}>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              required
              data-testid="user-email"
            />
          </Field>
          <Field label="UID" hint={t("common.optional")}>
            <Input value={form.uid} onChange={(e) => set("uid", e.target.value)} placeholder="RX-100001" />
          </Field>
          <Field label={t("fields.balance")}>
            <Input
              type="number"
              step="0.01"
              value={form.balance}
              onChange={(e) => set("balance", e.target.value)}
              data-testid="user-balance"
            />
          </Field>
          <Field label={t("fields.commissionBalance")}>
            <Input
              type="number"
              step="0.01"
              value={form.commission_balance}
              onChange={(e) => set("commission_balance", e.target.value)}
            />
          </Field>
          <Field label="Referral rate" hint="0.15">
            <Input
              type="number"
              step="0.01"
              min={0}
              max={1}
              value={form.referral_commission_rate}
              onChange={(e) => set("referral_commission_rate", e.target.value)}
            />
          </Field>
          <Field label={t("common.status")}>
            <OptionSelect
              value={form.status}
              onValueChange={(v) => set("status", v as User["status"])}
              options={STATUS_OPTIONS}
              locale={locale}
            />
          </Field>
        </div>
        <Field label={t("common.remark")} hint={t("common.optional")}>
          <Textarea rows={2} value={form.note} onChange={(e) => set("note", e.target.value)} />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <ToggleRow
            label={t("fields.superAdmin")}
            checked={form.super_admin}
            onCheckedChange={(v) => set("super_admin", v)}
          />
          <ToggleRow
            label={t("settings.autoRenew")}
            checked={form.auto_renew}
            onCheckedChange={(v) => set("auto_renew", v)}
          />
        </div>
      </FormDialog>

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(v) => !v && setDeleteTarget(null)}
        title={t("common.delete")}
        description={t("admin.deleteConfirm", { name: deleteTarget?.email ?? "" })}
        onConfirm={confirmDelete}
        pending={deleting}
      />

      {/* 用户详情（只读） */}
      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.userDetail")}</DialogTitle>
            <DialogDescription>{detail?.email}</DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="divide-y divide-[var(--border)]">
              <InfoRow label="ID">{detail.id}</InfoRow>
              <InfoRow label={t("common.email")}>{detail.email}</InfoRow>
              <InfoRow label="UID">{detail.uid ?? "-"}</InfoRow>
              <InfoRow label={t("fields.balance")}>{formatMoney(detail.balance)}</InfoRow>
              <InfoRow label={t("fields.commissionBalance")}>{formatMoney(detail.commission_balance)}</InfoRow>
              <InfoRow label={t("fields.referralRate")}>{detail.referral_commission_rate ?? "-"}</InfoRow>
              <InfoRow label={t("common.role")}>
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {detail.super_admin && <Badge variant="default">{t("fields.superAdmin")}</Badge>}
                  {(detail.admin_roles ?? detail.roles ?? []).length === 0 && !detail.super_admin ? (
                    <span className="text-[var(--muted-foreground)]">{t("admin.noRole")}</span>
                  ) : (
                    (detail.admin_roles ?? detail.roles ?? []).map((r) => (
                      <Badge key={r.id} variant="muted">
                        {r.name}
                      </Badge>
                    ))
                  )}
                </div>
              </InfoRow>
              <InfoRow label={t("common.status")}>
                <Badge variant={detail.status === "active" ? "success" : "muted"}>{detail.status}</Badge>
              </InfoRow>
              <InfoRow label={t("fields.autoRenew")}>{detail.auto_renew ? t("common.yes") : t("common.no")}</InfoRow>
              <InfoRow label={t("common.remark")}>{detail.note ?? "-"}</InfoRow>
              <InfoRow label={t("common.createdAt")}>{formatDateTime(detail.created_at)}</InfoRow>
              <InfoRow label={t("common.updatedAt")}>{formatDateTime(detail.updated_at)}</InfoRow>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 角色分配（仅超管可保存） */}
      <Dialog open={!!rolesTarget} onOpenChange={(v) => !v && setRolesTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.roles")}</DialogTitle>
            <DialogDescription>{rolesTarget?.email}</DialogDescription>
          </DialogHeader>
          {rolesLoading ? (
            <div className="flex items-center justify-center py-8 text-[var(--muted-foreground)]">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : allRoles.length === 0 ? (
            <p className="py-4 text-sm text-[var(--muted-foreground)]">{t("admin.noRole")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="field-hint">{t("admin.userRoleHint")}</p>
              <div className="max-h-[40vh] overflow-y-auto rounded-md border border-[var(--border)] divide-y divide-[var(--border)]">
                {allRoles.map((r) => (
                  <label key={r.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-[var(--muted)]/40">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={selectedRoles.includes(r.id)}
                      onChange={() => toggleRole(r.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{r.name}</span>
                      {r.description && <span className="field-hint block truncate">{r.description}</span>}
                    </span>
                    <Badge variant="outline">{t("admin.permissionCount", { n: Object.keys(r.permissions).length })}</Badge>
                  </label>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRolesTarget(null)} disabled={rolesPending}>
              {t("common.cancel")}
            </Button>
            <Button onClick={saveRoles} disabled={rolesPending || rolesLoading || allRoles.length === 0} data-testid="roles-save">
              {rolesPending && <Loader2 className="size-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
