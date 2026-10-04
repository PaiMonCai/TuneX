import { forwardProductStatus } from "@/lib/forward-status";
import { nodeConnectionValue, type StatusBadge } from "@/lib/node-status";
import type { Locale } from "@/lib/i18n";
import type { PortForward, UserNode } from "@/lib/types";

/**
 * Console 用户可见状态词表（V5-WP13.5A §9.4.7）。
 *
 * ~~~text
 * desired    已保存，尚未下发（控制面已生成期望状态）
 * applying   正在下发 / 等待 Agent ACK
 * running    运行的就是已保存的那一版
 * available  （线路/节点）现在可用、可接新业务
 * degraded   （线路/节点）仍在使用中但已降级：维护中、掉线、用户主动暂停
 * failed     下发失败 —— 上一版可能仍在跑，属于**可行动**错误
 * ~~~
 *
 * 两条纪律：
 *
 * 1. **这不是第二个状态机。** 本模块只做「既有投影 → 词表」的映射，判定权仍在后端：
 *    - Forward 走 `forwardProductStatus()`（`lib/forward-status.ts`：synced / pending /
 *      error / suspended，唯一实现），本模块只把它摊成四级；
 *    - Node 走 `nodeConnectionValue()` 与后端已投影的 `accepts_new_business`
 *      （`lib/node-status.ts`），**不**读心跳、**不**算 90s 窗口、**不**推导结论。
 *    因此这里不出现 `applied_revision` / `last_seen_at` / `config_revision` 之类的原始字段。
 *
 * 2. **不把所有异常压成一个 ERROR**（§9.4.7 明确要求）：`error` → `failed`，
 *    `suspended` → `degraded`，掉线节点 → `degraded`，维护中（在线但不接新业务）→ `degraded`。
 *    只有控制面明确写入失败原因的才叫 `failed`；`failed` 一律带可行动文案（见 `lib/forward-status.ts`
 *    `applyErrorAction`），不给用户看裸码。
 *
 * 普通用户只看到这一层（线路是否可用、延迟、流量、套餐、可行动错误）；
 * revision / lease epoch / Agent ACK 等内部字段属于 Admin Console（§9.4.1 要求 4）。
 */

/** 用户可见状态六态（§9.4.7） */
export type ConsoleStatusKey = "desired" | "applying" | "running" | "available" | "degraded" | "failed";

/** 六态全集（测试与 UI 遍历用；顺序即「从未落地到失败」的直觉顺序） */
export const CONSOLE_STATUS_KEYS: readonly ConsoleStatusKey[] = [
  "desired",
  "applying",
  "running",
  "available",
  "degraded",
  "failed",
];

interface ConsoleStatusText {
  zh: string;
  en: string;
  /** 复用既有徽章 variant 集合，不新造视觉 token */
  variant: StatusBadge["variant"];
}

const STATUS_TEXT: Record<ConsoleStatusKey, ConsoleStatusText> = {
  desired: { zh: "待应用", en: "Desired", variant: "outline" },
  applying: { zh: "下发中", en: "Applying", variant: "secondary" },
  running: { zh: "运行中", en: "Running", variant: "success" },
  available: { zh: "可用", en: "Available", variant: "success" },
  degraded: { zh: "降级", en: "Degraded", variant: "muted" },
  failed: { zh: "失败", en: "Failed", variant: "destructive" },
};

/** 词表取词（`zh` 之外的语言回落英文；词典未收录新 key 前不引入半截文案） */
export function consoleStatusText(locale: Locale, key: ConsoleStatusKey): string {
  const t = STATUS_TEXT[key];
  return locale === "en" ? t.en : t.zh;
}

/** 徽章 variant（与既有 Badge 组件同集合） */
export function consoleStatusVariant(key: ConsoleStatusKey): StatusBadge["variant"] {
  return STATUS_TEXT[key].variant;
}

/** 可渲染描述（key 稳定，供测试与埋点；label 随 locale） */
export function consoleStatusBadge(locale: Locale, key: ConsoleStatusKey): StatusBadge {
  return { key: `console:${key}`, label: consoleStatusText(locale, key), variant: consoleStatusVariant(key) };
}

/**
 * Forward 的用户可见状态。
 *
 * `pending` 这一档再区分「尚未下发（desired）」与「下发中（applying）」：
 * 依据是后端 `apply_status` 自身枚举的语义（`types.ts`：`pending` = 已生成期望状态尚未下发，
 * `applying` = 已下发等待 ACK），不是前端推导。
 */
export function consoleStatusForForward(
  forward: Pick<PortForward, "apply_status" | "config_revision" | "applied_revision" | "latest_revision"> | null | undefined,
): ConsoleStatusKey {
  // 没有数据 = 还没有任何运行态事实，显示「待应用」，绝不显示「失败」
  if (!forward) return "desired";
  const state = forwardProductStatus(forward).state;
  if (state === "error") return "failed";
  if (state === "suspended") return "degraded";
  if (state === "synced") return "running";
  return forward.apply_status === "applying" ? "applying" : "desired";
}

/**
 * Node 的用户可见状态。
 *
 * - `waiting`（后端未给连接事实，含尚未完成安装）→ `desired`；
 * - `online` 且后端结论是可接新业务 → `available`；在线但不接新业务（维护/停新）→ `degraded`；
 * - `offline` → `degraded`：掉线是**可用性下降**，不是 failed（已有转发可能仍在跑，且用户能做的是排查/恢复）。
 *
 * Node 侧没有独立的 `failed`：真正的失败经 Forward 下发结果与诊断入口呈现，
 * 避免把「离线」说成「失败」而让用户去做无用的重试。
 */
export function consoleStatusForNode(node: UserNode | null | undefined): ConsoleStatusKey {
  switch (nodeConnectionValue(node)) {
    case "online":
      return node?.accepts_new_business === false ? "degraded" : "available";
    case "offline":
      return "degraded";
    default:
      return "desired";
  }
}

/** 线路（Route Profile）可用性在用户侧的呈现：只回答「现在能不能选」。 */
export function consoleStatusForRouteAvailability(input: {
  enabled?: boolean | null;
  availableNodes?: number | null;
  degraded?: boolean | null;
}): ConsoleStatusKey {
  if (input.enabled === false) return "desired";
  if ((input.availableNodes ?? 0) <= 0) return "degraded";
  if (input.degraded) return "degraded";
  return "available";
}
