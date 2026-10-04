/**
 * V5.5 WP16 —— 用量纯逻辑的离线断言（bun:test，无 DB / 无网络）。
 *
 * 这一块每一条错误方向都是"账算错了"：重复累加 = 多收用户的钱，补 0 = 少算流量，
 * 重叠窗口求和 = 双计，乱序倒退水位 = 把新数据当旧数据丢掉。所以断言集中在：
 *   · fail-closed 解析（未知键 / 类型 / 倒置窗口）；
 *   · `usage_id` 首次即事实（重复不覆盖、不累加）；
 *   · 相邻窗口才合并；重叠不求和；空洞只报告、**绝不补 0**；
 *   · 归因不一致宁可不归因也不串租户；
 *   · 水位单调，乱序只记事实；
 *   · 未归因用量进独立桶，不静默丢弃。
 */
import { describe, expect, test } from "bun:test";

import {
  EMPTY_USAGE_CURSOR,
  attributeUsage,
  coalesceUsageWindows,
  dedupeUsageReports,
  foldUsageCursor,
  parseUsageReport,
  persistUsageReport,
  sameUsagePayload,
  summarizeUsage,
  type UsageAttributionContext,
  type UsageDb,
  type UsageFact,
  type UsageReport,
} from "../federation/usage.ts";

const T = (iso: string) => new Date(iso);

/** 不关心审计内容的调用点用它：默认 sink 会去写真实 DB，测试里没必要制造噪音。 */
const silentAudit = () => {};

function report(over: Partial<UsageReport> = {}): UsageReport {
  return {
    usage_id: "u1",
    lease_ref: "lease-1",
    forward_ref: "fwd-1",
    window_start: T("2026-10-05T04:00:00Z"),
    window_end: T("2026-10-05T04:05:00Z"),
    bytes_in: 100n,
    bytes_out: 200n,
    connections: 3,
    ...over,
  };
}

function uniqueConflict(): Error {
  const e = new Error("unique constraint");
  (e as any).code = "P2002";
  return e;
}

function makeUsageDb(seed: Record<string, any>[] = []) {
  const records: Record<string, any>[] = seed.map((r) => ({ ...r }));
  const calls = { create: [] as Record<string, any>[], audit: [] as Record<string, any>[] };
  const db: UsageDb = {
    federationUsageRecord: {
      async create(args: any) {
        if (records.some((r) => r.usage_id === args.data.usage_id)) throw uniqueConflict();
        calls.create.push(args.data);
        const row = { id: records.length + 1, received_at: T("2026-10-05T04:10:00Z"), ...args.data };
        records.push(row);
        return { ...row };
      },
      async findUnique(args: any) {
        const row = records.find((r) => r.usage_id === args.where?.usage_id);
        return row ? { ...row } : null;
      },
      async findMany() {
        return records.map((r) => ({ ...r }));
      },
      async count() {
        return records.length;
      },
    },
  };
  return { db, records, calls };
}

/* ================================================================== */
/* 解析                                                               */
/* ================================================================== */

describe("WP16 usage: malformed reports are rejected instead of partially believed", () => {
  test("a full report parses, accepting Date / ISO string / epoch millis", () => {
    const parsed = parseUsageReport({
      usage_id: "u1",
      lease_ref: "lease-1",
      forward_ref: "fwd-1",
      window_start: "2026-10-05T04:00:00Z",
      window_end: 1791183605000,
      bytes_in: 1,
      bytes_out: 2,
      connections: 3,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.bytes_in).toBe(1n);
      expect(parsed.value.window_start.getTime()).toBe(T("2026-10-05T04:00:00Z").getTime());
    }
  });

  test("counts default to zero but an explicit null / negative / float / string is refused", () => {
    const minimal = parseUsageReport({ usage_id: "u", lease_ref: "l", window_start: 0, window_end: 1 });
    expect(minimal.ok).toBe(true);
    if (minimal.ok) expect(minimal.value.connections).toBe(0);

    for (const bad of [{ bytes_in: -1 }, { bytes_in: 1.5 }, { bytes_in: "100" }, { connections: -1 }, { connections: 1.2 }]) {
      const parsed = parseUsageReport({
        usage_id: "u",
        lease_ref: "l",
        window_start: 0,
        window_end: 1,
        ...bad,
      });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("message_malformed");
    }
  });

  test("unknown keys and malformed identity fields fail closed", () => {
    const base = { usage_id: "u", lease_ref: "l", window_start: 0, window_end: 1 };
    expect(parseUsageReport({ ...base, future: 1 }).ok).toBe(false);
    expect(parseUsageReport({ ...base, usage_id: "" }).ok).toBe(false);
    expect(parseUsageReport({ ...base, usage_id: "x".repeat(97) }).ok).toBe(false);
    expect(parseUsageReport({ ...base, lease_ref: "" }).ok).toBe(false);
    expect(parseUsageReport({ ...base, forward_ref: "" }).ok).toBe(false);
    expect(parseUsageReport({ ...base, forward_ref: 7 }).ok).toBe(false);
    expect(parseUsageReport(null).ok).toBe(false);
    expect(parseUsageReport("u1").ok).toBe(false);
    // forward_ref 可缺省（有些 lease 在上报时还没绑定本地 Forward）。 
    expect(parseUsageReport(base).ok).toBe(true);
  });

  test("an inverted or unparsable window is refused (it would create negative traffic)", () => {
    const inverted = parseUsageReport({ usage_id: "u", lease_ref: "l", window_start: 10, window_end: 10 });
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.message).toContain("strictly after");

    expect(parseUsageReport({ usage_id: "u", lease_ref: "l", window_start: "yesterday", window_end: 1 }).ok).toBe(false);
    expect(parseUsageReport({ usage_id: "u", lease_ref: "l", window_start: 0, window_end: Number.NaN }).ok).toBe(false);
  });
});

describe("WP16 usage: `lease_id` is accepted as a legacy alias of `lease_ref`", () => {
  test("the alias parses to the canonical field", () => {
    const parsed = parseUsageReport({
      usage_id: "u1",
      lease_id: "lease-1",
      window_start: 0,
      window_end: 1,
      bytes_in: 1,
      bytes_out: 2,
      connections: 3,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.lease_ref).toBe("lease-1");
  });

  test("both names with the same value is fine, but disagreeing values fail closed", () => {
    const same = parseUsageReport({ usage_id: "u1", lease_ref: "lease-1", lease_id: "lease-1", window_start: 0, window_end: 1 });
    expect(same.ok).toBe(true);
    const conflict = parseUsageReport({ usage_id: "u1", lease_ref: "lease-1", lease_id: "lease-2", window_start: 0, window_end: 1 });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.message).toContain("disagree");
  });

  test("unknown keys are still rejected (the alias is not a general loosening)", () => {
    const parsed = parseUsageReport({ usage_id: "u1", lease_id: "lease-1", foo: 1, window_start: 0, window_end: 1 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("foo");
  });
});

/* ================================================================== */
/* 去重                                                               */
/* ================================================================== */

describe("WP16 usage: usage_id dedupe keeps the FIRST fact", () => {
  test("duplicates are reported, and the first occurrence is what survives", () => {
    const first = report({ usage_id: "u1", bytes_in: 100n });
    const dupe = report({ usage_id: "u1", bytes_in: 100n });
    const result = dedupeUsageReports([first, dupe, report({ usage_id: "u2" })]);

    expect(result.unique.map((r) => r.usage_id)).toEqual(["u1", "u2"]);
    expect(result.duplicates).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
    expect(sameUsagePayload(first, dupe)).toBe(true);
  });

  test("the same usage_id with a different payload is a conflict, not a silent overwrite", () => {
    const result = dedupeUsageReports([report({ usage_id: "u1", bytes_in: 100n }), report({ usage_id: "u1", bytes_in: 999n })]);
    expect(result.unique[0].bytes_in).toBe(100n);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].kept.bytes_in).toBe(100n);
    expect(result.conflicts[0].dropped.bytes_in).toBe(999n);
  });
});

/* ================================================================== */
/* 窗口合并                                                            */
/* ================================================================== */

describe("WP16 usage: windows merge only when adjacent, and gaps are never filled with zeros", () => {
  test("adjacent windows from the same lease are summed into one", () => {
    const result = coalesceUsageWindows([
      report({ usage_id: "u2", window_start: T("2026-10-05T04:05:00Z"), window_end: T("2026-10-05T04:10:00Z"), bytes_in: 5n, bytes_out: 6n, connections: 1 }),
      report({ usage_id: "u1", window_start: T("2026-10-05T04:00:00Z"), window_end: T("2026-10-05T04:05:00Z"), bytes_in: 100n, bytes_out: 200n, connections: 3 }),
    ]);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].bytes_in).toBe(105n);
    expect(result.windows[0].bytes_out).toBe(206n);
    expect(result.windows[0].connections).toBe(4);
    expect(result.windows[0].usage_ids).toEqual(["u1", "u2"]);
    expect(result.gaps).toHaveLength(0);
    expect(result.overlaps).toHaveLength(0);
  });

  test("a missing window is REPORTED as a gap, never synthesized as a zero window", () => {
    const result = coalesceUsageWindows([
      report({ usage_id: "u1", window_start: T("2026-10-05T04:00:00Z"), window_end: T("2026-10-05T04:05:00Z") }),
      report({ usage_id: "u3", window_start: T("2026-10-05T04:10:00Z"), window_end: T("2026-10-05T04:15:00Z") }),
    ]);
    expect(result.windows).toHaveLength(2);
    expect(result.gaps).toEqual([
      { lease_ref: "lease-1", after: T("2026-10-05T04:05:00Z"), before: T("2026-10-05T04:10:00Z") },
    ]);
    // 没有补 0：窗口数与输入的事实数一致，字节数与输入一致。
    expect(result.windows.reduce((sum, w) => sum + w.bytes_in, 0n)).toBe(200n);
  });

  test("overlapping windows are never summed (double counting) and are surfaced as conflicts", () => {
    const result = coalesceUsageWindows([
      report({ usage_id: "u1", window_start: T("2026-10-05T04:00:00Z"), window_end: T("2026-10-05T04:10:00Z"), bytes_in: 100n }),
      report({ usage_id: "u2", window_start: T("2026-10-05T04:05:00Z"), window_end: T("2026-10-05T04:15:00Z"), bytes_in: 100n }),
    ]);
    expect(result.overlaps).toHaveLength(1);
    expect(result.windows).toHaveLength(2);
    // 两笔 100 字节的事实都在，但绝不合成一笔 200 —— 重叠部分的真实值无法从这两条记录判定。
    expect(result.windows.map((w) => w.bytes_in)).toEqual([100n, 100n]);
  });

  test("out-of-order input is sorted by window_start before merging", () => {
    const result = coalesceUsageWindows([
      report({ usage_id: "u3", window_start: T("2026-10-05T04:10:00Z"), window_end: T("2026-10-05T04:15:00Z") }),
      report({ usage_id: "u1", window_start: T("2026-10-05T04:00:00Z"), window_end: T("2026-10-05T04:05:00Z") }),
      report({ usage_id: "u2", window_start: T("2026-10-05T04:05:00Z"), window_end: T("2026-10-05T04:10:00Z") }),
    ]);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].usage_ids).toEqual(["u1", "u2", "u3"]);
    expect(result.gaps).toHaveLength(0);
  });

  test("windows for different leases or different forward_refs are never merged together", () => {
    const result = coalesceUsageWindows([
      report({ usage_id: "u1", lease_ref: "lease-1", window_start: T("2026-10-05T04:00:00Z"), window_end: T("2026-10-05T04:05:00Z") }),
      report({ usage_id: "u2", lease_ref: "lease-2", window_start: T("2026-10-05T04:05:00Z"), window_end: T("2026-10-05T04:10:00Z") }),
      report({ usage_id: "u3", lease_ref: "lease-1", forward_ref: "fwd-2", window_start: T("2026-10-05T04:05:00Z"), window_end: T("2026-10-05T04:10:00Z") }),
    ]);
    expect(result.windows).toHaveLength(3);
  });
});

/* ================================================================== */
/* 归因                                                                */
/* ================================================================== */

describe("WP16 usage: attribution prefers 'unknown' over 'someone else's forward'", () => {
  const ctx: UsageAttributionContext = {
    leases: new Map([
      ["lease-1", { forward_ref: "fwd-1", tunnel_id: 42 }],
      ["lease-2", { forward_ref: "fwd-2", tunnel_id: null }],
    ]),
    forwards: new Map([["fwd-2", 77]]),
  };

  test("a lease mapped to a local forward is attributed", () => {
    const result = attributeUsage(report(), ctx);
    expect(result).toEqual({ attribution: "attributed", forward_ref: "fwd-1", tunnel_id: 42, reason: "lease_resolved" });
  });

  test("a fallback through forward_ref still attributes (lease not registered locally yet)", () => {
    const result = attributeUsage({ lease_ref: "lease-9", forward_ref: "fwd-2" }, ctx);
    expect(result.attribution).toBe("attributed");
    expect(result.tunnel_id).toBe(77);
    expect(result.reason).toBe("forward_resolved");
  });

  test("a contradictory forward_ref is unattributed (never guess across tenants)", () => {
    const result = attributeUsage({ lease_ref: "lease-1", forward_ref: "fwd-2" }, ctx);
    expect(result.attribution).toBe("unattributed");
    expect(result.reason).toBe("attribution_conflict");
    expect(result.tunnel_id).toBeNull();
  });

  test("unknown lease / unknown forward / missing forward_ref all get a reason, never a bucket-less drop", () => {
    expect(attributeUsage({ lease_ref: "nope", forward_ref: null }, ctx).reason).toBe("lease_unknown_and_no_forward_ref");
    expect(attributeUsage({ lease_ref: "nope", forward_ref: "ghost" }, ctx).reason).toBe("forward_unknown");
    expect(attributeUsage({ lease_ref: "lease-2", forward_ref: null }, ctx).reason).toBe("lease_has_no_local_forward");
    expect(attributeUsage({ lease_ref: "lease-2", forward_ref: "fwd-2" }, ctx).attribution).toBe("attributed");
  });
});

/* ================================================================== */
/* 乱序 / 水位                                                         */
/* ================================================================== */

describe("WP16 usage: the watermark only moves forward, stale reports are still facts", () => {
  test("fresh reports advance the watermark; duplicates and out-of-order ones do not", () => {
    const first = foldUsageCursor(EMPTY_USAGE_CURSOR, [report({ usage_id: "u1" })]);
    expect(first.cursor.watermark?.toISOString()).toBe("2026-10-05T04:05:00.000Z");
    expect(first.fresh).toHaveLength(1);

    const stale = report({ usage_id: "u0", window_start: T("2026-10-05T03:00:00Z"), window_end: T("2026-10-05T03:05:00Z") });
    const second = foldUsageCursor(first.cursor, [stale]);
    expect(second.out_of_order).toHaveLength(1);
    expect(second.fresh).toHaveLength(0);
    // 水位不许倒退
    expect(second.cursor.watermark?.toISOString()).toBe("2026-10-05T04:05:00.000Z");

    const third = foldUsageCursor(second.cursor, [report({ usage_id: "u1" })]);
    expect(third.duplicates).toHaveLength(1);
    expect(third.fresh).toHaveLength(0);
  });

  test("a report that ends exactly at the watermark is not silently treated as new", () => {
    const first = foldUsageCursor(EMPTY_USAGE_CURSOR, [report({ usage_id: "u1" })]);
    const boundary = foldUsageCursor(first.cursor, [
      report({ usage_id: "u2", window_start: T("2026-10-05T04:00:00Z"), window_end: T("2026-10-05T04:05:00Z") }),
    ]);
    expect(boundary.out_of_order).toHaveLength(1);
  });
});

/* ================================================================== */
/* 汇总                                                                */
/* ================================================================== */

describe("WP16 usage: unattributed usage is a visible bucket, not a disappearance", () => {
  test("totals, per-tunnel and per-forward rollups, and the unattributed detail bucket", () => {
    const facts: UsageFact[] = [
      { ...report({ usage_id: "u1", bytes_in: 100n, bytes_out: 200n, connections: 2 }), attribution: "attributed", tunnel_id: 42 },
      { ...report({ usage_id: "u2", lease_ref: "lease-2", forward_ref: null, bytes_in: 5n, bytes_out: 0n, connections: 1 }), attribution: "unattributed", tunnel_id: null },
    ];
    const summary = summarizeUsage(facts);

    expect(summary.totals).toEqual({ bytes_in: 105n, bytes_out: 200n, connections: 3, windows: 2 });
    expect(summary.attributed.bytes_in).toBe(100n);
    expect(summary.unattributed.bytes_in).toBe(5n);
    expect(summary.by_tunnel).toEqual([{ tunnel_id: 42, totals: { bytes_in: 100n, bytes_out: 200n, connections: 2, windows: 1 } }]);
    expect(summary.unattributed_buckets).toEqual([
      { lease_ref: "lease-2", forward_ref: null, totals: { bytes_in: 5n, bytes_out: 0n, connections: 1, windows: 1 } },
    ]);
    // 未归因不等于丢弃：总和里必须包含它。
    expect(summary.totals.bytes_in).toBe(summary.attributed.bytes_in + summary.unattributed.bytes_in);
  });
});

/* ================================================================== */
/* 持久化                                                              */
/* ================================================================== */

describe("WP16 usage: persistence dedupes on the database key, first write wins", () => {
  test("a first report is stored with its attribution", async () => {
    const { db, records, calls } = makeUsageDb();
    const outcome = await persistUsageReport(
      {
        report: report(),
        peer_panel_id: "panel-a",
        attribution: { attribution: "attributed", forward_ref: "fwd-1", tunnel_id: 42, reason: "lease_resolved" },
      },
      { db, audit: silentAudit },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.duplicate).toBe(false);
    expect(records[0].tunnel_id).toBe(42);
    expect(records[0].bytes_in).toBe(100n);
    expect(calls.audit).toHaveLength(0);
  });

  test("a duplicate returns the existing fact and does not overwrite it", async () => {
    const { db, records } = makeUsageDb([
      {
        id: 1,
        usage_id: "u1",
        peer_panel_id: "panel-a",
        lease_ref: "lease-1",
        forward_ref: "fwd-1",
        tunnel_id: 42,
        window_start: T("2026-10-05T04:00:00Z"),
        window_end: T("2026-10-05T04:05:00Z"),
        bytes_in: 100n,
        bytes_out: 200n,
        connections: 3,
        attribution: "attributed",
      },
    ]);
    const outcome = await persistUsageReport(
      {
        report: report({ bytes_in: 999n }),
        peer_panel_id: "panel-a",
        attribution: { attribution: "attributed", forward_ref: "fwd-1", tunnel_id: 42, reason: "lease_resolved" },
      },
      { db, audit: silentAudit },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.duplicate).toBe(true);
    expect(outcome.payload_mismatch).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0].bytes_in).toBe(100n);
  });

  test("unattributed usage is stored AND audited (it needs a human), never dropped", async () => {
    const { db, records } = makeUsageDb();
    const events: Record<string, any>[] = [];
    const outcome = await persistUsageReport(
      {
        report: report({ forward_ref: null }),
        peer_panel_id: "panel-a",
        attribution: { attribution: "unattributed", forward_ref: null, tunnel_id: null, reason: "lease_unknown_and_no_forward_ref" },
      },
      {
        db,
        audit: (e: Record<string, any>) => {
          events.push(e);
        },
      },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.duplicate).toBe(false);
    expect(records[0].attribution).toBe("unattributed");
    expect(events.map((e) => e.action)).toEqual(["usage.unattributed"]);
    expect(events[0].detail?.reason).toBe("lease_unknown_and_no_forward_ref");
  });

  test("a database failure is reported as internal_error instead of pretending the fact landed", async () => {
    const { db } = makeUsageDb();
    const failing = {
      federationUsageRecord: {
        ...db.federationUsageRecord,
        create: async () => {
          throw new Error("db is down");
        },
      },
    } as UsageDb;
    const outcome = await persistUsageReport(
      {
        report: report(),
        peer_panel_id: "panel-a",
        attribution: { attribution: "attributed", forward_ref: "fwd-1", tunnel_id: 42, reason: "lease_resolved" },
      },
      { db: failing },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("internal_error");
  });

  test("a missing peer_panel_id is a caller problem", async () => {
    const { db } = makeUsageDb();
    const outcome = await persistUsageReport(
      {
        report: report(),
        peer_panel_id: "",
        attribution: { attribution: "attributed", forward_ref: "fwd-1", tunnel_id: 42, reason: "lease_resolved" },
      },
      { db, audit: silentAudit },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("message_malformed");
  });
});
