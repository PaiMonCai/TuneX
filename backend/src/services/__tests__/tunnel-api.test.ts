/**
 * WP11 — Tunnel RELAY API 离线测试（不连 MySQL / Redis / 网络）。
 *
 * 依据 `DEVELOPMENT.md` §7.13「WP10 / WP11 — API Track」、§4.1（期望状态）、
 * §4.2（RELAY 编排铁律）。覆盖矩阵：
 *   A. **CRUD**：创建（direct/relay 分流）、读（列表/详情）、更新、删除；
 *      RELAY 拓扑硬校验（必须有出口组、不能同组、池 ID 形态）；
 *   B. **状态操作兼容矩阵**：retry 仅 error、resume 仅 suspended/error、
 *      suspend 幂等拒绝、delete 任意态；
 *   C. **所有运行操作统一走 orchestrator**（§7.13 铁律）：
 *      · 创建 RELAY → `applyCreate`（= WP8 `createRelayTunnel`）被调用，
 *        且退回 pending → applying → active 的 revision 由编排器推进；
 *      · retry/resume → `applyReapply`（= WP8 `reapplyRelayTunnel`），
 *        **同一 tunnelId**、不新建行；
 *      · delete → 两端各一次 `removeTunnel`（revision+1）后才删行；
 *   D. **失败保留 Tunnel**（§4.1）：编排失败 → `apply_status=error` +
 *      结构化错误码 + 行仍在，绝不 delete；
 *   E. **未接线不假装成功**：无 orchestrator 时 RELAY 停在 pending，
 *      不会回一个假 active；
 *   F. **越权不可见**：别的 workspace 的 tunnelId 一律 404（不是 403——
 *      不泄漏「这个 ID 存在」）。
 *
 * ── 替身设计 ──
 * `tunnel-api.ts` 把 db / 策略 / 编排入口全做成可注入（`TunnelApiDeps`），
 * 所以这里**不需要 `mock.module`：内存替身直接传进去。比 mock.module 稳
 * —— 它不会因为换 worktree / CI 路径而静默失效。
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  APPLY_STATUSES,
  TUNNEL_ACTIONS,
  TUNNEL_API_ERROR_STATUS,
  canRunAction,
  createTunnel,
  desiredAfterAction,
  getTunnelState,
  listTunnels,
  parseApplyStatusFilter,
  parseDesiredStatus,
  parseForwardAddress,
  parseTunnelMode,
  runTunnelAction,
  toTunnelApiError,
  tunnelView,
  updateTunnel,
  validateRelayTopology,
  type EgressPoolRow,
  type NodeGroupRow,
  type TunnelApiDeps,
  type TunnelApiNodeRow,
  type TunnelRow,
} from "../tunnel-api.ts";
import type { EffectivePolicy } from "../capability-policy.ts";
import type { CreateRelayTunnelResult } from "../scheduler.ts";

/* ------------------------------------------------------------------ */
/* 内存表                                                               */
/* ------------------------------------------------------------------ */

interface NodeRow extends TunnelApiNodeRow {
  node_group_id: number;
}

const tunnels = new Map<number, TunnelRow>();
const nodes: NodeRow[] = [];
const groups: NodeGroupRow[] = [];
const pools: EgressPoolRow[] = [];
/** 编排器收到的 apply 调用记录（验证「确实走 orchestrator」）。 */
const orchestratorCalls: {
  kind: "create" | "reapply" | "remove";
  tunnelId: number;
  revision?: number;
  nodeId?: number;
}[] = [];
/** 假 Agent 是否接受下一次下发。 */
let agentHealthy = true;

let nextTunnelId = 100;

function resetState(): void {
  tunnels.clear();
  nodes.length = 0;
  groups.length = 0;
  pools.length = 0;
  orchestratorCalls.length = 0;
  agentHealthy = true;
  nextTunnelId = 100;
}

function seedGroups(): void {
  groups.length = 0;
  groups.push(
    { id: 10, name: "in-group", node_type: "in", workspace_id: 7 },
    { id: 20, name: "out-group", node_type: "out", workspace_id: 7 },
    { id: 30, name: "other-ws", node_type: "in", workspace_id: 9 },
  );
}

function seedNodes(): void {
  nodes.length = 0;
  nodes.push(
    { id: 1, node_id: "ing-1", connect_ip: "10.0.0.1", role: "ingress", node_group_id: 10 },
    { id: 2, node_id: "egr-1", connect_ip: "10.0.0.2", role: "egress", node_group_id: 20 },
  );
}

function seedPools(): void {
  pools.length = 0;
  pools.push({ id: 99, node_id: 2, name: "default", status: "active" });
}

/** 造一条 relay 隧道行（可按状态覆写）。 */
function seedTunnel(over: Partial<TunnelRow> = {}): TunnelRow {
  const id = over.id ?? nextTunnelId++;
  const row: TunnelRow = {
    id,
    name: `tunnel-${id}`,
    tunnel_type: "tcp",
    listen_ip: "0.0.0.0",
    listen_port: 20000 + id,
    status: "active",
    in_node_group_id: 10,
    out_node_group_id: 20,
    user_id: 1,
    workspace_id: 7,
    tunnel_mode: "relay",
    egress_node_id: 2,
    egress_pool_id: 99,
    egress_port: 30000 + id,
    remote_host: null,
    remote_port: null,
    desired_status: "active",
    apply_status: "active",
    config_revision: 3,
    applied_revision: 3,
    apply_error_code: null,
    apply_error: null,
    last_applied_at: null,
    ...over,
  };
  tunnels.set(id, row);
  return row;
}

/* ------------------------------------------------------------------ */
/* 内存 DB 替身                                                         */
/* ------------------------------------------------------------------ */

function makeDb(): TunnelApiDeps["db"] {
  return {
    tunnel: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        if (where.id !== undefined) return tunnels.get(where.id as number) ?? null;
        return null;
      },
      async findFirst({ where }: { where: Record<string, unknown> }) {
        for (const t of tunnels.values()) {
          if (where.workspace_id !== undefined && t.workspace_id !== where.workspace_id) continue;
          if (where.id !== undefined && t.id !== where.id) continue;
          if (where.apply_status !== undefined && t.apply_status !== where.apply_status) continue;
          if (where.tunnel_mode !== undefined && t.tunnel_mode !== where.tunnel_mode) continue;
          // listen_port 冲突查询（PATCH 更新用）。
          if (where.listen_port !== undefined) {
            const port = where.listen_port as number;
            if (t.listen_port !== port) continue;
            const not = where.NOT as { id?: number } | undefined;
            if (not?.id !== undefined && t.id === not.id) continue;
            if (where.in_node_group_id !== undefined && t.in_node_group_id !== where.in_node_group_id) continue;
          }
          return t;
        }
        return null;
      },
      async findMany({ where }: { where?: Record<string, unknown> }) {
        let rows = [...tunnels.values()];
        if (where) {
          for (const [k, v] of Object.entries(where)) {
            if (v === undefined) continue;
            if (k === "name" && typeof v === "object") {
              const contains = (v as { contains?: string }).contains;
              if (contains) rows = rows.filter((t) => t.name.includes(contains));
              continue;
            }
            rows = rows.filter((t) => (t as unknown as Record<string, unknown>)[k] === v);
          }
        }
        return rows.sort((a, b) => b.id - a.id);
      },
      async count({ where }: { where?: Record<string, unknown> }) {
        let rows = [...tunnels.values()];
        if (where) {
          for (const [k, v] of Object.entries(where)) {
            if (v === undefined) continue;
            rows = rows.filter((t) => (t as unknown as Record<string, unknown>)[k] === v);
          }
        }
        return rows.length;
      },
      async create({ data }: { data: Partial<TunnelRow> }) {
        const id = nextTunnelId++;
        const row: TunnelRow = {
          id,
          name: String(data.name ?? ""),
          tunnel_type: String(data.tunnel_type ?? "tcp"),
          listen_ip: (data.listen_ip as string | null) ?? null,
          listen_port: (data.listen_port as number | null) ?? null,
          listen_protocol: ["tcp"],
          status: "active",
          forward_addresses: (data.forward_addresses as string[]) ?? [],
          forward_addresses_protocol: null,
          load_balance_type: "round",
          ip_type: "ipv4",
          order_by: 1000,
          ip_limit: null,
          client_limit: null,
          bandwidth_limit: null,
          traffic: 0,
          traffic_cost: 0,
          proxy_protocol: false,
          created_at: new Date(),
          updated_at: new Date(),
          in_node_group_id: Number(data.in_node_group_id ?? 0),
          out_node_group_id: (data.out_node_group_id as number | null) ?? null,
          user_id: Number(data.user_id ?? 0),
          workspace_id: Number(data.workspace_id ?? 0),
          tunnel_mode: (data.tunnel_mode as string | null) ?? null,
          egress_node_id: (data.egress_node_id as number | null) ?? null,
          egress_pool_id: (data.egress_pool_id as number | null) ?? null,
          egress_port: (data.egress_port as number | null) ?? null,
          remote_host: (data.remote_host as string | null) ?? null,
          remote_port: (data.remote_port as number | null) ?? null,
          desired_status: (data.desired_status as string | null) ?? null,
          apply_status: (data.apply_status as string | null) ?? null,
          config_revision: (data.config_revision as number | null) ?? null,
          applied_revision: (data.applied_revision as number | null) ?? null,
          apply_error_code: (data.apply_error_code as string | null) ?? null,
          apply_error: (data.apply_error as string | null) ?? null,
          last_applied_at: (data.last_applied_at as Date | null) ?? null,
          port_leases: [],
        };
        tunnels.set(id, row);
        return row;
      },
      async update({ where, data }: { where: { id: number }; data: Partial<TunnelRow> }) {
        const t = tunnels.get(where.id);
        if (!t) throw new Error("tunnel not found");
        Object.assign(t, data);
        return t;
      },
      async delete({ where }: { where: { id: number } }) {
        const existed = tunnels.delete(where.id);
        if (!existed) {
          const e = new Error("Record to delete does not exist.");
          (e as Error & { code: string }).code = "P2025";
          throw e;
        }
        return {};
      },
    },
    node: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        if (where.id !== undefined) return nodes.find((n) => n.id === where.id) ?? null;
        if (where.node_group_id !== undefined && where.role !== undefined) {
          return nodes.find((n) => n.node_group_id === where.node_group_id && n.role === where.role) ?? null;
        }
        return null;
      },
    },
    nodeGroup: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return groups.find((g) => g.id === where.id) ?? null;
      },
    },
    egressPool: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        return pools.find((p) => p.id === where.id) ?? null;
      },
      async findFirst({ where }: { where: Record<string, unknown> }) {
        return (
          pools.find(
            (p) =>
              (where.node_id === undefined || p.node_id === where.node_id) &&
              (where.name === undefined || p.name === where.name),
          ) ?? null
        );
      },
    },
  };
}

/** 放行一切的策略（create 路径的 auth/quota 应通过）。 */
function allowAllPolicy(): EffectivePolicy {
  return {
    workspace_id: 7,
    revision: 1,
    entitlements: {
      tunnel_types: ["tcp"],
      allow_custom_in_group: true,
      allow_custom_out_group: true,
      allowed_in_group_ids: null,
      allowed_out_group_ids: null,
      allow_shared_entry: false,
      whitelist_ips: null,
    },
    limits: {
      max_tunnels: null,
      max_nodes: null,
      max_members: null,
      traffic_limit: null,
      traffic_period: "total",
      bandwidth_limit: null,
      client_limit: null,
      ip_limit: null,
    },
    ceiling: {
      max_tunnels: null,
      max_nodes: null,
      max_members: null,
      traffic_limit: null,
      traffic_period: "total",
      bandwidth_limit: null,
      client_limit: null,
      ip_limit: null,
    },
    active_policies: [],
    grace_policies: [],
    grace_expires_at: null,
    deny_scope: false,
    deny_reason: null,
  } as unknown as EffectivePolicy;
}

/**
 * 假 orchestrator：只做「走没走」的记录与最终状态落库。
 * **不实现任何下发**——它只是编排器的替身，验证 WP11 把动作交给了编排层。
 */
const fakeOrchestrator = {
  removeTunnel: async (input: { tunnelId: number; revision: number }) => {
    orchestratorCalls.push({ kind: "remove", tunnelId: input.tunnelId, revision: input.revision });
    return { ok: true, result: { commandId: "cmd-rm", revision: input.revision, ack: {} } };
  },
};

function deps(over: TunnelApiDeps = {}): TunnelApiDeps {
  return {
    db: makeDb(),
    loadPolicy: async () => allowAllPolicy(),
    orchestrator: fakeOrchestrator as never,
    now: () => new Date("2026-09-25T12:00:00.000Z"),
    ...over,
  };
}

/** 让 `applyCreate` 替身把隧道推到 active 并回成功（模拟 WP8 编排成功）。 */
function successCreate(over: Partial<TunnelRow> = {}): NonNullable<TunnelApiDeps["applyCreate"]> {
  return async (input) => {
    const id = Number((input as { tunnelId?: number }).tunnelId ?? 0) || nextTunnelId - 1;
    orchestratorCalls.push({ kind: "create", tunnelId: id });
    if (!agentHealthy) {
      const t = tunnels.get(id);
      if (t) {
        t.apply_status = "error";
        t.desired_status = "inactive";
        t.apply_error_code = "ingress_apply_rejected";
        t.apply_error = "[ingress_apply_rejected] agent 1 rejected apply";
      }
      return {
        ok: false,
        tunnelId: id,
        steps: [],
        failedStep: "apply_ingress",
        error_code: "ingress_apply_rejected",
        error: "[ingress_apply_rejected] agent 1 rejected apply",
        retryable: true,
      } as CreateRelayTunnelResult;
    }
    const t = tunnels.get(id);
    if (t) {
      t.apply_status = "active";
      t.desired_status = "active";
      t.config_revision = 1;
      t.applied_revision = 1;
      t.apply_error_code = null;
      t.apply_error = null;
      Object.assign(t, over);
    }
    return { ok: true, tunnelId: id, revision: 1, ingressNodeId: 1, egressNodeId: 2, ingressPort: 20001, egressPort: 30001, steps: [] } as CreateRelayTunnelResult;
  };
}

/** 让 `applyReapply` 替身推进 revision 并回成功/失败。 */
function successReapply(opts: { ok?: boolean } = {}): NonNullable<TunnelApiDeps["applyReapply"]> {
  return async (tunnelId) => {
    orchestratorCalls.push({ kind: "reapply", tunnelId });
    const t = tunnels.get(tunnelId);
    const rev = (t?.config_revision ?? 0) + 1;
    if (!agentHealthy || opts.ok === false) {
      if (t) {
        t.apply_status = "error";
        t.desired_status = "inactive";
        t.apply_error_code = "egress_apply_rejected";
        t.apply_error = "[egress_apply_rejected] agent 2 unreachable";
        t.config_revision = rev;
      }
      return {
        ok: false,
        tunnelId,
        steps: [],
        failedStep: "apply_egress",
        error_code: "egress_apply_rejected",
        error: "[egress_apply_rejected] agent 2 unreachable",
        retryable: true,
      } as CreateRelayTunnelResult;
    }
    if (t) {
      t.apply_status = "active";
      t.desired_status = "active";
      t.config_revision = rev;
      t.applied_revision = rev;
      t.apply_error_code = null;
      t.apply_error = null;
    }
    return {
      ok: true,
      tunnelId,
      revision: rev,
      ingressNodeId: 1,
      egressNodeId: 2,
      ingressPort: t?.listen_port ?? 20001,
      egressPort: t?.egress_port ?? 30001,
      steps: [],
    } as CreateRelayTunnelResult;
  };
}

beforeEach(() => {
  resetState();
  seedGroups();
  seedNodes();
  seedPools();
});

/* ================================================================== */
/* A. 纯校验（无 IO）                                                    */
/* ================================================================== */

describe("A. 纯校验", () => {
  test("A1. 模式入参只接受 direct/relay（大小写不敏感）", () => {
    expect(parseTunnelMode("direct")).toBe("direct");
    expect(parseTunnelMode("RELAY")).toBe("relay");
    expect(parseTunnelMode("relay ")).toBe("relay");
    expect(parseTunnelMode("")).toBeNull();
    expect(parseTunnelMode("both")).toBeNull();
    expect(parseTunnelMode(42)).toBeNull();
  });

  test("A2. desired/apply 过滤入参归一", () => {
    expect(parseDesiredStatus("active")).toBe("active");
    expect(parseDesiredStatus("weird")).toBeNull();
    expect(parseApplyStatusFilter("all")).toBeNull();
    expect(parseApplyStatusFilter("")).toBeNull();
    expect(parseApplyStatusFilter("suspended")).toBe("suspended");
    expect(parseApplyStatusFilter("bogus")).toBeNull();
    // §4.1 五态穷尽
    expect([...APPLY_STATUSES].sort()).toEqual(["active", "applying", "error", "pending", "suspended"]);
    expect([...TUNNEL_ACTIONS].sort()).toEqual(["delete", "resume", "retry", "suspend"]);
  });

  test("A3. RELAY 拓扑：必须有出口组、不能同组", () => {
    expect(validateRelayTopology({ inNodeGroupId: 10, outNodeGroupId: 20 }).ok).toBe(true);
    expect(validateRelayTopology({ inNodeGroupId: 10, outNodeGroupId: null }).ok).toBe(false);
    expect(validateRelayTopology({ inNodeGroupId: 10, outNodeGroupId: 10 }).ok).toBe(false);
    expect(validateRelayTopology({ inNodeGroupId: 0, outNodeGroupId: 20 }).ok).toBe(false);
    expect(validateRelayTopology({ inNodeGroupId: 10, outNodeGroupId: 20, egressPoolId: 0 }).ok).toBe(false);
  });

  test("A4. 动作兼容矩阵：retry 仅 error、resume 仅 suspended/error、suspend 幂等拒绝", () => {
    expect(canRunAction("retry", { apply_status: "error" }).ok).toBe(true);
    expect(canRunAction("retry", { apply_status: "active" }).ok).toBe(false);
    expect(canRunAction("retry", { apply_status: "pending" }).ok).toBe(false);
    expect(canRunAction("resume", { apply_status: "suspended" }).ok).toBe(true);
    expect(canRunAction("resume", { apply_status: "error" }).ok).toBe(true);
    expect(canRunAction("resume", { apply_status: "active" }).ok).toBe(false);
    expect(canRunAction("suspend", { apply_status: "active" }).ok).toBe(true);
    expect(canRunAction("suspend", { apply_status: "applying" }).ok).toBe(true);
    expect(canRunAction("suspend", { apply_status: "suspended" }).ok).toBe(false);
    // delete 任意态都允许（显式用户动作）
    for (const s of APPLY_STATUSES) {
      expect(canRunAction("delete", { apply_status: s }).ok).toBe(true);
    }
  });

  test("A5. 动作 → desired 映射：retry/resume 推回 active 并清错误", () => {
    expect(desiredAfterAction("retry")).toEqual({ desired_status: "active", apply_status: "pending", clear_error: true });
    expect(desiredAfterAction("resume")).toEqual({ desired_status: "active", apply_status: "pending", clear_error: true });
    expect(desiredAfterAction("suspend")).toEqual({ desired_status: "inactive", apply_status: "suspended", clear_error: false });
    expect(desiredAfterAction("delete")).toEqual({ desired_status: "inactive", clear_error: false });
  });

  test("A6. forward 地址形态校验", () => {
    expect(parseForwardAddress("1.2.3.4:80")).toBe("1.2.3.4:80");
    expect(parseForwardAddress("example.com:443")).toBe("example.com:443");
    expect(parseForwardAddress("[::1]:8080")).toBe("[::1]:8080");
    expect(parseForwardAddress("99999")).toBeNull();
    expect(parseForwardAddress("host:notaport")).toBeNull();
    expect(parseForwardAddress("")).toBeNull();
  });

  test("A7. tunnelView 归一：老 DIRECT 行显示成 direct 而非 null", () => {
    const legacy = seedTunnel({ tunnel_mode: null, apply_status: null, config_revision: null });
    const v = tunnelView(legacy);
    expect(v.tunnel_mode).toBe("direct");
    expect(v.apply_status).toBe("pending");
    expect(v.online).toBe(false);
  });

  test("A8. 错误码 → HTTP 状态映射完整且不含 500", () => {
    // 状态码必须让前端能区分「你的问题」与「我们的问题」，不留 500 兜底。
    for (const [code, status] of Object.entries(TUNNEL_API_ERROR_STATUS)) {
      expect(typeof code).toBe("string");
      expect([400, 403, 404, 409, 502, 503]).toContain(status);
    }
    expect(TUNNEL_API_ERROR_STATUS.apply_failed).toBe(502);
    expect(TUNNEL_API_ERROR_STATUS.invalid_state).toBe(409);
    expect(toTunnelApiError({ code: "P2002" }).code).toBe("conflict");
    expect(toTunnelApiError({ code: "P2025" }).code).toBe("not_found");
  });
});

/* ================================================================== */
/* B. CRUD                                                             */
/* ================================================================== */

describe("B. CRUD", () => {
  test("B1. 创建 DIRECT：落 direct 模式，不走编排器", async () => {
    const d = deps({ applyCreate: successCreate() });
    const r = await createTunnel(
      {
        name: "direct-1",
        mode: "direct",
        userId: 1,
        workspaceId: 7,
        personalWorkspaceId: 7,
        inNodeGroupId: 10,
        outNodeGroupId: null,
        forwardAddresses: ["192.168.1.10:5000"],
        tunnelType: "tcp",
      },
      d,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("direct");
    // DIRECT 无 egress 端，绝不该触发 RELAY 编排。
    expect(orchestratorCalls.filter((c) => c.kind === "create")).toHaveLength(0);
    const created = tunnels.get(r.tunnelId)!;
    expect(created.tunnel_mode).toBe("direct");
    expect(created.forward_addresses).toEqual(["192.168.1.10:5000"]);
  });

  test("B2. 创建 RELAY：先落 pending，再交给编排器", async () => {
    const d = deps({ applyCreate: successCreate() });
    const r = await createTunnel(
      {
        name: "relay-1",
        mode: "relay",
        userId: 1,
        workspaceId: 7,
        personalWorkspaceId: 7,
        inNodeGroupId: 10,
        outNodeGroupId: 20,
        tunnelType: "tcp",
      },
      d,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("relay");
    if (r.mode !== "relay") return;
    expect(r.revision).toBe(1);
    expect(orchestratorCalls.filter((c) => c.kind === "create")).toHaveLength(1);
    const row = tunnels.get(r.tunnelId)!;
    expect(row.apply_status).toBe("active");
    expect(row.config_revision).toBe(1);
    expect(row.tunnel_mode).toBe("relay");
  });

  test("B3. 创建 RELAY 缺出口组 → 400（§2.1 双跳）", async () => {
    const r = await createTunnel(
      {
        name: "bad",
        mode: "relay",
        userId: 1,
        workspaceId: 7,
        personalWorkspaceId: 7,
        inNodeGroupId: 10,
        outNodeGroupId: null,
      },
      deps(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_input");
    expect(r.message).toContain("出口节点组");
  });

  test("B4. 创建 RELAY 同组入出口 → 400（双跳退化成单跳）", async () => {
    const r = await createTunnel(
      {
        name: "same",
        mode: "relay",
        userId: 1,
        workspaceId: 7,
        personalWorkspaceId: 7,
        inNodeGroupId: 10,
        outNodeGroupId: 10,
      },
      deps(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_input");
  });

  test("B5. 创建 RELAY 名字为空/超长 → 400", async () => {
    const base = {
      mode: "relay" as const,
      userId: 1,
      workspaceId: 7,
      personalWorkspaceId: 7,
      inNodeGroupId: 10,
      outNodeGroupId: 20,
    };
    expect((await createTunnel({ ...base, name: "" }, deps())).ok).toBe(false);
    expect((await createTunnel({ ...base, name: "x".repeat(61) }, deps())).ok).toBe(false);
  });

  test("B6. 读：列表按 workspace 隔离 + 状态/模式过滤", async () => {
    seedTunnel({ id: 101, apply_status: "active", tunnel_mode: "relay" });
    seedTunnel({ id: 102, apply_status: "error", tunnel_mode: "relay" });
    seedTunnel({ id: 103, apply_status: "suspended", tunnel_mode: "direct" });
    seedTunnel({ id: 104, workspace_id: 9, apply_status: "active" });

    const all = await listTunnels({ workspaceId: 7 }, deps());
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.items.map((t) => t.id)).toEqual([103, 102, 101]);
    expect(all.total).toBe(3);

    const errs = await listTunnels({ workspaceId: 7, applyStatus: "error" }, deps());
    if (!errs.ok) return;
    expect(errs.items.map((t) => t.id)).toEqual([102]);

    const direct = await listTunnels({ workspaceId: 7, tunnelMode: "direct" }, deps());
    if (!direct.ok) return;
    expect(direct.items.map((t) => t.id)).toEqual([103]);
  });

  test("B7. 读：详情含 revision 对齐信息；越权 workspace 一律 404", async () => {
    const t = seedTunnel({ id: 105, config_revision: 5, applied_revision: 3 });
    const own = await getTunnelState(105, 7, deps());
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    expect(own.tunnel.id).toBe(105);
    expect(own.tunnel.config_revision).toBe(5);
    expect(own.tunnel.applied_revision).toBe(3);
    // applied < config ⇒ 待下发（前端据此显示「同步中」）。
    expect(own.tunnel.applied_revision < own.tunnel.config_revision).toBe(true);
    void t;

    // 别的 workspace：404 而不是 403 —— 不泄漏「这个 ID 存在」。
    const other = await getTunnelState(105, 9, deps());
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.code).toBe("not_found");
  });

  test("B8. 更新：改名 / 改端口（含占用冲突）", async () => {
    seedTunnel({ id: 106, listen_port: 20001 });
    seedTunnel({ id: 107, listen_port: 20002 });
    const renamed = await updateTunnel(106, { name: "new-name" }, 7, deps());
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(renamed.tunnel.name).toBe("new-name");

    const ported = await updateTunnel(106, { listenPort: 20003 }, 7, deps());
    expect(ported.ok).toBe(true);

    // 撞已有端口 → 409
    const clash = await updateTunnel(106, { listenPort: 20002 }, 7, deps());
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.code).toBe("conflict");
  });

  test("B9. 更新：RELAY 不能清空出口组；切模式必须带出口组", async () => {
    seedTunnel({ id: 108, out_node_group_id: 20, tunnel_mode: "relay" });
    const cleared = await updateTunnel(108, { outNodeGroupId: null }, 7, deps());
    expect(cleared.ok).toBe(false);
    if (cleared.ok) return;
    expect(cleared.code).toBe("invalid_input");

    const sw = await updateTunnel(108, { mode: "relay", outNodeGroupId: undefined }, 7, deps());
    expect(sw.ok).toBe(true); // 本来就是 relay，无变化
  });

  test("B10. 更新：转发目标格式错 → 400", async () => {
    seedTunnel({ id: 109 });
    const bad = await updateTunnel(109, { forwardAddresses: ["not-a-host-port"] }, 7, deps());
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.code).toBe("invalid_input");
    const empty = await updateTunnel(109, { forwardAddresses: [] }, 7, deps());
    expect(empty.ok).toBe(false);
  });

  test("B11. 更新：目标池必须存在", async () => {
    seedTunnel({ id: 110 });
    const missing = await updateTunnel(110, { egressPoolId: 12345 }, 7, deps());
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.code).toBe("not_found");
    const ok = await updateTunnel(110, { egressPoolId: 99 }, 7, deps());
    expect(ok.ok).toBe(true);
  });
});

/* ================================================================== */
/* C. 运行操作统一走 orchestrator（§7.13 铁律）                          */
/* ================================================================== */

describe("C. 运行操作统一走 orchestrator", () => {
  test("C1. retry：仅 error 可重试，且走 reapply（同一 tunnelId，不新建行）", async () => {
    const t = seedTunnel({
      id: 200,
      apply_status: "error",
      apply_error_code: "ingress_apply_rejected",
      apply_error: "boom",
      config_revision: 3,
    });
    const before = tunnels.size;
    const r = await runTunnelAction(200, "retry", 7, deps({ applyReapply: successReapply() }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action).toBe("retry");
    const reapplies = orchestratorCalls.filter((c) => c.kind === "reapply");
    expect(reapplies).toHaveLength(1);
    expect(reapplies[0]!.tunnelId).toBe(200);
    // 绝不新建行、绝不物理删除后重建（§4.1）
    expect(tunnels.size).toBe(before);
    expect(t.id).toBe(200);
    expect(t.apply_status).toBe("active");
    // revision 前进（同 revision 会被 Agent 判 stale）
    expect(t.config_revision).toBe(4);
    expect(t.applied_revision).toBe(4);
    expect(t.apply_error).toBeNull();
  });

  test("C2. retry 非 error 态 → 409 且不调编排器", async () => {
    seedTunnel({ id: 201, apply_status: "active" });
    const r = await runTunnelAction(201, "retry", 7, deps({ applyReapply: successReapply() }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_state");
    expect(orchestratorCalls.filter((c) => c.kind === "reapply")).toHaveLength(0);
  });

  test("C3. resume：suspended → active，走 reapply", async () => {
    const t = seedTunnel({ id: 202, apply_status: "suspended", desired_status: "inactive" });
    const r = await runTunnelAction(202, "resume", 7, deps({ applyReapply: successReapply() }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(t.apply_status).toBe("active");
    expect(t.desired_status).toBe("active");
    expect(orchestratorCalls.some((c) => c.kind === "reapply" && c.tunnelId === 202)).toBe(true);
  });

  test("C4. suspend：desired→inactive、apply_status→suspended，不调编排器（只标记期望）", async () => {
    const t = seedTunnel({ id: 203, apply_status: "active", desired_status: "active" });
    const r = await runTunnelAction(203, "suspend", 7, deps({ applyReapply: successReapply() }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(t.desired_status).toBe("inactive");
    expect(t.apply_status).toBe("suspended");
    expect(orchestratorCalls).toHaveLength(0);
  });

  test("C5. suspend 幂等：已 suspended → 409", async () => {
    seedTunnel({ id: 204, apply_status: "suspended" });
    const r = await runTunnelAction(204, "suspend", 7, deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("invalid_state");
    expect(r.message).toContain("已处于");
  });

  test("C6. delete：两端各撤一次（revision+1）后才删行", async () => {
    seedTunnel({ id: 205, config_revision: 7, egress_node_id: 2, in_node_group_id: 10 });
    const r = await runTunnelAction(205, "delete", 7, deps());
    expect(r.ok).toBe(true);
    expect(tunnels.has(205)).toBe(false);
    const removes = orchestratorCalls.filter((c) => c.kind === "remove");
    // 入口 + 出口两端都要撤（单撤一端会留下一个继续收流量的 listener）。
    expect(removes).toHaveLength(2);
    // 补偿 revision = config_revision + 1（同值会被 Agent 判 stale 撤不掉）。
    for (const rm of removes) expect(rm.revision).toBe(8);
  });

  test("C7. delete：编排器不可用也允许删（补偿失败不阻断显式用户动作）", async () => {
    seedTunnel({ id: 206 });
    const r = await runTunnelAction(206, "delete", 7, deps({ orchestrator: null }));
    expect(r.ok).toBe(true);
    expect(tunnels.has(206)).toBe(false);
  });

  test("C8. delete：越权 workspace → 404，行还在", async () => {
    seedTunnel({ id: 207 });
    const r = await runTunnelAction(207, "delete", 9, deps());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
    expect(tunnels.has(207)).toBe(true);
    expect(orchestratorCalls).toHaveLength(0);
  });

  test("C9. 越权：retry/resume 别的 workspace → 404 不泄漏存在性", async () => {
    seedTunnel({ id: 208, apply_status: "error" });
    const r = await runTunnelAction(208, "retry", 9, deps({ applyReapply: successReapply() }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
    expect(orchestratorCalls).toHaveLength(0);
  });
});

/* ================================================================== */
/* D. 失败保留 Tunnel（§4.1）                                            */
/* ================================================================== */

describe("D. 失败保留 Tunnel", () => {
  test("D1. 编排失败：apply_status=error + 结构化错误，行绝不删除", async () => {
    agentHealthy = false;
    const r = await createTunnel(
      {
        name: "relay-fail",
        mode: "relay",
        userId: 1,
        workspaceId: 7,
        personalWorkspaceId: 7,
        inNodeGroupId: 10,
        outNodeGroupId: 20,
      },
      deps({ applyCreate: successCreate() }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("apply_failed");
    expect(r.apply_error_code).toBe("ingress_apply_rejected");
    // 行还在、挂着 error 与原因（前端展示 + 允许重试）
    const rows = [...tunnels.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.apply_status).toBe("error");
    expect(rows[0]!.apply_error_code).toBe("ingress_apply_rejected");
    expect(rows[0]!.apply_error).toContain("ingress_apply_rejected");
  });

  test("D2. retry 再次失败：仍在 error 且可再重试（轮次无限但都有记录）", async () => {
    const t = seedTunnel({ id: 210, apply_status: "error", config_revision: 1 });
    agentHealthy = false;
    const r = await runTunnelAction(210, "retry", 7, deps({ applyReapply: successReapply() }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("apply_failed");
    expect(t.apply_status).toBe("error");
    expect(t.config_revision).toBe(2); // revision 已前进（失败也前进，重试不会被 stale 挡）
    // 失败后依然满足 retry 的前置条件（可再试）
    expect(canRunAction("retry", t).ok).toBe(true);
  });

  test("D3. 无 orchestrator：RELAY 停在 pending，不回假 active", async () => {
    const r = await createTunnel(
      {
        name: "no-orch",
        mode: "relay",
        userId: 1,
        workspaceId: 7,
        personalWorkspaceId: 7,
        inNodeGroupId: 10,
        outNodeGroupId: 20,
      },
      deps({ orchestrator: null, applyCreate: successCreate() }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 未接线：不假装成功。revision 0 + pending（由 create 结果带出）。
    expect(r.mode).toBe("relay");
    if (r.mode !== "relay") return;
    expect(r.revision).toBe(0);
    const row = tunnels.get(r.tunnelId)!;
    expect(row.apply_status).toBe("pending");
    expect(row.apply_status).not.toBe("active");
    // 没有调用任何编排入口（没接线就不调用）
    expect(orchestratorCalls).toHaveLength(0);
  });
});

/* ================================================================== */
/* E. 结构约束：WP11 不得有第二套下发逻辑                                */
/* ================================================================== */

describe("E. 结构约束", () => {
  test("E1. 路由源码不含任何下发原语", async () => {
    // §7.13「禁止 route 自己写第二套下发逻辑」。这是静态断言：本服务层
    // 不得出现 createCommand / dispatchEgress / dispatchIngress /
    // transport 调用 / listen。真下发只允许在 WP8 orchestrator.ts。
    const src = await Bun.file(
      new URL("../tunnel-api.ts", import.meta.url).pathname,
    ).text();
    for (const forbidden of [
      "createCommand(",
      "dispatchEgress(",
      "dispatchIngress(",
      "new HttpAgentTransport",
      "HttpAgentTransport(",
      ".listen(",
      "new ControlValidator",
    ]) {
      expect(src.includes(forbidden)).toBe(false);
    }
    // 也不得 import socket 侧（legacy config-pusher 的领地）
    expect(src.includes("config-pusher")).toBe(false);
    expect(src.includes("pushNodeConfig")).toBe(false);
  });

  test("E2. 服务层唯一的下发出口是 scheduler 的两个编排入口", async () => {
    const src = await Bun.file(
      new URL("../tunnel-api.ts", import.meta.url).pathname,
    ).text();
    // createRelayTunnel（创建）与 reapplyRelayTunnel（重入）是唯二被引用的编排函数。
    expect(src.includes("createRelayTunnel")).toBe(true);
    expect(src.includes("reapplyRelayTunnel")).toBe(true);
    // 且都通过 resolveDeps 的注入点调用，测试才换得掉。
    expect(src.includes("deps.applyCreate(")).toBe(true);
    expect(src.includes("deps.applyReapply(")).toBe(true);
  });
});
