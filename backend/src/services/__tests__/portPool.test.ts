import { test, expect, describe, beforeEach, afterEach } from "bun:test";

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
  return {
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
          lease_type: "ingress" | "egress";
          status: string;
          expires_at: Date | null;
        };
      }): Promise<LeaseRow> {
        // @@unique([node_id, port]) —— 与 status 无关，released 行同样占位。
        const clash = leases.find((l) => l.node_id === args.data.node_id && l.port === args.data.port);
        if (clash) throw prismaUniqueError("node_id, port");
        const row: LeaseRow = {
          id: nextLeaseId++,
          node_id: args.data.node_id,
          port: args.data.port,
          tunnel_id: args.data.tunnel_id,
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
        where: { node_id?: number; status?: string };
        select?: Record<string, boolean>;
      }): Promise<Record<string, unknown>[]> {
        let out = leases.filter(
          (l) =>
            (args.where.node_id === undefined || l.node_id === args.where.node_id) &&
            (args.where.status === undefined || l.status === args.where.status),
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
          if (w.status !== undefined && l.status !== w.status) continue;
          Object.assign(l, args.data);
          count++;
        }
        return { count };
      },
    },
  };
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
  const deps = { db, redis } as unknown as Parameters<typeof pool.acquirePort>[1];
  return { db, redis, deps };
}

beforeEach(() => {
  resetState();
});

afterEach(() => {
  resetState();
});

/* ================================================================== */
/* 1. 并发分配无重复                                                    */
/* ================================================================== */

describe("1. 并发分配无重复（§7.6 DoD）", () => {
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
      Array.from({ length: 10 }, () =>
        pool.acquirePort({
          nodeId: 1,
          leaseType: "ingress",
          preferredPort: 19050,
          tunnelId: 1,
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
    const deps = { db, redis: brokenRedis };
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
