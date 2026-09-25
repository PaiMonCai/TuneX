"use client";

import { Activity } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, API_MOCK } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { formatDateTime } from "@/lib/utils";
import type { NodeStateReport } from "@/lib/types";

function formatPorts(ports: number[] | null | undefined): string {
  if (!ports || ports.length === 0) return "-";
  const sorted = [...ports].sort((a, b) => a - b);
  return sorted.join(", ");
}

function formatEgressPools(report: NodeStateReport): string {
  const pools = report.egress_pools;
  if (!pools || Object.keys(pools).length === 0) return "-";
  return Object.entries(pools)
    .map(([tunnelId, p]) => `#${tunnelId}: ${p.strategy} → ${(p.targets ?? []).join(", ")}`)
    .join("；");
}

/**
 * 运行态诊断面板（WP12 / WP7 Agent 状态上报 → node_state_report）。
 *
 * 两个口径写死：
 *   1. **reported_at 是面板收到上报的时刻（DB 侧时钟）**，不是 Agent 自述时间——
 *      离线/陈旧判定只用前者，避免被节点时钟漂移骗到；
 *   2. **Agent 自报角色仅供参考**：schema 注释明确「与 node.role 不一致时按
 *      node.role 为准」，所以这里只展示并在不一致时给出角标，不改任何东西。
 */
export function NodeRuntimePanel({ nodeId, report }: { nodeId: number; report: NodeStateReport | null }) {
  const { t } = useI18n();
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
        <CardDescription>{t("admin.runtimeEmpty")}</CardDescription>
      </CardHeader>
      <CardContent>
        {!report ? (
          <p className="text-sm text-[var(--muted-foreground)]">{t("admin.runtimeEmpty")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <Table>
              <TableBody>
                <TableRow>
                  <TableCell className="w-40 text-[var(--muted-foreground)]">{t("admin.runtimeVersion")}</TableCell>
                  <TableCell className="font-mono text-xs">{report.version ?? "-"}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-[var(--muted-foreground)]">{t("admin.runtimeReportedRole")}</TableCell>
                  <TableCell className="font-mono text-xs">{report.role ?? "-"}</TableCell>
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
        )}
      </CardContent>
    </Card>
  );
}

/** 供服务端 loader 使用：取运行态快照，失败回落 null（无上报是常态，不是错误） */
export async function loadNodeState(nodeId: number, cookie: string): Promise<NodeStateReport | null> {
  try {
    return await api.admin.nodeState(nodeId, cookie);
  } catch {
    return null;
  }
}
