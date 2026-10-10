import { Activity, ArrowRightLeft, CircleAlert, Waves } from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { formatBytes } from "@/lib/utils";
import type { ForwardSummary } from "@/lib/types";

export function ForwardSummaryCards({ summary, loading, t }: {
  summary: ForwardSummary | null; loading: boolean; t: (key: string) => string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 xl:grid-cols-4" aria-busy={loading && !summary}>
      <StatCard title={t("forward.monitorTotal")} icon={ArrowRightLeft} value={summary ? String(summary.total) : "—"}
        hint={summary ? `${t("forward.direct")} ${summary.direct} · ${t("forward.relay")} ${summary.relay}` : undefined} />
      <StatCard title={t("forward.monitorActive")} icon={Activity} value={summary ? String(summary.active) : "—"}
        hint={summary ? `${t("forward.statusPending")} ${summary.pending} · ${t("forward.statusSuspended")} ${summary.suspended}` : undefined} />
      <StatCard title={t("forward.monitorAttention")} icon={CircleAlert} value={summary ? String(summary.error) : "—"}
        hint={t("forward.monitorAttentionHint")} />
      <StatCard title={t("forward.monitorTraffic")} icon={Waves} value={summary ? formatBytes(summary.traffic) : "—"}
        hint={t("forward.monitorTrafficHint")} />
    </div>
  );
}
