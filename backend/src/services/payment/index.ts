/**
 * 支付网关工厂 + 注册表
 * 依据: pay-channel-analysis-report.md §0 getPay()（源码确认）
 *
 * 原版行为：switch(payment.method) 分发，**default 回落 EPay**。
 * 保留该回落语义（兼容 method 字段异常的历史数据），但显式记录告警。
 *
 * 扩展点：`registerGateway(method, factory)` 可注入自定义实现（测试/新网关），
 * 不改动本文件即可扩展。
 */
import { EPayGateway } from "./epay.ts";
import { BEPUSDTGateway } from "./bepusdt.ts";
import { HeleketGateway } from "./heleket.ts";
import { PaymentMethodError } from "./errors.ts";
import type { GatewayFactory, GatewayPayment, HttpFetch, PaymentGateway } from "./types.ts";
import { env } from "../../env.ts";

/** 内建网关注册表 */
const registry = new Map<string, GatewayFactory>();

export function registerGateway(method: string, factory: GatewayFactory): void {
  registry.set(method, factory);
}

export function unregisterGateway(method: string): void {
  registry.delete(method);
}

/** 已注册的支付方式列表 */
export function registeredMethods(): string[] {
  return [...registry.keys()];
}

// ---- 内建三种网关 ----
registerGateway("epay", (p, http) => new EPayGateway(p, http));
registerGateway("bepusdt", (p, http) => new BEPUSDTGateway(p, http));
registerGateway("heleket", (p, http) => new HeleketGateway(p, http));

/**
 * 拼接网关回调地址：{SITE_URL}/api/pay/{payment.id}/callback
 * 原版语义（源码确认）：由后端自动生成，与 payment.id 绑定。
 */
export function buildNotifyUrl(paymentId: number, siteUrl = env.siteUrl): string {
  return `${siteUrl.replace(/\/+$/, "")}/api/pay/${paymentId}/callback`;
}

/** 从 DB payment 行构造网关实例 */
export function getPaymentGateway(
  payment: {
    id: number;
    name: string;
    url: string;
    method: string;
    type?: string | null;
    fixed_fee?: number | null;
    percent_fee?: number | null;
    config: unknown;
  },
  opts: { notifyUrl?: string; http?: HttpFetch; siteUrl?: string } = {},
): PaymentGateway {
  const method = String(payment.method ?? "").toLowerCase();
  const factory = registry.get(method);

  // 原版 default → EPay 回落
  if (!factory) {
    console.warn(`[payment] unknown method "${payment.method}", falling back to epay`);
  }

  const gatewayPayment: GatewayPayment = {
    id: payment.id,
    name: payment.name,
    url: payment.url,
    method: (factory ? method : "epay") as GatewayPayment["method"],
    type: payment.type ?? null,
    fixed_fee: payment.fixed_fee ?? null,
    percent_fee: payment.percent_fee ?? null,
    config: (payment.config ?? {}) as GatewayPayment["config"],
    notify_url: opts.notifyUrl ?? buildNotifyUrl(payment.id, opts.siteUrl),
  };

  const resolved = factory ?? registry.get("epay")!;
  return resolved(gatewayPayment, opts.http);
}

/** 校验支付方式可用性（供路由层使用） */
export function assertMethodSupported(method: string): void {
  if (!registry.has(String(method ?? "").toLowerCase())) {
    throw new PaymentMethodError(`不支持的支付方式: ${method}`);
  }
}

export { EPayGateway, BEPUSDTGateway, HeleketGateway };
export type { PaymentGateway };
