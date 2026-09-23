"use client";

import dynamic from "next/dynamic";
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
  return (
    <div className="h-64 w-full" data-testid="traffic-chart" role="img" aria-label="traffic trend">
      <TrafficArea data={data} />
    </div>
  );
}

function ChartSkeleton() {
  return <div className="h-full w-full animate-pulse rounded-md bg-[var(--muted)]" />;
}
