"use client";

/**
 * V4-WP6 §13.4.4 —— 节点健康面板（**展示层**：只渲染后端已合成的结论）。
 *
 * 这一层不做任何判定：health / connection / reasons / flags / telemetry 全部
 * 来自 `GET /api/admin/node/:id/health`。面板只负责
 *   1. 把四态结论翻成徽章与中性文案（offline 不画成红色故障）；
 *   2. 把 reasons 渲染成**可操作**条目（症状 + 下一步），而不是一句「不健康」；
 *   3. 把 Agent 版本 / 资源 / runtime 计数与端口 / revision 摆成一眼能扫的表。
 *
 * 「未知 ≠ 0」：telemetry 为 null 时显示「等待首次上报」并保留 reasons
 * （例如 no_credential / never_reported），不去编造 0 值指标。
 */
import { AlertTriangle, CircleHelp, HeartPulse, Loader2, RefreshCw } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Progress } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { API_MOCK } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime } from "@/lib/utils";
import {
  connectionBadgeVariant,
  formatDuration,
  groupPorts,
  hasReasonCode,
  healthBadgeVariant,
  lifecycleBadgeVariant,
  resourceRows,
  runtimeCountEntries,
  severityBadgeVariant,
} from "@/lib/node-health";
import { nodeHealthText, reasonAction, reasonTitle } from "@/lib/node-health-i18n";
import type { NodeHealthReason, NodeHealthValue, NodeHealthView } from "@/lib/types";

/** 值 → 文本；缺值统一渲染成「-」，绝不把 null 显示成 0。 */
function dash(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "-";
  return String(v);
}

function InfoLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="shrink-0 text-xs text-[var(--muted-foreground)]">{label}</span>
      <span className="min-w-0 text-right text-xs break-all">{children}</span>
    </div>
  );
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius)] border border-[var(--border)] p-3" data-testid={testId}>
      <span className="text-xs font-medium">{title}</span>
      {children}
    </div>
  );
}

/** 判定理由一条：严重度徽章 + 标题 + 后端原句 + 下一步动作。 */
function ReasonRow({ reason, nextStepLabel }: { reason: NodeHealthReason; nextStepLabel: string }) {
  const { locale } = useI18n();
  const action = reasonAction(locale, reason.code);
  return (
    <li
      className="flex flex-col gap-1 rounded-[var(--radius)] border border-[var(--border)] p-2.5"
      data-testid="node-health-reason"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={severityBadgeVariant(reason.severity)} data-testid="node-health-reason-severity">
          {nodeHealthText(locale).severity[reason.severity]}
        </Badge>
        <span className="text-xs font-medium">{reasonTitle(locale, reason.code, reason.message)}</span>
        <code className="font-mono text-[10px] text-[var(--muted-foreground)]" data-testid="node-health-reason-code">
          {reason.code}
        </code>
      </div>
      {/* 后端原句始终保留：它是唯一带具体数值（92.3% / 版本号）的结论 */}
      <p className="text-xs text-[var(--muted-foreground)]">{reason.message}</p>
      {reason.detail && (
        <p className="font-mono text-[11px] break-all text-[var(--muted-foreground)]">{reason.detail}</p>
      )}
      {action && (
        <p className="text-xs" data-testid="node-health-reason-action">
          <span className="text-[var(--muted-foreground)]">{nextStepLabel}：</span>
          {action}
        </p>
      )}
    </li>
  );
}

export interface NodeHealthPanelProps {
  view: NodeHealthView | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function NodeHealthPanel({ view, loading, error, onRefresh }: NodeHealthPanelProps) {
  const { locale } = useI18n();
  const txt = nodeHealthText(locale);

  const health: NodeHealthValue | null = view?.health ?? null;
  const telemetry = view?.telemetry ?? null;
  const host = telemetry?.host ?? null;
  const resources = resourceRows(host);
  const counts = runtimeCountEntries(telemetry?.runtime.counts ?? null);
  const running = telemetry?.runtime.running ?? [];
  const upgradeAdvice = view ? hasReasonCode(view, "agent_version_behind") : false;

  const countLabels: Record<string, string> = {
    direct: txt.runtimeDirect,
    relay_ingress: txt.runtimeRelayIngress,
    relay_egress: txt.runtimeRelayEgress,
    total: txt.runtimeTotal,
  };
  const resourceLabels: Record<string, string> = {
    cpu: txt.resourceCpu,
    load: txt.resourceLoad,
    memory: txt.resourceMemory,
    disk: txt.resourceDisk,
    rss: txt.resourceRss,
    hostUptime: txt.resourceHostUptime,
  };

  return (
    <Card data-testid="node-health">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <HeartPulse className="size-4" />
          {txt.title}
          {health && (
            <Badge variant={healthBadgeVariant(health)} data-testid="node-health-badge">
              {txt.health[health]}
            </Badge>
          )}
          {view && (
            <>
              <Badge variant={connectionBadgeVariant(view.connection)} data-testid="node-health-connection">
                {txt.connection[view.connection] ?? view.connection}
              </Badge>
              <Badge variant={lifecycleBadgeVariant(view.lifecycle)} data-testid="node-health-lifecycle">
                {txt.lifecycle[view.lifecycle as keyof typeof txt.lifecycle] ?? view.lifecycle}
              </Badge>
            </>
          )}
          {upgradeAdvice && (
            <Badge variant="secondary" data-testid="node-health-upgrade">
              {txt.upgradeAdvice}
            </Badge>
          )}
          {API_MOCK && (
            <Badge variant="outline" title={txt.mockHint} data-testid="node-health-mock-badge">
              {txt.mockBadge}
            </Badge>
          )}
          <span className="ml-auto">
            <Button size="sm" variant="ghost" onClick={onRefresh} disabled={loading} data-testid="node-health-refresh">
              {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {txt.refresh}
            </Button>
          </span>
        </CardTitle>
        <CardDescription>{txt.subtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        {!view ? (
          <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]" data-testid="node-health-pending">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <CircleHelp className="size-4" />}
            <span>{error ?? (loading ? txt.loading : txt.loadFailed)}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* 布尔投影：四个并列事实，避免只看总徽章而漏掉具体维度 */}
            <div className="flex flex-wrap gap-1.5" data-testid="node-health-flags">
              <Badge variant={view.flags.reports_fresh ? "success" : "secondary"}>
                {view.flags.reports_fresh ? txt.flagReportsFresh : txt.flagReportsStale}
              </Badge>
              <Badge variant={view.flags.revision_in_sync ? "success" : "secondary"}>
                {view.flags.revision_in_sync ? txt.flagRevisionInSync : txt.flagRevisionBehind}
              </Badge>
              <Badge variant={view.flags.agent_errors_ongoing ? "destructive" : "muted"}>
                {view.flags.agent_errors_ongoing ? txt.flagErrorsOngoing : txt.flagErrorsNone}
              </Badge>
              <Badge variant={view.flags.resources_ok ? "success" : "secondary"}>
                {view.flags.resources_ok ? txt.flagResourcesOk : txt.flagResourcesTight}
              </Badge>
              <Badge variant={view.flags.ports_bound ? "success" : "destructive"} data-testid="node-health-flag-ports">
                {view.flags.ports_bound ? txt.flagPortsBound : txt.flagPortsMissing}
              </Badge>
            </div>

            {/* reasons：可操作诊断的主体 */}
            <Section title={`${txt.sectionReasons} (${view.reasons.length})`} testId="node-health-reasons">
              {view.reasons.length === 0 ? (
                <p className="text-xs text-[var(--muted-foreground)]">{txt.noIssues}</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {view.reasons.map((r, i) => (
                    <ReasonRow key={`${r.code}-${i}`} reason={r} nextStepLabel={txt.nextStep} />
                  ))}
                </ul>
              )}
            </Section>

            {!telemetry ? (
              <Section title={txt.noReport} testId="node-health-no-report">
                <p className="text-xs text-[var(--muted-foreground)]">{txt.noReportHint}</p>
              </Section>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Section title={txt.sectionVersion} testId="node-health-version">
                    <InfoLine label={txt.version}>{dash(telemetry.version)}</InfoLine>
                    <InfoLine label={txt.expectedVersion}>
                      {telemetry.expected_version ? (
                        <span className="flex items-center justify-end gap-1">
                          {telemetry.expected_version}
                          {upgradeAdvice && <AlertTriangle className="size-3 text-[var(--destructive)]" />}
                        </span>
                      ) : (
                        <span title={txt.versionUnknownHint}>-</span>
                      )}
                    </InfoLine>
                    <InfoLine label={txt.reportedRole}>{dash(telemetry.reported_role)}</InfoLine>
                  </Section>

                  <Section title={txt.sectionIdentity} testId="node-health-identity">
                    <InfoLine label={txt.hostname}>{dash(telemetry.hostname)}</InfoLine>
                    <InfoLine label={txt.osArch}>
                      {[telemetry.os, telemetry.arch].filter(Boolean).join(" / ") || "-"}
                    </InfoLine>
                    <InfoLine label={txt.agentStartedAt}>
                      {telemetry.agent_started_at ? formatDateTime(telemetry.agent_started_at) : "-"}
                    </InfoLine>
                    <InfoLine label={txt.agentUptime}>{formatDuration(telemetry.uptime_seconds)}</InfoLine>
                    <InfoLine label={txt.reportedAt}>
                      {telemetry.reported_at ? formatDateTime(telemetry.reported_at) : "-"}
                    </InfoLine>
                    <InfoLine label={txt.reportAge}>{formatDuration(telemetry.age_seconds)}</InfoLine>
                  </Section>

                  <Section title={txt.sectionRevision} testId="node-health-revision">
                    <InfoLine label={txt.appliedRevision}>{dash(telemetry.applied_revision)}</InfoLine>
                    <InfoLine label={txt.knownRevision}>{dash(telemetry.known_revision)}</InfoLine>
                    <InfoLine label={txt.forwardsCount}>{view.forward_count}</InfoLine>
                    <InfoLine label={txt.desiredRuntimes}>{dash(view.desired_runtime_count)}</InfoLine>
                    {telemetry.revision_pending && (
                      <p className="pt-1 text-xs text-[var(--muted-foreground)]" data-testid="node-health-revision-pending">
                        {txt.revisionPending}：{txt.revisionPendingHint}
                      </p>
                    )}
                  </Section>

                  <Section title={txt.sectionRuntime} testId="node-health-runtime">
                    {counts.length === 0 ? (
                      <p className="text-xs text-[var(--muted-foreground)]">-</p>
                    ) : (
                      <div className="flex flex-wrap gap-3" data-testid="node-health-runtime-counts">
                        {counts.map((c) => (
                          <span key={c.key} className="flex items-baseline gap-1">
                            <span className="text-xs text-[var(--muted-foreground)]">{countLabels[c.key]}</span>
                            <span className="font-mono text-xs">{c.value}</span>
                          </span>
                        ))}
                      </div>
                    )}
                    <InfoLine label={txt.runningRuntimes}>{running.length}</InfoLine>
                    {running.length > 0 && (
                      <p className="font-mono text-[11px] break-all text-[var(--muted-foreground)]">{running.join(", ")}</p>
                    )}
                    <InfoLine label={txt.usedPorts}>
                      <span className="font-mono">{groupPorts(telemetry.used_ports)}</span>
                    </InfoLine>
                  </Section>
                </div>

                <Section title={txt.sectionResources} testId="node-health-resources">
                  {resources.length === 0 ? (
                    <p className="text-xs text-[var(--muted-foreground)]">-</p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {resources.map((row) => (
                        <div key={row.key} className="flex flex-col gap-1" data-testid="node-health-resource">
                          <div className="flex items-start justify-between gap-3">
                            <span className="text-xs text-[var(--muted-foreground)]">{resourceLabels[row.key]}</span>
                            <span className="text-right font-mono text-xs break-all">
                              {row.text}
                              {row.key === "load" && row.note ? ` (${row.note}/cpu)` : ""}
                              {row.key === "disk" && row.note ? ` ${txt.diskPath}: ${row.note}` : ""}
                            </span>
                          </div>
                          {row.ratio !== null && <Progress value={row.ratio * 100} />}
                        </div>
                      ))}
                    </div>
                  )}
                </Section>

                <Section title={txt.sectionErrors} testId="node-health-errors">
                  <InfoLine label={txt.errorCount}>{dash(telemetry.errors.count)}</InfoLine>
                  <InfoLine label={txt.lastErrorAt}>
                    {telemetry.errors.last_at ? formatDateTime(telemetry.errors.last_at) : "-"}
                  </InfoLine>
                  {telemetry.errors.last_message && (
                    <p className="font-mono text-[11px] break-all text-[var(--destructive)]">
                      {telemetry.errors.last_message}
                    </p>
                  )}
                </Section>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
