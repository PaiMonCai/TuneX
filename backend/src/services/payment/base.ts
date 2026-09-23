/**
 * BaseGateway —— 支付网关抽象基类 + 通用签名/费用工具
 * 依据: relayx-pay-channel-analysis-report.md §1（BasePay 源码级还原）
 *
 * 本文件**不依赖任何 Web 框架**（不 import hono），只依赖 node:crypto，
 * 因此签名/费用逻辑可离线单元测试。
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type {
  CreateOrderInput,
  CreateOrderResult,
  GatewayPayment,
  HttpFetch,
  NotifyResult,
  PaymentGateway,
  PaymentMethodName,
} from "./types.ts";
import { GatewayApiError } from "./errors.ts";

/** 默认 HTTP 客户端：全局 fetch 的薄封装 */
export const defaultFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, init);
  return {
    status: res.status,
    text: () => res.text(),
    json: () => res.json() as Promise<unknown>,
  };
};

/** MD5 十六进制小写 */
export function md5Hex(input: string): string {
  return createHash("md5").update(input, "utf8").digest("hex");
}

/**
 * 签名内容构造（原版 getSignContent，源码确认）：
 *   ① 过滤 null / "" / skipSignFields 内的字段
 *   ② key 按 ASCII 升序（localeCompare 在纯 ASCII 键下等价）
 *   ③ `k=v` 用 `&` 连接
 *   ④ 末尾直接拼 apiKey（**无分隔符**）
 */
export function buildSignContent(
  data: Record<string, unknown>,
  apiKey: string,
  skipSignFields: readonly string[] = [],
): string {
  const skip = new Set(skipSignFields);
  const entries = Object.entries(data)
    .filter(([k, v]) => v !== null && v !== undefined && v !== "" && !skip.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&") + apiKey;
}

/**
 * Heleket 专用签名（原版 generateJsonBase64Sign，源码确认）：
 *   JSON.stringify(payload) 的 `/` → `\/`，整体 base64，再拼 apiKey，最后 MD5。
 * 注意：JS 的 JSON.stringify 不转义 `/`，故这里显式替换以对齐 PHP 风格。
 */
export function jsonBase64Sign(payload: Record<string, unknown>, apiKey: string): string {
  const json = JSON.stringify(payload);
  const escaped = json.replace(/\//g, "\\/");
  const b64 = Buffer.from(escaped, "utf8").toString("base64");
  return md5Hex(b64 + apiKey);
}

/** 恒定时间字符串比较（大小写不敏感；长度不等直接 false） */
export function signEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a.toUpperCase(), "utf8");
  const bb = Buffer.from(b.toUpperCase(), "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * 手续费计价（原版 getRealPrice，源码确认）：
 *   ① 先加 fixed_fee
 *   ② 再叠加 percent_fee（rate 为小数，如 0.03 = 3%）
 *   ③ `Math.round(x*1e6)/1e6` 消除浮点误差后 `Math.ceil` 向上取整到分
 * 用户实付 = 该结果；**入账余额仍是原始 price**。
 */
export function getRealPrice(
  price: number,
  fixedFee?: number | null,
  percentFee?: number | null,
): number {
  let p = price;
  if (fixedFee) p = p + fixedFee;
  if (percentFee) {
    const rawCents = p * (1 + percentFee) * 100;
    const cents = Math.ceil(Math.round(rawCents * 1e6) / 1e6);
    p = cents / 100;
  }
  return p;
}

/** 19 位订单号：yyyyMMddHHmmss(14) + randomInt(10000,99999)(5)，按 Asia/Shanghai 墙钟 */
export function generateOrderNo(now: Date = new Date(), tzOffsetMinutes = 8 * 60): string {
  const shifted = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const dt =
    `${shifted.getUTCFullYear()}${p(shifted.getUTCMonth() + 1)}${p(shifted.getUTCDate())}` +
    `${p(shifted.getUTCHours())}${p(shifted.getUTCMinutes())}${p(shifted.getUTCSeconds())}`;
  return `${dt}${randomInt(10000, 100000)}`;
}

/** 宽松数值解析（回调金额可能是 string / number） */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 金额一致性校验（W5 修复的原版缺陷）。
 * 原版只验签 + 判状态，**不回校回调金额与订单应付金额**（见交叉验证报告 §问题 13）。
 * 这里要求回调金额 >= 应付金额且不超过容差（默认 0.01，允许分位舍入差）。
 */
export function assertAmountConsistent(
  expected: number,
  actual: number,
  tolerance = 0.01,
): { ok: boolean; reason?: string } {
  if (!Number.isFinite(actual)) return { ok: false, reason: "callback amount not a finite number" };
  if (!Number.isFinite(expected)) return { ok: false, reason: "expected amount not a finite number" };
  const diff = actual - expected;
  // 浮点误差补偿：104.04 - 104.03 = 0.010000000000005116 > 0.01，
  // 故比较时叠加一个远小于最小货币单位（分）的 epsilon。
  const EPSILON = 1e-9;
  if (Math.abs(diff) <= tolerance + EPSILON) return { ok: true };
  if (diff > 0) return { ok: false, reason: `overpaid by ${diff.toFixed(2)} beyond tolerance` };
  return { ok: false, reason: `underpaid by ${Math.abs(diff).toFixed(2)}` };
}

/** 表单编码（application/x-www-form-urlencoded） */
export function toFormBody(data: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue;
    usp.append(k, String(v));
  }
  return usp.toString();
}

/* ------------------------------------------------------------------ */

/**
 * 抽象网关基类。
 * 子类必须实现 `createPayment` / `verifyCallback`；
 * `cancelPayment` 默认空实现（对齐原版 BasePay.cancelOrder）。
 */
export abstract class BaseGateway implements PaymentGateway {
  abstract readonly method: PaymentMethodName;

  protected readonly payment: GatewayPayment;
  protected readonly apiKey: string;
  protected readonly url: string;
  /** 需要从签名内容中剔除的字段名 */
  protected readonly skipSignFields: readonly string[] = [];
  /** 承载签名的字段名 */
  protected readonly signField: string = "sign";
  protected readonly http: HttpFetch;

  constructor(payment: GatewayPayment, http: HttpFetch = defaultFetch) {
    this.payment = payment;
    this.url = payment.url;
    this.apiKey = String(payment.config?.api_key ?? "").trim();
    this.http = http;
  }

  /** 是否配置了签名密钥（未配置的回调一律拒绝验签） */
  get hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /** 通用 MD5 签名（原版 generateSign） */
  generateSign(data: Record<string, unknown>): string {
    return md5Hex(buildSignContent(data, this.apiKey, this.skipSignFields));
  }

  /** 手续费计价（透传 payment 上的费率配置） */
  getRealPrice(price: number): number {
    return getRealPrice(price, this.payment.fixed_fee, this.payment.percent_fee);
  }

  /** 订单号生成 */
  generateOrderNo(now?: Date): string {
    return generateOrderNo(now);
  }

  /**
   * 通用验签：缺 sign → false；否则恒定时间比较（大小写不敏感）。
   * 未配置 api_key 时直接 false（避免空密钥伪造通过）。
   */
  verifySign(data: Record<string, unknown>): boolean {
    if (!this.hasApiKey) return false;
    const sign = data[this.signField];
    if (sign === null || sign === undefined || sign === "") return false;
    return signEquals(this.generateSign(data), String(sign));
  }

  /** 统一的网关 POST 调用（JSON 返回） */
  protected async postJson(
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const url = joinUrl(this.url, path);
    let res: Awaited<ReturnType<HttpFetch>>;
    try {
      res = await this.http(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new GatewayApiError(`网关请求失败: ${(e as Error)?.message ?? e}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GatewayApiError(`网关返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    return parsed as Record<string, unknown>;
  }

  /** 统一的网关表单 POST 调用 */
  protected async postForm(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = joinUrl(this.url, path);
    let res: Awaited<ReturnType<HttpFetch>>;
    try {
      res = await this.http(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: toFormBody(body),
      });
    } catch (e) {
      throw new GatewayApiError(`网关请求失败: ${(e as Error)?.message ?? e}`);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new GatewayApiError(`网关返回非 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
  }

  abstract createPayment(input: CreateOrderInput): Promise<CreateOrderResult>;

  /** 默认不支持关单（EPay / Heleket 原版语义） */
  async cancelPayment(_trade_id: string): Promise<void> {
    /* no-op */
  }

  abstract verifyCallback(data: Record<string, unknown>): Promise<NotifyResult>;
}

/** 拼接 baseURL 与 path（避免双斜杠 / 丢斜杠） */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return b + p;
}
