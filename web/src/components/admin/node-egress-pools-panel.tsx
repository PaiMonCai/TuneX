"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Loader2, Network, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/form";
import { OptionSelect } from "@/components/ui/option-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableEmpty, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, API_MOCK } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { LB_STRATEGIES, STATUS_OPTIONS } from "@/lib/constants";
import { formatDateTime, strOf, toNumOrNull } from "@/lib/utils";
import type { EgressPool, EgressPoolInput, EgressTarget, EgressTargetInput, ID, LBStrategy, NodeRole } from "@/lib/types";

/** 只有出口 / 兼任节点才有出口池 */
function poolsApply(role: NodeRole | null | undefined): boolean {
  return role === "egress" || role === "both";
}

function sumWeight(targets: EgressTarget[] | undefined): number {
  return (targets ?? []).filter((t) => t.status === "active").reduce((n, t) => n + Number(t.weight ?? 0), 0);
}

export interface NodeEgressPoolsPanelProps {
  nodeId: ID;
  nodeRole: NodeRole | null | undefined;
  pools: EgressPool[];
  onChanged: () => void;
}

/**
 * 出口池 / 出口目标管理（WP12 / WP10）。
 *
 * **数据源标注**：WP10 Admin API 尚未合入 main，`api.admin.pools*` 目前落在
 * 前端 mock handler 上（NEXT_PUBLIC_API_MOCK=1 才生效；非 mock 模式下由真实
 * 后端返回，契约已冻结）。页面据此渲染 MOCK 角标——**不发明字段、不造临时 API**，
 * 字段命名与 schema 的 EgressPool/EgressTarget 一一对应（§7.14 铁律）。
 *
 * 兑现两条 schema 注释里的服务端不变式：
 *   1. 池内至少一个 active 且 weight>0 的目标 → 删除/停用最后一个时提前拦；
 *   2. 目标改权重/增删 = 热更新快照，**不重建 ingress listener**（UI 层不做任何
 *      「重启/重连」按钮，也不在成功后做整页 reload，只刷列表）。
 */
export function NodeEgressPoolsPanel({ nodeId, nodeRole, pools, onChanged }: NodeEgressPoolsPanelProps) {
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [poolDialog, setPoolDialog] = useState<{ mode: "create" | "edit"; pool: EgressPool | null } | null>(null);
  const [targetDialog, setTargetDialog] = useState<{ mode: "create" | "edit"; poolId: ID; target: EgressTarget | null } | null>(
    null,
  );
  const [poolForm, setPoolForm] = useState<EgressPoolInput>({ name: "", lb_strategy: null, status: "active" });
  const [targetForm, setTargetForm] = useState<EgressTargetInput>({ host: "", port: 80, weight: 1, order_by: 1000, remark: null, status: "active" });

  const refresh = useCallback(() => onChanged(), [onChanged]);

  function openPoolCreate() {
    setPoolForm({ name: "", lb_strategy: null, status: "active" });
    setPoolDialog({ mode: "create", pool: null });
  }

  function openPoolEdit(pool: EgressPool) {
    setPoolForm({ name: pool.name, lb_strategy: pool.lb_strategy ?? null, status: pool.status });
    setPoolDialog({ mode: "edit", pool });
  }

  function openTargetCreate(poolId: ID) {
    setTargetForm({ host: "", port: 80, weight: 1, order_by: 1000, remark: null, status: "active" });
    setTargetDialog({ mode: "create", poolId, target: null });
  }

  function openTargetEdit(poolId: ID, target: EgressTarget) {
    setTargetForm({
      host: target.host,
      port: target.port,
      weight: target.weight,
      order_by: target.order_by,
      remark: target.remark ?? null,
      status: target.status,
    });
    setTargetDialog({ mode: "edit", poolId, target });
  }

  async function submitPool() {
    if (!poolForm.name.trim()) {
      toast.error(t("admin.saveFailed"));
      return;
    }
    setBusy(true);
    try {
      if (poolDialog?.mode === "edit" && poolDialog.pool) {
        await api.admin.updatePool(nodeId, poolDialog.pool.id, poolForm);
        toast.success(t("admin.updateSuccess", { name: poolForm.name }));
      } else {
        await api.admin.createPool(nodeId, poolForm);
        toast.success(t("admin.createSuccess", { name: poolForm.name }));
      }
      setPoolDialog(null);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function removePool(pool: EgressPool) {
    setBusy(true);
    try {
      await api.admin.removePool(nodeId, pool.id);
      toast.success(t("admin.deleteSuccess", { name: pool.name }));
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function submitTarget() {
    const host = targetForm.host.trim();
    if (!host || !Number.isInteger(targetForm.port) || targetForm.port <= 0 || targetForm.port > 65535) {
      toast.error(t("admin.saveFailed"));
      return;
    }
    setBusy(true);
    try {
      if (targetDialog?.mode === "edit" && targetDialog.target) {
        await api.admin.updateTarget(nodeId, targetDialog.poolId, targetDialog.target.id, targetForm);
        toast.success(t("admin.updateSuccess", { name: `${host}:${targetForm.port}` }));
      } else if (targetDialog) {
        await api.admin.createTarget(nodeId, targetDialog.poolId, targetForm);
        toast.success(t("admin.createSuccess", { name: `${host}:${targetForm.port}` }));
      }
      setTargetDialog(null);
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function removeTarget(poolId: ID, target: EgressTarget, pool: EgressPool) {
    // 客户端预检 schema 注释里的不变式：池内至少一个 active 且 weight>0 的目标。
    // 后端同样会拒，但提前拦能少一次无效请求 + 给得出解释的提示。
    const usable = (pool.targets ?? []).filter((x) => x.status === "active" && Number(x.weight ?? 0) > 0);
    if (target.status === "active" && usable.length <= 1 && usable[0]?.id === target.id) {
      toast.error(t("admin.targetLastOne"));
      return;
    }
    setBusy(true);
    try {
      await api.admin.removeTarget(nodeId, poolId, target.id);
      toast.success(t("admin.deleteSuccess", { name: `${target.host}:${target.port}` }));
      refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("admin.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!poolsApply(nodeRole)) {
    return (
      <Card data-testid="node-pools">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network className="size-4" />
            {t("admin.pools")}
          </CardTitle>
          <CardDescription>{t("admin.poolsHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-[var(--muted-foreground)]">{t("admin.poolsEmpty")}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="node-pools">
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Network className="size-4" />
            {t("admin.pools")}
            {API_MOCK && (
              <Badge variant="outline" title={t("admin.mockBadgeHint")} data-testid="pools-mock-badge">
                {t("admin.mockBadge")}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>{t("admin.poolsHint")}</CardDescription>
        </div>
        <Button size="sm" onClick={openPoolCreate} disabled={busy} data-testid="pool-create-btn">
          <Plus className="size-4" />
          {t("admin.poolCreate")}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {pools.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)]">{t("admin.poolsEmpty")}</p>
        ) : (
          pools.map((pool) => (
            <div key={pool.id} className="rounded-[var(--radius)] border border-[var(--border)]" data-testid="pool-row">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{pool.name}</span>
                  <Badge variant="muted">{pool.lb_strategy ?? "inherit"}</Badge>
                  <Badge variant={pool.status === "active" ? "success" : "muted"}>{pool.status}</Badge>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    {t("admin.poolTargets")}: {(pool.targets ?? []).length}
                    {(pool.targets ?? []).length > 0 && ` (Σw ${sumWeight(pool.targets)})`}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => openTargetCreate(pool.id)} disabled={busy} data-testid="target-add-btn">
                    <Plus className="size-4" />
                    {t("admin.targetAdd")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openPoolEdit(pool)} disabled={busy} aria-label={t("admin.poolEdit")}>
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-[var(--destructive)]"
                    onClick={() => removePool(pool)}
                    disabled={busy}
                    aria-label={t("admin.poolDelete")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("admin.targetHost")}</TableHead>
                      <TableHead>{t("admin.targetPort")}</TableHead>
                      <TableHead>{t("admin.targetWeight")}</TableHead>
                      <TableHead>{t("fields.orderBy")}</TableHead>
                      <TableHead>{t("common.remark")}</TableHead>
                      <TableHead>{t("common.status")}</TableHead>
                      <TableHead className="text-right">{t("common.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(pool.targets ?? []).length === 0 ? (
                      <TableEmpty colSpan={7} text={t("admin.targetsEmpty")} />
                    ) : (
                      (pool.targets ?? []).map((target) => (
                        <TableRow key={target.id}>
                          <TableCell className="font-mono text-xs">{target.host}</TableCell>
                          <TableCell className="font-mono text-xs">{target.port}</TableCell>
                          <TableCell className="text-xs">{target.weight}</TableCell>
                          <TableCell className="text-xs">{target.order_by}</TableCell>
                          <TableCell className="text-xs text-[var(--muted-foreground)]">{target.remark ?? "-"}</TableCell>
                          <TableCell>
                            <Badge variant={target.status === "active" ? "success" : "muted"}>{target.status}</Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => openTargetEdit(pool.id, target)}
                                disabled={busy}
                                aria-label={t("admin.targetEdit")}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-[var(--destructive)]"
                                onClick={() => removeTarget(pool.id, target, pool)}
                                disabled={busy}
                                aria-label={t("admin.targetDelete")}
                              >
                                <X className="size-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))
        )}
      </CardContent>

      {/* 池表单 */}
      <Dialog open={poolDialog !== null} onOpenChange={(v) => !v && setPoolDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{poolDialog?.mode === "edit" ? t("admin.poolEdit") : t("admin.poolCreate")}</DialogTitle>
            <DialogDescription>{t("admin.poolsHint")}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitPool();
            }}
          >
            <Field label={t("admin.poolName")}>
              <Input
                value={poolForm.name}
                onChange={(e) => setPoolForm((f) => ({ ...f, name: e.target.value }))}
                required
                data-testid="pool-name"
              />
            </Field>
            <Field label={t("admin.lbStrategy")} hint={t("admin.lbStrategyHint")}>
              <Select
                value={poolForm.lb_strategy ?? "inherit"}
                onValueChange={(v) => setPoolForm((f) => ({ ...f, lb_strategy: v === "inherit" ? null : (v as LBStrategy) }))}
              >
                <SelectTrigger data-testid="pool-strategy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">{t("admin.selectPlaceholder")}</SelectItem>
                  {LB_STRATEGIES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.zh}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("common.status")}>
              <OptionSelect
                value={poolForm.status ?? "active"}
                onValueChange={(v) => setPoolForm((f) => ({ ...f, status: v as EgressPool["status"] }))}
                options={STATUS_OPTIONS}
                locale={locale}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPoolDialog(null)} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy} data-testid="pool-submit">
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 目标表单 */}
      <Dialog open={targetDialog !== null} onOpenChange={(v) => !v && setTargetDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{targetDialog?.mode === "edit" ? t("admin.targetEdit") : t("admin.targetAdd")}</DialogTitle>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              submitTarget();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("admin.targetHost")}>
                <Input
                  value={targetForm.host}
                  onChange={(e) => setTargetForm((f) => ({ ...f, host: e.target.value }))}
                  required
                  placeholder="10.0.0.2"
                  data-testid="target-host"
                />
              </Field>
              <Field label={t("admin.targetPort")}>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={strOf(targetForm.port)}
                  onChange={(e) => setTargetForm((f) => ({ ...f, port: toNumOrNull(e.target.value) ?? 0 }))}
                  required
                  data-testid="target-port"
                />
              </Field>
              <Field label={t("admin.targetWeight")}>
                <Input
                  type="number"
                  min={0}
                  value={strOf(targetForm.weight)}
                  onChange={(e) => setTargetForm((f) => ({ ...f, weight: toNumOrNull(e.target.value) ?? 0 }))}
                  data-testid="target-weight"
                />
              </Field>
              <Field label={t("fields.orderBy")}>
                <Input
                  type="number"
                  value={strOf(targetForm.order_by)}
                  onChange={(e) => setTargetForm((f) => ({ ...f, order_by: toNumOrNull(e.target.value) ?? 1000 }))}
                />
              </Field>
            </div>
            <Field label={t("common.remark")} hint={t("common.optional")}>
              <Input
                value={targetForm.remark ?? ""}
                onChange={(e) => setTargetForm((f) => ({ ...f, remark: e.target.value.trim() || null }))}
              />
            </Field>
            <Field label={t("common.status")}>
              <OptionSelect
                value={targetForm.status ?? "active"}
                onValueChange={(v) => setTargetForm((f) => ({ ...f, status: v as EgressTarget["status"] }))}
                options={STATUS_OPTIONS}
                locale={locale}
              />
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setTargetDialog(null)} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy} data-testid="target-submit">
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
