/**
 * 流量计量 · 采集入库（OPS-01 入库半段）
 *
 * 链路（PLAN §OPS-03）：
 *   agent 上报 → Redis hash（`ws:<scope>:tunnel:traffic:<tunnelId>`，field = 计量
 *   日界 `YYYY-MM-DD`，HINCRBYFLOAT 累加字节）→ 本模块归档 → `tunnel_traffic`
 *   → 按 workspace 聚合展示（`services/traffic.ts`）。
 *
 * ── 幂等（PLAN §OPS-01 / §OPS-03 验收「采集入库不重复」）──
 * 归档是**读走即删**的最小事务：`HGETALL` 拿到快照 → 写库 → `DEL` 整个 hash。
 * 唯一的重复风险在「写库成功但进程在 DEL 之前崩掉」，此时同一份缓冲会被下一轮
 * 再归档一次。三重防线：
 *
 *   1. **SETNX 归档锁**：每个 (tunnel_id, date) 组合一个 key
 *      (`ws:global:traffic:archived:<tunnelId>:<date>`)，写库**之前**抢占，
 *      持有 TTL（见 {@link TRAFFIC_ARCHIVE_LOCK_TTL_S}）。崩溃场景下锁会残留，
 *      因此第二道防线交给数据库；
 *   2. **数据库唯一约束**：`tunnel_traffic` 上
 *      (`tunnel_id`, `date`（到日）) 唯一索引。重复归档在第二轮就撞锁冲突
 *      （P2002），该条计入 `duplicates` 而非再次累加；
 *   3. **同 hash 内逐 field 累加 + 原子 HINCRBYFLOAT**：agent 侧同一轮上报
 *      只会累加，不会产生第二条日界记录。
 *
 * 三条防线里 DB 唯一约束才是**最终真相**：SETNX 只是「把重试从每轮一次降为
 * TTL 内一次」的优化，锁过期后仍由唯一索引兜底。因此 net effect 是
 * **同一天同一隧道的流量恰好入库一次**，重复上报被幂等地丢弃。
 *
 * ── 为什么要「读走即删」而不是累加写入 ──
 * tunnel_traffic 语义是「该日界已归档的字节」，不是实时计数器。若用
 * upsert 累加，则任何一次「缓存已删但 DB 回滚」都会永久丢数；读走即删 +
 * 唯一索引则 Crash-safe：要么磁盘上多一份（幂等丢弃），要么缓冲还在（下轮重试）。
 *
 * ── 归属（TEN-02）──
 * 缓冲键带 `ws:<workspace_id>:` 前缀，`tunnel_traffic` 经 `tunnel.workspace_id`
 * 关联。归档时**不信任**缓冲键里的 scope 段做归属——隧道与 workspace 的对应
 * 关系以 MySQL 为准（一次 `findMany` 批量解析），只归档 tunnel_id 真实存在
 * 且归属明确的记录；解析不到归属的一律丢弃并计数（见 {@link flushTrafficBuffer}）。
 */
import type { Prisma } from "@prisma/client";
import {
  trafficBufferPrefix,
  trafficBufferKey,
  parseTrafficBufferKey as parseBufferKey,
  scopedKey,
  scopedPattern,
  GLOBAL_SCOPE,
} from "../tenant-scope.ts";

/** 归档后占位锁的 TTL（秒）：覆盖「写库 → DEL」之间的崩溃重试窗口。 */
export const TRAFFIC_ARCHIVE_LOCK_TTL_S = 6 * 60 * 60;

/** 单轮最多归档的缓冲键数（防一次扫太多把 Redis/DB 打满）。 */
export const TRAFFIC_FLUSH_KEYS_LIMIT = 500;

/**
 * 归档占位锁键：`ws:global:traffic:archived:<tunnelId>:<date>`。
 * 值只是「锁已存在」的标记，锁的存在本身即幂等凭证。
 */
export function trafficArchiveLockKey(tunnelId: number, date: string): string {
  return scopedKey(GLOBAL_SCOPE, "traffic", "archived", String(tunnelId), date);
}

/* ================================================================== */
/* 纯函数：缓冲解析                                                    */
/* ================================================================== */

/** 一条待入库的流量记录。 */
export interface TrafficRecord {
  /**
   * 隧道 id。`parseTrafficBuffer` 只看到 hash 内容（field=日界），拿不到
   * tunnel 归属，故填占位 0；调用方（flushTrafficBuffer）在读键后必须按键
   * 的 scope 段回填真实值，否则归属解析全部落空。
   */
  tunnel_id: number;
  /** 计量日界（`YYYY-MM-DD`，本地时区）。 */
  date: string;
  /** 本日界累计字节（>= 0；非有限数一律丢弃）。 */
  traffic: number;
  /** 计费口径字节（缺省与 traffic 相同；尚无计价体系时为 0 语义的占位）。 */
  traffic_cost: number;
}

/**
 * 解析单个缓冲 hash 的 `HGETALL` 扁平数组（`[f1, v1, f2, v2, ...]`）。
 *
 * 过滤规则（fail-closed）：
 *   · 日界字段必须形如 `YYYY-MM-DD`（否则 agent/历史脏数据 → 丢弃）；
 *   · 数值必须有限且 >= 0 —— 负数在字节计数上没有意义，通常是脏写；
 *   · `traffic === 0` 的记录**跳过**：没有净增量的日界入库只会产生噪声行
 *     （缓冲可能因为 agent 的探测性 HINCRBYFLOAT 0 而过期残留空 hash）。
 */
export function parseTrafficBuffer(entries: string[] | null | undefined): TrafficRecord[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const out: TrafficRecord[] = [];
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const date = entries[i]!;
    const bytes = Number(entries[i + 1]);
    if (!isDateKey(date)) continue;
    if (!Number.isFinite(bytes) || bytes < 0) continue;
    if (bytes === 0) continue;
    out.push({ tunnel_id: 0, date, traffic: bytes, traffic_cost: bytes });
  }
  return out;
}

/**
 * 日界字段形态：`YYYY-MM-DD`（4-2-2 位 + 真实月/日复核）。
 *
 * 复核用 `Date.UTC` + 显式分量回读，**不能**用
 * `new Date(\`${v}T00:00:00Z\`).toISOString()`：在 UTC+8 环境下
 * `new Date("2026-09-24T00:00:00")` 是**本地**午夜（= 09-23T16:00Z），
 * `toISOString().slice(0,10)` 会回退成前一天 —— 所有日界都会被判非法。
 */
export function isDateKey(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/* ================================================================== */
/* 副作用依赖（生产用 {@link defaultTrafficArchiveDeps}；测试注入）        */
/* ================================================================== */

/** Redis 侧最小接口（真实 ioredis 鸭子类型兼容）。 */
export interface TrafficRedisLike {
  scan(cursor: string, ...rest: unknown[]): Promise<[string, string[]]>;
  hgetall(key: string): Promise<Record<string, string> | null>;
  del(key: string): Promise<number>;
  set(key: string, value: string, ...rest: unknown[]): Promise<unknown>;
}

/** DB 侧最小接口（Prisma delegate 鸭子类型兼容）。 */
export interface TrafficDbLike {
  tunnel: {
    findMany(args: {
      where: { id: { in: number[] } };
      select: { id: true; workspace_id: true };
    }): Promise<Array<{ id: number; workspace_id: number }>>;
  };
  tunnelTraffic: {
    createMany(args: { data: TrafficInsertRow[]; skipDuplicates?: boolean }): Promise<{ count: number }>;
  };
}

/** 入库行（date 归一为 UTC 午夜 Date，与既有查询 `date` 日界口径一致）。 */
export interface TrafficInsertRow {
  tunnel_id: number;
  traffic: number;
  traffic_cost: number;
  date: Date;
}

export interface TrafficArchiveDeps {
  /** 扫描全部流量缓冲键（跨租户；key 里带 scope 段，解析后还原归属）。 */
  listBufferKeys(): Promise<string[]>;
  /** 读某个缓冲 hash 的扁平 entries。 */
  readBuffer(key: string): Promise<string[] | null>;
  /** 删除已归档的缓冲 hash。 */
  clearBuffer(key: string): Promise<void>;
  /** 解析 tunnel_id → workspace_id；缺失返回 null（视为未知隧道）。 */
  resolveTunnelWorkspace(ids: number[]): Promise<Map<number, number | null>>;
  /** 批量入库；返回成功条数。 */
  insertTraffic(rows: TrafficInsertRow[]): Promise<number>;
  /** 取归档锁（SETNX）；返回 true 表示本进程获得执行权。 */
  acquireArchiveLock(tunnelId: number, date: string, ttlSeconds: number): Promise<boolean>;
  /** 日志。 */
  log?(message: string, meta: Record<string, unknown>): void;
}

/** 一轮归档的结果统计。 */
export interface TrafficArchiveResult {
  /** 扫描到的缓冲键数。 */
  scanned: number;
  /** 形如 `ws:<scope>:tunnel:traffic:<tunnelId>` 的合法缓冲键数。 */
  keys: number;
  /** 解析出的 (tunnel, date) 组合数。 */
  records: number;
  /** 真正入库的行数。 */
  inserted: number;
  /** 因唯一约束被幂等丢弃的行数（重复归档）。 */
  duplicates: number;
  /** 无归属 / 隧道已删 / 数值非法而丢弃的组合数。 */
  skipped: number;
  /** 处理失败的缓冲键数（异常已吞，仅计数）。 */
  errors: number;
}

/** 日界字符串 → Date（UTC 午夜；与既有 `date` 字段的日界口径一致）。 */
export function trafficDate(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`);
}
/* ================================================================== */
/* 主流程                                                              */
/* ================================================================== */

/**
 * 归档一轮流量缓冲：Redis → MySQL。
 *
 * 每条 (tunnel, date) 独立取锁、入库、清缓冲，单条失败不阻断整轮。
 */
export async function flushTrafficBuffer(deps: TrafficArchiveDeps): Promise<TrafficArchiveResult> {
  const log = deps.log ?? (() => {});
  const result: TrafficArchiveResult = {
    scanned: 0,
    keys: 0,
    records: 0,
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    errors: 0,
  };

  const keys = await deps.listBufferKeys();
  result.scanned = keys.length;

  for (const key of keys) {
    const parsed = parseBufferKey(key);
    if (!parsed) {
      // 非本模块形态（历史裸名键 / 别的模块的 hash）：本模块不识别，只能跳过，
      // 不能顺手删——删掉的就是别人的数据。
      continue;
    }
    // 解析出的 tunnelId 是十进制字符串；入参两侧都按 number 用。
    const bufferTunnelId = Number(parsed.tunnelId);
    if (!Number.isInteger(bufferTunnelId) || bufferTunnelId <= 0) continue;
    result.keys++;
    try {
      const entries = await deps.readBuffer(key);
      if (!entries || entries.length === 0) continue;
      // 键里带 tunnelId（解析器已还原）；hash 里的 field 只是日界，
      // 解析出的记录里 tunnel_id 是占位 0，这里按键的归属回填。
      const records = parseTrafficBuffer(entries).map((r) => ({
        ...r,
        tunnel_id: bufferTunnelId,
      }));
      if (records.length === 0) {
        // 全脏数据 / 全零：清掉空壳，避免无限重扫。
        await deps.clearBuffer(key);
        continue;
      }

      // 归属解析以 MySQL 为准，缓冲键里的 scope 段只用于「这个键属于本模块」的判定。
      const tunnelIds = [...new Set(records.map((r) => r.tunnel_id))];
      const workspaceOf = await deps.resolveTunnelWorkspace(tunnelIds);

      const rows: TrafficInsertRow[] = [];
      for (const rec of records) {
        result.records++;
        const workspaceId = workspaceOf.get(rec.tunnel_id) ?? null;
        if (workspaceId === null) {
          // 隧道已删 / 归属不明 → 丢弃。写不进去的数据进任何桶都是错的。
          result.skipped++;
          continue;
        }
        // 归档锁：在写库之前抢，把「崩溃 → 下一轮重试」压到 TTL 内一次。
        const locked = await deps.acquireArchiveLock(rec.tunnel_id, rec.date, TRAFFIC_ARCHIVE_LOCK_TTL_S);
        if (!locked) {
          // 另一轮刚归档过同一 (tunnel, date)：幂等跳过。
          result.duplicates++;
          continue;
        }
        rows.push({
          tunnel_id: rec.tunnel_id,
          traffic: rec.traffic,
          traffic_cost: rec.traffic_cost,
          date: trafficDate(rec.date),
        });
      }

      if (rows.length > 0) {
        try {
          // createMany + skipDuplicates：命中唯一索引的行被 DB 静默跳过，
          // 这正是「重复归档不重复入库」的最终防线。
          const inserted = await deps.insertTraffic(rows);
          result.inserted += inserted;
          result.duplicates += rows.length - inserted;
        } catch (e) {
          // MySQL 侧异常：保留缓冲等下一轮（锁自然过期后由唯一索引兜底）。
          result.errors++;
          log("[traffic] insert failed", { key, err: (e as Error)?.message });
          continue;
        }
      }

      // 无论本轮是否有新增行，都已处理完毕 → 读走即删。
      await deps.clearBuffer(key);
    } catch (e) {
      result.errors++;
      log("[traffic] failed to process buffer", { key, err: (e as Error)?.message });
    }
  }

  return result;
}

/* ================================================================== */
/* 生产依赖                                                            */
/* ================================================================== */

/** 全量扫描流量缓冲键的 pattern（跨租户，由 parseBufferKey 还原归属）。 */
export function trafficBufferPattern(): string {
  return scopedPattern("*", "tunnel", "traffic", "*");
}

/** 生产实现：真实 Redis + Prisma（懒加载 import，避免单测引入本模块即连库）。 */
export function defaultTrafficArchiveDeps(): TrafficArchiveDeps {
  return {
    async listBufferKeys() {
      const { redis } = await import("../redis.ts");
      const out: string[] = [];
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          trafficBufferPattern(),
          "COUNT",
          200,
        );
        cursor = next;
        for (const k of keys) {
          out.push(k);
          if (out.length >= TRAFFIC_FLUSH_KEYS_LIMIT) return out;
        }
      } while (cursor !== "0");
      return out;
    },
    async readBuffer(key) {
      const { redis } = await import("../redis.ts");
      const hash = await redis.hgetall(key);
      if (!hash) return null;
      const out: string[] = [];
      for (const [k, v] of Object.entries(hash)) out.push(k, v);
      return out.length > 0 ? out : null;
    },
    async clearBuffer(key) {
      const { redis } = await import("../redis.ts");
      await redis.del(key);
    },
    async resolveTunnelWorkspace(ids) {
      const { db } = await import("../db.ts");
      const rows = await db.tunnel.findMany({
        where: { id: { in: ids } },
        select: { id: true, workspace_id: true },
      });
      const map = new Map<number, number | null>();
      for (const id of ids) {
        const found = rows.find((r) => r.id === id);
        map.set(id, found ? found.workspace_id : null);
      }
      return map;
    },
    async insertTraffic(rows) {
      const { db } = await import("../db.ts");
      const res = await db.tunnelTraffic.createMany({ data: rows, skipDuplicates: true });
      return res.count;
    },
    async acquireArchiveLock(tunnelId, date, ttlSeconds) {
      const { redis } = await import("../redis.ts");
      // SET key 1 NX EX ttl —— 原子占锁；已存在返回 null（未获得）。
      const res = await redis.set(trafficArchiveLockKey(tunnelId, date), "1", "EX", ttlSeconds, "NX");
      return res === "OK";
    },
    log: (message, meta) => console.warn(message, meta),
  };
}

/** 缓存键工厂再导出（业务代码从 tenant-scope 单一真相源取）。 */
export { trafficBufferPrefix, trafficBufferKey, parseBufferKey as parseTrafficBufferKey };

/* ================================================================== */
/* 采集：agent 上报 → Redis 缓冲                                       */
/* ================================================================== */

/**
 * 本地计量日界键 `YYYY-MM-DD`（与 tunnel_traffic.date 的日界口径一致）。
 *
 * 用本地分量拼字符串，**不能** `toISOString().slice(0,10)`：
 * UTC+8 下本地午夜 = 前一天 16:00Z，那会把日界整体回退一天。
 */
export function trafficDayKey(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 一条 agent 上报的隧道流量增量。 */
export interface TrafficReportItem {
  tunnel_id: number;
  /** 本轮新增字节（>= 0；非有限数一律丢弃）。 */
  bytes: number;
}

/** 上报拒绝原因（调用方据此记日志/告警；agent 侧应能看到具体原因）。 */
export type TrafficRejectReason =
  /** 字段形态不对（tunnel_id 非正整数 / bytes 非有限数 / 负数） */
  | "malformed"
  /** 增量 <= 0：没有净增量，不入缓冲（探测性上报/重复上报） */
  | "no_delta"
  /** 该隧道不属于上报节点所在的 workspace（越权/串租户） */
  | "tunnel_not_in_scope";

export interface TrafficRejectItem {
  tunnel_id: number | null;
  reason: TrafficRejectReason;
}

/** 上报的纯判定结果：哪些可以 HINCRBY、哪些要拒绝。 */
export interface TrafficReportDecision {
  accepted: Array<{ tunnel_id: number; bytes: number }>;
  rejected: TrafficRejectItem[];
}

/**
 * 纯判定：校验并筛出可入缓冲的上报项。
 *
 * fail-closed：任何一项不合法都不影响其它项（逐项判定），但**全部**不合法时
 * 调用方仍写不了任何东西。`allowedTunnelIds` 为空表示「不做归属校验」
 * （仅测试/内部调用），非空时只接受集合内的 tunnel_id。
 */
export function decideTrafficReport(
  items: unknown,
  allowedTunnelIds: ReadonlySet<number> | null,
): TrafficReportDecision {
  const accepted: TrafficReportDecision["accepted"] = [];
  const rejected: TrafficRejectItem[] = [];
  if (!Array.isArray(items)) {
    return { accepted, rejected: [{ tunnel_id: null, reason: "malformed" }] };
  }
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) {
      rejected.push({ tunnel_id: null, reason: "malformed" });
      continue;
    }
    const item = raw as Partial<TrafficReportItem>;
    // 严格整数校验：不用 Math.trunc 兜底。截断会把 agent 端
    // {tunnel_id: 1.5} 这类脏数据变成「合法的 1 号隧道流量」——
    // 脏数据必须被拒，不能被静默修正。
    // bytes 允许小数：Redis 侧就是 HINCRBYFLOAT，计费口径按浮点累加。
    const tunnelId = typeof item.tunnel_id === "number" ? item.tunnel_id : NaN;
    const bytes = typeof item.bytes === "number" ? item.bytes : NaN;
    if (!Number.isInteger(tunnelId) || tunnelId <= 0 || !Number.isFinite(bytes) || bytes < 0) {
      rejected.push({ tunnel_id: Number.isInteger(tunnelId) ? tunnelId : null, reason: "malformed" });
      continue;
    }
    if (allowedTunnelIds && !allowedTunnelIds.has(tunnelId)) {
      // 归属校验以 MySQL 为准：节点组 → tunnel 的 workspace 必须一致。
      rejected.push({ tunnel_id: tunnelId, reason: "tunnel_not_in_scope" });
      continue;
    }
    if (bytes === 0) {
      rejected.push({ tunnel_id: tunnelId, reason: "no_delta" });
      continue;
    }
    accepted.push({ tunnel_id: tunnelId, bytes });
  }
  return { accepted, rejected };
}

/**
 * 把一批增量累加进 Redis 缓冲（HINCRBYFLOAT，同 key 多 field 一次调用）。
 * 返回实际生效的 field 数。
 *
 * 为什么用 HINCRBYFLOAT：并发上报同一 (tunnel, day) 时累加是原子的；
 * 「覆盖写」会丢前一方的增量。
 */
export async function accumulateTraffic(
  scope: number,
  tunnelIds: readonly number[],
  bytes: readonly number[],
  deps: { hincrBy(key: string, field: string, by: number): Promise<unknown> },
  dayKey: string = trafficDayKey(),
): Promise<number> {
  let n = 0;
  for (let i = 0; i < tunnelIds.length; i++) {
    const tunnelId = tunnelIds[i]!;
    const by = bytes[i]!;
    await deps.hincrBy(trafficBufferKey(scope, tunnelId), dayKey, by);
    n++;
  }
  return n;
}

/** Prisma createMany 入参类型（保留显式导出，便于测试构造）。 */
export type TrafficCreateManyArgs = Prisma.TunnelTrafficCreateManyArgs;
