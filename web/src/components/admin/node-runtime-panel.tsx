"use client";

import { Activity, RefreshCw } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { API_MOCK } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime } from "@/lib/utils";
import {
  nodeRuntimeText,
  type NodeRuntimeState,
  type NodeRuntimeText,
  type NodeRuntimeUnavailableReason,
} from "@/lib/node-runtime-state";
import type { Locale } from "@/lib/i18n";
import type { NodeStateReport } from "@/lib/types";

function formatPorts(ports: number[] | null | undefined): string {
  if (!ports || ports.length === 0) return "-";
  const sorted = [...ports].sort((a, b) => a - b);
  return sorted.join(", ");
}

/**
 * 本面板新增事实行的文案（面板侧角色 / 角色一致性 / 快照新鲜度）。
 *
 * 为什么在组件内而不是 `lib/i18n/dictionaries.ts`：本任务的写入范围**不含**字典
 * （那是多人共写的单一对象字面量，并发改它必然冲突）。词条按**事实**建表，漏一个
 * 状态是编译错误；集成时可整体搬进字典，不需要改这里的结构。
 *
 * 话术纪律：`stale` 只说"这一格事实多久没更新"，**不出现**"离线 / 异常 / 正常"——
 * 一台在线但 5 分钟没上报的节点会同时是 `online: true` + `stale: true`。
 */
interface RuntimeFactsText {
  panelRole: string;
  roleAgreement: string;
  roleAgreed: string;
  roleMismatch: string;
  roleUnknown: string;
  freshness: string;
  age: (seconds: number) => string;
  ageUnknown: string;
  staleNote: string;
}

const RUNTIME_FACTS_ZH: RuntimeFactsText = {
  panelRole: "面板侧角色",
  roleAgreement: "角色一致性",
  roleAgreed: "两侧一致（role_mismatch: false）",
  roleMismatch: "不一致（role_mismatch: true）：以面板侧角色为准",
  roleUnknown: "无法判定：有一侧没有角色值（不是「不一致」）",
  freshness: "快照新鲜度",
  age: (seconds) => `快照年龄 ${seconds} 秒`,
  ageUnknown: "没有快照（从未上报）",
  staleNote: "stale: true —— 这一格事实超过 5 分钟没更新；它不代表节点离线",
};

const RUNTIME_FACTS_EN: RuntimeFactsText = {
  panelRole: "Panel-side role",
  roleAgreement: "Role agreement",
  roleAgreed: "Both sides agree (role_mismatch: false)",
  roleMismatch: "Disagreement (role_mismatch: true): the panel-side role wins",
  roleUnknown: "Cannot decide: one side has no role value (not the same as \"disagreement\")",
  freshness: "Snapshot freshness",
  age: (seconds) => `Snapshot age ${seconds}s`,
  ageUnknown: "No snapshot (never reported)",
  staleNote: "stale: true — this fact has not been updated for over 5 minutes; it does not mean the node is offline",
};

function runtimeFactsText(locale: Locale): RuntimeFactsText {
  return locale === "en" ? RUNTIME_FACTS_EN : RUNTIME_FACTS_ZH;
}

function formatEgressPools(report: NodeStateReport): string {
  const pools = report.egress_pools;
  if (!pools || Object.keys(pools).length === 0) return "-";
  return Object.entries(pools)
    .map(([tunnelId, p]) => `#${tunnelId}: ${p.strategy} → ${(p.targets ?? []).join(", ")}`)
    .join("；");
}

/**
 * 「取不到」区块（**纯展示、无 hook**）。
 *
 * 独立导出有两个原因：
 *   1. 它必须与「没有上报」在**文案与 testid** 上完全可分（这是本切片的验收点）；
 *   2. 无 hook 才能在测试里直接调用取元素树、断言重试按钮真的挂在 `onRetry` 上
 *      （本仓没有 DOM 测试环境，只有 `renderToStaticMarkup`，同 `NodeInstallDialogBody`
 *      被拆出来的理由）。
 *
 * 文案纪律：只说「取不到 / 这不代表没有上报」，**不出现**「正常 / 健康 / 在线」
 * 之类正向结论。
 */
export function NodeRuntimeUnavailable({
  text,
  reason,
  message,
  onRetry,
}: {
  text: NodeRuntimeText;
  reason: NodeRuntimeUnavailableReason;
  message: string;
  onRetry?: () => void;
}) {
  const unrecognized = reason === "unrecognized_payload";
  return (
    <div className="flex flex-col gap-2" data-testid="runtime-unavailable">
      <p className="text-sm font-medium">{unrecognized ? text.unrecognizedTitle : text.unavailableTitle}</p>
      <p className="text-xs text-[var(--muted-foreground)]">
        {unrecognized ? text.unrecognizedHint : text.unavailableHint}
      </p>
      {message ? (
        <p className="font-mono text-xs break-all text-[var(--muted-foreground)]" data-testid="runtime-unavailable-detail">
          {message}
        </p>
      ) : null}
      {onRetry ? (
        <div>
          <Button size="sm" variant="outline" onClick={onRetry} data-testid="runtime-retry">
            <RefreshCw className="size-4" />
            {text.retry}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** 有上报时的原始快照表（隧道 / 出口池 / 上报时刻）。 */
function NodeRuntimeReport({ report }: { report: NodeStateReport }) {
  const { t, locale } = useI18n();
  const copy = runtimeFactsText(locale);
  return (
    <div className="flex flex-col gap-4" data-testid="runtime-report">
      <Table>
        <TableBody>
          <TableRow>
            <TableCell className="w-40 text-[var(--muted-foreground)]">{t("admin.runtimeVersion")}</TableCell>
            <TableCell className="font-mono text-xs">{report.version ?? "-"}</TableCell>
          </TableRow>
          {/*
            「Agent 自报角色」这一行必须读 `reported_role`；`role` 是**面板侧**认定
            （`node.role`），两者连大小写都可能不同（真机：`role: "ingress"` /
            `reported_role: "INGRESS"`）。这里曾经渲染 `report.role` 却挂着
            「Agent 自报角色」的标签 —— 生产是错的，而 mock 曾把落库行（两字段同值）
            直接回显，所以本地永远看不出来。
          */}
          <TableRow>
            <TableCell className="w-40 text-[var(--muted-foreground)]">{t("admin.runtimeReportedRole")}</TableCell>
            <TableCell className="font-mono text-xs" data-testid="runtime-reported-role">
              {report.reported_role ?? "-"}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="w-40 text-[var(--muted-foreground)]">{copy.panelRole}</TableCell>
            <TableCell className="font-mono text-xs" data-testid="runtime-panel-role">
              {report.role ?? "-"}
            </TableCell>
          </TableRow>
          {/*
            角色一致性：后端特意给出的 `role_mismatch`（两侧都非空才判、大小写归一比较）。
            三态分开说：确实不一致 / 两侧一致 / 无法判定（有一侧没值）——
            把第三种说成前两种都是编结论。
          */}
          <TableRow>
            <TableCell className="w-40 text-[var(--muted-foreground)]">{copy.roleAgreement}</TableCell>
            <TableCell className="text-xs" data-testid="runtime-role-agreement">
              {report.role_mismatch === true
                ? copy.roleMismatch
                : !report.role || !report.reported_role
                  ? copy.roleUnknown
                  : copy.roleAgreed}
            </TableCell>
          </TableRow>
          {/*
            快照新鲜度：`age_seconds` / `stale` 回答"这一格事实有多旧"，
            **不是**在线/离线判定（在线看 `online` / connection）。
            因此这里只出现"多久没更新"，不出现"离线/异常/正常"这类结论。
          */}
          <TableRow>
            <TableCell className="w-40 text-[var(--muted-foreground)]">{copy.freshness}</TableCell>
            <TableCell className="text-xs" data-testid="runtime-freshness">
              {typeof report.age_seconds === "number" ? copy.age(report.age_seconds) : copy.ageUnknown}
              {report.stale === true ? <span data-testid="runtime-stale"> · {copy.staleNote}</span> : null}
            </TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="text-[var(--muted-foreground)]">{t("admin.runtimeRevision")}</TableCell>
            <TableCell className="font-mono text-xs">{report.reported_revision ?? "-"}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="text-[var(--muted-foreground)]">{t("admin.runtimeReportedAt")}</TableCell>
            <TableCell className="text-xs">{formatDateTime(report.reported_at)}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="text-[var(--muted-foreground)]">{t("admin.runtimeUsedPorts")}</TableCell>
            <TableCell className="font-mono text-xs break-all">{formatPorts(report.used_ports)}</TableCell>
          </TableRow>
          <TableRow>
            <TableCell className="text-[var(--muted-foreground)]">{t("admin.runtimeEgressPools")}</TableCell>
            <TableCell className="font-mono text-xs break-all">{formatEgressPools(report)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-[var(--muted-foreground)]">
          {t("admin.runtimeTunnels")} ({report.tunnels?.length ?? 0})
        </span>
        {(report.tunnels ?? []).length === 0 ? (
          <p className="text-xs text-[var(--muted-foreground)]">{t("common.noData")}</p>
        ) : (
          <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableCell>ID</TableCell>
                  <TableCell>{t("tunnel.category")}</TableCell>
                  <TableCell>ingress</TableCell>
                  <TableCell>egress</TableCell>
                  <TableCell>revision</TableCell>
                  <TableCell>targets</TableCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(report.tunnels ?? []).map((tun) => (
                  <TableRow key={tun.id}>
                    <TableCell className="font-mono text-xs">{tun.id}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="muted">{tun.mode}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{tun.ingress_port ?? "-"}</TableCell>
                    <TableCell className="font-mono text-xs">{tun.egress_port ?? "-"}</TableCell>
                    <TableCell className="font-mono text-xs">{tun.revision ?? "-"}</TableCell>
                    <TableCell className="font-mono text-xs break-all">{(tun.targets ?? []).join(", ") || "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {report.last_error && (
        <div className="rounded-[var(--radius)] border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 p-3">
          <span className="text-xs font-medium text-[var(--destructive)]">{t("admin.runtimeLastError")}</span>
          <p className="mt-1 font-mono text-xs break-all">{report.last_error}</p>
        </div>
      )}
    </div>
  );
}

export interface NodeRuntimePanelProps {
  nodeId: number;
  /**
   * 运行态读数（三态）：有上报 / 200 无上报 / 取不到。
   *
   * **不再接受 `NodeStateReport | null`**：那个签名把「取不到」与「没有上报」
   * 折成同一个 `null`，正是本切片要消灭的降级形态。
   */
  state: NodeRuntimeState;
  /** 降级时的重试入口。服务端组件不能传函数，所以由客户端上层给（`router.refresh()`）。 */
  onRetry?: () => void;
}

/**
 * 运行态诊断面板（WP12 / WP7 Agent 状态上报 → node_state_report）。
 *
 * 两个口径写死：
 *   1. **reported_at 是面板收到上报的时刻（DB 侧时钟）**，不是 Agent 自述时间——
 *      离线/陈旧判定只用前者，避免被节点时钟漂移骗到；
 *   2. **Agent 自报角色仅供参考**：schema 注释明确「与 node.role 不一致时按
 *      node.role 为准」，所以这里只展示并在不一致时给出角标，不改任何东西。
 *
 * ── 三态显示（本切片的核心）──
 *   · `reported`       → 原始快照表；
 *   · `never_reported` → 「该节点尚未上报运行态」（200 的事实）；
 *   · `unavailable`    → 「暂时取不到运行态」+ 原因 + 可重试，**不出现**正向措辞。
 *   「取不到」与「没有上报」的 testid 与文案都不同，页面上不可能混淆。
 *
 * ── 与 WP6 健康面板的边界（V4-WP6 起）──
 * 本面板展示 `node_state_report` 的**原始快照**（隧道/出口池列表、上报时刻）。
 * 健康判定、版本/资源/runtime 计数摘要、可操作理由都由 WP6 的
 * `/admin/node/:id/health` 给出，由 `NodeHealthManager` 渲染。两者不重复判定：
 * 面板上「version」这一行的权威口径在健康卡里（Agent 版本 + 期望版本 + 升级建议）。
 */
export function NodeRuntimePanel({ nodeId, state, onRetry }: NodeRuntimePanelProps) {
  const { t, locale } = useI18n();
  void nodeId;

  return (
    <Card data-testid="node-runtime">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4" />
          {t("admin.runtime")}
          {API_MOCK && (
            <Badge variant="outline" title={t("admin.mockBadgeHint")} data-testid="runtime-mock-badge">
              {t("admin.mockBadge")}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {state.status === "reported" ? (
          <NodeRuntimeReport report={state.report} />
        ) : state.status === "never_reported" ? (
          // 200 + 无记录：这是契约事实（新节点还没上报），不是错误，也不是「取不到」。
          <p className="text-sm text-[var(--muted-foreground)]" data-testid="runtime-never-reported">
            {t("admin.runtimeEmpty")}
          </p>
        ) : (
          <NodeRuntimeUnavailable
            text={nodeRuntimeText(locale)}
            reason={state.reason}
            message={state.message}
            onRetry={onRetry}
          />
        )}
      </CardContent>
    </Card>
  );
}
