"use client";

import { formatDate } from "@/lib/utils";
import type { DashboardStats } from "@/lib/types";

/**
 * V5-WP20-5 —— 到期 / 宽限的**可观测提示**（仪表盘用）。
 *
 * ── 为什么单独一个组件 ──
 * `DashboardBody` 是 async 服务端组件（自己取 cookies 与 api），无法在静态渲染测试里跑；
 * 而「用户到底看不看得到这句话」恰恰是这一半交付物唯一值得断言的东西。把它抽成纯展示组件，
 * 就能用 `renderToStaticMarkup` 直接钉住（同 `attention-panel.tsx` 的拆法）。
 *
 * ── 两条语义 ──
 *   1. **文案来自后端**（`expiry.deny_message` = `capability-policy#describeDeny` 的输出）：
 *      前端一个字都不自己拼。反例：前端抄一份「策略已到期」，后端改词后就变成两处口径，
 *      而用户看到的永远是旧那句。
 *   2. **宽限期内不拦任何操作**（F3 的语义就是「仍放行」），这里只提示 + 给宽限截止点；
 *      真正 fail-closed 的表现是后端对**新动作**的拒绝，不是这个卡片。
 */
export function PlanExpiryNotice({
  expiry,
  expiresLabel,
}: {
  expiry: DashboardStats["expiry"];
  /** 「到期时间」的本地化标签（由调用方给，避免本组件依赖 i18n 上下文）。 */
  expiresLabel: string;
}) {
  if (!expiry) return null;
  if (!expiry.in_grace && !expiry.deny_scope) return null;
  return (
    <div
      className="rounded-md border border-[var(--border)] bg-[var(--muted)]/40 px-3 py-2 text-xs text-[var(--muted-foreground)]"
      data-testid="plan-expiry-notice"
    >
      <div className="font-medium text-[var(--foreground)]">{expiry.deny_message ?? ""}</div>
      {expiry.in_grace && expiry.grace_expires_at ? (
        <div>
          {expiresLabel}: {formatDate(expiry.grace_expires_at)}
        </div>
      ) : null}
    </div>
  );
}
