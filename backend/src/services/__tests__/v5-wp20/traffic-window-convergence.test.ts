/**
 * V5-WP20-6 流量口径统一单元测试 —— 离线。
 *
 * 契约：`docs/v5-wp20-subscription-billing-runtime-contract.md` §3.1.3（三处口径收敛为一处）、
 * §3.3（周期自然滚动 / `traffic_used` 读路径切换 / 联邦缺口可观测）；**DoD 第 8 条**。
 *
 * 这一文件守在三个「各自算一遍」的地方之间：
 *   1. **窗口起点**：`capability-policy#trafficWindowStart` 与 `policy-service#trafficStart`
 *      （额度判定读它们）；
 *   2. **图表日键**：`traffic#dayKeyOf`/`fillDays` 与 `dashboard`/`tunnels` 的兄弟实现；
 *   3. **归档戳**：`traffic-archive#trafficDate`（写入口径）。
 * 它们过去各写一份本地时区逻辑，其中 ② 还用 `toISOString().slice(0,10)` 把「今天」画成昨天。
 * 现在全部委托 `billing-time.ts`；本文件用**跨模块逐字相等**断言把这件事钉死，
 * 并断言 DoD 第 8 条要的那个 grep 结果。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/v5-wp20/traffic-window-convergence.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  billingDayKeyStamp,
  billingDayStart,
  billingMonthStart,
  billingPeriodKey,
} from "../../billing-time.ts";
import { composeEffectivePolicy, trafficWindowStart, type PolicyRecord } from "../../capability-policy.ts";
import { dayKeyOf, fillDays } from "../../traffic.ts";
import { trafficDate } from "../../traffic-archive.ts";
import { sumFederatedUnattributedTraffic, type FederatedUsageClient } from "../../policy-service.ts";

/** 覆盖日界、月界、跨年、闰年、以及「UTC 日 ≠ 上海日」的临界点。 */
const GRID: string[] = [
  "2026-01-01T00:00:00.000Z", // 上海 01-01 08:00
  "2026-01-31T15:59:59.999Z", // 上海 01-31 23:59:59.999
  "2026-01-31T16:00:00.000Z", // 上海 02-01 00:00（跨月的那一秒）
  "2026-02-28T15:59:59.999Z",
  "2026-02-28T16:00:00.000Z", // 上海 03-01
  "2026-12-31T16:00:00.000Z", // 上海 2027-01-01（跨年）
  "2028-02-29T02:30:00.000Z", // 闰年
  "2026-10-05T18:30:00.000Z", // 上海 10-06 02:30（UTC 日与上海日不同）
];

// ─────────────────────────── A. 窗口起点：两个入口都与 billing-time 逐字相等 ───────────────────────────

describe("A. 窗口起点收敛：day/month 都由 billing-time 派生，total 恒为 null", () => {
  test("capability-policy#trafficWindowStart 与 billing-time 逐字相等", () => {
    for (const instant of GRID) {
      const at = new Date(instant);
      expect({ instant, value: trafficWindowStart("day", at) }).toEqual({
        instant,
        value: billingDayStart(at),
      });
      expect({ instant, value: trafficWindowStart("month", at) }).toEqual({
        instant,
        value: billingMonthStart(at),
      });
      expect(trafficWindowStart("total", at)).toBeNull();
    }
  });

  test("跨月那一秒：月首必须跟着上海月走（不是 UTC 月）", () => {
    expect(trafficWindowStart("month", new Date("2026-01-31T15:59:59.999Z"))!.toISOString()).toBe(
      "2025-12-31T16:00:00.000Z",
    );
    expect(trafficWindowStart("month", new Date("2026-01-31T16:00:00.000Z"))!.toISOString()).toBe(
      "2026-01-31T16:00:00.000Z",
    );
    expect(trafficWindowStart("day", new Date("2026-10-05T18:30:00.000Z"))!.toISOString()).toBe(
      "2026-10-05T16:00:00.000Z",
    );
  });
});

// ─────────────────────────── B. 图表日键：与写入端的归档戳同源 ───────────────────────────

describe("B. 图表日键 = 归档日标签（读入口径与写入口径逐字相等）", () => {
  test("dayKeyOf 与 billingPeriodKey(…, \"day\") 逐字相等", () => {
    for (const instant of GRID) {
      const at = new Date(instant);
      expect({ instant, key: dayKeyOf(at) }).toEqual({ instant, key: billingPeriodKey(at, "day") });
    }
  });

  test("写入口径 = 读入口径：trafficDate(dayKeyOf(t)) === billingDayKeyStamp(t)", () => {
    // `trafficDate` 是归档真正写进 `tunnel_traffic.date` 的实现；两者必须逐字相等，
    // 否则图表键永远匹配不上库里任何一行（历史 bug：UTC+8 下整体回退一天）。
    for (const instant of GRID) {
      const at = new Date(instant);
      expect({ instant, stamp: trafficDate(dayKeyOf(at)).toISOString() }).toEqual({
        instant,
        stamp: billingDayKeyStamp(at).toISOString(),
      });
    }
  });

  test("归档戳是 UTC 午夜，且键能往返（stamp → key 不变）", () => {
    for (const instant of GRID) {
      const stamp = billingDayKeyStamp(new Date(instant));
      expect(stamp.toISOString()).toMatch(/T00:00:00\.000Z$/);
      expect(dayKeyOf(stamp)).toBe(billingPeriodKey(new Date(instant), "day"));
    }
  });

  test("fillDays：升序、以今天结尾、长度为 N（键序列 = 归档戳回退 N-1 天）", () => {
    const now = new Date("2026-10-05T18:30:00.000Z"); // 上海 10-06
    const keys = fillDays(3, now);
    expect(keys).toEqual(["2026-10-04", "2026-10-05", "2026-10-06"]);
    expect(keys[keys.length - 1]).toBe(dayKeyOf(now));
    expect(fillDays(1, now)).toEqual(["2026-10-06"]);
    // 非法天数不产生空序列（图表点数稳定是既有契约）
    expect(fillDays(0, now)).toEqual(["2026-10-06"]);
  });
});

// ─────────────────────────── C. 联邦缺口可观测（§3.3.5 / O5） ───────────────────────────

describe("C. traffic_used_unattributed_federated：缺口可观测，但不并进额度用量", () => {
  test("按 workspace 归因求和，BigInt 转 number", async () => {
    const calls: unknown[] = [];
    const client: FederatedUsageClient = {
      // 与 Prisma 同形：`T` 是**结果集**类型，替身必须保持泛型，否则不满足接口
      async $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
        calls.push({ sql: strings.join("?"), values });
        return [{ total: 3_000_000_000n }] as T;
      },
    };
    await expect(sumFederatedUnattributedTraffic(7, client)).resolves.toBe(3_000_000_000);
    expect(calls).toHaveLength(1);
    // workspace 通过参数下发（不是字符串拼接），且 SQL 关联的是本 workspace 的隧道
    const call = calls[0] as { sql: string; values: unknown[] };
    expect(call.values).toEqual([7]);
    expect(call.sql).toContain("JOIN tunnel");
    expect(call.sql).toContain("federation_usage_record");
  });

  test("无行 / NULL 合计 ⇒ 0（不是 NaN、不是 undefined）", async () => {
    const empty: FederatedUsageClient = { async $queryRaw<T>(): Promise<T> { return [] as unknown as T; } };
    expect(await sumFederatedUnattributedTraffic(7, empty)).toBe(0);
    const nulled: FederatedUsageClient = {
      async $queryRaw<T>(): Promise<T> { return [{ total: null }] as T; },
    };
    expect(await sumFederatedUnattributedTraffic(7, nulled)).toBe(0);
  });

  test("报告里它是**独立字段**：与 traffic_used 并列，不参与求和", () => {
    const source = readFileSync(new URL("../../policy-service.ts", import.meta.url), "utf8");
    expect(source).toContain("traffic_used_unattributed_federated: federated");
    // 反例守卫：若把它加进 traffic_used，两本账就合并了（契约 §10 的「谁权威」问题）
    expect(source).not.toContain("traffic_used: traffic_used + federated");
    expect(source).not.toMatch(/traffic_used:\s*[^,\n]*\+\s*federated/);
  });
});


// ─────────────────────────── C2. 生效周期 = 声明的最长周期（既有缺陷修复） ───────────────────────────

/** 造一条策略（只填判定用得上的字段）。 */
function pol(over: Partial<PolicyRecord> & { id: number; key: string }): PolicyRecord {
  return {
    id: over.id,
    key: over.key,
    name: over.name ?? over.key,
    source: over.source ?? "purchase",
    applies_to: over.applies_to ?? null,
    is_ceiling: over.is_ceiling ?? false,
    status: over.status ?? "active",
    revision: over.revision ?? 1,
    tunnel_types: over.tunnel_types ?? ["tcp"],
    allow_custom_in_group: false,
    allow_custom_out_group: false,
    allowed_in_group_ids: null,
    allowed_out_group_ids: null,
    allow_shared_entry: false,
    max_tunnels: over.max_tunnels ?? null,
    max_nodes: null,
    max_members: null,
    traffic_limit: over.traffic_limit ?? null,
    traffic_period: over.traffic_period ?? "total",
    bandwidth_limit: null,
    client_limit: null,
    ip_limit: null,
    whitelist_ips: null,
  };
}

const assignOf = (policy: PolicyRecord, ceilings: PolicyRecord[] = []) => ({
  workspace_id: 1,
  now: new Date("2026-10-05T05:30:00.000Z"),
  graceMs: 0,
  assignments: [
    { policy, source: policy.source, effective_at: new Date("2026-09-01T00:00:00.000Z"), expires_at: null, revoked_at: null, note: null },
  ],
  ceilings: ceilings.map((c) => c),
});

describe("C2. 生效周期 = 适用策略中声明的**最长**周期（修既有缺陷：union 初值曾让 total 恒胜）", () => {
  test("单条 month ⇒ month（修前是 total ⇒ 月额度按全量累计判定、永不复位）", () => {
    const policy = composeEffectivePolicy(assignOf(pol({ id: 1, key: "pro", traffic_period: "month", traffic_limit: 100 })));
    expect(policy.limits.traffic_period).toBe("month");
    expect(policy.limits.traffic_limit).toBe(100);
  });

  test("单条 day ⇒ day；month + day ⇒ month（更宽松者是声明者之一）", () => {
    const day = composeEffectivePolicy(assignOf(pol({ id: 1, key: "d", traffic_period: "day" })));
    expect(day.limits.traffic_period).toBe("day");

    const both = composeEffectivePolicy({
      workspace_id: 1,
      now: new Date("2026-10-05T05:30:00.000Z"),
      graceMs: 0,
      assignments: [
        { policy: pol({ id: 1, key: "m", traffic_period: "month" }), source: "purchase", effective_at: new Date("2026-09-01T00:00:00.000Z"), expires_at: null, revoked_at: null, note: null },
        { policy: pol({ id: 2, key: "d", traffic_period: "day" }), source: "admin_grant", effective_at: new Date("2026-09-01T00:00:00.000Z"), expires_at: null, revoked_at: null, note: null },
      ],
    });
    expect(both.limits.traffic_period).toBe("month");
  });

  test("month + total 并存 ⇒ total（只有当某条策略**声明** total 时才是 total）", () => {
    const both = composeEffectivePolicy({
      workspace_id: 1,
      now: new Date("2026-10-05T05:30:00.000Z"),
      graceMs: 0,
      assignments: [
        { policy: pol({ id: 1, key: "m", traffic_period: "month" }), source: "purchase", effective_at: new Date("2026-09-01T00:00:00.000Z"), expires_at: null, revoked_at: null, note: null },
        { policy: pol({ id: 2, key: "t", traffic_period: "total" }), source: "admin_grant", effective_at: new Date("2026-09-01T00:00:00.000Z"), expires_at: null, revoked_at: null, note: null },
      ],
    });
    expect(both.limits.traffic_period).toBe("total");
  });

  test("ceiling 的 total 表示「无约束」，不得把已声明的 month 拉宽（与 intersectCeiling 的既有口径一致）", () => {
    const policy = composeEffectivePolicy(
      assignOf(pol({ id: 1, key: "pro", traffic_period: "month", traffic_limit: 100 }), [
        pol({ id: 9, key: "platform_ceiling", is_ceiling: true, traffic_period: "total", traffic_limit: 1000, max_tunnels: 100 }),
      ]),
    );
    expect(policy.limits.traffic_period).toBe("month");
    expect(policy.ceiling.traffic_period).toBe("total");
  });

  test("数值上限不受此次修复影响（初值 null 是 max 的中性元，折法等价）", () => {
    const policy = composeEffectivePolicy(assignOf(pol({ id: 1, key: "pro", max_tunnels: 7, traffic_limit: 500 })));
    expect(policy.limits.max_tunnels).toBe(7);
    expect(policy.limits.traffic_limit).toBe(500);
  });

  test("复位是可执行的：下个月的窗口起点**晚于**上个月的归档戳（所以上月不计入本月用量）", () => {
    const oct = new Date("2026-10-05T05:30:00.000Z");
    const nov = new Date("2026-11-05T05:30:00.000Z");
    // 上月戳：10-05 的归档戳（UTC 午夜）；下月窗口起点：11-01 上海 00:00
    const octStamp = billingDayKeyStamp(oct);
    const novWindowStart = billingWindowForMonth(nov);
    expect(novWindowStart.getTime()).toBeGreaterThan(octStamp.getTime());
  });
});

/** 生效月窗口起点（与 `sumWorkspaceTraffic(ws, "month", now)` 内部用的同一个函数）。 */
function billingWindowForMonth(now: Date): Date {
  return trafficWindowStart("month", now) as Date;
}

// ─────────────────────────── D. DoD 第 8 条与读路径切换（静态守卫） ───────────────────────────

const SRC = new URL("../../../", import.meta.url).pathname; // backend/src/
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");
const STRIP = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w"'])\/\/[^\n]*/g, "$1");

describe("D. 守卫：不再有第二套日界实现 / 已用流量不再读 legacy 列", () => {
  test("DoD 第 8 条：policy-service 与 capability-policy 里 0 处 `setHours(0, 0, 0, 0)`", () => {
    for (const file of ["services/policy-service.ts", "services/capability-policy.ts"]) {
      const code = STRIP(read(file));
      expect({ file, hits: code.includes("setHours(0, 0, 0, 0)") }).toEqual({ file, hits: false });
      expect({ file, hits: code.includes("setDate(1)") }).toEqual({ file, hits: false });
    }
  });

  test("图表侧不再自造日界：dashboard / tunnels 里没有 setHours(0…，且都用 fillDays", () => {
    for (const file of ["routes/dashboard.ts", "routes/tunnels.ts"]) {
      const code = STRIP(read(file));
      expect({ file, hits: code.includes("setHours(0") }).toEqual({ file, hits: false });
      expect({ file, uses_fillDays: code.includes("fillDays(") }).toEqual({ file, uses_fillDays: true });
    }
    // dashboard 的日首 / 月首也必须来自 billing-time
    const dashboard = STRIP(read("routes/dashboard.ts"));
    expect(dashboard).toContain("billingDayStart(now)");
    expect(dashboard).toContain("billingMonthStart(now)");
  });

  test("已用流量读路径已切换：不再读 legacy 列，改读窗口求和 + 同源的策略上限", () => {
    const code = STRIP(read("routes/dashboard.ts"));
    // 反例守卫：`userPlan?.traffic_used` 是冻结的 legacy 展示列（没有任何写入方）
    expect(code).not.toContain("userPlan?.traffic_used");
    expect(code).toContain("sumWorkspaceTraffic(workspace.id");
    expect(code).toContain("policyView?.limits.traffic_period");
    // 上限与用量同源，避免「用量按策略窗口、上限按旧列」的错配
    expect(code).toContain("policyView?.limits.traffic_limit");
  });

  test("联邦缺口在**已挂载**的用量端点上可见（不是只加在无人调用的报告里）", () => {
    const code = STRIP(read("services/traffic.ts"));
    expect(code).toContain("traffic_used_unattributed_federated: federated");
    expect(code).toContain("sumFederatedUnattributedTraffic(workspaceId)");
    // 缺口不得并进 total_traffic
    expect(code).not.toMatch(/total_traffic:\s*[^,\n]*federated/);
  });
});
