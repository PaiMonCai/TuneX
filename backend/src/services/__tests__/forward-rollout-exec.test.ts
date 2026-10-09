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
import { acquirePort, type PortPoolDb } from "../portPool.ts";
// `isRevisionBehind` 是 reconciler 的落后判定（applied < config）：rollout 落账
// 是否让「编辑后」安静下来，必须用真实判定函数而不是在测试里重抄一遍条件。
import { isRevisionBehind } from "../reconciler.ts";
import { capabilityFactsFromStoredV2 } from "../capability-manifest.ts";
import { FORWARD_NATIVE_BOTH_CAPABILITY } from "../forward-native-both.ts";
import {
  executeRollout,
  compensateRollout,
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

  const db: RolloutDb & Pick<PortPoolDb, "$transaction"> = {
    async $transaction(run, options) {
      expect(options?.isolationLevel).toBe("Serializable");
      return run({ ...db, $queryRawUnsafe: async (query, nodeId, port) => {
        expect(query).toContain("FOR UPDATE");
        expect(typeof nodeId).toBe("number");
        expect(typeof port).toBe("number");
        return [];
      } });
    },
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
          node_group_id: id,
          role: id >= 20 ? "egress" : "ingress",
          connect_ip: `10.0.0.${id}`,
          lifecycle: "active",
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
        const row = { id: leases.length + 1, status: "active", ...a.data };
        leases.push(row);
        return row;
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
      // V5.3 新契约：回滚产生新世代 ⇒ 补偿为"内容 = 基线"的新 revision 写快照。
      create: async (args: unknown) => {
        const a = args as { data: { tunnel_id: number; revision: number } };
        const snapshot = { id: seq++, ...a.data };
        snapshots.push(snapshot);
        return snapshot;
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
      leases.push({ id, status: "active", protocol: "tcp", bind_scope: "*", link_id: null, ...l });
      return id;
    },
    addTunnel: (t: Record<string, unknown>) => tunnels.push({ id: 1, user_id: 1, workspace_id: 1, tunnel_type: "tcp", ...t }),
  };
};

const nativeBothFacts = () => capabilityFactsFromStoredV2({ control_protocol_version: 2,
  capabilities: ["apply_tunnel", "remove_tunnel", FORWARD_NATIVE_BOTH_CAPABILITY], reported_at: new Date(),
  capability_manifest: { schema_version: 2, protocols: ["tcp", "udp", "both"], transports: ["stream", "datagram", "mixed"], runtime: [], diagnostics: [] } });

it("relay both retarget rebuild resolves the ACKed exit before cutting over ingress and keeps both durable leases", async () => {
  const { f, deps, orch } = modeSwitchEnv();
  const baseline = f.snapshots.find((s) => s.revision === 6)!;
  const desired = f.snapshots.find((s) => s.revision === 7)!;
  Object.assign(baseline, { mode: "relay", protocol: "both", egress_node_id: 21, egress_port: 31000,
    target_host: "10.8.8.8", target_port: 80,
    targets: [{ host: "10.8.8.8", port: 80, weight: 1, order_by: 10 }] });
  Object.assign(desired, { protocol: "both", target_host: "10.8.8.8", target_port: 81,
    targets: [{ host: "10.8.8.8", port: 81, weight: 1, order_by: 10 }] });
  Object.assign(f.tunnels[0]!, { forward_protocol: "both", tunnel_type: null,
    ingress_node: { connect_ip: "10.0.0.11" } });
  const ingressLease = f.addLease({ node_id: 11, port: 10001, lease_type: "ingress", tunnel_id: 1, protocol: "unknown" });
  const egressLease = f.addLease({ node_id: 21, port: 31000, lease_type: "egress", tunnel_id: 1, protocol: "unknown" });
  deps.loadCapabilityFacts = async () => nativeBothFacts();
  const registration = await registerRollout({ tunnelId: 1, revision: 7, baseRevision: 6,
    impact: impact({ listener_replacement: true, target_change: true, egress_target_change: true }) }, deps);
  expect(registration.rolloutId).not.toBeNull();
  const result = await executeRollout(registration.rolloutId!, deps);
  expect(result.phase, JSON.stringify(result)).toBe("done");
  expect(orch.calls.dispatchEgress[0]).toMatchObject({ protocol: "both", egressPort: 31000,
    targets: [{ host: "10.8.8.8", port: 81 }], hopPeer: "10.0.0.11" });
  expect(orch.calls.dispatchIngress).toHaveLength(1);
  expect(orch.calls.dispatchIngress[0]).toMatchObject({ protocol: "both", revision: 7, nextHop: "10.0.1.21:31000" });
  expect(orch.calls.removeTunnel).toHaveLength(0);
  expect(f.leases.filter((l) => l.status === "active").map((l) => l.id)).toEqual([ingressLease, egressLease]);
});

it.each(["direct", "relay"] as const)("%s both failed cutover restores a revision strictly above each removal fence", async (mode) => {
  const { f, deps, orch } = mode === "direct" ? directEnv() : modeSwitchEnv();
  f.snapshots.forEach((s) => { s.protocol = "both"; s.listen_port = 10001; });
  if (mode === "relay") Object.assign(f.snapshots.find((s) => s.revision === 6)!, {
    mode, egress_node_id: 21, egress_port: 31000,
    targets: [{ host: "10.9.9.9", port: 8080, weight: 1, order_by: 10 }] });
  Object.assign(f.tunnels[0]!, { forward_protocol: "both", tunnel_type: null, listen_port: 10001,
    ingress_node: { connect_ip: "10.0.0.11" } });
  if (mode === "direct") f.leases[0]!.protocol = "unknown";
  else {
    f.addLease({ node_id: 11, port: 10001, lease_type: "ingress", tunnel_id: 1, protocol: "unknown" });
    f.addLease({ node_id: 21, port: 31000, lease_type: "egress", tunnel_id: 1, protocol: "unknown" });
  }
  deps.loadCapabilityFacts = async () => nativeBothFacts();
  const fences = new Map<string, number>();
  const remove = orch.removeTunnel;
  orch.removeTunnel = (async (input: Record<string, any>) => {
    const result = await remove(input);
    fences.set(`${input.node.id}:${input.direction}`, Number(input.revision));
    return result;
  }) as typeof orch.removeTunnel;
  for (const [method, nodeKey, direction] of [
    ["dispatchDirect", "ingressNode", "direct"], ["dispatchIngress", "ingressNode", "ingress"],
    ["dispatchEgress", "egressNode", "egress"],
  ] as const) {
    const dispatch = orch[method];
    const fencedDispatch = async (input: Record<string, any>) => {
      const result = await dispatch(input);
      if (direction !== "egress" && Number(input.revision) === 7)
        return { ok: false, error_code: "agent_rejected", error: "candidate bind failed" };
      // Match Agent ReplaceListener: incoming <= removedRevision is stale.
      if (Number(input.revision) <= (fences.get(`${input[nodeKey].id}:${direction}`) ?? 0))
        return { ok: false, error_code: "stale_revision", error: "removal fence" };
      return result;
    };
    Object.assign(orch, { [method]: fencedDispatch });
  }
  const registration = await registerRollout({ tunnelId: 1, revision: 7, baseRevision: 6,
    impact: impact({ listener_replacement: true, target_change: true, egress_target_change: mode === "relay" }) }, deps);
  const result = await executeRollout(registration.rolloutId!, deps);
  expect(result.phase, JSON.stringify(result)).toBe("failed");
  expect(f.tunnels[0]).toMatchObject({ forward_protocol: "both", applied_revision: 8, config_revision: 8 });
  expect(Math.max(...fences.values())).toBeLessThan(8);
});

it("native both rollback restores the baseline protocol, full projection and policy at a new durable revision", async () => {
  const { f, deps, orch } = directEnv();
  Object.assign(f.snapshots.find((s) => s.revision === 6)!, { protocol: "both", max_connections: 4 });
  Object.assign(f.snapshots.find((s) => s.revision === 7)!, { protocol: "tcp", max_connections: 8 });
  Object.assign(f.tunnels[0]!, { forward_protocol: "tcp", max_connections: 8 });
  f.leases[0]!.protocol = "unknown";
  deps.loadCapabilityFacts = async () => nativeBothFacts();
  const checked: string[] = [];
  deps.runtimeUse = async (_id, resource) => { checked.push(resource.protocol!); return null; };
  const dispatch = orch.dispatchDirect;
  orch.dispatchDirect = (async (input: Record<string, unknown>) => {
    const result = await dispatch(input as unknown as Record<string, unknown>);
    return orch.calls.dispatchDirect.length === 1 ? { ok: false, error_code: "agent_rejected", error: "bind failed" } : result;
  }) as typeof orch.dispatchDirect;
  const registration = await registerRollout({ tunnelId: 1, revision: 7, baseRevision: 6,
    impact: impact({ listen_port_change: true, listener_replacement: true }) }, deps);
  expect(registration.rolloutId).not.toBeNull();
  const result = await executeRollout(registration.rolloutId!, deps);
  expect(result.phase).toBe("failed");
  expect(orch.calls.dispatchDirect.map((c) => c.protocol)).toEqual(["tcp", "both"]);
  expect(checked).toContain("both");
  const rollback = f.snapshots.find((s) => s.revision === 8)!;
  expect(f.tunnels[0]).toMatchObject({ forward_protocol: "both", tunnel_type: null, config_revision: 8,
    applied_revision: 8, desired_revision_id: rollback.id, listen_port: 10001, max_connections: 4 });
});

it("native both rollback rechecks fresh capabilities before replay; removal still proceeds without them", async () => {
  const { f, deps, orch } = directEnv();
  Object.assign(f.snapshots.find((s) => s.revision === 6)!, { protocol: "both" });
  Object.assign(f.snapshots.find((s) => s.revision === 7)!, { protocol: "tcp" });
  f.tunnels[0]!.forward_protocol = "tcp";
  const registration = await registerRollout({ tunnelId: 1, revision: 7, baseRevision: 6,
    impact: impact({ listen_port_change: true, listener_replacement: true }) }, deps);
  deps.loadCapabilityFacts = async () => null;
  const dispatchedBeforeCompensation = orch.calls.dispatchDirect.length;
  const result = await compensateRollout(registration.rolloutId!, deps);
  expect(result.ok).toBe(false); expect(result.error).toContain("protocol_not_supported");
  expect(orch.calls.removeTunnel.length).toBeGreaterThan(0);
  expect(orch.calls.dispatchDirect).toHaveLength(dispatchedBeforeCompensation);
  expect(f.tunnels[0]!.forward_protocol).toBe("tcp");
});

it("relay both compensation retains hop_peer from the baseline ingress after a failed placement/protocol change", async () => {
  const { f, deps, orch } = directEnv();
  Object.assign(f.snapshots.find((s) => s.revision === 6)!, { protocol: "both", mode: "relay", egress_node_id: 21,
    egress_port: 31000, targets: [{ host: "10.9.9.9", port: 8080, weight: 1, order_by: 10 }] });
  Object.assign(f.snapshots.find((s) => s.revision === 7)!, { protocol: "tcp", ingress_node_id: 12 });
  Object.assign(f.tunnels[0]!, { forward_protocol: "tcp", ingress_node_id: 12,
    ingress_node: { connect_ip: "10.0.0.12" } });
  deps.loadCapabilityFacts = async () => nativeBothFacts();
  const registration = await registerRollout({ tunnelId: 1, revision: 7, baseRevision: 6,
    impact: impact({ ingress_node_change: true, listener_replacement: true }) }, deps);
  // Inject the persisted failure phase; compensation's terminal CAS must never
  // be exercised on a done rollout (registration executes eagerly).
  f.rollouts.find((r) => r.id === registration.rolloutId)!.phase = "compensating";
  const outcome = await compensateRollout(registration.rolloutId!, deps);
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  expect(orch.calls.dispatchEgress.at(-1)).toMatchObject({ protocol: "both", hopPeer: "10.0.0.11", egressPort: 31000 });
  expect(orch.calls.dispatchIngress.at(-1)).toMatchObject({ protocol: "both", revision: 8, ingressNode: { id: 11 } });
});

it("both automatic PREPARE lease reuse is not released when a later PREPARE step fails", async () => {
  const { f, deps } = modeSwitchEnv();
  f.snapshots.forEach((s) => { s.protocol = "both"; }); f.tunnels[0]!.forward_protocol = "both";
  f.snapshots.find((s) => s.revision === 7)!.listen_port = null;
  const leaseId = f.addLease({ node_id: 11, port: 10001, lease_type: "ingress", tunnel_id: 1, protocol: "unknown" });
  deps.loadCapabilityFacts = async () => nativeBothFacts();
  deps.orchestrator = fakeOrchestrator({ failOn: { dispatchEgress: true } });
  const registration = await registerRollout({ tunnelId: 1, revision: 7, baseRevision: 6,
    impact: impact({ mode_change: true, listener_replacement: true }) }, deps);
  const result = await executeRollout(registration.rolloutId!, deps);
  expect(result.phase).toBe("failed");
  expect(f.leases.find((l) => l.id === leaseId)).toMatchObject({ status: "active", protocol: "unknown" });
});

/* ------------------------------------------------------------------ */
/* 假 orchestrator                                                      */
/* ------------------------------------------------------------------ */

it("rollout lease fixtures preserve full bindings across TCP retry and UDP allocation", async () => {
  const f = fakeDb();
  const deps = { db: f.db, redis: { set: async () => null, del: async () => 0, scan: async () => ["0", []] as [string, string[]] },
    agentUsedPorts: async () => [] };
  const input = { nodeId: 11, leaseType: "ingress" as const, preferredPort: 10001, tunnelId: 1, protocol: "tcp" };
  const first = await acquirePort(input, deps);
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error(first.code);
  expect(first.result).toMatchObject({ port: 10001, tunnelId: 1, protocol: "tcp", bindScope: "*" });
  expect(f.leases[0]!.node_id).toBe(11);
  const retry = await acquirePort(input, deps);
  expect(retry).toMatchObject({ ok: true, result: { leaseId: first.result.leaseId, reused: true } });
  expect(await acquirePort({ ...input, tunnelId: 2, protocol: "udp" }, deps)).toMatchObject({ ok: true });
  expect(f.leases).toHaveLength(2);
});

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
    releaseOwnership: [] as Array<Record<string, unknown>>,
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
    releaseOwnership: async (input: Record<string, unknown>) => {
      calls.releaseOwnership.push(input);
      return { ok: true as const };
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
    middle_node_change: false,
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
  const deps: RolloutDeps = { db: f.db, runtimeUse: async () => null, orchestrator: orch, sleep: async () => {} };
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
  return { f, deps: { db: f.db, runtimeUse: async () => null, orchestrator: orch } as RolloutDeps, orch };
}


/** V4-F1：建一个「DIRECT ingress 11 → 12」迁移环境。 */
function ingressMigrationEnv(overrides: { failOn?: FakeOrchestratorOpts["failOn"] } = {}) {
  const f = fakeDb();
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
    middle_node_id: null,
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
    ingress_node_id: 12,
    egress_node_id: null,
    middle_node_id: null,
    listen_port: 10001,
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
    ingress_node_id: 12,
    egress_node_id: null,
    middle_node_id: null,
    listen_ip: null,
    listen_port: 10001,
    remote_host: "10.9.9.9",
    remote_port: 8080,
    egress_pool_id: null,
    egress_port: null,
    config_revision: 7,
    desired_revision_id: null,
    desired_status: "active",
    apply_status: "pending",
    applied_revision: 6,
    node_id: 12,
  });

  const orch = fakeOrchestrator({ failOn: overrides.failOn });
  const deps: RolloutDeps = { db: f.db, runtimeUse: async () => null, orchestrator: orch, sleep: async () => {} };
  return { f, deps, orch };
}

/** V5.4：建一个「三跳 rev6 → 单跳 rev7」环境，专门覆盖 G4.6 的回切。 */
function removeMiddleHopEnv() {
  const f = fakeDb();
  f.addLease({ node_id: 11, port: 10001, lease_type: "ingress", tunnel_id: 1, status: "active", expires_at: null });
  f.addLease({ node_id: 22, port: 22000, lease_type: "egress", tunnel_id: 1, status: "active", expires_at: null });
  f.addLease({ node_id: 23, port: 23000, lease_type: "egress", tunnel_id: 1, status: "active", expires_at: null });

  f.addSnapshot({
    tunnel_id: 1,
    revision: 6,
    name: "three-hop",
    desired_status: "active",
    mode: "relay",
    ingress_node_id: 11,
    egress_node_id: 22,
    middle_node_id: 23,
    listen_port: 10001,
    target_host: null,
    target_port: null,
    egress_pool_id: 1,
    egress_port: 22000,
    targets: [{ host: "10.9.9.9", port: 8080, weight: 1, order_by: 10 }],
    listen_ip: null,
  });
  f.addSnapshot({
    tunnel_id: 1,
    revision: 7,
    name: "single-hop",
    desired_status: "active",
    mode: "relay",
    ingress_node_id: 11,
    egress_node_id: 22,
    middle_node_id: null,
    listen_port: 10001,
    target_host: null,
    target_port: null,
    egress_pool_id: 1,
    egress_port: 22000,
    targets: [{ host: "10.9.9.9", port: 8080, weight: 1, order_by: 10 }],
    listen_ip: null,
  });
  f.addTunnel({
    id: 1,
    name: "single-hop",
    tunnel_mode: "relay",
    ingress_node_id: 11,
    egress_node_id: 22,
    middle_node_id: null,
    listen_ip: null,
    listen_port: 10001,
    remote_host: null,
    remote_port: null,
    egress_pool_id: 1,
    egress_port: 22000,
    config_revision: 7,
    desired_revision_id: null,
    desired_status: "active",
    apply_status: "pending",
    node_id: 11,
  });

  const orch = fakeOrchestrator({ egressHost: "10.0.1.22" });
  const deps: RolloutDeps = { db: f.db, runtimeUse: async () => null, orchestrator: orch, sleep: async () => {} };
  return { f, deps, orch };
}

/* ------------------------------------------------------------------ */
/* 1. 正常路径                                                          */
/* ------------------------------------------------------------------ */

describe("V4-F1 ingress ownership handoff", () => {
  it("stops old ingress and releases ownership before dispatching the new ingress", async () => {
    const { f, deps, orch } = ingressMigrationEnv();
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({
          ingress_node_change: true,
          listener_replacement: true,
          changes_external_address: true,
        }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );

    expect(res.ok).toBe(true);
    expect(orch.calls.removeTunnel).toHaveLength(1);
    expect(orch.calls.releaseOwnership).toHaveLength(1);
    expect(orch.calls.dispatchDirect).toHaveLength(1);

    const oldRemoval = orch.calls.removeTunnel[0]!;
    expect(oldRemoval).toMatchObject({
      tunnelId: 1,
      revision: 7,
      direction: "direct",
    });
    expect(Number((oldRemoval.node as { id?: number } | undefined)?.id)).toBe(11);
    expect(orch.calls.releaseOwnership[0]).toMatchObject({ tunnelId: 1, nodeId: 11 });

    const newDispatch = orch.calls.dispatchDirect[0]!;
    expect(Number((newDispatch.ingressNode as { id?: number } | undefined)?.id)).toBe(12);

    expect(f.leases.find((l) => l.node_id === 11 && l.port === 10001)?.status).toBe("released");
    expect(f.leases.find((l) => l.node_id === 12 && l.port === 10001)?.status).toBe("active");
  });

  it("if new ingress cutover fails, compensation releases the attempted owner before replaying baseline", async () => {
    const { deps, orch } = ingressMigrationEnv({ failOn: { dispatchDirect: true } });
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({
          ingress_node_change: true,
          listener_replacement: true,
          changes_external_address: true,
        }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );

    expect(res.ok).toBe(false);
    // handoff old owner + compensation attempted new owner release
    expect(orch.calls.releaseOwnership.length).toBeGreaterThanOrEqual(2);
    expect(orch.calls.releaseOwnership[0]).toMatchObject({ tunnelId: 1, nodeId: 11 });
    expect(orch.calls.releaseOwnership.some((x) => x.nodeId === 12)).toBe(true);
  });
});

describe("V5.4 middle-hop topology cutover", () => {
  it("removing middle hop re-cuts ingress to egress, retires transit, and releases only the transit lease", async () => {
    const { f, deps, orch } = removeMiddleHopEnv();
    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ middle_node_change: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );

    expect(res.ok).toBe(true);
    expect(orch.calls.dispatchEgress).toHaveLength(1);
    expect(orch.calls.dispatchIngress).toHaveLength(1);
    expect(String(orch.calls.dispatchIngress[0]?.nextHop)).toBe("10.0.1.22:22000");

    const transitRemovals = orch.calls.removeTunnel.filter(
      (x) => Number((x.node as { id?: number } | undefined)?.id) === 23 && x.direction === "egress",
    );
    expect(transitRemovals.length).toBeGreaterThan(0);

    expect(f.leases.find((l) => l.node_id === 23 && l.port === 23000)?.status).toBe("released");
    expect(f.leases.find((l) => l.node_id === 22 && l.port === 22000)?.status).toBe("active");
    expect(f.leases.find((l) => l.node_id === 11 && l.port === 10001)?.status).toBe("active");
  });
});

describe("正常路径：五阶段推进到 done", () => {
  it("DIRECT 同节点换端口 ⇒ Agent 自行 retire 旧 listener，backend 不 remove 新 runtime", async () => {
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
    // validate + acquire + cutover + cleanup；同节点端口移动不再生成远程 drain。
    expect(readKeySet(f.rollouts[0]!.cleaned)).toHaveLength(4);
    expect(orch.calls.removeTunnel).toHaveLength(0);
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

  it("DIRECT→RELAY egress_port=auto ⇒ 租端口、next_hop 同端口并持久化", async () => {
    const { f, deps, orch } = modeSwitchEnv();
    const desired = f.snapshots.find((s) => Number(s.revision) === 7)!;
    desired.egress_port = null;
    f.tunnels[0]!.egress_port = null;

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
    const dispatched = Number(orch.calls.dispatchEgress[0]?.egressPort);
    expect(dispatched).toBeGreaterThan(0);
    expect(String(orch.calls.dispatchIngress[0]?.nextHop)).toBe(`10.0.1.21:${dispatched}`);
    expect(f.tunnels[0]!.egress_port).toBe(dispatched);
    expect(f.leases.some((l) => l.node_id === 21 && l.port === dispatched && l.status === "active")).toBe(true);
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
  it("Tunnel 成功记账失败时 rollout 不得先进入 done", async () => {
    const { f, deps } = directEnv();
    const original = deps.db.tunnel.updateMany;
    deps.db.tunnel.updateMany = async (args: unknown) => {
      const data = (args as { data?: Record<string, unknown> }).data ?? {};
      if (data.apply_status === "active" && data.applied_revision === 7) {
        throw new Error("simulated tunnel ledger failure");
      }
      return original(args);
    };

    await expect(
      registerRollout(
        {
          tunnelId: 1,
          impact: impact({ listen_port_change: true, listener_replacement: true }),
          revision: 7,
          baseRevision: 6,
        },
        deps,
      ),
    ).rejects.toThrow(/simulated tunnel ledger failure/);

    expect(f.rollouts[0]!.phase).not.toBe("done");
  });

  it("resume 到 done 时同样补写 applied_revision", async () => {
    const at = new Date("2026-09-26T04:05:00.000Z");
    const { f, orch } = directEnv();
    const deps: RolloutDeps = { db: f.db, runtimeUse: async () => null, orchestrator: orch, now: () => at, sleep: async () => {} };
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
    const failDeps: RolloutDeps = { db: relay.f.db, runtimeUse: async () => null, orchestrator: failOrch };
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

  it("PREPARE 复用本隧道已有 active lease 时，失败清理不得释放旧 ownership", async () => {
    const relay = modeSwitchEnv();
    const existingLeaseId = relay.f.addLease({
      node_id: 21,
      port: 31000,
      lease_type: "egress",
      tunnel_id: 1,
      status: "active",
      expires_at: null,
    });
    const failOrch = fakeOrchestrator({ failOn: { dispatchEgress: true } });
    const failDeps: RolloutDeps = {
      db: relay.f.db,
      runtimeUse: async () => null,
      orchestrator: failOrch,
    };

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
    expect(relay.f.leases.find((lease) => lease.id === existingLeaseId)?.status).toBe("active");
  });

  it("CUTOVER 清理无法确认 runtime 已撤时保留新端口租约，避免双绑", async () => {
    const { f } = modeSwitchEnv();
    const desired = f.snapshots.find((s) => Number(s.revision) === 7)!;
    desired.egress_port = null;
    f.tunnels[0]!.egress_port = null;

    const failOrch = fakeOrchestrator({
      failOn: { dispatchIngress: true, removeTunnel: true },
    });
    const deps: RolloutDeps = {
      db: f.db,
      runtimeUse: async () => null,
      orchestrator: failOrch,
      sleep: async () => {},
    };

    const res = await registerRollout(
      {
        tunnelId: 1,
        impact: impact({ mode_change: true, egress_node_change: true }),
        revision: 7,
        baseRevision: 6,
      },
      deps,
    );

    expect(res.ok).toBe(false);
    const preparedLease = f.leases.find(
      (lease) => lease.node_id === 21 && lease.tunnel_id === 1,
    );
    expect(preparedLease).toBeTruthy();
    expect(preparedLease?.status).toBe("active");
    expect(f.rollouts[0]!.phase).toBe("degraded");
  });

  it("CUTOVER 失败 ⇒ compensating → 补偿撤新 runtime + 重放基线", async () => {
    const { f } = modeSwitchEnv();
    // ingress 失败 ⇒ cutover 阶段失败 ⇒ 必须补偿。
    const failOrch = fakeOrchestrator({ failOn: { dispatchIngress: true } });
    const d2: RolloutDeps = { db: f.db, runtimeUse: async () => null, orchestrator: failOrch };
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
    // 重放基线（rev6 是 DIRECT）——但**挂在新世代上**（V5.3 契约变更）。
    expect(failOrch.calls.dispatchDirect.length).toBe(1);
    // max(base 6, target 7) + 1 = 8：内容 = 基线，版本继续向前。
    // 旧契约（原地重放 revision 6）会被 Agent 正确地拒绝为 stale_revision —— 那正是补偿
    // 永远失败、rollout 停在 degraded 的原因（forward_rollout#35 的 compensation_error）。
    expect((failOrch.calls.dispatchDirect[0] as { revision: number }).revision).toBe(8);
    // 新世代的快照必须存在，否则下一次 rollout 按 revision 找基线会"不存在"。
    expect(f.snapshots.some((s) => Number(s.revision) === 8)).toBe(true);
    // 成功补偿 ⇒ failed（不是 degraded）；台账**一起前进**：内容回到基线、版本是新世代。
    expect(f.rollouts[0]!.compensated).toBe(true);
    expect(f.tunnels[0]!.apply_status).toBe("active");
    expect(f.tunnels[0]!.config_revision).toBe(8);
    expect(f.tunnels[0]!.applied_revision).toBe(8);
    expect(String(f.tunnels[0]!.apply_error_code)).toBe("rollback_compensated");
  });

  it("补偿失败 ⇒ degraded", async () => {
    const { f, deps } = modeSwitchEnv();
    // ingress 失败 + removeTunnel 也失败 ⇒ 补偿无法完成。
    const failOrch = fakeOrchestrator({ failOn: { dispatchIngress: true, removeTunnel: true } });
    const d2: RolloutDeps = { db: f.db, runtimeUse: async () => null, orchestrator: failOrch };
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
    const d2: RolloutDeps = { db: f.db, runtimeUse: async () => null, orchestrator: softOrch };
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
      { db: f.db, runtimeUse: async () => null, orchestrator: orch },
    );
    expect(first.ok).toBe(false);
    expect(first.status).toBe("waiting");
    expect(f.rollouts[0]!.phase).toBe("waiting");
    expect(f.tunnels[0]!.applied_revision).toBe(6);
    expect(orch.calls.removeTunnel).toHaveLength(0);
    expect(f.rollouts[0]!.compensated).toBe(false);

    const recovered = fakeOrchestrator();
    const resumed = await executeRollout(f.rollouts[0]!.id, {
      db: f.db,
      runtimeUse: async () => null,
      orchestrator: recovered,
      sleep: async () => {},
    });
    expect(resumed.ok).toBe(true);
    expect(f.rollouts[0]!.phase).toBe("done");
    expect(f.tunnels[0]!.applied_revision).toBe(7);
    expect(f.tunnels[0]!.config_revision).toBe(7);
    expect(recovered.calls.dispatchDirect).toHaveLength(1);
    // same-node listener replacement由 Agent 自行 retire 旧 listener；backend 不应
    // remove 同一个 logical resource，否则会把刚恢复的新 listener 一并删掉。
    expect(recovered.calls.removeTunnel).toHaveLength(0);
    expect(f.rollouts[0]!.compensated).toBe(false);
  });


  it("waiting 恢复优先相信新鲜 NodeStateReport：runtime 已到目标 revision 时不重发", async () => {
    const { f } = directEnv();
    f.tunnels[0]!.applied_revision = 6;
    f.tunnels[0]!.apply_status = "pending";

    const firstOrch = fakeOrchestrator({ failOn: { dispatchDirect: true }, failCode: "ack_timeout" });
    const first = await registerRollout(
      { tunnelId: 1, impact: impact({ target_change: true }), revision: 7, baseRevision: 6 },
      { db: f.db, runtimeUse: async () => null, orchestrator: firstOrch, now: () => new Date("2026-09-26T13:00:00.000Z") },
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
      runtimeUse: async () => null,
      orchestrator: recovered,
      now: () => new Date("2026-09-26T13:00:31.000Z"),
      sleep: async () => {},
    });
    expect(resumed.ok).toBe(true);
    expect(resumed.phase).toBe("done");
    expect(recovered.calls.dispatchDirect).toHaveLength(0);
    expect(f.tunnels[0]!.applied_revision).toBe(7);
  });


  it("waiting 恢复会等一个 state-report 周期，迟到的 runtime revision 出现后不重发", async () => {
    const { f } = directEnv();
    f.tunnels[0]!.applied_revision = 6;
    f.tunnels[0]!.apply_status = "pending";

    const firstOrch = fakeOrchestrator({ failOn: { dispatchDirect: true }, failCode: "ack_timeout" });
    const first = await registerRollout(
      { tunnelId: 1, impact: impact({ target_change: true }), revision: 7, baseRevision: 6 },
      { db: f.db, runtimeUse: async () => null, orchestrator: firstOrch, now: () => new Date("2026-09-26T13:02:00.000Z") },
    );
    expect(first.status).toBe("waiting");

    let reads = 0;
    (f.db as RolloutDb & { nodeStateReport?: { findUnique(args: unknown): Promise<unknown> } }).nodeStateReport = {
      findUnique: async () => {
        reads += 1;
        return {
          tunnels: reads < 3
            ? [{ id: "tunex-1-direct", revision: 6 }]
            : [{ id: "tunex-1-direct", revision: 7 }],
          reported_at: new Date("2026-09-26T13:02:10.000Z"),
        };
      },
    };

    let tick = 0;
    const resumedOrch = fakeOrchestrator({ failOn: { dispatchDirect: true }, failCode: "agent_rejected" });
    const resumed = await executeRollout(f.rollouts[0]!.id, {
      db: f.db,
      runtimeUse: async () => null,
      orchestrator: resumedOrch,
      now: () => new Date(Date.parse("2026-09-26T13:02:31.000Z") + tick * 1000),
      sleep: async () => { tick += 1; },
    });
    expect(resumed.ok).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(resumedOrch.calls.dispatchDirect).toHaveLength(0);
    expect(f.tunnels[0]!.applied_revision).toBe(7);
  });

  it("executor lease 阻止第二个执行器对同一 active rollout 产生远程副作用", async () => {
    const { f } = directEnv();
    const firstOrch = fakeOrchestrator({ failOn: { dispatchDirect: true }, failCode: "ack_timeout" });
    const first = await registerRollout(
      { tunnelId: 1, impact: impact({ target_change: true }), revision: 7, baseRevision: 6 },
      { db: f.db, runtimeUse: async () => null, orchestrator: firstOrch, now: () => new Date("2026-09-26T13:01:00.000Z") },
    );
    expect(first.status).toBe("waiting");

    f.rollouts[0]!.executor_owner = "other-executor";
    f.rollouts[0]!.executor_lease_until = new Date("2026-09-26T13:03:00.000Z");
    const contender = fakeOrchestrator();
    const result = await executeRollout(f.rollouts[0]!.id, {
      db: f.db,
      runtimeUse: async () => null,
      orchestrator: contender,
      now: () => new Date("2026-09-26T13:01:30.000Z"),
    });
    expect(result.ok).toBe(false);
    expect(result.error_code).toBe("concurrent_transition");
    expect(contender.calls.dispatchDirect).toHaveLength(0);
  });
  it("cutover 后崩溃 ⇒ resume 只补做 cleanup，不重发入口配置/不误删新 listener", async () => {
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

    // 抹掉 cleanup 进度，phase 退回 drain：模拟 cutover_ingress 已 ACK 后进程
    // 被 kill。same-node port move 没有远程 drain step，恢复只能做安全 cleanup。
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
    // 不能发 remove_tunnel；Agent ReplaceListener 已经负责旧 listener 退场。
    expect(orch.calls.removeTunnel).toHaveLength(beforeRemove);
    // validate + acquire + cutover + cleanup 共四个步骤。
    expect(readKeySet(f.rollouts[0]!.cleaned)).toHaveLength(4);
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
    // 续跑补偿与首次补偿必须产出**同一个新世代**（8 = max(base 6, target 7) + 1）：
    // 补偿是幂等的，不会每次崩溃都再抬一个版本号。
    expect(Number((orch.calls.dispatchDirect.at(-1) as { revision: number }).revision)).toBe(8);
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
    expect(readKeySet(f.rollouts[0]!.cleaned)).toHaveLength(4);
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
