"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Copy, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDeleteDialog } from "@/components/admin/admin-ui";
import { ForwardEditDialog, RunningVsDesiredBadge } from "@/components/forwards/forward-edit-dialog";
import { useI18n } from "@/components/providers";
import { TrafficChart } from "@/components/traffic-chart";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoRow } from "@/components/ui/form";
import { api } from "@/lib/api";
import type { NodeBinding, PortForward, TrafficPoint, UserNode } from "@/lib/types";
import { formatBytes, formatDateTime } from "@/lib/utils";

function statusVariant(status: PortForward["apply_status"]) {
  if (status === "active") return "success" as const;
  if (status === "error") return "destructive" as const;
  return "secondary" as const;
}

export function ForwardDetail({
  forward: initialForward,
  traffic: initialTraffic,
}: {
  forward: PortForward;
  traffic: TrafficPoint[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [forward, setForward] = useState(initialForward);
  const [traffic, setTraffic] = useState(initialTraffic);
  const [actionBusy, setActionBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // V4-WP4：编辑 = 全字段编辑器（不再只有改名）。
  const [editOpen, setEditOpen] = useState(false);
  const [nodes, setNodes] = useState<UserNode[]>([]);
  const [bindings, setBindings] = useState<Record<string, NodeBinding[]>>({});

  useEffect(() => {
    if (!editOpen) return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await api.nodes.list();
        if (cancelled) return;
        setNodes(rows);
        const ingressRows = rows.filter(
          (node) => node.role === "ingress" || node.role === "both",
        );
        const map: Record<string, NodeBinding[]> = {};
        for (const node of ingressRows) {
          const list = await api.nodes.bindings(node.id);
          map[String(node.id)] = list;
        }
        if (!cancelled) setBindings(map);
      } catch {
        // 节点列表只服务于编辑器的下拉；取不到时编辑器仍可打开，
        // 由表单自身的必填校验提示用户。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editOpen]);

  async function refreshTraffic() {
    try {
      setTraffic(await api.forwards.traffic(forward.id, 14));
    } catch {
      // Traffic is secondary to the control-plane operation.
    }
  }

  async function runAction(action: "retry" | "suspend" | "resume") {
    setActionBusy(true);
    try {
      const updated = await api.forwards.action(forward.id, action);
      setForward(updated);
      await refreshTraffic();
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("forward.loadFailed"));
    } finally {
      setActionBusy(false);
    }
  }

  async function removeForward() {
    setDeleting(true);
    try {
      await api.forwards.remove(forward.id);
      toast.success(t("forward.deleteSuccess"));
      setConfirmDelete(false);
      router.push("/forwards");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("forward.deleteFailed"));
      setDeleting(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("common.copied"));
    } catch {
      toast.error(text);
    }
  }

  const listenAddress = `${forward.listen_ip ?? "*"}:${forward.listen_port ?? "auto"}`;
  const targetAddress =
    forward.target_host && forward.target_port
      ? `${forward.target_host}:${forward.target_port}`
      : t("forward.noTarget");

  return (
    <div className="flex flex-col gap-5" data-testid="forward-detail">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/forwards">
            <ArrowLeft className="size-4" />
            {t("forward.backToList")}
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          {forward.apply_status === "error" ? (
            <Button size="sm" variant="outline" onClick={() => void runAction("retry")} disabled={actionBusy}>
              {actionBusy && <Loader2 className="size-4 animate-spin" />}
              {t("forward.retry")}
            </Button>
          ) : null}
          {forward.apply_status === "active" ? (
            <Button size="sm" variant="outline" onClick={() => void runAction("suspend")} disabled={actionBusy}>
              {actionBusy && <Loader2 className="size-4 animate-spin" />}
              {t("forward.suspend")}
            </Button>
          ) : null}
          {forward.apply_status === "suspended" ? (
            <Button size="sm" variant="outline" onClick={() => void runAction("resume")} disabled={actionBusy}>
              {actionBusy && <Loader2 className="size-4 animate-spin" />}
              {t("forward.resume")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="size-4" />
            {t("forward.editForward")}
          </Button>
          <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="size-4" />
            {t("common.delete")}
          </Button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="truncate">{forward.name}</CardTitle>
              <CardDescription>{t("forward.detailSubtitle")}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={forward.mode === "relay" ? "outline" : "secondary"}>
                {forward.mode === "relay" ? t("forward.relay") : t("forward.direct")}
              </Badge>
              <Badge variant={statusVariant(forward.apply_status)}>
                {forward.apply_status ?? "pending"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-2 flex items-center justify-between">
              <span className="section-title">{t("forward.trafficTrend")}</span>
              <span className="text-xs text-[var(--muted-foreground)]">
                {t("forward.totalTraffic")}: {formatBytes(forward.traffic)}
              </span>
            </div>
            {traffic.length > 0 ? (
              <TrafficChart data={traffic} />
            ) : (
              <div className="flex h-64 items-center justify-center rounded-md bg-[var(--muted)] text-sm text-[var(--muted-foreground)]">
                {t("forward.noTraffic")}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("forward.basicInfo")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col divide-y divide-[var(--border)]">
            <InfoRow label={t("fields.id")}>
              <span className="font-mono text-xs">{forward.id}</span>
            </InfoRow>
            <InfoRow label={t("forward.mode")}>
              {forward.mode === "relay" ? t("forward.relay") : t("forward.direct")}
            </InfoRow>
            <InfoRow label={t("forward.ingressNode")}>
              {forward.ingress_node?.node_id ?? forward.ingress_node_id}
            </InfoRow>
            <InfoRow label={t("forward.egressNode")}>
              {forward.egress_node?.node_id ?? t("common.none")}
            </InfoRow>
            <InfoRow label={t("forward.listenAddress")}>
              <button
                className="inline-flex items-center gap-1 font-mono text-xs hover:text-[var(--primary)]"
                onClick={() => void copy(listenAddress)}
              >
                {listenAddress}
                <Copy className="size-3 opacity-60" />
              </button>
            </InfoRow>
            <InfoRow label={t("forward.target")}>
              <button
                className="inline-flex items-center gap-1 font-mono text-xs hover:text-[var(--primary)]"
                onClick={() => void copy(targetAddress)}
                disabled={!forward.target_host || !forward.target_port}
              >
                {targetAddress}
                {forward.target_host && forward.target_port ? <Copy className="size-3 opacity-60" /> : null}
              </button>
            </InfoRow>
            <InfoRow label={t("common.createdAt")}>
              <span className="text-xs text-[var(--muted-foreground)]">{formatDateTime(forward.created_at)}</span>
            </InfoRow>
            <InfoRow label={t("common.updatedAt")}>
              <span className="text-xs text-[var(--muted-foreground)]">{formatDateTime(forward.updated_at)}</span>
            </InfoRow>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("forward.runtime")}</CardTitle>
          <CardDescription>{t("forward.runtimeHint")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-x-8 md:grid-cols-2">
          <div className="flex flex-col divide-y divide-[var(--border)]">
            {/* V4-WP4：running-vs-desired 用产品状态表达，先给语义再给数字。 */}
            <InfoRow label={t("forward.runningDesired")}>
              <RunningVsDesiredBadge forward={forward} />
            </InfoRow>
            <InfoRow label={t("forward.desiredStatus")}>
              {forward.desired_status ?? t("common.none")}
            </InfoRow>
            <InfoRow label={t("forward.applyStatus")}>
              <Badge variant={statusVariant(forward.apply_status)}>
                {forward.apply_status ?? "pending"}
              </Badge>
            </InfoRow>
            <InfoRow label={t("forward.revision")}>
              {forward.config_revision ?? forward.latest_revision ?? "—"}
            </InfoRow>
          </div>
          <div className="flex flex-col divide-y divide-[var(--border)]">
            <InfoRow label={t("forward.appliedRevision")}>
              {forward.applied_revision ?? "—"}
            </InfoRow>
            <InfoRow label={t("forward.lastApplied")}>
              {forward.last_applied_at ? formatDateTime(forward.last_applied_at) : "—"}
            </InfoRow>
            <InfoRow label={t("forward.online")}>
              {forward.online ? t("common.online") : t("common.offline")}
            </InfoRow>
          </div>
          {forward.apply_error ? (
            <div className="md:col-span-2 mt-4 rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 p-3">
              <div className="text-sm font-medium text-[var(--destructive)]">{t("forward.applyError")}</div>
              <div className="mt-1 font-mono text-xs text-[var(--destructive)]">
                {forward.apply_error_code ? `${forward.apply_error_code}: ` : ""}
                {forward.apply_error}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ForwardEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        forward={forward}
        nodes={nodes}
        bindings={bindings}
        onSaved={(updated) => {
          setForward(updated);
          router.refresh();
        }}
        onReload={() => router.refresh()}
      />

      <ConfirmDeleteDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("common.delete")}
        description={t("forward.deleteConfirm").replace("{name}", forward.name)}
        onConfirm={removeForward}
        pending={deleting}
      />
    </div>
  );
}
