/**
 * V5.5 WP16 —— 用量事实的接收侧（home）。契约：`docs/v5-wp14-16-federation-contract.md` §4.1 / §4.2。
 *
 * 三条口径在这里被钉死，因为它们的错误方向都是"悄悄给用户少算或多算流量"：
 *
 *   1. **`usage_id` 唯一去重，首次写入即事实**。重复投递不覆盖、不累加
 *      （累加会把一次重投递变成双倍流量）。
 *   2. **缺失窗口不补 0**。"不知道"不是"零流量"（与 `TargetObservation.latency_ms` 同口径）。
 *      本模块只**报告**窗口空洞（`gaps`），绝不生成 0 值窗口。
 *   3. **无法归因的用量进 `unattributed` 桶并告警，不静默丢弃**。
 *      宁可让运营看到一笔未归因流量，也不要让它从账单里消失。
 *
 * 另外两条容易写错的地方：
 *   · **重叠窗口不求和**。同一 lease 的两段重叠窗口来自两次独立上报，求和 = 双计；
 *     本模块把它们当**冲突事实**并列保留，并报给调用方。
 *   · **乱序不倒退游标**。`window_end` 比水位旧的报告仍然是事实（照收），但**不许**
 *     把水位推回去——否则下一次"新窗口"判定会把真正的新数据当成旧数据丢掉。
 */
import { db } from "../../db.ts";
import { isUniqueConflict } from "../portPool.ts";
import { defaultFederationAuditSink, type FederationAuditSink, type ParseResult } from "./grant.ts";
import type { FederationErrorCode } from "./errors.ts";

/* ================================================================== */
/* 报告形状与 fail-closed 解析                                          */
/* ================================================================== */

/** 一条用量报告（host → home）。计数值用 bigint：字节数不是"差不多"的指标。 */
export interface UsageReport {
  usage_id: string;
  lease_ref: string;
  forward_ref: string | null;
  window_start: Date;
  window_end: Date;
  bytes_in: bigint;
  bytes_out: bigint;
  connections: number;
}

const USAGE_ID_MAX = 96;
const LEASE_REF_MAX = 64;
const FORWARD_REF_MAX = 191;

const USAGE_KEYS: ReadonlySet<string> = new Set([
  "usage_id",
  "lease_ref",
  "forward_ref",
  "window_start",
  "window_end",
  "bytes_in",
  "bytes_out",
  "connections",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** 时间：接受 Date / ISO 字符串 / epoch 毫秒整数；其余一律拒绝（不做宽松解析）。 */
function parseInstant(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function parseByteCount(v: unknown): bigint | null {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) return null;
    return BigInt(v);
  }
  // 字符串形式的数字（"1e9" / "1,000" / "-1"）一律拒绝：跨面板的字段类型必须确定，
  // 宽松解析是"同一个值在两侧解读不同"的温床。
  return null;
}

function parseConnections(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
  return v;
}

/**
 * 解析一条上报。unknown / malformed **fail-closed**（§3.5）：
 * 未知键、类型不对、窗口倒置都被拒绝，而不是"取能认的字段继续算"。
 * 少算一笔流量比拒收一笔报告严重得多——拒收会让 host 重投，误算不会有人发现。
 */
export function parseUsageReport(raw: unknown): ParseResult<UsageReport> {
  const bad = (message: string): ParseResult<UsageReport> => ({ ok: false, code: "message_malformed", message });
  if (!isPlainObject(raw)) return bad("usage report must be a JSON object");
  for (const key of Object.keys(raw)) {
    if (!USAGE_KEYS.has(key)) return bad(`usage report has unknown key "${key}" (fail-closed)`);
  }

  const usageId = raw.usage_id;
  if (typeof usageId !== "string" || usageId.length === 0 || usageId.length > USAGE_ID_MAX) {
    return bad(`usage_id must be a non-empty string of at most ${USAGE_ID_MAX} chars`);
  }
  const leaseRef = raw.lease_ref;
  if (typeof leaseRef !== "string" || leaseRef.length === 0 || leaseRef.length > LEASE_REF_MAX) {
    return bad(`lease_ref must be a non-empty string of at most ${LEASE_REF_MAX} chars`);
  }
  let forwardRef: string | null = null;
  if (raw.forward_ref !== undefined && raw.forward_ref !== null) {
    if (typeof raw.forward_ref !== "string" || raw.forward_ref.length === 0 || raw.forward_ref.length > FORWARD_REF_MAX) {
      return bad(`forward_ref must be a non-empty string of at most ${FORWARD_REF_MAX} chars`);
    }
    forwardRef = raw.forward_ref;
  }

  const windowStart = parseInstant(raw.window_start);
  const windowEnd = parseInstant(raw.window_end);
  if (windowStart === null) return bad("window_start must be a Date, ISO string or epoch millis");
  if (windowEnd === null) return bad("window_end must be a Date, ISO string or epoch millis");
  if (windowEnd.getTime() <= windowStart.getTime()) {
    return bad("window_end must be strictly after window_start");
  }

  const bytesIn = parseByteCount(raw.bytes_in ?? 0);
  const bytesOut = parseByteCount(raw.bytes_out ?? 0);
  const connections = parseConnections(raw.connections ?? 0);
  if (bytesIn === null) return bad("bytes_in must be a non-negative integer");
  if (bytesOut === null) return bad("bytes_out must be a non-negative integer");
  if (connections === null) return bad("connections must be a non-negative integer");

  return {
    ok: true,
    value: {
      usage_id: usageId,
      lease_ref: leaseRef,
      forward_ref: forwardRef,
      window_start: windowStart,
      window_end: windowEnd,
      bytes_in: bytesIn,
      bytes_out: bytesOut,
      connections,
    },
  };
}

/* ================================================================== */
/* 去重（usage_id 唯一，首次即事实）                                      */
/* ================================================================== */

export function sameUsagePayload(a: UsageReport, b: UsageReport): boolean {
  return (
    a.lease_ref === b.lease_ref &&
    a.forward_ref === b.forward_ref &&
    a.window_start.getTime() === b.window_start.getTime() &&
    a.window_end.getTime() === b.window_end.getTime() &&
    a.bytes_in === b.bytes_in &&
    a.bytes_out === b.bytes_out &&
    a.connections === b.connections
  );
}

export interface UsageDedupeResult {
  /** 每个 usage_id 的**首次**报告（顺序保持稳定，调用方可直接持久化这一组）。 */
  unique: UsageReport[];
  /** 被丢弃的重投递。 */
  duplicates: UsageReport[];
  /** 同 usage_id 但载荷不同 —— 必须告警的事实（两侧对同一笔流量的说法不一致）。 */
  conflicts: Array<{ kept: UsageReport; dropped: UsageReport }>;
}

/** 按 `usage_id` 去重，**首次写入即事实**（重复投递不覆盖、不累加）。 */
export function dedupeUsageReports(reports: readonly UsageReport[]): UsageDedupeResult {
  const seen = new Map<string, UsageReport>();
  const unique: UsageReport[] = [];
  const duplicates: UsageReport[] = [];
  const conflicts: Array<{ kept: UsageReport; dropped: UsageReport }> = [];

  for (const report of reports) {
    const first = seen.get(report.usage_id);
    if (first === undefined) {
      seen.set(report.usage_id, report);
      unique.push(report);
      continue;
    }
    duplicates.push(report);
    if (!sameUsagePayload(first, report)) conflicts.push({ kept: first, dropped: report });
  }

  return { unique, duplicates, conflicts };
}

/* ================================================================== */
/* 窗口合并 / 空洞 / 重叠                                                */
/* ================================================================== */

export interface UsageWindow {
  lease_ref: string;
  forward_ref: string | null;
  window_start: Date;
  window_end: Date;
  bytes_in: bigint;
  bytes_out: bigint;
  connections: number;
  /** 合并进来的原始报告 id（可追溯）。 */
  usage_ids: readonly string[];
}

export interface CoalesceResult {
  windows: UsageWindow[];
  /** 同一 lease 的时间线空洞：**只报告，绝不补 0**。 */
  gaps: Array<{ lease_ref: string; after: Date; before: Date }>;
  /** 重叠窗口：不求和（会双计），并列保留并上报冲突。 */
  overlaps: Array<{ lease_ref: string; kept: UsageWindow; conflicting: UsageReport }>;
}

function sortReports(reports: readonly UsageReport[]): UsageReport[] {
  return [...reports].sort((a, b) => {
    if (a.lease_ref !== b.lease_ref) return a.lease_ref < b.lease_ref ? -1 : 1;
    if (a.forward_ref !== b.forward_ref) return (a.forward_ref ?? "") < (b.forward_ref ?? "") ? -1 : 1;
    const dt = a.window_start.getTime() - b.window_start.getTime();
    if (dt !== 0) return dt;
    return a.usage_id < b.usage_id ? -1 : a.usage_id > b.usage_id ? 1 : 0;
  });
}

/**
 * 合并**相邻且不重叠**的窗口（前一窗 `end` 恰好等于后一窗 `start`），
 * 并且：
 *   · 重叠（`next.start < current.end`）→ 不合并、不求和，记 `overlaps` 并另起一个窗口；
 *   · 有洞（`next.start > current.end`）→ 记 `gaps`，两个窗口各自独立；
 *   · `forward_ref` 不同 → 不是同一条事实链，不合并（避免把两次归因拼成一条）。
 */
export function coalesceUsageWindows(reports: readonly UsageReport[]): CoalesceResult {
  const sorted = sortReports(reports);
  const windows: UsageWindow[] = [];
  const gaps: Array<{ lease_ref: string; after: Date; before: Date }> = [];
  const overlaps: Array<{ lease_ref: string; kept: UsageWindow; conflicting: UsageReport }> = [];

  let current: UsageWindow | null = null;
  for (const report of sorted) {
    if (current === null || current.lease_ref !== report.lease_ref || current.forward_ref !== report.forward_ref) {
      current = {
        lease_ref: report.lease_ref,
        forward_ref: report.forward_ref,
        window_start: report.window_start,
        window_end: report.window_end,
        bytes_in: report.bytes_in,
        bytes_out: report.bytes_out,
        connections: report.connections,
        usage_ids: [report.usage_id],
      };
      windows.push(current);
      continue;
    }

    const start = report.window_start.getTime();
    const end = current.window_end.getTime();
    if (start === end) {
      current.window_end = report.window_end;
      current.bytes_in += report.bytes_in;
      current.bytes_out += report.bytes_out;
      current.connections += report.connections;
      current.usage_ids = [...current.usage_ids, report.usage_id];
      continue;
    }
    if (start < end) {
      // 重叠：**不能求和**。保留既有窗口不动，把新报告并列成自己的窗口并上报冲突。
      overlaps.push({ lease_ref: report.lease_ref, kept: current, conflicting: report });
    } else {
      gaps.push({ lease_ref: report.lease_ref, after: current.window_end, before: report.window_start });
    }
    const next: UsageWindow = {
      lease_ref: report.lease_ref,
      forward_ref: report.forward_ref,
      window_start: report.window_start,
      window_end: report.window_end,
      bytes_in: report.bytes_in,
      bytes_out: report.bytes_out,
      connections: report.connections,
      usage_ids: [report.usage_id],
    };
    windows.push(next);
    current = next;
  }

  return { windows, gaps, overlaps };
}

/* ================================================================== */
/* 归因                                                                */
/* ================================================================== */

export type UsageAttribution = "attributed" | "unattributed";

export interface UsageAttributionSource {
  forward_ref: string | null;
  tunnel_id: number | null;
}

/**
 * 归因上下文：home 侧自己的事实（lease → 本机 Forward 的映射）。
 * 注意这里**只有** `lease_ref → {forward_ref, tunnel_id}` 与 `forward_ref → tunnel_id`，
 * 没有"远端节点"——远端资源在 home 侧不能变成本地 Node（§1.2 / §7）。
 */
export interface UsageAttributionContext {
  leases: ReadonlyMap<string, UsageAttributionSource>;
  forwards: ReadonlyMap<string, number>;
}

export interface UsageAttributionResult {
  attribution: UsageAttribution;
  forward_ref: string | null;
  tunnel_id: number | null;
  /** 未归因时的可解释原因（进告警），永远不是空字符串。 */
  reason: string;
}

/**
 * 归因一条用量。**保守优先**：只要两侧的说法不一致（同一 lease 的 forward_ref 与上报里
 * 的对不上），就不猜、不合并，直接进 unattributed 并告警——归因错比归因不到更危险，
 * 因为它会把流量记到别人账上（§8 G5 的 cross-tenant isolation）。
 */
export function attributeUsage(
  report: Pick<UsageReport, "lease_ref" | "forward_ref">,
  ctx: UsageAttributionContext,
): UsageAttributionResult {
  const lease = ctx.leases.get(report.lease_ref);
  if (lease !== undefined) {
    if (lease.forward_ref !== null && report.forward_ref !== null && lease.forward_ref !== report.forward_ref) {
      return {
        attribution: "unattributed",
        forward_ref: null,
        tunnel_id: null,
        reason: "attribution_conflict",
      };
    }
    if (lease.tunnel_id !== null) {
      return {
        attribution: "attributed",
        forward_ref: report.forward_ref ?? lease.forward_ref,
        tunnel_id: lease.tunnel_id,
        reason: "lease_resolved",
      };
    }
    if (report.forward_ref === null) {
      return { attribution: "unattributed", forward_ref: lease.forward_ref, tunnel_id: null, reason: "lease_has_no_local_forward" };
    }
  }

  if (report.forward_ref === null) {
    return {
      attribution: "unattributed",
      forward_ref: null,
      tunnel_id: null,
      reason: lease === undefined ? "lease_unknown_and_no_forward_ref" : "no_forward_ref",
    };
  }

  const tunnelId = ctx.forwards.get(report.forward_ref);
  if (tunnelId === undefined || tunnelId === null) {
    return { attribution: "unattributed", forward_ref: report.forward_ref, tunnel_id: null, reason: "forward_unknown" };
  }
  return { attribution: "attributed", forward_ref: report.forward_ref, tunnel_id: tunnelId, reason: "forward_resolved" };
}

/* ================================================================== */
/* 乱序：水位单调，旧消息只记事实                                        */
/* ================================================================== */

export interface UsageCursor {
  /** 已见到的最大 window_end；null = 还没见过任何窗口。 */
  watermark: Date | null;
  /** 已见过的 usage_id（去重窗口）。 */
  seen: ReadonlySet<string>;
}

export const EMPTY_USAGE_CURSOR: UsageCursor = { watermark: null, seen: new Set<string>() };

export interface FoldUsageCursorResult {
  cursor: UsageCursor;
  /** 水位之后的窗口（可以推进状态/告警）。 */
  fresh: UsageReport[];
  /** 重投递（usage_id 已见）。 */
  duplicates: UsageReport[];
  /** 乱序：`window_end` 不晚于水位。**仍然收下作为事实**，但不得把水位推回去。 */
  out_of_order: UsageReport[];
}

/**
 * 推进用量水位。水位只增不减（乱序报告不许让它倒退），否则下一次"新窗口"判定会把真正
 * 的新数据当成旧数据——这就是 §4.2「旧消息只记事实不改状态」在用量侧的落点。
 */
export function foldUsageCursor(current: UsageCursor, reports: readonly UsageReport[]): FoldUsageCursorResult {
  const seen = new Set(current.seen);
  let watermark = current.watermark;
  const fresh: UsageReport[] = [];
  const duplicates: UsageReport[] = [];
  const outOfOrder: UsageReport[] = [];

  for (const report of reports) {
    if (seen.has(report.usage_id)) {
      duplicates.push(report);
      continue;
    }
    seen.add(report.usage_id);
    if (watermark !== null && report.window_end.getTime() <= watermark.getTime()) {
      outOfOrder.push(report);
    } else {
      fresh.push(report);
    }
    if (watermark === null || report.window_end.getTime() > watermark.getTime()) {
      watermark = report.window_end;
    }
  }

  return { cursor: { watermark, seen }, fresh, duplicates, out_of_order: outOfOrder };
}

/* ================================================================== */
/* 汇总（unattributed 单独成桶，永不丢弃）                                */
/* ================================================================== */

export interface UsageTotals {
  bytes_in: bigint;
  bytes_out: bigint;
  connections: number;
  windows: number;
}

export interface UsageFact extends UsageReport {
  attribution: UsageAttribution;
  tunnel_id: number | null;
}

export interface UsageSummary {
  totals: UsageTotals;
  attributed: UsageTotals;
  unattributed: UsageTotals;
  /** 按本机 tunnel 汇总（只含已归因事实）。 */
  by_tunnel: Array<{ tunnel_id: number; totals: UsageTotals }>;
  /** 按 forward_ref 汇总（已归因 + 未归因都在，便于查是谁欠了归因）。 */
  by_forward_ref: Array<{ forward_ref: string; totals: UsageTotals }>;
  /** 未归因的明细桶（运营要按它去追 host 补映射）。 */
  unattributed_buckets: Array<{ lease_ref: string; forward_ref: string | null; totals: UsageTotals }>;
}

function emptyTotals(): UsageTotals {
  return { bytes_in: 0n, bytes_out: 0n, connections: 0, windows: 0 };
}

function addTotals(into: UsageTotals, fact: UsageFact): void {
  into.bytes_in += fact.bytes_in;
  into.bytes_out += fact.bytes_out;
  into.connections += fact.connections;
  into.windows += 1;
}

/** 汇总。无法归因的用量进 `unattributed` 桶并保留明细，**不静默丢弃**（§4.2）。 */
export function summarizeUsage(facts: readonly UsageFact[]): UsageSummary {
  const totals = emptyTotals();
  const attributed = emptyTotals();
  const unattributed = emptyTotals();
  const byTunnel = new Map<number, UsageTotals>();
  const byForward = new Map<string, UsageTotals>();
  const unattributedBuckets = new Map<string, { lease_ref: string; forward_ref: string | null; totals: UsageTotals }>();

  for (const fact of facts) {
    addTotals(totals, fact);
    if (fact.attribution === "attributed" && fact.tunnel_id !== null) {
      addTotals(attributed, fact);
      const t = byTunnel.get(fact.tunnel_id) ?? emptyTotals();
      addTotals(t, fact);
      byTunnel.set(fact.tunnel_id, t);
    } else {
      addTotals(unattributed, fact);
      const key = `${fact.lease_ref}|${fact.forward_ref ?? ""}`;
      const bucket = unattributedBuckets.get(key) ?? { lease_ref: fact.lease_ref, forward_ref: fact.forward_ref, totals: emptyTotals() };
      addTotals(bucket.totals, fact);
      unattributedBuckets.set(key, bucket);
    }
    if (fact.forward_ref !== null) {
      const f = byForward.get(fact.forward_ref) ?? emptyTotals();
      addTotals(f, fact);
      byForward.set(fact.forward_ref, f);
    }
  }

  return {
    totals,
    attributed,
    unattributed,
    by_tunnel: [...byTunnel.entries()].map(([tunnel_id, t]) => ({ tunnel_id, totals: t })).sort((a, b) => a.tunnel_id - b.tunnel_id),
    by_forward_ref: [...byForward.entries()].map(([forward_ref, t]) => ({ forward_ref, totals: t })).sort((a, b) => (a.forward_ref < b.forward_ref ? -1 : 1)),
    unattributed_buckets: [...unattributedBuckets.values()].sort((a, b) => (a.lease_ref < b.lease_ref ? -1 : a.lease_ref > b.lease_ref ? 1 : 0)),
  };
}

/* ================================================================== */
/* 持久化（home 侧，usage_id 唯一去重）                                   */
/* ================================================================== */

export interface UsageDb {
  federationUsageRecord: {
    create(args: unknown): Promise<unknown>;
    findUnique(args: unknown): Promise<unknown>;
    findMany(args: unknown): Promise<unknown>;
    count(args: unknown): Promise<number>;
  };
}

export interface UsageDeps {
  db?: UsageDb;
  audit?: FederationAuditSink;
}

export interface PersistUsageInput {
  report: UsageReport;
  peer_panel_id: string;
  attribution: UsageAttributionResult;
}

export type PersistUsageOutcome =
  | {
      ok: true;
      usage_id: string;
      /** 重投递：返回既有事实的 id，**不覆盖、不累加**。 */
      duplicate: boolean;
      /** 同 usage_id 载荷不同 → 必须告警（两侧说法不一致）。 */
      payload_mismatch: boolean;
      record_id: number | null;
    }
  | { ok: false; code: FederationErrorCode; message: string };

export interface UsageRecordRow {
  id: number;
  usage_id: string;
  peer_panel_id: string;
  lease_ref: string;
  forward_ref: string | null;
  tunnel_id: number | null;
  window_start: Date;
  window_end: Date;
  bytes_in: bigint;
  bytes_out: bigint;
  connections: number;
  attribution: string;
  received_at: Date;
}

const defaultUsageDb = db as unknown as UsageDb;

function rowMatchesReport(row: UsageRecordRow, report: UsageReport): boolean {
  return (
    row.lease_ref === report.lease_ref &&
    (row.forward_ref ?? null) === report.forward_ref &&
    new Date(row.window_start).getTime() === report.window_start.getTime() &&
    new Date(row.window_end).getTime() === report.window_end.getTime() &&
    BigInt(row.bytes_in) === report.bytes_in &&
    BigInt(row.bytes_out) === report.bytes_out &&
    Number(row.connections) === report.connections
  );
}

/**
 * 落一条用量事实。唯一索引 `usage_id` 是去重真相（不是"先查后写"）：
 * 撞唯一键 = 重投递 → 返回**既有**事实（首次即事实，绝不覆盖）。
 *
 * 审计策略：用量是周期事实，每拍都写审计会把审计表变成流量表；只有**异常**留痕——
 * 未归因（必须被追）与载荷不一致（两侧说法冲突）。这与 §4.2「不静默丢弃」并不矛盾：
 * 事实本身始终落库，留痕的是"需要有人看一眼"的那些。
 */
export async function persistUsageReport(
  input: PersistUsageInput,
  deps?: UsageDeps,
): Promise<PersistUsageOutcome> {
  const d = deps?.db ?? defaultUsageDb;
  const audit: FederationAuditSink = deps?.audit ?? defaultFederationAuditSink;

  if (typeof input.peer_panel_id !== "string" || input.peer_panel_id.length === 0 || input.peer_panel_id.length > 64) {
    return { ok: false, code: "message_malformed", message: "peer_panel_id must be a non-empty string of at most 64 chars" };
  }

  try {
    const row = (await d.federationUsageRecord.create({
      data: {
        usage_id: input.report.usage_id,
        peer_panel_id: input.peer_panel_id,
        lease_ref: input.report.lease_ref,
        forward_ref: input.report.forward_ref,
        tunnel_id: input.attribution.tunnel_id,
        window_start: input.report.window_start,
        window_end: input.report.window_end,
        bytes_in: input.report.bytes_in,
        bytes_out: input.report.bytes_out,
        connections: input.report.connections,
        attribution: input.attribution.attribution,
      },
    })) as UsageRecordRow;
    if (input.attribution.attribution === "unattributed") {
      await audit({
        action: "usage.unattributed",
        direction: "inbound",
        peer_panel_id: input.peer_panel_id,
        status: 202,
        detail: { usage_id: input.report.usage_id, lease_ref: input.report.lease_ref, reason: input.attribution.reason },
      });
    }
    return { ok: true, usage_id: input.report.usage_id, duplicate: false, payload_mismatch: false, record_id: row.id ?? null };
  } catch (e) {
    if (!isUniqueConflict(e)) {
      return { ok: false, code: "internal_error", message: e instanceof Error ? e.message : String(e) };
    }
  }

  const existing = (await d.federationUsageRecord.findUnique({
    where: { usage_id: input.report.usage_id },
  })) as UsageRecordRow | null;
  if (existing === null || existing === undefined) {
    return { ok: false, code: "internal_error", message: "usage_id conflicted but the existing row cannot be read" };
  }
  const mismatch = !rowMatchesReport(existing, input.report);
  if (mismatch) {
    await audit({
      action: "usage.payload_mismatch",
      direction: "inbound",
      peer_panel_id: input.peer_panel_id,
      status: 409,
      detail: { usage_id: input.report.usage_id, lease_ref: input.report.lease_ref },
    });
  }
  return {
    ok: true,
    usage_id: input.report.usage_id,
    duplicate: true,
    payload_mismatch: mismatch,
    record_id: existing.id ?? null,
  };
}
