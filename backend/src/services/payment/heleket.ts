/**
 * Heleket 网关 —— 加密货币聚合支付
 * 依据: pay-channel-analysis-report.md §4（源码级还原）
 *
 * 已按源码确认实现的部分：
 *   · 签名：MD5( base64( JSON.stringify(payload) 的 `/`→`\/` ) + apiKey )
 *   · 下单：POST {url}/v1/payment，JSON body
 *            headers: { merchant: <merchant_uuid>, sign: <签名>, Content-Type: application/json }
 *   · 金额：`getRealPrice(price).toFixed(2)`（强制 2 位小数）
 *   · 成功标识：响应 `state === 0`，取 `result.url` / `result.uuid`
 *   · 回调：body 内 `sign`，用同一 base64 算法对「去除 sign 后的 payload」验签
 *   · 回调成功状态：`status ∈ {paid, paid_over}`，应答文本 `ok`
 *   · 关单：上游无实现（原版空实现）
 *
 * 对接实测待确认项（不改变接口契约）：
 *   - [ ] 回调是否经 HTTP header 传 sign（报告写 body 内 sign，需实测确认）
 *   - [ ] 回调金额字段名（推断 `amount`；确认后开启 amount_checked）
 *   - [ ] currency 大小写与 to_currency 覆盖优先级
 */
import { BaseGateway, jsonBase64Sign, signEquals, toNumber } from "./base.ts";
import { GatewayApiError, SignatureError, TradeStatusError } from "./errors.ts";
import type {
  CreateOrderInput,
  CreateOrderResult,
  GatewayPayment,
  HttpFetch,
  NotifyResult,
  PaymentMethodName,
} from "./types.ts";

/** Heleket 视为支付成功的状态 */
export const HELEKET_PAID_STATUSES = ["paid", "paid_over"] as const;

export class HeleketGateway extends BaseGateway {
  readonly method: PaymentMethodName = "heleket";
  /** 回调签名整体参与 base64（无字段级 skip） */
  protected override readonly skipSignFields = [] as const;
  protected override readonly signField = "sign";

  /** 商户 UUID（config.merchant_uuid ?? config.merchant） */
  private readonly merchant: string;

  constructor(payment: GatewayPayment, http?: HttpFetch) {
    super(payment, http);
    this.merchant = String(payment.config?.merchant_uuid ?? payment.config?.merchant ?? "").trim();
    if (!this.merchant) throw new GatewayApiError("Heleket merchant_uuid is required");
  }

  /** Heleket 专用签名（覆盖基类的字段拼接式 MD5） */
  override generateSign(data: Record<string, unknown>): string {
    return jsonBase64Sign(data, this.apiKey);
  }

  /** 构造下单参数（不含签名） */
  buildPayData(input: CreateOrderInput): Record<string, unknown> {
    const data: Record<string, unknown> = {
      amount: this.getRealPrice(input.price).toFixed(2),
      currency: String(this.payment.config?.currency ?? "USD"),
      order_id: input.order_id,
      url_return: input.redirect_url,
      url_success: `${input.redirect_url}?trade_status=TRADE_SUCCESS`,
      url_callback: this.payment.notify_url,
    };
    if (this.payment.config?.network) data.network = this.payment.config.network;
    if (this.payment.config?.to_currency) data.to_currency = this.payment.config.to_currency;

    // pay_type 直接覆盖目标币种（源码确认）
    const payType = input.pay_type ?? this.payment.type ?? undefined;
    if (payType) data.to_currency = payType;
    return data;
  }

  async createPayment(input: CreateOrderInput): Promise<CreateOrderResult> {
    const data = this.buildPayData(input);
    const sign = this.generateSign(data);

    const ret = await this.postJson("/v1/payment", data, {
      merchant: this.merchant,
      sign,
    });

    if (ret.state !== 0) {
      throw new GatewayApiError(
        `Heleket 下单失败: ${String(ret.message ?? JSON.stringify(ret.errors ?? ret))}`,
      );
    }
    const result = (ret.result ?? {}) as Record<string, unknown>;
    const payUrl = String(result.url ?? "");
    if (!payUrl) throw new GatewayApiError(`Heleket 响应缺少 result.url: ${JSON.stringify(ret)}`);
    return { pay_url: payUrl, trade_id: String(result.uuid ?? "") };
  }

  /** 上游无关单接口（原版空实现） */
  override async cancelPayment(_trade_id: string): Promise<void> {
    /* no-op：Heleket 未提供关单接口 */
  }

  async verifyCallback(data: Record<string, unknown>): Promise<NotifyResult> {
    const sign = data.sign;
    if (sign === null || sign === undefined || String(sign) === "") {
      throw new SignatureError(`Missing sign, data: ${JSON.stringify(data)}`);
    }
    if (!this.hasApiKey) throw new SignatureError("api_key not configured");

    // 验签载荷 = 去除 sign 后的全部字段
    const payload: Record<string, unknown> = { ...data };
    delete payload.sign;

    const expected = this.generateSign(payload);
    if (!signEquals(expected, String(sign))) {
      throw new SignatureError(`Invalid response signature, data: ${JSON.stringify(data)}`);
    }

    const status = String(data.status ?? "");
    if (!(HELEKET_PAID_STATUSES as readonly string[]).includes(status)) {
      throw new TradeStatusError(`Trade status is not success: ${status}`);
    }

    const orderId = String(data.order_id ?? "");
    if (!orderId) throw new SignatureError("Callback missing order_id");

    // TODO(抓包): 金额字段名确认前不阻断入账，标记 amount_checked=false
    const amount = toNumber(data.amount) ?? toNumber(data.actual_amount) ?? toNumber(data.money);
    return {
      order_id: orderId,
      trade_id: String(data.uuid ?? data.trade_id ?? ""),
      amount: amount ?? Number.NaN,
      raw_amount: amount === null ? "" : String(amount),
      status,
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
