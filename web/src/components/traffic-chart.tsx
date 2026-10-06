"use client";

import dynamic from "next/dynamic";
import { useI18nOptional } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import type { TrafficPoint } from "@/lib/types";

/**
 * 流量趋势图入口。
 *
 * recharts 是「纯客户端」库（依赖 DOM 尺寸测量），因此这里用
 * `next/dynamic(..., { ssr: false })` 把它隔离在客户端 bundle 中：
 * 服务端渲染只输出骨架屏，图表在浏览器里挂载后才绘制，
 * 从根本上避免 recharts 在 SSR / hydration 阶段报错。
 *
 * 注意：`ssr: false` 只能出现在客户端组件里（Next 16 约束），故本文件为 "use client"。
 */
const TrafficArea = dynamic(() => import("@/components/charts/traffic-area"), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

export function TrafficChart({ data }: { data: TrafficPoint[] }) {
  // recharts 的画布对屏幕阅读器不可见，这个 `aria-label` 就是图表唯一的可访问名称：
  // 它必须跟随当前语言（旧实现写死英文 "traffic trend"，中文界面下读出来是英文）。
  // 用 optional hook + 词典回落，保证在 Provider 之外渲染时也不会抛错、且名称非空。
  const i18n = useI18nOptional();
  const label = i18n?.t("dashboard.trafficChartLabel") ?? getDictionary("zh").dashboard.trafficChartLabel;
  return (
    <div className="h-64 w-full" data-testid="traffic-chart" role="img" aria-label={label}>
      <TrafficArea data={data} />
    </div>
  );
}

function ChartSkeleton() {
  return <div className="h-full w-full animate-pulse rounded-md bg-[var(--muted)]" />;
}
