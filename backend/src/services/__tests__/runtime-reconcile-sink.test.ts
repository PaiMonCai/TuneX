/**
 * V4-F2 Gate 缺陷 1 回归 —— `runtime-reconcile-sink.ts` 的同-revision 重发记账。
 *
 * ── 被钉住的缺陷 ──
 * 维护（§13.4.2 maintenance）期间保存的 desired 不走 rollout：`patchForward` 的
 * VALIDATE 被 `lifecycleAcceptsBusiness()` 拒绝并返回 `blocked`（失败规则一），
 * **一条 `forward_rollout` 行都不建**。退出维护后能把 runtime 推到最新 desired 的
 * 通道只剩 reconciler 的同-revision 重发。旧实现在 dispatch + ACK 之后**不写库**，
 * 于是出现「Agent 已跑新 revision（数据面已切）、面板 `tunnel.applied_revision`
 * 停在旧值」：reconciler 每 30 s 再判一次 `revision_behind` 并重复下发同一
 * revision，永不静默。
 *
 * ── 断言矩阵 ──
 *   A. DIRECT / RELAY 成功 ⇒ CAS 推进 `applied_revision`（同一 revision；写列里
 *      没有 `config_revision` / 端口 / 节点绑定；`isRevisionBehind` 由真变假 =
 *      能静下来）；
 *   B. 失败不记账：ACK 失败 / RELAY 半途失败 / desired 非 active / desired 已变；
 *   C. CAS 语义：并发推进（revision 已被别人改）不脏写不抛错；`applied_revision`
 *      为 NULL 的「从未 ACK」行也必须被推进（SQL 的 `<` 对 NULL 不成立）；
 *   D. 端到端（真实 sink + 真实 reconciler）：维护中静默、退出后一轮收敛、
 *      第二轮零 findings（= Gate G1.3/G1.4/F2.5.3 的复现路径）。
 *
 * 全程离线：所有 IO（DB / orchestrator / 时钟）都是注入替身，不连 MySQL /
 * Redis / 网络。跑法（与 CI 一致）：`cd backend && bun run test:unit`。
 */

import { describe, expect, it } from "bun:test";

import {
  executeReconcile,
  isRevisionBehind,
  type DesiredTunnel,
  type NodeOnlineInput,
  type NodeReport,
  type ReconcileDeps,
} from "../reconciler.ts";
import {
  createRuntimeReconcileSink,
  createTunnelLedger,
  type ReconcileSinkDb,
  type SinkEgressTarget,
  type SinkOrchestrator,
  type SinkTunnel,
} from "../runtime-reconcile-sink.ts";

/* ================================================================== */
/* 内存替身                                                            */
/* ================================================================== */

const NOW = new Date("2026-09-27T00:00:00.000Z");

interface TunnelRow extends SinkTunnel {
  /** 记录每次 CAS 的入参，用来断言「写了哪些列 / where 是不是幂等闸门」。 */
  writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
}

function makeTunnel(over: Partial<SinkTunnel> = {}): TunnelRow {
  return {
    id: 1,
    desired_status: "active",
    config_revision: 3,
    applied_revision: 1,
    apply_status: "active",
    apply_error_code: null,
    apply_error: null,
    last_applied_at: null,
    tunnel_mode: "direct",
    listen_port: 21010,
    listen_ip: null,
    remote_host: "10.0.0.3",
    remote_port: 80,
    egress_port: null,
    egress_pool_id: null,
    ingress_node: { id: 11, node_id: "F2-A", connect_ip: "127.0.0.1", role: "both" },
    egress_node: null,
    egress_pool: null,
    writes: [],
    ...over,
  };
}

/** 一条 RELAY desired（入口 11 / 出口 12 / 出口池 7），默认 config 3 applied 1。 */
function makeRelayTunnel(over: Partial<SinkTunnel> = {}): TunnelRow {
  return makeTunnel({
    tunnel_mode: "relay",
    config_revision: 3,
    applied_revision: 1,
    remote_host: null,
    remote_port: null,
    egress_port: 31000,
    egress_pool_id: 7,
    egress_node: { id: 12, node_id: "F2-B", connect_ip: "10.0.0.9", role: "egress", lb_strategy: "round" },
    egress_pool: { lb_strategy: "round", targets: [egressTarget()] },
    ...over,
  });
}

/**
 * 内存 DB 替身：实现 `tunnel.findUnique` / `tunnel.updateMany`（Prisma 子集）。
 *
 * `updateMany` **按真实 SQL 语义求值 where**（不是无条件返回 count=1）：否则
 * 「CAS 未命中」那几条断言就是自证——替身永远成功，脏写也测不出来。尤其
 * `applied_revision < n` 在对端为 NULL 时求值为 NULL（不成立），替身必须复刻，
 * 显式 `{ applied_revision: null }` 这条 OR 才有存在意义。
 */
function makeDb(rows: TunnelRow[]): ReconcileSinkDb {
  return {
    tunnel: {
      findUnique: async (args: unknown) => {
        const a = args as { where: { id: number } };
        return rows.find((r) => r.id === a.where.id) ?? null;
      },
      updateMany: async (args: unknown) => {
        const a = args as {
          where: { id: number; config_revision?: number; OR?: Array<Record<string, unknown>> };
          data: Record<string, unknown>;
        };
        const row = rows.find((r) => r.id === a.where.id);
        row?.writes.push({ where: a.where as unknown as Record<string, unknown>, data: a.data });

        const appliedClause = (clause: Record<string, unknown>): boolean => {
          if (!("applied_revision" in clause)) return false;
          const v = clause.applied_revision;
          if (v === null) return row != null && row.applied_revision === null;
          const lt = (v as { lt?: number } | null)?.lt;
          // SQL：NULL < n ⇒ NULL（不成立）。少了显式 null 分支，「从未 ACK」的行
          // 就永远推进不了——而 reconciler 恰好把 null 判为「落后」。
          if (row == null || row.applied_revision == null || lt === undefined) return false;
          return row.applied_revision < lt;
        };

        const matches =
          row != null &&
          (a.where.config_revision === undefined || row.config_revision === a.where.config_revision) &&
          (a.where.OR === undefined || a.where.OR.some(appliedClause));

        if (!matches) return { count: 0 };
        Object.assign(row, a.data);
        return { count: 1 };
      },
    },
  };
}

/** 记录下发调用、失败可控的 orchestrator 替身。 */
function makeOrchestrator(opts: { egressOk?: boolean; ingressOk?: boolean; directOk?: boolean } = {}) {
  const calls: Array<{ kind: "direct" | "egress" | "ingress"; revision: number; tunnelId: number }> = [];
  const ok = (revision: number, commandId: string) => ({
    ok: true as const,
    result: { commandId, revision, ack: {} as never },
  });
  const fail = (error_code: string, error: string) => ({ ok: false as const, error_code, error });

  const orchestrator: SinkOrchestrator = {
    dispatchDirect: async (input) => {
      calls.push({ kind: "direct", revision: input.revision, tunnelId: input.tunnelId });
      return (opts.directOk === false
        ? fail("agent_rejected", "agent rejected command")
        : ok(input.revision, "c-direct")) as never;
    },
    dispatchEgress: async (input) => {
      calls.push({ kind: "egress", revision: input.revision, tunnelId: input.tunnelId });
      return (opts.egressOk === false
        ? fail("ack_timeout", "egress ack timeout")
        : { ...ok(input.revision, "c-egress"), egress_host: "10.0.0.9", egress_port: input.egressPort }) as never;
    },
    dispatchIngress: async (input) => {
      calls.push({ kind: "ingress", revision: input.revision, tunnelId: input.tunnelId });
      return (opts.ingressOk === false
        ? fail("ack_timeout", "ingress ack timeout")
        : ok(input.revision, "c-ingress")) as never;
    },
  };
  return { calls, orchestrator };
}

function sinkFor(rows: TunnelRow[], opts: Parameters<typeof makeOrchestrator>[0] = {}) {
  const db = makeDb(rows);
  const { calls, orchestrator } = makeOrchestrator(opts);
  const sink = createRuntimeReconcileSink({
    ledger: createTunnelLedger(async () => db),
    orchestrator: () => orchestrator,
    now: () => NOW,
  });
  return { sink, calls };
}

function egressTarget(over: Partial<SinkEgressTarget> = {}): SinkEgressTarget {
  return { host: "10.0.0.5", port: 8080, weight: 1, order_by: 0, ...over };
}

/* ================================================================== */
/* A. 成功必须记账                                                      */
/* ================================================================== */

describe("A. 同-revision 重发成功后必须推进 applied_revision", () => {
  it("DIRECT：ACK 成功 ⇒ applied_revision 追平 config_revision", async () => {
    const row = makeTunnel({ applied_revision: 1, config_revision: 3 });
    expect(isRevisionBehind(row)).toBe(true);

    const { sink } = sinkFor([row]);
    await sink.resendSameRevision({ tunnel_id: 1, revision: 3, envelope: null });

    expect(row.applied_revision).toBe(3);
    expect(row.apply_status).toBe("active");
    expect(row.apply_error_code).toBeNull();
    expect(row.apply_error).toBeNull();
    expect(row.last_applied_at).toEqual(NOW);
    // 收敛判定用真函数，不在测试里重抄一遍条件。
    expect(isRevisionBehind(row)).toBe(false);
  });

  it("记账 where 是 CAS，写列里没有 config_revision / 端口 / 节点绑定", async () => {
    const row = makeTunnel({ config_revision: 5, applied_revision: 1 });
    const { sink } = sinkFor([row]);
    await sink.resendSameRevision({ tunnel_id: 1, revision: 5, envelope: null });

    const write = row.writes.at(-1)!;
    expect(write.where).toMatchObject({ id: 1, config_revision: 5 });
    // 「从未 ACK」必须显式 OR 出来：SQL 的 `<` 对 NULL 不成立。
    expect(write.where.OR).toEqual([{ applied_revision: null }, { applied_revision: { lt: 5 } }]);
    expect(Object.keys(write.data).sort()).toEqual(
      ["applied_revision", "apply_error", "apply_error_code", "apply_status", "last_applied_at"].sort(),
    );
    for (const forbidden of [
      "config_revision",
      "desired_status",
      "listen_port",
      "egress_port",
      "egress_pool_id",
      "ingress_node_id",
      "egress_node_id",
    ]) {
      expect(write.data).not.toHaveProperty(forbidden);
    }
    expect(row.config_revision).toBe(5);
  });

  it("applied_revision=null（从未 ACK）也被推进到 revision", async () => {
    const row = makeTunnel({ applied_revision: null, config_revision: 4 });
    const { sink } = sinkFor([row]);
    await sink.resendSameRevision({ tunnel_id: 1, revision: 4, envelope: null });
    expect(row.applied_revision).toBe(4);
    expect(isRevisionBehind(row)).toBe(false);
  });

  it("RELAY：出口 + 入口都 ACK 之后才记账，且只记一次", async () => {
    const row = makeRelayTunnel();
    const { sink, calls } = sinkFor([row]);
    await sink.resendSameRevision({ tunnel_id: 1, revision: 3, envelope: null });

    expect(calls.map((c) => c.kind)).toEqual(["egress", "ingress"]);
    expect(row.applied_revision).toBe(3);
    expect(row.writes).toHaveLength(1);
  });
});

/* ================================================================== */
/* B. 失败 / 非目标状态不记账                                            */
/* ================================================================== */

describe("B. 没有真实 ACK 就绝不记账", () => {
  it("DIRECT ACK 失败 ⇒ 抛错且 applied_revision 不动", async () => {
    const row = makeTunnel({ applied_revision: 1, config_revision: 3 });
    const { sink } = sinkFor([row], { directOk: false });
    await expect(sink.resendSameRevision({ tunnel_id: 1, revision: 3, envelope: null })).rejects.toThrow();
    expect(row.applied_revision).toBe(1);
    expect(row.writes).toHaveLength(0);
  });

  it("RELAY 入口失败（出口已 ACK）⇒ 不记账，下一轮同 revision 重试", async () => {
    const row = makeRelayTunnel();
    const { sink } = sinkFor([row], { ingressOk: false });
    await expect(sink.resendSameRevision({ tunnel_id: 1, revision: 3, envelope: null })).rejects.toThrow();
    expect(row.applied_revision).toBe(1);
    expect(row.writes).toHaveLength(0);
  });

  it("RELAY 出口失败 ⇒ 不记账且不打入口（§13.3.5 顺序铁律）", async () => {
    const row = makeRelayTunnel();
    const { sink, calls } = sinkFor([row], { egressOk: false });
    await expect(sink.resendSameRevision({ tunnel_id: 1, revision: 3, envelope: null })).rejects.toThrow();
    expect(calls.map((c) => c.kind)).toEqual(["egress"]);
    expect(row.writes).toHaveLength(0);
  });

  it("desired 非 active ⇒ 一条都不发、不记账", async () => {
    const row = makeTunnel({ desired_status: "inactive", applied_revision: 1, config_revision: 3 });
    const { sink, calls } = sinkFor([row]);
    await sink.resendSameRevision({ tunnel_id: 1, revision: 3, envelope: null });
    expect(calls).toHaveLength(0);
    expect(row.writes).toHaveLength(0);
    expect(row.applied_revision).toBe(1);
  });

  it("重发期间 desired 被改（config_revision 前移）⇒ 抛错且不记账", async () => {
    const row = makeTunnel({ config_revision: 4, applied_revision: 1 });
    const { sink, calls } = sinkFor([row]);
    await expect(sink.resendSameRevision({ tunnel_id: 1, revision: 3, envelope: null })).rejects.toThrow(
      /revision changed while reconciling/,
    );
    expect(calls).toHaveLength(0);
    expect(row.applied_revision).toBe(1);
  });
});

/* ================================================================== */
/* C. CAS 语义                                                          */
/* ================================================================== */

describe("C. 记账是 CAS：并发推进不脏写、不把并发编辑伪装成下发故障", () => {
  it("ACK 回来前 desired 被再次推进（CAS 未命中）⇒ 不抛错、不覆盖新 desired", async () => {
    const row = makeTunnel({ config_revision: 3, applied_revision: 1 });
    const base = makeOrchestrator();
    const racing: SinkOrchestrator = {
      ...base.orchestrator,
      dispatchDirect: async (input) => {
        row.config_revision = 4; // 模拟「用户又编辑了一次」发生在 ACK 之前
        return (await base.orchestrator.dispatchDirect(input)) as never;
      },
    };
    const sink = createRuntimeReconcileSink({
      ledger: createTunnelLedger(async () => makeDb([row])),
      orchestrator: () => racing,
      now: () => NOW,
    });

    // 不抛错：CAS 未命中不是下发故障，本轮结果按过期丢弃即可（抛错会被
    // reconciler 记成 failed，把一次正常并发编辑渲染成故障）。
    await sink.resendSameRevision({ tunnel_id: 1, revision: 3, envelope: null });

    // 旧 revision 的 ACK 不记到新 desired 头上；下一轮按 4 重新收敛。
    expect(row.applied_revision).toBe(1);
    expect(row.config_revision).toBe(4);
    expect(isRevisionBehind(row)).toBe(true);
    expect(row.writes.at(-1)?.data.applied_revision).toBe(3); // 尝试过，被 CAS 拒绝
  });

  it("markApplied 幂等：已追平的行返回 false 且不写", async () => {
    const row = makeTunnel({ config_revision: 3, applied_revision: 3 });
    const ledger = createTunnelLedger(async () => makeDb([row]));
    expect(await ledger.markApplied({ tunnelId: 1, revision: 3, at: NOW })).toBe(false);
    expect(row.applied_revision).toBe(3);
  });

  it("markApplied 命中：落后 / 为空的行返回 true 并追平", async () => {
    const behind = makeTunnel({ config_revision: 3, applied_revision: 2 });
    expect(await createTunnelLedger(async () => makeDb([behind])).markApplied({ tunnelId: 1, revision: 3, at: NOW }))
      .toBe(true);
    expect(behind.applied_revision).toBe(3);

    const fresh = makeTunnel({ config_revision: 3, applied_revision: null });
    expect(await createTunnelLedger(async () => makeDb([fresh])).markApplied({ tunnelId: 1, revision: 3, at: NOW }))
      .toBe(true);
    expect(fresh.applied_revision).toBe(3);
  });
});

/* ================================================================== */
/* D. 端到端：维护中静默、退出后一轮收敛（Gate 复现路径）                  */
/* ================================================================== */

/**
 * 端到端 deps：DB 事实 = `row`（记账会回写到它），sink = **真实**
 * `createRuntimeReconcileSink` —— 本文件要证明的正是「reconcile 收敛路径自己会
 * 记账」。Agent 快照两侧都自报 revision 3，与 Gate 实测一致：数据面已经切到最新，
 * 落后的是面板账本。
 */
function reconcileDeps(row: TunnelRow, lifecycles: { ingress: string; egress: string }): ReconcileDeps {
  const node = (node_id: number, lifecycle: string): NodeOnlineInput => ({
    node_id,
    status: "active",
    last_seen_at: NOW,
    reported_at: NOW,
    lifecycle,
  });
  const reports = new Map<number, NodeReport>([
    [11, {
      reported_at: NOW,
      last_error: null,
      tunnels: [{ id: "tunex-1-relay", mode: "relay", ingress_port: 21010, revision: 3 }],
    }],
    [12, {
      reported_at: NOW,
      last_error: null,
      tunnels: [{ id: "tunex-1-egress", mode: "egress", egress_port: 31000, revision: 3 }],
    }],
  ]);
  return {
    tunnels: async () => [row as unknown as DesiredTunnel],
    nodes: async () => [node(11, lifecycles.ingress), node(12, lifecycles.egress)],
    reports: async () => reports,
    sink: createRuntimeReconcileSink({
      ledger: createTunnelLedger(async () => makeDb([row])),
      orchestrator: () => makeOrchestrator().orchestrator,
      now: () => NOW,
    }),
    now: () => NOW,
  };
}

describe("D. maintenance 退出后的收敛（Gate V4-F2 G1.3 / G1.4 / F2.5.3 复现）", () => {
  it("入口 maintenance：一条都不发（§13.4.2 等待），applied_revision 不动", async () => {
    const row = makeRelayTunnel();
    const out = await executeReconcile(reconcileDeps(row, { ingress: "maintenance", egress: "active" }));
    expect(out.resent).toBe(0);
    expect(row.applied_revision).toBe(1);
    expect(row.writes).toHaveLength(0);
    expect(out.findings.map((f) => f.code)).toContain("node_in_maintenance");
  });

  it("出口 maintenance 也算维护（RELAY 的折叠视图必须带出 lifecycle）", async () => {
    const row = makeRelayTunnel();
    const out = await executeReconcile(reconcileDeps(row, { ingress: "active", egress: "maintenance" }));
    expect(out.resent).toBe(0);
    expect(row.writes).toHaveLength(0);
    expect(out.findings.map((f) => f.code)).toContain("node_in_maintenance");
  });

  it("退出维护后一轮收敛，第二轮零 findings（不再每 30s 空转）", async () => {
    const row = makeRelayTunnel();
    const deps = reconcileDeps(row, { ingress: "active", egress: "active" });

    const first = await executeReconcile(deps);
    expect(first.resent).toBe(1);
    expect(row.applied_revision).toBe(3);
    expect(isRevisionBehind(row)).toBe(false);

    // 第二轮：drift 消失 ⇒ 无 revision_behind finding、无 resend。这正是 Gate
    // G1.4「每轮都判偏差并重复下发同一 revision（永不静默）」的反面。
    const second = await executeReconcile(deps);
    expect(second.resent).toBe(0);
    expect(second.findings).toHaveLength(0);
  });
});
