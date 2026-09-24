import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { createHash } from "node:crypto";

/**
 * TEN-03 邮箱令牌服务离线测试（不连 MySQL / Redis）。
 *
 * 用内存数据结构替身替换 `../db.ts`，覆盖 PLAN §TEN-03 的三条验收：
 *   1. token **过期**即失效（验证 24h / 重置 1h）；
 *   2. token **单次使用**：第二次消费一律拒绝（含并发竞争——只有一个 updateMany 能命中）；
 *   3. **邮箱枚举防护**：forgot-password 对存在/不存在的邮箱走同一路径；
 * 另加：用途隔离（验证 token 不能当重置 token 用）、发新即作废旧 token、
 * 明文不落库（只存 sha256 哈希）。
 */

/* ------------------------------------------------------------------ */
/* 内存 DB 替身                                                        */
/* ------------------------------------------------------------------ */

interface Row {
  id: number;
  user_id: number;
  email: string;
  purpose: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

const users: { id: number; email: string }[] = [];
const rows: Row[] = [];
let nextId = 1;

/** 重置用例间的全局状态（每个用例都全新）。 */
function resetState(): void {
  users.length = 0;
  rows.length = 0;
  nextId = 1;
}

/**
 * 可控时钟：被测模块用 `new Date(Date.now() + ttl)` 计算过期时间。
 * 直接把 `Date.now` 打桩为「真实时间 + 偏移」，两个过期用例因此不需要真等 1 小时。
 * bun 的 mock.system 不可用（bun:test 1.4 无该 API），这里用最朴素的替换/还原。
 */
let clockOffsetMs = 0;
const realNow = Date.now.bind(Date);
function offsetClock(ms: number): void {
  clockOffsetMs += ms;
}
/** 把全局 Date.now 拨快；必须与 restoreClock 成对使用。 */
function shiftDateNow(): void {
  Date.now = () => realNow() + clockOffsetMs;
}
function restoreDateNow(): void {
  Date.now = realNow;
}

interface Tx {
  emailVerification: {
    updateMany(args: { where: Record<string, unknown>; data: { used_at: Date } }): Promise<{ count: number }>;
    create(args: { data: Omit<Row, "id"> }): Promise<Row>;
    findFirst(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, string>;
      select?: Record<string, boolean>;
    }): Promise<Record<string, unknown> | null>;
    findUnique(args: { where: { token_hash: string } }): Promise<Row | null>;
  };
  user: {
    findUnique(args: { where: { email?: string; id?: number } }): Promise<{ id: number; email: string } | null>;
    update(args: { where: { id: number }; data: Record<string, unknown> }): Promise<unknown>;
  };
}

const tx: Tx = {
  emailVerification: {
    async updateMany({ where, data }) {
      let targets = rows.filter((r) => {
        for (const [k, v] of Object.entries(where)) {
          if (k === "used_at" || k === "expires_at") continue;
          if (k === "purpose" && r.purpose !== v) return false;
          if (k === "user_id" && r.user_id !== v) return false;
          if (k === "token_hash" && r.token_hash !== v) return false;
          if (k === "id" && r.id !== v) return false;
        }
        return true;
      });
      // 模拟 `used_at: null` 条件：只有未使用的才被计入/更新
      if (where.used_at === null) {
        const usable = targets.filter((r) => r.used_at === null);
        if (data.used_at) for (const r of usable) r.used_at = data.used_at;
        return { count: usable.length };
      }
      if (data.used_at) for (const r of targets) r.used_at = data.used_at;
      return { count: targets.length };
    },
    async create({ data }) {
      // MySQL 侧 `used_at` 无默认值，但 Prisma 的可空 DateTime 允许 JSON null / undefined；
      // 这里统一补 null，模拟「新建即未使用」。
      const row: Row = { ...data, id: nextId++, used_at: data.used_at ?? null };
      rows.push(row);
      return row;
    },
    async findFirst({ where, orderBy, select }): Promise<Record<string, unknown> | null> {
      let found = rows.filter((r) => {
        for (const [k, v] of Object.entries(where)) {
          if (k === "used_at" || k === "expires_at") continue;
          if (k === "purpose" && r.purpose !== v) return false;
          if (k === "user_id" && r.user_id !== v) return false;
          if (k === "email" && r.email !== v) return false;
        }
        return true;
      });
      if (where.used_at === null) found = found.filter((r) => r.used_at === null);
      if (orderBy?.created_at === "desc") found = [...found].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      if (!found.length) return null;
      if (select) {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(select)) out[key] = (found[0] as unknown as Record<string, unknown>)[key];
        return out;
      }
      return found[0] as unknown as Record<string, unknown>;
    },
    async findUnique({ where }) {
      return rows.find((r) => r.token_hash === where.token_hash) ?? null;
    },
  },
  user: {
    async findUnique({ where }) {
      if (where.email) return users.find((u) => u.email === where.email) ?? null;
      if (where.id) return users.find((u) => u.id === where.id) ?? null;
      return null;
    },
    async update() {
      return {};
    },
  },
};

const dbStub = {
  $transaction: async (fn: (t: Tx) => unknown) => fn(tx),
  emailVerification: tx.emailVerification,
  user: tx.user,
};

// mock.module 必须在被测模块 import **之前**注册（与 config-pusher-dedup 测试同一模式）。
// 路径必须是「与 mail-tokens.ts 里 `../db.ts` / `../env.ts` 解析到的同一文件」。
const MODULE_DB = new URL("../../db.ts", import.meta.url).pathname;
const MODULE_ENV = new URL("../../env.ts", import.meta.url).pathname;

mock.module(MODULE_DB, () => ({ db: dbStub }));
mock.module(MODULE_ENV, () => ({
  env: {
    siteUrl: "https://tunex.example",
    emailVerifyTtlSeconds: 24 * 60 * 60,
    resendVerificationIntervalSeconds: 60,
  },
}));

const tokens = await import("../mail-tokens.ts");

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  resetState();
  clockOffsetMs = 0;
  shiftDateNow();
  users.push({ id: 7, email: "alice@example.test" });
  users.push({ id: 9, email: "bob@example.test" });
});

afterEach(() => {
  restoreDateNow();
});

describe("issueEmailToken", () => {
  test("只存哈希：落库的是 sha256(token) 十六进制，明文不外泄", async () => {
    const { token } = await tokens.issueEmailToken(7, "alice@example.test", "email_verify");
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const stored = rows.find((r) => r.user_id === 7);
    expect(stored?.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(stored?.token_hash).not.toContain(token);
  });

  test("验证邮件 24h / 重置 1h，各自按用途计时", async () => {
    const v = await tokens.issueEmailToken(7, "alice@example.test", "email_verify");
    const r = await tokens.issueEmailToken(7, "alice@example.test", "password_reset");
    // 容差 1ms：被测模块与服务分别在两个时刻读 Date.now()，跨毫秒属正常。
    expect(Math.abs(v.expiresAt.getTime() - realNow() - 24 * 60 * 60 * 1000)).toBeLessThanOrEqual(1);
    expect(Math.abs(r.expiresAt.getTime() - realNow() - 60 * 60 * 1000)).toBeLessThanOrEqual(1);
  });

  test("同一用户同用途发新 token 时，旧的立即作废", async () => {
    const first = await tokens.issueEmailToken(7, "alice@example.test", "email_verify");
    await tokens.issueEmailToken(7, "alice@example.test", "email_verify");
    const before = rows.filter((r) => r.user_id === 7 && r.used_at === null);
    expect(before).toHaveLength(1);
    const stale = await tokens.consumeEmailToken(first.token, "email_verify");
    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.reason).toBe("already_used");
  });

  test("不同用途的 token 互不干扰", async () => {
    const v = await tokens.issueEmailToken(7, "alice@example.test", "email_verify");
    const created = rows.filter((r) => r.user_id === 7);
    expect(created).toHaveLength(1); // 新签的 email_verify 只作废同用途旧 token
    const asReset = await tokens.consumeEmailToken(v.token, "password_reset");
    expect(asReset.ok).toBe(false);
    expect(asReset.ok === false && asReset.reason).toBe("invalid_token");
  });
});

describe("consumeEmailToken", () => {
  test("未过期 + 未使用 → 成功并原子置 used_at", async () => {
    const { token } = await tokens.issueEmailToken(9, "bob@example.test", "email_verify");
    const first = await tokens.consumeEmailToken(token, "email_verify");
    expect(first.ok).toBe(true);
    expect(first.ok === true && first.userId).toBe(9);
    expect(first.ok === true && first.email).toBe("bob@example.test");
    expect(rows.find((r) => r.user_id === 9)?.used_at).not.toBeNull();
  });

  test("过期 token → 拒绝，且不消耗其它字段", async () => {
    const { token } = await tokens.issueEmailToken(9, "bob@example.test", "email_verify");
    offsetClock(24 * 60 * 60 * 1000 + 1_000); // 越过 24h
    const late = await tokens.consumeEmailToken(token, "email_verify");
    expect(late.ok).toBe(false);
    expect(late.ok === false && late.reason).toBe("expired");
    expect(rows.find((r) => r.user_id === 9)?.used_at).toBeNull();
  });

  test("重置 token 满 1h 即过期（不是 24h）", async () => {
    const { token } = await tokens.issueEmailToken(9, "bob@example.test", "password_reset");
    offsetClock(60 * 60 * 1000 + 1_000);
    const late = await tokens.consumeEmailToken(token, "password_reset");
    expect(late.ok).toBe(false);
    expect(late.ok === false && late.reason).toBe("expired");
  });

  test("重复使用 → 第二次起一律拒绝（单次使用语义）", async () => {
    const { token } = await tokens.issueEmailToken(9, "bob@example.test", "password_reset");
    expect((await tokens.consumeEmailToken(token, "password_reset")).ok).toBe(true);
    const replay = await tokens.consumeEmailToken(token, "password_reset");
    expect(replay.ok).toBe(false);
    expect(replay.ok === false && replay.reason).toBe("already_used");
  });

  test("伪造 / 乱码 token → invalid_token（与过期/已用形成同一失败面）", async () => {
    await tokens.issueEmailToken(9, "bob@example.test", "password_reset");
    const forged = await tokens.consumeEmailToken("not-a-real-token-xxxxxxxxxxxxxxxx", "password_reset");
    expect(forged.ok).toBe(false);
    expect(forged.ok === false && forged.reason).toBe("invalid_token");
  });

  test("并发竞争：两个相同 token 同时消费，只有一个成功", async () => {
    const { token } = await tokens.issueEmailToken(9, "bob@example.test", "password_reset");
    // 真实竞争由 MySQL 的 updateMany 行数保证；内存替身串行执行，
    // 这里用 Promise.all 触发并验证「第二次必然 already_used」的顺序不变式。
    const [a, b] = await Promise.all([
      tokens.consumeEmailToken(token, "password_reset"),
      tokens.consumeEmailToken(token, "password_reset"),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    expect([a, b].every((r) => r.ok || (r.ok === false && r.reason === "already_used"))).toBe(true);
  });
});

describe("issueForgotPasswordToken（邮箱枚举防护）", () => {
  test("邮箱不存在 → 返回 null（调用方仍返回同一成功响应）", async () => {
    const none = await tokens.issueForgotPasswordToken("nobody@example.test");
    expect(none).toBeNull();
    expect(rows).toHaveLength(0); // 不落库：DB 侧也不留「有人请求过」的痕迹
  });

  test("邮箱存在 → 正常签发 1h 重置 token", async () => {
    const issued = await tokens.issueForgotPasswordToken("alice@example.test");
    expect(issued).not.toBeNull();
    expect(Math.abs(issued!.expiresAt.getTime() - realNow() - 60 * 60 * 1000)).toBeLessThanOrEqual(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe("password_reset");
  });

  test("重复发起 forgot → 旧的未用重置信被作废（不会留下两把钥匙）", async () => {
    const first = await tokens.issueForgotPasswordToken("alice@example.test");
    await tokens.issueForgotPasswordToken("alice@example.test");
    const usable = rows.filter((r) => r.used_at === null);
    expect(usable).toHaveLength(1);
    expect((await tokens.consumeEmailToken(first!.token, "password_reset")).ok).toBe(false);
  });
});

describe("buildTokenLink", () => {
  test("链接指向 SITE_URL + 页面路径，token 已经 URL 编码", () => {
    const link = tokens.buildTokenLink("verify-email", "abc/def+gh=");
    expect(link).toBe("https://tunex.example/verify-email?token=abc%2Fdef%2Bgh%3D");
    expect(tokens.buildTokenLink("reset-password", "t1")).toBe("https://tunex.example/reset-password?token=t1");
  });
});
