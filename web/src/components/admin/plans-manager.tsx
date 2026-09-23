"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Field, ToggleRow } from "@/components/ui/form";
import { OptionSelect } from "@/components/ui/option-select";
import { AdminToolbar, ConfirmDeleteDialog, FormDialog, RowActions, useForm } from "@/components/admin/admin-ui";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { BILLING_CYCLES, STATUS_OPTIONS } from "@/lib/constants";
import { formatMoney, strOf, toNumOrNull } from "@/lib/utils";
import type { Paginated, Plan, PlanInput } from "@/lib/types";

interface PlanForm {
  name: string;
  description: string;
  price: string;
  original_price: string;
  max_tunnels: string;
  traffic: string;
  ip_limit: string;
  client_limit: string;
  bandwidth_limit: string;
  whitelist_limit: string;
  setup_fee: string;
  stock: string;
  order_by: string;
  billing_cycle: Plan["billing_cycle"];
  status: Plan["status"];
  renewable: boolean;
  allow_custom_in_node_group: boolean;
  allow_custom_out_node_group: boolean;
  all_in_node_groups: boolean;
  all_out_node_groups: boolean;
}

const EMPTY: PlanForm = {
  name: "",
  description: "",
  price: "",
  original_price: "",
  max_tunnels: "",
  traffic: "",
  ip_limit: "",
  client_limit: "",
  bandwidth_limit: "",
  whitelist_limit: "",
  setup_fee: "",
  stock: "",
  order_by: "1000",
  billing_cycle: "month",
  status: "active",
  renewable: true,
  allow_custom_in_node_group: true,
  allow_custom_out_node_group: true,
  all_in_node_groups: false,
  all_out_node_groups: true,
};

function toForm(p: Plan): PlanForm {
  return {
    name: p.name,
    description: p.description ?? "",
    price: strOf(p.price),
    original_price: strOf(p.original_price),
    max_tunnels: strOf(p.max_tunnels),
    traffic: strOf(p.traffic),
    ip_limit: strOf(p.ip_limit),
    client_limit: strOf(p.client_limit),
    bandwidth_limit: strOf(p.bandwidth_limit),
    whitelist_limit: strOf(p.whitelist_limit),
    setup_fee: strOf(p.setup_fee),
    stock: strOf(p.stock),
    order_by: strOf(p.order_by),
    billing_cycle: p.billing_cycle,
    status: p.status,
    renewable: p.renewable,
    allow_custom_in_node_group: p.allow_custom_in_node_group,
    allow_custom_out_node_group: p.allow_custom_out_node_group,
    all_in_node_groups: p.all_in_node_groups,
    all_out_node_groups: p.all_out_node_groups,
  };
}

function toPayload(f: PlanForm): PlanInput {
  return {
    name: f.name.trim(),
    description: f.description.trim() || null,
    price: toNumOrNull(f.price) ?? 0,
    original_price: toNumOrNull(f.original_price),
    max_tunnels: toNumOrNull(f.max_tunnels),
    traffic: toNumOrNull(f.traffic),
    ip_limit: toNumOrNull(f.ip_limit),
    client_limit: toNumOrNull(f.client_limit),
    bandwidth_limit: toNumOrNull(f.bandwidth_limit),
    whitelist_limit: toNumOrNull(f.whitelist_limit),
    setup_fee: toNumOrNull(f.setup_fee),
    stock: toNumOrNull(f.stock),
    order_by: toNumOrNull(f.order_by) ?? 1000,
    billing_cycle: f.billing_cycle,
    status: f.status,
    renewable: f.renewable,
    allow_custom_in_node_group: f.allow_custom_in_node_group,
    allow_custom_out_node_group: f.allow_custom_out_node_group,
    all_in_node_groups: f.all_in_node_groups,
    all_out_node_groups: f.all_out_node_groups,
  };
}

export function AdminPlansManager({ initialData }: { initialData: Paginated<Plan> }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [editing, setEditing] = useState<Plan | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Plan | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { form, set, setForm } = useForm<PlanForm>(EMPTY);

  const cycles = useMemo(
    () => BILLING_CYCLES.map((c) => ({ value: c.value, zh: c.zh, en: c.en })),
    [],
  );

  async function load(kw = keyword) {
    setLoading(true);
    try {
      setData(await api.admin.plans({ page: 1, page_size: 20, keyword: kw || undefined }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("common.noData"));
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }

  function openEdit(p: Plan) {
    setEditing(p);
    setForm(toForm(p));
    setOpen(true);
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
        await api.admin.updatePlan(editing.id, payload);
        toast.success(t("admin.updateSuccess", { name: payload.name }));
      } else {
        await api.admin.createPlan(payload);
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
      await api.admin.removePlan(deleteTarget.id);
      toast.success(t("admin.deleteSuccess", { name: deleteTarget.name }));
      setDeleteTarget(null);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="admin-plans">
      <AdminToolbar
        keyword={keyword}
        onKeywordChange={setKeyword}
        onSearch={() => load()}
        onRefresh={() => load()}
        loading={loading}
        total={data.total}
        onCreate={openCreate}
        createLabel={t("common.create")}
        createTestId="create-plan-btn"
      />

      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>{t("fields.plan")}</TableHead>
              <TableHead>{t("plan.price")}</TableHead>
              <TableHead>{t("plan.cycle")}</TableHead>
              <TableHead>{t("plan.traffic")}</TableHead>
              <TableHead>{t("plan.maxTunnels")}</TableHead>
              <TableHead>{t("common.status")}</TableHead>
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
              data.data.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs">{p.id}</TableCell>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>{formatMoney(p.price)}</TableCell>
                  <TableCell className="text-xs">
                    {BILLING_CYCLES.find((c) => c.value === p.billing_cycle)?.[locale === "zh" ? "zh" : "en"] ??
                      p.billing_cycle}
                  </TableCell>
                  <TableCell className="text-xs">{p.traffic ? `${p.traffic} GB` : t("plan.unlimited")}</TableCell>
                  <TableCell className="text-xs">{p.max_tunnels ?? t("plan.unlimited")}</TableCell>
                  <TableCell>
                    <Badge variant={p.status === "active" ? "success" : "muted"}>{p.status}</Badge>
                  </TableCell>
                  <TableCell>
                    <RowActions onEdit={() => openEdit(p)} onDelete={() => setDeleteTarget(p)} />
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
        title={editing ? t("admin.editTitle", { name: t("fields.plan") }) : t("admin.createTitle", { name: t("fields.plan") })}
        onSubmit={submit}
        submitLabel={t("common.save")}
        pending={pending}
        wide
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("fields.plan")}>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} required data-testid="plan-name" />
          </Field>
          <Field label={t("plan.price")}>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={form.price}
              onChange={(e) => set("price", e.target.value)}
              required
              data-testid="plan-price"
            />
          </Field>
          <Field label={t("plan.cycle")}>
            <OptionSelect
              value={form.billing_cycle}
              onValueChange={(v) => set("billing_cycle", v as Plan["billing_cycle"])}
              options={cycles}
              locale={locale}
            />
          </Field>
          <Field label={t("common.status")}>
            <OptionSelect
              value={form.status}
              onValueChange={(v) => set("status", v as Plan["status"])}
              options={STATUS_OPTIONS}
              locale={locale}
            />
          </Field>
          <Field label={t("plan.traffic")} hint="GB">
            <Input type="number" min={0} value={form.traffic} onChange={(e) => set("traffic", e.target.value)} />
          </Field>
          <Field label={t("plan.maxTunnels")}>
            <Input type="number" min={0} value={form.max_tunnels} onChange={(e) => set("max_tunnels", e.target.value)} />
          </Field>
          <Field label={t("plan.bandwidth")} hint="Mbps">
            <Input
              type="number"
              min={0}
              value={form.bandwidth_limit}
              onChange={(e) => set("bandwidth_limit", e.target.value)}
            />
          </Field>
          <Field label={t("plan.clientLimit")}>
            <Input
              type="number"
              min={0}
              value={form.client_limit}
              onChange={(e) => set("client_limit", e.target.value)}
            />
          </Field>
          <Field label={t("plan.originalPrice")} hint={t("common.optional")}>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={form.original_price}
              onChange={(e) => set("original_price", e.target.value)}
            />
          </Field>
          <Field label={t("plan.ipLimit")}>
            <Input type="number" min={0} value={form.ip_limit} onChange={(e) => set("ip_limit", e.target.value)} />
          </Field>
          <Field label={t("plan.whitelistLimit")}>
            <Input
              type="number"
              min={0}
              value={form.whitelist_limit}
              onChange={(e) => set("whitelist_limit", e.target.value)}
            />
          </Field>
          <Field label={t("plan.setupFee")} hint={t("common.optional")}>
            <Input
              type="number"
              step="0.01"
              min={0}
              value={form.setup_fee}
              onChange={(e) => set("setup_fee", e.target.value)}
            />
          </Field>
          <Field label={t("plan.stock")} hint={t("common.optional")}>
            <Input type="number" min={0} value={form.stock} onChange={(e) => set("stock", e.target.value)} />
          </Field>
          <Field label={t("fields.orderBy")}>
            <Input type="number" value={form.order_by} onChange={(e) => set("order_by", e.target.value)} />
          </Field>
        </div>
        <Field label={t("common.remark")}>
          <Textarea
            rows={2}
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder={t("common.optional")}
          />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <ToggleRow label={t("plan.renewable")} checked={form.renewable} onCheckedChange={(v) => set("renewable", v)} />
          <ToggleRow
            label={t("plan.allowCustomInNodeGroup")}
            checked={form.allow_custom_in_node_group}
            onCheckedChange={(v) => set("allow_custom_in_node_group", v)}
          />
          <ToggleRow
            label={t("plan.allowCustomOutNodeGroup")}
            checked={form.allow_custom_out_node_group}
            onCheckedChange={(v) => set("allow_custom_out_node_group", v)}
          />
          <ToggleRow
            label={t("plan.allInNodeGroups")}
            checked={form.all_in_node_groups}
            onCheckedChange={(v) => set("all_in_node_groups", v)}
          />
          <ToggleRow
            label={t("plan.allOutNodeGroups")}
            checked={form.all_out_node_groups}
            onCheckedChange={(v) => set("all_out_node_groups", v)}
          />
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
