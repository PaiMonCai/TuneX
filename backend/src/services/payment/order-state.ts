/**
 * topup_order 状态机 —— 纯函数实现（零 DB / 零框架依赖，可离线全路径测试）
 * 依据: relayx-pay-channel-analysis-report.md §6-§7 + RelayX-最终交叉验证汇总报告.md §问题 13/14/15
 *
 * 持久化状态（Prisma enum TopupOrderStatus）：pending | success | cancelled
 *
 * 逻辑态映射（任务书的 pending→paid→completed 在原版 schema 中无中间态，
 * 故 `success` 同时代表「网关已确认收款(paid)」与「余额已入账(completed)」，
 * 二者由 `balance_log` 的存在性与 `topup_order.balance` 变化共同佐证）：
 *
 *   pending ──(网关回调成功 + 金额校验通过)──▶ success
 *   pending ──(10min 超时 / 用户取消)───────▶ cancelled
 *
 * 合法迁移矩阵：
 *   pending   → success    ✅ 正常入账
 *   pending   → cancelled  ✅ 超时/主动取消
 *   pending   → pending    ✅ 幂等（重复处理）
 *   success   → success    ✅ 幂等（重复回调，**不得重复入账**）
 *   cancelled → cancelled  ✅ 幂等
 *   cancelled → success    ⚠️ 原版允许（用户已付款但订单被自动取消）
 *                             W5 默认保留（收到真金白银应入账），但强制记录 WARN；
 *                             `strictCancelled` 选项可改为拒绝
 *   success   → cancelled  ❌ 非法（已入账不可取消，需人工冲正）
 *   cancelled → pending    ❌ 非法（订单不可复活）
 */

/** 持久化状态（对齐 Prisma TopupOrderStatus） */
export type TopupState = "pending" | "success" | "cancelled";

/** 迁移动作（触发方） */
export type TopupAction =
  | "callback_paid" // 网关回调成功（已验签+金额校验）
  | "timeout_cancel" // 10 分钟未支付自动取消
  | "user_cancel" // 用户主动取消
  | "admin_mark_paid"; // 管理员手动标记已付

/** 迁移判定结果 */
export interface TransitionResult {
  /** 是否允许执行 */
  allowed: boolean;
  /** 目标状态 */
  next: TopupState;
  /** 是否为幂等（状态不变） */
  idempotent: boolean;
  /** 是否需要实际入账（余额变动） */
  shouldCredit: boolean;
  /** 拒绝原因 */
  reason?: string;
  /** 需要告警的「可疑但放行」路径 */
  warn?: string;
}

/** 动作 → 目标状态 */
export const ACTION_TARGET: Record<TopupAction, TopupState> = {
  callback_paid: "success",
  admin_mark_paid: "success",
  timeout_cancel: "cancelled",
  user_cancel: "cancelled",
};

/** 非法迁移表（from→to） */
const FORBIDDEN: Array<[TopupState, TopupState]> = [
  ["success", "cancelled"],
  ["cancelled", "pending"],
  ["success", "pending"],
];

export interface TransitionOptions {
  /**
   * 严格模式：`cancelled → success` 拒绝（默认 false，保留原版宽松语义）。
   * 生产建议按业务口径决定；默认 false 的理由见文件头注释。
   */
  strictCancelled?: boolean;
}

/**
 * 判定一次状态迁移是否允许。
 * 纯函数：无副作用、无 IO，便于全路径枚举测试。
 */
export function evaluateTransition(
  from: TopupState,
  action: TopupAction,
  opts: TransitionOptions = {},
): TransitionResult {
  const to = ACTION_TARGET[action];

  if (FORBIDDEN.some(([f, t]) => f === from && t === to)) {
    return {
      allowed: false,
      next: from,
      idempotent: false,
      shouldCredit: false,
      reason: `illegal transition ${from} → ${to} (action=${action})`,
    };
  }

  if (from === to) {
    return {
      allowed: true,
      next: to,
      idempotent: true,
      shouldCredit: false,
      reason: "already in target state",
    };
  }

  // cancelled → success：原版允许；W5 可收紧
  if (from === "cancelled" && to === "success") {
    if (opts.strictCancelled) {
      return {
        allowed: false,
        next: from,
        idempotent: false,
        shouldCredit: false,
        reason: "order already cancelled (strictCancelled=true)",
      };
    }
    return {
      allowed: true,
      next: to,
      idempotent: false,
      shouldCredit: true,
      warn: "recovering cancelled order: gateway confirmed payment after auto-cancel",
    };
  }

  // pending → success / cancelled
  return { allowed: true, next: to, idempotent: false, shouldCredit: to === "success" };
}

/** 全状态 × 全动作矩阵（供测试与文档使用） */
export function transitionMatrix(opts: TransitionOptions = {}) {
  const states: TopupState[] = ["pending", "success", "cancelled"];
  const actions: TopupAction[] = ["callback_paid", "timeout_cancel", "user_cancel", "admin_mark_paid"];
  return states.flatMap((from) => actions.map((action) => ({ from, action, ...evaluateTransition(from, action, opts) })));
}
