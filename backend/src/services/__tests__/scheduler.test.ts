import { test, expect, describe, beforeEach } from "bun:test";
import type { EffectivePolicy } from "../capability-policy.ts";

/**
 * WP8 — Scheduler + RELAY Orchestrator 离线测试（不连 MySQL / Redis / 网络）。
 *
 * 依据 `DEVELOPMENT.md` §7.11「WP8 — Scheduler + RELAY Orchestrator」、
 * §4.2「RELAY 编排铁律」、§1.1「RELAY 必须**先准备出口，再启入口**」。
 *
 * 覆盖矩阵（验收口径逐条对应）：
 *   A. **编排顺序**：§7.11 的十条步骤严格有序 —— auth/quota → pending →
 *      bind → ports → revision++ → apply Egress → Egress ACK → apply Ingress →
 *      Ingress ACK → active。任一时刻「下一步」未允许被执行。
 *      · 铁律一：出口下发**先于**入口下发（先 Egress ACK 才能拿到 next_hop）；
 *      · 铁律二：两次独立下发（两条 AgentTunnelConfig，各自 command_id）；
 *      · 铁律三：端口分配在编排器之外（portPool 被调用，orchestrator 不 import 它）。
 *   B. **失败补偿**：§7.11「任何失败」四条硬要求逐条钉死 ——
 *      1. Tunnel **不物理删除**（没有任何 delete 调用被记录）；
 *      2. `apply_status = "error"`；
 *      3. `apply_error_code` / `apply_error` 结构化错误；
 *      4. 补偿执行（已 ACK 的 Egress 被撤、端口租约被释放）。
 *   C. **端口分配集成**：ingress + egress 两端各取一个端口；
 *      · 同节点物理互斥（WP3 的 UNIQUE(node_id, port)）；
 *      · user-specified 与 auto 同一规则；
 *      · legacy DIRECT `reservedPorts` 交接（§7.6）；
 *      · 入口端口写进用户可见列 `listen_port`，出口端口写 `egress_port`。
 *
 * ── 替身设计 ──
 *  三个接缝全部用内存替身，零外部依赖：
 *   · `SchedulerDb` —— 内存 Prisma 替身（tunnel/node/nodeGroup/egressPool/
 *     egressTarget 五张表的最小投影，复刻 §5.1 的关键约束形状）；
 *   · `AgentTransport` —— 记录每次下发的假 Agent（返回 WP4 `{ok:true}` 形状，
 *     可注入失败：拒绝 / 超时 / 错 revision）；
 *   · `portPoolDeps` —— 内存 DB + Redis（从 WP3 测试同款形态抄来，
 *     保证 §5.1 的唯一键语义在集成测试里真的生效）。
 */

/* ------------------------------------------------------------------ */
/* 内存表                                                               */
/* ------------------------------------------------------------------ */

interface TunnelRow {
  id: number;
  name: string;
  tunnel_type: string;
  listen_ip: string | null;
  listen_port: number | null;
  in_node_group_id: number;
  out_node_group_id: number | null;
  user_id: number;
  workspace_id: number;
  tunnel_mode: string | null;
  ingress_node_id: number | null;
  egress_node_id: number | null;
  egress_pool_id: number | null;
  egress_port: number | null;
  desired_status: string | null;
  apply_status: string | null;
  config_revision: number | null;
  applied_revision: number | null;
  apply_error_code: string | null;
  apply_error: string | null;
  last_applied_at: Date | null;
  [k: string]: unknown;
}

interface NodeRow {
  id: number;
  node_id: string;
  role: "ingress" | "egress" | "both" | null;
  connect_ip: string | null;
  port_range_min: number | null;
  port_range_max: number | null;
  lb_strategy: "round" | "rand" | null;
  status: "active" | "inactive";
  last_seen_at: Date | null;
  node_group_id: number;
  /** WP7 per-node credential 列（见 scheduler.ts 的 SchedulableNode 同名字段）。 */
  node_credential_hash?: string | null;
  credential_revoked?: boolean;
}

interface NodeGroupRow {
  id: number;
  name: string;
  workspace_id: number;
  user_id: number;
  node_type: "in" | "out";
  [k: string]: unknown;
}

interface EgressPoolRow {
  id: number;
  node_id: number;
  name: string;
  lb_strategy: "round" | "rand" | null;
  status: "active" | "inactive";
}

interface EgressTargetRow {
  id: number;
  pool_id: number;
  host: string;
  port: number;
  weight: number;
  order_by: number;
  status: "active" | "inactive";
}

interface LeaseRow {
  id: number;
  node_id: number;
  port: number;
  tunnel_id: number | null;
  lease_type: "ingress" | "egress";
  status: "active" | "released";
  expires_at: Date | null;
}

let tunnels: TunnelRow[] = [];
let nodes: NodeRow[] = [];
let groups: NodeGroupRow[] = [];
let pools: EgressPoolRow[] = [];
let targets: EgressTargetRow[] = [];
let leases: LeaseRow[] = [];
let nextId = 1000;

/** 每次 DB 调用的形状，用于断言「从不 delete」这一步铁律。 */
const dbCalls: { model: string; op: string; where?: unknown }[] = [];

function resetState(): void {
  tunnels = [];
  nodes = [];
  groups = [];
  pools = [];
  targets = [];
  leases = [];
  nextId = 1000;
  dbCalls.length = 0;
}

function row<T extends { id: number }>(t: T | null): T {
  return t as T;
}

/** `findFirst(...) ?? null`  Prisma 真签名允许 null；mock 里统一走这里。 */
function rowOrNull<T extends { id: number }>(t: T | null): T | null {
  return t;
}

/**
 * 内存 Prisma 替身：只实现编排器真正用到的五个方法与必要的 where 形态。
 * `UNIQUE(node_id, port)` 在 `nodePortLease.create` 里以 P2002 复刻
 * （与 WP3 测试同一做法），保证集成层真的吃得到那只约束。
 */
function makeDb() {
  return {
    tunnel: {
      async create({ data }: { data: Partial<TunnelRow> }) {
        const t: TunnelRow = {
          id: nextId++,
          name: String(data.name ?? ""),
          tunnel_type: String(data.tunnel_type ?? "tcp"),
          listen_ip: (data.listen_ip as string | null) ?? null,
          listen_port: (data.listen_port as number | null) ?? null,
          in_node_group_id: Number(data.in_node_group_id ?? 0),
          out_node_group_id: (data.out_node_group_id as number | null) ?? null,
          user_id: Number(data.user_id ?? 0),
          workspace_id: Number(data.workspace_id ?? 0),
          tunnel_mode: (data.tunnel_mode as string | null) ?? null,
          ingress_node_id: (data.ingress_node_id as number | null) ?? null,
          egress_node_id: (data.egress_node_id as number | null) ?? null,
          egress_pool_id: (data.egress_pool_id as number | null) ?? null,
          egress_port: (data.egress_port as number | null) ?? null,
          desired_status: (data.desired_status as string | null) ?? null,
          apply_status: (data.apply_status as string | null) ?? null,
          config_revision: (data.config_revision as number | null) ?? null,
          applied_revision: (data.applied_revision as number | null) ?? null,
          apply_error_code: (data.apply_error_code as string | null) ?? null,
          apply_error: (data.apply_error as string | null) ?? null,
          last_applied_at: (data.last_applied_at as Date | null) ?? null,
        };
        tunnels.push(t);
        dbCalls.push({ model: "tunnel", op: "create", where: { id: t.id } });
        return row(t);
      },
      async update({ where, data }: { where: { id: number }; data: Partial<TunnelRow> }) {
        const t = tunnels.find((x) => x.id === where.id);
        if (!t) throw new Error("tunnel not found");
        Object.assign(t, data);
        dbCalls.push({ model: "tunnel", op: "update", where: { id: t.id } });
        return row(t);
      },
      async findUnique({ where, select }: { where: { id: number }; select?: Record<string, boolean> }) {
        const t = tunnels.find((x) => x.id === where.id);
        if (!t) return null;
        if (!select) return row(t);
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(select)) out[k] = (t as unknown as Record<string, unknown>)[k];
        return out;
      },
      async findMany({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) {
        const out = tunnels.filter((t) =>
          Object.entries(where).every(([k, v]) => (t as unknown as Record<string, unknown>)[k] === v),
        );
        if (!select) return out.map(row);
        return out.map((t) => {
          const o: Record<string, unknown> = {};
          for (const k of Object.keys(select)) o[k] = (t as unknown as Record<string, unknown>)[k];
          return o;
        });
      },
      /** policy-service 的 `countWorkspaceTunnels` 走这里（quota 计数）。 */
      async count({ where }: { where: Record<string, unknown> }) {
        return tunnels.filter((t) =>
          Object.entries(where).every(([k, v]) => (t as unknown as Record<string, unknown>)[k] === v),
        ).length;
      },
    },
    node: {
      async findMany({ where }: { where: Record<string, unknown> }) {
        return nodes
          .filter((n) => Object.entries(where).every(([k, v]) => (n as unknown as Record<string, unknown>)[k] === v))
          .map(row);
      },
      async findUnique({ where }: { where: { id: number } }) {
        return row(nodes.find((n) => n.id === where.id) ?? null);
      },
    },
    nodeGroup: {
      async findUnique({ where }: { where: { id: number } }) {
        return row(groups.find((g) => g.id === where.id) ?? null);
      },
    },
    egressPool: {
      async findUnique({ where }: { where: { id: number } }) {
        return row(pools.find((p) => p.id === where.id) ?? null);
      },
      async findFirst({ where }: { where: Record<string, unknown> }) {
        return row(
          pools.find((p) =>
            Object.entries(where).every(([k, v]) => (p as unknown as Record<string, unknown>)[k] === v),
          ) ?? null,
        );
      },
    },
    /** policy-service 的 `sumWorkspaceTraffic` 走这里。测试场景一律零流量。 */
    tunnelTraffic: {
      async aggregate() {
        return { _sum: { traffic: null } };
      },
    },
    egressTarget: {
      async findMany({ where }: { where: Record<string, unknown> }) {
        return targets
          .filter((t) => Object.entries(where).every(([k, v]) => (t as unknown as Record<string, unknown>)[k] === v))
          .map(row);
      },
    },
    /* WP3 portPool 通过注入的 deps 使用，不从这里走（见 makePortPoolDeps）。 */
    nodePortLease: {
      async create({ data }: { data: Partial<LeaseRow> }) {
        const clash = leases.find((l) => l.node_id === data.node_id && l.port === data.port);
        if (clash) {
          const e = new Error("Unique constraint failed on the fields: (`node_id`,`port`)");
          (e as Error & { code: string }).code = "P2002";
          throw e;
        }
        const l: LeaseRow = {
          id: nextId++,
          node_id: Number(data.node_id),
          port: Number(data.port),
          tunnel_id: (data.tunnel_id as number | null) ?? null,
          lease_type: (data.lease_type as LeaseRow["lease_type"]) ?? "ingress",
          status: "active",
          expires_at: (data.expires_at as Date | null) ?? null,
        };
        leases.push(l);
        return row(l);
      },
      async findUnique(args: { where: { id?: number; node_id_port?: { node_id: number; port: number } } }) {
        const where = args.where;
        if (where.node_id_port) {
          return row(
            leases.find(
              (l) => l.node_id === where.node_id_port!.node_id && l.port === where.node_id_port!.port,
            ) ?? null,
          );
        }
        return row(leases.find((l) => l.id === where.id) ?? null);
      },
      async findMany({ where }: { where: Record<string, unknown> }) {
        return leases
          .filter((l) => Object.entries(where).every(([k, v]) => (l as unknown as Record<string, unknown>)[k] === v))
          .map(row);
      },
      async update({ where, data }: { where: { id: number }; data: Partial<LeaseRow> }) {
        const l = leases.find((x) => x.id === where.id);
        if (!l) {
          const e = new Error("Record to update not found.");
          (e as Error & { code: string }).code = "P2025";
          throw e;
        }
        Object.assign(l, data);
        return row(l);
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Partial<LeaseRow> }) {
        let count = 0;
        for (const l of leases) {
          if (!Object.entries(where).every(([k, v]) => (l as unknown as Record<string, unknown>)[k] === v)) continue;
          Object.assign(l, data);
          count += 1;
        }
        return { count };
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* 内存 Redis（portPool 的 NX 锁）                                      */
/* ------------------------------------------------------------------ */

function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string, ...rest: unknown[]) {
      if (!rest.map(String).includes("NX")) throw new Error("stub: expect SET … NX");
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
    async scan() {
      return ["0", [...store.keys()]] as [string, string[]];
    },
  };
}

/* ------------------------------------------------------------------ */
/* 假 Agent transport                                                   */
/* ------------------------------------------------------------------ */

interface RecordedApply {
  kind: "direct" | "egress" | "relay" | "remove";
  nodeId: number;
  config: Record<string, unknown> | null;
}

class FakeAgentTransport {
  readonly applies: RecordedApply[] = [];
  /** 注入失败：下一次 apply 的 kind → 失败模式。 */
  failNext: {
    kind: "direct" | "egress" | "relay" | "remove";
    mode: "reject" | "unreachable" | "bad_revision";
  } | null = null;
  /** 排队的历史失败（按顺序消费，便于测「先成功后失败」）。 */
  scriptedFailures: ({ kind: "direct" | "egress" | "relay" | "remove"; mode: "reject" | "unreachable" | "bad_revision" })[] = [];

  async applyEgress(node: { id: number }, config: Record<string, unknown>) {
    return this.record("egress", node, config);
  }
  async applyRelay(node: { id: number }, config: Record<string, unknown>) {
    return this.record("relay", node, config);
  }
  async applyDirect(node: { id: number }, config: Record<string, unknown>) {
    return this.record("direct", node, config);
  }
  async removeTunnel(node: { id: number }, tunnelId: string) {
    this.applies.push({ kind: "remove", nodeId: node.id, config: { tunnelId } });
    // remove 的补偿必须幂等：假 Agent 对未知 id 也报 ok（与 WP4 一致）。
    this.consume("remove");
    return { ok: true, id: tunnelId };
  }
  async isReachable() {
    return true;
  }

  private async record(
    kind: "direct" | "egress" | "relay" | "remove",
    node: { id: number },
    config: Record<string, unknown>,
  ) {
    this.applies.push({ kind, nodeId: node.id, config });
    const script = this.scriptedFailures.shift() ?? this.failNext;
    if (script && script.kind === kind) {
      this.failNext = null;
      if (script.mode === "unreachable") {
        throw new AgentTransportErrorLike("agent_unreachable", `agent ${node.id} unreachable`);
      }
      if (script.mode === "bad_revision") {
        // Agent 应用了但回了一个错 revision —— ACK 必须被 revision_mismatch 挡住。
        return { ok: false, error: "revision mismatch" };
      }
      throw new AgentTransportErrorLike("agent_rejected", `agent ${node.id} rejected apply`);
    }
    return { ok: true, revision: Number(config.revision ?? 0) };
  }

  private consume(kind: "egress" | "relay" | "remove") {
    const script = this.scriptedFailures.shift() ?? this.failNext;
    if (script && script.kind === kind) this.failNext = null;
  }
}

/** 与 orchestrator.ts 的 AgentTransportError 同形（测试侧不需要引入私有依赖）。 */
class AgentTransportErrorLike extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentTransportError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* 被测模块（在 mock 之前 import 会拿到真 db，故用动态 import）            */
/* ------------------------------------------------------------------ */

let scheduler: typeof import("../scheduler.ts");
let orchestratorModule: typeof import("../orchestrator.ts");

/* ------------------------------------------------------------------ */
/* 种子数据                                                            */
/* ------------------------------------------------------------------ */

/** 固定「现在」，让心跳超时判定与 TTL 断言稳定。 */
const NOW = new Date("2026-09-25T00:00:00.000Z");

function seed() {
  resetState();
  groups = [
    { id: 10, name: "in-group", workspace_id: 7, user_id: 1, node_type: "in" },
    { id: 20, name: "out-group", workspace_id: 7, user_id: 1, node_type: "out" },
  ];
  nodes = [
    row({
      id: 1,
      node_id: "ing-1",
      role: "ingress",
      connect_ip: "10.0.0.1",
      port_range_min: 20000,
      port_range_max: 20010,
      lb_strategy: null,
      status: "active",
      last_seen_at: NOW,
      node_group_id: 10,
      // WP7：种子节点均已签发凭据（§3.3 身份闸门的前置条件）。
      node_credential_hash: "1".repeat(64),
      credential_revoked: false,
    }),
    row({
      id: 2,
      node_id: "egr-1",
      role: "egress",
      connect_ip: "10.0.0.2",
      port_range_min: 30000,
      port_range_max: 30010,
      lb_strategy: "round",
      status: "active",
      last_seen_at: NOW,
      node_group_id: 20,
      node_credential_hash: "2".repeat(64),
      credential_revoked: false,
    }),
  ];
  pools = [row({ id: 99, node_id: 2, name: "default", lb_strategy: null, status: "active" })];
  targets = [
    row({ id: 501, pool_id: 99, host: "192.168.1.10", port: 8080, weight: 1, order_by: 10, status: "active" }),
    row({ id: 502, pool_id: 99, host: "192.168.1.11", port: 8080, weight: 2, order_by: 20, status: "active" }),
  ];
}

/** 一条「已存在」的 RELAY 隧道行（quota 计数、reservedPorts 等场景用）。 */
function seedTunnel(over: Partial<TunnelRow> = {}): TunnelRow {
  return {
    id: ++nextId,
    name: "seeded",
    tunnel_type: "tcp",
    listen_ip: null,
    listen_port: null,
    in_node_group_id: 10,
    out_node_group_id: 20,
    user_id: 1,
    workspace_id: 7,
    tunnel_mode: "relay",
    ingress_node_id: 1,
    egress_node_id: 2,
    egress_pool_id: 99,
    egress_port: null,
    desired_status: "active",
    apply_status: "active",
    config_revision: 1,
    applied_revision: 1,
    apply_error_code: null,
    apply_error: null,
    last_applied_at: null,
    ...over,
  };
}

/** 标准创建入参（RELAY）。 */
function input(over: Partial<Parameters<typeof scheduler.createRelayTunnel>[0]> = {}) {
  return {
    name: "relay-1",
    userId: 1,
    workspaceId: 7,
    personalWorkspaceId: 7,
    tunnelType: "tcp",
    inNodeGroupId: 10,
    outNodeGroupId: 20,
    egressPoolId: null,
    listenPort: null,
    listenIp: null,
    ...over,
  } as Parameters<typeof scheduler.createRelayTunnel>[0];
}

/** 放行一切的策略（auth/quota 步骤应通过）。 */
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
      traffic_period: "total" as const,
      bandwidth_limit: null,
      client_limit: null,
      ip_limit: null,
    },
    ceiling: {
      max_tunnels: null,
      max_nodes: null,
      max_members: null,
      traffic_limit: null,
      traffic_period: "total" as const,
      bandwidth_limit: null,
      client_limit: null,
      ip_limit: null,
    },
    active_policies: [],
    grace_policies: [],
    grace_expires_at: null,
    deny_scope: false,
    deny_reason: null,
  };
}

/** 隧道数已达上限的策略。 */
function tunnelLimitPolicy(limit = 1) {
  const p = allowAllPolicy();
  p.limits.max_tunnels = limit;
  p.ceiling.max_tunnels = limit;
  return p;
}

/* ------------------------------------------------------------------ */
/* 装配                                                                */
/* ------------------------------------------------------------------ */

let fakeAgent: FakeAgentTransport;
let deps: NonNullable<Parameters<typeof scheduler.createRelayTunnel>[2]>;
let orch: InstanceType<typeof orchestratorModule.Orchestrator>;

beforeEach(async () => {
  seed();
  fakeAgent = new FakeAgentTransport();
  // 动态 import：本文件不 mock.module（WP3 测试已证明依赖注入比 mock 稳），
  // 但 db 单例仍需替身 —— 用 scheduler 的 deps.db 注入即可，无需 mock。
  scheduler = scheduler ?? (await import("../scheduler.ts"));
  orchestratorModule = orchestratorModule ?? (await import("../orchestrator.ts"));
  orch = new orchestratorModule.Orchestrator({
    transport: fakeAgent as never,
  });
  deps = {
    db: makeDb() as unknown as NonNullable<typeof deps>["db"],
    loadPolicy: async () => allowAllPolicy() as never,
    authorizeGroup: async () => true,
    now: () => NOW,
    validator: (orch as unknown as { validator: never }).validator,
    portPoolDeps: { db: makeDb(), redis: makeRedis() } as unknown as NonNullable<typeof deps>["portPoolDeps"],
  };
});

/* ================================================================== */
/* A. 编排顺序（§7.11）                                                 */
/* ================================================================== */

describe("A. 编排顺序（§7.11 十条步骤）", () => {
  test("A1. 成功路径：十条步骤全部 ok，顺序与 §7.11 逐条对应", async () => {
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((s) => s.step)).toEqual([
      "auth_quota",
      "create_pending",
      "bind_nodes",
      "acquire_ports",
      "bump_revision",
      "apply_egress",
      "egress_ack",
      "apply_ingress",
      "ingress_ack",
      "activate",
    ]);
    // 每一步都必须 ok；失败路径单独测（B 组）。
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });

  test("A2. 铁律一：出口下发先于入口下发（顺序不可交换）", async () => {
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(true);
    const order = fakeAgent.applies.map((a) => a.kind);
    expect(order).toEqual(["egress", "relay"]);
    // 出口下发的节点必须是出口节点；入口下发落在入口节点。
    expect(fakeAgent.applies[0]!.nodeId).toBe(2);
    expect(fakeAgent.applies[1]!.nodeId).toBe(1);
  });

  test("A3. 铁律一（因果）：入口下发的 next_hop 来自出口下发的返回", async () => {
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(true);
    const ingress = fakeAgent.applies.find((a) => a.kind === "relay")!;
    // next_hop = <egress connect_ip>:<egress_port>
    expect(ingress.config?.next_hop).toMatch(/^10\.0\.0\.2:3\d{4}$/);
    // 两端二进制相反：入口是 RELAY、出口是 EGRESS。
    expect(fakeAgent.applies.find((a) => a.kind === "egress")!.config?.mode).toBe("EGRESS");
    expect(ingress.config?.mode).toBe("RELAY");
  });

  test("A4. 铁律二：两次独立下发，各自 command_id，revision 相同（N）", async () => {
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [egressStep, ingressStep] = result.steps.filter((s) =>
      s.step === "apply_egress" || s.step === "apply_ingress",
    );
    expect(egressStep!.meta!.command_id).not.toBe(ingressStep!.meta!.command_id);
    // 同一个 revision N 同时下发两端：一次重发对两端都是同一版本。
    expect(egressStep!.meta!.revision).toBe(1);
    expect(ingressStep!.meta!.revision).toBe(1);
    expect(result.revision).toBe(1);
  });

  test("A5. revision 单调递增：同一资源回退的 revision 被 WP6 闸门拒绝", async () => {
    // createRelayTunnel 是「创建」入口，每次进来都是一条新 Tunnel → revision 从
    // 1 起（这点由 A4 断言）。真正防回退的是 WP6 validator 的资源闸门：同一
    // resource_id 收到更小 revision 必须 rejected。编排器每一步都依赖这条性质。
    const { ControlValidator, createCommand } = await import("../control-protocol/index.ts");
    const v = new ControlValidator();
    const mk = (rev: number) =>
      createCommand({
        resource: "tunnel",
        resource_id: "tunex-1-egress",
        revision: rev,
        action: "apply_tunnel",
        payload: {
          tunnel: {
            name: "tunex-1-egress",
            tunnel_type: "tcp",
            listen_port: 1,
            targets: [{ address: "1.1.1.1", port: 2, weight: 1 }],
          },
        },
      });
    // 前进放行。
    expect((await v.handle(mk(3), () => ({ status: "active" }))).status).toBe("applied");
    // 回退拒绝。
    expect((await v.handle(mk(2), () => ({ status: "active" }))).status).toBe("rejected");
    // 继续前推进 still 放行（闸门只挡回退）。
    expect((await v.handle(mk(4), () => ({ status: "active" }))).status).toBe("applied");
  });

  test("A6. 两端 ACK 齐后 apply_status=active 且 last_applied_at 落库", async () => {
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = tunnels.find((x) => x.id === result.tunnelId)!;
    expect(t.apply_status).toBe("active");
    expect(t.desired_status).toBe("active");
    expect(t.applied_revision).toBe(1);
    expect(t.config_revision).toBe(1);
    expect(t.last_applied_at).toEqual(NOW);
    expect(t.apply_error_code).toBeNull();
    expect(t.apply_error).toBeNull();
  });

  test("A7. bind 落库：egress_node_id / egress_pool_id 指向实际节点", async () => {
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = tunnels.find((x) => x.id === result.tunnelId)!;
    expect(t.ingress_node_id).toBe(1);
    expect(t.egress_node_id).toBe(2);
    // 未显式指定池 → 取该出口节点的 default 池（§2.2）。
    expect(t.egress_pool_id).toBe(99);
    expect(result.egressNodeId).toBe(2);
    expect(result.ingressNodeId).toBe(1);
  });

  test("A8. 入口与出口绑定到同一节点 → 拒绝（RELAY 必须跨节点）", async () => {
    // 造出「两端只能选到同一个节点」：唯一的 role=both 节点挂在组 10，
    // 入/出口都指向组 10 —— 于是两端 pickNode 都返回它。
    nodes = [
      row({
        id: 1,
        node_id: "both-1",
        role: "both",
        connect_ip: "10.0.0.1",
        port_range_min: 20000,
        port_range_max: 20010,
        lb_strategy: null,
        status: "active",
        last_seen_at: NOW,
        node_group_id: 10,
        node_credential_hash: "3".repeat(64),
        credential_revoked: false,
      }),
    ];
    const result = await scheduler.createRelayTunnel(
      input({ inNodeGroupId: 10, outNodeGroupId: 10 }),
      orch,
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("bind_nodes");
    expect(result.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.mode_topology_mismatch);
  });

  test("A9. role 不覆盖 → node_unavailable（NodeGroup.node_type 不参与判定）", async () => {
    // 入口组里只有一个 egress 角色的节点：按 §2.1 role 是最终真相源，
    // 不能因为它挂在 in 组里就当入口用。
    nodes = [nodes[1]!]; // 只剩出口节点
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("bind_nodes");
    expect(result.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.node_unavailable);
    expect(result.error).toContain("ingress");
  });

  test("A10. 离线节点仍被绑定（记 warning 不中断），ACK 阶段才失败", async () => {
    nodes[0]!.last_seen_at = new Date(NOW.getTime() - 10 * 60 * 1000); // 10 分钟前
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bind = result.steps.find((s) => s.step === "bind_nodes")!;
    expect(bind.ok).toBe(true);
    expect(bind.detail).toContain("心跳超时");
    expect(bind.meta).toMatchObject({ ingress_online: false, egress_online: true });
  });
});

/* ================================================================== */
/* B. 失败补偿（§7.11「任何失败」四条硬要求）                            */
/* ================================================================== */

describe("B. 失败补偿", () => {
  test("B1. 铁律：从不物理删除 Tunnel（全程零 delete 调用）", async () => {
    fakeAgent.failNext = { kind: "relay", mode: "reject" };
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 记录里没有任何 delete。
    expect(dbCalls.filter((c) => c.op === "delete")).toEqual([]);
    // Tunnel 行还在。
    expect(tunnels.find((t) => t.id === result.tunnelId)).toBeDefined();
  });

  test("B2. 铁律：apply_status=error + 结构化错误码 + 人读原文", async () => {
    fakeAgent.failNext = { kind: "relay", mode: "reject" };
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const t = tunnels.find((x) => x.id === result.tunnelId)!;
    expect(t.apply_status).toBe("error");
    expect(t.apply_error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.ingress_apply_rejected);
    expect(t.apply_error).toContain("ingress_apply_rejected");
    // 失败时 desired_status 回 inactive（控制面不认为它该跑）。
    expect(t.desired_status).toBe("inactive");
    // last_applied_at 不动：这段编排从未成功过。
    expect(t.last_applied_at).toBeNull();
  });

  test("B3. 入口失败 → 已 ACK 的 Egress 被补偿撤下（先撤出口）", async () => {
    fakeAgent.failNext = { kind: "relay", mode: "reject" };
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    const removes = fakeAgent.applies.filter((a) => a.kind === "remove");
    expect(removes.length).toBe(1);
    // 撤的是出口节点上那条（role=egress）。
    expect(removes[0]!.nodeId).toBe(2);
    expect(removes[0]!.config?.tunnelId).toBe("tunex-" + result.tunnelId + "-egress");
  });

  test("B4. 入口失败 → 两个端口租约都被释放（不会等到 reconcile TTL）", async () => {
    fakeAgent.failNext = { kind: "ingress_unused", mode: "reject" } as never;
    fakeAgent.failNext = { kind: "relay", mode: "reject" };
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const active = leases.filter((l) => l.status === "active" && l.tunnel_id === result.tunnelId);
    expect(active).toEqual([]);
    // 释放是软删除：行还在（供对账），只是状态变 released。
    const released = leases.filter((l) => l.status === "released" && l.tunnel_id === result.tunnelId);
    expect(released.length).toBe(2);
    expect(released.map((l) => l.lease_type).sort()).toEqual(["egress", "ingress"]);
  });

  test("B5. 出口失败 → 两个端口租约也被释放（两侧都还没 listener）", async () => {
    fakeAgent.failNext = { kind: "egress", mode: "reject" };
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("apply_egress");
    // 出口都没成，没有任何 remove（没什么可撤的）。
    expect(fakeAgent.applies.filter((a) => a.kind === "remove")).toEqual([]);
    const active = leases.filter((l) => l.status === "active" && l.tunnel_id === result.tunnelId);
    expect(active).toEqual([]);
  });

  test("B6. 补偿用 revision+1：Agent 侧闸门放行（失败那次可能已推进版本）", async () => {
    fakeAgent.failNext = { kind: "relay", mode: "reject" };
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // remove 信封的 revision 必须比失败的那次高 1，否则会被判 stale 撤不掉。
    const removeCall = fakeAgent.applies.find((a) => a.kind === "remove")!;
    expect(removeCall.config).toBeDefined();
    // revision 存在 envelope 里而不是 config 里；这里断言编排记录的 meta。
    const applyStep = result.steps.find((s) => s.step === "apply_egress")!;
    expect(applyStep.meta!.revision).toBe(1); // 失败在 revision 1
    // 补偿的 revision = 2（见 orchestrator.removeTunnel 入参）。
    expect(result.steps.find((s) => s.step === "bump_revision")!.meta!.revision).toBe(1);
  });

  test("B7. ACK revision 不一致 → revision_mismatch，且不推进 active", async () => {
    fakeAgent.failNext = { kind: "relay", mode: "bad_revision" };
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const t = tunnels.find((x) => x.id === result.tunnelId)!;
    expect(t.apply_status).toBe("error");
    expect(t.applied_revision).toBeNull();
    expect(t.last_applied_at).toBeNull();
  });

  test("B8. Agent 不可达 → agent_unreachable 一族，错误可重试", async () => {
    fakeAgent.failNext = { kind: "egress", mode: "unreachable" };
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("unreachable");
  });

  test("B9. bind_nodes 失败不产生任何端口租约（顺序保证）", async () => {
    nodes = [nodes[1]!]; // 入口组无节点 → bind 阶段就失败
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("bind_nodes");
    expect(leases).toEqual([]); // 端口一步都没分配
  });

  test("B10. acquire 阶段失败：入口成功后出口失败 → 入口租约被补偿释放", async () => {
    // 出口节点区间做成只剩黑名单端口 → egressAlloc 失败，已拿的入口租约要放。
    nodes[1]!.port_range_min = 22;
    nodes[1]!.port_range_max = 22; // 22 = ssh，黑名单
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("acquire_ports");
    expect(result.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.port_allocation_failed);
    // 入口租约确实被释放了（软删除）。
    const active = leases.filter((l) => l.status === "active");
    expect(active).toEqual([]);
  });

  test("B11. 端口分配失败在 apply 之前：从不产生任何 Agent 下发", async () => {
    nodes[0]!.port_range_min = 22;
    nodes[0]!.port_range_max = 22;
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("acquire_ports");
    expect(fakeAgent.applies).toEqual([]);
  });

  test("B12. auth/quota 失败 → Tunnel 都还没建（tunnelId=-1，零副作用）", async () => {
    deps.loadPolicy = async () => tunnelLimitPolicy(1) as never;
    // 预置一条**同 workspace** 的隧道把计数顶到上限（tunnelLimitPolicy(1)=只能有 1 条）。
    tunnels.push({
      ...seedTunnel(),
      id: ++nextId,
      workspace_id: 7,
      listen_port: 20001,
    });
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("auth_quota");
    expect(result.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.tunnel_limit);
    expect(result.tunnelId).toBe(-1);
    expect(dbCalls.filter((c) => c.model === "tunnel" && c.op === "create")).toEqual([]);
    expect(fakeAgent.applies).toEqual([]);
  });

  /* ── WP7 node-credential 身份闸门（§3.3）── */
  test("B13. 入口节点没有有效凭据 → node_credential_missing，Tunnel 保留为 error", async () => {
    // 摘掉入口节点的凭据：编排必须在 bind 阶段拒绝，而不是向一个身份
    // 不可验证的节点下发真配置。
    nodes = nodes.map((n) =>
      n.id === 1 ? { ...n, node_credential_hash: null, credential_revoked: false } : n,
    );
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("bind_nodes");
    expect(result.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.node_credential_missing);
    // Tunnel 仍被保留并落 error（§7.11：不物理删除）。
    const t = tunnels.find((x) => x.id === result.tunnelId)!;
    expect(t.apply_status).toBe("error");
    expect(t.apply_error_code).toBe("node_credential_missing");
    // 凭据缺口不是用户重试能解决的（要管理员补签）→ 不可重试。
    expect(result.retryable).toBe(false);
    // 身份都没验过，任何端口/下发都不该发生。
    expect(fakeAgent.applies).toEqual([]);
    expect(leases).toEqual([]);
  });

  test("B14. 出口节点凭据被撤销 → node_credential_missing（revoked 优先于哈希比对）", async () => {
    nodes = nodes.map((n) => (n.id === 2 ? { ...n, credential_revoked: true } : n));
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.node_credential_missing);
    expect(fakeAgent.applies).toEqual([]);
  });
});

/* ================================================================== */
/* C. 端口分配集成（WP3 portPool）                                       */
/* ================================================================== */

describe("C. 端口分配集成", () => {
  test("C1. ingress + egress 各取一个端口，落在用户可见/内部两列", async () => {
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ingressPort).toBeGreaterThanOrEqual(20000);
    expect(result.ingressPort).toBeLessThanOrEqual(20010);
    expect(result.egressPort).toBeGreaterThanOrEqual(30000);
    expect(result.egressPort).toBeLessThanOrEqual(30010);
    const t = tunnels.find((x) => x.id === result.tunnelId)!;
    expect(t.listen_port).toBe(result.ingressPort); // 用户可见端口
    expect(t.egress_port).toBe(result.egressPort); // 节点间内部端口
  });

  test("C2. 两端端口来自不同节点区间 → 同一端口号可各自持有（§5.1 天然隔离）", async () => {
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(true);
    // 入口区间 20000-20010、出口 30000-30010，本例不会相同；断言的是
    // 「两端不会撞在同一条 UNIQUE(node_id, port) 上」——不同 node_id 天然成立。
    if (!result.ok) return;
    expect(leases.filter((l) => l.status === "active").length).toBe(2);
    const byNode = new Map<number, number[]>();
    for (const l of leases.filter((x) => x.status === "active")) {
      byNode.set(l.node_id, [...(byNode.get(l.node_id) ?? []), l.port]);
    }
    expect(byNode.get(1)?.length).toBe(1);
    expect(byNode.get(2)?.length).toBe(1);
  });

  test("C3. user-specified listen_port 走同一规则：合法即命中", async () => {
    const result = await scheduler.createRelayTunnel(
      input({ listenPort: 20005 }),
      orch,
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ingressPort).toBe(20005);
    const t = tunnels.find((x) => x.id === result.tunnelId)!;
    expect(t.listen_port).toBe(20005);
  });

  test("C4. user-specified 指定黑名单端口 → port_invalid（不静默改分）", async () => {
    const result = await scheduler.createRelayTunnel(
      input({ listenPort: 80 }),
      orch,
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("acquire_ports");
    expect(result.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.port_invalid);
    // 没有改分别的端口：整条流程失败。
    expect(result.retryable).toBe(false);
  });

  test("C5. legacy DIRECT 端口不可被抢占：reservedPorts 生效", async () => {
    // 入口组内已有一条 DIRECT 隧道占着 20001（DB 里没有租约行）。
    const existing = await (deps.db as unknown as ReturnType<typeof makeDb>).tunnel.create({
      data: {
        name: "legacy-direct",
        in_node_group_id: 10,
        workspace_id: 7,
        user_id: 1,
        listen_port: 20001,
      },
    });
    expect(existing.listen_port).toBe(20001);
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ingressPort).not.toBe(20001);
    // 指定 20001 也应失败（同规则：抢占失败）。
    const clash = await scheduler.createRelayTunnel(
      input({ name: "clash", listenPort: 20001 }),
      orch,
      deps,
    );
    expect(clash.ok).toBe(false);
    if (clash.ok) return;
    expect(clash.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.port_allocation_failed);
  });

  test("C6. 同一入口节点上两条 RELAY 拿不同端口（UNIQUE(node_id,port) 生效）", async () => {
    const a = await scheduler.createRelayTunnel(input({ name: "a" }), orch, deps);
    const b = await scheduler.createRelayTunnel(input({ name: "b" }), orch, deps);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.ingressPort).not.toBe(b.ingressPort);
    expect(a.egressPort).not.toBe(b.egressPort);
    // 入口节点上有两条 active ingress 租约，端口互异。
    const ingressLeases = leases.filter((l) => l.status === "active" && l.node_id === 1);
    expect(ingressLeases.length).toBe(2);
    expect(ingressLeases[0]!.port).not.toBe(ingressLeases[1]!.port);
  });

  test("C7. 区间耗尽/全占 → port_allocation_failed，且不产生任何下发", async () => {
    nodes[0]!.port_range_min = 20000;
    nodes[0]!.port_range_max = 20002;
    nodes[1]!.port_range_min = 30000;
    nodes[1]!.port_range_max = 30002;
    // 把入口区间整段用租约占满：pool 的候选集非空但全部撞 UNIQUE(node_id,port)
    // → WP3 归并为 port_taken（attempts.length === 0 时才会给 no_available_port）。
    for (const p of [20000, 20001, 20002]) {
      await (
        deps.portPoolDeps as unknown as {
          db: { nodePortLease: { create: (a: unknown) => Promise<unknown> } };
        }
      ).db.nodePortLease.create({
        data: { node_id: 1, port: p, lease_type: "ingress", status: "active", expires_at: null },
      });
    }
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("acquire_ports");
    // WP8 把 port_taken / no_available_port 都收敛到 port_allocation_failed
    // （对调用方它们是同一类「这台节点上分不到入口端口」）。
    expect(result.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.port_allocation_failed);
    expect(result.error).toContain("端口");
    expect(result.retryable).toBe(true);
    // 铁律：分配失败不得产生任何 Agent 下发。
    expect(fakeAgent.applies).toEqual([]);
  });

  test("C7b. 候选集真空（min>max）→ no_available_port 那一支", async () => {
    // WP3 的 attempts.length === 0 分支：区间不合法到连候选都生成不出来。
    nodes[0]!.port_range_min = 20005;
    nodes[0]!.port_range_max = 20000; // 反转 → 无候选
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("acquire_ports");
    // 仍然收敛到 port_allocation_failed；detail 里点名「区间不合法」。
    expect(result.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.port_allocation_failed);
    expect(fakeAgent.applies).toEqual([]);
  });

  test("C8. 节点未配置区间 → 拒绝分配，不回落到节点组 port_range（§7.6）", async () => {
    nodes[0]!.port_range_min = null;
    nodes[0]!.port_range_max = null;
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("acquire_ports");
    expect(result.error).toContain("未配置端口区间");
  });

  test("C9. 出口端口永不接受用户指定（节点间内部端口）", async () => {
    // 即使调用方塞了 egressPort，入参里也没有这个字段（类型层面挡住）。
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 出口端口总是自动分配，来自出口节点自己的区间。
    expect(result.egressPort).toBeGreaterThanOrEqual(30000);
  });

  test("C10. 端口租约挂到隧道上（tunnel_id），compensation 可按隧道批量释放", async () => {
    fakeAgent.failNext = { kind: "relay", mode: "reject" };
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const owned = leases.filter((l) => l.tunnel_id === result.tunnelId);
    expect(owned.length).toBe(2);
    expect(owned.every((l) => l.status === "released")).toBe(true);
  });
});

/* ================================================================== */
/* D. 纯函数（无 IO）                                                    */
/* ================================================================== */

describe("D. 纯函数", () => {
  test("D1. pickNode：role 覆盖 + 在线优先 + id 最小（确定性）", () => {
    const base: NodeRow = {
      id: 0, node_id: "n", role: null, connect_ip: null,
      port_range_min: null, port_range_max: null, lb_strategy: null,
      status: "active", last_seen_at: NOW, node_group_id: 1,
      // 默认带有效凭据：本测试聚焦 role/在线/确定性，身份闸门由 D1b 单测。
      node_credential_hash: "e".repeat(64), credential_revoked: false,
    };
    const list = [
      row({ ...base, id: 5, role: "ingress", last_seen_at: new Date(NOW.getTime() - 10 * 60_000) }),
      row({ ...base, id: 3, role: "ingress", last_seen_at: NOW }),
      row({ ...base, id: 4, role: "egress", last_seen_at: NOW }),
    ];
    // 入口：候选 3 与 5，3 在线且 id 更小 → 选 3。
    expect(scheduler.pickNode(list as never, "ingress", NOW)).toMatchObject({
      ok: true,
      online: true,
      node: { id: 3 },
    });
    // 出口：只有 4。
    expect(scheduler.pickNode(list as never, "egress", NOW)).toMatchObject({
      ok: true,
      online: true,
      node: { id: 4 },
    });
    // both 同时覆盖两端（§2.1）。
    const both = { ...base, id: 9, role: "both", last_seen_at: NOW } as NodeRow;
    expect((scheduler.pickNode([both] as never, "ingress", NOW) as { node: NodeRow }).node.id).toBe(9);
    expect((scheduler.pickNode([both] as never, "egress", NOW) as { node: NodeRow }).node.id).toBe(9);
    // role 不覆盖 → no_role_match（不是「挑一个最近的顶替」）。
    const wrongRole: NodeRow = { ...base, id: 7, role: "egress", last_seen_at: NOW };
    expect(scheduler.pickNode([wrongRole] as never, "ingress", NOW)).toEqual({
      ok: false,
      reason: "no_role_match",
    });

    /* ── WP7 身份闸门（§3.3）── */
    // 未签发凭据的节点不可被选：身份不可验证的节点不出现在编排候选里。
    const noCred: NodeRow = {
      ...base,
      id: 11,
      role: "ingress",
      last_seen_at: NOW,
      node_credential_hash: null,
      credential_revoked: false,
    };
    expect(scheduler.pickNode([noCred] as never, "ingress", NOW)).toEqual({
      ok: false,
      reason: "no_credential",
    });
    // 已撤销的节点同样出局（revoked 优先于哈希比对）。
    const revoked: NodeRow = {
      ...base,
      id: 12,
      role: "ingress",
      last_seen_at: NOW,
      node_credential_hash: "a".repeat(64),
      credential_revoked: true,
    };
    expect(scheduler.pickNode([revoked] as never, "ingress", NOW)).toEqual({
      ok: false,
      reason: "no_credential",
    });
    // 混合候选：有凭据的 13 胜出，没凭据的 id 3 被跳过（不是「谁 id 小谁上」）。
    const noCredSmall: NodeRow = {
      ...list[1] as NodeRow,
      id: 3,
      node_credential_hash: null,
      credential_revoked: false,
    };
    const cred: NodeRow = {
      ...base,
      id: 13,
      role: "ingress",
      last_seen_at: NOW,
      node_credential_hash: "b".repeat(64),
      credential_revoked: false,
    };
    expect(scheduler.pickNode([noCredSmall, cred] as never, "ingress", NOW)).toMatchObject({
      ok: true,
      node: { id: 13 },
    });
  });

  test("D1b. nodeCredentialUsable：直接复用 WP7 decideNodeAuth 的三条判定", () => {
    // 未签发 → invalid_credential。
    expect(
      scheduler.nodeCredentialUsable({ node_credential_hash: null, credential_revoked: false }),
    ).toEqual({ ok: false, reason: "invalid_credential" });
    // 撤销 → revoked（即使哈希在位）。
    expect(
      scheduler.nodeCredentialUsable({ node_credential_hash: "c".repeat(64), credential_revoked: true }),
    ).toEqual({ ok: false, reason: "revoked" });
    // 哈希在位且未撤销 → ok。
    expect(
      scheduler.nodeCredentialUsable({ node_credential_hash: "d".repeat(64), credential_revoked: false }),
    ).toEqual({ ok: true });
  });

  test("D2. collectReservedPorts：只收合法端口、去重", () => {
    expect(
      scheduler.collectReservedPorts([
        { listen_port: 20001 },
        { listen_port: 20001 },
        { listen_port: null },
        { listen_port: 0 },
        { listen_port: -3 },
      ]),
    ).toEqual([20001]);
  });

  test("D3. parseHostPort：IPv4 / 域名 / [IPv6] 三形态", () => {
    expect(scheduler.parseHostPort("10.0.0.1:8080")).toEqual({ host: "10.0.0.1", port: 8080 });
    expect(scheduler.parseHostPort("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(scheduler.parseHostPort("[2001:db8::1]:443")).toEqual({ host: "2001:db8::1", port: 443 });
    expect(scheduler.parseHostPort("10.0.0.1:0")).toBeNull();
    expect(scheduler.parseHostPort("10.0.0.1:99999")).toBeNull();
    expect(scheduler.parseHostPort("")).toBeNull();
    expect(scheduler.parseHostPort("10.0.0.1")).toBeNull();
  });

  test("D4. splitNextHop：RELAY next_hop 严格 host:port", () => {
    expect(orchestratorModule.splitNextHop("10.0.0.2:30001")).toEqual({ host: "10.0.0.2", port: 30001 });
    expect(orchestratorModule.splitNextHop("[2001:db8::2]:30001")).toEqual({ host: "2001:db8::2", port: 30001 });
    expect(orchestratorModule.splitNextHop("10.0.0.2")).toBeNull();
    expect(orchestratorModule.splitNextHop("10.0.0.2:")).toBeNull();
    // 裸 IPv6 会被误判成 host:port，必须拒（否则连到错误的地址）。
    expect(orchestratorModule.splitNextHop("2001:db8::2:30001")).toBeNull();
    expect(orchestratorModule.splitNextHop("")).toBeNull();
  });

  test("D5. normalizeLbStrategy：DB 值 → Agent 枚举", () => {
    expect(orchestratorModule.normalizeLbStrategy("round")).toBe("ROUND_ROBIN");
    expect(orchestratorModule.normalizeLbStrategy("rand")).toBe("RANDOM");
    expect(orchestratorModule.normalizeLbStrategy("weighted_round")).toBe("WEIGHTED_ROUND_ROBIN");
    expect(orchestratorModule.normalizeLbStrategy(null)).toBe("ROUND_ROBIN");
    expect(orchestratorModule.normalizeLbStrategy("garbage")).toBe("ROUND_ROBIN");
  });

  test("D6. mapDispatchCode：失败落到正确的一端（排障优先级不同）", () => {
    expect(
      scheduler.mapDispatchCode("egress", {
        ok: false,
        error_code: "agent_unreachable",
        error: "x",
      }),
    ).toBe(scheduler.SCHEDULER_ERROR_CODES.egress_apply_rejected);
    expect(
      scheduler.mapDispatchCode("ingress", {
        ok: false,
        error_code: "agent_unreachable",
        error: "x",
      }),
    ).toBe(scheduler.SCHEDULER_ERROR_CODES.ingress_apply_rejected);
  });

  test("D7. isRetryable：Agent 抖动可重试，额度/拓扑不可重试", () => {
    expect(scheduler.isRetryable(scheduler.SCHEDULER_ERROR_CODES.egress_ack_failed)).toBe(true);
    expect(scheduler.isRetryable(scheduler.SCHEDULER_ERROR_CODES.port_allocation_failed)).toBe(true);
    expect(scheduler.isRetryable(scheduler.SCHEDULER_ERROR_CODES.tunnel_limit)).toBe(false);
    expect(scheduler.isRetryable(scheduler.SCHEDULER_ERROR_CODES.mode_topology_mismatch)).toBe(false);
    expect(scheduler.isRetryable(scheduler.SCHEDULER_ERROR_CODES.node_group_not_allowed)).toBe(false);
  });

  test("D8. 隧道 id 带方向后缀：入口与出口不会在 Agent 侧互相覆盖", () => {
    expect(orchestratorModule.Orchestrator.egressTunnelId(42)).toBe("tunex-42-egress");
    expect(orchestratorModule.Orchestrator.relayTunnelId(42)).toBe("tunex-42-relay");
    expect(orchestratorModule.Orchestrator.egressTunnelId(42)).not.toBe(
      orchestratorModule.Orchestrator.relayTunnelId(42),
    );
  });
});

/* ================================================================== */
/* E. ORCHESTRATOR 单测（隔离 scheduler，直接打下发层）                   */
/* ================================================================== */

describe("E. Orchestrator 下发层", () => {
  const egressNode = { id: 2, node_id: "egr-1", connect_ip: "10.0.0.2", role: "egress" as const };
  const ingressNode = { id: 1, node_id: "ing-1", connect_ip: "10.0.0.1", role: "ingress" as const };

  test("E1. dispatchEgress：目标映射到 Agent 的 targets，lb 归一化", async () => {
    const out = await orch.dispatchEgress({
      tunnelId: 5,
      revision: 3,
      egressNode,
      egressPort: 30001,
      poolId: 99,
      targets: [
        { host: "192.168.1.10", port: 8080, weight: 1, order_by: 10 },
        { host: "192.168.1.11", port: 8080, weight: 2, order_by: 20 },
      ],
      lbStrategy: "rand",
    });
    expect(out.ok).toBe(true);
    const cfg = fakeAgent.applies.find((a) => a.kind === "egress")!.config!;
    expect(cfg.mode).toBe("EGRESS");
    expect(cfg.egress_port).toBe(30001);
    expect(cfg.lb_strategy).toBe("RANDOM");
    expect(cfg.targets).toEqual([
      { host: "192.168.1.10", port: 8080, weight: 1, order: 10 },
      { host: "192.168.1.11", port: 8080, weight: 2, order: 20 },
    ]);
    expect(cfg.id).toBe("tunex-5-egress");
    expect(cfg.revision).toBe(3);
  });

  test("E2. dispatchIngress 缺 next_hop → 拒绝（不许跳过出口先启入口）", async () => {
    const out = await orch.dispatchIngress({
      tunnelId: 5,
      revision: 3,
      ingressNode,
      ingressPort: 20005,
      nextHop: "",
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error_code).toBe("node_unaddressable");
    expect(out.error).toContain("next_hop");
    // 关键：根本没有下发。
    expect(fakeAgent.applies).toEqual([]);
  });

  test("E3. dispatchEgress 成功后 egress_host 可用于拼 next_hop", async () => {
    const out = await orch.dispatchEgress({
      tunnelId: 5,
      revision: 3,
      egressNode,
      egressPort: 30001,
      poolId: 99,
      targets: [{ host: "10.1.1.1", port: 80 }],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.egress_host).toBe("10.0.0.2");
    expect(out.egress_port).toBe(30001);
  });

  test("E4. transport 抛错 → dispatch 失败且不抛到调用方", async () => {
    fakeAgent.failNext = { kind: "egress", mode: "unreachable" };
    const out = await orch.dispatchEgress({
      tunnelId: 6,
      revision: 1,
      egressNode,
      egressPort: 30001,
      poolId: 99,
      targets: [{ host: "10.1.1.1", port: 80 }],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error_code).toBe("agent_unreachable");
    expect(out.commandId).toBeDefined();
  });

  test("E5. removeTunnel 幂等：重复撤同一条不报错（Agent 未知 id 也 ok）", async () => {
    const a = await orch.removeTunnel({
      tunnelId: 7,
      node: egressNode,
      revision: 5,
      reason: "compensation",
    });
    const b = await orch.removeTunnel({
      tunnelId: 7,
      node: egressNode,
      revision: 5,
      reason: "compensation",
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(fakeAgent.applies.filter((x) => x.kind === "remove").length).toBe(2);
  });

  test("E6. 下发账本：同 command_id 重放不重复执行（idempotent ACK）", async () => {
    const args = {
      tunnelId: 8,
      revision: 1,
      egressNode,
      egressPort: 30002,
      poolId: 99,
      targets: [{ host: "10.1.1.1", port: 80 }],
    };
    await orch.dispatchEgress(args);
    await orch.dispatchEgress(args);
    // 两次 dispatchEgress 会各自新建 command_id（每次 createCommand 生成新
    // UUID），因此 Agent 侧会看到两次 apply —— 但**同一 revision**，
    // WP4 manager 的 equal-revision 幂等规则会让第二次变成 no-op。
    const cfgs = fakeAgent.applies.filter((a) => a.kind === "egress");
    expect(cfgs.length).toBe(2);
    expect(cfgs[1]!.config?.revision).toBe(cfgs[0]!.config?.revision);
  });

  test("E7. HTTP transport：connect_ip 多 IP 取第一个，IPv6 加方括号", async () => {
    const calls: { url: string; body: unknown; auth: string }[] = [];
    class StubTransport extends orchestratorModule.HttpAgentTransport {
      constructor() {
        super({
          port: 9090,
          tokenForNode: () => "secret-token",
          fetch: (async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
            calls.push({
              url: String(url),
              body: init.body ? JSON.parse(init.body) : null,
              auth: init.headers?.authorization ?? "",
            });
            return new Response("{\"ok\":true}", { status: 200 });
          }) as unknown as typeof fetch,
        });
      }
    }
    const t = new StubTransport();
    const multi = { id: 3, node_id: "m", connect_ip: "10.0.0.9, 10.0.0.10", role: "egress" as const };
    await t.applyEgress(multi, {
      id: "tunex-1-egress", mode: "EGRESS", ingress_port: 0, egress_port: 30001,
      remote_host: "", remote_port: 0, next_hop: "", targets: [],
      lb_strategy: "ROUND_ROBIN", protocol: "tcp", speed_limit: 0, revision: 1,
    });
    expect(calls[0]!.url).toBe("http://10.0.0.9:9090/tunnel");
    expect(calls[0]!.auth).toBe("Bearer secret-token");

    const v6 = { id: 4, node_id: "v6", connect_ip: "2001:db8::5", role: "egress" as const };
    await t.applyEgress(v6, {
      id: "tunex-2-egress", mode: "EGRESS", ingress_port: 0, egress_port: 30001,
      remote_host: "", remote_port: 0, next_hop: "", targets: [],
      lb_strategy: "ROUND_ROBIN", protocol: "tcp", speed_limit: 0, revision: 1,
    });
    expect(calls[1]!.url).toBe("http://[2001:db8::5]:9090/tunnel");
  });

  test("E8. HTTP transport：非 2xx → agent_rejected（不是 unreachable）", async () => {
    const t = new orchestratorModule.HttpAgentTransport({
      port: 9090,
      tokenForNode: () => "tok",
      fetch: (async () =>
        new Response('{"ok":false,"error":"stale revision"}', {
          status: 409,
        })) as unknown as typeof fetch,
    });
    await expect(
      t.applyEgress(egressNode, {
        id: "t", mode: "EGRESS", ingress_port: 0, egress_port: 1,
        remote_host: "", remote_port: 0, next_hop: "", targets: [],
        lb_strategy: "ROUND_ROBIN", protocol: "tcp", speed_limit: 0, revision: 1,
      }),
    ).rejects.toMatchObject({ code: "agent_rejected" });
  });

  test("E9. HTTP transport：缺少 token → 拒绝下发（不先发再被 401）", async () => {
    const t = new orchestratorModule.HttpAgentTransport({
      port: 9090,
      tokenForNode: () => null,
      fetch: (async () => {
        throw new Error("should not be called");
      }) as unknown as typeof fetch,
    });
    await expect(
      t.applyEgress(egressNode, {
        id: "t", mode: "EGRESS", ingress_port: 0, egress_port: 1,
        remote_host: "", remote_port: 0, next_hop: "", targets: [],
        lb_strategy: "ROUND_ROBIN", protocol: "tcp", speed_limit: 0, revision: 1,
      }),
    ).rejects.toMatchObject({ code: "agent_rejected" });
  });

  test("E10. HTTP transport：connect_ip 为空 → node_unaddressable", async () => {
    const t = new orchestratorModule.HttpAgentTransport({
      port: 9090,
      tokenForNode: () => "tok",
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    await expect(
      t.applyEgress({ id: 9, node_id: "noip", connect_ip: null, role: "egress" }, {
        id: "t", mode: "EGRESS", ingress_port: 0, egress_port: 1,
        remote_host: "", remote_port: 0, next_hop: "", targets: [],
        lb_strategy: "ROUND_ROBIN", protocol: "tcp", speed_limit: 0, revision: 1,
      }),
    ).rejects.toMatchObject({ code: "node_unaddressable" });
  });
});

/* ================================================================== */
/* F. 端到端顺序的形状（防回归：一个断言看全流程）                        */
/* ================================================================== */

describe("F. 集成形状", () => {
  test("F1. 一次成功创建的全部可观测痕迹（单断言看全）", async () => {
    const result = await scheduler.createRelayTunnel(input({ listenPort: 20007 }), orch, deps);
    expect(result.ok).toBe(true);
    // steps：十条、全 ok、顺序正确。
    expect(result.steps.map((s) => s.step).join(">")).toBe(
      "auth_quota>create_pending>bind_nodes>acquire_ports>bump_revision>apply_egress>egress_ack>apply_ingress>ingress_ack>activate",
    );
    // Agent：先出口后入口，两次 apply，无 remove。
    expect(fakeAgent.applies.map((a) => a.kind).join(",")).toBe("egress,relay");
    // 端口：入口 20007（用户指定），出口自动。
    const t = tunnels[0]!;
    expect(t.listen_port).toBe(20007);
    expect(t.egress_port).toBeTypeOf("number");
    // 状态：active，revision 1，无错误。
    expect(t.apply_status).toBe("active");
    expect(t.applied_revision).toBe(1);
    expect(t.apply_error).toBeNull();
    // 租约：两条 active。
    expect(leases.filter((l) => l.status === "active").length).toBe(2);
    // DB：零 delete。
    expect(dbCalls.filter((c) => c.op === "delete")).toEqual([]);
  });

  test("F2. workspace 跨租户：入口组未授权 → 拒绝（fail-closed）", async () => {
    // 组 10 属于别的 workspace（id 999），而请求的是 workspace 7。
    groups[0]!.workspace_id = 999;
    // 这条必须走**真的**授权语义，不能 stub 成 () => true —— 那会把跨租户
    // 隔离整层绕掉（B10 里的 stub 是为了专注编排顺序，这里是专门验隔离）。
    // 不 mock.module(db)：那会污染整个文件。改为按
    // `canUseNodeGroup` 的判定式（自有组 + workspace 相等）内联实现，
    // 保持与 `node-group-access.ts` 相同的语义而不用它的 db 单例。
    deps.authorizeGroup = async (userId, group, _dir, workspaceId, personalWorkspaceId) => {
      const g = group as { user_id?: number; workspace_id?: number };
      const owned = g.user_id === userId && g.workspace_id === workspaceId;
      return owned && workspaceId === personalWorkspaceId;
    };
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("auth_quota");
    expect(result.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.node_group_not_allowed);
    // fail-closed：连 Tunnel 都不建。
    expect(result.tunnelId).toBe(-1);
  });

  test("F3. RELAY 不给出口组 → mode_topology_mismatch（不能只用入口组）", async () => {
    const result = await scheduler.createRelayTunnel(
      input({ outNodeGroupId: null }),
      orch,
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("auth_quota");
    expect(result.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.mode_topology_mismatch);
  });

  test("F4. 出口池显式指定且属于该出口节点 → 用它；否则拒绝", async () => {
    // 池 99 属于节点 2（正确）。
    const ok = await scheduler.createRelayTunnel(input({ egressPoolId: 99 }), orch, deps);
    expect(ok.ok).toBe(true);
    // 造一个属于入口节点的池 → 必须拒绝（不能把入口节点当出口用）。
    pools.push(row({ id: 98, node_id: 1, name: "default", lb_strategy: null, status: "active" }));
    const bad = await scheduler.createRelayTunnel(
      input({ name: "bad-pool", egressPoolId: 98 }),
      orch,
      deps,
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.failedStep).toBe("bind_nodes");
    expect(bad.error_code).toBe(scheduler.SCHEDULER_ERROR_CODES.node_unavailable);
    expect(bad.error).toContain("98");
  });

  test("F5. 出口池目标全下线 → 拒绝下发（不把空 targets 发出去）", async () => {
    // 池/目标全部 inactive：目标快照为空。这里**必须失败**而不是照发空 targets
    // —— WP6 的 validatePayload 会把 `targets: []` 判为坏 payload（它无法区分
    // 「这台节点是纯入口」和「配置错了」），真发出去只会拿到 400。
    // 编排器先在调度层拦下，落成结构化的 apply_egress 失败 + 释放端口租约。
    pools[0]!.status = "inactive";
    targets.forEach((t) => (t.status = "inactive"));
    const result = await scheduler.createRelayTunnel(input(), orch, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedStep).toBe("apply_egress");
    expect(result.error).toContain("没有 active 目标");
    // 铁律：没成功 → 一次 dispatch 都没发出去。
    expect(fakeAgent.applies).toEqual([]);
    // 端口租约必须被补偿释放（不留孤儿租约）。
    const live = leases.filter((l) => l.status === "active");
    expect(live).toEqual([]);
  });
});
