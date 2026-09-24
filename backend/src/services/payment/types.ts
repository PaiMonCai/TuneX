/**
 * 支付网关抽象层 —— 类型定义
 * 依据: pay-channel-analysis-report.md §1-§5（源码级还原）
 *
 * 复刻原版 `packages/shared/src/pay.ts` 的 BasePay 抽象 + 三种实现，
 * 但做了三点工程化增强：
 *   1. 统一的 PaymentGateway 接口（原版为隐式 duck typing）
 *   2. 结构化错误类型（AmountMismatchError / SignatureError ...）便于上层区分
 *   3. HTTP 客户端可注入（原版硬编码 axios），使单元测试无需网络
 */

/** 三种支付方式（对应 Prisma enum PaymentMethod） */
export type PaymentMethodName = "epay" | "bepusdt" | "heleket";

/** payment.config（JSON 列）——含各网关的商户凭证，敏感，勿外泄 */
export interface PaymentConfig {
  /** 通用签名密钥 */
  api_key?: string;
  /** EPay 商户 ID */
  pid?: string | number;
  /** Heleket 商户 UUID（或别名 merchant） */
  merchant_uuid?: string;
  merchant?: string;
  /** Heleket 计价币种，默认 USD */
  currency?: string;
  /** Heleket 链网络 */
  network?: string;
  /** Heleket 目标币种 */
  to_currency?: string;
  /** 金额一致性校验容差（回调金额与订单应付金额允许的最大偏差） */
  amount_tolerance?: number;
  [key: string]: unknown;
}

/** 传给网关构造器的支付渠道记录（DB payment 行 + 运行时拼装的 notify_url） */
export interface GatewayPayment {
  id: number;
  name: string;
  url: string;
  method: PaymentMethodName;
  /** 渠道选择器，语义随 method 变（EPay=支付类型，BEPUSDT=直转账 trade_type，Heleket=目标币种） */
  type?: string | null;
  fixed_fee?: number | null;
  percent_fee?: number | null;
  config: PaymentConfig;
  /** 后端自动拼装：{SITE_URL}/api/pay/{payment.id}/callback */
  notify_url: string;
}

/** 创建订单入参 */
export interface CreateOrderInput {
  order_id: string;
  price: number;
  redirect_url: string;
  client_ip: string;
  pay_type?: string | null;
}

/** 创建订单结果 */
export interface CreateOrderResult {
  /** 收银台 URL */
  pay_url: string;
  /** 上游流水号 */
  trade_id: string;
}

/**
 * 回调解析结果（已验签 + 已判成功状态）。
 * amount 为数值化后的回调金额，用于金额一致性校验（原版缺陷修复点）。
 */
export interface NotifyResult {
  /** 商户订单号（本地 order_id） */
  order_id: string;
  /** 上游流水号 */
  trade_id: string;
  /** 回调金额（数值） */
  amount: number;
  /** 回调金额原文（保留精度，便于日志/审计） */
  raw_amount: string;
  /** 网关状态原文 */
  status: string;
  /** 需要回给网关的应答文本（EPay "success" / BEPUSDT|Heleket "ok"） */
  response: string;
  /** 该网关回调是否携带可校验的金额（false 时应跳过金额一致性校验） */
  amount_checked: boolean;
}

/** 可注入的 HTTP 客户端（默认走全局 fetch） */
export type HttpFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

/**
 * 统一支付网关接口（三种实现共同契约）。
 *
 * 命名对齐任务规范：createPayment / cancelPayment / verifyCallback。
 * 实现类同时保留原版方法名 `pay` / `cancelOrder` / `notify` 作为别名，
 * 以保证与逆向报告中的源码语义 1:1 对应（便于后续对照审查）。
 */
export interface PaymentGateway {
  /** 网关方法名标识 */
  readonly method: PaymentMethodName;

  /** 生成商户订单号（19 位：yyyyMMddHHmmss + 5 位随机） */
  generateOrderNo(now?: Date): string;

  /** 是否已配置签名密钥（未配置时空密钥回调一律拒绝） */
  readonly hasApiKey: boolean;

  /** 发起支付：向网关下单，返回 [收银台 URL, 上游流水号] 等价的完整结果 */
  createPayment(input: CreateOrderInput): Promise<CreateOrderResult>;

  /**
   * 关闭上游交易（幂等语义：订单已支付等「不可取消」状态应容忍而非抛错）。
   * EPay / Heleket 上游不支持关单 → 空实现（与原版一致）。
   */
  cancelPayment(trade_id: string): Promise<void>;

  /**
   * 校验并解析回调：
   * ① 验签失败 → 抛 SignatureError
   * ② 状态非成功 → 抛 TradeStatusError
   * ③ 通过 → 返回 NotifyResult（含金额，供上层做一致性校验）
   */
  verifyCallback(data: Record<string, unknown>): Promise<NotifyResult>;
}

/** 网关构造器签名（工厂注册表使用；第二参数为可注入 HTTP 客户端） */
export type GatewayFactory = (payment: GatewayPayment, http?: HttpFetch) => PaymentGateway;

