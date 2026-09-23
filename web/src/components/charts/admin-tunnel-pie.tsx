"use client";

import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

/** 与设计系统一致的分类色板（OKLCH token；暗色下同样可读） */
const PIE_COLORS = [
  "var(--chart-1, oklch(0.55 0.19 258))",
  "var(--chart-2, oklch(0.62 0.16 150))",
  "var(--chart-3, oklch(0.72 0.18 70))",
  "var(--chart-4, oklch(0.62 0.2 25))",
  "var(--chart-5, oklch(0.6 0.15 200))",
];

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  fontSize: 12,
} as const;

const LEGEND_STYLE = { fontSize: 12, color: "var(--muted-foreground)" } as const;

/**
 * 隧道类型分布饼图（recharts，纯客户端）。
 * 由 `admin/admin-charts.tsx` 通过 `next/dynamic(..., { ssr: false })` 隔离加载。
 */
export default function TunnelTypePie({ data }: { data: { type: string; count: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey="count"
          nameKey="type"
          outerRadius={80}
          paddingAngle={2}
          label={{ fontSize: 11, fill: "var(--muted-foreground)" }}
        >
          {data.map((_, i) => (
            <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="var(--card)" strokeWidth={1} />
          ))}
        </Pie>
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={LEGEND_STYLE} iconSize={10} />
      </PieChart>
    </ResponsiveContainer>
  );
}
