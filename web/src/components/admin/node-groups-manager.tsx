"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, ToggleRow } from "@/components/ui/form";
import { OptionSelect } from "@/components/ui/option-select";
import { AdminToolbar, ConfirmDeleteDialog, FormDialog, RowActions, useForm } from "@/components/admin/admin-ui";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { BYPASS_TYPE_OPTIONS, LOAD_BALANCE_TYPES, NODE_TYPE_OPTIONS, TUNNEL_TYPES } from "@/lib/constants";
import { parseStringList, strOf, toNumOrNull } from "@/lib/utils";
import type { NodeGroup, NodeGroupInput, Paginated } from "@/lib/types";

interface GroupForm {
  name: string;
  token: string;
  port_range: string;
  connect_ip: string;
  node_type: NodeGroup["node_type"];
  load_balance_type: NodeGroup["load_balance_type"];
  traffic_rate: string;
  bypass_type: NodeGroup["bypass_type"];
  bypass_list: string;
  allow_listen_protocol: boolean;
  allow_listen_protocols: string;
  allow_tunnel_types: string;
  admission: boolean;
  need_out_node_group: boolean;
  order_by: string;
}

const EMPTY: GroupForm = {
  name: "",
  token: "",
  port_range: "",
  connect_ip: "",
  node_type: "in",
  load_balance_type: "round",
  traffic_rate: "1",
  bypass_type: "blacklist",
  bypass_list: "",
  allow_listen_protocol: false,
  allow_listen_protocols: "",
  allow_tunnel_types: "",
  admission: false,
  need_out_node_group: true,
  order_by: "1000",
};

function toForm(g: NodeGroup): GroupForm {
  return {
    name: g.name,
    token: g.token,
    port_range: g.port_range ?? "",
    connect_ip: g.connect_ip ?? "",
    node_type: g.node_type,
    load_balance_type: g.load_balance_type,
    traffic_rate: strOf(g.traffic_rate),
    bypass_type: g.bypass_type,
    bypass_list: (g.bypass_list ?? []).join(", "),
    allow_listen_protocol: g.allow_listen_protocol,
    allow_listen_protocols: (g.allow_listen_protocols ?? []).join(", "),
    allow_tunnel_types: (g.allow_tunnel_types ?? []).join(", "),
    admission: g.admission,
    need_out_node_group: g.need_out_node_group,
    order_by: strOf(g.order_by),
  };
}

function toPayload(f: GroupForm): NodeGroupInput {
  return {
    name: f.name.trim(),
    token: f.token.trim(),
    port_range: f.port_range.trim() || null,
    connect_ip: f.connect_ip.trim() || null,
    node_type: f.node_type,
    load_balance_type: f.load_balance_type,
    traffic_rate: toNumOrNull(f.traffic_rate) ?? 1,
    bypass_type: f.bypass_type,
    bypass_list: parseStringList(f.bypass_list),
    allow_listen_protocol: f.allow_listen_protocol,
    allow_listen_protocols: parseStringList(f.allow_listen_protocols),
    allow_tunnel_types: parseStringList(f.allow_tunnel_types) as NodeGroupInput["allow_tunnel_types"],
    admission: f.admission,
    need_out_node_group: f.need_out_node_group,
    order_by: toNumOrNull(f.order_by) ?? 1000,
  };
}

export function AdminNodeGroupsManager({ initialData }: { initialData: Paginated<NodeGroup> }) {
  const { t, locale } = useI18n();
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [editing, setEditing] = useState<NodeGroup | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<NodeGroup | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { form, set, setForm } = useForm<GroupForm>(EMPTY);

  const lbOptions = LOAD_BALANCE_TYPES.map((v) => ({ value: v, zh: v, en: v }));

  async function load(kw = keyword) {
    setLoading(true);
    try {
      setData(await api.admin.nodeGroups({ page: 1, page_size: 20, keyword: kw || undefined }));
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

  function openEdit(g: NodeGroup) {
    setEditing(g);
    setForm(toForm(g));
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
        await api.admin.updateNodeGroup(editing.id, payload);
        toast.success(t("admin.updateSuccess", { name: payload.name }));
      } else {
        await api.admin.createNodeGroup(payload);
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
      await api.admin.removeNodeGroup(deleteTarget.id);
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
    <div className="flex flex-col gap-4" data-testid="admin-node-groups">
      <AdminToolbar
        keyword={keyword}
        onKeywordChange={setKeyword}
        onSearch={() => load()}
        onRefresh={() => load()}
        loading={loading}
        total={data.total}
        onCreate={openCreate}
        createTestId="create-node-group-btn"
      />

      <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>{t("common.name")}</TableHead>
              <TableHead>{t("fields.token")}</TableHead>
              <TableHead>{t("fields.nodeType")}</TableHead>
              <TableHead>{t("fields.loadBalanceType")}</TableHead>
              <TableHead>{t("fields.trafficRate")}</TableHead>
              <TableHead>{t("fields.portRange")}</TableHead>
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
              data.data.map((g) => (
                <TableRow key={g.id}>
                  <TableCell className="font-mono text-xs">{g.id}</TableCell>
                  <TableCell className="font-medium">{g.name}</TableCell>
                  <TableCell className="font-mono text-xs text-[var(--muted-foreground)]">{g.token}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {g.node_type === "in" ? t("fields.in") : t("fields.out")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{g.load_balance_type}</TableCell>
                  <TableCell className="text-xs">{g.traffic_rate}</TableCell>
                  <TableCell className="font-mono text-xs">{g.port_range ?? "-"}</TableCell>
                  <TableCell>
                    <RowActions onEdit={() => openEdit(g)} onDelete={() => setDeleteTarget(g)} />
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
            ? t("admin.editTitle", { name: t("admin.nodeGroups") })
            : t("admin.createTitle", { name: t("admin.nodeGroups") })
        }
        onSubmit={submit}
        submitLabel={t("common.save")}
        pending={pending}
        wide
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("common.name")}>
            <Input value={form.name} onChange={(e) => set("name", e.target.value)} required data-testid="ng-name" />
          </Field>
          <Field label={t("fields.token")} hint={t("common.optional")}>
            <Input
              value={form.token}
              onChange={(e) => set("token", e.target.value)}
              placeholder="ng_in_hk_01"
            />
          </Field>
          <Field label={t("fields.nodeType")}>
            <OptionSelect
              value={form.node_type}
              onValueChange={(v) => set("node_type", v as NodeGroup["node_type"])}
              options={NODE_TYPE_OPTIONS}
              locale={locale}
            />
          </Field>
          <Field label={t("fields.loadBalanceType")}>
            <OptionSelect
              value={form.load_balance_type}
              onValueChange={(v) => set("load_balance_type", v as NodeGroup["load_balance_type"])}
              options={lbOptions}
              locale={locale}
            />
          </Field>
          <Field label={t("fields.connectIp")} hint={t("common.optional")}>
            <Input value={form.connect_ip} onChange={(e) => set("connect_ip", e.target.value)} placeholder="hk1.tunex.example" />
          </Field>
          <Field label={t("fields.portRange")} hint="20000-30000">
            <Input value={form.port_range} onChange={(e) => set("port_range", e.target.value)} placeholder="20000-30000" />
          </Field>
          <Field label={t("fields.trafficRate")}>
            <Input
              type="number"
              step="0.1"
              min={0}
              value={form.traffic_rate}
              onChange={(e) => set("traffic_rate", e.target.value)}
            />
          </Field>
          <Field label={t("fields.orderBy")}>
            <Input type="number" value={form.order_by} onChange={(e) => set("order_by", e.target.value)} />
          </Field>
        </div>

        <Field label={t("common.type")} hint={TUNNEL_TYPES.join(" / ")}>
          <Input
            value={form.allow_tunnel_types}
            onChange={(e) => set("allow_tunnel_types", e.target.value)}
            placeholder="tcp, udp, tls"
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Bypass" hint={BYPASS_TYPE_OPTIONS.map((o) => o.value).join(" / ")}>
            <OptionSelect
              value={form.bypass_type}
              onValueChange={(v) => set("bypass_type", v as NodeGroup["bypass_type"])}
              options={BYPASS_TYPE_OPTIONS}
              locale={locale}
            />
          </Field>
          <Field label="Bypass list" hint="80, 443, 8080">
            <Input value={form.bypass_list} onChange={(e) => set("bypass_list", e.target.value)} />
          </Field>
        </div>

        <Field label="Allow listen protocols" hint="tcp, udp">
          <Input
            value={form.allow_listen_protocols}
            onChange={(e) => set("allow_listen_protocols", e.target.value)}
            placeholder="tcp, udp"
          />
        </Field>

        <div className="grid gap-2 sm:grid-cols-2">
          <ToggleRow
            label="Allow listen protocol"
            checked={form.allow_listen_protocol}
            onCheckedChange={(v) => set("allow_listen_protocol", v)}
          />
          <ToggleRow label="Admission" checked={form.admission} onCheckedChange={(v) => set("admission", v)} />
          <ToggleRow
            label={t("tunnel.outNodeGroup")}
            checked={form.need_out_node_group}
            onCheckedChange={(v) => set("need_out_node_group", v)}
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
