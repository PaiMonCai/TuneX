"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Pencil, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, InfoRow } from "@/components/ui/form";
import { OptionSelect } from "@/components/ui/option-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NodeCredentialPanel } from "@/components/admin/node-credential-panel";
import { NodeEgressPoolsPanel } from "@/components/admin/node-egress-pools-panel";
import { NodeRuntimePanel } from "@/components/admin/node-runtime-panel";
import { api, API_MOCK } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { LB_STRATEGIES, NODE_ROLES, STATUS_OPTIONS } from "@/lib/constants";
import { formatBytes, formatDateTime, strOf, toNumOrNull } from "@/lib/utils";
import type { ID, LBStrategy, Node, NodeDetail, NodeRole, Status } from "@/lib/types";

function roleBadgeVariant(role: NodeRole | null | undefined): "success" | "default" | "muted" {
  if (role === "ingress") return "success";
  if (role === "egress") return "default";
  return "muted"; // null = 未声明
}

function roleLabel(role: NodeRole | null | undefined, undeclaredText: string): string {
  if (!role) return undeclaredText;
  const meta = NODE_ROLES.find((r) => r.value === role);
  return meta ? meta.zh : role;
}

/** 「角色已声明」才展示出口池区块：ingress 节点没有池（池只挂 egress/both） */
function poolsApply(role: NodeRole | null | undefined): boolean {
  return role === "egress" || role === "both";
}

interface RoleForm {
  role: NodeRole | "";
  port_range_min: string;
  port_range_max: string;
  lb_strategy: LBStrategy | "";
  status: Status;
}

function toRoleForm(n: Node): RoleForm {
  return {
    role: n.role ?? "",
    port_range_min: strOf(n.port_range_min),
    port_range_max: strOf(n.port_range_max),
    lb_strategy: n.lb_strategy ?? "",
    status: n.status,
  };
}

export interface NodeDetailManagerProps {
  nodeId: ID;
  initial: NodeDetail;
}

/**
 * 节点详情管理（WP12）：基础信息 + 角色/端口区间编辑 + 凭据 + 出口池 + 运行态。
 *
 * 角色保存走 PATCH /admin/nodes/:id（后端已实现，只补三个可空列），
 * 凭据走 WP7 已合并的 /admin/node/:id/credential*，出口池/运行态来自 WP10
 * 契约（mock）。**「未声明角色」不允许被静默填默认值**——表单提交时空值原样
 * 发送 null，与 schema 的「存量行不改/不猜」一致。
 */
export function NodeDetailManager({ nodeId, initial }: NodeDetailManagerProps) {
  const { t, locale } = useI18n();
  const [detail, setDetail] = useState<NodeDetail>(initial);
  const [form, setForm] = useState<RoleForm>(() => toRoleForm(initial));
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);

  const reload = useCallback(async () => {
    setReloading(true);
    try {
      const next = await api.admin.nodeDetail(nodeId);
      setDetail(next);
      setForm(toRoleForm(next));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.saveFailed"));
    } finally {
      setReloading(false);
    }
  }, [nodeId, t]);

  // 节点从 detail 派生展示的字段在「保存成功 / 凭据轮换」后会变，统一在这里同步
  useEffect(() => {
    setForm(toRoleForm(detail));
  }, [detail]);

  async function saveRole() {
    setSaving(true);
    try {
      const updated = await api.admin.updateNode(nodeId, {
        // 空串 = 尚未声明：显式发 null，不让后端/前端猜默认角色
        role: form.role === "" ? null : (form.role as NodeRole),
        port_range_min: toNumOrNull(form.port_range_min),
        port_range_max: toNumOrNull(form.port_range_max),
        lb_strategy: form.lb_strategy === "" ? null : (form.lb_strategy as LBStrategy),
        status: form.status,
      });
      setDetail((prev) => ({ ...prev, ...updated, pools: prev.pools, state: prev.state }));
      toast.success(t("admin.updateSuccess", { name: updated.node_id }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const node = detail;
  const role = node.role ?? null;

  return (
    <div className="flex flex-col gap-5" data-testid="admin-node-detail">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/admin/nodes">
          <Button size="sm" variant="outline">
            <ArrowLeft className="size-4" />
            {t("admin.nodes")}
          </Button>
        </Link>
        <Button size="sm" variant="ghost" onClick={reload} disabled={reloading} data-testid="node-reload">
          {reloading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {t("common.refresh")}
        </Button>
      </div>

      {/* 基础信息（只读） */}
      <Card data-testid="node-basic">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{node.node_id}</span>
            <Badge variant={node.online ? "success" : "muted"}>{node.online ? t("common.online") : t("common.offline")}</Badge>
            <Badge variant={roleBadgeVariant(role)} data-testid="node-role-badge">
              {roleLabel(role, t("admin.nodeRoleUndeclared"))}
            </Badge>
            <Badge variant="outline">#{node.id}</Badge>
            {API_MOCK && (
              <Badge variant="outline" title={t("admin.mockBadgeHint")} data-testid="node-mock-badge">
                {t("admin.mockBadge")}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            {t("admin.nodeRoleHint")}
            {role === null ? ` ${t("admin.nodeRoleEmptyHint")}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <InfoRow label={t("fields.connectIp")}>
            <span className="font-mono text-xs">{node.connect_ip}</span>
          </InfoRow>
          <InfoRow label={t("fields.nodeGroup")}>{node.node_group?.name ?? node.node_group_id}</InfoRow>
          <InfoRow label={t("fields.version")}>{node.version}</InfoRow>
          <InfoRow label={t("fields.weight")}>{node.weight}</InfoRow>
          <InfoRow label={t("tunnel.traffic")}>{formatBytes(node.traffic ?? 0)}</InfoRow>
          <InfoRow label={t("admin.lastSeen")}>
            {node.last_seen_at ? formatDateTime(node.last_seen_at) : t("admin.lastSeenNever")}
          </InfoRow>
          <InfoRow label={t("common.createdAt")}>{formatDateTime(node.created_at)}</InfoRow>
          <InfoRow label={t("common.updatedAt")}>{formatDateTime(node.updated_at)}</InfoRow>
        </CardContent>
      </Card>

      {/* 角色 / 端口区间（可写） */}
      <Card data-testid="node-role-form">
        <CardHeader>
          <CardTitle>{t("admin.nodeRole")}</CardTitle>
          <CardDescription>{t("admin.nodeRoleEmptyHint")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label={t("fields.nodeRole")} hint={t("admin.nodeRoleHint")}>
            <Select
              value={form.role === "" ? "__unset__" : form.role}
              onValueChange={(v) => setForm((f) => ({ ...f, role: v === "__unset__" ? "" : (v as NodeRole) }))}
            >
              <SelectTrigger data-testid="node-role-select">
                <SelectValue placeholder={t("admin.nodeRoleUndeclared")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unset__">{t("admin.nodeRoleUndeclared")}</SelectItem>
                {NODE_ROLES.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.zh}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("common.status")}>
            <OptionSelect
              value={form.status}
              onValueChange={(v) => setForm((f) => ({ ...f, status: v as Status }))}
              options={STATUS_OPTIONS}
              locale={locale}
            />
          </Field>
          <Field label={t("fields.portRangeMin")} hint={t("admin.portRangeHint")}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={form.port_range_min}
              onChange={(e) => setForm((f) => ({ ...f, port_range_min: e.target.value }))}
              placeholder="20000"
              data-testid="node-port-min"
            />
          </Field>
          <Field label={t("fields.portRangeMax")}>
            <Input
              type="number"
              min={1}
              max={65535}
              value={form.port_range_max}
              onChange={(e) => setForm((f) => ({ ...f, port_range_max: e.target.value }))}
              placeholder="30000"
              data-testid="node-port-max"
            />
          </Field>
          {poolsApply(role) || form.role === "egress" || form.role === "both" ? (
            <Field label={t("fields.lbStrategy")} hint={t("admin.lbStrategyHint")}>
              <Select
                value={form.lb_strategy === "" ? "__unset__" : form.lb_strategy}
                onValueChange={(v) => setForm((f) => ({ ...f, lb_strategy: v === "__unset__" ? "" : (v as LBStrategy) }))}
              >
                <SelectTrigger data-testid="node-lb-strategy">
                  <SelectValue placeholder={t("admin.selectPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unset__">{t("admin.selectPlaceholder")}</SelectItem>
                  {LB_STRATEGIES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.zh}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <div className="sm:col-span-2">
            <Button size="sm" onClick={saveRole} disabled={saving} data-testid="node-role-save">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Pencil className="size-4" />}
              {t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 凭据（WP7 已合并的真实端点） */}
      <NodeCredentialPanel
        nodeId={nodeId}
        nodeKey={node.node_id}
        node={node}
        onNodeChanged={(next) => setDetail((prev) => ({ ...prev, ...next }))}
      />

      {/* 出口池（egress/both 才有意义） */}
      {poolsApply(role) && (
        <NodeEgressPoolsPanel nodeId={nodeId} nodeRole={role} pools={detail.pools} onChanged={reload} />
      )}

      {/* 运行态诊断 */}
      <NodeRuntimePanel nodeId={nodeId} report={detail.state} />
    </div>
  );
}
