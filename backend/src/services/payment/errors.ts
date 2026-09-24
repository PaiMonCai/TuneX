/**
 * 支付模块结构化错误
 *
 * 原版缺陷：验签失败抛裸 `Error`，被 app.ts 的 onError 当作 500 处理并上报 sentry，
 * 恶意伪造回调可制造日志/告警噪音。本实现改为结构化错误，路由层据此返回明确状态码，
 * 且不触发 5xx 告警。
 */

/** 支付错误基类 */
export class PaymentError extends Error {
  /** 建议的 HTTP 状态码（0 = 由调用方决定） */
  readonly httpStatus: number;
  readonly code: string;
  /** 是否应由调用方静默处理（不告警） */
  readonly silent: boolean;

  constructor(message: string, opts: { httpStatus?: number; code?: string; silent?: boolean } = {}) {
    super(message);
    this.name = new.target.name;
    this.httpStatus = opts.httpStatus ?? 500;
    this.code = opts.code ?? "PAYMENT_ERROR";
    this.silent = opts.silent ?? false;
  }
}

/** 回调验签失败（伪造/篡改） */
export class SignatureError extends PaymentError {
  constructor(message = "Invalid callback signature") {
    super(message, { httpStatus: 400, code: "PAY_SIGNATURE_INVALID", silent: true });
  }
}

/** 回调金额与订单应付金额不一致（已修复的原版缺陷） */
export class AmountMismatchError extends PaymentError {
  readonly expected: number;
  readonly actual: number;
  readonly orderId: string;

  constructor(orderId: string, expected: number, actual: number, detail = "") {
    super(
      `Callback amount mismatch for order ${orderId}: expected ${expected}, got ${actual}${detail ? ` (${detail})` : ""}`,
      { httpStatus: 400, code: "PAY_AMOUNT_MISMATCH", silent: false },
    );
    this.orderId = orderId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** 回调交易状态非成功 */
export class TradeStatusError extends PaymentError {
  constructor(message = "Trade status is not success") {
    super(message, { httpStatus: 400, code: "PAY_TRADE_STATUS", silent: true });
  }
}

/** 订单不存在 */
export class OrderNotFoundError extends PaymentError {
  constructor(message = "充值订单不存在") {
    super(message, { httpStatus: 404, code: "PAY_ORDER_NOT_FOUND", silent: true });
  }
}

/** 订单状态不允许当前操作（如非 pending 取消、已成功重复入账等） */
export class OrderStateError extends PaymentError {
  constructor(message = "订单状态不允许该操作") {
    super(message, { httpStatus: 409, code: "PAY_ORDER_STATE", silent: true });
  }
}

/** 网关 API 调用失败（下单/关单） */
export class GatewayApiError extends PaymentError {
  constructor(message: string) {
    super(message, { httpStatus: 502, code: "PAY_GATEWAY_API", silent: false });
  }
}

/** 业务参数错误（金额过小、支付方式不可用等） */
export class PaymentInputError extends PaymentError {
  constructor(message: string) {
    super(message, { httpStatus: 400, code: "PAY_INPUT", silent: true });
  }
}

/** 支付方式不存在 / 已停用 */
export class PaymentMethodError extends PaymentError {
  constructor(message = "支付方式不存在") {
    super(message, { httpStatus: 404, code: "PAY_METHOD_NOT_FOUND", silent: true });
  }
}
