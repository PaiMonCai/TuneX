/**
 * BEPUSDT 网关 —— USDT-TRC20 链上支付
 * 依据: relayx-pay-channel-analysis-report.md §3（源码级还原）
 *
 * 已按源码确认实现的部分：
 *   · 签名：与 EPay 同款 MD5(k=v&...+apiKey)，承载字段名为 `signature`
 *   · 下单：pay_type 非空 → `/api/v1/order/create-transaction`（直转账，带 trade_type）
 *            pay_type 为空 → `/api/v1/order/create-order`（普通订单）
 *   · 成功标识：响应 `status_code === 200`，取 `data.payment_url` / `data.trade_id`
 *   · 回调成功状态：`status === 2`（已支付），应答文本 `ok`
 *   · 关单：`/api/v1/order/cancel-transaction`，容忍「状态不允许取消」
 *
 * TODO（待抓包/对接实测确认，不影响接口契约）：
 *   - [ ] 回调 POST 的真实 Content-Type（报告为 JSON body，需抓包确认是否 form）
 *   - [ ] 回调中金额字段名（推断为 `amount`，需抓包确认；确认后开启 amount_checked）
 *   - [ ] create-order 响应中 `data.payment_url` 与 `data.trade_id` 的字段命名
 *   - [ ] 是否存在签名时间戳/nonce 防重放字段
 */
import { BaseGateway, toNumber } from "./base.ts";
import { GatewayApiError, SignatureError, TradeStatusError } from "./errors.ts";
import type {
  CreateOrderInput,
  CreateOrderResult,
  GatewayPayment,
  HttpFetch,
  NotifyResult,
  PaymentMethodName,
} from "./types.ts";

/** BEPUSDT 已支付状态码 */
export const BEPUSDT_STATUS_PAID = 2;

/** BEPUSDT 接口成功状态码 */
export const BEPUSDT_STATUS_CODE_OK = 200;

export class BEPUSDTGateway extends BaseGateway {
  readonly method: PaymentMethodName = "bepusdt";
  protected override readonly skipSignFields = ["signature"] as const;
  protected override readonly signField = "signature";

  constructor(payment: GatewayPayment, http?: HttpFetch) {
    super(payment, http);
  }

  /** 构造下单参数（不含签名） */
  buildPayData(input: CreateOrderInput): Record<string, unknown> {
    const amount = this.getRealPrice(input.price);
    const redirectUrl = `${input.redirect_url}?trade_status=TRADE_SUCCESS`;
    const payType = input.pay_type ?? this.payment.type ?? undefined;

    // pay_type 语义（源码确认）：非空 → 直转账接口；空 → 普通订单接口
    if (payType) {
      return {
        trade_type: payType,
        order_id: input.order_id,
        amount,
        notify_url: this.payment.notify_url,
        redirect_url: redirectUrl,
        no_rate: false,
      };
    }
    return {
      order_id: input.order_id,
      amount,
      notify_url: this.payment.notify_url,
      redirect_url: redirectUrl,
    };
  }

  /** 下单路径选择（pay_type 非空 → 直转账） */
  getCreatePath(input: CreateOrderInput): string {
    const payType = input.pay_type ?? this.payment.type ?? undefined;
    return payType ? "/api/v1/order/create-transaction" : "/api/v1/order/create-order";
  }

  async createPayment(input: CreateOrderInput): Promise<CreateOrderResult> {
    const data = this.buildPayData(input);
    data.signature = this.generateSign(data);

    const ret = await this.postJson(this.getCreatePath(input), data);
    if (ret.status_code !== BEPUSDT_STATUS_CODE_OK) {
      throw new GatewayApiError(`BEPUSDT 下单失败: ${String(ret.message ?? JSON.stringify(ret))}`);
    }
    const payload = (ret.data ?? {}) as Record<string, unknown>;
    const payUrl = String(payload.payment_url ?? "");
    const tradeId = String(payload.trade_id ?? "");
    if (!payUrl) throw new GatewayApiError(`BEPUSDT 响应缺少 payment_url: ${JSON.stringify(ret)}`);
    return { pay_url: payUrl, trade_id: tradeId };
  }

  /** 关单：容忍「状态不允许取消」（原版语义） */
  override async cancelPayment(trade_id: string): Promise<void> {
    const data: Record<string, unknown> = { trade_id };
    data.signature = this.generateSign(data);

    const ret = await this.postJson("/api/v1/order/cancel-transaction", data);
    if (ret.status_code !== BEPUSDT_STATUS_CODE_OK) {
      const message = String(ret.message ?? "");
      if (!message.includes("状态不允许取消")) {
        throw new GatewayApiError(`BEPUSDT 关单失败: ${message || JSON.stringify(ret)}`);
      }
    }
  }

  async verifyCallback(data: Record<string, unknown>): Promise<NotifyResult> {
    if (!this.verifySign(data)) {
      throw new SignatureError(`Invalid response signature, data: ${JSON.stringify(data)}`);
    }

    const status = toNumber(data.status);
    if (status !== BEPUSDT_STATUS_PAID) {
      throw new TradeStatusError(`Trade status is not success: ${String(data.status)}`);
    }

    const orderId = String(data.order_id ?? "");
    if (!orderId) throw new SignatureError("Callback missing order_id");

    // TODO(抓包): 金额字段名确认前不阻断入账，但标记 amount_checked=false；
    // 若回调确实携带 amount，则开启校验（见 order.ts 的金额一致性逻辑）。
    const amount = toNumber(data.amount) ?? toNumber(data.money) ?? toNumber(data.actual_amount);
    return {
      order_id: orderId,
      trade_id: String(data.trade_id ?? ""),
      amount: amount ?? Number.NaN,
      raw_amount: amount === null ? "" : String(amount),
      status: String(status),
      response: "ok",
      amount_checked: amount !== null,
    };
  }

  /** 原版别名 */
  async pay(order_id: string, price: number, redirect_url: string, client_ip: string, pay_type?: string | null) {
    const r = await this.createPayment({ order_id, price, redirect_url, client_ip, pay_type });
    return [r.pay_url, r.trade_id] as const;
  }

  /** 原版别名 */
  async notify(data: Record<string, unknown>) {
    const r = await this.verifyCallback(data);
    return [r.order_id, r.response] as const;
  }
}
