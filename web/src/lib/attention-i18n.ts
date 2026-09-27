/**
 * V4-WP8 §13.7 Wave 4 —— Dashboard 待办面板的文案（`Locale` → 文本）。
 *
 * 与 WP6 / WP7 同一惯例：**单独一张表**，不落 `i18n.ts` 大字典 —— 大字典是
 * 多人并行改的热点，往里塞新段必然冲突。
 *
 * 理由**标题**不在这里：本模块只提供面板骨架文案，具体理由的标题与下一步
 * 一律走既有表（`reasonTitle` WP6 / `conditionTitle` WP7 / 本 WP 的
 * `applyErrorAction`），避免同一件事在两处有不同说法。
 */
import type { Locale } from "./i18n";
import type { AttentionKind, AttentionSeverity } from "./types";

export interface AttentionText {
  title: string;
  /** 面板副标题：说明这里出现的是什么。 */
  subtitle: string;
  /** 正常态：没有待办。 */
  allClear: string;
  /** 降级态：取不到待办（**不是**「一切正常」）。 */
  degraded: string;
  /** 分组标题。 */
  nodeGroup: string;
  forwardGroup: string;
  /** 严重度标签（列表上按需显示）。 */
  severityError: string;
  severityWarning: string;
  severityInfo: string;
  /** 动作按钮。 */
  retry: string;
  openNode: string;
  openForward: string;
  /** 条目计数后缀：`共 N 项`。 */
  totalItems: string;
  /**
   * Forward 未收敛时的解释（不给数字，产品语言）。
   *
   * `runtime_revision_behind`（已运行但落后）与 `forward_pending_apply`
   * （正在下发）共用一句：用户要做的事相同（等），差别只是进度阶段。
   */
  waitingDelivery: string;
  /** 失败但不可自愈时的指引。 */
  needsOperator: string;
  /**
   * 失败原因未知（后端给了码但前端没有词条 / 该行没有码）时的唯一诚实动作：
   * 打开详情看 `apply_error` 原文。不猜原因，也不假装有建议。
   */
  openDetail: string;
}

const zh: AttentionText = {
  title: "需要处理",
  subtitle: "离线、等待安装、管理态与下发失败的节点和转发。",
  allClear: "没有需要处理的节点或转发。",
  degraded: "暂时取不到待办清单。这不代表没有问题，请稍后刷新。",
  nodeGroup: "节点",
  forwardGroup: "转发",
  severityError: "故障",
  severityWarning: "需关注",
  severityInfo: "提示",
  retry: "重试",
  openNode: "查看节点",
  openForward: "查看转发",
  totalItems: "共 {count} 项",
  waitingDelivery: "等待控制面下发完成；长时间不变再重试。",
  needsOperator: "该问题需要管理员处理，重试不会自行恢复。",
  openDetail: "打开这条转发查看失败详情（详情里有可执行的下一步）。",
};

const en: AttentionText = {
  title: "Needs attention",
  subtitle: "Nodes and forwards that are offline, waiting to be installed, under a management state, or failing to apply.",
  allClear: "Nothing needs your attention right now.",
  degraded: "Could not load the attention list. This does not mean everything is fine — refresh in a moment.",
  nodeGroup: "Nodes",
  forwardGroup: "Forwards",
  severityError: "Failed",
  severityWarning: "Needs attention",
  severityInfo: "Notice",
  retry: "Retry",
  openNode: "View node",
  openForward: "View forward",
  totalItems: "{count} items",
  waitingDelivery: "Waiting for the control plane to finish rolling out; retry if it does not change.",
  needsOperator: "An administrator has to fix this; retrying will not recover it.",
  openDetail: "Open this forward to see the failure details — the detail page carries the next step.",
};

export function attentionText(locale: Locale): AttentionText {
  return locale === "en" ? en : zh;
}

/** 分组标题取词。 */
export function attentionGroupLabel(locale: Locale, kind: AttentionKind): string {
  const txt = attentionText(locale);
  return kind === "node" ? txt.nodeGroup : txt.forwardGroup;
}

/** 严重度标签取词。 */
export function attentionSeverityLabel(locale: Locale, severity: AttentionSeverity): string {
  const txt = attentionText(locale);
  if (severity === "error") return txt.severityError;
  if (severity === "warning") return txt.severityWarning;
  return txt.severityInfo;
}

/** 严重度 → Badge 变体（与 health 徽章同一套配色方向）。 */
export function attentionSeverityVariant(
  severity: AttentionSeverity,
): "destructive" | "secondary" | "outline" {
  if (severity === "error") return "destructive";
  if (severity === "warning") return "secondary";
  return "outline";
}

/** 导出供测试做中英键集一致性断言。 */
export const ATTENTION_DICTS = { zh, en } as const;
