"use client";

/**
 * WP13 —— 创建隧道对话框（DIRECT / RELAY）。
 *
 * DIRECT：单跳，目标为 remote_host:remote_port（写入 forward_addresses[0]，与存量契约兼容）。
 * RELAY：双跳，需要出口节点组 + 出口目标池（`/egress-pools`，WP11 契约；后端合入前走 mock）。
 *
 * 字段语义与 backend schema §2.1 对齐：tunnel_mode 缺省由后端按 forward_addresses
 * 推导（存量路径不变），因此本组件始终显式下发用户所选模式。
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { TUNNEL_TYPES } from "@/lib/constants";
import type { NodeGroup, TunnelCreateInput, TunnelEgressPoolOption, TunnelMode, TunnelType } from "@/lib/types";

export function TunnelCreateDialog({
  open,
  onOpenChange,
  nodeGroups,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  nodeGroups: NodeGroup[];
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<TunnelType>("tcp");
  const [category, setCategory] = useState<"port_forward" | "remote_port_forward">("port_forward");
  const [inGroup, setInGroup] = useState("");
  // ── WP13：DIRECT / RELAY ──
  const [mode, setMode] = useState<TunnelMode>("direct");
  const [outGroup, setOutGroup] = useState("");
  const [poolId, setPoolId] = useState("");
  const [pools, setPools] = useState<TunnelEgressPoolOption[]>([]);
  const [poolsLoading, setPoolsLoading] = useState(false);
  const [forward, setForward] = useState("");
  const [port, setPort] = useState("");

  // 入口组默认值（首个可用组）
  useEffect(() => {
    if (open && !inGroup && nodeGroups.length > 0) setInGroup(String(nodeGroups[0].id));
  }, [open, nodeGroups, inGroup]);

  // RELAY 模式下拉取可用出口池（WP11 `/egress-pools`；mock 同契约）
  useEffect(() => {
    if (!open || mode !== "relay") return;
    let alive = true;
    setPoolsLoading(true);
    api.egressPools
      .available({ page: 1, page_size: 100 })
      .then((res) => {
        if (alive) setPools(res);
      })
      .catch((err) => {
        if (alive) toast.error(err instanceof Error ? err.message : t("tunnel.createFailed"));
      })
      .finally(() => {
        if (alive) setPoolsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, mode, t]);

  const outGroups = useMemo(
    () => nodeGroups.filter((g) => g.node_type !== "in"),
    [nodeGroups],
  );

  // 出口组变化时清空已选池（池属于具体出口节点，组切换后旧选择可能失效）
  useEffect(() => {
    setPoolId("");
  }, [outGroup]);

  const poolsForGroup = useMemo(
    () => (outGroup ? pools.filter((p) => p.status === "active") : []),
    [pools, outGroup],
  );
  // 出口池可空（RELAY 允许不选 = 出口节点 default 池，§2.2），故不做禁用提交

  async function submit() {
    if (!name || !inGroup) {
      toast.error(t("tunnel.createFailed"));
      return;
    }
    if (mode === "relay") {
      if (!outGroup) {
        toast.error(t("tunnel.v3RelayNeedOutGroup"));
        return;
      }
      // 出口池非必选（可回落节点 default 池），但必须至少存在可用池才允许创建 RELAY
      if (poolsForGroup.length === 0) {
        toast.error(t("tunnel.v3PoolEmpty"));
        return;
      }
    } else if (!forward.trim()) {
      toast.error(t("tunnel.createFailed"));
      return;
    }

    setPending(true);
    try {
      const base: TunnelCreateInput = {
        name,
        tunnel_type: type,
        category,
        in_node_group_id: Number(inGroup),
        listen_port: port ? Number(port) : null,
        forward_addresses: [],
      };
      if (mode === "direct") {
        base.tunnel_mode = "direct";
        base.forward_addresses = forward.split("\n").map((s) => s.trim()).filter(Boolean);
      } else {
        base.tunnel_mode = "relay";
        base.out_node_group_id = Number(outGroup);
        // 出口池可选：未选 = 出口节点 default 池
        if (poolId) base.egress_pool_id = Number(poolId);
        base.forward_addresses = [];
      }
      await api.tunnels.create(base);
      toast.success(t("tunnel.createSuccess"));
      setName("");
      setForward("");
      setPort("");
      setOutGroup("");
      setPoolId("");
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("tunnel.createFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="tunnel-create-dialog">
        <DialogHeader>
          <DialogTitle>{t("tunnel.createTitle")}</DialogTitle>
          <DialogDescription>{t("tunnel.v3CreateModeHint")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label={t("tunnel.name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-tunnel" />
          </Field>
          <Field label={t("tunnel.tunnelType")}>
            <Select value={type} onValueChange={(v) => setType(v as TunnelType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TUNNEL_TYPES.map((tt) => (
                  <SelectItem key={tt} value={tt}>
                    {tt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("tunnel.category")}>
            <Select value={category} onValueChange={(v) => setCategory(v as "port_forward" | "remote_port_forward")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="port_forward">{t("tunnel.portForward")}</SelectItem>
                <SelectItem value="remote_port_forward">{t("tunnel.remotePortForward")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {/* ── WP13：模式选择 ── */}
          <Field label={t("tunnel.v3Mode")}>
            <Select value={mode} onValueChange={(v) => setMode(v as TunnelMode)}>
              <SelectTrigger data-testid="tunnel-mode-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="direct" data-testid="tunnel-mode-direct">
                  {t("tunnel.v3ModeDirect")}
                </SelectItem>
                <SelectItem value="relay" data-testid="tunnel-mode-relay">
                  {t("tunnel.v3ModeRelay")}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="field-hint">
              {mode === "direct" ? t("tunnel.v3ModeDirectHint") : t("tunnel.v3ModeRelayHint")}
            </p>
          </Field>

          <Field label={t("tunnel.inNodeGroup")}>
            <Select value={inGroup} onValueChange={setInGroup}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {nodeGroups.map((g) => (
                  <SelectItem key={g.id} value={String(g.id)}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {mode === "relay" && (
            <>
              <Field label={t("tunnel.outNodeGroup")}>
                <Select value={outGroup} onValueChange={setOutGroup}>
                  <SelectTrigger data-testid="tunnel-out-group-select">
                    <SelectValue placeholder={t("common.none")} />
                  </SelectTrigger>
                  <SelectContent>
                    {outGroups.map((g) => (
                      <SelectItem key={g.id} value={String(g.id)}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label={t("tunnel.v3Pool")} hint={t("tunnel.v3PoolNone")}>
                {poolsLoading ? (
                  <Input disabled value={t("common.loading")} />
                ) : poolsForGroup.length === 0 ? (
                  <div className="flex items-start gap-1.5 rounded-md border border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    {t("tunnel.v3PoolEmpty")}
                  </div>
                ) : (
                  <Select value={poolId} onValueChange={setPoolId}>
                    <SelectTrigger data-testid="tunnel-pool-select">
                      <SelectValue placeholder={t("tunnel.v3PoolNone")} />
                    </SelectTrigger>
                    <SelectContent>
                      {poolsForGroup.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name} · {p.node_label}
                          {p.lb_strategy ? ` · ${p.lb_strategy}` : ""}（{p.targets.length}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </>
          )}

          {mode === "direct" && (
            <Field label={t("tunnel.forwardAddresses")} hint={t("tunnel.forwardAddressesHint")}>
              <Textarea value={forward} onChange={(e) => setForward(e.target.value)} rows={3} />
            </Field>
          )}

          <Field label={t("tunnel.listenPort")} hint={t("tunnel.listenPortHint")}>
            <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="20001" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={pending} data-testid="tunnel-create-submit">
            {t("tunnel.createButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}
