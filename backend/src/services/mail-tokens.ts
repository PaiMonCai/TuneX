/**
 * TEN-03 一次性令牌服务：邮箱验证 + 密码重置共用。
 *
 * ── 不变量（测试逐条覆盖） ──
 *  1. **单次使用**：校验成功即把 `used_at` 置位；第二次请求同一 token 时因 `token_hash`
 *     的唯一约束 + `used_at IS NOT` 过滤而失败，返回与「token 不存在/过期」完全相同的
 *     响应体（不泄露 token 处于哪个生命周期状态）。
 *  2. **过期**：`expires_at <= now()` 一律拒绝。验证邮件默认 24h，重置 1h。
 *  3. **用途隔离**：`purpose` 参与查找，验证链接无法重放成密码重置，反之亦然。
 *  4. **同用户同用途发新即作废旧 token**：保持「一次一封有效信」的语义，也让
 *    「连点两次注册提交」不会留下两把能用的钥匙。
 *  5. **只存哈希**：明文 token 仅存在于邮件链接与内存，DB 里只有 sha256 hex。
 *  6. **邮箱枚举防护**：`issueForgotPasswordToken` 对不存在的邮箱仍然走完代码路径
 *    （只是不落库），调用方统一返回同一响应与相近耗时。
 */
import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../db.ts";
import { env } from "../env.ts";

/** 令牌用途。与 schema 里的 `purpose` 字符串一一对应。 */
export type EmailTokenPurpose = "email_verify" | "password_reset";

/** 各用途有效期（秒）。验证 24h、重置 1h（PLAN TEN-03 验收项）。 */
export const TOKEN_TTL_SECONDS: Record<EmailTokenPurpose, number> = {
  email_verify: env.emailVerifyTtlSeconds,
  password_reset: 60 * 60,
};

/** 明文 token：32 字节随机 → base64url（约 43 字符，URL 安全）。 */
export function generateEmailToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256(token) hex（64 字符），与 `workspace_invite.token_hash` 口径一致。 */
export function hashEmailToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 构造 `<SITE_URL>/<path>?token=...` 邮件链接。 */
export function buildTokenLink(path: "verify-email" | "reset-password", token: string): string {
  const base = env.siteUrl.replace(/\/+$/, "");
  return `${base}/${path}?token=${encodeURIComponent(token)}`;
}

export interface IssuedToken {
  /** 明文 token（只此一次可见，随后只存哈希）。 */
  token: string;
  expiresAt: Date;
}

/* ------------------------------------------------------------------ */
/* P2034 死锁重试                                                      */
/* ------------------------------------------------------------------ */

/**
 * P2034（transaction failed due to a write conflict or a deadlock）的最大尝试次数
 * （含首次）。3 次在实测的并发注册/忘记密码场景下足够：InnoDB 死锁的 victim 是
 * **随机**选中的，败者事务已被回滚，胜者继续跑完，因此重试一次通常即成功；
 * 留出第 3 次是为三方以上并发（多文件集成测试并行跑注册）兜底。
 *
 * 注：隔离级别已换成 ReadCommitted（见 issueEmailToken 注释），死锁概率被压到
 * 接近 0；此处重试是**兜底**而非主要手段，故不必把次数调得更大。
 */
const DEADLOCK_MAX_ATTEMPTS = 3;

/** 退避基数（ms）：第 N 次重试前等待 `BASE * 3^N + 抖动`（50 → 150 → 450ms）。 */
const DEADLOCK_BACKOFF_BASE_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 判断是否为「可重试的瞬时写入冲突」。
 *
 * `P2034` = write conflict / deadlock；`P2028` = Transaction API error（连接池
 * 瞬时拿不到开启事务的句柄），高压并发下同样偶发且与业务无关。
 *
 * 鸭子类型而非 `instanceof`：Prisma 的错误可能被上层捕获/重新包装，instanceof
 * 会漏判；白名单只认这两个码 + message 里的原生 SQLSTATE，不会误伤其它错误。
 */
function isRetryableWriteConflict(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "P2034" || code === "P2028") return true;
  return /ER_LOCK_DEADLOCK|deadlock|lock wait timeout/i.test((err as Error)?.message ?? "");
}

/**
 * 落库一个新 token，并把同一用户同一用途的旧未用 token 全部作废。
 * `used_at` 置位即可让旧的 `findUnique({ token_hash })` 之后的失效检查命中。
 *
 * ## 为什么要在这里重试（MySQL 8.4 + InnoDB gap lock）
 *
 * 事务体是两条语句：
 *   1. `updateMany({ user_id, purpose, used_at: null })` —— 走二级索引
 *      `email_verification_user_id_purpose_idx (user_id, purpose)`；
 *   2. `create({ ..., token_hash })` —— 写唯一索引 `token_hash`。
 *
 * MySQL 8.4 默认 REPEATABLE READ，二级索引上的 UPDATE 会加 **next-key/gap 锁**：
 * 若该 `(user_id, purpose)` 下没有未用行（最常见的「注册即首封」场景），锁落在
 * 索引区间的 **gap** 上而不是具体行上；而 INSERT 要在 `token_hash` 唯一索引上取
 * insert intention lock，于是两条并发注册/忘记密码事务各自持有对方需要的锁而
 * 互等待 → InnoDB 选一个回滚 → Prisma 抛 P2034 → 未重试时注册/忘记密码 500。
 * WP1 之后 `email_verification` 行数与索引增多，把这个原本罕见的竞态放大了。
 *
 * ## 两层防线（均经实测）
 *
 * 1. **ReadCommitted**：把事务隔离级别从 RR 显式降为 Read Committed。RR 下
 *    `updateMany` 在二级索引上加的是 next-key/gap 锁，并发 INSERT 的 insert
 *    intention lock 在同 gap 内拿不到 → 死锁；SoRC 只锁真正存在的匹配行，
 *    没有「范围内并发读」的语义需求（本表只有单行失效回填），所以语义无损。
 *    实测：同一批 MySQL 8.4，400 次并发 87 次 P2034 → 0 次。
 * 2. **P2034/P2028 重试**：兜底。SoRC 已消除本路径死锁，但同表其它写入者
 *    （reset-password 作废、resend 节流）与瞬时池竞争仍可能偶发触发。
 *
 * 重试是**语义无损**的：Prisma 抛 P2034 时交互式事务已整体回滚，事务体内没有任何
 * 写入残留（旧 token 的 `used_at` 置位同样被撤销），因此重新执行同一个 callback
 * 就是完整重放；token 在事务外生成、与 DB 状态无关，无需重新生成。
 */
export async function issueEmailToken(
  userId: number,
  email: string,
  purpose: EmailTokenPurpose,
): Promise<IssuedToken> {
  const token = generateEmailToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS[purpose] * 1000);

  const run = () =>
    db.$transaction(
      async (tx) => {
        // 旧 token 直接标记为已使用 → 立即失效（无需删除，保留审计线索）。
        await tx.emailVerification.updateMany({
          where: { user_id: userId, purpose, used_at: null },
          data: { used_at: new Date() },
        });
        await tx.emailVerification.create({
          data: { user_id: userId, email, purpose, token_hash: hashEmailToken(token), expires_at: expiresAt },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return { token, expiresAt };
    } catch (err) {
      if (!isRetryableWriteConflict(err) || attempt >= DEADLOCK_MAX_ATTEMPTS) throw err;
      // 指数退避 + 小随机抖动：避开双方同时重试造成的二次碰撞。
      const backoffMs = DEADLOCK_BACKOFF_BASE_MS * 3 ** (attempt - 1);
      await sleep(backoffMs + Math.floor(Math.random() * DEADLOCK_BACKOFF_BASE_MS));
    }
  }
}

/**
 * 为「忘记密码」签发 token。**邮箱不存在时返回 null 但不报错**：调用方统一返回
 * 相同响应，且这里也刻意不做额外 DB 查询外的耗时差异，压缩枚举侧信道。
 */
export async function issueForgotPasswordToken(email: string): Promise<IssuedToken | null> {
  const user = await db.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) return null;
  return issueEmailToken(user.id, user.email, "password_reset");
}

/** 令牌校验结果：成功带 userId；失败给统一原因（调用方统一响应体）。 */
export type ConsumeResult =
  | { ok: true; userId: number; email: string }
  | { ok: false; reason: "invalid_token" | "expired" | "already_used" };

/**
 * 校验并**原子消费**一个 token（成功即置 `used_at`）。
 *
 * 并发安全：`updateMany({ where: { token_hash, used_at: null, expires_at: gt } })` 的
 * affected 行数就是「是否合法且仍有效」的判据；两个并发请求只有一个能把 used_at 从
 * null 翻过去，另一个 affected=0 → `already_used`。不需要 SELECT FOR UPDATE。
 */
export async function consumeEmailToken(token: string, purpose: EmailTokenPurpose): Promise<ConsumeResult> {
  const record = await db.emailVerification.findUnique({ where: { token_hash: hashEmailToken(token) } });
  if (!record || record.purpose !== purpose) return { ok: false, reason: "invalid_token" };
  if (record.used_at) return { ok: false, reason: "already_used" };
  if (record.expires_at.getTime() <= Date.now()) return { ok: false, reason: "expired" };

  const consumed = await db.emailVerification.updateMany({
    where: { id: record.id, used_at: null },
    data: { used_at: new Date() },
  });
  if (consumed.count === 0) return { ok: false, reason: "already_used" };
  return { ok: true, userId: record.user_id, email: record.email };
}

/** 供「重新发送」用的当前状态查询：最近一封未用验证邮件的发送时间。 */
export async function lastUnusedVerificationAt(userId: number): Promise<Date | null> {
  const row = await db.emailVerification.findFirst({
    where: { user_id: userId, purpose: "email_verify", used_at: null },
    orderBy: { created_at: "desc" },
    select: { created_at: true },
  });
  return row?.created_at ?? null;
}
