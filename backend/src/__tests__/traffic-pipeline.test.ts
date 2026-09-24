/**
 * OPS-01 / OPS-03 流量链路单元测试（不连 MySQL / Redis）。
 *
 * 覆盖 PLAN §OPS-01 与 §OPS-03 的验收项：
 *   1. **采集入库不重复**：同一 (tunnel, date) 缓冲被两轮归档，只入库一次
 *      （SETNX 锁占 + skipDuplicates 撞唯一索引，两条路径都验证）；
 *   2. **归属校验**：无归属/已删隧道的记录不进库，unknown 缓冲键不删别人的数据；
 *   3. **聚合口径与策略流量一致**：`aggregateTrafficRows` 的窗口起点复用
 *      `trafficWindowStart`（与 config-generator / sumWorkspaceTraffic 同源），
 *      同窗口下聚合总量 == 逐行求和；
 *   4. **增量上报的纯判定**：负数/非有限值/零/越权 tunnel_id 各自被拒。
 *
 * 与仓库其它 unit test 同一模式：`mock.module` 屏蔽 db/redis/env，业务逻辑
 * 走 deps 注入的替身（offline-detector / user-keys 都是这个套路）。
 */
import { test, expect, describe, beforeEach, mock } from "bun:test";
import type {
  TrafficArchiveDeps,
  TrafficInsertRow,
} from "../services/traffic-archive.ts";

const ROOT = "/opt/TuneX-email-auth/backend/src";

// env.ts 顶层 fail-fast 校验 secret —— 屏蔽掉（redis-scope.test.ts 同一套路）。
mock.module(`${ROOT}/env.ts`, () => ({
  env: { redisUrl: "redis://127.0.0.1:6399/0", databaseUrl: "mysql://x/y" },
}));

const archive = await import("../services/traffic-archive.ts");
const trafficService = await import("../services/traffic.ts");

const {
  parseTrafficBuffer,
  isDateKey,
  decideTrafficReport,
  accumulateTraffic,
  flushTrafficBuffer,
  trafficArchiveLockKey,
  trafficBufferKey,
  parseTrafficBufferKey,
  trafficDate,
  trafficDayKey,
  TRAFFIC_ARCHIVE_LOCK_TTL_S,
} = archive;

/**
 * 本地日期的 `YYYY-MM-DD` 基准值。
 *
 * 禁用 `new Date(...).toISOString().slice(0,10)` 做期望：UTC+8 下本地午夜
 * 是前一天 16:00Z，toISOString 会倒退一天，期望值本身就是错的。
 */
function localKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 入库 Date（UTC 午夜）→ `YYYY-MM-DD`。 */
function UTCDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/* ================================================================== */
/* 内存 Redis 替身（只实现 archive 用到的四个方法）                      */
/* ================================================================== */

class FakeRedis {
  hashes = new Map<string, Map<string, string>>();
  locks = new Set<string>();
  /** SETNX 行为开关：true 时锁永远抢不到（模拟另一轮正在归档）。 */
  lockAlwaysTaken = false;
  sets: Array<{ key: string; ttl: number }> = [];

  async scan(_cursor: string, ...rest: unknown[]): Promise<[string, string[]]> {
    // 只解析 MATCH 段；测试只传一种 pattern。
    const pattern = String(rest[0] ?? "");
    const rx = new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`);
    return ["0", [...this.hashes.keys()].filter((k) => rx.test(k))];
  }
  async hgetall(key: string): Promise<Record<string, string> | null> {
    const h = this.hashes.get(key);
    if (!h) return null;
    return Object.fromEntries(h);
  }
  async del(key: string): Promise<number> {
    return this.hashes.delete(key) ? 1 : 0;
  }
  /** SET key 1 EX ttl NX：已存在 / 被强制占用 → null（未获得锁）。 */
  async set(key: string, _v: string, ...rest: unknown[]): Promise<string | null> {
    const exIndex = rest.findIndex((r) => r === "EX");
    this.sets.push({ key, ttl: exIndex >= 0 ? Number(rest[exIndex + 1]) : 0 });
    if (this.lockAlwaysTaken) return null;
    if (this.locks.has(key)) return null;
    this.locks.add(key);
    return "OK";
  }
}

/** 内存 DB 替身：tunnel 归属 + tunnelTraffic.createMany。 */
class FakeDb {
  tunnels = new Map<number, number>(); // tunnel_id → workspace_id
  rows: TrafficInsertRow[] = [];
  /** 唯一约束模拟：同 (tunnel_id, dateMs) 已存在时视为重复行。 */
  uniqueKeys = new Set<string>();
  insertCalls = 0;
  insertFails = false;
  /** createMany 返回的 count 模拟：撞唯一索引的行不计入。 */
  returnedCount: number | null = null;

  async insertTraffic(rows: TrafficInsertRow[]): Promise<number> {
    this.insertCalls++;
    if (this.insertFails) throw new Error("mysql down");
    let count = 0;
    for (const r of rows) {
      const uk = `${r.tunnel_id}|${r.date.getTime()}`;
      if (this.uniqueKeys.has(uk)) continue; // 唯一索引：静默跳过
      this.uniqueKeys.add(uk);
      this.rows.push(r);
      count++;
    }
    return this.returnedCount ?? count;
  }
}

function makeDeps(
  redis: FakeRedis,
  db: FakeDb,
  over: Partial<TrafficArchiveDeps> = {},
): TrafficArchiveDeps {
  return {
    listBufferKeys: async () => [...redis.hashes.keys()],
    readBuffer: async (key) => {
      const h = redis.hashes.get(key);
      if (!h) return null;
      // HGETALL 的扁平数组形态（ioredis 返回对象；模块约定用扁平数组）
      const out: string[] = [];
      for (const [k, v] of h) out.push(k, v);
      return out.length > 0 ? out : null;
    },
    clearBuffer: async (key) => {
      redis.hashes.delete(key);
    },
    resolveTunnelWorkspace: async (ids) => {
      const map = new Map<number, number | null>();
      for (const id of ids) map.set(id, db.tunnels.get(id) ?? null);
      return map;
    },
    insertTraffic: (rows) => db.insertTraffic(rows),
    acquireArchiveLock: async (tunnelId, date, ttl) => {
      // 键形态必须与实现同源：直接用实现内的工厂函数，替身里不许抄一份字符串。
      const res = await redis.set(trafficArchiveLockKey(tunnelId, date), "1", "EX", ttl, "NX");
      return res === "OK";
    },
    ...over,
  };
}

/** 写入一个缓冲 hash（field = date, value = 字节）。 */
function seedBuffer(redis: FakeRedis, scope: number, tunnelId: number, date: string, bytes: string) {
  const key = trafficBufferKey(scope, tunnelId);
  const h = redis.hashes.get(key) ?? new Map<string, string>();
  h.set(date, bytes);
  redis.hashes.set(key, h);
  return key;
}

beforeEach(() => {
  // 每个 describe 自带实例；这里只做兜底。
});

/* ================================================================== */
/* 1. 纯解析                                                            */
/* ================================================================== */

describe("parseTrafficBuffer", () => {
  test("扁平数组 → 记录；零值/负数/非法日期/非有限值被丢弃", () => {
    const out = parseTrafficBuffer([
      "2026-09-24", "1024",
      "2026-09-25", "0", // 零增量：不入库（噪声行）
      "2026-09-26", "-1", // 负数：字节计数无意义
      "not-a-date", "512",
      "2026-13-01", "512", // 月份非法
      "2026-09-27", "abc", // 非有限数
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ date: "2026-09-24", traffic: 1024, traffic_cost: 1024 });
  });

  test("空/奇数长度/非数组 → 空数组（不抛）", () => {
    expect(parseTrafficBuffer(null)).toEqual([]);
    expect(parseTrafficBuffer(undefined)).toEqual([]);
    expect(parseTrafficBuffer([])).toEqual([]);
    // 奇数长度：最后一对缺 value，被忽略（不会读到 undefined 之后越界）
    expect(parseTrafficBuffer(["2026-09-24"])).toEqual([]);
  });

  test("多日界共存：同一条隧道的多个 field 各自成记录", () => {
    const out = parseTrafficBuffer(["2026-09-23", "100", "2026-09-24", "200"]);
    expect(out.map((r) => r.date)).toEqual(["2026-09-23", "2026-09-24"]);
    expect(out.map((r) => r.traffic)).toEqual([100, 200]);
  });
});

describe("isDateKey", () => {
  test("只接受真实存在的 YYYY-MM-DD", () => {
    expect(isDateKey("2026-09-24")).toBe(true);
    expect(isDateKey("2026-02-29")).toBe(false); // 2026 非闰年
    expect(isDateKey("2024-02-29")).toBe(true); // 闰年
    expect(isDateKey("2026-9-4")).toBe(false); // 位宽不对
    expect(isDateKey("2026-09-24T00:00:00Z")).toBe(false);
    expect(isDateKey("")).toBe(false);
  });
});

/* ================================================================== */
/* 2. 键生成与解析（TEN-02：scope 必须带，且解析同源）                    */
/* ================================================================== */

describe("traffic buffer keys (TEN-02 scope)", () => {
  test("同 tunnelId 不同 scope → 不同键（两个租户不共用缓冲）", () => {
    expect(trafficBufferKey(1, 42)).toBe("ws:1:tunnel:traffic:42");
    expect(trafficBufferKey(2, 42)).toBe("ws:2:tunnel:traffic:42");
    expect(trafficBufferKey(1, 42)).not.toBe(trafficBufferKey(2, 42));
  });

  test("非法/零 scope → ws:global（不落到某个真实租户）", () => {
    expect(trafficBufferKey(0, 42)).toBe("ws:global:tunnel:traffic:42");
    expect(trafficBufferKey(null, 42)).toBe("ws:global:tunnel:traffic:42");
  });

  test("解析 round-trip；非本模块形态返回 null", () => {
    expect(parseTrafficBufferKey("ws:7:tunnel:traffic:42")).toEqual({ scope: 7, tunnelId: "42" });
    expect(parseTrafficBufferKey("ws:global:tunnel:traffic:42")).toEqual({ scope: 0, tunnelId: "42" });
    // 缺日期段 / 别名 / 裸名一律拒绝
    expect(parseTrafficBufferKey("ws:7:tunnel:traffic:abc")).toBeNull();
    expect(parseTrafficBufferKey("ws:7:tunnel:observer:raw")).toBeNull();
    expect(parseTrafficBufferKey("tunnel:traffic:42")).toBeNull();
    expect(parseTrafficBufferKey("ws:7:tunnel:out_listen")).toBeNull();
  });

  test("归档锁键带 tunnel+date，不同组合互不干扰", () => {
    expect(trafficArchiveLockKey(1, "2026-09-24")).toBe("ws:global:traffic:archived:1:2026-09-24");
    expect(trafficArchiveLockKey(1, "2026-09-24")).not.toBe(trafficArchiveLockKey(1, "2026-09-25"));
    expect(trafficArchiveLockKey(1, "2026-09-24")).not.toBe(trafficArchiveLockKey(2, "2026-09-24"));
  });

  test("锁 TTL 覆盖 worker 10min 周期性重跑的崩溃重试窗口", () => {
    // worker 每 10 分钟归档一轮；TTL 至少一个周期，否则锁过期后重复归档
    // 只能靠唯一索引兜底（那也是兜底，但每轮都会打一次 DB）。
    expect(TRAFFIC_ARCHIVE_LOCK_TTL_S).toBeGreaterThanOrEqual(600);
  });

  test("trafficDate 归一为 UTC 午夜（与既有 date 日界口径一致）", () => {
    const d = trafficDate("2026-09-24");
    expect(d.toISOString()).toBe("2026-09-24T00:00:00.000Z");
  });
});

/* ================================================================== */
/* 3. 入库幂等（OPS-01 / OPS-03 主验收）                                */
/* ================================================================== */

describe("flushTrafficBuffer 幂等性", () => {
  test("第一轮：入库并清缓冲", async () => {
    const redis = new FakeRedis();
    const db = new FakeDb();
    db.tunnels.set(11, 5);
    seedBuffer(redis, 5, 11, "2026-09-24", "4096");

    const r = await flushTrafficBuffer(makeDeps(redis, db));
    expect(r).toMatchObject({ scanned: 1, keys: 1, records: 1, inserted: 1, duplicates: 0, skipped: 0, errors: 0 });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ tunnel_id: 11, traffic: 4096 });
    expect(redis.hashes.size).toBe(0); // 读走即删
    expect(db.insertCalls).toBe(1);
  });

  test("第二轮扫到同一缓冲（崩溃在写库与删缓冲之间）→ 零新增，计入 duplicates", async () => {
    const redis = new FakeRedis();
    const db = new FakeDb();
    db.tunnels.set(11, 5);
    seedBuffer(redis, 5, 11, "2026-09-24", "4096");

    // 第一轮：真实入库 + 清缓冲
    await flushTrafficBuffer(makeDeps(redis, db));
    expect(db.rows).toHaveLength(1);
    // 崩溃场景：缓冲还在（第一轮清理没执行），重新塞回去
    seedBuffer(redis, 5, 11, "2026-09-24", "4096");

    const r2 = await flushTrafficBuffer(makeDeps(redis, db));
    // 关键断言：同一 (tunnel, date) 只入库一次
    expect(db.rows).toHaveLength(1);
    expect(r2.inserted).toBe(0);
    expect(r2.duplicates).toBeGreaterThanOrEqual(1);
  });

  test("锁抢不到（另一轮正在归档）→ 该组合跳过，不写库", async () => {
    const redis = new FakeRedis();
    const db = new FakeDb();
    db.tunnels.set(11, 5);
    const key = seedBuffer(redis, 5, 11, "2026-09-24", "4096");
    // 先占住锁：模拟并发轮次（键形态与实现同源）
    await redis.set(trafficArchiveLockKey(11, "2026-09-24"), "1", "EX", 600, "NX");

    const r = await flushTrafficBuffer(makeDeps(redis, db));
    expect(db.rows).toHaveLength(0);
    expect(r.duplicates).toBe(1);
    expect(r.inserted).toBe(0);
    // 没有可写行 → 不调 createMany
    expect(db.insertCalls).toBe(0);
    // 缓冲被清（该轮已判定完毕）
    expect(redis.hashes.has(key)).toBe(false);
  });

  test("createMany 返回 count < 行数 → 差额计入 duplicates（唯一索引静默跳过）", async () => {
    const redis = new FakeRedis();
    const db = new FakeDb();
    db.tunnels.set(11, 5);
    seedBuffer(redis, 5, 11, "2026-09-24", "4096");
    seedBuffer(redis, 5, 11, "2026-09-25", "8192");
    // 预置 09-25 已归档（唯一约束），createMany 只吃下 09-24 那行
    db.uniqueKeys.add(`11|${trafficDate("2026-09-25").getTime()}`);

    const r = await flushTrafficBuffer(makeDeps(redis, db));
    expect(r.records).toBe(2);
    expect(r.inserted).toBe(1);
    expect(r.duplicates).toBe(1);
    expect(db.rows.map((x) => UTCDayKey(x.date))).toEqual(["2026-09-24"]);
  });

  test("入库抛错 → 计入 errors 且缓冲保留（下一轮重试）", async () => {
    const redis = new FakeRedis();
    const db = new FakeDb();
    db.tunnels.set(11, 5);
    db.insertFails = true;
    const key = seedBuffer(redis, 5, 11, "2026-09-24", "4096");

    const r = await flushTrafficBuffer(makeDeps(redis, db));
    expect(r.errors).toBe(1);
    expect(r.inserted).toBe(0);
    // 缓冲必须保留：丢了就是永久丢流量
    expect(redis.hashes.has(key)).toBe(true);
  });

  test("单条失败不阻断其它缓冲键", async () => {
    const redis = new FakeRedis();
    const db = new FakeDb();
    db.tunnels.set(11, 5);
    db.tunnels.set(12, 5);
    seedBuffer(redis, 5, 11, "2026-09-24", "4096");
    const badKey = seedBuffer(redis, 5, 12, "2026-09-24", "8192");
    const deps = makeDeps(redis, db, {
      readBuffer: async (key) => {
        if (key === badKey) throw new Error("redis read failed");
        const h = redis.hashes.get(key);
        if (!h) return null;
        const out: string[] = [];
        for (const [k, v] of h) out.push(k, v);
        return out.length > 0 ? out : null;
      },
    });
    const r = await flushTrafficBuffer(deps);
    expect(r.keys).toBe(2);
    expect(r.errors).toBe(1);
    expect(r.inserted).toBe(1);
    expect(db.rows.map((x) => x.tunnel_id)).toEqual([11]);
  });
});

/* ================================================================== */
/* 4. 归属与跨租户                                                      */
/* ================================================================== */

describe("flushTrafficBuffer 归属校验", () => {
  test("隧道已删（解析不到 workspace）→ skipped，不入库", async () => {
    const redis = new FakeRedis();
    const db = new FakeDb(); // 没有任何 tunnel
    seedBuffer(redis, 5, 999, "2026-09-24", "4096");

    const r = await flushTrafficBuffer(makeDeps(redis, db));
    expect(r.records).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.inserted).toBe(0);
    expect(db.rows).toHaveLength(0);
  });

  test("非本模块形态的键不删别人的数据（scanned 但不 keys、不动）", async () => {
    const redis = new FakeRedis();
    const db = new FakeDb();
    // 别人的 hash（observer 队列是 list，但同形态 key 也不该被删）
    redis.hashes.set("ws:3:node:7:n1:offline", new Map([["x", "1"]]));
    // 历史裸名流量缓冲：不带 scope 前缀，本模块的解析器必须拒绝
    redis.hashes.set("tunnel:traffic:42", new Map([["2026-09-24", "100"]]));
    redis.hashes.set("random", new Map([["a", "b"]]));

    const r = await flushTrafficBuffer(makeDeps(redis, db));
    expect(r.scanned).toBe(3);
    expect(r.keys).toBe(0);
    // 关键的「不破坏」断言：三个键原样还在
    expect(redis.hashes.has("ws:3:node:7:n1:offline")).toBe(true);
    expect(redis.hashes.has("tunnel:traffic:42")).toBe(true);
    expect(redis.hashes.has("random")).toBe(true);
  });

  test("全脏数据/全零的缓冲 → 清掉空壳，不反复重扫", async () => {
    const redis = new FakeRedis();
    const db = new FakeDb();
    db.tunnels.set(11, 5);
    const key = seedBuffer(redis, 5, 11, "2026-09-24", "0");

    const r = await flushTrafficBuffer(makeDeps(redis, db));
    expect(r.keys).toBe(1);
    expect(r.records).toBe(0);
    expect(r.inserted).toBe(0);
    expect(redis.hashes.has(key)).toBe(false);
  });

  test("不同 workspace 的同 tunnelId 缓冲各自归档到各自归属", async () => {
    const redis = new FakeRedis();
    const db = new FakeDb();
    // 注意：tunnel_id 全局唯一，两个 workspace 各有一条隧道（id 不同）
    db.tunnels.set(11, 5);
    db.tunnels.set(21, 6);
    seedBuffer(redis, 5, 11, "2026-09-24", "1024");
    seedBuffer(redis, 6, 21, "2026-09-24", "2048");

    const r = await flushTrafficBuffer(makeDeps(redis, db));
    expect(r.inserted).toBe(2);
    const rows = [...db.rows].sort((a, b) => a.tunnel_id - b.tunnel_id);
    expect(rows[0]).toMatchObject({ tunnel_id: 11, traffic: 1024 });
    expect(rows[1]).toMatchObject({ tunnel_id: 21, traffic: 2048 });
  });

  test("workspace_id 为 null 的隧道行：按未知处理跳过", async () => {
    const redis = new FakeRedis();
    const db = new FakeDb();
    // findMany 不返回该行 → resolveTunnelWorkspace 给 null
    seedBuffer(redis, 5, 31, "2026-09-24", "999");

    const r = await flushTrafficBuffer(makeDeps(redis, db));
    expect(r.skipped).toBe(1);
    expect(db.rows).toHaveLength(0);
  });
});

/* ================================================================== */
/* 5. 上报纯判定（采集入口）                                            */
/* ================================================================== */

describe("decideTrafficReport", () => {
  const allowed = new Set([1, 2, 3]);

  test("合法增量全部接受", () => {
    const r = decideTrafficReport([{ tunnel_id: 1, bytes: 100 }, { tunnel_id: 3, bytes: 0.5 }], allowed);
    expect(r.accepted).toHaveLength(2);
    expect(r.rejected).toHaveLength(0);
  });

  test("零增量 / 负数 / 非有限数 / 隧道 id 非法 → 逐项拒绝", () => {
    const r = decideTrafficReport(
      [
        { tunnel_id: 1, bytes: 0 },
        { tunnel_id: 1, bytes: -5 },
        { tunnel_id: 1, bytes: Number.NaN },
        { tunnel_id: 1, bytes: Number.POSITIVE_INFINITY },
        { tunnel_id: 0, bytes: 100 },
        { tunnel_id: -2, bytes: 100 },
        { tunnel_id: 1.5, bytes: 100 },
      ],
      allowed,
    );
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(7);
    expect(r.rejected.every((x) => x.reason === "malformed" || x.reason === "no_delta")).toBe(true);
  });

  test("越权 tunnel_id → tunnel_not_in_scope（fail-closed）", () => {
    const r = decideTrafficReport(
      [
        { tunnel_id: 1, bytes: 100 }, // 合法
        { tunnel_id: 99, bytes: 100 }, // 别的 workspace
      ],
      allowed,
    );
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.tunnel_id).toBe(1);
    expect(r.rejected).toEqual([{ tunnel_id: 99, reason: "tunnel_not_in_scope" }]);
  });

  test("空白名单 → 全部拒绝（该 workspace 一条隧道都没有）", () => {
    const r = decideTrafficReport([{ tunnel_id: 1, bytes: 100 }], new Set());
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0]).toEqual({ tunnel_id: 1, reason: "tunnel_not_in_scope" });
  });

  test("allowedTunnelIds 为 null → 跳过归属校验（仅测试/内部）", () => {
    const r = decideTrafficReport([{ tunnel_id: 77, bytes: 5 }], null);
    expect(r.accepted).toEqual([{ tunnel_id: 77, bytes: 5 }]);
  });

  test("非数组载荷 → malformed，不抛", () => {
    expect(decideTrafficReport(null, allowed).rejected).toEqual([{ tunnel_id: null, reason: "malformed" }]);
    expect(decideTrafficReport("x", allowed).rejected).toEqual([{ tunnel_id: null, reason: "malformed" }]);
    expect(decideTrafficReport([null, 42, "str"], allowed).rejected).toHaveLength(3);
  });
});

describe("accumulateTraffic", () => {
  test("逐条 HINCRBY 到 (scope, tunnelId) 键，field 为日界", async () => {
    const calls: Array<{ key: string; field: string; by: number }> = [];
    const n = await accumulateTraffic(
      5,
      [11, 12],
      [1024, 2048],
      {
        async hincrBy(key, field, by) {
          calls.push({ key, field, by });
        },
      },
      "2026-09-24",
    );
    expect(n).toBe(2);
    expect(calls).toEqual([
      { key: "ws:5:tunnel:traffic:11", field: "2026-09-24", by: 1024 },
      { key: "ws:5:tunnel:traffic:12", field: "2026-09-24", by: 2048 },
    ]);
  });
});

describe("trafficDayKey", () => {
  test("本地零点日界", () => {
    const d = new Date(2026, 8, 24, 23, 30, 0); // 2026-09-24 23:30 local
    expect(trafficDayKey(d)).toBe(localKey(new Date(2026, 8, 24)));
  });
});

/* ================================================================== */
/* 6. 聚合口径（OPS-03：与策略流量一致）                                */
/* ================================================================== */

const { aggregateTrafficRows, fillDays, getWorkspaceTrafficSummary, dayKeyOf } = trafficService;

/** 构造聚合行（date 会按本地零点归一，与 archive 写库口径一致）。 */
function aggRow(
  tunnelId: number,
  dateKey: string,
  bytes: number,
  name = `t${tunnelId}`,
): Parameters<typeof aggregateTrafficRows>[0][number] {
  return {
    tunnel_id: tunnelId,
    traffic: bytes,
    traffic_cost: bytes,
    date: new Date(`${dateKey}T00:00:00`),
    tunnel: { name, tunnel_type: "tcp", in_node_group_id: 1, in_node_group: { name: "g1" } },
  };
}

describe("aggregateTrafficRows 聚合口径", () => {
  test("总量 == 逐行求和（不丢行）", () => {
    const rows = [
      aggRow(1, "2026-09-22", 100),
      aggRow(1, "2026-09-23", 250),
      aggRow(2, "2026-09-22", 50),
      aggRow(2, "2026-09-24", 1.5),
    ];
    const agg = aggregateTrafficRows(rows, { days: 3, now: new Date("2026-09-24T12:00:00Z") });
    const sum = rows.reduce((a, r) => a + r.traffic, 0);
    expect(agg.total_traffic).toBeCloseTo(sum, 2);
  });

  test("按隧道分组按流量降序", () => {
    const agg = aggregateTrafficRows(
      [aggRow(1, "2026-09-23", 10), aggRow(2, "2026-09-23", 900), aggRow(3, "2026-09-23", 100)],
      { days: 2, now: new Date("2026-09-23T00:00:00Z") },
    );
    expect(agg.by_tunnel.map((t) => t.tunnel_id)).toEqual([2, 3, 1]);
    expect(agg.by_tunnel[0]).toMatchObject({ name: "t2", traffic: 900, in_node_group_name: "g1" });
  });

  test("by_day 补齐缺失日界为 0，长度恒为 days", () => {
    const agg = aggregateTrafficRows([aggRow(1, "2026-09-24", 512)], {
      days: 5,
      now: new Date("2026-09-24T10:00:00Z"),
    });
    expect(agg.by_day).toHaveLength(5);
    expect(agg.by_day[4]).toMatchObject({ date: "2026-09-24", traffic: 512 });
    expect(agg.by_day.slice(0, 4).every((p) => p.traffic === 0)).toBe(true);
    // 升序
    const keys = agg.by_day.map((p) => p.date);
    expect([...keys].sort()).toEqual(keys);
  });

  test("空行集 → 全零（不是 undefined/NaN）", () => {
    const agg = aggregateTrafficRows([], { days: 3, now: new Date("2026-09-24T00:00:00Z") });
    expect(agg.total_traffic).toBe(0);
    expect(agg.total_traffic_cost).toBe(0);
    expect(agg.by_tunnel).toEqual([]);
    expect(agg.by_day).toHaveLength(3);
    expect(agg.by_day.every((p) => p.traffic === 0 && p.traffic_cost === 0)).toBe(true);
  });

  test("同隧道同一天多条行 → 累加到同一分组/同一日界", () => {
    const agg = aggregateTrafficRows(
      [aggRow(1, "2026-09-24", 100), aggRow(1, "2026-09-24", 37), aggRow(1, "2026-09-23", 5)],
      { days: 2, now: new Date("2026-09-24T00:00:00Z") },
    );
    expect(agg.by_tunnel).toHaveLength(1);
    expect(agg.by_tunnel[0]!.traffic).toBeCloseTo(142, 2);
    const day = agg.by_day.find((p) => p.date === "2026-09-24")!;
    expect(day.traffic).toBeCloseTo(137, 2);
  });

  test("tunnel 元数据缺失 → 空串/ null（不抛）", () => {
    const rows = [{ tunnel_id: 9, traffic: 1, traffic_cost: 1, date: new Date("2026-09-24T00:00:00") }];
    const agg = aggregateTrafficRows(rows, { days: 1, now: new Date("2026-09-24T00:00:00Z") });
    expect(agg.by_tunnel[0]).toMatchObject({ name: "", tunnel_type: "", in_node_group_id: null, in_node_group_name: null });
  });
});

describe("fillDays / dayKeyOf", () => {
  test("本地零点序列，末位是今天", () => {
    const keys = fillDays(3, new Date(2026, 8, 24, 15, 0, 0));
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(localKey(new Date(2026, 8, 24)));
    expect(keys[0]).toBe(localKey(new Date(2026, 8, 22)));
  });

  test("跨月边界", () => {
    const keys = fillDays(2, new Date(2026, 9, 1, 0, 0, 0)); // 10 月 1 日
    expect(keys[0]).toBe(localKey(new Date(2026, 8, 30)));
    expect(keys[1]).toBe(localKey(new Date(2026, 9, 1)));
  });

  test("dayKeyOf 归一化到日", () => {
    expect(dayKeyOf(new Date(2026, 8, 24, 23, 59))).toBe(localKey(new Date(2026, 8, 24)));
  });
});
