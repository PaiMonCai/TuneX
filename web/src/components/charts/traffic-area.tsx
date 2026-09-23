"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrafficPoint } from "@/lib/types";
import { formatBytes } from "@/lib/utils";

const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" } as const;

const TOOLTIP_STYLE = {
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  fontSize: 12,
} as const;

/**
 * 流量趋势面积图（recharts）。
 *
 * 该模块只允许在**客户端**加载：recharts 依赖 DOM 尺寸测量，
 * 由 `traffic-chart.tsx` 里的 `next/dynamic(..., { ssr: false })` 隔离，
 * 服务端渲染时只输出骨架屏，避免 SSR/hydration 问题。
 *
 * 颜色统一取 CSS 变量（OKLCH token），因此亮/暗色自动跟随。
 */
export default function TrafficArea({ data }: { data: TrafficPoint[] }) {
  const chartData = data.map((p) => ({
    date: p.date.slice(5),
    traffic: p.traffic,
  }));

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="trafficFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1, oklch(0.55 0.19 258))" stopOpacity={0.45} />
            <stop offset="100%" stopColor="var(--chart-1, oklch(0.55 0.19 258))" stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey="date" tick={AXIS_TICK} tickLine={false} axisLine={false} />
        <YAxis
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v: number) => `${Math.round(Number(v) / 1073741824)}G`}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter={(value: any) => [formatBytes(Number(value)), "traffic"] as any}
        />
        <Area
          type="monotone"
          dataKey="traffic"
          stroke="var(--chart-1, oklch(0.55 0.19 258))"
          strokeWidth={2}
          fill="url(#trafficFill)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
