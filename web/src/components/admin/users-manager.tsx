"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Field, ToggleRow } from "@/components/ui/form";
import { OptionSelect } from "@/components/ui/option-select";
import { AdminToolbar, ConfirmDeleteDialog, FormDialog, RowActions, useForm } from "@/components/admin/admin-ui";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { STATUS_OPTIONS } from "@/lib/constants";
import { formatDateTime, formatMoney, strOf, toNumOrNull } from "@/lib/utils";
import type { AdminUserInput, Paginated, User } from "@/lib/types";

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
                    <Badge variant={u.super_admin ? "default" : "outline"}>
                      {u.super_admin ? t("fields.superAdmin") : t("common.profile")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={u.status === "active" ? "success" : "muted"}>{u.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-[var(--muted-foreground)]">{formatDateTime(u.created_at)}</TableCell>
                  <TableCell>
                    <RowActions onEdit={() => openEdit(u)} onDelete={() => setDeleteTarget(u)} />
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
    </div>
  );
}
