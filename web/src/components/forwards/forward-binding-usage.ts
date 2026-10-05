/**
 * Binding usage 的前端投影（薄适配层，**不重新统计**）。
 *
 * 使用量是后端契约（`backend/src/services/binding-usage.ts` 的响应投影，由
 * `GET|POST /api/nodes/:id/bindings` 下发）：
 *
 *     { used_by_forward_count: number, unbind_blocked: boolean }
 *
 * 口径（后端唯一实现，前端**不得**重算）：workspace 内 `category = port_forward`、
 * `tunnel_mode = relay`、ingress/egress 全等的转发条数；**不按运行状态过滤**，
 * 所以 suspended / error 的中继同样占用绑定。
 * `DELETE /api/nodes/:ingressId/bindings/:egressId` 用同一判定：>0 → 409
 * `code: "binding_in_use"` + `used_by_forward_count`。
 *
 * 为什么不在前端重算：列表里的「可解绑」必须与解绑闸门是同一条规则。前端各自
 * 前端重新统计会与后端解绑闸门漂移，造成“看起来可解绑、实际被 409 拒绝”的假象。
 * 要消灭的那类体验。需要改口径时改后端那一份。
 *
 * 本模块只做两件事：把契约字段折算成 UI 两态（可解绑 / 使用中），并把「字段缺失」
 * 归一成 0（旧缓存或手写 fixture 不会渲染出 NaN）。
 */
import type { NodeBinding } from "@/lib/types";

/** 绑定使用量在 UI 侧的两态。 */
export type BindingUsageState = "in-use" | "deletable";

export type BindingUsageView = {
  used_by_forward_count: number;
  /** 与后端 `unbind_blocked` 同判定：true = 解绑会被 409 挡回。 */
  blocked: boolean;
  state: BindingUsageState;
};

/**
 * 使用量归一：缺失 / 非有限 / 负数一律按 0 处理。
 *
 * 与后端 `bindingUsage()` 的负值防御一致 —— 免得 UI 出现「显示 -3 条转发但标记为
 * 可解绑」这种自相矛盾的行。
 */
export function bindingUsageCount(
  binding: Pick<NodeBinding, "used_by_forward_count">,
): number {
  const raw = Number(binding.used_by_forward_count);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * 契约字段 → UI 两态。
 *
 * `blocked` 优先取后端下发的 `unbind_blocked`（唯一判定点）；字段缺失时按
 * `count > 0` 兜底，与后端判定等价。
 */
export function bindingUsageView(
  binding: Pick<NodeBinding, "used_by_forward_count" | "unbind_blocked">,
): BindingUsageView {
  const count = bindingUsageCount(binding);
  const blocked = typeof binding.unbind_blocked === "boolean" ? binding.unbind_blocked : count > 0;
  return {
    used_by_forward_count: count,
    blocked,
    state: blocked ? "in-use" : "deletable",
  };
}

/** 两态判定（供列表渲染直接取用）。 */
export function bindingUsageState(view: BindingUsageView): BindingUsageState {
  return view.state;
}

/**
 * 使用量文案需要渲染吗？
 *
 * 使用量为 0 且有明确契约字段时，UI 显示「未被任何转发使用」—— 这是有效信息
 * （用户知道可以安全解绑）。只有**字段整体缺失**（旧后端 / 手写 fixture）才
 * 不渲染，避免画出假的 0。
 */
export function hasBindingUsage(
  binding: Partial<Pick<NodeBinding, "used_by_forward_count" | "unbind_blocked">>,
): boolean {
  return (
    typeof binding.used_by_forward_count === "number" ||
    typeof binding.unbind_blocked === "boolean"
  );
}
