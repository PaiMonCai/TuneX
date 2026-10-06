/**
 * V5-WP17.4 —— DNS **就绪性闸门**（执行器之前）与 **DNS 后继**（执行器之后）。
 *
 * 钉住的不变量：
 *
 * ① **闸门只对"显式开了自动解析"的转发生效**。没开的转发不该被 DNS 的事实拖住 ——
 *    否则一个可选功能会变成全局迁移的前置条件。
 * ② **就绪必须有证据**：provider 行存在只是**配置**，"最近成功写的新鲜度"或"只读探测成功"
 *    才是**证据**。一个刚配好、从来没写通过的 provider 不该让迁移开始。
 * ③ **没开自动解析 ⇒ 零外呼、零探测**；就绪的判定用新鲜度命中时**也不探测**（省一次出网）。
 * ④ **后继必须等迁移真的到达**（`applied_revision == config_revision`）。先写再搬 = 把客户端
 *    指向还没监听的机器；没到就这一拍不做，**下一拍再看**。
 * ⑤ **被闸门拦下是可见的事实**（`dns_gated` 带原因码）：静默地不迁移与"没有需要迁移的"在
 *    日志里长得一样，而前者的排查成本极高。
 */
import { describe, expect, test } from "bun:test";
import {
  DDNS_GATE_REASONS,
  DDNS_PROOF_MAX_AGE_MS,
  dnsPathReadiness,
  runDdnsSuccessor,
  type DdnsSuccessorDeps,
} from "../ddns-successor.ts";
import { runFailoverSweep } from "../failover-loop.ts";

const NOW = new Date("2026-10-05T04:00:00Z");

/**
 * 一条"已绑定且已开自动解析"的转发行。
 *
 * 注意：**字段齐全是必须的** —— `syncForwardDns` 对"没绑定"的判定是 fail-closed 的
 * （缺 `dns_mode`/`dns_domain`/`dns_record_type`/`dns_provider_id` 任一即按未绑定处理，
 * 返回 noop 且零外呼）。夹具漏字段的表现是"断言说没写，其实是被当成没绑定"，
 * 所以这里把执行器读到的每一列都列全（本文件第一版就漏了 `dns_mode`）。
 */
const binding = (over: Record<string, unknown> = {}) => ({
  id: 11,
  workspace_id: 7,
  dns_auto_resolve: true,
  dns_provider_id: 3,
  dns_domain: "edge.example.com",
  dns_record_type: "A",
  dns_mode: "multi_entry",
  dns_confirmed_values: ["203.0.113.9"],
  dns_synced_at: NOW,
  dns_verified: true,
  dns_last_error: null,
  dns_attempt_count: 0,
  dns_next_attempt_at: null,
  ingress_node_id: 5,
  applied_revision: 2,
  config_revision: 2,
  ...over,
});

function gateDeps(over: { row?: Record<string, unknown> | null; configured?: boolean; probe?: () => Promise<boolean> } = {}) {
  const probes: number[] = [];
  return {
    probes,
    deps: {
      db: { tunnel: { findFirst: async () => (over.row === undefined ? binding() : over.row) } },
      providerConfigured: async () => over.configured ?? true,
      probeProvider: async () => {
        probes.push(1);
        return over.probe ? over.probe() : true;
      },
      now: () => NOW,
    },
  };
}

/* ================================================================== */
/* 闸门                                                                */
/* ================================================================== */

describe("V5-WP17.4: 就绪闸门只对开启自动解析的转发生效", () => {
  test("没开自动解析 ⇒ 不适用、不拦、**不探测**", async () => {
    const g = gateDeps({ row: binding({ dns_auto_resolve: false }) });
    const result = await dnsPathReadiness(g.deps, { tunnelId: 11 });
    expect(result).toEqual({ applicable: false, ready: true });
    expect(g.probes).toHaveLength(0);
  });

  test("没有这一行 / 没绑定 provider ⇒ 不适用或明确不可用", async () => {
    expect(await dnsPathReadiness(gateDeps({ row: null }).deps, { tunnelId: 11 })).toEqual({
      applicable: false,
      ready: true,
    });
    const result = await dnsPathReadiness(gateDeps({ row: binding({ dns_provider_id: null }) }).deps, { tunnelId: 11 });
    expect(result).toEqual({ applicable: true, ready: false, reason: DDNS_GATE_REASONS.dns_provider_unconfigured });
  });
});

describe("V5-WP17.4: 就绪必须有证据（配置存在不算证据）", () => {
  test("provider 凭据不是封存形态 ⇒ 明确不可用（不是「没配 provider」也不是「路径不可用」）", async () => {
    const result = await dnsPathReadiness(gateDeps({ configured: false }).deps, { tunnelId: 11 });
    expect(result).toEqual({ applicable: true, ready: false, reason: DDNS_GATE_REASONS.dns_provider_unconfigured });
  });

  test("最近一次成功写**新鲜** ⇒ 就绪，且**不做探测**（省一次出网）", async () => {
    const g = gateDeps({ row: binding({ dns_synced_at: new Date(NOW.getTime() - DDNS_PROOF_MAX_AGE_MS + 1_000) }) });
    const result = await dnsPathReadiness(g.deps, { tunnelId: 11 });
    expect(result).toEqual({ applicable: true, ready: true, proof: "fresh_sync" });
    expect(g.probes).toHaveLength(0);
  });

  test("成功写过期 ⇒ 用只读探测兜底；探测成功也算就绪（但要标明证据是探测）", async () => {
    const g = gateDeps({ row: binding({ dns_synced_at: new Date(NOW.getTime() - DDNS_PROOF_MAX_AGE_MS - 1_000) }) });
    const result = await dnsPathReadiness(g.deps, { tunnelId: 11 });
    expect(result).toEqual({ applicable: true, ready: true, proof: "probe" });
    expect(g.probes).toHaveLength(1);
  });

  test("从来没有成功写过 + 探测失败 ⇒ `dns_path_unready`", async () => {
    const g = gateDeps({ row: binding({ dns_synced_at: null }), probe: async () => false });
    const result = await dnsPathReadiness(g.deps, { tunnelId: 11 });
    expect(result).toEqual({ applicable: true, ready: false, reason: DDNS_GATE_REASONS.dns_path_unready });
  });

  test("探测**抛错**也是「不可用」，不能让扫描崩掉", async () => {
    const g = gateDeps({
      row: binding({ dns_synced_at: null }),
      probe: async () => {
        throw new Error("connection refused");
      },
    });
    const result = await dnsPathReadiness(g.deps, { tunnelId: 11 });
    expect(result).toEqual({ applicable: true, ready: false, reason: DDNS_GATE_REASONS.dns_path_unready });
  });
});

/* ================================================================== */
/* 后继                                                                */
/* ================================================================== */

function successorDeps(over: { row?: Record<string, unknown> | null; desired?: unknown } = {}) {
  const calls = { desired: 0, clients: 0, writes: 0 };
  const deps = {
    db: {
      tunnel: {
        findFirst: async (args: unknown) => {
          const select = (args as { select?: Record<string, unknown> }).select ?? {};
          if ("dns_provider" in select) return { dns_provider: { id: 3, config: "v1.a.b.c" } };
          return over.row === undefined ? binding() : over.row;
        },
        update: async () => ({}),
      },
    },
    clientFor: () => {
      calls.clients += 1;
      return {
        supportsReadBack: true,
        readValues: async () => ["203.0.113.9"],
        writeValues: async () => {
          calls.writes += 1;
        },
      };
    },
    desiredValues: async () => {
      calls.desired += 1;
      return (over.desired ?? { ok: true, values: ["203.0.113.9"] }) as never;
    },
    now: () => NOW,
    auditSink: { write: async () => {} },
  } as unknown as DdnsSuccessorDeps;
  return { deps, calls };
}

describe("V5-WP17.4: 后继的前置条件", () => {
  test("没开自动解析 / 没绑定 ⇒ not_applicable 且**零外呼**", async () => {
    const s = successorDeps({ row: binding({ dns_auto_resolve: false }) });
    expect((await runDdnsSuccessor(s.deps, { tunnelId: 11 })).outcome).toBe("not_applicable");
    expect(s.calls).toEqual({ desired: 0, clients: 0, writes: 0 });
  });

  test("迁移还没到（applied ≠ config）⇒ waiting_for_rollout 且**零外呼**", async () => {
    const s = successorDeps({ row: binding({ applied_revision: 1, config_revision: 2 }) });
    const result = await runDdnsSuccessor(s.deps, { tunnelId: 11 });
    expect(result).toEqual({ outcome: "waiting_for_rollout", applied_revision: 1, config_revision: 2 });
    expect(s.calls).toEqual({ desired: 0, clients: 0, writes: 0 });
  });

  test("到达之后才真的同步（值集没变时**不写**）", async () => {
    const s = successorDeps({ row: binding({ dns_confirmed_values: ["203.0.113.9"] }) });
    const result = await runDdnsSuccessor(s.deps, { tunnelId: 11 });
    expect(result.outcome).toBe("synced");
    if (result.outcome === "synced") expect(result.sync.action).toBe("noop");
    expect(s.calls.writes).toBe(0);
  });

  test("值集变了 ⇒ 真的写一次", async () => {
    const s = successorDeps({ row: binding({ dns_confirmed_values: [] }) });
    const result = await runDdnsSuccessor(s.deps, { tunnelId: 11 });
    expect(result.outcome).toBe("synced");
    if (result.outcome === "synced") expect(result.sync.action).toBe("synced");
    expect(s.calls.writes).toBe(1);
  });
});

/* ================================================================== */
/* 集成：闸门与后继在扫描里的位置                                      */
/* ================================================================== */

describe("V5-WP17.4: 扫描里的闸门与后继", () => {
  const policy = async () => ({ auto_failover: true, auto_failback: false });

  test("被闸门拦下的转发**不调用执行器**，且原因是可见的事实", async () => {
    const executed: number[] = [];
    const successors: number[] = [];
    const result = await runFailoverSweep({
      readPolicy: policy,
      tunnelIds: [1, 2],
      log: () => undefined,
      dnsGate: async (tunnelId) =>
        tunnelId === 1
          ? { applicable: true, ready: false, reason: DDNS_GATE_REASONS.dns_path_unready }
          : { applicable: false, ready: true },
      execute: (async (tunnelId: number) => {
        executed.push(tunnelId);
        return { outcome: "hold", reason: "x" } as never;
      }) as never,
      dnsSuccessor: async (tunnelId) => {
        successors.push(tunnelId);
        return { outcome: "not_applicable" };
      },
    });
    expect(executed).toEqual([2]);
    expect(successors).toEqual([2]);
    expect(result.dns_gated).toEqual([{ tunnel_id: 1, reason: DDNS_GATE_REASONS.dns_path_unready }]);
    expect(result.evaluated).toBe(2);
  });

  test("后继抛错**不影响**迁移判定（DNS 有自己的退避与重试节拍）", async () => {
    const logs: string[] = [];
    const result = await runFailoverSweep({
      readPolicy: policy,
      tunnelIds: [7],
      log: (e) => void logs.push(e.message),
      dnsGate: async () => ({ applicable: false, ready: true }),
      execute: (async () => ({ outcome: "moved", reason: "x" }) as never) as never,
      dnsSuccessor: async () => {
        throw new Error("boom");
      },
    });
    expect(result.moved).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(logs).toContain("ddns successor failed");
  });
});
