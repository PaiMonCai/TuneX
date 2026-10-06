/**
 * task-8 —— **独立 DDNS 同步节拍**（与 failover 策略解耦）。
 *
 * 这里钉的是一个真实产品断点：DDNS 的写入以前只挂在 failover 扫描末尾，而那个扫描在
 * `auto_failover`/`auto_failback` 都关时整轮直接返回；两个开关的**缺省值就是关**。
 * 于是"绑定域名 + 开自动同步"在默认部署下永远不会写 —— 一个纯 DNS 能力被一个与它无关的
 * 安全闸门顺带关掉了。
 *
 * 断言分三层：
 *   ① **默认策略下也会写**，而且这条节拍**根本不去读** FAILOVER_POLICY（读它就抛错也不影响）；
 *   ② 走**真实**后继 + **真实**执行器：第一次真的写出去，第二次值集未变则**零外呼**；
 *   ③ 一条转发失败不拖垮整轮扫描，且"写了没读回"不会被计成"已确认"。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { runDdnsSyncSweep, runDdnsSuccessor, successorSummary, type DdnsSuccessorDeps } from "../ddns-successor.ts";
import type { DdnsProviderClient } from "../ddns-executor.ts";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const OWNER_IP = "203.0.113.9";

interface TunnelRow {
  id: number;
  workspace_id: number | null;
  dns_domain: string | null;
  dns_record_type: string | null;
  dns_mode: string | null;
  dns_provider_id: number | null;
  dns_auto_resolve: boolean | null;
  dns_confirmed_values: unknown;
  dns_synced_at: Date | null;
  dns_verified: boolean | null;
  dns_last_error: string | null;
  dns_attempt_count: number | null;
  dns_next_attempt_at: Date | null;
  ingress_node_id: number | null;
  config_revision: number | null;
  applied_revision: number | null;
}

/** 一条"绑定完整、revision 已对齐"的转发行（默认 = 刚绑定、还没写过）。 */
function tunnelRow(over: Partial<TunnelRow> = {}): TunnelRow {
  return {
    id: 11,
    workspace_id: 7,
    dns_domain: "edge.example.com",
    dns_record_type: "A",
    dns_mode: "single_active",
    dns_provider_id: 3,
    dns_auto_resolve: true,
    dns_confirmed_values: [],
    dns_synced_at: null,
    dns_verified: false,
    dns_last_error: null,
    dns_attempt_count: 0,
    dns_next_attempt_at: null,
    ingress_node_id: 5,
    config_revision: 4,
    applied_revision: 4,
    ...over,
  };
}

/**
 * 替身表：`findFirst` 同时服务后继（少列）与执行器（多列），`update` **真的落库**
 * （否则"第二次零外呼"就无从验证 —— 执行器把 `dns_confirmed_values` 写成已确认值，
 * 下一拍才会算出 `noop`）。
 */
function tableStub(rows: Map<number, TunnelRow>) {
  const tunnel = {
    findFirst: async (args: unknown) => {
      const id = (args as { where?: { id?: number } }).where?.id;
      const select = (args as { select?: Record<string, unknown> }).select ?? {};
      const found = id === undefined ? undefined : rows.get(id);
      if (!found) return null;
      if ("dns_provider" in select) {
        return { dns_provider: found.dns_provider_id === null ? null : { id: found.dns_provider_id, config: "v1.stub.sealed" } };
      }
      return { ...found };
    },
    update: async (args: unknown) => {
      const { where, data } = args as { where: { id: number }; data: Partial<TunnelRow> };
      const current = rows.get(where.id);
      if (current) rows.set(where.id, { ...current, ...data });
      return {};
    },
  };
  return { tunnel };
}

/** 计数 provider：读回**回声**刚写进去的值（模拟一个支持读回的真实 provider）。 */
function countingProvider() {
  let current: string[] = [];
  const writes: string[][] = [];
  const client: DdnsProviderClient = {
    supportsReadBack: true,
    readValues: async () => [...current],
    writeValues: async (request) => {
      writes.push([...request.values]);
      current = [...request.values];
    },
  };
  return { client, writes };
}

function successorDeps(rows: Map<number, TunnelRow>, client: DdnsProviderClient): DdnsSuccessorDeps {
  return {
    db: tableStub(rows) as unknown as DdnsSuccessorDeps["db"],
    clientFor: () => client,
    desiredValues: async ({ ownerNodeId }) =>
      ownerNodeId === null ? { ok: false as const, reason: "owner 未知" } : { ok: true as const, values: [OWNER_IP] },
    now: () => NOW,
  };
}

describe("默认策略下 DDNS 仍然会写（这条节拍不看 failover 策略）", () => {
  test("FAILOVER_POLICY 两个开关都关（生产缺省）⇒ 照样写出去", async () => {
    const { systemConfig } = await import("../config.ts");
    const original = systemConfig.getConfig;
    const policyReads: string[] = [];
    try {
      // 生产缺省：显式的 {"auto_failover":false,"auto_failback":false}。
      (systemConfig as unknown as { getConfig: (k: string) => Promise<string> }).getConfig = async (key: string) => {
        policyReads.push(key);
        return '{"auto_failover":false,"auto_failback":false}';
      };

      const rows = new Map([[11, tunnelRow()]]);
      const { client, writes } = countingProvider();
      const deps = successorDeps(rows, client);
      const seenArgs: unknown[] = [];
      const sweep = await runDdnsSyncSweep({
        db: {
          tunnel: {
            findMany: async (args: unknown) => {
              seenArgs.push(args);
              return [{ id: 11 }];
            },
          },
        },
        sync: async (id) => successorSummary(await runDdnsSuccessor(deps, { tunnelId: id })),
      });

      expect(sweep.evaluated).toBe(1);
      expect(sweep.synced).toBe(1);
      expect(writes).toEqual([[OWNER_IP]]);
      // 而且这条节拍**根本不去读**策略：读它就是耦合，耦合就是这次断点的成因。
      expect(policyReads).toEqual([]);
      // 候选集合的判据 = "开了自动同步" + "绑了 provider"。
      expect(seenArgs).toHaveLength(1);
      const where = (seenArgs[0] as { where: Record<string, unknown> }).where;
      expect(where).toEqual({ dns_auto_resolve: true, dns_provider_id: { not: null } });
    } finally {
      (systemConfig as unknown as { getConfig: unknown }).getConfig = original;
    }
  });

  test("即使读策略会抛错（DB 不可用），这条节拍照样同步", async () => {
    const { systemConfig } = await import("../config.ts");
    const original = systemConfig.getConfig;
    try {
      (systemConfig as unknown as { getConfig: () => Promise<string> }).getConfig = async () => {
        throw new Error("config 表不可用");
      };
      const rows = new Map([[11, tunnelRow()]]);
      const { client, writes } = countingProvider();
      const deps = successorDeps(rows, client);
      const sweep = await runDdnsSyncSweep({ tunnelIds: [11], sync: async (id) => successorSummary(await runDdnsSuccessor(deps, { tunnelId: id })) });
      expect(sweep.synced).toBe(1);
      expect(writes).toHaveLength(1);
    } finally {
      (systemConfig as unknown as { getConfig: unknown }).getConfig = original;
    }
  });
});

describe("两个 tick 走真实后继 + 真实执行器", () => {
  test("第一次写出去；值集未变时第二次**零外呼**（noop，不算 synced）", async () => {
    const rows = new Map([[11, tunnelRow()]]);
    const { client, writes } = countingProvider();
    const deps = successorDeps(rows, client);
    const sync = async (id: number) => successorSummary(await runDdnsSuccessor(deps, { tunnelId: id }));

    const first = await runDdnsSyncSweep({ tunnelIds: [11], sync });
    expect(first.synced).toBe(1);
    expect(first.noop).toBe(0);
    expect(writes).toEqual([[OWNER_IP]]);
    // 读回确认 = 执行器的 verified 分支；写回的确认值集必须是期望值。
    expect(rows.get(11)!.dns_verified).toBe(true);
    expect(rows.get(11)!.dns_confirmed_values).toEqual([OWNER_IP]);
    expect(rows.get(11)!.dns_synced_at).toBeInstanceOf(Date);

    const second = await runDdnsSyncSweep({ tunnelIds: [11], sync });
    expect(second.outcomes[0]!.action).toBe("noop");
    expect(second.noop).toBe(1);
    expect(second.synced).toBe(0);
    expect(writes).toHaveLength(1); // 零外呼
  });

  test("新绑定（confirmed 为空）在一次 tick 内 pending → 已确认", async () => {
    // "刚绑定"的真实形状：dns_synced_at=null / confirmed=[] / verified=false。
    const rows = new Map([[11, tunnelRow({ dns_synced_at: null, dns_confirmed_values: [], dns_verified: false })]]);
    const { client } = countingProvider();
    const deps = successorDeps(rows, client);
    const sweep = await runDdnsSyncSweep({ tunnelIds: [11], sync: async (id) => successorSummary(await runDdnsSuccessor(deps, { tunnelId: id })) });
    expect(sweep.synced).toBe(1);
    expect(rows.get(11)!.dns_verified).toBe(true);
    expect(rows.get(11)!.dns_last_error).toBeNull();
  });
});

describe("汇总语义：不谎报，且一条坏数据不拖垮整轮", () => {
  test("一条转发抛错 ⇒ 其余照常同步，errors=1 且不中断", async () => {
    const calls: number[] = [];
    const r = await runDdnsSyncSweep({
      tunnelIds: [11, 12, 13],
      sync: async (id) => {
        calls.push(id);
        if (id === 12) throw new Error("boom");
        return { outcome: "synced", action: "synced" };
      },
      log: () => undefined,
    });
    expect(calls).toEqual([11, 12, 13]); // 第 3 条没有被第 2 条带走
    expect(r.synced).toBe(2);
    expect(r.errors).toBe(1);
    expect(r.outcomes.map((o) => o.tunnel_id)).toEqual([11, 12, 13]);
  });

  test("写了但没读回 ⇒ unverified，绝不计成 synced", async () => {
    const r = await runDdnsSyncSweep({ tunnelIds: [11], sync: async () => ({ outcome: "synced", action: "synced_unverified" }) });
    expect(r.unverified).toBe(1);
    expect(r.synced).toBe(0);
  });

  test("执行器报出的失败 ⇒ failed（已排退避），不是 synced，也不算异常", async () => {
    const r = await runDdnsSyncSweep({ tunnelIds: [11], sync: async () => ({ outcome: "synced", action: "error" }) });
    expect(r.failed).toBe(1);
    expect(r.synced).toBe(0);
    expect(r.errors).toBe(0);
  });

  test("退避窗口内 / 未开自动解析 ⇒ 计成 noop（零外呼），不是 synced", async () => {
    const r = await runDdnsSyncSweep({ tunnelIds: [11, 12], sync: async (id) => ({ outcome: "synced", action: id === 11 ? "backoff" : "suggested" }) });
    expect(r.noop).toBe(2);
    expect(r.synced).toBe(0);
  });

  test("等 rollout / 未绑定分别计成 waiting / not_applicable", async () => {
    const r = await runDdnsSyncSweep({
      tunnelIds: [11, 12, 13],
      sync: async (id) => (id === 11 ? { outcome: "waiting_for_rollout" } : id === 12 ? { outcome: "not_applicable" } : { outcome: "synced", action: "synced" }),
    });
    expect(r.waiting).toBe(1);
    expect(r.not_applicable).toBe(1);
    expect(r.synced).toBe(1);
  });

  test("没有任何候选 ⇒ evaluated=0，且不调用任何同步", async () => {
    let called = 0;
    const r = await runDdnsSyncSweep({ db: { tunnel: { findMany: async () => [] } }, sync: async () => { called += 1; return { outcome: "synced" }; } });
    expect(r.evaluated).toBe(0);
    expect(called).toBe(0);
  });
});

describe("worker 接线", () => {
  test("注册了独立节拍 cron_ddns_sync，且处理器调用同一个后继扫描", () => {
    // 这是**接线**锚点：worker.ts 顶层会建 BullMQ/Redis 连接，import 它会真的连 Redis，
    // 所以这里读源码文本断言"注册了这条节拍 + 用的是同一个 runDdnsSyncSweep"。
    // 行为正确性由上面的用例与真实环境端到端证明。
    const source = readFileSync(new URL("../../worker.ts", import.meta.url), "utf8");
    expect(source).toContain('name: "cron_ddns_sync"');
    expect(source).toContain('case "cron_ddns_sync"');
    expect(source).toContain("runDdnsSyncSweep");
    // 这条节拍不能靠 failover 扫描捎带：它必须是自己的 case。
    expect(source).toContain('await import("./services/ddns-successor.ts")');
  });
});
