"use client";

/**
 * V5.2 §7 —— 目标健康**状态徽标**：五态的唯一渲染实现。
 *
 * 为什么单独一个组件、并且和 `lib/target-health.ts` 配对（与 V5.1a 的
 * `forward-protocol-badge.tsx` 同一模式）：状态会在池列表、目标行、逐观测者行、
 * 汇总提示等多个地方出现。每处各写一段 `state === "healthy" ? green : grey`，
 * 早晚会有人漏掉 `unknown`，于是「没有证据」被画成健康——而 §7 把这件事列为
 * 这一节最危险的错误方向。这里只有一条规则：
 *
 *   · 变体/附加 class 由 `targetHealthBadgeVariant` / `targetHealthBadgeClass`
 *     这两个**穷尽 switch** 决定（契约加第六个状态 = 编译期红）；
 *   · 文案由 `TARGET_HEALTH_STATE_TEXT` 提供，`unknown` 的标签是「无观测证据」，
 *     永远不可能读成「健康」；
 *   · `title` 给出契约定义，让运维不必回文档就能理解这个状态意味着什么。
 */
import { Badge } from "@/components/ui/card";
import { useI18n } from "@/components/providers";
import {
  targetHealthBadgeClass,
  targetHealthBadgeVariant,
  targetHealthStateHint,
  targetHealthStateLabel,
  type TargetHealthState,
} from "@/lib/target-health";

export function TargetHealthBadge({
  state,
  className,
}: {
  state: TargetHealthState;
  className?: string;
}) {
  const { t, locale } = useI18n();
  const label = targetHealthStateLabel(state, locale);
  const hint = targetHealthStateHint(state, locale);
  return (
    <Badge
      variant={targetHealthBadgeVariant(state)}
      className={[targetHealthBadgeClass(state), className].filter(Boolean).join(" ")}
      data-target-health={state}
      // 结论是机器给的，定义必须随手可查：title 里带的是**契约定义**，不是口号。
      title={`${label} — ${hint}`}
      aria-label={`${t("admin.targetHealth.stateLabel")}: ${label}`}
    >
      {label}
    </Badge>
  );
}
