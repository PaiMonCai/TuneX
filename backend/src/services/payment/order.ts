/**
 * TopupOrderService —— 充值订单状态机 + 余额入账事务 + 10 分钟超时取消
 * 依据:
 *   · pay-channel-analysis-report.md §6-§7（回调入账 / 下单 / 自动取消，源码级还原）
 *   · billing-source-verification-report.md §2（processReferralCommission 挂载点）
 *   · TuneX-最终交叉验证汇总报告.md 问题 13/14/15（原版缺陷，已修复）
 *
 * 修复的三处原版缺陷：
 *   【缺陷 13】回调不回校金额一致性 → `assertAmountConsistent`，
 *              不一致时**在事务内抛错**（任何 DB 写之前），并记录明确日志
 *   【缺陷 14】幂等只挡 success 不挡 cancelled → 走统一状态机 `evaluateTransition`，
 *              cancelled→success 路径显式记 WARN
 *   【缺陷 15】自动取消不调上游关单 → 保留原版行为（只本地改状态），
 *              但把上游关单抽出为 `cancelUpstream` 开关，业务方可按需开启
 *
 * 框架依赖：仅 Prisma（db.ts）/ ioredis（redis.ts）。**不依赖 hono**。
 */
import { db } from "../../db.ts";
import { env } from "../../env.ts";
import { redis, RedisKeys } from "../../redis.ts";
import { assertAmountConsistent, getRealPrice } from "./base.ts";
import {
  AmountMismatchError,
  GatewayApiError,
  OrderNotFoundError,
  OrderStateError,
  PaymentInputError,
  PaymentMethodError,
} from "./errors.ts";
import { evaluateTransition, type TopupAction, type TopupState } from "./order-state.ts";
import { getPaymentGateway } from "./index.ts";
import type { HttpFetch } from "./types.ts";

/** 未付订单自动取消时限（与原版 delay job 一致：10 分钟） */
export const UNPAID_ORDER_TIMEOUT_MS = 10 * 60 * 1000;

/** 每用户单笔 pending 订单的互斥锁 TTL */
const USER_LOCK_TTL_SECONDS = 5;

/** 打印器（便于测试注入静默实现） */
export interface PayLogger {
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export const defaultPayLogger: PayLogger = {
  info: (m, meta) => console.log(`[pay] ${m}`, meta ?? ""),
  warn: (m, meta) => console.warn(`[pay] ${m}`, meta ?? ""),
  error: (m, meta) => console.error(`[pay] ${m}`, meta ?? ""),
};

/**
 * 自动取消调度端口。
 * 默认实现为 setTimeout（降级方案，进程重启丢任务）；
 * 生产用 BullMQ 接入：`orderService.setScheduler(bullmqScheduler)`。
 */
export interface AutoCancelScheduler {
  schedule(orderId: number, delayMs: number): Promise<void> | void;
  cancel?(orderId: number): Promise<void> | void;
}

/** setTimeout 降级实现（进程内定时器；unref 避免阻塞退出） */
export class SetTimeoutScheduler implements AutoCancelScheduler {
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly run: (orderId: number) => Promise<unknown>,
    private readonly logger: PayLogger = defaultPayLogger,
  ) {}

  schedule(orderId: number, delayMs: number): void {
    const old = this.timers.get(orderId);
    if (old) clearTimeout(old);
    const t = setTimeout(() => {
      this.timers.delete(orderId);
      this.run(orderId).catch((e) => this.logger.error(`auto-cancel failed for #${orderId}`, e));
    }, delayMs);
    // Bun/Node：定时器不应阻止进程退出
    (t as unknown as { unref?: () => void }).unref?.();
    this.timers.set(orderId, t);
  }

  cancel(orderId: number): void {
    const t = this.timers.get(orderId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(orderId);
    }
  }

  /** 测试用：等待所有定时器清空 */
  pendingCount(): number {
    return this.timers.size;
  }
}

/** 入账后钩子（佣金结算等扩展点；在事务内执行） */
export type AfterCreditHook = (
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  order: { id: number; order_id: string; user_id: number; price: number; bonus: number },
) => Promise<void>;

export interface CreateTopupInput {
  user_id: number;
  price: number;
  payment_id: number;
  redirect_url: string;
  client_ip: string;
}

export interface CreateTopupOptions {
  /** 注入式 HTTP 客户端（测试用；默认走全局 fetch） */
  http?: HttpFetch;
}

export interface CallbackOutcome {
  /** 网关应答文本（透传给网关） */
  response: string;
  /** 是否本次真正入账 */
  credited: boolean;
  order_id: string;
  /** 入账金额（price + bonus） */
  amount?: number;
}

export class TopupOrderService {
  private scheduler: AutoCancelScheduler;
  private logger: PayLogger;
  private afterCredit: AfterCreditHook | null = null;
  /** 是否在本地取消时一并调用上游关单（原版不调；默认 false 保持一致） */
  private cancelUpstreamOnLocalCancel = false;

  constructor(opts: { scheduler?: AutoCancelScheduler; logger?: PayLogger } = {}) {
    this.logger = opts.logger ?? defaultPayLogger;
    this.scheduler =
      opts.scheduler ?? new SetTimeoutScheduler((id) => this.cancelUnpaidOrder(id), this.logger);
  }

  setScheduler(s: AutoCancelScheduler): void {
    this.scheduler = s;
  }

  setLogger(l: PayLogger): void {
    this.logger = l;
  }

  setAfterCreditHook(hook: AfterCreditHook | null): void {
    this.afterCredit = hook;
  }

  setCancelUpstreamOnLocalCancel(v: boolean): void {
    this.cancelUpstreamOnLocalCancel = v;
  }

  /* ------------------------------------------------------------------ */
  /* 下单                                                               */
  /* ------------------------------------------------------------------ */

  /** 最低充值金额（config 表 MIN_TOPUP_AMOUNT，默认 10） */
  async minTopupAmount(): Promise<number> {
    try {
      const row = await db.systemConfig.findUnique({ where: { name: "MIN_TOPUP_AMOUNT" } });
      const n = Number(row?.value);
      return Number.isFinite(n) && n > 0 ? n : 10;
    } catch {
      return 10;
    }
  }

  /**
   * 赠送金额（TopupActivity 命中项**累加**，源码确认语义）。
   * 命中条件：有效期区间 + 金额区间均满足。
   */
  async calculateBonus(price: number): Promise<number> {
    const now = new Date();
    const activities = await db.topupActivity.findMany({
      where: {
        AND: [
          { OR: [{ valid_start: null }, { valid_start: { lte: now } }] },
          { OR: [{ valid_end: null }, { valid_end: { gte: now } }] },
          { OR: [{ min_amount: null }, { min_amount: { lte: price } }] },
          { OR: [{ max_amount: null }, { max_amount: { gte: price } }] },
        ],
      },
    });
    let bonus = 0;
    for (const a of activities) {
      if (a.type === "percentage") bonus += price * (a.value / 100);
      else bonus += a.value;
    }
    return bonus;
  }

  /**
   * 创建充值订单（对齐原版 routes/topup.ts POST /api/topup）：
   *   ① 最低金额校验 ② 支付方式必须 active ③ 单用户互斥锁
   *   ④ 单用户单笔 pending 限制（409） ⑤ 调用网关下单
   *   ⑥ 计算赠送 ⑦ 落库 ⑧ 排定 10 分钟自动取消
   */
  async createTopupOrder(
    input: CreateTopupInput,
    opts: CreateTopupOptions = {},
  ): Promise<{ id: number; order_id: string; pay_url: string }> {
    const min = await this.minTopupAmount();
    if (!Number.isFinite(input.price) || input.price < min) {
      throw new PaymentInputError(`充值金额不能小于 ${min} 元`);
    }

    const payment = await db.payment.findFirst({
      where: { id: input.payment_id, status: "active" },
    });
    if (!payment) throw new PaymentMethodError("支付方式不存在");

    return this.withUserLock(input.user_id, async () => {
      const pending = await db.topupOrder.findFirst({
        where: { user_id: input.user_id, status: "pending" },
      });
      if (pending) throw new OrderStateError("存在未完成的充值订单");

      const gateway = getPaymentGateway(payment, { siteUrl: env.siteUrl, http: opts.http });
      const orderId = gateway.generateOrderNo();

      const created = await gateway.createPayment({
        order_id: orderId,
        price: input.price,
        redirect_url: input.redirect_url,
        client_ip: input.client_ip,
        pay_type: payment.type,
      });

      const user = await db.user.findUnique({ where: { id: input.user_id }, select: { balance: true } });
      const bonus = await this.calculateBonus(input.price);

      const order = await db.topupOrder.create({
        data: {
          user_id: input.user_id,
          price: input.price,
          pay_url: created.pay_url,
          payment_id: payment.id,
          order_id: orderId,
          trade_id: created.trade_id || null,
          balance: user?.balance ?? 0,
          bonus,
          status: "pending",
        },
      });

      await this.scheduler.schedule(order.id, UNPAID_ORDER_TIMEOUT_MS);
      this.logger.info(`topup order created #${order.id} (${orderId}) price=${input.price} bonus=${bonus}`);
      return { id: order.id, order_id: orderId, pay_url: created.pay_url };
    });
  }

  /* ------------------------------------------------------------------ */
  /* 回调入账                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * 处理网关回调（对齐原版 routes/pay.ts POST|GET /api/pay/:id/callback）。
   *
   * 流程：验签+状态 → 事务内 { 读订单 → 状态机判定 → **金额一致性校验** →
   *       余额 increment → 订单置 success → balance_log → 扩展钩子 }
   *
   * 任何校验失败都在 **事务内** 抛错 → 全部回滚 → 零 DB 写。
   */
  async handleCallback(paymentId: number, payload: Record<string, unknown>): Promise<CallbackOutcome> {
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new PaymentMethodError("支付方式不存在");

    const gateway = getPaymentGateway(payment, { siteUrl: env.siteUrl });

    // ① 验签 + 状态判定（抛 SignatureError / TradeStatusError）
    const notify = await gateway.verifyCallback(payload);

    const outcome = await db.$transaction(async (tx) => {
      const order = await tx.topupOrder.findUnique({ where: { order_id: notify.order_id } });
      if (!order) throw new OrderNotFoundError("充值订单不存在");

      // ② 状态机
      const decision = evaluateTransition(order.status as TopupState, "callback_paid");
      if (!decision.allowed) {
        this.logger.error(`callback rejected for ${notify.order_id}: ${decision.reason}`);
        throw new OrderStateError(decision.reason ?? "订单状态不允许入账");
      }
      if (decision.idempotent) {
        this.logger.warn(`duplicate callback ignored (already ${order.status}): ${notify.order_id}`);
        return { credited: false, order_id: notify.order_id };
      }
      if (decision.warn) {
        this.logger.warn(`callback on ${order.status} order -> success: ${notify.order_id} (${decision.warn})`);
      }

      // ③ 金额一致性校验（修复原版缺陷 13）
      if (notify.amount_checked) {
        const tolerance = Number(payment.config && (payment.config as Record<string, unknown>).amount_tolerance);
        const tol = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0.01;

        // 期望值双口径：含手续费实付额（网关下单所用）或订单原始额（不含手续费口径）
        const withFee = getRealPrice(order.price, payment.fixed_fee, payment.percent_fee);
        const isWithFee = assertAmountConsistent(withFee, notify.amount, tol).ok;
        const isRaw = assertAmountConsistent(order.price, notify.amount, tol).ok;

        if (!isWithFee && !isRaw) {
          this.logger.error(
            `amount mismatch for ${notify.order_id}: order.price=${order.price} payable=${withFee} callback=${notify.amount}`,
          );
          throw new AmountMismatchError(notify.order_id, withFee, notify.amount);
        }
      } else {
        this.logger.warn(
          `callback for ${notify.order_id} carries no verifiable amount (gateway ${payment.method}); amount check skipped`,
        );
      }

      // ④ 入账：余额 increment + 订单置 success + 流水
      const totalAmount = order.price + order.bonus;

      const updatedUser = await tx.user.update({
        where: { id: order.user_id },
        data: { balance: { increment: totalAmount } },
        select: { balance: true },
      });

      const updated = await tx.topupOrder.updateMany({
        where: { id: order.id },
        data: {
          status: "success",
          balance: { increment: totalAmount },
          ...(notify.trade_id ? { trade_id: notify.trade_id } : {}),
        },
      });
      if (updated.count !== 1) {
        throw new OrderStateError(`订单更新失败（并发冲突）: ${notify.order_id}`);
      }

      await tx.balanceLog.create({
        data: {
          user_id: order.user_id,
          balance: updatedUser.balance,
          amount: totalAmount,
          type: "topup",
        },
      });

      // ⑤ 扩展钩子（佣金结算等；REFERRAL_MODE === "topup" 时由上层注入）
      if (this.afterCredit) {
        await this.afterCredit(tx, {
          id: order.id,
          order_id: order.order_id,
          user_id: order.user_id,
          price: order.price,
          bonus: order.bonus,
        });
      }

      // 本地确认入账 → 撤销待触发的超时取消
      await this.scheduler.cancel?.(order.id);

      this.logger.info(`topup credited ${notify.order_id}: +${totalAmount} (price=${order.price} bonus=${order.bonus})`);
      return { credited: true, order_id: notify.order_id, amount: totalAmount };
    });

    return { ...outcome, response: notify.response };
  }

  /* ------------------------------------------------------------------ */
  /* 取消                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * 10 分钟未支付自动取消（对齐原版 cancelUnpaidOrder）。
   * **只本地改状态**（原版行为，缺陷 15）；仅当 cancelUpstreamOnLocalCancel=true 才调上游。
   */
  async cancelUnpaidOrder(orderId: number): Promise<boolean> {
    const order = await db.topupOrder.findUnique({ where: { id: orderId } });
    if (!order) return false;

    const decision = evaluateTransition(order.status as TopupState, "timeout_cancel");
    if (!decision.allowed || decision.idempotent) {
      this.logger.info(`auto-cancel skipped for #${orderId} (status=${order.status})`);
      return false;
    }

    await this.applyLocalCancel(order.id, "timeout_cancel");
    this.logger.info(`unpaid order auto-cancelled #${orderId} (${order.order_id})`);
    return true;
  }

  /** 用户主动取消（原版 PATCH /api/topup/:id/cancel → 调上游关单） */
  async cancelByUser(orderId: number, userId: number): Promise<void> {
    const order = await db.topupOrder.findFirst({ where: { id: orderId, user_id: userId } });
    if (!order) throw new OrderNotFoundError("充值订单不存在");

    const decision = evaluateTransition(order.status as TopupState, "user_cancel");
    if (!decision.allowed || decision.idempotent) {
      throw new OrderStateError(`订单当前状态（${order.status}）不可取消`);
    }

    // 用户取消 → 上游关单（原版语义；EPay/Heleket 为空实现）
    await this.cancelUpstream(order.payment_id, order.trade_id);
    await this.applyLocalCancel(order.id, "user_cancel");
    this.logger.info(`order cancelled by user #${orderId} (${order.order_id})`);
  }

  /** 管理员手动标记已付（对齐原版 TopupService.markAsPaid） */
  async markAsPaid(orderId: number): Promise<boolean> {
    const order = await db.topupOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new OrderNotFoundError("充值订单不存在");

    const decision = evaluateTransition(order.status as TopupState, "admin_mark_paid");
    if (!decision.allowed) throw new OrderStateError(decision.reason ?? "订单状态不允许入账");
    if (decision.idempotent) {
      this.logger.warn(`markAsPaid: order #${orderId} already ${order.status}`);
      return false;
    }

    const totalAmount = order.price + order.bonus;
    await db.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: order.user_id },
        data: { balance: { increment: totalAmount } },
        select: { balance: true },
      });
      await tx.topupOrder.update({
        where: { id: order.id },
        data: { status: "success", balance: { increment: totalAmount } },
      });
      await tx.balanceLog.create({
        data: {
          user_id: order.user_id,
          balance: updatedUser.balance,
          amount: totalAmount,
          type: "topup",
        },
      });
      if (this.afterCredit) {
        await this.afterCredit(tx, {
          id: order.id,
          order_id: order.order_id,
          user_id: order.user_id,
          price: order.price,
          bonus: order.bonus,
        });
      }
    });
    await this.scheduler.cancel?.(order.id);
    return true;
  }

  /* ------------------------------------------------------------------ */

  private async applyLocalCancel(
    id: number,
    action: Extract<TopupAction, "timeout_cancel" | "user_cancel">,
  ): Promise<void> {
    const target = evaluateTransition("pending", action).next;
    // 条件更新（乐观锁）：只有非 success 的订单才能落到 cancelled
    await db.topupOrder.updateMany({
      where: { id, status: { not: "success" } },
      data: { status: target },
    });
    await this.scheduler.cancel?.(id);
  }

  private async cancelUpstream(paymentId: number, tradeId: string | null): Promise<void> {
    if (!this.cancelUpstreamOnLocalCancel && !tradeId) return;
    const payment = await db.payment.findUnique({ where: { id: paymentId } });
    if (!payment) return;
    try {
      const gateway = getPaymentGateway(payment, { siteUrl: env.siteUrl });
      await gateway.cancelPayment(tradeId ?? "");
    } catch (e) {
      // 上游关单失败不应阻断本地取消（原版对 EPay 亦为空实现）
      if (e instanceof GatewayApiError) {
        this.logger.warn(`upstream cancel failed for payment ${paymentId}: ${e.message}`);
        return;
      }
      throw e;
    }
  }

  /** 单用户互斥锁（Redis SET NX EX；Redis 不可用时降级为直通，与原版 Redlock 语义近似） */
  private async withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    // TEN-02：锁是账户级资源（一个用户可属多个 workspace），走 `ws:global:topup:order:<userId>`。
    const key = RedisKeys.topupOrderLock(userId);
    let acquired = false;
    try {
      acquired = (await redis.set(key, String(Date.now()), "EX", USER_LOCK_TTL_SECONDS, "NX")) === "OK";
    } catch {
      this.logger.warn("redis unavailable; skipping topup user lock");
    }
    if (!acquired) {
      // 锁被占用：给一次短等待重试机会（原版 Redlock 会自动重试）
      await new Promise((r) => setTimeout(r, 200));
      try {
        acquired = (await redis.set(key, String(Date.now()), "EX", USER_LOCK_TTL_SECONDS, "NX")) === "OK";
      } catch {
        /* ignore */
      }
      if (!acquired) throw new OrderStateError("操作过于频繁，请稍后重试");
    }
    try {
      return await fn();
    } finally {
      try {
        await redis.del(key);
      } catch {
        /* ignore */
      }
    }
  }
}

/** 进程级单例（路由层直接 import 使用） */
export const topupOrderService = new TopupOrderService();
