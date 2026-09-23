/**
 * EPay 网关 —— 完整实现（支付宝/微信等通用企业支付）
 * 依据: relayx-pay-channel-analysis-report.md §2（源码级还原，无推测）
 *
 * 协议要点：
 *   · 下单：POST {url}/mapi.php，application/x-www-form-urlencoded
 *   · 签名：MD5( 过滤空值/sign/sign_type → key ASCII 升序 → k=v& 连接 + api_key )
 *   · 成功：响应 JSON `code === 1`，取 `payurl` / `trade_no`
 *   · 回调：GET/POST 携带 query 参数，验签 + `trade_status === "TRADE_SUCCESS"`
 *   · 应答：纯文本 `success`
 *   · 关单：上游不支持（原版空实现）
 *
 * W5 增强（修复原版缺陷，见交叉验证报告 §问题 13）：
 *   `verifyCallback` 返回回调金额，由上层 `order.ts` 与订单应付金额做一致性校验；
 *   金额不一致时拒绝入账并记录日志。
 */
import { isIPv6 } from "node:net";
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

/** EPay 下单字段（`type` 仅在配置了渠道时出现） */
export interface EPayPayData {
  pid: string | number;
  out_trade_no: string;
  clientip: string;
  notify_url: string;
  return_url: string;
  name: string;
  money: string | number;
  device: string;
  type?: string;
  sign?: string;
  sign_type?: string;
  [key: string]: unknown;
}

/** EPay 回调字段 */
export interface EPayNotifyData {
  pid?: string | number;
  trade_no?: string;
  out_trade_no?: string;
  type?: string;
  name?: string;
  money?: string | number;
  trade_status?: string;
  sign?: string;
  sign_type?: string;
  [key: string]: unknown;
}

export class EPayGateway extends BaseGateway {
  readonly method: PaymentMethodName = "epay";
  protected override readonly skipSignFields = ["sign", "sign_type"] as const;
  protected override readonly signField = "sign";

  /** 商户 ID（config.pid） */
  private readonly pid: string | number;

  constructor(payment: GatewayPayment, http?: HttpFetch) {
    super(payment, http);
    this.pid = (payment.config?.pid ?? "") as string | number;
  }

  /**
   * 构造下单参数（**不含签名**）。
   * 抽成独立纯函数式方法，便于离线断言字段集与签名内容。
   */
  buildPayData(input: CreateOrderInput): EPayPayData {
    const ip = input.client_ip && !isIPv6(input.client_ip) ? input.client_ip : "127.0.0.1";
    const data: EPayPayData = {
      pid: this.pid,
      out_trade_no: input.order_id,
      clientip: ip,
      notify_url: this.payment.notify_url,
      return_url: input.redirect_url,
      name: input.order_id,
      money: this.getRealPrice(input.price),
      device: "jump",
    };
    const payType = input.pay_type ?? this.payment.type ?? undefined;
    if (payType) data.type = payType;
    return data;
  }

  /** 下单：POST /mapi.php（form），返回收银台 URL 与上游流水号 */
  async createPayment(input: CreateOrderInput): Promise<CreateOrderResult> {
    const data = this.buildPayData(input);
    data.sign = this.generateSign(data);
    data.sign_type = "MD5";

    const ret = await this.postForm("/mapi.php", data);

    const code = ret.code;
    if (code !== 1 && code !== "1") {
      throw new GatewayApiError(`EPay 下单失败: ${String(ret.msg ?? JSON.stringify(ret))}`);
    }
    const payUrl = String(ret.payurl ?? "");
    const tradeId = String(ret.trade_no ?? "");
    if (!payUrl) throw new GatewayApiError(`EPay 响应缺少 payurl: ${JSON.stringify(ret)}`);
    return { pay_url: payUrl, trade_id: tradeId };
  }

  /** EPay 上游不支持关单（原版空实现，保持语义） */
  override async cancelPayment(_trade_id: string): Promise<void> {
    /* no-op：EPay 无关闭订单接口 */
  }

  /**
   * 回调验签 + 状态判定。
   * 步骤 ① 验签（失败抛 SignatureError）
   *      ② trade_status 必须为 TRADE_SUCCESS
   *      ③ 返回含金额的结果（由调用方做金额一致性校验）
   */
  async verifyCallback(data: Record<string, unknown>): Promise<NotifyResult> {
    const d = data as EPayNotifyData;

    if (!this.verifySign(d)) {
      throw new SignatureError(`Invalid response signature, data: ${JSON.stringify(d)}`);
    }

    const tradeStatus = String(d.trade_status ?? "");
    if (tradeStatus !== "TRADE_SUCCESS") {
      throw new TradeStatusError(`Trade status is not success: ${tradeStatus}`);
    }

    const orderId = String(d.out_trade_no ?? "");
    if (!orderId) throw new SignatureError("Callback missing out_trade_no");

    const amount = toNumber(d.money);
    if (amount === null) throw new TradeStatusError("Callback missing/invalid money");

    return {
      order_id: orderId,
      trade_id: String(d.trade_no ?? ""),
      amount,
      raw_amount: String(d.money),
      status: tradeStatus,
      response: "success",
      amount_checked: true,
    };
  }

  /** 原版别名（源码 1:1 对照用） */
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

/**
 * 离线签名工具导出（测试/调试用，不实例化网关即可算签名）。
 * 与 EPayGateway.generateSign 走同一实现，避免测试重复实现算法。
 */
export function buildEPaySignFields(data: Record<string, unknown>, apiKey: string): string {
  return new EPayGateway(
    {
      id: 0,
      name: "test",
      url: "http://unused",
      method: "epay",
      config: { api_key: apiKey },
      notify_url: "http://unused",
    },
    async () => {
      throw new Error("offline");
    },
  ).generateSign(data);
}
