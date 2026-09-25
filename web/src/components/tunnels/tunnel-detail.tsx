"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Copy, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Field, InfoRow, Switch } from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TrafficChart } from "@/components/traffic-chart";
import { ConfirmDeleteDialog } from "@/components/admin/admin-ui";
import TunnelOrchestrationPanel, { TunnelModeBadge } from "@/components/tunnels/tunnel-orchestration-panel";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatBytes, formatDateTime } from "@/lib/utils";
import type { TrafficPoint, Tunnel } from "@/lib/types";

const LIMIT_KEYS: { key: keyof Tunnel; labelKey: string; unit?: string }[] = [
  { key: "bandwidth_limit", labelKey: "tunnel.bandwidthLimit", unit: "Mbps" },
  { key: "client_limit", labelKey: "tunnel.clientLimit" },
  { key: "ip_limit", labelKey: "tunnel.ipLimit" },
];

export function TunnelDetail({
  tunnel: initialTunnel,
  traffic: initialTraffic,
}: {
  tunnel: Tunnel;
  traffic: TrafficPoint[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [tunnel, setTunnel] = useState(initialTunnel);
  const [traffic, setTraffic] = useState(initialTraffic);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editForwardOpen, setEditForwardOpen] = useState(false);
  const [forwardDraft, setForwardDraft] = useState(initialTunnel.forward_addresses.join("\n"));
  const [savingForward, setSavingForward] = useState(false);

  const isActive = tunnel.status === "active";

  async function refreshTraffic() {
    try {
      setTraffic(await api.tunnels.traffic(tunnel.id, 14));
    } catch {
      /* 图表刷新失败不打断交互 */
    }
  }

  async function onToggle(next: boolean) {
    setToggling(true);
    try {
      const updated = await api.tunnels.toggle(tunnel.id);
      setTunnel(updated);
      toast.success(t("tunnel.toggleSuccess"));
      refreshTraffic();
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("tunnel.toggleFailed"));
    } finally {
      setToggling(false);
    }
  }

  async function onSaveForward() {
    const addresses = forwardDraft
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (addresses.length === 0) {
      toast.error(t("tunnel.saveFailed"));
      return;
    }
    setSavingForward(true);
    try {
      const updated = await api.tunnels.update(tunnel.id, { forward_addresses: addresses });
      setTunnel(updated);
      setEditForwardOpen(false);
      toast.success(t("tunnel.saveSuccess"));
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("tunnel.saveFailed"));
    } finally {
      setSavingForward(false);
    }
  }

  async function onDelete() {
    setDeleting(true);
    try {
      await api.tunnels.remove(tunnel.id);
      toast.success(t("tunnel.deleteSuccess"));
      setConfirmDelete(false);
      router.push("/tunnels");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("tunnel.deleteFailed"));
      setDeleting(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${t("common.copied")} ${text}`);
    } catch {
      toast.error(text);
    }
  }

  return (
    <div className="flex flex-col gap-5" data-testid="tunnel-detail">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/tunnels">
            <ArrowLeft className="size-4" />
            {t("tunnel.backToList")}
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
            <span className={`size-2 rounded-full ${tunnel.online ? "bg-[var(--success)]" : "bg-[var(--muted-foreground)]"}`} />
            {tunnel.online ? t("common.online") : t("common.offline")}
          </span>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmDelete(true)}
            data-testid="tunnel-delete-btn"
          >
            <Trash2 className="size-4" />
            {t("common.delete")}
          </Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="truncate" data-testid="tunnel-name">
                {tunnel.name}
              </CardTitle>
              <CardDescription>{t("tunnel.detailSubtitle")}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">{tunnel.tunnel_type}</Badge>
              <TunnelModeBadge mode={tunnel.tunnel_mode} />
              <Badge variant={isActive ? "success" : "muted"}>
                {isActive ? t("common.active") : t("common.inactive")}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center justify-between rounded-md border border-[var(--border)] px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  {isActive ? t("tunnel.disable") : t("tunnel.enable")}
                  {toggling && <Loader2 className="size-3.5 animate-spin" />}
                </div>
                <div className="field-hint">{t("tunnel.runtime")}</div>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={onToggle}
                disabled={toggling}
                id="tunnel-status-switch"
              />
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="section-title">{t("tunnel.trafficTrend")}</span>
                <span className="text-xs text-[var(--muted-foreground)]">
                  {t("tunnel.traffic")}: {formatBytes(tunnel.traffic)}
                </span>
              </div>
              {traffic.length > 0 ? (
                <TrafficChart data={traffic} />
              ) : (
                <div className="h-64 rounded-md bg-[var(--muted)]" />
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("tunnel.basicInfo")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-[var(--border)]">
            <InfoRow label={t("fields.id")}>
              <span className="font-mono text-xs">{tunnel.id}</span>
            </InfoRow>
            <InfoRow label={t("tunnel.category")}>
              {tunnel.category === "port_forward" ? t("tunnel.portForward") : t("tunnel.remotePortForward")}
            </InfoRow>
            <InfoRow label={t("tunnel.inNodeGroup")}>{tunnel.in_node_group?.name ?? tunnel.in_node_group_id}</InfoRow>
            <InfoRow label={t("tunnel.outNodeGroup")}>
              {tunnel.out_node_group?.name ?? t("common.none")}
            </InfoRow>
            <InfoRow label={t("tunnel.v3Mode")}>
              <TunnelModeBadge mode={tunnel.tunnel_mode} />
              {tunnel.tunnel_mode == null && (
                <span className="ml-1.5 text-xs font-normal text-[var(--muted-foreground)]">
                  {t("tunnel.v3ModeLegacy")}
                </span>
              )}
            </InfoRow>
            <InfoRow label={t("tunnel.v3EgressPort")}>
              {tunnel.tunnel_mode === "relay" ? tunnel.egress_port ?? t("common.none") : t("common.none")}
            </InfoRow>
            <InfoRow label={t("tunnel.listenAddress")}>
              <button
                className="inline-flex items-center gap-1 font-mono text-xs hover:text-[var(--primary)]"
                onClick={() => copy(`${tunnel.listen_ip ?? "*"}:${tunnel.listen_port ?? ""}`)}
              >
                {tunnel.listen_ip ?? "*"}:{tunnel.listen_port ?? "-"}
                <Copy className="size-3 opacity-60" />
              </button>
            </InfoRow>
            <InfoRow label={t("tunnel.loadBalance")}>{tunnel.load_balance_type}</InfoRow>
            <InfoRow label={t("fields.ipType")}>{tunnel.ip_type}</InfoRow>
            <InfoRow label={t("tunnel.clients")}>{tunnel.client_count ?? 0}</InfoRow>
            <InfoRow label={t("tunnel.proxyProtocol")}>
              {tunnel.proxy_protocol ? t("common.yes") : t("common.no")}
            </InfoRow>
            <InfoRow label={t("common.createdAt")}>
              <span className="text-xs text-[var(--muted-foreground)]">{formatDateTime(tunnel.created_at)}</span>
            </InfoRow>
            <InfoRow label={t("common.updatedAt")}>
              <span className="text-xs text-[var(--muted-foreground)]">{formatDateTime(tunnel.updated_at)}</span>
            </InfoRow>
          </CardContent>
        </Card>
      </div>

      <TunnelOrchestrationPanel
        tunnel={tunnel}
        onChanged={(next) => {
          setTunnel(next);
          router.refresh();
        }}
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>{t("tunnel.forwardTargets")}</CardTitle>
              <CardDescription>{t("tunnel.forwardAddressesHint")}</CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setForwardDraft(tunnel.forward_addresses.join("\n"));
                setEditForwardOpen(true);
              }}
              data-testid="edit-forward-btn"
            >
              {t("common.edit")}
            </Button>
          </CardHeader>
          <CardContent>
            {tunnel.forward_addresses.length === 0 ? (
              <p className="text-sm text-[var(--muted-foreground)]">{t("common.noData")}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {tunnel.forward_addresses.map((addr, i) => (
                  <li
                    key={`${addr}-${i}`}
                    className="flex items-center justify-between rounded-md border border-[var(--border)] px-3 py-2"
                  >
                    <span className="font-mono text-xs">{addr}</span>
                    <div className="flex items-center gap-1.5">
                      {tunnel.forward_addresses_protocol?.[i] && (
                        <Badge variant="outline">{tunnel.forward_addresses_protocol[i]}</Badge>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => copy(addr)} aria-label={t("common.copy")}>
                        <Copy className="size-3.5" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("tunnel.loadBalance")}</CardTitle>
            <CardDescription>{t("tunnel.runtime")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-[var(--border)]">
            {LIMIT_KEYS.map(({ key, labelKey, unit }) => {
              const value = tunnel[key] as number | null;
              return (
                <InfoRow key={String(key)} label={t(labelKey)}>
                  {value === null || value === undefined
                    ? t("plan.unlimited")
                    : `${value}${unit ? ` ${unit}` : ""}`}
                </InfoRow>
              );
            })}
          </CardContent>
        </Card>
      </div>

      <Dialog open={editForwardOpen} onOpenChange={setEditForwardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("tunnel.forwardTargets")}</DialogTitle>
            <DialogDescription>{t("tunnel.forwardAddressesHint")}</DialogDescription>
          </DialogHeader>
          <Field label={t("tunnel.forwardAddresses")}>
            <Textarea
              rows={4}
              value={forwardDraft}
              onChange={(e) => setForwardDraft(e.target.value)}
              data-testid="forward-textarea"
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditForwardOpen(false)} disabled={savingForward}>
              {t("common.cancel")}
            </Button>
            <Button onClick={onSaveForward} disabled={savingForward} data-testid="save-forward-btn">
              {savingForward && <Loader2 className="size-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("common.delete")}
        description={t("tunnel.deleteConfirm")}
        onConfirm={onDelete}
        pending={deleting}
      />
    </div>
  );
}
