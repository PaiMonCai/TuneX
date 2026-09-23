"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMoney } from "@/lib/utils";

const AXIS_TICK = { fontSize: 11, fill: "var(--muted-foreground)" } as const;

const TOOLTIP_STYLE = {
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  fontSize: 12,
} as const;

/**
 * 收入趋势面积图（recharts，纯客户端）。
 * 由 `admin/admin-charts.tsx` 通过 `next/dynamic(..., { ssr: false })` 隔离加载。
 */
export default function RevenueArea({ data }: { data: { date: string; amount: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <defs>
          <linearGradient id="rv" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--chart-1, oklch(0.55 0.19 258))" stopOpacity={0.4} />
            <stop offset="95%" stopColor="var(--chart-1, oklch(0.55 0.19 258))" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="date"
          tick={AXIS_TICK}
          tickFormatter={(v: string) => String(v).slice(5)}
          tickLine={false}
          axisLine={false}
          minTickGap={12}
        />
        <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={52} />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter={(v: any) => [formatMoney(Number(v)), "revenue"] as any}
        />
        <Area
          type="monotone"
          dataKey="amount"
          stroke="var(--chart-1, oklch(0.55 0.19 258))"
          fill="url(#rv)"
          strokeWidth={2}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
