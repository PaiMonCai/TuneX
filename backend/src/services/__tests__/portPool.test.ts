import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { fileURLToPath } from "node:url";
import type { ReportedLinkPlacement } from "../node-state-report.ts";

/**
 * WP3 — NodePortLease / Port Allocator 离线测试（不连 MySQL / Redis）。
 *
 * 依据 `DEVELOPMENT.md` §7.6。验收口径逐条对应：
 *
 *   1. **并发分配无重复**：50 个 acquire 并发打同一个节点，结果集端口两两不同；
 *   2. **Redis 丢锁后 DB unique 兜底**：把 Redis 替身做成「永远抢不到锁」，
 *      分配仍正确且互斥（说明锁真的只是优化，DB 才是真相）；
 *   3. **orphan lease 可 reconcile**：悬空隧道 + 过期预分配都能被回收；
 *   4. **黑名单生效**：9 个基础设施端口一个都分不到，user-specified 也拒；
 *   5. **ingress/egress 双池隔离 + 同机互斥**：不同 node_id 天然隔离
 *      （各自可以拿同一个端口），同一 node_id 的 ingress/egress **必定**互斥
 *      ——BOTH 节点同 port 冲突这条就是这么钉死的；
 *   6. **legacy DIRECT 不可被抢占**：调用方灌 `reservedPorts` 后 v3 不再碰；
 *   7. **user-specified 与 auto 同一规则**：指定端口同样过黑名单 / 区间 /
 *      唯一性，且被占时不会静默改分别的端口。
 *
 * ── 替身设计 ──
 * `portPool.ts` 把 `db` / `redis` 做成可注入（见 {@link PortPoolDeps}），所以
 * 这里**不需要** `mock.module` 去拦真实 db/redis：直接把内存替身从
 * `AcquirePortInput.deps` 传进去。这比 mock.module 更稳——它不会因为模块解析
 * 路径变化（换 worktree / CI 目录）而静默失效。
 *
 * 替身按 WP1 真实 schema 复刻两条关键行为：
 *   · `@@unique([node_id, port])` → 内存 Map + P2002 抛错；
 *   · `releaseLease` 是软删除，released 行**仍占唯一键** —— 这条最容易被
 *     测试替身省略，然后掩盖「端口回收」的真实行为。
 */

/* ------------------------------------------------------------------ */
/* 内存 DB / Redis 替身                                                */
/* ------------------------------------------------------------------ */

interface LeaseRow {
  id: number;
  node_id: number;
  port: number;
  tunnel_id: number | null;
  link_id: number | null;
  protocol: string;
  bind_scope: string;
  lease_type: "ingress" | "egress";
  status: "active" | "released";
  expires_at: Date | null;
  created_at: Date;
}

interface NodeRow {
  id: number;
  port_range_min: number | null;
  port_range_max: number | null;
  node_group: { workspace_id: number | null; is_shared: boolean | null };
}

const leases: LeaseRow[] = [];
const nodes = new Map<number, NodeRow>();
const tunnels = new Set<number>();
let nextLeaseId = 1;

function resetState(): void {
  leases.length = 0;
  nodes.clear();
  tunnels.clear();
  nextLeaseId = 1;
}

function seedNode(
  id: number,
  range: [number, number] | null,
  workspaceId: number | null = 7,
): NodeRow {
  const row: NodeRow = {
    id,
    port_range_min: range ? range[0] : null,
    port_range_max: range ? range[1] : null,
    node_group: { workspace_id: workspaceId, is_shared: workspaceId === null },
  };
  nodes.set(id, row);
  return row;
}

function prismaUniqueError(fields: string): Error {
  const e = new Error(`Unique constraint failed on the fields: (${fields})`);
  (e as Error & { code: string }).code = "P2002";
  return e;
}

/** 内存 Redis：`SET NX` + `SCAN MATCH`，语义与 ioredis 对齐。 */
function makeRedis(opts: { alwaysFailLock?: boolean } = {}) {
  const store = new Map<string, string>();
  const calls = { set: 0, del: 0, scan: 0 };
  return {
    calls,
    store,
    async set(key: string, value: string, ...rest: unknown[]): Promise<string | null> {
      calls.set++;
      // 只认 `SET key val EX <ttl> NX` 这一种调用形态。
      const hasNx = rest.some((a) => String(a).toUpperCase() === "NX");
      if (!hasNx) throw new Error(`redis stub: unexpected SET form ${rest.join(" ")}`);
      if (opts.alwaysFailLock) return null;
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async del(key: string): Promise<number> {
      calls.del++;
      return store.delete(key) ? 1 : 0;
    },
    async scan(
      cursor: number | string,
      ...rest: unknown[]
    ): Promise<[string, string[]]> {
      calls.scan++;
      const matchAt = rest.findIndex((a) => String(a).toUpperCase() === "MATCH");
      const pattern = matchAt >= 0 ? String(rest[matchAt + 1]) : "*";
      const rx = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")}$`);
      return ["0", [...store.keys()].filter((k) => rx.test(k))];
    },
  };
}

/** 内存 Prisma 替身（只实现 portPool 用到的五个方法）。 */
function makeDb() {
  let tail: Promise<unknown> = Promise.resolve();
  const db = {
    async $queryRawUnsafe(query: string, ..._values: unknown[]) {
      if (!query.includes("FOR UPDATE") || !query.includes("node_id = ? AND port = ?")) throw new Error("missing node+port range lock");
      return [];
    },
    async $transaction<T>(fn: (tx: import("../portPool.ts").PortPoolTransaction) => Promise<T>, options?: { isolationLevel: "Serializable" }): Promise<T> {
      expect(options?.isolationLevel).toBe("Serializable");
      const next = tail.then(() => fn(db as unknown as import("../portPool.ts").PortPoolTransaction));
      tail = next.catch(() => undefined);
      return next;
    },
    node: {
      async findUnique(args: { where: { id: number } }): Promise<NodeRow | null> {
        return nodes.get(args.where.id) ?? null;
      },
    },
    tunnel: {
      async findUnique(args: { where: { id: number } }): Promise<{ id: number } | null> {
        return tunnels.has(args.where.id) ? { id: args.where.id } : null;
      },
    },
    nodePortLease: {
      async create(args: {
        data: {
          node_id: number;
          port: number;
          tunnel_id: number | null;
          link_id?: number | null;
          protocol?: string;
          bind_scope?: string;
          lease_type: "ingress" | "egress";
          status: string;
          expires_at: Date | null;
        };
      }): Promise<LeaseRow> {
        // @@unique([node_id, port]) —— 与 status 无关，released 行同样占位。
        const clash = leases.find((l) => l.node_id === args.data.node_id && l.port === args.data.port && l.protocol === (args.data.protocol ?? "tcp") && l.bind_scope === (args.data.bind_scope ?? "*"));
        if (clash) throw prismaUniqueError("node_id, port");
        const row: LeaseRow = {
          id: nextLeaseId++,
          node_id: args.data.node_id,
          port: args.data.port,
          tunnel_id: args.data.tunnel_id,
          link_id: args.data.link_id ?? null,
          protocol: args.data.protocol ?? "tcp",
          bind_scope: args.data.bind_scope ?? "*",
          lease_type: args.data.lease_type,
          status: args.data.status as LeaseRow["status"],
          expires_at: args.data.expires_at,
          created_at: new Date(),
        };
        leases.push(row);
        return row;
      },
      async findUnique(args: {
        where: { id?: number; node_id_port?: { node_id: number; port: number } };
      }): Promise<LeaseRow | null> {
        if (args.where.node_id_port) {
          return (
            leases.find(
              (l) =>
                l.node_id === args.where.node_id_port!.node_id &&
                l.port === args.where.node_id_port!.port,
            ) ?? null
          );
        }
        return leases.find((l) => l.id === args.where.id) ?? null;
      },
      async findMany(args: {
        where: { node_id?: number; port?: number; status?: string };
        select?: Record<string, boolean>;
      }): Promise<Record<string, unknown>[]> {
        let out = leases.filter(
          (l) =>
            (args.where.node_id === undefined || l.node_id === args.where.node_id) &&
            (args.where.status === undefined || l.status === args.where.status) &&
            (args.where.port === undefined || l.port === args.where.port),
        );
        if (!args.select) return out as unknown as Record<string, unknown>[];
        return out.map((l) => {
          const o: Record<string, unknown> = {};
          for (const k of Object.keys(args.select!)) o[k] = (l as unknown as Record<string, unknown>)[k];
          return o;
        });
      },
      async update(args: { where: { id: number }; data: { status: string } }): Promise<LeaseRow> {
        const row = leases.find((l) => l.id === args.where.id);
        if (!row) {
          const e = new Error("Record to update not found.");
          (e as Error & { code: string }).code = "P2025";
          throw e;
        }
        row.status = args.data.status as LeaseRow["status"];
        return row;
      },
      async updateMany(args: {
        where: {
          id?: number | { in: number[] };
          node_id?: number;
          port?: number;
          tunnel_id?: number;
          link_id?: number;
          status?: string;
        };
        data: Partial<LeaseRow>;
      }): Promise<{ count: number }> {
        const w = args.where;
        let count = 0;
        for (const l of leases) {
          if (w.id !== undefined) {
            if (typeof w.id === "number") {
              if (l.id !== w.id) continue;
            } else if (!w.id.in.includes(l.id)) continue;
          }
          if (w.node_id !== undefined && l.node_id !== w.node_id) continue;
          if (w.port !== undefined && l.port !== w.port) continue;
          if (w.tunnel_id !== undefined && l.tunnel_id !== w.tunnel_id) continue;
          if (w.link_id !== undefined && l.link_id !== w.link_id) continue;
          if (w.status !== undefined && l.status !== w.status) continue;
          Object.assign(l, args.data);
          count++;
        }
        return { count };
      },
    },
  };
  return db;
}

/**
 * portPool 的依赖是**函数参数注入**而不是模块级单例，所以整份测试共用一个
 * import、每套用例自建替身（不需要 `mock.module`，也就没有「换 worktree 后
 * mock 路径打歪」这类问题）。
 */
const pool = await import("../portPool.ts");

/** 注入用的依赖形状（portPool 导出的 {@link PortPoolDeps}）。 */
type InjectedDeps = {
  db: ReturnType<typeof makeDb>;
  redis: ReturnType<typeof makeRedis>;
};

function harness(opts: { alwaysFailLock?: boolean } = {}) {
  const db = makeDb();
  const redis = makeRedis(opts);
  // 内存替身直接通过 AcquirePortInput.deps / 第二参传进去。
  const deps = { db, redis, agentUsedPorts: async () => [] } as unknown as Parameters<typeof pool.acquirePort>[1];
  return { db, redis, deps };
}

function carrierReport(overrides: Partial<ReportedLinkPlacement> = {}): ReportedLinkPlacement {
  return { id: "tunex-link-30-p1-egress", link_id: 30, workspace_id: 7, node_id: 1, role: "egress",
    generation: 2, observed_generation: 2, config_digest: "a".repeat(64), desired_config_digest: "a".repeat(64),
    ready: true, state: "ready", lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    runtime_ids: ["link-30-v1-exit-tcp", "link-30-v1-exit-udp"],
    ports: [{ protocol: "tcp", host: "", port: 19000 }, { protocol: "udp", host: "", port: 19000 }],
    ...overrides };
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetState();
});

describe("protocol, bind scope and independent Link ownership", () => {
  function request(h: ReturnType<typeof harness>, extra: Partial<Parameters<typeof pool.acquirePort>[0]> = {}) {
    return pool.acquirePort({ nodeId: 1, leaseType: "ingress", preferredPort: 19000, deps: h.deps, ...extra });
  }

  test("TCP and UDP use the same numeric port with different owners; release and revive preserve the other", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    const tcp = await request(h, { tunnelId: 10 });
    const udp = await request(h, { tunnelId: 11, protocol: "udp" });
    expect(tcp.ok && udp.ok).toBe(true);
    if (!tcp.ok || !udp.ok) throw new Error("independent sockets must allocate");
    expect(tcp.result.protocol).toBe("tcp"); expect(tcp.result.bindScope).toBe("*");
    expect(tcp.result.leaseId).not.toBe(udp.result.leaseId);
    for (const protocol of ["tcp", "tls", "ws", "udp"]) expect(await request(h, { protocol, tunnelId: 12 })).toMatchObject({ ok: false, code: "port_taken" });
    expect(await pool.releaseLease({ leaseId: tcp.result.leaseId }, h.deps)).toBe(true);
    expect((await pool.leaseHolder(1, 19000, h.deps, { protocol: "udp" }))?.status).toBe("active");
    const reused = await request(h, { tunnelId: 12, protocol: "tls" });
    expect(reused).toMatchObject({ ok: true, result: { leaseId: tcp.result.leaseId, reused: true, protocol: "tcp" } });
  });

  test("concrete scopes coexist; wildcard, IPv4 mapped and unresolved scopes collide", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    for (const [tunnelId, bindScope] of [[1, "127.0.0.1"], [2, "127.0.0.2"], [3, "::1"]] as const) {
      expect((await request(h, { tunnelId, bindScope })).ok).toBe(true);
    }
    for (const bindScope of ["*", "0.0.0.0", "::", "::ffff:127.0.0.1", "localhost", "[0:0:0:0:0:0:0:1]"]) {
      expect(await request(h, { tunnelId: 9, bindScope })).toMatchObject({ ok: false, code: "port_taken" });
    }
    expect((await request(h, { tunnelId: 9, protocol: "udp", bindScope: "*" })).ok).toBe(true);
  });

  test("scope deletion permits exact reuse and does not free an independent scope", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    const first = await request(h, { tunnelId: 1, bindScope: "127.0.0.1" });
    expect((await request(h, { tunnelId: 2, bindScope: "127.0.0.2" })).ok).toBe(true);
    if (!first.ok) throw new Error("first scope must allocate");
    await pool.releaseLease({ tunnelId: 1 }, h.deps);
    expect(await request(h, { tunnelId: 3, bindScope: "::ffff:127.0.0.1" })).toMatchObject({ ok: true, result: { leaseId: first.result.leaseId, bindScope: "127.0.0.1", reused: true } });
    expect(await request(h, { tunnelId: 3, bindScope: "127.0.0.2" })).toMatchObject({ ok: false, code: "port_taken" });
    expect(await request(h, { tunnelId: 3, bindScope: "*" })).toMatchObject({ ok: false, code: "port_taken" });
  });

  test.each([null, "", "future-protocol"])("unknown acquisition %p reserves TCP and UDP", async (protocol) => {
    const h = harness(); seedNode(1, [19000, 19000]);
    expect(await request(h, { protocol, tunnelId: 1 })).toMatchObject({ ok: true, result: { protocol: "unknown" } });
    for (const known of ["tcp", "udp"]) expect(await request(h, { protocol: known, tunnelId: 2 })).toMatchObject({ ok: false, code: "port_taken" });
  });

  test("Link composite allocation stays closed; FXP must reserve explicit lanes", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    expect(await request(h, { protocol: "both", linkId: 1 })).toEqual({ ok: false, code: "unsupported_protocol" });
    expect(leases).toHaveLength(0);
  });

  test("native both reserves one conservative lease, blocks each lane, retries and releases as one owner", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    const first = await request(h, { protocol: "both", tunnelId: 10 });
    expect(first).toMatchObject({ ok: true, result: { port: 19000, protocol: "unknown", tunnelId: 10 } });
    if (!first.ok) throw new Error("missing lease");
    expect(leases).toHaveLength(1);
    for (const protocol of ["tcp", "udp", "both"]) {
      expect(await request(h, { protocol, tunnelId: 11 })).toMatchObject({ ok: false, code: "port_taken" });
    }
    expect(await request(h, { protocol: "both", tunnelId: 10 })).toMatchObject({ ok: true, result: { leaseId: first.result.leaseId, reused: true } });
    expect(await request(h, { protocol: "both", tunnelId: 10, preferredPort: undefined })).toMatchObject({ ok: true, result: { leaseId: first.result.leaseId, reused: true } });
    expect(await request(h, { protocol: "tcp", tunnelId: 10 })).toMatchObject({ ok: true, result: { leaseId: first.result.leaseId, protocol: "unknown" } });
    expect(leases).toHaveLength(1);
    await pool.releaseLease({ tunnelId: 10 }, h.deps);
    expect(leases[0]!.status).toBe("released");
    expect((await request(h, { protocol: "udp", tunnelId: 11 })).ok).toBe(true);
  });

  test("transition into both widens the same lease under the range lock, never steals an occupied lane", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    const tcp = await request(h, { tunnelId: 10 });
    const udp = await request(h, { tunnelId: 11, protocol: "udp" });
    if (!tcp.ok || !udp.ok) throw new Error("missing disjoint leases");
    expect(await request(h, { tunnelId: 10, protocol: "both" })).toMatchObject({ ok: false, code: "port_taken" });
    expect(leases[0]!.protocol).toBe("tcp");
    await pool.releaseLease({ tunnelId: 11 }, h.deps);
    expect(await request(h, { tunnelId: 10, protocol: "both" })).toMatchObject({ ok: true,
      result: { leaseId: tcp.result.leaseId, protocol: "unknown", reused: true } });
    expect(leases.filter((l) => l.status === "active")).toHaveLength(1);
  });

  test.each([
    { mode: "DIRECT", leaseType: "ingress" as const, used_ports: { tcp: { "19000": true }, udp: { "19000": true } } },
    { mode: "RELAY", leaseType: "ingress" as const, used_ports: { tcp: [19000], udp: [19000] } },
      { mode: "EGRESS", leaseType: "egress" as const, used_ports: [19000] },
  ])("native both reuses its own durable binding with real aggregate report %p", async ({ mode, leaseType, used_ports }) => {
    const h = harness(); seedNode(1, [19000, 19000]);
    const first = await request(h, { tunnelId: 10, protocol: "both", leaseType });
    if (!first.ok) throw new Error("native both must allocate");
    const id = `tunex-10-${mode.toLowerCase()}`;
    const agentUsedPorts = async () => pool.agentPortHoldersFromReport({ used_ports,
      tunnels: [{ id, mode, ingress_port: 19000, egress_port: 19000, protocol: "both",
        // The real disposable Agents use a concrete --listen-ip, although the
        // product's unspecified listen_ip owns a conservative wildcard lease.
        listen_host: mode === "DIRECT" ? "172.28.0.10" : "0.0.0.0" }] });
    for (const preferredPort of [19000, undefined]) {
      expect(await request(h, { tunnelId: 10, protocol: "both", leaseType, preferredPort,
        ownRuntimeIds: [id], deps: { ...h.deps, agentUsedPorts } })).toMatchObject({ ok: true,
          result: { leaseId: first.result.leaseId, port: 19000, protocol: "unknown", reused: true } });
    }
    expect(leases).toHaveLength(1);
    expect(await request(h, { tunnelId: 11, protocol: "both", leaseType,
      ownRuntimeIds: [id], deps: { ...h.deps, agentUsedPorts } })).toMatchObject({ ok: false, code: "port_taken" });
  });

  test("reported native runtime mode is normalized before deriving lease direction", () => {
    expect(pool.agentPortHoldersFromReport({ tunnels: [
      { id: "d", mode: " direct ", ingress_port: 19000, egress_port: 19001, protocol: "both" },
      { id: "r", mode: "relay", ingress_port: 19002, protocol: "both" },
      { id: "e", mode: " EGRESS ", ingress_port: 19003, egress_port: 19004, protocol: "both" },
    ] })).toMatchObject([
      { port: 19000, runtime_id: "d", protocol: "both", lease_type: "ingress" },
      { port: 19002, runtime_id: "r", protocol: "both", lease_type: "ingress" },
      { port: 19004, runtime_id: "e", protocol: "both", lease_type: "egress" },
    ] as const);
  });

  test("native aggregate self-reuse needs the exact owner, direction, scope and actual lanes", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    const bindScope = "127.0.0.1";
    const first = await request(h, { tunnelId: 10, protocol: "both", bindScope });
    if (!first.ok) throw new Error("native both must allocate");
    const native = { id: "tunex-10-direct", mode: "DIRECT", ingress_port: 19000,
      protocol: "both", listen_host: bindScope };
    for (const override of [
      { id: "tunex-11-direct" }, { mode: "EGRESS", egress_port: 19000 },
      { listen_host: "127.0.0.2" }, { listen_host: "0.0.0.0" }, { listen_host: undefined },
      { protocol: "tcp" }, { protocol: undefined }, { protocol: "future-protocol" },
      { ingress_port: 19001 },
    ]) {
      const agentUsedPorts = async () => pool.agentPortHoldersFromReport({
        used_ports: { tcp: [19000], udp: [19000] }, tunnels: [{ ...native, ...override }] });
      expect(await request(h, { tunnelId: 10, protocol: "both", bindScope, ownRuntimeIds: [native.id],
        deps: { ...h.deps, agentUsedPorts } })).toMatchObject({ ok: false, code: "port_taken" });
    }
    // A separate unowned/draining fact is not a duplicate numeric summary.
    const agentUsedPorts = async () => [...pool.agentPortHoldersFromReport({
      used_ports: { tcp: [19000], udp: [19000] }, tunnels: [native] }),
      { port: 19000, protocol: "udp", runtime_id: null }];
    expect(await request(h, { tunnelId: 10, protocol: "both", bindScope, ownRuntimeIds: [native.id],
      deps: { ...h.deps, agentUsedPorts } })).toMatchObject({ ok: false, code: "port_taken" });
    // A runtime ID and its summary cannot replace durable ownership.
    await pool.releaseLease({ leaseId: first.result.leaseId }, h.deps);
    expect(await request(h, { tunnelId: 10, protocol: "both", bindScope, ownRuntimeIds: [native.id],
      deps: { ...h.deps, agentUsedPorts: async () => pool.agentPortHoldersFromReport({
        used_ports: { tcp: [19000], udp: [19000] }, tunnels: [native] }) } }))
      .toMatchObject({ ok: false, code: "port_taken" });
  });

  test.each(["future-protocol", "unknown", ""])("native both and single-lane transitions cannot explain explicitly unknown %p aggregate occupancy", async (summaryProtocol) => {
    const h = harness(); seedNode(1, [19000, 19000]);
    expect((await request(h, { tunnelId: 10, protocol: "both" })).ok).toBe(true);
    const native = { id: "tunex-10-direct", mode: "DIRECT", ingress_port: 19000, protocol: "both", listen_host: "0.0.0.0" };
    const agentUsedPorts = async () => pool.agentPortHoldersFromReport({
      used_ports: { [summaryProtocol]: [19000] }, tunnels: [native] });
    for (const protocol of ["both", "tcp", "udp"]) {
      expect(await request(h, { tunnelId: 10, protocol, ownRuntimeIds: [native.id],
        deps: { ...h.deps, agentUsedPorts } })).toMatchObject({ ok: false, code: "port_taken" });
    }
  });

  test("same Link owner retries are idempotent with preferred or automatic allocation", async () => {
    const h = harness(); seedNode(1, [19000, 19010]);
    const first = await request(h, { linkId: 30, preferredPort: undefined });
    if (!first.ok) throw new Error("Link must allocate");
    const attempts = await Promise.all(Array.from({ length: 8 }, () => request(h, { linkId: 30, preferredPort: undefined })));
    for (const attempt of attempts) expect(attempt).toMatchObject({ ok: true, result: { leaseId: first.result.leaseId, port: first.result.port, linkId: 30, tunnelId: null, reused: true } });
    expect(await request(h, { linkId: 30, preferredPort: first.result.port })).toMatchObject({ ok: true, result: { leaseId: first.result.leaseId } });
    expect(leases).toHaveLength(1);
    expect(await request(h, { tunnelId: 30, preferredPort: first.result.port })).toMatchObject({ ok: false, code: "port_taken" });
    expect(leases[0]!.expires_at).toBeNull();
  });

  test.each([
    { label: "protocol map", used_ports: { tcp: { "19000": true }, udp: { "19000": true } } },
    { label: "protocol arrays", used_ports: { tcp: [19000], udp: [19000] } },
    { label: "legacy numeric summary", used_ports: [19000] },
  ])("second rule reuses its Link carrier with %p", async ({ used_ports }) => {
    const h = harness(); seedNode(1, [19000, 19010]); seedNode(2, [19000, 19010]);
    const original = await Promise.all(["tcp", "udp"].map((protocol) => request(h, { linkId: 30, protocol, leaseType: "egress" })));
    const agentUsedPorts = async (nodeId: number) => nodeId === 1
      ? pool.agentPortHoldersFromReport({ used_ports, link_placements: [carrierReport()] }) : [];
    // The second business listener adds a binding at ingress; the carrier is
    // shared by the Link and keeps its owner/leases across compiler versions.
    for (const protocol of ["tcp", "udp"]) {
      expect((await pool.acquirePort({ nodeId: 2, leaseType: "ingress", preferredPort: 19001,
        linkId: 30, protocol }, { ...h.deps, agentUsedPorts })).ok).toBe(true);
    }
    const retries = await Promise.all(Array.from({ length: 6 }, (_, i) => request(h, {
      linkId: 30, protocol: i % 2 ? "udp" : "tcp", leaseType: "egress",
      preferredPort: i % 3 ? 19000 : undefined,
      ownRuntimeIds: ["tunex-link-30-p1-egress", "link-30-v2-exit-tcp", "link-30-v2-exit-udp"],
      deps: { ...h.deps, agentUsedPorts },
    })));
    for (const [index, retry] of retries.entries()) {
      const first = original[index % 2];
      if (!first?.ok) throw new Error("carrier must initially allocate");
      expect(retry).toMatchObject({ ok: true, result: {
        leaseId: first.result.leaseId, port: 19000, linkId: 30, tunnelId: null, reused: true,
      } });
    }
    expect(leases).toHaveLength(4);
    expect(await request(h, { linkId: 31, leaseType: "egress", deps: { ...h.deps, agentUsedPorts } }))
      .toMatchObject({ ok: false, code: "port_taken" });
  });

  test("only the exact Link/node/direction/protocol/scope owner can explain aggregate occupancy", async () => {
    const h = harness(); seedNode(1, [19000, 19010]);
    const scope = "127.0.0.1";
    const first = await request(h, { linkId: 30, leaseType: "egress", bindScope: scope });
    if (!first.ok) throw new Error("carrier must allocate");
    const placement = carrierReport({ ports: [{ protocol: "tcp", host: "[::ffff:127.0.0.1]", port: 19000 }] });
    const retry = (link_placements: unknown) => request(h, { linkId: 30, leaseType: "egress", bindScope: scope,
      ownRuntimeIds: [placement.id], deps: { ...h.deps, agentUsedPorts: async () =>
        pool.agentPortHoldersFromReport({ used_ports: [19000], link_placements }) } });
    expect(await retry([placement])).toMatchObject({ ok: true, result: { leaseId: first.result.leaseId, reused: true } });
    for (const override of [
      { link_id: 31 }, { node_id: 2 }, { role: "ingress" as const },
      { ports: [{ protocol: "tcp" as const, host: "127.0.0.2", port: 19000 }] },
      { ports: [{ protocol: "udp" as const, host: scope, port: 19000 }] },
      { ports: [{ protocol: "tcp" as const, host: scope, port: 19001 }] },
      { ports: [] },
    ]) expect(await retry([{ ...placement, ...override }])).toMatchObject({ ok: false, code: "port_taken" });
    for (const value of [undefined, null, [], [{ ...placement, unexpected_field: true }]]) {
      expect(await retry(value)).toMatchObject({ ok: false, code: "port_taken" });
    }
    // A known owned TCP lane does not explain an unknown UDP claim at the same
    // number, and a DB owner without a matching runtime fact explains nothing.
    expect(await request(h, { linkId: 30, leaseType: "egress", protocol: "udp", bindScope: scope,
      deps: { ...h.deps, agentUsedPorts: async () => pool.agentPortHoldersFromReport({
        used_ports: [19000], link_placements: [placement],
      }) } })).toMatchObject({ ok: false, code: "port_taken" });
    expect(leases).toHaveLength(1);
  });

  test("failed/updating/expired placements cannot erase their coarse claims even with ownRuntimeIds", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    await request(h, { linkId: 30, leaseType: "egress" });
    for (const state of ["failed", "updating", "expired", "removed", "cached", "closed", "exited", "passive"] as const) {
      const placement = carrierReport({ ready: false, state });
      expect(await request(h, { linkId: 30, leaseType: "egress", ownRuntimeIds: [placement.id],
        deps: { ...h.deps, agentUsedPorts: async () => pool.agentPortHoldersFromReport({
          used_ports: { tcp: [19000] }, link_placements: [placement],
        }) } })).toMatchObject({ ok: false, code: "port_taken" });
    }
    const placement = carrierReport({ lease_expires_at: new Date(0).toISOString() });
    expect(await request(h, { linkId: 30, leaseType: "egress", deps: { ...h.deps,
      agentUsedPorts: async () => pool.agentPortHoldersFromReport({ used_ports: [19000], link_placements: [placement] }),
    } })).toMatchObject({ ok: false, code: "port_taken" });
  });

  test("draining/unowned facts survive exact own carrier summary disambiguation", async () => {
    const h = harness(); seedNode(1, [19000, 19010]);
    const first = await request(h, { linkId: 30, leaseType: "egress" });
    if (!first.ok) throw new Error("carrier must allocate");
    const report = { used_ports: [19000, 19001], link_placements: [carrierReport()] };
    const retry = (holders: Awaited<ReturnType<typeof pool.agentPortHoldersFromReport>>) => request(h, {
      linkId: 30, leaseType: "egress", ownRuntimeIds: [carrierReport().id],
      deps: { ...h.deps, agentUsedPorts: async () => holders },
    });
    expect(await retry(pool.agentPortHoldersFromReport(report))).toMatchObject({ ok: true });
    for (const holder of [
      { port: 19000 }, { port: 19000, protocol: "tcp", bind_scope: "::", runtime_id: null },
      { port: 19000, protocol: "tcp", bind_scope: "", runtime_id: "foreign-draining" },
    ]) expect(await retry([...pool.agentPortHoldersFromReport(report), holder]))
      .toMatchObject({ ok: false, code: "port_taken" });
    expect(await retry(pool.agentPortHoldersFromReport({ ...report, used_ports: [19000, { port: 19000 }] })))
      .toMatchObject({ ok: false, code: "port_taken" });
    expect(await retry(pool.agentPortHoldersFromReport({ ...report,
      link_placements: [carrierReport(), carrierReport({ id: "foreign-link", link_id: 31 })],
    }))).toMatchObject({ ok: false, code: "port_taken" });
    expect(await request(h, { linkId: 30, leaseType: "egress", preferredPort: 19001,
      deps: { ...h.deps, agentUsedPorts: async () => pool.agentPortHoldersFromReport(report) },
    })).toMatchObject({ ok: false, code: "port_taken" });
    expect(await pool.availablePorts(1, [], { ...h.deps, agentUsedPorts: async () => pool.agentPortHoldersFromReport(report) },
      { protocol: "udp" })).not.toContain(19000);
    await pool.releaseLease({ leaseId: first.result.leaseId }, h.deps);
    expect(await retry(pool.agentPortHoldersFromReport(report))).toMatchObject({ ok: false, code: "port_taken" });
  });

  test("carrier reuse rechecks its durable owner under the node+port transaction lock", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    await request(h, { linkId: 30, leaseType: "egress" });
    const transaction = h.db.$transaction.bind(h.db);
    h.db.$transaction = async (run, options) => {
      // Retirement raced the Agent snapshot read. The snapshot alone must not
      // revive a released lease while its old claim still appears occupied.
      leases[0]!.status = "released";
      return transaction(run, options);
    };
    expect(await request(h, { linkId: 30, leaseType: "egress", deps: { ...h.deps,
      agentUsedPorts: async () => pool.agentPortHoldersFromReport({ used_ports: [19000], link_placements: [carrierReport()] }),
    } })).toMatchObject({ ok: false, code: "port_taken" });
    expect(leases[0]!.status).toBe("released");
    expect(leases).toHaveLength(1);
  });

  test("default Agent snapshot query reads Link placements for same-carrier reuse", () => {
    const dbModule = JSON.stringify(fileURLToPath(new URL("../../db.ts", import.meta.url)));
    const poolModule = JSON.stringify(fileURLToPath(new URL("../portPool.ts", import.meta.url)));
    const report = JSON.stringify({ used_ports: [19000], tunnels: [], link_placements: [carrierReport()] });
    // Isolate module mocks from every other suite; exercise the real default
    // Agent facts reader rather than an injected pre-parsed holder callback.
    const scenario = `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      process.env.AUTH_SECRET="offline-carrier-port-test";
      process.env.DATABASE_URL="mysql://unused:unused@127.0.0.1:1/unused";
      const lease={id:77,node_id:1,port:19000,lease_type:"egress",tunnel_id:null,link_id:30,
        protocol:"tcp",bind_scope:"*",status:"active",expires_at:null};
      let reads=0;
      const db={
        node:{findUnique:async()=>({id:1,port_range_min:19000,port_range_max:19000,node_group:{workspace_id:7}})},
        nodeStateReport:{findUnique:async({where,select})=>{assert.equal(where.node_id,1);
          assert.equal(select.link_placements,true);assert.equal(select.used_ports,true);reads++;return ${report};}},
        nodePortLease:{findMany:async()=>[lease],create:async()=>{throw new Error("must reuse carrier");}},
        $queryRawUnsafe:async()=>[], $transaction:async(run)=>run(db),
      };
      mock.module(${dbModule},()=>({db}));
      mock.module("ioredis",()=>({default:class OfflineRedis {on(){return this;}}}));
      const {acquirePort}=await import(${poolModule});
      const outcome=await acquirePort({nodeId:1,leaseType:"egress",preferredPort:19000,linkId:30,
        protocol:"tcp",ownRuntimeIds:["tunex-link-30-p1-egress"]},
        {redis:{set:async()=>null,del:async()=>0,scan:async()=>["0",[]]}});
      assert.equal(outcome.ok,true,JSON.stringify(outcome));
      assert.equal(outcome.result.leaseId,77);assert.equal(outcome.result.reused,true);assert.equal(reads,1);
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", scenario], { stdout: "pipe", stderr: "pipe" });
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    expect(child.exitCode).toBe(0);
  });

  test("Link release covers its TCP/UDP children only, and reconcile never expires Link rows", async () => {
    const h = harness(); seedNode(1, [19000, 19010]);
    for (const protocol of ["tcp", "udp"]) expect((await request(h, { linkId: 30, protocol, expiresAt: new Date(0) })).ok).toBe(true);
    expect((await request(h, { tunnelId: 30, preferredPort: 19001 })).ok).toBe(true);
    tunnels.add(30);
    expect(await pool.reconcileLeases({ deps: h.deps })).toEqual({ releasedDanglingTunnel: 0, releasedExpired: 0 });
    expect(await pool.releaseLease({ tunnelId: 30 }, h.deps)).toBe(true);
    expect(leases.filter((row) => row.link_id === 30 && row.status === "active")).toHaveLength(2);
    expect(await pool.releaseLease({ linkId: 30 }, h.deps)).toBe(true);
    expect(await pool.releaseLease({ linkId: 30 }, h.deps)).toBe(false);
    expect((await request(h, { linkId: 31, protocol: "udp" })).ok).toBe(true);
  });

  test("Link and Tunnel cannot both own one row", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    await expect(request(h, { linkId: 1, tunnelId: 1 })).rejects.toThrow("exactly one business owner");
    expect(leases).toHaveLength(0);
  });

  test("concurrent wildcard and concrete scopes are serialized even without Redis", async () => {
    const h = harness({ alwaysFailLock: true }); seedNode(1, [19000, 19000]);
    const results = await Promise.all(Array.from({ length: 24 }, (_, tunnelId) => request(h, { tunnelId, bindScope: tunnelId % 2 ? "0.0.0.0" : "127.0.0.1" })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(leases).toHaveLength(1);
  });

  test("concurrent TCP and UDP claims admit exactly one owner in each namespace", async () => {
    const h = harness({ alwaysFailLock: true }); seedNode(1, [19000, 19000]);
    const results = await Promise.all(Array.from({ length: 24 }, (_, tunnelId) => request(h, { tunnelId, protocol: tunnelId % 2 ? "udp" : "tcp" })));
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(new Set(leases.map((row) => row.protocol))).toEqual(new Set(["tcp", "udp"]));
  });

  test("availability and holder queries preserve scope and protocol", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    await request(h, { protocol: "tcp", bindScope: "127.0.0.1", tunnelId: 1 });
    expect(await pool.availablePorts(1, [], h.deps, { protocol: "udp" })).toEqual([19000]);
    expect(await pool.availablePorts(1, [], h.deps, { protocol: "tcp", bindScope: "127.0.0.2" })).toEqual([19000]);
    expect(await pool.availablePorts(1, [], h.deps, { protocol: "tcp", bindScope: "::" })).toEqual([]);
    await request(h, { protocol: "udp", bindScope: "*", linkId: 2 });
    await expect(pool.leaseHolder(1, 19000, h.deps)).rejects.toThrow("ambiguous");
    expect(await pool.leaseHolder(1, 19000, h.deps, { protocol: "udp" })).toMatchObject({ linkId: 2, tunnelId: null, protocol: "udp" });
  });

  test("Agent unknown facts and numeric reservations block both namespaces; explicit TCP facts allow UDP", async () => {
    const h = harness(); seedNode(1, [19000, 19000]);
    for (const protocol of ["tcp", "udp"]) {
      expect(await request(h, { protocol, deps: { ...h.deps, agentUsedPorts: async () => [{ port: 19000, runtime_id: "unknown-owner" }] } })).toMatchObject({ ok: false, code: "port_taken" });
      expect(await request(h, { protocol, reservedPorts: [19000] })).toMatchObject({ ok: false, code: "port_taken" });
    }
    const agentUsedPorts = async () => [{ port: 19000, runtime_id: "native-tcp", protocol: "tls", bind_scope: "*" }];
    expect((await request(h, { protocol: "udp", deps: { ...h.deps, agentUsedPorts } })).ok).toBe(true);
    expect(await request(h, { protocol: "tcp", deps: { ...h.deps, agentUsedPorts } })).toMatchObject({ ok: false, code: "port_taken" });
  });

  test("Agent report keeps draining unowned facts and the correct local socket port", () => {
    const holders = pool.agentPortHoldersFromReport({
      tunnels: [
        { id: "eg", mode: "EGRESS", protocol: "udp", egress_port: 19000, ingress_port: 19001 },
        { id: "direct", mode: "DIRECT", protocol: "tcp", ingress_port: 19002, egress_port: 19003, listen_host: "127.0.0.1" },
      ], used_ports: { udp: [19000, 19004], tcp: { "19002": true, "19005": true } },
    });
    expect(holders.filter((holder) => holder.runtime_id != null).map((holder) => holder.port)).toEqual([19000, 19002]);
    expect(holders).toContainEqual({ port: 19004, runtime_id: null, protocol: "udp", aggregate: true });
    expect(pool.agentPortHoldersFromReport({ used_ports: [19000] })).toEqual([{ port: 19000, runtime_id: null, protocol: undefined, aggregate: true }]);
  });
});

/* ================================================================== */
/* 1. 并发分配无重复                                                    */
/* ================================================================== */

describe("1. 并发分配无重复（§7.6 DoD）", () => {
  test("Agent 上报的占用端口会被跳过（面板的租约表不是唯一事实）", async () => {
    // 现场根因：面板按 DB 租约发端口，而 Agent 的端口守卫仍占着那个端口（Remove 之后监听
    // 还在关闭、或守卫漂移），Agent 于是**正确地**拒绝 apply —— 症状是一条路由永远建不起来，
    // 日志里只有一个 `*_apply_rejected`，离原因很远。
    // 这里钉住的是修法：分配器把节点**自己报的** used_ports 也算作占用。
    const h = harness();
    seedNode(1, [19000, 19002]); // 区间 [min,max]（不是端口列表）：正好三个可选端口

    const first = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 1, deps: h.deps });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const taken = first.result.port;

    // 该端口在 DB 里被 released（面板视角空闲），但 Agent 仍然占着它。
    leases.length = 0;
    const second = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      tunnelId: 2,
      deps: { ...h.deps, agentUsedPorts: async () => [{ port: taken, runtime_id: "tunex-9-relay" }] },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.result.port).not.toBe(taken);
  });

  test("本隧道自己的 runtime 占用的端口不算冲突（幂等编辑 / 失败重试必须成功）", async () => {
    // 实测踩到过：把 Forward 的 listen_port 改回它**正在使用**的那个值（还原夹具 / 重试），
    // 若把 Agent 上报的占用一律当成"别人占用"，分配器会拒绝自己的端口 → 502 port_taken，
    // 而那个端口明明就是这条隧道本隧道在听。ownRuntimeIds 就是用来区分这一点的。
    const h = harness();
    seedNode(1, [19000, 19002]);
    const mine = "tunex-7-direct";

    const outcome = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      tunnelId: 7,
      preferredPort: 19000,
      ownRuntimeIds: [mine, "tunex-7-relay"],
      deps: { ...h.deps, agentUsedPorts: async () => [{ port: 19000, runtime_id: mine }] },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.port).toBe(19000);
  });

  test("50 个并发 acquire 拿到 50 个互不相同的端口", async () => {
    const h = harness();
    seedNode(1, [19000, 19200]); // 201 个端口远大于 50 并发，必定成功

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        pool.acquirePort({
          nodeId: 1,
          leaseType: "ingress",
          tunnelId: 100 + i,
          deps: h.deps,
        }),
      ),
    );

    expect(results.filter((r) => r.ok).length).toBe(50);
    const ports = results.flatMap((r) => (r.ok ? [r.result.port] : []));
    expect(new Set(ports).size).toBe(50); // 两两不同
    // 全部落在节点区间内，且无黑名单端口。
    for (const p of ports) {
      expect(p).toBeGreaterThanOrEqual(19000);
      expect(p).toBeLessThanOrEqual(19200);
      expect(pool.isBlacklistedPort(p)).toBe(false);
    }
    // DB 里也确实是 50 行 active。
    expect(leases.filter((l) => l.status === "active").length).toBe(50);
  });

  test("并发抢同一个 user-specified 端口：恰好一个人成功", async () => {
    const h = harness();
    seedNode(1, [19000, 19200]);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        pool.acquirePort({
          nodeId: 1,
          leaseType: "ingress",
          preferredPort: 19050,
          tunnelId: i + 1,
          deps: h.deps,
        }),
      ),
    );

    const ok = results.filter((r) => r.ok);
    expect(ok.length).toBe(1);
    expect(ok[0]!.ok && ok[0]!.result.port).toBe(19050);
    // 其余 9 个都是可解释的 port_taken，而不是异常。
    for (const r of results) {
      if (!r.ok) expect(r.code).toBe("port_taken");
    }
  });

  test("同一 tunnel/node/direction 重入 preferred port 幂等成功，供 suspend→resume 使用", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);

    const first = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      preferredPort: 19005,
      tunnelId: 42,
      deps: h.deps,
    });
    const again = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      preferredPort: 19005,
      tunnelId: 42,
      deps: h.deps,
    });

    expect(first.ok).toBe(true);
    expect(again.ok).toBe(true);
    if (!first.ok || !again.ok) return;
    expect(again.result.port).toBe(first.result.port);
    expect(again.result.leaseId).toBe(first.result.leaseId);
    expect(again.result.reused).toBe(true);
    expect(leases.filter((l) => l.status === "active")).toHaveLength(1);
  });

  test("同一 tunnel 但不同方向不能把同一物理端口当作幂等重入", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);

    const ingress = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      preferredPort: 19006,
      tunnelId: 42,
      deps: h.deps,
    });
    const egress = await pool.acquirePort({
      nodeId: 1,
      leaseType: "egress",
      preferredPort: 19006,
      tunnelId: 42,
      deps: h.deps,
    });

    expect(ingress.ok).toBe(true);
    expect(egress.ok).toBe(false);
    if (!egress.ok) expect(egress.code).toBe("port_taken");
  });

  test("同一隧道的 ingress/egress 两个槽拿到不同端口", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);

    const a = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 42, deps: h.deps });
    const b = await pool.acquirePort({ nodeId: 1, leaseType: "egress", tunnelId: 42, deps: h.deps });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.result.port).not.toBe(b.result.port);
  });
});

/* ================================================================== */
/* 2. Redis 丢锁后 DB unique 兜底                                       */
/* ================================================================== */

describe("2. Redis 丢锁后 DB unique 兜底（§7.6 DoD）", () => {
  test("Redis 永远抢不到锁：分配仍正确、仍互斥（锁只是优化）", async () => {
    const h = harness({ alwaysFailLock: true });
    seedNode(1, [19000, 19100]);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: i, deps: h.deps }),
      ),
    );

    expect(results.filter((r) => r.ok).length).toBe(20);
    const ports = results.flatMap((r) => (r.ok ? [r.result.port] : []));
    expect(new Set(ports).size).toBe(20);
    // 锁一次都没拿到过，说明 DB 是唯一兜底路径。
    expect(h.redis.store.size).toBe(0);
  });

  test("Redis 整体抛异常：不挂，退回 DB 唯一约束", async () => {
    const db = makeDb();
    const brokenRedis = {
      async set(): Promise<unknown> {
        throw new Error("redis down");
      },
      async del(): Promise<unknown> {
        throw new Error("redis down");
      },
      async scan(): Promise<unknown> {
        throw new Error("redis down");
      },
    };
    const deps = { db, redis: brokenRedis, agentUsedPorts: async () => [] };
    seedNode(1, [19000, 19100]);

    const first = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 1, deps });
    const second = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 2, deps });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.result.port).not.toBe(second.result.port);
  });

  test("锁丢失不被当作「端口空闲」：holder 只认 DB 行", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);
    const acquired = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 9, deps: h.deps });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    // 把 Redis 整个清空（模拟锁被 flush），holder 仍应报出持有者。
    h.redis.store.clear();
    const holder = await pool.leaseHolder(1, acquired.result.port, h.deps);
    expect(holder).not.toBeNull();
    expect(holder?.tunnelId).toBe(9);
    expect(holder?.status).toBe("active");
  });
});

/* ================================================================== */
/* 3. orphan lease 可 reconcile                                        */
/* ================================================================== */

describe("3. orphan lease 可 reconcile（§7.6 DoD）", () => {
  test("悬空隧道租约（tunnel_id 指向已删除的 Tunnel）被回收", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);
    tunnels.add(1); // 只有 1 号隧道存在

    const alive = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 1, deps: h.deps });
    const dangling = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 999, deps: h.deps });
    expect(alive.ok && dangling.ok).toBe(true);

    const stat = await pool.reconcileLeases({ deps: h.deps });
    expect(stat.releasedDanglingTunnel).toBe(1);
    expect(stat.releasedExpired).toBe(0);

    // 活着的那条不受影响；悬空的那条变 released。
    if (alive.ok) expect((await pool.leaseHolder(1, alive.result.port, h.deps))?.status).toBe("active");
    if (dangling.ok) {
      expect((await pool.leaseHolder(1, dangling.result.port, h.deps))?.status).toBe("released");
    }
  });

  test("过期预分配（tunnel_id NULL 且 expires_at 已过）被回收", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);

    const stale = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      tunnelId: null,
      expiresAt: new Date(Date.now() - 1000),
      deps: h.deps,
    });
    const fresh = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      tunnelId: null,
      expiresAt: new Date(Date.now() + 60_000),
      deps: h.deps,
    });
    expect(stale.ok && fresh.ok).toBe(true);

    const stat = await pool.reconcileLeases({ deps: h.deps });
    expect(stat.releasedExpired).toBe(1);
    expect(stat.releasedDanglingTunnel).toBe(0);
    if (fresh.ok) expect((await pool.leaseHolder(1, fresh.result.port, h.deps))?.status).toBe("active");
  });

  test("预分配拿到默认 TTL（不是 NULL）—— 否则 reconcile 永远收不回它", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);
    const pre = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: null, deps: h.deps });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    const row = leases.find((l) => l.port === pre.result.port)!;
    expect(row.expires_at).not.toBeNull();
    expect(row.expires_at!.getTime()).toBeGreaterThan(Date.now());
  });

  test("撤回：reconcile 只统计不写，行状态不变", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);
    await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 404, deps: h.deps });

    const stat = await pool.reconcileLeases({ dryRun: true, deps: h.deps });
    expect(stat.releasedDanglingTunnel).toBe(1);
    expect(leases.filter((l) => l.status === "active").length).toBe(1); // 没被写
  });

  test("回收后的端口可被再次分配（revive，不会因 released 行耗尽区间）", async () => {
    const h = harness();
    seedNode(1, [19000, 19000]); // 只有一个端口的病态区间

    const first = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 1, deps: h.deps });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 区间耗尽 → no_available_port（不是永久卡死）。
    const exhausted = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 2, deps: h.deps });
    expect(exhausted.ok).toBe(false);

    // 释放后同一个端口能再拿回来。
    await pool.releaseLease({ leaseId: first.result.leaseId }, h.deps);
    const again = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 3, deps: h.deps });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.result.port).toBe(19000);
      expect(again.result.reused).toBe(true); // revive 路径
    }
  });
});

/* ================================================================== */
/* 4. 黑名单生效                                                        */
/* ================================================================== */

describe("4. 黑名单生效（§7.6）", () => {
  test("9 个基础设施端口全部在清单里（22/80/443/3306/5432/6379/27017/9090/9191）", () => {
    expect([...pool.PORT_BLACKLIST].sort((a, b) => a - b)).toEqual([
      22, 80, 443, 3306, 5432, 6379, 9090, 9191, 27017,
    ]);
    for (const p of pool.PORT_BLACKLIST) expect(pool.isBlacklistedPort(p)).toBe(true);
    expect(pool.isBlacklistedPort(19000)).toBe(false);
  });

  test("区间含黑名单端口时，自动分配一个都不给", async () => {
    const h = harness();
    seedNode(1, [80, 84]); // 80 黑名单，81-84 可用
    const got: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: i, deps: h.deps });
      if (r.ok) got.push(r.result.port);
    }
    expect(got).toEqual([81, 82, 83, 84]);
    expect(got).not.toContain(80);
    expect(got).not.toContain(443);
  });

  test("user-specified 指定黑名单端口 → port_blacklisted（与 auto 同一规则）", async () => {
    const h = harness();
    seedNode(1, [19000, 19100]);
    for (const p of pool.PORT_BLACKLIST) {
      const r = await pool.acquirePort({
        nodeId: 1,
        leaseType: "ingress",
        preferredPort: p,
        tunnelId: 1,
        deps: h.deps,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("port_blacklisted");
        expect(r.port).toBe(p);
      }
    }
  });

  test("纯黑名单区间 → no_available_port", async () => {
    const h = harness();
    seedNode(1, [22, 22]);
    const r = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 1, deps: h.deps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no_available_port");
  });

  test("expandAvailablePorts 把黑名单整段剔除（含区间两端点）", () => {
    expect(pool.expandAvailablePorts({ min: 78, max: 82 })).toEqual([78, 79, 81, 82]);
    expect(pool.expandAvailablePorts({ min: 9090, max: 9092 })).toEqual([9091, 9092]);
  });
});

/* ================================================================== */
/* 5. ingress / egress 双池：同 node 互斥，跨 node 隔离                 */
/* ================================================================== */

describe("5. ingress/egress 共用同一物理 namespace（§7.6 BOTH 同 port 冲突）", () => {
  test("同一 node_id：egress 抢 ingress 已占的端口 → port_taken（BOTH 双绑被禁）", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);

    const ingress = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      preferredPort: 19005,
      tunnelId: 1,
      deps: h.deps,
    });
    expect(ingress.ok).toBe(true);

    const egress = await pool.acquirePort({
      nodeId: 1,
      leaseType: "egress",
      preferredPort: 19005,
      tunnelId: 2,
      deps: h.deps,
    });
    expect(egress.ok).toBe(false);
    if (!egress.ok) expect(egress.code).toBe("port_taken");
  });

  test("同一 node_id：egress 自动分配不会撞上任何 ingress 端口", async () => {
    const h = harness();
    seedNode(1, [19000, 19009]);

    const ingressPorts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: i, deps: h.deps });
      if (r.ok) ingressPorts.push(r.result.port);
    }
    const egressPorts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await pool.acquirePort({ nodeId: 1, leaseType: "egress", tunnelId: 100 + i, deps: h.deps });
      if (r.ok) egressPorts.push(r.result.port);
    }
    // 10 个分配挤在 10 个端口上，两个方向必须完全不重叠。
    expect(ingressPorts.length + egressPorts.length).toBe(10);
    expect(new Set([...ingressPorts, ...egressPorts]).size).toBe(10);
    expect(ingressPorts.some((p) => egressPorts.includes(p))).toBe(false);
  });

  test("不同 node_id：同一个端口可以各自持有（天然隔离，role 无关）", async () => {
    const h = harness();
    seedNode(7, [19000, 19010]); // 入口节点
    seedNode(8, [19000, 19010]); // 出口节点

    const a = await pool.acquirePort({ nodeId: 7, leaseType: "ingress", preferredPort: 19000, tunnelId: 1, deps: h.deps });
    const b = await pool.acquirePort({ nodeId: 8, leaseType: "egress", preferredPort: 19000, tunnelId: 1, deps: h.deps });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.result.port).toBe(19000);
      expect(b.result.port).toBe(19000);
    }
  });

  test("sameLeaseTarget 不看 lease_type —— 物理互斥判定与方向无关", () => {
    const a = { node_id: 7, port: 19000 };
    const b = { node_id: 7, port: 19000 };
    expect(pool.sameLeaseTarget(a, b)).toBe(true);
    expect(pool.sameLeaseTarget({ node_id: 7, port: 19000 }, { node_id: 8, port: 19000 })).toBe(false);
    expect(pool.sameLeaseTarget({ node_id: 7, port: 19000 }, { node_id: 7, port: 19001 })).toBe(false);
  });

  test("holder 按 (node_id, port) 定位，能分辨两个节点上的同一个端口号", async () => {
    const h = harness();
    seedNode(7, [19000, 19010]);
    seedNode(8, [19000, 19010]);
    await pool.acquirePort({ nodeId: 7, leaseType: "ingress", preferredPort: 19000, tunnelId: 11, deps: h.deps });
    await pool.acquirePort({ nodeId: 8, leaseType: "egress", preferredPort: 19000, tunnelId: 22, deps: h.deps });

    const inHolder = await pool.leaseHolder(7, 19000, h.deps);
    const outHolder = await pool.leaseHolder(8, 19000, h.deps);
    expect(inHolder?.leaseType).toBe("ingress");
    expect(inHolder?.tunnelId).toBe(11);
    expect(outHolder?.leaseType).toBe("egress");
    expect(outHolder?.tunnelId).toBe(22);
  });
});

/* ================================================================== */
/* 6. legacy DIRECT 端口不可被抢占                                       */
/* ================================================================== */

describe("6. legacy DIRECT 端口不可被抢占（§7.6）", () => {
  test("reservedPorts 里的 DIRECT listen_port 自动分配绝不给", async () => {
    const h = harness();
    seedNode(1, [19000, 19004]);
    // 存量 DIRECT 隧道占了 19001 / 19003（在 DB 里没有租约行）。
    const got: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await pool.acquirePort({
        nodeId: 1,
        leaseType: "ingress",
        tunnelId: i,
        reservedPorts: [19001, 19003],
        deps: h.deps,
      });
      if (r.ok) got.push(r.result.port);
    }
    expect(got).toEqual([19000, 19002, 19004]);
  });

  test("DIRECT 端口被显式 user-specified → port_taken（抢占失败）", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);
    const r = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      preferredPort: 19003,
      reservedPorts: [19003],
      tunnelId: 1,
      deps: h.deps,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("port_taken");
    // 没有因此静默改分到别的端口上。
    expect(leases.length).toBe(0);
  });

  test("节点未配置区间 → 拒绝分配，不回落到节点组 port_range", async () => {
    const h = harness();
    seedNode(1, null); // port_range_min/max 都是 NULL
    const r = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 1, deps: h.deps });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("node_range_unset");
  });
});

/* ================================================================== */
/* 7. user-specified 与 auto 走同一规则                                   */
/* ================================================================== */

describe("7. user-specified port 与 auto port 同一规则（§7.6）", () => {
  test("指定合法端口直接命中，且写库形状与 auto 一致", async () => {
    const h = harness();
    seedNode(1, [19000, 19100]);
    const r = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      preferredPort: 19077,
      tunnelId: 5,
      deps: h.deps,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.port).toBe(19077);
    expect(r.result.tunnelId).toBe(5);
    expect(r.result.leaseType).toBe("ingress");
    expect(r.result.reused).toBe(false);
    expect(leases).toHaveLength(1);
    expect(leases[0]!.status).toBe("active");
    expect(leases[0]!.lease_type).toBe("ingress");
  });

  test("指定端口被占 → port_taken，不会改分别的端口", async () => {
    const h = harness();
    seedNode(1, [19000, 19100]);
    await pool.acquirePort({ nodeId: 1, leaseType: "ingress", preferredPort: 19050, tunnelId: 1, deps: h.deps });
    const second = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", preferredPort: 19050, tunnelId: 2, deps: h.deps });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("port_taken");
    expect(leases).toHaveLength(1);
  });

  test("指定端口越界 / 非整数 → 拒绝（同一套校验）", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);
    const outside = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      preferredPort: 80,
      tunnelId: 1,
      deps: h.deps,
    });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.code).toBe("port_blacklisted");

    const bad = await pool.acquirePort({
      nodeId: 1,
      leaseType: "ingress",
      preferredPort: 1234.5,
      tunnelId: 1,
      deps: h.deps,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("port_out_of_range");
  });

  test("portCandidates：指定时候选集只剩它自己（同一规则的机制保证）", () => {
    expect(pool.portCandidates({ min: 19000, max: 19002 }, 19001)).toEqual([19001]);
    expect(pool.portCandidates({ min: 19000, max: 19002 })).toEqual([19000, 19001, 19002]);
    expect(pool.portCandidates({ min: 19000, max: 19002 }, null)).toEqual([19000, 19001, 19002]);
  });

  test("auto 分配严格升序、跨调用保持稳定", async () => {
    const h = harness();
    seedNode(1, [19000, 19004]);
    const got: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: i, deps: h.deps });
      if (r.ok) got.push(r.result.port);
    }
    expect(got).toEqual([19000, 19001, 19002]);
  });

  test("节点不存在 / 区间非法 → 可解释失败码（不抛）", async () => {
    const h = harness();
    const missing = await pool.acquirePort({ nodeId: 999, leaseType: "ingress", tunnelId: 1, deps: h.deps });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("node_not_found");

    seedNode(1, [19100, 19000]); // min > max
    const bad = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 1, deps: h.deps });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("node_range_invalid");
  });
});

/* ================================================================== */
/* 8. release / availablePorts / 锁对账                                  */
/* ================================================================== */

describe("8. release / availablePorts / 锁对账", () => {
  test("release 是软删除：行还在，状态变 released，端口仍占唯一键", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);
    const a = await pool.acquirePort({ nodeId: 1, leaseType: "ingress", preferredPort: 19001, tunnelId: 1, deps: h.deps });
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    expect(await pool.releaseLease({ leaseId: a.result.leaseId }, h.deps)).toBe(true);
    const row = leases.find((l) => l.id === a.result.leaseId)!;
    expect(row.status).toBe("released");
    expect(leases).toHaveLength(1); // 没物理删

    // released 行仍撞唯一键：直接 insert 同一 (node, port) 会 P2002。
    await expect(
      h.db.nodePortLease.create({
        data: { node_id: 1, port: 19001, tunnel_id: null, lease_type: "ingress", status: "active", expires_at: null },
      }),
    ).rejects.toThrow();
  });

  test("release 不存在的 leaseId → false，不抛", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);
    expect(await pool.releaseLease({ leaseId: 12345 }, h.deps)).toBe(false);
  });

  test("按 tunnelId 批量释放：该隧道的 ingress+egress 两条都放", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);
    await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 7, deps: h.deps });
    await pool.acquirePort({ nodeId: 1, leaseType: "egress", tunnelId: 7, deps: h.deps });
    expect(await pool.releaseLease({ tunnelId: 7 }, h.deps)).toBe(true);
    expect(leases.filter((l) => l.status === "released").length).toBe(2);
  });

  test("availablePorts 剔除 active 租约 + reservedPorts + 黑名单", async () => {
    const h = harness();
    seedNode(1, [80, 84]); // 80 黑名单 → 81..84
    await pool.acquirePort({ nodeId: 1, leaseType: "ingress", preferredPort: 82, tunnelId: 1, deps: h.deps });
    const avail = await pool.availablePorts(1, [83], h.deps);
    expect(avail).toEqual([81, 84]);
  });

  test("availablePorts：节点没配区间时返回空数组（不抛）", async () => {
    const h = harness();
    seedNode(1, null);
    expect(await pool.availablePorts(1, [], h.deps)).toEqual([]);
  });

  test("锁对账：SCAN 到残留锁 key，del 掉后 store 清空", async () => {
    const h = harness();
    seedNode(1, [19000, 19010], 7); // workspace_id=7，scope=7
    await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 1, deps: h.deps });
    // 正常路径放锁了，所以这里应为空；真正要验证的是 SCAN 能按 pattern 定位
    // 到**手动灌入**的残留 key（进程崩溃场景）。
    expect(h.redis.store.size).toBe(0);

    // 手动灌一个残留 key（进程崩溃场景）。
    h.redis.store.set(pool.__internals.leaseLockKey(7, 1, 19005), "1");
    const found = await pool.reconcileLeaseLocks({ dryRun: true, deps: h.deps });
    expect(found).toBe(1);
    const deleted = await pool.reconcileLeaseLocks({ deps: h.deps });
    expect(deleted).toBe(1);
    expect(h.redis.store.size).toBe(0);
  });

  test("锁 key 走 tenant-scope 的 key 工厂（ws:<scope>:node_port_lease:lock:<node>:<port>）", () => {
    // scope=0 → ws:global（平台共享；nodeScope 会把 is_shared 或空 workspace 折叠到 0）。
    expect(pool.__internals.leaseLockKey(0, 3, 22)).toBe("ws:global:node_port_lease:lock:3:22");
    // 普通租户走 workspace id。
    expect(pool.__internals.leaseLockKey(7, 1, 19000)).toBe("ws:7:node_port_lease:lock:1:19000");
  });

  test("锁的 TTL 有带上（进程崩溃不能永久阻塞分配）", async () => {
    const h = harness();
    seedNode(1, [19000, 19010]);
    await pool.acquirePort({ nodeId: 1, leaseType: "ingress", tunnelId: 1, deps: h.deps });
    // 替身的 set() 只接受 `EX <ttl> NX` 形态（否则会抛错），走到这里即证明带上了。
    expect(h.redis.calls.set).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* 9. 纯函数                                                            */
/* ================================================================== */

describe("9. 纯函数", () => {
  test("isValidPort：1..65535 整数", () => {
    expect(pool.isValidPort(1)).toBe(true);
    expect(pool.isValidPort(65535)).toBe(true);
    expect(pool.isValidPort(0)).toBe(false);
    expect(pool.isValidPort(65536)).toBe(false);
    expect(pool.isValidPort(19000.5)).toBe(false);
    expect(pool.isValidPort("19000")).toBe(false);
  });

  test("resolveNodeRange：unset / invalid / ok 三态", () => {
    expect(pool.resolveNodeRange({ min: null, max: null })).toEqual({ kind: "unset" });
    expect(pool.resolveNodeRange({ min: 19000, max: null })).toEqual({ kind: "unset" });
    expect(pool.resolveNodeRange({ min: 19100, max: 19000 })).toEqual({ kind: "invalid" });
    expect(pool.resolveNodeRange({ min: 0, max: 100 })).toEqual({ kind: "invalid" });
    expect(pool.resolveNodeRange({ min: 19000, max: 19002 })).toEqual({ kind: "ok", min: 19000, max: 19002 });
  });

  test("isUniqueConflict / P2002", () => {
    expect(pool.isUniqueConflict({ code: "P2002" })).toBe(true);
    expect(pool.isUniqueConflict({ code: "P2025" })).toBe(false);
    expect(pool.isUniqueConflict(null)).toBe(false);
  });

  test("ORPHAN_RULES.isExpired：NULL expiry 一律视为过期", () => {
    const now = new Date();
    expect(pool.ORPHAN_RULES.isExpired({ expires_at: null }, now)).toBe(true);
    expect(pool.ORPHAN_RULES.isExpired({ expires_at: new Date(now.getTime() - 1) }, now)).toBe(true);
    expect(pool.ORPHAN_RULES.isExpired({ expires_at: new Date(now.getTime() + 1) }, now)).toBe(false);
  });
});
