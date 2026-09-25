"use client";

/**
 * WP13 —— v3 隧道编排（apply 状态机）共享展示 + 运行操作。
 *
 * 约定（DEVELOPMENT.md §4.1 / §7.14 WP13）：
 *   - 状态真相是 `apply_status`；`status` 是 legacy DIRECT 开关列，两者并行展示。
 *   - NULL `tunnel_mode` / NULL `apply_status` = 补列前的存量行（§7.1「不改 /
 *     不猜」），必须显式渲染「未声明 / 无编排」，不得默认成 direct / active。
 *   - 运行操作（retry/suspend/resume）按钮只按 §4.1 的合法来源状态启用：
 *       error → retry · active → suspend · suspended → resume
 *     其余状态一律禁用（含 pending/applying 与 legacy），避免用户对「正在下发」
 *     或「无编排」的隧道做无效操作。
 *   - **WP11 Tunnel RELAY API 未合入 main**：api.tunnels.retry/suspend/resume 由
 *     mocks/handler.ts 提供同契约响应；契约冻结后无需改本组件。
 */

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Pause, Play, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/components/providers";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import type { Tunnel, TunnelApplyStatus, TunnelApplyStep, TunnelMode } from "@/lib/types";

/** v3 apply 状态 → Badge 变体（卡片已有的 success / destructive / muted / outline） */
const APPLY_BADGE_VARIANT: Record<TunnelApplyStatus, "success" | "destructive" | "muted" | "secondary"> = {
  active: "success",
  error: "destructive",
  applying: "secondary",
  pending: "muted",
  suspended: "muted",
};

export function tunnelModeLabelKey(mode: TunnelMode | null | undefined): string {
  // NULL/undefined = 存量未声明，**不得**默认成 direct（§7.1）
  if (mode === "direct") return "tunnel.v3ModeDirect";
  if (mode === "relay") return "tunnel.v3ModeRelay";
  return "tunnel.v3ModeUndeclared";
}

export function applyStatusLabelKey(status: TunnelApplyStatus | null | undefined): string {
  switch (status) {
    case "pending":
      return "tunnel.v3ApplyPending";
    case "applying":
      return "tunnel.v3ApplyApplying";
    case "active":
      return "tunnel.v3ApplyActive";
    case "error":
      return "tunnel.v3ApplyError";
    case "suspended":
      return "tunnel.v3ApplySuspended";
    default:
      return "tunnel.v3ApplyLegacy";
  }
}

/** apply 状态徽章（NULL = legacy 无编排，灰色 outline） */
export function ApplyStatusBadge({ status }: { status: TunnelApplyStatus | null | undefined }) {
  const { t } = useI18n();
  if (status === null || status === undefined) {
    return (
      <Badge variant="outline" className="text-[var(--muted-foreground)]">
        {t("tunnel.v3ApplyLegacy")}
      </Badge>
    );
  }
  return <Badge variant={APPLY_BADGE_VARIANT[status]}>{t(applyStatusLabelKey(status))}</Badge>;
}

/** 模式徽章（NULL = 未声明） */
export function TunnelModeBadge({ mode }: { mode: TunnelMode | null | undefined }) {
  const { t } = useI18n();
  const isUndeclared = mode !== "direct" && mode !== "relay";
  return (
    <Badge variant={isUndeclared ? "outline" : "secondary"}>{t(tunnelModeLabelKey(mode))}</Badge>
  );
}

export function applyStatusHintKey(status: TunnelApplyStatus | null | undefined): string {
  switch (status) {
    case "pending":
      return "tunnel.v3ApplyPendingHint";
    case "applying":
      return "tunnel.v3ApplyApplyingHint";
    case "active":
      return "tunnel.v3ApplyActiveHint";
    case "error":
      return "tunnel.v3ApplyErrorHint";
    case "suspended":
      return "tunnel.v3ApplySuspendedHint";
    default:
      return "tunnel.v3ApplyLegacy";
  }
}

/** revision 漂移检测：有编排且 applied < desired = 待下发 */
export function revisionDrifted(tunnel: Tunnel): boolean {
  const { config_revision, applied_revision, apply_status } = tunnel;
  if (apply_status === null || apply_status === undefined) return false;
  if (config_revision == null || applied_revision == null) return false;
  // error 态 already 说明当前 revision 未生效；仍归为漂移（UI 一致提示重试）
  return applied_revision < config_revision;
}

export default function TunnelOrchestrationPanel({
  tunnel,
  onChanged,
}: {
  tunnel: Tunnel;
  /** 运行操作成功后回调（父组件据此覆盖本地 tunnel 状态并刷新） */
  onChanged: (t: Tunnel) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<"retry" | "suspend" | "resume" | null>(null);

  const status = tunnel.apply_status ?? null;
  const isLegacy = status === null;
  // §4.1 合法迁移：error → retry / active → suspend / suspended → resume
  const canRetry = status === "error";
  const canSuspend = status === "active";
  const canResume = status === "suspended";
  const inFlight = status === "pending" || status === "applying";
  const drifted = revisionDrifted(tunnel);

  async function run(action: "retry" | "suspend" | "resume") {
    setBusy(action);
    try {
      const res =
        action === "retry"
          ? await api.tunnels.retry(tunnel.id)
          : action === "suspend"
            ? await api.tunnels.suspend(tunnel.id)
            : await api.tunnels.resume(tunnel.id);
      onChanged(res.tunnel);
      toast.success(
        action === "retry"
          ? t("tunnel.v3RetrySuccess")
          : action === "suspend"
            ? t("tunnel.v3SuspendSuccess")
            : t("tunnel.v3ResumeSuccess"),
      );
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : action === "retry"
            ? t("tunnel.v3RetryFailed")
            : action === "suspend"
              ? t("tunnel.v3SuspendFailed")
              : t("tunnel.v3ResumeFailed"),
      );
    } finally {
      setBusy(null);
    }
  }

  const nodeLabel = (n: Tunnel["egress_node"] | undefined, id: Tunnel["egress_node_id"]) => {
    if (n?.node_id) return `${n.node_id}${id ? ` (#${id})` : ""}`;
    if (n?.connect_ip) return n.connect_ip;
    if (id != null) return `#${id}`;
    return t("common.none");
  };

  return (
    <Card data-testid="tunnel-orchestration">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>{t("tunnel.v3ApplyStatus")}</CardTitle>
          <CardDescription>{t(applyStatusHintKey(status))}</CardDescription>
        </div>
        <ApplyStatusBadge status={status} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLegacy ? (
          <p className="text-sm text-[var(--muted-foreground)]">{t("tunnel.v3ApplyLegacy")}</p>
        ) : (
          <>
            {/* 状态明细 */}
            <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              <Row label={t("tunnel.v3Revision")}>{tunnel.config_revision ?? t("common.none")}</Row>
              <Row label={t("tunnel.v3AppliedRevision")}>
                <span className={drifted ? "text-[var(--primary)]" : undefined}>
                  {tunnel.applied_revision ?? t("common.none")}
                  {drifted && <span className="ml-1.5 text-xs">({t("tunnel.v3RevisionDrift")})</span>}
                </span>
              </Row>
              <Row label={t("tunnel.v3InNode")}>
                {tunnel.in_node_group?.name ?? tunnel.in_node_group_id}
              </Row>
              <Row label={t("tunnel.v3OutNode")}>
                {nodeLabel(tunnel.egress_node, tunnel.egress_node_id)}
              </Row>
              <Row label={t("tunnel.v3EgressPort")}>
                {tunnel.egress_port ?? t("common.none")}
              </Row>
              <Row label={t("tunnel.v3Pool")}>
                {tunnel.egress_pool ? tunnel.egress_pool.name : t("tunnel.v3PoolNone")}
              </Row>
              <Row label={t("tunnel.v3LastAppliedAt")}>
                {tunnel.last_applied_at ? formatDateTime(tunnel.last_applied_at) : t("common.none")}
              </Row>
            </div>

            {/* 错误原因（error 态必须可解释） */}
            {status === "error" && (
              <div className="rounded-md border border-[var(--destructive)]/40 bg-[var(--destructive)]/10 px-3 py-2">
                <div className="flex items-center gap-1.5 text-sm font-medium text-[var(--destructive)]">
                  <AlertTriangle className="size-4" />
                  {t("tunnel.v3ErrorDetail")}
                </div>
                {tunnel.apply_error_code && (
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    {t("tunnel.v3ErrorCode")}: <span className="font-mono">{tunnel.apply_error_code}</span>
                  </div>
                )}
                {tunnel.apply_error && <p className="mt-1 text-xs">{tunnel.apply_error}</p>}
              </div>
            )}

            {/* 编排步骤回放（只读） */}
            <div>
              <div className="mb-1.5 section-title">{t("tunnel.v3Steps")}</div>
              {!tunnel.apply_steps || tunnel.apply_steps.length === 0 ? (
                <p className="text-xs text-[var(--muted-foreground)]">{t("tunnel.v3NoSteps")}</p>
              ) : (
                <ol className="flex flex-col gap-1">
                  {tunnel.apply_steps.map((s: TunnelApplyStep, i) => (
                    <li
                      key={`${s.step}-${i}`}
                      className="flex items-center justify-between rounded border border-[var(--border)] px-2.5 py-1.5 text-xs"
                    >
                      <span className="font-mono">{s.step}</span>
                      <span className="flex items-center gap-2">
                        {s.error && <span className="font-mono text-[var(--destructive)]">{s.error}</span>}
                        <Badge variant={s.ok ? "success" : "destructive"}>
                          {s.ok ? t("tunnel.v3StepOk") : t("tunnel.v3StepFailed")}
                        </Badge>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </>
        )}

        {/* 运行操作（WP11 mock：契约冻结） */}
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={!canRetry || busy !== null || isLegacy}
            onClick={() => run("retry")}
            data-testid="tunnel-retry-btn"
          >
            {busy === "retry" ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
            {t("tunnel.v3Retry")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canSuspend || busy !== null || isLegacy}
            onClick={() => run("suspend")}
            data-testid="tunnel-suspend-btn"
          >
            {busy === "suspend" ? <Loader2 className="size-4 animate-spin" /> : <Pause className="size-4" />}
            {t("tunnel.v3Suspend")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!canResume || busy !== null || isLegacy}
            onClick={() => run("resume")}
            data-testid="tunnel-resume-btn"
          >
            {busy === "resume" ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {t("tunnel.v3Resume")}
          </Button>
          {/* 禁用原因（可用 aria 提示；不弹 toast 打扰） */}
          {!isLegacy && (inFlight || (!canRetry && !canSuspend && !canResume)) && (
            <span className="text-xs text-[var(--muted-foreground)]">{t("tunnel.v3ActionDisabled")}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-[var(--border)] py-1 text-xs">
      <span className="text-[var(--muted-foreground)]">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  );
}
