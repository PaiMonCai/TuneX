/**
 * 个人凭据（api_key / subscription_key）哈希化与轮换 —— SEC-02 收尾
 *
 * ── 为什么改 ──
 *  此前 `user.api_key` / `user.subscription_key` 以 **UUID v4 明文**存库，
 *  Bearer 认证直接 `where: { api_key: bearer }` 命中明文。拖库即凭据泄露，
 *  且泄露后可被无限期使用（直到用户手动轮换）。
 *
 * ── 现在 ──
 *  新签发的凭据一律 `sha256(明文)` 落库，明文只在响应体里出现一次。
 *  认证查哈希列；命中即视为新凭据。**旧明文行平滑迁移**：认证时先按哈希查，
 *  未命中再按明文查，命中后同事务写入哈希并清空明文 —— 用户无需任何操作，
 *  首次使用即完成迁移（lazy migration，无全量数据订正脚本）。
 *
 *  轮换（settings 端点）= 生成新 UUID + 覆盖哈希列 + 清空明文列。
 *  旧凭据立即失效（哈希列被覆盖，明文列为空）。
 *
 * ── 不做什么（明确的边界）──
 *  · 不加 `*_rotated_at` 列：审计走 `audit_log`（中间件已对 /settings/* 留痕），
 *    不为单一事件扩表。
 *  · 不轮换 JWT 签名密钥 / Fernet key：那是部署层（env）的范畴，见
 *    `crypto/keys.ts` 与运维文档。
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { db } from "../db.ts";

export type UserKeyKind = "api_key" | "subscription_key";

/** sha256 hex（64 字符，对应 DB 列 `CHAR(64)`）。 */
export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/** 恒定时间比较（哈希等长时；长度不同直接 false，timingSafeEqual 会抛错）。 */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const COLUMN: Record<
  UserKeyKind,
  { hash: "api_key_hash" | "subscription_key_hash"; legacy: "api_key" | "subscription_key" }
> = {
  api_key: { hash: "api_key_hash", legacy: "api_key" },
  subscription_key: { hash: "subscription_key_hash", legacy: "subscription_key" },
};

/**
 * 按明文凭据解析用户（先哈希列，后明文列惰性迁移）。
 *
 * ① 哈希列：新凭据的唯一索引等值命中，**只读不写**；
 * ② 明文列：存量老行（迁移前的用户）。命中即视为凭据有效，并**同事务**写入
 *    哈希、清空明文（惰性迁移）——此后再拿同一把钥匙只会命中 ①；
 * ③ 返回 null 表示凭据无效（两列都没命中，或复核失败）。
 */
export async function resolveUserByKey(kind: UserKeyKind, plaintext: string) {
  const { hash: hashCol, legacy: legacyCol } = COLUMN[kind];
  const hashed = hashKey(plaintext);

  // ① 新凭据：按哈希查（唯一索引）。
  const byHash = await db.user.findUnique({
    where: { [hashCol]: hashed } as never,
    include: { admin_roles: true },
  });
  if (byHash) return byHash;

  // ② 旧明文行：按明文查；未命中 → 凭据无效。
  const legacy = await db.user.findUnique({
    where: { [legacyCol]: plaintext } as never,
    include: { admin_roles: true },
  });
  if (!legacy) return null;

  // 防御：①的等值匹配已保证 stored === plaintext，这一步防的是「查到之后、写库
  // 之前」明文列被并发清空的竞态（恒定时间比较，无短答侧信道）。
  const stored = (legacy as unknown as Record<string, unknown>)[legacyCol];
  if (typeof stored !== "string" || !safeEqualHex(stored, plaintext)) return null;

  // ③ 惰性迁移：同事务写哈希 + 清明文。守卫条件带 `id + 明文当前值`，于是
  //    并发下第二个请求 updateMany 命中 0 行（该行已被抢先迁移/轮换），
  //    不重复写、不抛错 —— 持钥人身份没有变，认证结果不受影响。
  try {
    await db.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: { id: legacy.id, [legacyCol]: plaintext } as never,
        data: { [hashCol]: hashed, [legacyCol]: null } as never,
      });
    });
  } catch (e) {
    // 唯一索引冲突（P2002）只可能是「同一把钥匙已被并发路径迁到同一行」——
    // 视为迁移已完成即可；其余错误照常抛出，不吞真实故障。
    if ((e as { code?: string })?.code !== "P2002") throw e;
  }

  // 明文不再随返回值外泄：调用方（中间件 → c.set("user")）只该看到
  // id / status / admin_roles 等字段。
  return { ...legacy, [legacyCol]: null } as unknown as typeof legacy;
}

/**
 * 轮换：生成新 UUID，覆盖哈希列并清空明文列。
 * 返回新凭据的明文（仅此一次可见，调用方必须只把它放进响应体）。
 */
export async function rotateKey(kind: UserKeyKind, userId: number): Promise<{ plaintext: string }> {
  const { hash: hashCol, legacy: legacyCol } = COLUMN[kind];
  const plaintext = randomUUID();
  await db.user.update({
    where: { id: userId },
    data: { [hashCol]: hashKey(plaintext), [legacyCol]: null } as never,
  });
  return { plaintext };
}
