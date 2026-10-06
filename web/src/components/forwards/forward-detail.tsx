"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Copy, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDeleteDialog } from "@/components/admin/admin-ui";
import { ForwardDiagnose } from "@/components/forwards/forward-diagnose";
import { ForwardEditDialog, RunningVsDesiredBadge } from "@/components/forwards/forward-edit-dialog";
import { ForwardProtocolBadge } from "@/components/forwards/forward-protocol-badge";
import { ForwardLedgerTotal, ForwardTopologyCard } from "@/components/forwards/forward-topology";
import { ForwardDnsCard } from "@/components/forwards/forward-dns-card";
import { ForwardLatencyCard } from "@/components/forwards/forward-latency";
import { ForwardHaCard } from "@/components/forwards/forward-ha-card";
import { useI18n } from "@/components/providers";
import { TrafficChart } from "@/components/traffic-chart";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoRow } from "@/components/ui/form";
import { api } from "@/lib/api";
import { useWorkspace } from "@/components/workspace/workspace-context";
import { PERMISSION_DENIED } from "@/lib/workspace-permissions";
import { forwardAccessAddress } from "@/components/forwards/forward-copy";
import {
  TLS_FORWARD_PROTOCOL,
  forwardProtocolFact,
  forwardProtocolHasConnections,
} from "@/lib/forward-protocol";
import {
  applyErrorAction,
  forwardErrorActions,
  forwardErrorInfo,
  forwardProductBadgeVariant,
  forwardProductStatus,
} from "@/lib/forward-status";
import type { NodeBinding, PortForward, TrafficPoint, UserNode } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

export function ForwardDetail({
  forward: initialForward,
  traffic: initialTraffic,
}: {
  forward: PortForward;
  traffic: TrafficPoint[];
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { currentId, permissions, permissionsLoading, can, canForward } = useWorkspace();
  const [forward, setForward] = useState(initialForward);
  const [traffic, setTraffic] = useState(initialTraffic);
  const [resourceScope, setResourceScope] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const canUpdate = resourceScope === currentId && canForward(forward, "update");
  const canDelete = resourceScope === currentId && canForward(forward, "delete");
  const [actionBusy, setActionBusy] = useState(false);
  /**
   * 「下一步做什么」提示：重试/暂停/恢复失败时**不替换页面内容**，只在按钮
   * 下方给一句可执行的话（V4-WP8 §13.5：错误必须给下一步）。
   *
   * 为什么不用 toast：toast 几秒后消失，而用户真正需要的是「照这句话去做」，
   * 页面上的常驻提示才办得到；何况失败原因往往需要照着念给管理员。
   */
  const [actionHint, setActionHint] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // V4-WP4：编辑 = 全字段编辑器（不再只有改名）。
  const [editOpen, setEditOpen] = useState(false);
  const [nodes, setNodes] = useState<UserNode[]>([]);
  const [bindings, setBindings] = useState<Record<string, NodeBinding[]>>({});

  useEffect(() => {
    if (!editOpen || !can("node:read")) return;
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
  }, [editOpen, currentId, permissions]);

  async function refreshTraffic() {
    try {
      setTraffic(await api.forwards.traffic(forward.id, 14));
    } catch {
      // Traffic is secondary to the control-plane operation.
    }
  }

  async function runAction(action: "retry" | "suspend" | "resume") {
    if (!canUpdate) { toast.error(PERMISSION_DENIED); return; }
    setActionBusy(true);
    setActionHint(null);
    try {
      const updated = await api.forwards.action(forward.id, action);
      setForward(updated);
      await refreshTraffic();
      router.refresh();
    } catch (error) {
      // V4-WP8 §13.5：失败必须给「下一步」，而且**先给动作再给原文**。
      //
      // 顺序是有意的：动作是用户现在能做的事；原文是排障材料（可能要念给管理员）。
      // 只回显原文等于把诊断责任推给用户。而「动作」全部来自码表（WP7 的
      // `conditionAction` / 本 WP 的 `applyErrorAction`）—— 409 的
      // `data.condition`（例如 `node_in_maintenance`）在此被消费，不再是笼统的
      // 「操作失败」。
      const message = writeFailureText(error, t("forward.loadFailed"));
      toast.error(message);
      setActionHint(message);
    } finally {
      setActionBusy(false);
    }
  }

  /** 与列表页同一口径：按 condition / apply_error_code 给下一步，再落后端原文。 */
  function writeFailureText(err: unknown, fallback: string): string {
    const info = forwardErrorInfo(err);
    const actions = forwardErrorActions(locale, info);
    return [...actions, info.message || fallback].filter((part) => part !== "").join(" ");
  }

  async function removeForward() {
    if (!canDelete) { toast.error(PERMISSION_DENIED); return; }
    setDeleting(true);
    try {
      await api.forwards.remove(forward.id);
      toast.success(t("forward.deleteSuccess"));
      setConfirmDelete(false);
      router.push("/forwards");
      router.refresh();
    } catch (error) {
      toast.error(writeFailureText(error, t("forward.deleteFailed")));
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

  useEffect(() => {
    let cancelled = false;
    setResourceScope(null); setLoadError(null);
    setEditOpen(false); setConfirmDelete(false); setNodes([]); setBindings({});
    if (!can("forward:read") || currentId === null) return;
    void api.forwards.detail(initialForward.id).then(async (value) => {
      const points = await api.forwards.traffic(value.id, 14).catch(() => [] as TrafficPoint[]);
      if (cancelled) return;
      setForward(value); setTraffic(points); setResourceScope(currentId);
    }).catch((err) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : PERMISSION_DENIED); });
    return () => { cancelled = true; };
  }, [currentId, permissions, initialForward]);

  const listenAddress = forwardAccessAddress(forward) ?? t("forward.addressPending");
  const targetAddress =
    forward.target_host && forward.target_port
      ? `${forward.target_host}:${forward.target_port}`
      : t("forward.noTarget");
  // V4-WP8 §13.4：产品状态是**唯一**的投影实现（lib/forward-status.ts），
  // 本组件不再自己比较 revision。
  const product = forwardProductStatus(forward);
  /**
   * V5.1b：传输维度决定两处渲染 —— datagram（udp）要显式说明它**没有连接**，
   * tls 行要展示证书/私钥路径（后端已投影这两列）。
   * 两个判断都走契约模块（`forwardProtocolHasConnections` / `forwardProtocolFact`），
   * 组件不自己比较协议名 —— 否则「udp 没有连接」这个事实就有了第二份实现。
   * `false` 才是「确认没有连接」；`null`（未开放的协议）不说任何话。
   */
  const datagram = forwardProtocolHasConnections(forward.protocol) === false;
  const isTls = forwardProtocolFact(forward.protocol) === TLS_FORWARD_PROTOCOL;
  // 失败时给可执行的一步（后端原文优先；没有已知动作时不编造）。
  const applyNextStep = forward.apply_error
    ? applyErrorAction(locale, forward.apply_error_code)
    : null;

  if (permissionsLoading) return <p>{t("common.loading")}</p>;
  if (!can("forward:read")) return <p role="alert">{PERMISSION_DENIED}</p>;
  if (loadError) return <p role="alert">{loadError}</p>;
  if (resourceScope !== currentId) return <p>{t("common.loading")}</p>;
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
          {canUpdate && forward.apply_status === "error" ? (
            <Button size="sm" variant="outline" onClick={() => void runAction("retry")} disabled={actionBusy}>
              {actionBusy && <Loader2 className="size-4 animate-spin" />}
              {t("forward.retry")}
            </Button>
          ) : null}
          {canUpdate && forward.apply_status === "active" ? (
            <Button size="sm" variant="outline" onClick={() => void runAction("suspend")} disabled={actionBusy}>
              {actionBusy && <Loader2 className="size-4 animate-spin" />}
              {t("forward.suspend")}
            </Button>
          ) : null}
          {canUpdate && forward.apply_status === "suspended" ? (
            <Button size="sm" variant="outline" onClick={() => void runAction("resume")} disabled={actionBusy}>
              {actionBusy && <Loader2 className="size-4 animate-spin" />}
              {t("forward.resume")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={!canUpdate}
             onClick={() => setEditOpen(true)}
          >
            <Pencil className="size-4" />
            {t("forward.editForward")}
          </Button>
          <Button disabled={!canDelete} size="sm" variant="destructive" onClick={() => setConfirmDelete(true)}>
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
              {/* V4-WP8 §13.7：产品状态，不画 apply_status 原始枚举。 */}
              <Badge variant={forwardProductBadgeVariant(product.state)} data-testid="forward-product-status">
                {t(`forward.product.${product.state}`)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="mb-2 flex items-center justify-between">
              <span className="section-title">{t("forward.trafficTrend")}</span>
              {/* 累计流量改用**归档账本**（与图表同源），不再读详情接口里那条
                  已无写入者的 legacy `forward.traffic` 列（F11：同屏两个口径，
                  数字永远是 0 B）。窗口/归档延迟由组件如实标注。 */}
              <ForwardLedgerTotal points={traffic} />
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

        {/* 链路（自包含组件，自带四态：loading / denied / 取不到 / ok）。
            它一次回答"这条转发经过哪些节点、每一端是否在跑、revision 对不对"，
            并且**只**消费服务端 `GET /api/forwards/:id/topology` 的投影——
            前端不自己判在线、不把"取不到"说成"正常"。 */}
        <div className="lg:col-span-2">
          <ForwardTopologyCard forwardId={forward.id} />
        </div>

        {/* DNS 前门（自包含组件，只吃 forwardId：权限、取数、绑定/解绑、五态与
            退避全部在组件内部，按服务端投影渲染）。它**不**推断"已切换"：
            只有 `state === "synced"` 才会那样说。 */}
        <div className="lg:col-span-2">
          <ForwardDnsCard forwardId={forward.id} />
        </div>

        {/* 延迟历史（自包含组件，只吃 forwardId）。四态由服务端的 `status` 决定：
            有观测 / 窗口内没观测（数据缺口）/ 按构造没有观测维度 / 多目标拒绝猜；
            `latency_ms: null` 是"那次不可达"，折线断开而**不补零**。 */}
        <div className="lg:col-span-2">
          <ForwardLatencyCard forwardId={forward.id} />
        </div>

        {/* 高可用（task-16 交付的自包含卡片）：只读服务端 `/forwards/:id/ha` 投影。
            「首选入口」是**期望**、`connection`/`accepts_new_business` 是**事实**，
            两者在卡片里分开说；平台策略缺省即关时显示"未启用自动迁移"，不写成"已保护"。 */}
        <div className="lg:col-span-2">
          <ForwardHaCard forwardId={forward.id} />
        </div>

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
            {/*
              V5-WP5-A1：协议事实（四个可创建值 + 历史行的未开放值）。
              渲染走共用徽标，未知取值**不会**退化成 "unknown"。
            */}
            <InfoRow label={t("forward.protocol")}>
              <ForwardProtocolBadge forward={forward} />
            </InfoRow>
            {/*
              V5.1b §6.2：datagram（udp）的会话模型必须说出来。这是**唯一**会让人按
              TCP 的连接模型理解 udp 的地方：详情页给出了它正在服务的协议，却对
              「有没有连接」「怎么结束」保持沉默，用户就会把不存在的连接数当成 0。
              只对 datagram 行显示 —— stream 行的「连接」不需要解释。
            */}
            {datagram ? (
              <InfoRow label={t("forward.sessionModel")}>
                <span className="text-xs">{t("forward.sessionModelMapping")}</span>
              </InfoRow>
            ) : null}
            {/*
              V5-WP5-A1：tls 行的证书/私钥路径。后端 `forwardView` 现在投影这两列
              （只有路径，永远没有密钥内容），所以运维可以在页面上核对用的是哪张证书，
              而不必去读数据库。
            */}
            {isTls ? (
              <>
                <InfoRow label={t("forward.tlsCertPath")}>
                  <span className="font-mono text-xs break-all">
                    {forward.tls_cert_path ?? t("common.none")}
                  </span>
                </InfoRow>
                <InfoRow label={t("forward.tlsKeyPath")}>
                  <span className="font-mono text-xs break-all">
                    {forward.tls_key_path ?? t("common.none")}
                  </span>
                </InfoRow>
              </>
            ) : null}
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
            {/* V4-WP4/V4-WP8：running-vs-desired 用产品状态表达，先给语义。 */}
            <InfoRow label={t("forward.runningDesired")}>
              <RunningVsDesiredBadge forward={forward} />
            </InfoRow>
            <InfoRow label={t("forward.online")}>
              {forward.online ? t("common.online") : t("common.offline")}
            </InfoRow>
          </div>
          <div className="flex flex-col divide-y divide-[var(--border)]">
            {/*
              V4-WP8 §13.7：raw revision / desired internals **默认折叠**。
              信息不删除（排障仍要看），只是不再默认糊在脸上 ——
              「config_revision 5 / applied_revision 3」对普通用户不构成决策依据，
              产品状态才构成。用原生 <details> 而不是状态驱动的折叠组件：
              默认收起是**结构性**保证（没有 JS 也能保证收起），不会被某次
              重构顺手改成默认展开。
            */}
            <details className="py-2" data-testid="forward-technical-details">
              <summary className="cursor-pointer text-xs text-[var(--muted-foreground)]">
                {t("forward.technicalDetails")}
              </summary>
              <div className="mt-2 flex flex-col divide-y divide-[var(--border)]">
                <InfoRow label={t("forward.desiredStatus")}>
                  {forward.desired_status ?? t("common.none")}
                </InfoRow>
                <InfoRow label={t("forward.applyStatus")}>
                  <span className="font-mono text-xs">{forward.apply_status ?? "—"}</span>
                </InfoRow>
                <InfoRow label={t("forward.revision")}>
                  {forward.config_revision ?? forward.latest_revision ?? "—"}
                </InfoRow>
                <InfoRow label={t("forward.appliedRevision")}>
                  {forward.applied_revision ?? "—"}
                </InfoRow>
                <InfoRow label={t("forward.lastApplied")}>
                  {forward.last_applied_at ? formatDateTime(forward.last_applied_at) : "—"}
                </InfoRow>
              </div>
            </details>
            {actionHint ? (
              <p className="py-2 text-xs text-[var(--destructive)]" data-testid="forward-action-hint">
                {actionHint}
              </p>
            ) : null}
          </div>
          {forward.apply_error ? (
            <div className="md:col-span-2 mt-4 rounded-md border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 p-3">
              <div className="text-sm font-medium text-[var(--destructive)]">{t("forward.applyError")}</div>
              {/* V4-WP8 §13.5：先给「下一步」，再给原文。
                  原文是排障材料（可能要念给管理员），动作是用户现在能做的事；
                  只给原文等于把诊断责任推给用户。 */}
              {applyNextStep ? (
                <p className="mt-1 text-xs" data-testid="forward-apply-next-step">
                  {applyNextStep}
                </p>
              ) : null}
              <div className="mt-1 font-mono text-xs text-[var(--destructive)]">
                {forward.apply_error_code ? `${forward.apply_error_code}: ` : ""}
                {forward.apply_error}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* V4-WP11C：诊断入口。只读，不需要变更权限——能看这条转发的人就能诊断它。 */}
      <ForwardDiagnose forwardId={forward.id} />

      <ForwardEditDialog
        open={editOpen && canUpdate}
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
        open={confirmDelete && canDelete}
        onOpenChange={setConfirmDelete}
        title={t("common.delete")}
        description={t("forward.deleteConfirm").replace("{name}", forward.name)}
        onConfirm={removeForward}
        pending={deleting}
      />
    </div>
  );
}
