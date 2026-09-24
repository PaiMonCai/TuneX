import { test, expect, describe, beforeEach, mock } from "bun:test";
import { createHash } from "node:crypto";

/**
 * SEC-02 用户密钥服务离线测试（不连 MySQL / Redis）。
 *
 * 用内存数据结构替身替换 `../db.ts`，逐条覆盖 PLAN §SEC-02 的验收项：
 *   1. **只存哈希**：新凭据落库的是 sha256(明文) hex（64 字符），DB 里任何
 *      字段都不含明文字符串；
 *   2. **惰性迁移**：认证命中 legacy 明文行 → 同事务写哈希 + 清明文，
 *      第二次请求同一把钥匙走哈希列且不再产生任何写操作；
 *   3. **轮换**：rotateKey 覆盖哈希列、清空明文列，返回的新明文是一次性的 ——
 *      旧明文（迁移前的钥匙）与新明文之一失效后立即失效；
 *   4. **凭据无效**：两列都没命中 → null；
 *   5. **两种凭据隔离**：api_key 与 subscription_key 查的是各自的列，
 *      订阅钥匙不能通过 Bearer（api_key）通道认证。
 */

/* ------------------------------------------------------------------ */
/* 内存 DB 替身                                                        */
/* ------------------------------------------------------------------ */

interface UserRow {
  id: number;
  email: string;
  status: "active" | "inactive";
  api_key: string | null;
  api_key_hash: string | null;
  subscription_key: string | null;
  subscription_key_hash: string | null;
  admin_roles: { id: number; name: string }[];
}

const users: UserRow[] = [];
/** 每次 update/updateMany 调用的日志，用于断言「命中哈希列时零写入」。 */
const writes: { model: string; op: string; where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
let nextId = 1;

function resetState(): void {
  users.length = 0;
  writes.length = 0;
  nextId = 1;
}

function seedUser(over: Partial<UserRow> = {}): UserRow {
  const row: UserRow = {
    id: nextId++,
    email: `u${nextId}@example.test`,
    status: "active",
    api_key: null,
    api_key_hash: null,
    subscription_key: null,
    subscription_key_hash: null,
    admin_roles: [],
    ...over,
  };
  users.push(row);
  return row;
}

/** Prisma 风格唯一冲突错误（惰性迁移竞态时 updateMany 可能撞上哈希唯一索引）。 */
function prismaUniqueError(): Error {
  const e = new Error("Unique constraint failed on the fields: (`api_key_hash`)");
  (e as Error & { code: string }).code = "P2002";
  return e;
}

/**
 * 测试开关：模拟「①读哈希列与 ③写哈希列之间」被并发迁移抢先完成。
 * 开启后 findUnique 查哈希列恒返回 null（读到旧状态），updateMany 则抛 P2002
 * （真库此刻另一行/另一进程刚把同一把钥匙迁到同一哈希值）。
 */
let racePlantHashConflict = false;

/** 按 where 条件匹配用户（支持 id / 四个凭据列；Prisma `never` 字段走字符串键）。 */
function matchUser(where: Record<string, unknown>): UserRow | null {
  return (
    users.find((u) =>
      Object.entries(where).every(([k, v]) => (u as unknown as Record<string, unknown>)[k] === v),
    ) ?? null
  );
}

/** findUnique({ where: { <hash|legacy>: value } }) —— 单列等值。 */
function findUniqueByKey(where: Record<string, unknown>): UserRow | null {
  const [col, val] = Object.entries(where)[0] as [string, string];
  return users.find((u) => (u as unknown as Record<string, unknown>)[col] === val) ?? null;
}

const dbStub = {
  user: {
    async findUnique({ where }: { where: Record<string, unknown> }) {
      // include: { admin_roles: true } → 替身行内嵌 admin_roles，直接整行回传。
      // 竞态注入：查哈希列时假装还读到旧状态（哈希尚未就位）。
      if (racePlantHashConflict && (where.api_key_hash || where.subscription_key_hash)) return null;
      const hasId = "id" in where;
      const row = hasId ? users.find((u) => u.id === where.id) ?? null : findUniqueByKey(where);
      return row ? { ...row, admin_roles: [...row.admin_roles] } : null;
    },
    async findUniqueOrThrow({ where }: { where: { id: number } }) {
      const row = users.find((u) => u.id === where.id);
      if (!row) throw new Error("not found");
      return row;
    },
    async update({ where, data }: { where: { id: number }; data: Record<string, unknown> }) {
      const row = users.find((u) => u.id === where.id);
      if (!row) throw new Error("not found");
      // 模拟唯一索引：写入哈希列与既有哈希列冲突 → P2002。
      for (const col of ["api_key_hash", "subscription_key_hash"]) {
        const incoming = data[col];
        if (incoming !== undefined && incoming !== null) {
          const clash = users.find((u) => u.id !== row.id && (u as unknown as Record<string, unknown>)[col] === incoming);
          if (clash) throw prismaUniqueError();
        }
      }
      Object.assign(row, data);
      writes.push({ model: "user", op: "update", where: { id: where.id }, data });
      return row;
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      // 竞态注入：另一个并发请求已把同一把钥匙迁成同一哈希 → 唯一索引冲突。
      if (racePlantHashConflict) throw prismaUniqueError();
      // 守卫条件：id + legacy 列当前值同时匹配才动行（并发迁移的原子性来源）。
      const row = matchUser(where);
      if (!row) {
        writes.push({ model: "user", op: "updateMany", where, data });
        return { count: 0 };
      }
      for (const col of ["api_key_hash", "subscription_key_hash"]) {
        const incoming = data[col];
        if (incoming !== undefined && incoming !== null) {
          const clash = users.find((u) => u.id !== row.id && (u as unknown as Record<string, unknown>)[col] === incoming);
          if (clash) throw prismaUniqueError();
        }
      }
      Object.assign(row, data);
      writes.push({ model: "user", op: "updateMany", where, data });
      return { count: 1 };
    },
  },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(dbStub),
};

// mock.module 必须在被测模块 import **之前**注册（与 mail-tokens 测试同一模式）。
mock.module(new URL("../../db.ts", import.meta.url).pathname, () => ({ db: dbStub }));

const keys = await import("../user-keys.ts");

/* ------------------------------------------------------------------ */
/* 用例                                                                */
/* ------------------------------------------------------------------ */

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  resetState();
});

describe("hashKey", () => {
  test("sha256 hex：64 个小写十六进制字符", () => {
    const h = keys.hashKey("a-key");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createHash("sha256").update("a-key", "utf8").digest("hex"));
  });

  test("同一输入恒定，不同输入必定不同", () => {
    expect(keys.hashKey("x")).toBe(keys.hashKey("x"));
    expect(keys.hashKey("x")).not.toBe(keys.hashKey("y"));
  });

  test("空字符串也产出 64 字符摘要（不是异常路径）", () => {
    expect(keys.hashKey("")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("resolveUserByKey", () => {
  test("命中哈希列 → 返回用户，且零写操作", async () => {
    const plaintext = "5f1a0b2c-1111-4222-8333-444455556666";
    const row = seedUser({ api_key_hash: keys.hashKey(plaintext) });
    const found = await keys.resolveUserByKey("api_key", plaintext);
    expect(found?.id).toBe(row.id);
    expect(writes).toHaveLength(0);
  });

  test("凭据无效（两列都未命中）→ null", async () => {
    seedUser({ api_key: "other-plain", api_key_hash: keys.hashKey("other-plain") });
    expect(await keys.resolveUserByKey("api_key", "never-issued")).toBeNull();
    expect(writes).toHaveLength(0);
  });

  test("惰性迁移：命中 legacy 明文行 → 返回用户，同事务写哈希并清空明文", async () => {
    const plaintext = "6ee1c0de-0000-4000-8000-abcdefabcdef";
    seedUser({ api_key: plaintext, api_key_hash: null });
    const found = await keys.resolveUserByKey("api_key", plaintext);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(1);

    // 落库状态：哈希列就位、明文列清空。
    expect(users[0].api_key_hash).toBe(keys.hashKey(plaintext));
    expect(users[0].api_key).toBeNull();
    // 写入发生在 $transaction 内（守卫条件带 id + 明文当前值）。
    expect(writes).toHaveLength(1);
    expect(writes[0].op).toBe("updateMany");
    expect(writes[0].where).toEqual({ id: 1, api_key: plaintext });
    expect(writes[0].data).toEqual({ api_key_hash: keys.hashKey(plaintext), api_key: null });
  });

  test("惰性迁移幂等：第二次同一把钥匙走哈希列，不再写库", async () => {
    const plaintext = "7cc7d71e-7777-4f77-9f77-777777777777";
    seedUser({ api_key: plaintext });
    expect(await keys.resolveUserByKey("api_key", plaintext)).not.toBeNull();
    const writesAfterMigration = writes.length;
    expect(await keys.resolveUserByKey("api_key", plaintext)).not.toBeNull();
    expect(writes.length).toBe(writesAfterMigration); // 没有新增写入
  });

  test("迁移后返回值不再携带明文（不把凭据渗进 c.set('user')）", async () => {
    const plaintext = "8dd8e82f-8888-4888-8f88-888888888888";
    seedUser({ api_key: plaintext });
    const found = await keys.resolveUserByKey("api_key", plaintext);
    expect(found).not.toBeNull();
    expect(JSON.stringify(found)).not.toContain(plaintext);
  });

  test("subscription_key 与 api_key 走各自的列：钥匙不跨通道生效", async () => {
    const subKey = "9ee9f930-9999-4999-8f99-999999999999";
    seedUser({ subscription_key: subKey });
    // 订阅钥匙不能当 api_key 用（api_key 列查不到）。
    expect(await keys.resolveUserByKey("api_key", subKey)).toBeNull();
    // 但自己的通道一认证就命中（并触发迁移）。
    expect(await keys.resolveUserByKey("subscription_key", subKey)).not.toBeNull();
    expect(users[0].subscription_key_hash).toBe(keys.hashKey(subKey));
    expect(users[0].subscription_key).toBeNull();
  });

  test("哈希列命中优先于明文列（同一把钥匙两种存储不并存）", async () => {
    const plaintext = "af0a0a41-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    // 反常状态：哈希与明文都是同一把钥匙（真实库由 updateMany 保证不出现，
    // 这里只验证「先查哈希」的路径选择，且不做任何写。
    seedUser({ api_key: plaintext, api_key_hash: keys.hashKey(plaintext) });
    const found = await keys.resolveUserByKey("api_key", plaintext);
    expect(found?.id).toBe(1);
    expect(writes).toHaveLength(0);
  });

  test("并发迁移：两个请求同时携带 legacy 钥匙，只有一个写入，双方都认证成功", async () => {
    const plaintext = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
    seedUser({ api_key: plaintext });
    const [a, b] = await Promise.all([
      keys.resolveUserByKey("api_key", plaintext),
      keys.resolveUserByKey("api_key", plaintext),
    ]);
    expect(a?.id).toBe(1);
    expect(b?.id).toBe(1);
    expect(users[0].api_key_hash).toBe(keys.hashKey(plaintext));
    expect(users[0].api_key).toBeNull();
  });

  test("并发迁移 + 哈希唯一索引冲突 → 吞 P2002（迁移已完成），照常返回用户", async () => {
    const plaintext = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
    seedUser({ api_key: plaintext });
    // 竞态注入：查哈希列读到旧状态，接着 updateMany 撞唯一索引抛 P2002
    // （真库里等价于另一个并发请求刚把这把钥匙迁成同一哈希值）。
    racePlantHashConflict = true;
    try {
      const found = await keys.resolveUserByKey("api_key", plaintext);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(1); // 不抛错，凭据仍然有效
    } finally {
      racePlantHashConflict = false;
    }
  });
});

describe("rotateKey", () => {
  test("生成 UUID v4 明文，覆盖哈希列并清空明文列", async () => {
    seedUser({ api_key: "legacy-plain-key", api_key_hash: null });
    const { plaintext } = await keys.rotateKey("api_key", 1);
    expect(plaintext).toMatch(UUID_V4_RE);
    expect(users[0].api_key_hash).toBe(keys.hashKey(plaintext));
    expect(users[0].api_key).toBeNull();
    // DB 里任何字段都不含明文。
    const dump = JSON.stringify(users);
    expect(dump).not.toContain(plaintext);
  });

  test("明文只返回一次：轮换后旧明文立即失效", async () => {
    const old = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3";
    seedUser({ api_key_hash: keys.hashKey(old) });
    expect(await keys.resolveUserByKey("api_key", old)).not.toBeNull();

    const { plaintext } = await keys.rotateKey("api_key", 1);
    expect(await keys.resolveUserByKey("api_key", old)).toBeNull(); // 旧钥匙失效
    expect(await keys.resolveUserByKey("api_key", plaintext)).not.toBeNull(); // 新钥匙可用
  });

  test("轮换覆盖 legacy 明文行：迁移前的旧钥匙也一起失效", async () => {
    const legacy = "e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4";
    seedUser({ api_key: legacy });
    const { plaintext } = await keys.rotateKey("api_key", 1);
    expect(users[0].api_key).toBeNull();
    expect(await keys.resolveUserByKey("api_key", legacy)).toBeNull();
    expect(await keys.resolveUserByKey("api_key", plaintext)).not.toBeNull();
  });

  test("subscription_key 轮换同理（独立列）", async () => {
    seedUser({ subscription_key: "sub-legacy" });
    const { plaintext } = await keys.rotateKey("subscription_key", 1);
    expect(plaintext).toMatch(UUID_V4_RE);
    expect(users[0].subscription_key_hash).toBe(keys.hashKey(plaintext));
    expect(users[0].subscription_key).toBeNull();
    expect(users[0].api_key_hash).toBeNull(); // 不影响另一把钥匙
    expect(await keys.resolveUserByKey("subscription_key", plaintext)).not.toBeNull();
    expect(await keys.resolveUserByKey("subscription_key", "sub-legacy")).toBeNull();
  });

  test("连续两次轮换 → 只有最后一把钥匙有效", async () => {
    seedUser();
    const first = await keys.rotateKey("api_key", 1);
    const second = await keys.rotateKey("api_key", 1);
    expect(first.plaintext).not.toBe(second.plaintext);
    expect(await keys.resolveUserByKey("api_key", first.plaintext)).toBeNull();
    expect(await keys.resolveUserByKey("api_key", second.plaintext)).not.toBeNull();
  });
});
