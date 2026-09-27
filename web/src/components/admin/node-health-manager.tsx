"use client";

/**
 * V4-WP6 §13.4.4 —— 节点健康取数（客户端）。
 *
 * 与 `node-runtime-panel` 的分工：
 *   · 本组件只负责**取数**（GET /api/admin/node/:id/health）与刷新；
 *   · `NodeHealthPanel` 只负责渲染，不做请求。
 *
 * 失败时**保留上一份视图**只提示错误：健康接口挂掉不该把已经拿到的
 * reasons/telemetry 一并抹成空态——那会让「接口故障」看起来像「节点没问题」。
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/components/providers";
import { nodeHealthText } from "@/lib/node-health-i18n";
import { NodeHealthPanel } from "@/components/admin/node-health-panel";
import type { ID, NodeHealthView } from "@/lib/types";

export function NodeHealthManager({ nodeId, initial = null }: { nodeId: ID; initial?: NodeHealthView | null }) {
  const { locale } = useI18n();
  const txt = nodeHealthText(locale);
  const [view, setView] = useState<NodeHealthView | null>(initial);
  const [loading, setLoading] = useState(initial === null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.admin.nodeHealth(nodeId);
      setView(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : txt.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [nodeId, txt.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  return <NodeHealthPanel view={view} loading={loading} error={error} onRefresh={() => void load()} />;
}
