"use client";

import dynamic from "next/dynamic";
import { useI18nOptional } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";

/** 图表可访问名称跟随语言；没有 Provider 时回落到产品默认语言词典（名称永不为空）。 */
function useChartLabel(key: "revenueChartLabel" | "tunnelTypeChartLabel"): string {
  const i18n = useI18nOptional();
  return i18n?.t(`admin.${key}`) ?? getDictionary("zh").admin[key];
}

/**
 * 管理后台图表入口（客户端组件）。
 *
 * recharts 必须在浏览器里运行，这里统一用 `next/dynamic(..., { ssr: false })`
 * 隔离：SSR 只输出骨架，避免 recharts 在服务端渲染时报错。
 * 对外仍导出 `RevenueAreaChart` / `TunnelTypePieChart` 两个具名组件，
 * 供 `app/admin/page.tsx` 等既有页面直接使用（保持导入路径不变）。
 */
const RevenueArea = dynamic(() => import("@/components/charts/admin-revenue-area"), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

const TunnelTypePie = dynamic(() => import("@/components/charts/admin-tunnel-pie"), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

export function RevenueAreaChart({ data }: { data: { date: string; amount: number }[] }) {
  const label = useChartLabel("revenueChartLabel");
  return (
    <div className="h-64 w-full" data-testid="revenue-chart" role="img" aria-label={label}>
      <RevenueArea data={data} />
    </div>
  );
}

export function TunnelTypePieChart({ data }: { data: { type: string; count: number }[] }) {
  const label = useChartLabel("tunnelTypeChartLabel");
  return (
    <div className="h-64 w-full" data-testid="tunnel-types-chart" role="img" aria-label={label}>
      <TunnelTypePie data={data} />
    </div>
  );
}

function ChartSkeleton() {
  return <div data-chart-loading="true" className="h-full w-full animate-pulse rounded-md bg-[var(--muted)]" />;
}
