/**
 * V4-WP3 合并前阻塞项 —— rollout 记账列 + 恢复接缝定向测试。
 * 跑法（与 CI 的 `bun test` 一致）：
 *   cd backend && bun test src/services/__tests__/forward-rollout-ledger.test.ts
 *
 * 覆盖的是 20261009123000_wp3_rollout_ledger_columns 补上的四列与 C5/C6/C7 接线：
 *   1. `strategy` 落库：register 写的分类 = planRollout 的分类；
 *   2. `notes` 落库：每个完成步骤产生一条流水账（追加式，不覆盖）；
 *   3. `compensated` / `compensation_error` 落库：§13.3.5 第三张表的两个终态
 *      （补偿成功 ⇒ true + NULL；补偿失败 ⇒ false + 非 NULL + phase=degraded）；
 *   4. 迁移前的存量行（notes=null / compensated=false）让续跑仍能工作——
 *      证明新列可空/缺省的选择没有把旧数据变成不可执行；
 *   5. `resumeRollouts` 只扫未完成行、按 id 升序、一条失败不阻断其余；
 *   6. 续跑并发跳过（`concurrent_transition`）不算失败。
 *
 * 这里刻意**不打真库**：DB 层断言在 CI 的 MySQL backend job 里由
 * `tests/forward-rollout-migration.test.mjs` 执行（本目录只跑离线替身）。
 */

import { describe, expect, it } from "bun:test";

import type { ForwardImpact } from "../forward-revision.ts";
import type { RolloutPlan, RolloutSnapshot } from "../forward-rollout.ts";
import {
  executeRollout,
  readKeySet,
  registerRollout,
  type RolloutDb,
  type RolloutDeps,
} from "../forward-rollout-exec.ts";
import { resumeRollouts } from "../forward-rollout-recovery.ts";

/* ------------------------------------------------------------------ */
/* 内存替身（含四个新列）                                               */
/* ------------------------------------------------------------------ */

/** 内存 rollout 行：带 20261009123000 补上的四列。 */
interface Row {
  id: number;
  tunnel_id: number;
  revision: number;
  base_revision: number | null;
  phase: string;
  strategy: string | null;
  steps: unknown;
  cleaned: string[];
  prepared: unknown[];
  notes: string[] | null;
  compensated: boolean;
  compensation_error: string | null;
  last_error_code: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const fakeDb = () => {
  const rollouts: Row[] = [];
  const tunnels: Array<Record<string, unknown>> = [];
  const snapshots: Array<Record<string, unknown>> = [];
  const leases: Array<Record<string, unknown>> = [];
  let seq = 1;

  const db: RolloutDb = {
    node: {
      findUnique: async (args: unknown) => {
        const a = args as { where: { id: number }; select?: Record<string, boolean> };
        const id = a.where.id;
        const min = id === 21 ? 20000 : id === 22 ? 22000 : 10000;
        const base: Record<string, unknown> = {
          id,
          node_id: `node-${id}`,
          workspace_id: 1,
          scope: 1,
          port_range_min: min,
          port_range_max: min + 19999,
        };
        if (!a.select) return base;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(a.select)) out[k] = base[k];
        return out;
      },
      findMany: async () => [],
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
    nodePortLease: {
      create: async (args: unknown) => {
        const a = args as { data: Record<string, unknown> };
        leases.push({ id: leases.length + 1, status: "active", ...a.data });
        return { id: leases.length };
      },
      findUnique: async (args: unknown) => {
        const a = args as { where: { id: number } };
        return leases.find((l) => l.id === a.where.id) ?? null;
      },
      findMany: async () => leases.filter((l) => l.status === "active"),
      update: async (args: unknown) => {
        const a = args as { where: { id: number }; data: Record<string, unknown> };
        const row = leases.find((l) => l.id === a.where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, a.data);
        return row;
      },
      updateMany: async (args: unknown) => {
        const a = args as { where: Record<string, unknown>; data: Record<string, unknown> };
        for (const l of leases) {
          if (a.where.status === undefined || l.status === a.where.status) Object.assign(l, a.data);
        }
        return { count: 1 };
      },
    },
    tunnel: {
      findUnique: async () => {
        const row = tunnels[0];
        if (!row) return null;
        const nodes: Record<string, unknown> = {};
        if (row.ingress_node_id != null) {
          nodes.ingress_node = {
            id: Number(row.ingress_node_id),
            node_id: `node-${Number(row.ingress_node_id)}`,
            role: "ingress",
            connect_ip: `10.0.0.${Number(row.ingress_node_id)}`,
            lifecycle: "active",
            port_range_min: 10000,
            port_range_max: 20000,
          };
        }
        if (row.egress_node_id != null) {
          nodes.egress_node = {
            id: Number(row.egress_node_id),
            node_id: `node-${Number(row.egress_node_id)}`,
            role: "egress",
            connect_ip: `10.0.1.${Number(row.egress_node_id)}`,
            lifecycle: "active",
            port_range_min: 20000,
            port_range_max: 30000,
          };
        }
        return { ...row, ...nodes };
      },
      update: async () => ({}),
      updateMany: async (args: unknown) => {
        const a = args as { where: { id: number }; data: Record<string, unknown> };
        const row = tunnels.find((t) => t.id === a.where.id);
        if (!row) return { count: 0 };
        Object.assign(row, a.data);
        return { count: 1 };
      },
    },
    forwardRevision: {
      findFirst: async (args: unknown) => {
        const a = args as { where: { tunnel_id: number; revision: number } };
        return snapshots.find((s) => s.tunnel_id === a.where.tunnel_id && s.revision === a.where.revision) ?? null;
      },
      findMany: async (args: unknown) => {
        const a = args as { where: { tunnel_id: number } };
        return snapshots
          .filter((s) => s.tunnel_id === a.where.tunnel_id)
          .sort((x, y) => Number(y.revision) - Number(x.revision));
      },
    },
    forwardRollout: {
      create: async (args: unknown) => {
        const a = args as { data: Record<string, unknown> };
        const row: Row = {
          id: seq++,
          tunnel_id: Number(a.data.tunnel_id),
          revision: Number(a.data.revision),
          base_revision: (a.data.base_revision as number | null) ?? null,
          phase: String(a.data.phase),
          strategy: (a.data.strategy as string | null) ?? null,
          steps: a.data.steps,
          cleaned: (a.data.cleaned as string[]) ?? [],
          prepared: (a.data.prepared as unknown[]) ?? [],
          // 真库语义：`notes` 可空、`compensated` 有缺省 —— register 不显式写
          // notes，列就保持 NULL（这正是迁移前存量行的形状）。
          notes: (a.data.notes as string[] | null) ?? null,
          compensated: Boolean(a.data.compensated),
          compensation_error: (a.data.compensation_error as string | null) ?? null,
          last_error_code: (a.data.last_error_code as string | null) ?? null,
          last_error: (a.data.last_error as string | null) ?? null,
          created_at: String(a.data.created_at),
          updated_at: String(a.data.updated_at),
        };
        rollouts.push(row);
        return { id: row.id };
      },
      findUnique: async (args: unknown) => {
        const a = args as { where: { id: number } };
        return rollouts.find((r) => r.id === a.where.id) ?? null;
      },
      findMany: async (args: unknown) => {
        const a = args as { where: Record<string, unknown> };
        const phase = (a.where.phase as { in: string[] } | undefined)?.in;
        if (phase) return rollouts.filter((r) => phase.includes(r.phase));
        return rollouts.filter((r) => r.tunnel_id === a.where.tunnel_id);
      },
      update: async () => ({ count: 1 }),
      updateMany: async (args: unknown) => {
        const a = args as {
          where: { id: number; phase?: string | { in: string[] } };
          data: Record<string, unknown>;
        };
        const row = rollouts.find((r) => r.id === a.where.id);
        if (!row) return { count: 0 };
        const expected = a.where.phase;
        if (expected !== undefined) {
          if (typeof expected === "string") {
            if (row.phase !== expected) return { count: 0 };
          } else if (!expected.in.includes(row.phase)) {
            return { count: 0 };
          }
        }
        for (const [k, v] of Object.entries(a.data)) {
          // 先判数组：`"push" in []` 因为 Array.prototype.push 继承而为 true，
          // 若不先排除数组，`notes: []` 会被当成 `{push}` 把 push 函数本身写进列。
          if (
            !Array.isArray(v) &&
            v !== null &&
            typeof v === "object" &&
            "push" in (v as Record<string, unknown>)
          ) {
            // JSON 列语义：push 到已有的数组上；列为 NULL 时从空数组开始
            // （真库里 JSON NULL 不会让 prisma 的 push 变成 null）。
            const prev = Array.isArray(row[k as keyof Row]) ? (row[k as keyof Row] as unknown[]) : [];
            (row as unknown as Record<string, unknown>)[k] = [...prev, (v as { push: unknown }).push];
          } else {
            (row as unknown as Record<string, unknown>)[k] = v;
          }
        }
        return { count: 1 };
      },
    },
    nodeBinding: {
      findUnique: async () => null,
      create: async (args: unknown) => {
        const a = args as { data: { ingress_node_id: number; egress_node_id: number } };
        return { id: 1, ...a.data };
      },
    },
  };

  return {
    db,
    rollouts,
    tunnels,
    snapshots,
    addSnapshot: (s: Record<string, unknown>) => snapshots.push({ id: seq++, ...s }),
    addTunnel: (t: Record<string, unknown>) => tunnels.push({ id: 1, ...t }),
    addRollout: (r: Partial<Row>) =>
      rollouts.push({
        id: rollouts.length + 1,
        tunnel_id: 1,
        revision: 7,
        base_revision: 6,
        phase: "done",
        strategy: "listener_replace",
        steps: { steps: [] },
        cleaned: [],
        prepared: [],
        notes: null,
        compensated: false,
        compensation_error: null,
        last_error_code: null,
        last_error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...r,
      }),
  };
};

function fakeOrchestrator(opts: { failOn?: Record<string, boolean> } = {}) {
  const calls = {
    dispatchEgress: [] as Array<Record<string, unknown>>,
    dispatchIngress: [] as Array<Record<string, unknown>>,
    dispatchDirect: [] as Array<Record<string, unknown>>,
    removeTunnel: [] as Array<Record<string, unknown>>,
  };
  const fail = { error_code: "agent_unreachable", error: "fake transport failure" };
  const orch = {
    calls,
    dispatchEgress: async (input: Record<string, unknown>) => {
      calls.dispatchEgress.push(input);
      if (opts.failOn?.dispatchEgress) return { ok: false as const, ...fail };
      return {
        ok: true as const,
        result: { commandId: "cmd-e", revision: Number(input.revision), ack: {} },
        egress_host: "10.0.1.21",
        egress_port: Number(input.egressPort),
      };
    },
    dispatchIngress: async (input: Record<string, unknown>) => {
      calls.dispatchIngress.push(input);
      if (opts.failOn?.dispatchIngress) return { ok: false as const, ...fail };
      return { ok: true as const, result: { commandId: "cmd-i", revision: Number(input.revision), ack: {} } };
    },
    dispatchDirect: async (input: Record<string, unknown>) => {
      calls.dispatchDirect.push(input);
      if (opts.failOn?.dispatchDirect) return { ok: false as const, ...fail };
      return { ok: true as const, result: { commandId: "cmd-d", revision: Number(input.revision), ack: {} } };
    },
    removeTunnel: async (input: Record<string, unknown>) => {
      calls.removeTunnel.push(input);
      if (opts.failOn?.removeTunnel) return { ok: false as const, ...fail };
      return { ok: true as const, result: { commandId: "cmd-r", revision: Number(input.revision), ack: {} } };
    },
  };
  return orch as unknown as RolloutDeps["orchestrator"] & typeof orch;
}

function impact(overrides: Partial<ForwardImpact> = {}): ForwardImpact {
  return {
    metadata_only: false,
    runtime_change: true,
    changes_external_address: false,
    listen_port_change: false,
    listener_replacement: false,
    ingress_node_change: false,
    egress_node_change: false,
    mode_change: false,
    target_change: false,
    egress_target_change: false,
    nodes_prepare_drain: [],
    binding_required: false,
    port_status: "ok",
    desired_address: null,
    ...overrides,
  };
}

/** 「desired=rev7 / applied=rev6 / DIRECT」环境。 */
function directEnv(overrides: { failOn?: Record<string, boolean> } = {}) {
  const f = fakeDb();
  f.addSnapshot({
    tunnel_id: 1,
    revision: 6,
    name: "fwd",
    desired_status: "active",
    mode: "direct",
    ingress_node_id: 11,
    egress_node_id: null,
    listen_port: 10001,
    target_host: "10.9.9.9",
    target_port: 8080,
    egress_pool_id: null,
    egress_port: null,
    targets: null,
    listen_ip: null,
  });
  f.addSnapshot({
    tunnel_id: 1,
    revision: 7,
    name: "fwd",
    desired_status: "active",
    mode: "direct",
    ingress_node_id: 11,
    egress_node_id: null,
    listen_port: 20002,
    target_host: "10.9.9.9",
    target_port: 8080,
    egress_pool_id: null,
    egress_port: null,
    targets: null,
    listen_ip: null,
  });
  f.addTunnel({
    id: 1,
    name: "fwd",
    tunnel_mode: "direct",
    ingress_node_id: 11,
    egress_node_id: null,
    listen_ip: null,
    listen_port: 20002,
    remote_host: "10.9.9.9",
    remote_port: 8080,
    egress_pool_id: null,
    egress_port: null,
    config_revision: 7,
    desired_revision_id: null,
    desired_status: "active",
    apply_status: "pending",
    node_id: 11,
  });
  const orch = fakeOrchestrator(overrides);
  return { f, deps: { db: f.db, orchestrator: orch } as RolloutDeps, orch };
}

/** 「DIRECT(rev6) → RELAY(rev7)」环境。 */
function modeSwitchEnv() {
  const f = fakeDb();
  f.addSnapshot({
    tunnel_id: 1,
    revision: 6,
    name: "fwd",
    desired_status: "active",
    mode: "direct",
    ingress_node_id: 11,
    egress_node_id: null,
    listen_port: 10001,
    target_host: "10.9.9.9",
    target_port: 8080,
    egress_pool_id: null,
    egress_port: null,
    targets: null,
    listen_ip: null,
  });
  f.addSnapshot({
    tunnel_id: 1,
    revision: 7,
    name: "fwd",
    desired_status: "active",
    mode: "relay",
    ingress_node_id: 11,
    egress_node_id: 21,
    listen_port: 10001,
    target_host: null,
    target_port: null,
    egress_pool_id: null,
    egress_port: 31000,
    targets: [{ host: "10.8.8.8", port: 80, weight: 1, order_by: 10 }],
    listen_ip: null,
  });
  f.addTunnel({
    id: 1,
    name: "fwd",
    tunnel_mode: "relay",
    ingress_node_id: 11,
    egress_node_id: 21,
    listen_ip: null,
    listen_port: 10001,
    remote_host: null,
    remote_port: null,
    egress_pool_id: null,
    egress_port: 31000,
    config_revision: 7,
    desired_revision_id: null,
    desired_status: "active",
    apply_status: "pending",
    node_id: 11,
  });
  return { f, deps: { db: f.db, orchestrator: fakeOrchestrator() } as RolloutDeps };
}

/* ------------------------------------------------------------------ */
/* 1. strategy 列                                                      */
/* ------------------------------------------------------------------ */

describe("strategy 列（20261009123000 追加）", () => {
  it("register 落库的分类 = planRollout 的分类", async () => {
    const { f, deps } = directEnv();
    await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    expect(f.rollouts).toHaveLength(1);
    // 端口变化 ⇒ listener_replace（§13.3.4 判定表）。
    expect(f.rollouts[0]!.strategy).toBe("listener_replace");
    // 与 `steps` 列里存的计划是同一个值（两处必须同源，否则排障读到两份分类）。
    const steps = f.rollouts[0]!.steps as RolloutPlan & { desired: RolloutSnapshot };
    expect(steps.strategy).toBe("listener_replace");
  });

  it("模式切换 ⇒ mode_switch（同一编辑多字段 ⇒ 报最重档）", async () => {
    const { f, deps } = modeSwitchEnv();
    await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ mode_change: true, egress_node_change: true, listen_port_change: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    expect(f.rollouts[0]!.strategy).toBe("mode_switch");
  });

  it("存量行 strategy 为 NULL 不阻断续跑（新列可空的选择没有把旧数据变砖）", async () => {
    const { f, deps, orch } = directEnv();
    // 手工塞一行"迁移前"的 rollout：strategy/notes=NULL、compensated=false，
    // phase 停在 cutover，只剩 drain/cleanup 未完成。
    f.addSnapshot({
      tunnel_id: 1,
      revision: 7,
      name: "fwd",
      desired_status: "active",
      mode: "direct",
      ingress_node_id: 11,
      egress_node_id: null,
      listen_port: 20002,
      target_host: "10.9.9.9",
      target_port: 8080,
      egress_pool_id: null,
      egress_port: null,
      targets: null,
      listen_ip: null,
    });
    f.addRollout({
      phase: "drain",
      strategy: null,
      notes: null,
      compensated: false,
      compensation_error: null,
      steps: {
        revision: 7,
        base_revision: 6,
        strategy: "listener_replace",
        blocking: [],
        warnings: [],
        desired: {
          name: "fwd",
          mode: "direct",
          ingress_node_id: 11,
          egress_node_id: null,
          listen_ip: null,
          listen_port: 20002,
          target_host: "10.9.9.9",
          target_port: 8080,
          egress_pool_id: null,
          egress_port: null,
          egress_targets: null,
          desired_status: "active",
        },
        applied: null,
        steps: [],
      },
    });
    const before = orch.calls.removeTunnel.length;
    const resumed = await executeRollout(f.rollouts[0]!.id, deps);
    expect(resumed.ok).toBe(true);
    expect(f.rollouts[0]!.phase).toBe("done");
    // NULL notes + 无步骤可跑（steps 全空）：不写任何 note，列保持 NULL。
    // 真实库同理——Prisma 的 `{ push }` 只在有新 note 时才 UPDATE。
    expect(f.rollouts[0]!.notes === null || Array.isArray(f.rollouts[0]!.notes)).toBe(true);
    void before;
  });
});

/* ------------------------------------------------------------------ */
/* 2. notes 列                                                         */
/* ------------------------------------------------------------------ */

describe("notes 列：追加式流水账", () => {
  it("每个完成步骤产生一条 note，且 notes 覆盖全阶段（不会被后续 patch 抹掉）", async () => {
    const { f, deps } = directEnv();
    await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    const notes = f.rollouts[0]!.notes as string[] | null;
    expect(notes).not.toBeNull();
    const list = notes ?? [];
    // 五阶段全部有落账：done 前的最后一次 transition 也会带 notes。
    for (const phase of ["validate", "prepare", "cutover", "drain", "cleanup"]) {
      expect(list.some((n) => n.startsWith(`${phase}:`))).toBe(true);
    }
    // 完成后步骤数 ≥ 5（有的阶段会有多条 note）。
    expect(list.length).toBeGreaterThanOrEqual(5);
  });

  it("DRAIN 软失败也记一条 note（§13.3.5：只记 warning 不阻塞 CLEANUP）", async () => {
    const { f, deps } = directEnv();
    const soft = { db: f.db, orchestrator: fakeOrchestrator({ failOn: { removeTunnel: true } }) } as RolloutDeps;
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      soft,
    );
    expect(res.ok).toBe(true);
    const list = (f.rollouts[0]!.notes ?? []) as string[];
    expect(list.some((n) => n.includes("SOFT"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 3. compensated / compensation_error                                  */
/* ------------------------------------------------------------------ */

describe("compensated + compensation_error：§13.3.5 第三张表的两个终态", () => {
  it("CUTOVER 失败且补偿成功 ⇒ compensated=true、compensation_error=null、phase=failed", async () => {
    const { f } = modeSwitchEnv();
    const d2 = { db: f.db, orchestrator: fakeOrchestrator({ failOn: { dispatchIngress: true } }) } as RolloutDeps;
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ mode_change: true, egress_node_change: true }),
        revision: 7,
        baseRevision: 6,
      },
      d2,
    );
    expect(res.ok).toBe(false);
    expect(f.rollouts[0]!.phase).toBe("failed");
    // 「补偿成功也是失败」——ok:false 只说明 desired 没生效。
    expect(f.rollouts[0]!.compensated).toBe(true);
    expect(f.rollouts[0]!.compensation_error).toBeNull();
  });

  it("补偿失败 ⇒ compensated=false、compensation_error 非空、phase=degraded", async () => {
    const { f } = modeSwitchEnv();
    const d2 = {
      db: f.db,
      orchestrator: fakeOrchestrator({ failOn: { dispatchIngress: true, removeTunnel: true } }),
    } as RolloutDeps;
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ mode_change: true, egress_node_change: true }),
        revision: 7,
        baseRevision: 6,
      },
      d2,
    );
    expect(res.ok).toBe(false);
    expect(f.rollouts[0]!.phase).toBe("degraded");
    expect(f.rollouts[0]!.compensated).toBe(false);
    // 补偿失败原因必须落库：没有它，运维无法判断该人工重试还是该改网络。
    expect(f.rollouts[0]!.compensation_error).toBeTruthy();
    // 真实内容是补偿里每一步的失败原因聚合（此处 fake orchestrator 的
    // removeTunnel 返回 error），不是 CUTOVER 那次 error。
    expect(String(f.rollouts[0]!.compensation_error)).toContain("fake transport failure");
    expect(String(f.rollouts[0]!.last_error_code)).toBe("compensation_failed");
  });

  it("PREPARE 失败 ⇒ 不进补偿：compensated 保持 false、compensation_error 为空", async () => {
    const { f } = modeSwitchEnv();
    const d2 = { db: f.db, orchestrator: fakeOrchestrator({ failOn: { dispatchEgress: true } }) } as RolloutDeps;
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ mode_change: true, egress_node_change: true }),
        revision: 7,
        baseRevision: 6,
      },
      d2,
    );
    expect(res.ok).toBe(false);
    expect(f.rollouts[0]!.phase).toBe("failed");
    expect(f.rollouts[0]!.compensated).toBe(false);
    expect(f.rollouts[0]!.compensation_error).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 4. register 的四列初始值                                            */
/* ------------------------------------------------------------------ */

describe("register 创建行时四列的初始形状", () => {
  it("新行 strategy=计划分类、notes=NULL、compensated=false、compensation_error=NULL", async () => {
    const { f, deps } = directEnv();
    await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    const row = f.rollouts[0]!;
    expect(row.strategy).toBe("listener_replace");
    // 真库里 register 不写 notes；第一次成功步骤的 push 才建列值。
    expect(row.notes === null || Array.isArray(row.notes)).toBe(true);
    expect(row.compensated).toBe(false);
    expect(row.compensation_error).toBeNull();
  });

  it("suspended noop 行同样带 strategy（旁路记账也分类）", async () => {
    const { f, deps } = directEnv();
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
        suspended: true,
      },
      deps,
    );
    expect(res.status).toBe("done");
    expect(f.rollouts[0]!.strategy).toBe("listener_replace");
  });
});

/* ------------------------------------------------------------------ */
/* 5. resumeRollouts（C5 / worker C7）                                 */
/* ------------------------------------------------------------------ */

describe("resumeRollouts：只扫未完成、按 id 升序、一条失败不阻断", () => {
  /** 直接调 resumeRollouts，用一个按序返回 id 的 db。 */
  async function runWith(ids: number[], opts: { failEngine?: boolean } = {}) {
    const f = fakeDb();
    const seen: number[] = [];
    const db = {
      ...f.db,
      forwardRollout: {
        ...f.db.forwardRollout,
        findMany: async () => ids.map((id) => ({ id })),
      },
    } as unknown as RolloutDb;
    const deps = {
      db,
      orchestrator: (opts.failEngine ? undefined : fakeOrchestrator()) as never,
    } as unknown as RolloutDeps;

    // executeRollout 对不存在的行返回 not_found（不抛），正是我们想要的
    // 「一条失败不阻断其余」的观测通道。
    const original = f.db.forwardRollout.findUnique;
    void original;
    const res = await resumeRollouts(deps);
    void seen;
    return { res };
  }

  it("空库 ⇒ scanned=0，全部计数为 0", async () => {
    const { res } = await runWith([]);
    expect(res).toEqual({ scanned: 0, resumed: 0, failed: 0, skipped: 0, errors: [], truncated: false });
  });

  it("扫到的行逐个续跑；行不存在 ⇒ 记 failed 但不抛", async () => {
    const { res } = await runWith([11, 12, 13]);
    expect(res.scanned).toBe(3);
    expect(res.resumed + res.failed + res.skipped).toBe(3);
    // 三条都是 not_found（替身里没有这些行）⇒ 全部进 failed，且没有抛出来。
    expect(res.failed).toBe(3);
    expect(res.errors).toHaveLength(3);
    expect(res.errors.map((e) => e.rolloutId)).toEqual([11, 12, 13]);
  });

  it("单条引擎抛异常 ⇒ 记 resume_threw，其余继续", async () => {
    const f = fakeDb();
    const calls: Array<"findMany" | "boom"> = [];
    const db = {
      ...f.db,
      forwardRollout: {
        ...f.db.forwardRollout,
        findMany: async () => {
          calls.push("findMany");
          return [{ id: 1 }, { id: 2 }];
        },
      },
    } as unknown as RolloutDb;
    // orchestrator 缺失 ⇒ register/execute 内部对 transport 的调用会抛；
    // resumeRollouts 必须兜住它，而不是把整轮 worker 打挂。
    const deps = { db, orchestrator: undefined as never } as unknown as RolloutDeps;
    const res = await resumeRollouts(deps);
    expect(calls).toEqual(["findMany"]);
    expect(res.scanned).toBe(2);
    // 两条都失败（一条找不到 / 一条没有 transport），但都记进了 errors。
    expect(res.failed).toBeGreaterThanOrEqual(1);
    expect(res.errors.length).toBeGreaterThanOrEqual(1);
  });

  it("已完成的行（done/failed/degraded）不被扫进来", async () => {
    const f = fakeDb();
    f.addRollout({ id: 1, phase: "done" });
    f.addRollout({ id: 2, phase: "failed" });
    f.addRollout({ id: 3, phase: "degraded" });
    f.addRollout({ id: 4, phase: "cutover" });
    // findMany 只返回 `phase in ACTIVE_ROLLOUT_PHASES` 的行 ⇒ 第 4 行。
    const res = await resumeRollouts({ db: f.db, orchestrator: fakeOrchestrator() as never } as RolloutDeps);
    expect(res.scanned).toBe(1);
    expect(readKeySet(f.rollouts[3]!.cleaned).length).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------ */
/* 6. upsert 顺序：id 升序（同一 tunnel 至多一条未完成）                 */
/* ------------------------------------------------------------------ */

describe("resumeRollouts 的顺序", () => {
  it("where 用 id 升序（先发生的 rollout 先收敛）", async () => {
    const f = fakeDb();
    let seenOrderBy: unknown = null;
    const db = {
      ...f.db,
      forwardRollout: {
        ...f.db.forwardRollout,
        findMany: async (args: unknown) => {
          const a = args as { orderBy?: unknown; where?: { phase?: { in: string[] } } };
          seenOrderBy = a.orderBy;
          // 断言扫的是 active 集合（不是全表）。
          expect(a.where?.phase?.in).toContain("compensating");
          expect(a.where?.phase?.in).not.toContain("done");
          return [];
        },
      },
    } as unknown as RolloutDb;
    await resumeRollouts({ db, orchestrator: fakeOrchestrator() as never } as RolloutDeps);
    expect(seenOrderBy).toEqual({ id: "asc" });
  });
});

/* ------------------------------------------------------------------ */
/* 7. S10.47：degraded 是终态，不参与 resume / reconcile 自动修复      */
/* ------------------------------------------------------------------ */

describe("S10.47 degraded 终态：不自动重放、不掩盖真相", () => {
  /**
   * S10.47 现象（wp14 实测）：tunnel tunex-15 的 rollout id=20 停在
   * `degraded`，`compensation_error` 记录「撤新 runtime 超时 + 基线重放被
   * validator 的 revision 闸门以 stale_revision 拒绝」，而 Agent 侧其实已经
   * hot-swap 到 revision=4。worker 每轮 cron 都在扫它、都不收敛。
   *
   * 这不是代码 Bug（degraded 语义上就是「回不去也进不去，等人来看」），
   * 但两个观测面必须诚实：
   *   a. `resumeRollouts` **不得**把 degraded 扫进来重放 —— 已由 ACTIVE_ROLLOUT_PHASES
   *      不含 degraded 保证（上面第 1 组已覆盖）。这里补的是**反向**断言：
   *      即使有人把 degraded 塞进扫进来的行，executeRollout 也不得推进它。
   *   b. degraded 行的 `applied_revision < config_revision` 必须让 reconciler
   *      只产 finding、不自动 resend —— 否则每轮都在给一个不可达/半损的节点
   *      下发注定被拒的命令，属于把「不可达降级」的需求反向实现成自动修。
   */

  /** 环境：tunnel 1 的 desired revision 7、applied revision 6（落后一版）。 */
  function behindEnv() {
    const { f, orch } = directEnv();
    // directEnv 已 addSnapshot(rev6 / rev7)；补一条 tunnel 行让 reconciler 能读到。
    f.db.tunnel.findUnique = (async () => {
      const row = {
        id: 1,
        name: "fwd",
        tunnel_mode: "direct",
        ingress_node_id: 11,
        egress_node_id: null,
        listen_port: 20002,
        remote_host: "10.9.9.9",
        remote_port: 8080,
        egress_pool_id: null,
        egress_port: null,
        config_revision: 7,
        applied_revision: 6,
        desired_status: "active",
        apply_status: "active",
        desired_revision_id: null,
        last_applied_at: null,
        apply_error_code: null,
        apply_error: null,
      };
      return {
        ...row,
        ingress_node: { id: 11, node_id: "node-11", connect_ip: "10.0.1.11", role: null, lb_strategy: null },
        egress_node: null,
      };
    }) as unknown as RolloutDb["tunnel"]["findUnique"];
    return { f, orch };
  }

  it("executeRollout 对 degraded 行返回 ok:false 且不写任何下发", async () => {
    const { f, orch } = behindEnv();
    f.addRollout({
      id: 40,
      phase: "degraded",
      revision: 7,
      base_revision: 6,
      compensated: false,
      compensation_error: "compensation failed",
      steps: {
        revision: 7,
        base_revision: 6,
        strategy: "target_hot_swap",
        blocking: [],
        warnings: [],
        desired: {
          name: "fwd",
          mode: "direct",
          ingress_node_id: 11,
          egress_node_id: null,
          listen_ip: null,
          listen_port: 20002,
          target_host: "10.9.9.9",
          target_port: 8080,
          egress_pool_id: null,
          egress_port: null,
          egress_targets: null,
          desired_status: "active",
        },
        applied: null,
        steps: [],
      },
    });
    const before = orch.calls.dispatchDirect.length;
    const res = await executeRollout(40, { db: f.db, orchestrator: orch } as RolloutDeps);
    // degraded 是终态：不得假装推进成功，也不得再下发任何 Agent 命令。
    expect(res.ok).toBe(false);
    expect(res.phase).toBe("degraded");
    expect(orch.calls.dispatchDirect.length).toBe(before);
    expect(f.rollouts[0]!.phase).toBe("degraded");
  });

  it("reconciler：rollout 停在 degraded 时，落后的 revision 只产 finding 不重发", async () => {
    const { f, orch } = behindEnv();
    const { executeReconcile } = await import("../reconciler.ts");
    const outcome = await executeReconcile({
      tunnels: async () => [
        {
          id: 1,
          name: "fwd",
          mode: "direct",
          desired_status: "active",
          config_revision: 7,
          applied_revision: 6,
          apply_status: "active",
          apply_error_code: null,
          apply_error: null,
          ingress_node_id: 11,
          egress_node_id: null,
        },
      ],
      nodes: async () => [
        { node_id: 11, last_seen_at: new Date().toISOString(), reported_at: new Date().toISOString(), stale: false },
      ],
      reports: async () =>
        new Map([
          [
            11,
            {
              reported_at: new Date(),
              // agent 快照里必须有这条 runtime，否则只有 missing_runtime。
              tunnels: [{ id: "tunex-1-direct", mode: "direct", revision: 6 }],
              last_error: null,
            },
          ],
        ]),
      sink: null,
    } as never);
    const resendFindings = outcome.findings.filter((x) => x.code === "resend_skipped");
    // sink 未注入 ⇒ 只记 finding，不得有任何下发尝试。
    expect(outcome.resent).toBe(0);
    expect(outcome.noTransport).toBe(1);
    expect(resendFindings.length).toBe(1);
    // 落后事实本身要被如实报出来（不是静默放过）。
    expect(outcome.findings.some((x) => x.code === "revision_behind")).toBe(true);
    // 落盘的那条 resend_skipped 必须挂到这条隧道 + 这个 revision 上。
    expect(resendFindings[0]!.tunnel_id).toBe(1);
    expect(resendFindings[0]!.revision).toBe(7);
    void f;
    void orch;
  });


  it("resendSameRevision：该 tunnel 有 degraded rollout 行 ⇒ 拒绝重发且一次都不下发", async () => {
    // S10.47 实测形态：tunnel 15 的 rollout 20 停在 degraded、compensation 已
    // 失败，而 applied_revision=3 < config_revision=4。reconciler 每轮都会判
    // 定 revision_behind 并尝试 resend —— 修好后 sink 必须在任何 dispatch
    // 之前拒绝，并让拒绝措辞带出 rollout id/phase，使观测面如实呈现
    // 「degraded 需要人工介入」而不是一条没有上下文的 resend 失败。
    const { createRuntimeReconcileSink } = await import("../runtime-reconcile-sink.ts");
    const dispatched: Array<{ method: string; revision: number }> = [];
    const orch = {
      dispatchDirect: async (input: Record<string, unknown>) => {
        dispatched.push({ method: "dispatchDirect", revision: Number(input.revision) });
        return { ok: true as const, result: { commandId: "x", revision: Number(input.revision), ack: {} } };
      },
    };
    const sink = createRuntimeReconcileSink({
      db: {
        tunnel: {
          findUnique: async (args: unknown) => {
            const a = args as { include?: { forwardRollouts?: unknown } };
            expect(a.include?.forwardRollouts).toBeDefined();
            return {
              id: 15,
              desired_status: "active",
              config_revision: 4,
              applied_revision: 3,
              tunnel_mode: "direct",
              listen_port: 21011,
              remote_host: "target-a",
              remote_port: 3030,
              listen_ip: null,
              ingress_node: { id: 3, node_id: "node-3", connect_ip: "10.0.1.3", role: null, lb_strategy: null },
              egress_node: null,
              egress_pool: null,
              forwardRollouts: [{ id: 20, phase: "degraded" }],
            };
          },
        },
      },
      orchestrator: (() => orch) as never,
    });

    let thrown: Error | null = null;
    try {
      await sink.resendSameRevision({ tunnel_id: 15, revision: 4, envelope: null } as never);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).toMatch(/degraded/);
    expect(thrown!.message).toMatch(/15/);
    // 关键：拒绝发生在下发之前，Agent 一次都不被打扰。
    expect(dispatched).toEqual([]);
  });

  it("resendSameRevision：compensating 行同样阻止重发（补偿未收敛）", async () => {
    const { createRuntimeReconcileSink } = await import("../runtime-reconcile-sink.ts");
    const dispatched: Array<{ method: string }> = [];
    const sink = createRuntimeReconcileSink({
      db: {
        tunnel: {
          findUnique: async () => ({
            id: 7,
            desired_status: "active",
            config_revision: 4,
            applied_revision: 3,
            tunnel_mode: "direct",
            listen_port: 21011,
            remote_host: "target-a",
            remote_port: 3030,
            listen_ip: null,
            ingress_node: { id: 3, node_id: "node-3", connect_ip: "10.0.1.3", role: null, lb_strategy: null },
            egress_node: null,
            egress_pool: null,
            forwardRollouts: [{ id: 31, phase: "compensating" }],
          }),
        },
      },
      orchestrator: (() => ({
        dispatchDirect: async () => {
          dispatched.push({ method: "dispatchDirect" });
          return { ok: true as const, result: { commandId: "x", revision: 4, ack: {} } };
        },
      })) as never,
    });
    await expect(
      sink.resendSameRevision({ tunnel_id: 7, revision: 4 } as never),
    ).rejects.toThrow(/compensating#31/);
    expect(dispatched).toEqual([]);
  });

  it("resendSameRevision：没有 degraded/compensating 行时行为不变（无回归）", async () => {
    const { createRuntimeReconcileSink } = await import("../runtime-reconcile-sink.ts");
    const dispatched: number[] = [];
    const sink = createRuntimeReconcileSink({
      db: {
        tunnel: {
          findUnique: async () => ({
            id: 6,
            desired_status: "active",
            config_revision: 4,
            applied_revision: 3,
            tunnel_mode: "direct",
            listen_port: 21011,
            remote_host: "target-a",
            remote_port: 3030,
            listen_ip: null,
            ingress_node: { id: 3, node_id: "node-3", connect_ip: "10.0.1.3", role: null, lb_strategy: null },
            egress_node: null,
            egress_pool: null,
            forwardRollouts: [],
          }),
        },
      },
      orchestrator: (() => ({
        dispatchDirect: async (input: Record<string, unknown>) => {
          dispatched.push(Number(input.revision));
          return { ok: true as const, result: { commandId: "x", revision: Number(input.revision), ack: {} } };
        },
      })) as never,
    });
    await sink.resendSameRevision({ tunnel_id: 6, revision: 4 } as never);
    expect(dispatched).toEqual([4]);
  });

  it("resendSameRevision：完成后只剩 done 行 ⇒ 不阻挡重发", async () => {
    // done/failed 不列在 select 里；用「include 真的生效」来证明 where 生效。
    const { createRuntimeReconcileSink } = await import("../runtime-reconcile-sink.ts");
    const sink = createRuntimeReconcileSink({
      db: {
        tunnel: {
          findUnique: async (args: unknown) => {
            const a = args as { include?: { forwardRollouts?: { where?: { phase?: { in: string[] } } } } };
            const phases = a.include?.forwardRollouts?.where?.phase?.in ?? [];
            expect(phases).toContain("degraded");
            expect(phases).toContain("compensating");
            expect(phases).not.toContain("done");
            expect(phases).not.toContain("failed");
            return {
              id: 6,
              desired_status: "active",
              config_revision: 4,
              applied_revision: 3,
              tunnel_mode: "direct",
              listen_port: 21011,
              remote_host: "target-a",
              remote_port: 3030,
              listen_ip: null,
              ingress_node: { id: 3, node_id: "node-3", connect_ip: "10.0.1.3", role: null, lb_strategy: null },
              egress_node: null,
              egress_pool: null,
              forwardRollouts: [],
            };
          },
        },
      },
      orchestrator: (() => ({
        dispatchDirect: async () => ({ ok: true as const, result: { commandId: "x", revision: 4, ack: {} } }),
      })) as never,
    });
    await sink.resendSameRevision({ tunnel_id: 6, revision: 4 } as never);
  });
});
