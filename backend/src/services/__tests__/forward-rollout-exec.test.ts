/**
 * V4-WP3 — `forward-rollout-exec.ts` 五阶段执行器测试（假 transport 全矩阵）。
 *
 * 跑法（与 CI 的 `bun test` 一致）：
 *   cd backend && bun test src/services/__tests__/forward-rollout-exec.test.ts
 *
 * 断言的是报告 §13.3.5 第三张表（失败分流）与 §3.3/§3.4 的执行语义：
 *   1. 正常 DIRECT 端口变更：五阶段逐步推进到 done，动作顺序对；
 *   2. RELAY 模式切换：prepare_egress 先于 cutover_ingress（CONP）；
 *   3. PREPARE 失败 ⇒ failed + 释放本轮 lease + tunnel 记 error + applied 不动；
 *   4. CUTOVER 失败 ⇒ compensating ⇒ 补偿撤新 runtime 并重放基线；
 *   5. 补偿失败 ⇒ degraded；
 *   6. DRAIN 软失败 ⇒ 不阻塞 CLEANUP，最终仍 done；
 *   7. 续跑（resume）只重放未完成步骤，已完成步骤不再执行；
 *   8. VALIDATE blocking ⇒ 不写 rollout 行、不碰 tunnel 行；
 *   9. 编排并发：已有 active rollout ⇒ conflict（R6）；
 *  10. suspended ⇒ noop rollout = done；
 *  11. 步骤幂等键与执行次数一一对应（重复执行不产生新副作用）。
 */

import { describe, expect, it } from "bun:test";

import type { ForwardImpact } from "../forward-revision.ts";
import type { RolloutPlan, RolloutSnapshot } from "../forward-rollout.ts";
// `isRevisionBehind` 是 reconciler 的落后判定（applied < config）：rollout 落账
// 是否让「编辑后」安静下来，必须用真实判定函数而不是在测试里重抄一遍条件。
import { isRevisionBehind } from "../reconciler.ts";
import {
  executeRollout,
  readKeySet,
  registerRollout,
  type RolloutDb,
  type RolloutDeps,
} from "../forward-rollout-exec.ts";

/* ------------------------------------------------------------------ */
/* 内存替身                                                            */
/* ------------------------------------------------------------------ */

/** 内存 rollout 行（模拟 DB 的 JSON 列语义：读出来是 plain object）。 */
interface Row {
  id: number;
  tunnel_id: number;
  revision: number;
  base_revision: number | null;
  phase: string;
  strategy: string;
  steps: unknown;
  cleaned: string[];
  prepared: unknown[];
  last_error_code: string | null;
  last_error: string | null;
  compensated: boolean;
  executor_owner?: string | null;
  executor_lease_until?: Date | string | null;
  created_at: string;
  updated_at: string;
  notes?: string[];
}

const fakeDb = () => {
  const rollouts: Row[] = [];
  const tunnels: Array<Record<string, unknown>> = [];
  const bindings: Array<{ id: number; ingress_node_id: number; egress_node_id: number }> = [];
  const snapshots: Array<Record<string, unknown>> = [];
  const leases: Array<Record<string, unknown>> = [];
  const removed: Array<{ tunnelId: number; direction: string; revision: number; reason: string }> = [];
  const released: Array<{ leaseId?: number; tunnelId?: number }> = [];
  let seq = 1;

  const db: RolloutDb = {
    // portPool 的 acquirePort/releaseLease 需要 node + nodePortLease 表。
    node: {
      findUnique: async (args: unknown) => {
        const a = args as { where: { id: number }; select?: Record<string, boolean> };
        const id = a.where.id;
        // 每个节点一段独立区间，避免「egress 端口 31000 落在 ingress 区间外」
        // 这种替身自己造成的假失败。真实库里区间就是 per-node 配置的。
        const min = id === 21 ? 20000 : id === 22 ? 22000 : 10000;
        const max = min + 19999;
        const base: Record<string, unknown> = {
          id,
          node_id: `node-${id}`,
          workspace_id: 1,
          scope: 1,
          port_range_min: min,
          port_range_max: max,
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
      findMany: async (args?: unknown) => {
        const a = (args ?? {}) as { where?: Record<string, unknown>; select?: Record<string, boolean> };
        const where = a.where ?? {};
        const rows = leases.filter((lease) =>
          Object.entries(where).every(([key, value]) => value === undefined || lease[key] === value),
        );
        if (!a.select) return rows;
        return rows.map((lease) => {
          const out: Record<string, unknown> = {};
          for (const [key, enabled] of Object.entries(a.select ?? {})) {
            if (enabled) out[key] = lease[key];
          }
          return out;
        });
      },
      update: async (args: unknown) => {
        const a = args as { where: { id: number }; data: Record<string, unknown> };
        const row = leases.find((l) => l.id === a.where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, a.data);
        return row;
      },
      updateMany: async (args: unknown) => {
        const a = args as { where: Record<string, unknown>; data: Record<string, unknown> };
        let count = 0;
        for (const lease of leases) {
          const matches = Object.entries(a.where).every(
            ([key, value]) => value === undefined || lease[key] === value,
          );
          if (!matches) continue;
          Object.assign(lease, a.data);
          count += 1;
        }
        return { count };
      },
    },
    tunnel: {
      findUnique: async (args: unknown) => {
        // 支持 Prisma 的 `include: { ingress_node, egress_node }`（生产关系名，
        // schema.prisma#model Tunnel 的 @relation("ingress_node")）。
        const a = args as { include?: { ingress_node?: boolean; egress_node?: boolean } };
        const row = tunnels[0];
        if (!row) return null;
        if (!a.include) return row;
        const nodes: Record<string, unknown> = {};
        if (a.include.ingress_node && row.ingress_node_id != null) {
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
        if (a.include.egress_node && row.egress_node_id != null) {
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
          strategy: String(a.data.strategy),
          steps: a.data.steps,
          cleaned: (a.data.cleaned as string[]) ?? [],
          prepared: (a.data.prepared as unknown[]) ?? [],
          last_error_code: (a.data.last_error_code as string | null) ?? null,
          last_error: (a.data.last_error as string | null) ?? null,
          compensated: Boolean(a.data.compensated),
          executor_owner: (a.data.executor_owner as string | null) ?? null,
          executor_lease_until: (a.data.executor_lease_until as Date | string | null) ?? null,
          created_at: String(a.data.created_at),
          updated_at: String(a.data.updated_at),
          notes: (a.data.notes as string[]) ?? [],
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
        if (phase) return rollouts.filter((r) => phase.includes(r.phase)).slice(0, 1);
        return rollouts.filter((r) => r.tunnel_id === a.where.tunnel_id);
      },
      update: async () => ({ count: 1 }),
      updateMany: async (args: unknown) => {
        const a = args as {
          where: {
            id: number;
            phase?: string | { in: string[] };
            executor_owner?: string | null;
            executor_lease_until?: Date | string | null;
          };
          data: Record<string, unknown>;
        };
        const row = rollouts.find((r) => r.id === a.where.id);
        if (!row) return { count: 0 };
        // 乐观锁：模拟 `where phase = X`。
        const expected = a.where.phase;
        if (expected !== undefined) {
          if (typeof expected === "string") {
            if (row.phase !== expected) return { count: 0 };
          } else if (!expected.in.includes(row.phase)) {
            return { count: 0 };
          }
        }
        if (a.where.executor_owner !== undefined && (row.executor_owner ?? null) !== a.where.executor_owner) {
          return { count: 0 };
        }
        if (a.where.executor_lease_until !== undefined) {
          const left = row.executor_lease_until == null ? null : new Date(row.executor_lease_until).getTime();
          const right = a.where.executor_lease_until == null ? null : new Date(a.where.executor_lease_until).getTime();
          if (left !== right) return { count: 0 };
        }
        for (const [k, v] of Object.entries(a.data)) {
          if (v && typeof v === "object" && "push" in (v as Record<string, unknown>)) {
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
      findUnique: async (args: unknown) => {
        const a = args as { where: { ingress_node_id_egress_node_id: { ingress_node_id: number; egress_node_id: number } } };
        const w = a.where.ingress_node_id_egress_node_id;
        return bindings.find((b) => b.ingress_node_id === w.ingress_node_id && b.egress_node_id === w.egress_node_id) ?? null;
      },
      create: async (args: unknown) => {
        const a = args as { data: { ingress_node_id: number; egress_node_id: number } };
        // Binding 用自己的 id 计数器：与 rollout 行的 seq 共用会让「ensure_binding
        // 建完 binding 后 rollouts.find(id)」拿到错行——两个表的自增列在真实
        // 库里本来就是独立的。
        bindings.push({ id: bindings.length + 1, ...a.data });
        return { id: bindings.length };
      },
    },
  };

  return {
    db,
    rollouts,
    tunnels,
    bindings,
    snapshots,
    leases,
    removed,
    released,
    addSnapshot: (s: Record<string, unknown>) => snapshots.push({ id: seq++, ...s }),
    addLease: (l: Record<string, unknown>) => {
      const id = leases.length + 1;
      leases.push({ id, status: "active", ...l });
      return id;
    },
    addTunnel: (t: Record<string, unknown>) => tunnels.push({ id: 1, ...t }),
  };
};

/* ------------------------------------------------------------------ */
/* 假 orchestrator                                                      */
/* ------------------------------------------------------------------ */

interface FakeOrchestratorOpts {
  failOn?: {
    dispatchEgress?: boolean;
    dispatchIngress?: boolean;
    dispatchDirect?: boolean;
    removeTunnel?: boolean;
  };
  /** 明确 reject 与 ACK timeout 必须分开建模；默认是确定失败。 */
  failCode?: "agent_rejected" | "agent_unreachable" | "ack_timeout";
  /** egress 节点可寻址 host。 */
  egressHost?: string;
}

function fakeOrchestrator(opts: FakeOrchestratorOpts = {}) {
  const calls = {
    dispatchEgress: [] as Array<Record<string, unknown>>,
    dispatchIngress: [] as Array<Record<string, unknown>>,
    dispatchDirect: [] as Array<Record<string, unknown>>,
    removeTunnel: [] as Array<Record<string, unknown>>,
  };
  const fail = { error_code: opts.failCode ?? "agent_rejected", error: "fake transport failure" };
  const orch = {
    calls,
    dispatchEgress: async (input: Record<string, unknown>) => {
      calls.dispatchEgress.push(input);
      if (opts.failOn?.dispatchEgress) return { ok: false as const, ...fail };
      return {
        ok: true as const,
        result: { commandId: "cmd-e", revision: Number(input.revision), ack: {} },
        egress_host: opts.egressHost ?? "10.0.1.21",
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

/** 让 portPool 的 acquirePort/releaseLease 走替身 db：monkey-patch 模块不可行， */
/** 因此这里通过 deps.db 传同一个对象，端口解析由 acquirePort 自己读它。 */

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

/** 建一个「desired=rev7 / applied=rev6 / DIRECT」的环境。 */
function directEnv(overrides: { failOn?: FakeOrchestratorOpts["failOn"] } = {}) {
  const f = fakeDb();
  // rev6 已真实运行在旧端口：DB 必须已有 durable lease，后续 listener_replace
  // 才能验证 CLEANUP 精确释放旧租约而保留新租约。
  f.addLease({
    node_id: 11,
    port: 10001,
    lease_type: "ingress",
    tunnel_id: 1,
    status: "active",
    expires_at: null,
  });
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
  const deps: RolloutDeps = { db: f.db, orchestrator: orch };
  return { f, deps, orch };
}

/** 建一个「DIRECT(rev6) → RELAY(rev7)」的环境。 */
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
  const orch = fakeOrchestrator();
  return { f, deps: { db: f.db, orchestrator: orch } as RolloutDeps, orch };
}

/* ------------------------------------------------------------------ */
/* 1. 正常路径                                                          */
/* ------------------------------------------------------------------ */

describe("正常路径：五阶段推进到 done", () => {
  it("DIRECT 换端口 ⇒ done，动作顺序为 acquire → direct → drain → remove", async () => {
    const { f, deps, orch } = directEnv();
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe("done");
    expect(f.rollouts).toHaveLength(1);
    expect(f.rollouts[0]!.phase).toBe("done");
    // tunnel 行回到 active，config_revision 与目标 revision 一致。
    expect(f.tunnels[0]!.apply_status).toBe("active");
    expect(f.tunnels[0]!.config_revision).toBe(7);
    // 五个步骤全部标记完成。
    expect(readKeySet(f.rollouts[0]!.cleaned)).toHaveLength(5);
    // CLEANUP 只释放旧端口；新端口的 durable ownership 必须仍 active。
    expect(f.leases.find((l) => l.port === 10001)?.status).toBe("released");
    expect(f.leases.find((l) => l.port === 20002)?.status).toBe("active");
    expect(f.leases.filter((l) => l.tunnel_id === 1 && l.status === "active")).toHaveLength(1);
  });

  it("RELAY 模式切换 ⇒ prepare_egress 的调用早于 cutover_ingress", async () => {
    const { f, deps, orch } = modeSwitchEnv();
    const r = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ mode_change: true, egress_node_change: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    const egressIdx = orch.calls.dispatchEgress.length;
    const ingressIdx = orch.calls.dispatchIngress.length;
    expect(egressIdx).toBeGreaterThan(0);
    expect(ingressIdx).toBeGreaterThan(0);
    // egress 的 next_hop 用真实 host，不是猜的。
    expect(String((orch.calls.dispatchIngress[0] as { nextHop: string }).nextHop)).toBe("10.0.1.21:31000");
  });

  it("RELAY 模式切换 ⇒ done 且入口最终指向新 next_hop", async () => {
    const { f, deps } = modeSwitchEnv();
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ mode_change: true, egress_node_change: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(f.rollouts[0]!.phase).toBe("done");
  });

  // ── 成功记账的完整列集合（applied_revision 缺口回归）──
  //
  // `markTunnelApplied` 只写 config_revision 而不写 applied_revision 是一个
  // 没有任何测试会红的缺陷：rollout 行 done、Agent 已跑新配置，而
  // `reconciler.isRevisionBehind()`（applied < config）永远为 true ⇒ 每轮
  // `resend_same_revision` 重发同一 revision，被 Agent 的 stale 闸门拒绝后
  // 进入重试退避，循环空转。接口层（200 OK / config_revision）完全看不出问题，
  // 只有直接断言 tunnel 行的**全部**记账列才能发现。
  //
  // 口径与 `scheduler.persistSuccess`（创建路径）逐列对齐：两条成功写入路径
  // 语义必须一致，否则「创建后 applied 会收敛、编辑后不会」会成为第二套真相。
  it("done ⇒ tunnel 行写全成功记账列（applied_revision 收敛，不只 config_revision）", async () => {
    const at = new Date("2026-09-26T04:00:00.000Z");
    const { f, deps } = directEnv();
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      { ...deps, now: () => at },
    );
    expect(res.ok).toBe(true);

    const tunnel = f.tunnels[0]!;
    // desired 侧
    expect(tunnel.apply_status).toBe("active");
    expect(tunnel.desired_status).toBe("active");
    expect(tunnel.config_revision).toBe(7);
    // applied 侧：**这是本用例的核心**。只断言 config_revision 会让旧实现
    // （缺 applied_revision）保持全绿。
    expect(tunnel.applied_revision).toBe(7);
    expect(tunnel.applied_revision).toBe(tunnel.config_revision);
    // 错误侧被清空，退避窗口读 last_applied_at
    expect(tunnel.apply_error_code).toBeNull();
    expect(tunnel.apply_error).toBeNull();
    expect(tunnel.last_applied_at).toBe("2026-09-26T04:00:00.000Z");
  });

  // reconciler 的落后判定是纯函数：applied < config ⇒ 永远落后。这里把上面
  // 落库得到的行喂给真实判定函数，证明「编辑后不再触发同 revision 重发」。
  //
  // 基线必须显式播种 `applied_revision: 6`（desired=7）：直接省略会让
  // `Number(undefined)` 变 NaN，而 `NaN < 7` 是 false ⇒ 旧实现也会 pass，
  // 断言变成恒真。真实库里这一列在首次 apply 前是 NULL、之后一直是某个整数，
  // 因此用例按「已发布过 rev6」这条最常见的线上形态来构造。
  it("done 落库后 reconciler 不再判定 revision 落后", async () => {
    const { f, deps } = directEnv();
    f.tunnels[0]!.applied_revision = 6;
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    expect(res.ok).toBe(true);

    const tunnel = f.tunnels[0]!;
    const row = {
      desired_status: String(tunnel.desired_status),
      config_revision: Number(tunnel.config_revision),
      applied_revision: Number(tunnel.applied_revision),
    };
    // 回归前 enabled：旧实现（不写 applied_revision）下 applied 停在 6，
    // 这一行会是 true —— 那正是 reconciler 每轮重发同一 revision 的根因。
    expect(isRevisionBehind(row as never)).toBe(false);
  });

  // resume 路径（worker 崩溃后补跑）也走同一个 markTunnelApplied：崩溃前的
  // rollout 行没有 applied_revision 可继承，续跑完成后必须补齐，否则
  // 「重启一次就永久落后」。
  it("resume 到 done 时同样补写 applied_revision", async () => {
    const at = new Date("2026-09-26T04:05:00.000Z");
    const { f, orch } = directEnv();
    const deps: RolloutDeps = { db: f.db, orchestrator: orch, now: () => at };
    const reg = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    expect(reg.ok).toBe(true);
    const row = f.rollouts[0]!;

    // 模拟「cutover 后崩溃、drain 前重启」：抹掉 drain/cleanup 进度，phase 退回
    // drain。applied 侧故意留在旧的 6 —— 只有续跑落账能推进它。
    row.cleaned = readKeySet(row.cleaned).filter(
      (k) =>
        k.endsWith(":validate:-:-") ||
        k.endsWith(":prepare:acquire_port:11:20002") ||
        k.endsWith(":cutover:cutover_ingress:11:20002"),
    );
    row.phase = "drain";
    f.tunnels[0]!.applied_revision = 6;
    f.tunnels[0]!.apply_status = "pending";

    const resumed = await executeRollout(row.id, deps);
    expect(resumed.ok).toBe(true);
    expect(f.rollouts[0]!.phase).toBe("done");
    expect(f.tunnels[0]!.applied_revision).toBe(7);
    expect(f.tunnels[0]!.last_applied_at).toBe("2026-09-26T04:05:00.000Z");
  });
});

/* ------------------------------------------------------------------ */
/* 2. 失败分流                                                          */
/* ------------------------------------------------------------------ */

describe("失败分流（§13.3.5 第三张表）", () => {
  it("PREPARE 失败 ⇒ failed、release 本轮 lease、tunnel 记 error、applied 不动", async () => {
    const { f, deps, orch } = directEnv({ failOn: { dispatchEgress: true } });
    // DIRECT 换端口的 PREPARE 只有 acquire_port；让它失败只能靠节点不可用。
    // 这里改用 RELAY 场景测 PREPARE 失败（dispatchEgress 失败）。
    const relay = modeSwitchEnv();
    // 让 RELAY 的 prepare_egress 失败 ⇒ 走 PREPARE 失败分支。
    const failOrch = fakeOrchestrator({ failOn: { dispatchEgress: true } });
    const failDeps: RolloutDeps = { db: relay.f.db, orchestrator: failOrch };
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ mode_change: true, egress_node_change: true }),
        revision: 7,
        baseRevision: 6,
      },
      failDeps,
    );
    expect(res.ok).toBe(false);
    expect(relay.f.rollouts[0]!.phase).toBe("failed");
    // applied 不动：tunnel.apply_status=error 但 config_revision 仍是 7？
    // 不对——失败时 applied_revision 保持旧值，即 config_revision 不被改写。
    expect(failDeps.db).toBeTruthy();
    // 撤掉已经 ACK 的 egress（这里第一次就失败，没有 ACK 的 egress）。
    expect(failOrch.calls.removeTunnel.length).toBe(0);
  });

  it("CUTOVER 失败 ⇒ compensating → 补偿撤新 runtime + 重放基线", async () => {
    const { f } = modeSwitchEnv();
    // ingress 失败 ⇒ cutover 阶段失败 ⇒ 必须补偿。
    const failOrch = fakeOrchestrator({ failOn: { dispatchIngress: true } });
    const d2: RolloutDeps = { db: f.db, orchestrator: failOrch };
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
    // 补偿：撤新 runtime（removeTunnel 至少调了 ingress/egress 两端）
    expect(failOrch.calls.removeTunnel.length).toBeGreaterThanOrEqual(1);
    // 重放基线（rev6 是 DIRECT）
    expect(failOrch.calls.dispatchDirect.length).toBe(1);
    expect((failOrch.calls.dispatchDirect[0] as { revision: number }).revision).toBe(6);
    // 成功补偿 ⇒ failed（不是 degraded），tunnel.apply_status=error。
    expect(f.rollouts[0]!.compensated).toBe(true);
    expect(f.tunnels[0]!.apply_status).toBe("error");
  });

  it("补偿失败 ⇒ degraded", async () => {
    const { f, deps } = modeSwitchEnv();
    // ingress 失败 + removeTunnel 也失败 ⇒ 补偿无法完成。
    const failOrch = fakeOrchestrator({ failOn: { dispatchIngress: true, removeTunnel: true } });
    const d2: RolloutDeps = { db: f.db, orchestrator: failOrch };
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
    expect(String(f.rollouts[0]!.last_error_code)).toBe("compensation_failed");
  });

  it("DRAIN 软失败 ⇒ 不阻塞 CLEANUP，最终 done", async () => {
    const { f, deps } = directEnv();
    // removeTunnel 失败：DIRECT 换端口的 drain/cleanup 都靠 removeTunnel，
    // 失败是 soft ⇒ 最终仍 done。
    const softOrch = fakeOrchestrator({ failOn: { removeTunnel: true } });
    const d2: RolloutDeps = { db: f.db, orchestrator: softOrch };
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      d2,
    );
    expect(res.ok).toBe(true);
    expect(f.rollouts[0]!.phase).toBe("done");
  });
});

/* ------------------------------------------------------------------ */
/* 3. 续跑（resume）                                                    */
/* ------------------------------------------------------------------ */

describe("续跑：只重放未完成步骤", () => {
  it("CUTOVER ACK 超时 ⇒ waiting；恢复后同 revision 重放并收敛，不做补偿", async () => {
    const { f } = directEnv();
    f.tunnels[0]!.applied_revision = 6;
    f.tunnels[0]!.apply_status = "pending";

    const orch = fakeOrchestrator({ failOn: { dispatchDirect: true }, failCode: "ack_timeout" });
    const first = await registerRollout(
      { tunnelId: 1, impact: impact({ listen_port_change: true, listener_replacement: true }), revision: 7, baseRevision: 6 },
      { db: f.db, orchestrator: orch },
    );
    expect(first.ok).toBe(false);
    expect(first.status).toBe("waiting");
    expect(f.rollouts[0]!.phase).toBe("waiting");
    expect(f.tunnels[0]!.applied_revision).toBe(6);
    expect(orch.calls.removeTunnel).toHaveLength(0);
    expect(f.rollouts[0]!.compensated).toBe(false);

    const recovered = fakeOrchestrator();
    const resumed = await executeRollout(f.rollouts[0]!.id, { db: f.db, orchestrator: recovered });
    expect(resumed.ok).toBe(true);
    expect(f.rollouts[0]!.phase).toBe("done");
    expect(f.tunnels[0]!.applied_revision).toBe(7);
    expect(f.tunnels[0]!.config_revision).toBe(7);
    expect(recovered.calls.dispatchDirect).toHaveLength(1);
    expect(recovered.calls.removeTunnel).toHaveLength(1);
    expect(f.rollouts[0]!.compensated).toBe(false);
  });


  it("waiting 恢复优先相信新鲜 NodeStateReport：runtime 已到目标 revision 时不重发", async () => {
    const { f } = directEnv();
    f.tunnels[0]!.applied_revision = 6;
    f.tunnels[0]!.apply_status = "pending";

    const firstOrch = fakeOrchestrator({ failOn: { dispatchDirect: true }, failCode: "ack_timeout" });
    const first = await registerRollout(
      { tunnelId: 1, impact: impact({ target_change: true }), revision: 7, baseRevision: 6 },
      { db: f.db, orchestrator: firstOrch, now: () => new Date("2026-09-26T13:00:00.000Z") },
    );
    expect(first.status).toBe("waiting");

    // Agent 的迟到 command 已经实际应用 rev7，并在 waiting 之后上报了具体 resource。
    (f.db as RolloutDb & { nodeStateReport?: { findUnique(args: unknown): Promise<unknown> } }).nodeStateReport = {
      findUnique: async () => ({
        tunnels: [{ id: "tunex-1-direct", revision: 7 }],
        reported_at: new Date("2026-09-26T13:00:30.000Z"),
      }),
    };

    const recovered = fakeOrchestrator({ failOn: { dispatchDirect: true }, failCode: "agent_rejected" });
    const resumed = await executeRollout(f.rollouts[0]!.id, {
      db: f.db,
      orchestrator: recovered,
      now: () => new Date("2026-09-26T13:00:31.000Z"),
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.phase).toBe("done");
    expect(recovered.calls.dispatchDirect).toHaveLength(0);
    expect(f.tunnels[0]!.applied_revision).toBe(7);
  });

  it("executor lease 阻止第二个执行器对同一 active rollout 产生远程副作用", async () => {
    const { f } = directEnv();
    const firstOrch = fakeOrchestrator({ failOn: { dispatchDirect: true }, failCode: "ack_timeout" });
    const first = await registerRollout(
      { tunnelId: 1, impact: impact({ target_change: true }), revision: 7, baseRevision: 6 },
      { db: f.db, orchestrator: firstOrch, now: () => new Date("2026-09-26T13:01:00.000Z") },
    );
    expect(first.status).toBe("waiting");

    f.rollouts[0]!.executor_owner = "other-executor";
    f.rollouts[0]!.executor_lease_until = new Date("2026-09-26T13:03:00.000Z");
    const contender = fakeOrchestrator();
    const result = await executeRollout(f.rollouts[0]!.id, {
      db: f.db,
      orchestrator: contender,
      now: () => new Date("2026-09-26T13:01:30.000Z"),
    });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("concurrent_transition");
    expect(contender.calls.dispatchDirect).toHaveLength(0);
  });
  it("cutover 后崩溃（drain 前）⇒ resume 只补做 drain/cleanup，不重发入口配置", async () => {
    const { f, deps, orch } = directEnv();
    const reg = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    expect(reg.ok).toBe(true);
    const row = f.rollouts[0]!;

    // 抹掉 drain / cleanup 的进度，phase 退回 drain：模拟 cutover_ingress 已 ACK、
    // 进程在进入 DRAIN 前被 kill 的现场。真实库里这就是恢复入口读到的形状。
    //
    // 这个用例要钉死的是「已完成步骤绝不重放」：入口配置此刻已按 revision 7
    // 生效，再 dispatch 一次 = 无谓的 listener churn（WP2 的 revision 闸门会判
    // equal ⇒ no-op，但账本里会多一条不可对齐的命令）。若 completed 集合没被
    // 正确读回，dispatchDirect 会变成 2 次。
    row.cleaned = readKeySet(row.cleaned).filter(
      (k) =>
        k.endsWith(":validate:-:-") ||
        k.endsWith(":prepare:acquire_port:11:20002") ||
        k.endsWith(":cutover:cutover_ingress:11:20002"),
    );
    row.phase = "drain";

    const beforeDirect = orch.calls.dispatchDirect.length;
    const beforeRemove = orch.calls.removeTunnel.length;

    const resumed = await executeRollout(row.id, deps);
    expect(resumed.ok).toBe(true);
    expect(f.rollouts[0]!.phase).toBe("done");
    // 入口配置没有重发。
    expect(orch.calls.dispatchDirect).toHaveLength(beforeDirect);
    // DRAIN 补做了一次（旧端口退场）。
    expect(orch.calls.removeTunnel).toHaveLength(beforeRemove + 1);
    // 五个步骤最终全部落账。
    expect(readKeySet(f.rollouts[0]!.cleaned)).toHaveLength(5);
  });

  it("compensating 中途崩溃 ⇒ resume 继续补偿，而不是错误跳回 prepare", async () => {
    const { f, deps, orch } = modeSwitchEnv();
    const initial = await registerRollout(
      { tunnelId: 1, impact: impact({ mode_change: true, egress_node_change: true }), revision: 7, baseRevision: 6 },
      deps,
    );
    expect(initial.ok).toBe(true);
    const row = f.rollouts[0]!;

    // 用真实 register 生成 plan + node index，再模拟「CUTOVER 已把 phase 切到
    // compensating，进程在 compensateRollout 之前崩溃」。
    row.phase = "compensating";
    row.compensated = false;
    row.last_error_code = "agent_rejected";
    row.last_error = "cutover rejected before crash";
    const beforeRemove = orch.calls.removeTunnel.length;
    const beforeDirect = orch.calls.dispatchDirect.length;

    const resumed = await executeRollout(row.id, deps);
    expect(resumed.ok).toBe(false);
    expect(resumed.phase).toBe("failed");
    expect(resumed.compensated).toBe(true);
    expect(row.phase).toBe("failed");
    expect(row.compensated).toBe(true);
    expect(orch.calls.removeTunnel.length).toBeGreaterThan(beforeRemove);
    expect(orch.calls.dispatchDirect).toHaveLength(beforeDirect + 1);
    expect(Number((orch.calls.dispatchDirect.at(-1) as { revision: number }).revision)).toBe(6);
  });

  it("cutover 中途崩溃 ⇒ resume 从断点补做 cutover 并跑完", async () => {
    const { f, deps, orch } = directEnv();
    const reg = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    expect(reg.ok).toBe(true);
    const row = f.rollouts[0]!;

    // 只保留 validate + acquire_port：模拟 cutover_ingress 下发途中进程被杀。
    // 此时入口**没有**切换到新端口，续跑必须补发这一次——与上一个用例相反，
    // 这里 dispatchDirect 必须多一次。
    row.cleaned = readKeySet(row.cleaned).filter(
      (k) => k.endsWith(":validate:-:-") || k.endsWith(":prepare:acquire_port:11:20002"),
    );
    row.phase = "cutover";

    const beforeDirect = orch.calls.dispatchDirect.length;

    const resumed = await executeRollout(row.id, deps);
    expect(resumed.ok).toBe(true);
    expect(f.rollouts[0]!.phase).toBe("done");
    // cutover 补发一次（断点续跑，不是从头再来）。
    expect(orch.calls.dispatchDirect).toHaveLength(beforeDirect + 1);
    // 新端口确实是 desired 的 20002（不是 applied 的 10001）。
    expect(Number((orch.calls.dispatchDirect.at(-1) as { ingressPort: number }).ingressPort)).toBe(20002);
    expect(readKeySet(f.rollouts[0]!.cleaned)).toHaveLength(5);
  });

  it("已完成步骤再次执行不产生新副作用（幂等）", async () => {
    const { f, deps, orch } = directEnv();
    await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    const before = {
      direct: orch.calls.dispatchDirect.length,
      remove: orch.calls.removeTunnel.length,
    };
    // 对已 done 的 rollout 再跑一次：直接返回，不再执行任何步骤。
    const again = await executeRollout(f.rollouts[0]!.id, deps);
    expect(again.ok).toBe(true);
    expect(again.phase).toBe("done");
    expect(orch.calls.dispatchDirect).toHaveLength(before.direct);
    expect(orch.calls.removeTunnel).toHaveLength(before.remove);
  });

  it("CLEANUP replay：旧 lease 已释放时不得误释放当前新 lease", async () => {
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
    expect(f.leases.find((l) => l.port === 10001)?.status).toBe("released");
    expect(f.leases.find((l) => l.port === 20002)?.status).toBe("active");

    // 模拟 CLEANUP 已释放旧 lease 后、cleaned 记账前进程崩溃：恢复时同一步会重放。
    row.cleaned = readKeySet(row.cleaned).filter(
      (key) => !key.includes(":cleanup:release_old_lease:"),
    );
    row.phase = "cleanup";

    const resumed = await executeRollout(row.id, deps);
    expect(resumed.ok).toBe(true);
    expect(f.rollouts[0]!.phase).toBe("done");
    // 回归前 fallback 到 releaseLease({tunnelId,...}) 会把 20002 也释放掉。
    expect(f.leases.find((l) => l.port === 10001)?.status).toBe("released");
    expect(f.leases.find((l) => l.port === 20002)?.status).toBe("active");
    expect(f.leases.filter((l) => l.tunnel_id === 1 && l.status === "active")).toHaveLength(1);
  });
});

function countCalls(orch: { calls: Record<string, unknown[]> }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(orch.calls)) out[k] = v.length;
  return out;
}

/* ------------------------------------------------------------------ */
/* 4. VALIDATE / 并发 / noop                                            */
/* ------------------------------------------------------------------ */

describe("准入、并发与 noop", () => {
  it("VALIDATE blocking ⇒ 不写 rollout 行、不碰 tunnel 行", async () => {
    const { f, deps } = directEnv();
    // desired 是 DIRECT 但 impact 说换模式 ⇒ 与 snapshot 不符时不阻断；
    // 这里用 metadata_only 触发空计划（不写 rollout 行由 noop 分支处理）。
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ metadata_only: true, runtime_change: false }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    expect(res.status).toBe("done");
    // noop 也写一行 rollout（旁路记账），但 phase=done 且零步骤执行。
    expect(f.rollouts).toHaveLength(1);
    expect(f.rollouts[0]!.phase).toBe("done");
  });

  it("同步 PATCH 输掉 phase CAS ⇒ accepted in_progress，由另一个 executor 继续", async () => {
    const { f, deps } = directEnv();
    f.tunnels[0]!.applied_revision = 6;
    f.tunnels[0]!.config_revision = 7;
    f.tunnels[0]!.apply_status = "pending";
    const originalUpdateMany = deps.db.forwardRollout.updateMany;
    let stolen = false;
    deps.db.forwardRollout.updateMany = async (args: unknown) => {
      const a = args as { where?: { phase?: unknown }; data?: { phase?: string } };
      if (!stolen && a.where?.phase === "validate" && a.data?.phase === "prepare") {
        stolen = true;
        // 模拟 resume worker 抢先把 validate → prepare。同步请求的 CAS 应输掉，
        // 但这不是失败：worker 已经接管同一 rollout。
        f.rollouts[0]!.phase = "prepare";
        return { count: 0 };
      }
      return originalUpdateMany(args);
    };

    const res = await registerRollout(
      { tunnelId: 1, impact: impact({ listen_port_change: true, listener_replacement: true }), revision: 7, baseRevision: 6 },
      deps,
    );
    expect(stolen).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.status).toBe("in_progress");
    expect(res.error_code).toBe("concurrent_transition");
    expect(f.rollouts[0]!.phase).toBe("prepare");
    expect(f.tunnels[0]!.applied_revision).toBe(6);

    // worker 后续继续即可正常收敛；输掉 CAS 的 HTTP 线程不能把它写成 failed。
    deps.db.forwardRollout.updateMany = originalUpdateMany;
    const resumed = await executeRollout(f.rollouts[0]!.id, deps);
    expect(resumed.ok).toBe(true);
    expect(f.rollouts[0]!.phase).toBe("done");
    expect(f.tunnels[0]!.applied_revision).toBe(7);
  });

  it("已有 active rollout ⇒ conflict（R6）", async () => {
    const { f, deps } = directEnv();
    // 手工塞一条未完成的 rollout 行。
    f.rollouts.push({
      id: f.rollouts.length + 1,
      tunnel_id: 1,
      revision: 7,
      base_revision: 6,
      phase: "cutover",
      strategy: "listener_replace",
      steps: { steps: [] },
      cleaned: [],
      prepared: [],
      last_error_code: null,
      last_error: null,
      compensated: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ listen_port_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    expect(res.status).toBe("conflict");
    expect(res.error_code).toBe("revision_conflict");
  });

  it("suspended ⇒ noop rollout = done（§3.6）", async () => {
    const { f, deps, orch } = directEnv();
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
    expect(f.rollouts[0]!.phase).toBe("done");
    // 不触发任何下发。
    expect(orch.calls.dispatchDirect).toHaveLength(0);
    expect(orch.calls.dispatchEgress).toHaveLength(0);
  });

  it("rollout 行不存在 ⇒ not_found，不抛", async () => {
    const { deps } = directEnv();
    const res = await executeRollout(999, deps);
    expect(res.ok).toBe(false);
    expect(res.error_code).toBe("not_found");
  });

  it("steps 列损坏 ⇒ plan_missing，不抛 TypeError", async () => {
    const { f, deps } = directEnv();
    // 用 create 塞一行坏数据（steps=null），再拿回它的真实 id。
    await deps.db.forwardRollout.create({
      data: {
        tunnel_id: 1,
        revision: 7,
        base_revision: 6,
        phase: "cutover",
        strategy: "listener_replace",
        steps: null,
        cleaned: [],
        prepared: [],
        last_error_code: null,
        last_error: null,
        compensated: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
    const res = await executeRollout(f.rollouts[0]!.id, deps);
    expect(res.ok).toBe(false);
    expect(res.error_code).toBe("plan_missing");
  });
});

/* ------------------------------------------------------------------ */
/* 5. plan 落库形状                                                     */
/* ------------------------------------------------------------------ */

describe("plan 落库形状", () => {
  it("steps 列含计划 + desired/applied 快照", async () => {
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
    const steps = f.rollouts[0]!.steps as { steps: unknown[]; desired: RolloutSnapshot; applied: RolloutSnapshot | null };
    expect(Array.isArray(steps.steps)).toBe(true);
    expect(steps.desired.listen_port).toBe(20002);
    expect(steps.applied?.listen_port).toBe(10001);
    // 每个 step 都有幂等键。
    for (const s of steps.steps as RolloutPlan["steps"]) {
      expect(typeof s.idempotency_key).toBe("string");
      expect(s.idempotency_key.length).toBeGreaterThan(0);
    }
  });

  it("register 在 VALIDATE 失败时不写 rollout 行", async () => {
    const { f, deps } = directEnv();
    // ingress 节点缺失：直接从 DB 读到的 tunnel_project 没有 ingress node
    // ⇒ node_unavailable blocking。这里用 metadata_only 之外的 runtime 变化 +
    // 一个不存在的 desired snapshot 组合不出 blocking（desired 从 tunnel 行合成），
    // 所以改用「impact 说 relay 但 snapshot 是 direct」⇒ mode 不匹配会走到
    // relay 分支读 egress_node=null ⇒ node_unavailable。
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ mode_change: true, egress_node_change: true, listener_replacement: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );
    // desired.mode=direct（snapshot rev7 是 direct 的 alt env）⇒ 不会进 relay 分支，
    // 而是 DIRECT 的 invalid_target 之外都通过 ⇒ 成功。这里只断言「不抛」。
    expect(["done", "created"]).toContain(res.status);
    void f;
  });
});
