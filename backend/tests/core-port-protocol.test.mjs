/**
 * Real MySQL gate for the single NodePortLease table and its allocator.
 * CI's test:integration glob includes this file after migrations/client generation.
 * Local syntax check: node --check tests/core-port-protocol.test.mjs
 * DB execution: TUNEX_DB_TEST=1 node --experimental-transform-types --test ...
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.TUNEX_DB_TEST !== "1") {
  test("core port protocol MySQL gate (requires TUNEX_DB_TEST=1)", { skip: true }, () => {});
} else {
  // Require an explicit CI/test database before importing any application module.
  // This is the same opt-in as the existing DB gates; never use a .env fallback.
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must name the migrated test database");
  assert.notEqual(process.env.NODE_ENV, "production", "DB fixtures must not run in production");
  const testUrl = new URL(process.env.DATABASE_URL);
  assert.equal(testUrl.protocol, "mysql:");
  assert.match(decodeURIComponent(testUrl.pathname), /(?:^|[_/-])(?:ci|test|verify)(?:[_/-]|$)/i,
    "DATABASE_URL must explicitly name a CI/test/verify database");
  testUrl.searchParams.set("connect_timeout", "3");
  testUrl.searchParams.set("pool_timeout", "5");
  testUrl.searchParams.set("connection_limit", "12");
  process.env.AUTH_SECRET ??= "test-only-auth-secret-must-not-be-used-in-production";
  process.env.PAYMENTS_ENABLED = "false";

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({
    datasources: { db: { url: testUrl.toString() } },
    transactionOptions: { maxWait: 5_000, timeout: 5_000 },
  });
  const { redis } = await import("../src/redis.ts");
  // The allocator's Redis lock is only an optimization. Disable it here so the
  // real MySQL range lock must protect both empty and populated socket scopes.
  redis.disconnect();
  const { acquirePort, releaseLease, reconcileLeases } = await import("../src/services/portPool.ts");
  const { collectReservedPorts } = await import("../src/services/scheduler-support.ts");
  const { db: applicationDb } = await import("../src/db.ts");

  const nonce = randomUUID().slice(0, 12);
  const created = { user: null, workspace: null, group: null, nodes: [], tunnels: [], links: [] };
  const noRedisLock = {
    async set() { return null; },
    async del() { return 0; },
    async scan() { return ["0", []]; },
  };
  let fixtureSeq = 0;

  // All fixtures use unique names and tracked IDs, as in the existing DB gates.
  // No whole-table cleanup or production reconciler run is permitted here.
  async function fixture(protocols = ["tcp", "udp", "tcp", "udp"]) {
    const label = `${nonce}-${++fixtureSeq}`;
    const node = await db.node.create({ data: {
      node_group_id: created.group.id, node_id: `core-port-${label}`,
      connect_ip: "127.0.0.1", role: "both", status: "active",
      port_range_min: 21000, port_range_max: 21020,
    } });
    created.nodes.push(node.id);
    const owners = [];
    for (const [index, protocol] of protocols.entries()) {
      const tunnel = await db.tunnel.create({ data: {
        name: `core-port-${label}-${index}`, tunnel_type: protocol === "udp" ? "udp" : "tcp",
        forward_protocol: protocol, forward_addresses: ["127.0.0.1:8080"], load_balance_type: "round",
        tunnel_mode: "direct", in_node_group_id: created.group.id,
        workspace_id: created.workspace.id, user_id: created.user.id, ingress_node_id: node.id,
      } });
      created.tunnels.push(tunnel.id);
      owners.push(tunnel);
    }
    // Acquisition and transactions use the real Prisma client. Only the outer
    // lease read is scoped, since reconcile otherwise scans unrelated fixtures.
    const scopedDb = {
      node: db.node, tunnel: db.tunnel,
      $transaction: (run, options) => db.$transaction(run, options),
      nodePortLease: {
        create: (args) => db.nodePortLease.create(args),
        findUnique: (args) => db.nodePortLease.findUnique(args),
        findMany: (args) => db.nodePortLease.findMany({ ...args,
          where: { AND: [args.where ?? {}, { node_id: node.id }] },
        }),
        update: (args) => db.nodePortLease.update(args),
        updateMany: (args) => db.nodePortLease.updateMany(args),
      },
    };
    const deps = { db: scopedDb, redis: noRedisLock, agentUsedPorts: async () => [] };
    return {
      node, owners, deps,
      acquire: (owner, extra = {}) => acquirePort({ nodeId: node.id, leaseType: "ingress",
        preferredPort: 21000, tunnelId: owner.id, protocol: owner.forward_protocol, ...extra }, deps),
      rows: (port = 21000) => db.nodePortLease.findMany({
        where: { node_id: node.id, port }, orderBy: { id: "asc" },
      }),
      async link() {
        const link = await db.linkResource.create({ data: {
          workspace_id: created.workspace.id, name: `core-port-link-${label}-${created.links.length}`,
          created_by: created.user.id,
        } });
        created.links.push(link.id);
        return link;
      },
    };
  }

  function allocated(outcome) {
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    return outcome.result;
  }
  function taken(outcome) {
    assert.equal(outcome.ok, false, JSON.stringify(outcome));
    assert.equal(outcome.code, "port_taken");
  }
  async function concurrent(requests) {
    // Settle every actual transaction before making assertions or cleaning up.
    const settled = await Promise.allSettled(requests);
    const rejected = settled.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 0,
      rejected.map((result) => result.reason?.message ?? String(result.reason)).join("\n"));
    return settled.map((result) => result.value);
  }

  describe("core port protocol / real NodePortLease", { concurrency: false, timeout: 60_000 }, () => {
    before(async () => {
      // One connection attempt with a bounded timeout, no readiness retry loop.
      await db.$connect();
      created.user = await db.user.create({ data: { email: `core-port-${nonce}@example.test` } });
      created.workspace = await db.workspace.create({ data: {
        slug: `core-port-${nonce}`, name: `core port ${nonce}`, kind: "team", created_by_id: created.user.id,
      } });
      created.group = await db.nodeGroup.create({ data: {
        name: `core-port-${nonce}`, node_type: "in", user_id: created.user.id,
        workspace_id: created.workspace.id,
      } });
    }, { timeout: 15_000 });

    after(async () => {
      try {
        if (created.nodes.length) await db.nodePortLease.deleteMany({ where: { node_id: { in: created.nodes } } });
        if (created.tunnels.length) await db.tunnel.deleteMany({ where: { id: { in: created.tunnels } } });
        if (created.links.length) await db.linkResource.deleteMany({ where: { id: { in: created.links } } });
        if (created.nodes.length) await db.node.deleteMany({ where: { id: { in: created.nodes } } });
        if (created.group) await db.nodeGroup.delete({ where: { id: created.group.id } });
        if (created.workspace) await db.workspace.delete({ where: { id: created.workspace.id } });
        if (created.user) await db.user.delete({ where: { id: created.user.id } });
      } finally {
        redis.disconnect();
        await Promise.all([db.$disconnect(), applicationDb.$disconnect()]);
      }
    }, { timeout: 30_000 });

    test("TCP and UDP concurrently acquire the same node and numeric port in either submission order", async () => {
      for (const protocols of [["tcp", "udp"], ["udp", "tcp"]]) {
        const f = await fixture(protocols);
        const results = await concurrent(f.owners.map((owner) => f.acquire(owner)));
        const leases = results.map(allocated);
        assert.equal(new Set(leases.map((lease) => lease.leaseId)).size, 2);
        assert.deepEqual(leases.map((lease) => lease.port), [21000, 21000]);
        const rows = await f.rows();
        assert.equal(rows.length, 2);
        assert.deepEqual(new Set(rows.map((row) => row.protocol)), new Set(["tcp", "udp"]));
        assert.ok(rows.every((row) => row.node_id === f.node.id && row.status === "active" && row.bind_scope === "*"));
      }
    });

    test("same protocol contenders admit exactly one owner, including TLS/WS sharing TCP", async () => {
      for (const protocols of [["tcp", "tls", "ws", "tcp", "tls", "ws"], Array(6).fill("udp")]) {
        const f = await fixture(protocols);
        const outcomes = await concurrent(f.owners.map((owner) => f.acquire(owner)));
        assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
        outcomes.filter((outcome) => !outcome.ok).forEach(taken);
        const rows = await f.rows();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].protocol, protocols[0]);
      }
    });

    test("wildcard IPv6 and concrete IP contenders overlap even when their unique keys differ", async () => {
      const scopes = [
        ["[::]", "127.0.0.1"], ["[::]", "[::1]"], ["127.0.0.1", "::"],
        ["::1", "::"], ["0.0.0.0", "::1"],
        ["[::ffff:127.0.0.1]", "127.0.0.1"], ["2001:db8::1", "[2001:0db8:0::1]"],
      ];
      for (const protocol of ["tcp", "udp"]) {
        const f = await fixture([protocol, protocol]);
        for (const [index, pair] of scopes.entries()) {
          const port = 21000 + index;
          const outcomes = await concurrent(pair.map((bindScope, owner) =>
            f.acquire(f.owners[owner], { preferredPort: port, bindScope })));
          assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1, `${protocol} ${pair}`);
          outcomes.filter((outcome) => !outcome.ok).forEach(taken);
          assert.equal((await f.rows(port)).length, 1);
        }
      }
    });

    test("different concrete IPv4/IPv6 scopes can acquire the same protocol and port", async () => {
      for (const protocol of ["tcp", "udp"]) {
        const f = await fixture([protocol, protocol, protocol]);
        const scopes = ["127.0.0.1", "127.0.0.2", "[::1]"];
        const outcomes = await concurrent(f.owners.map((owner, i) => f.acquire(owner, { bindScope: scopes[i] })));
        outcomes.forEach(allocated);
        assert.deepEqual(new Set((await f.rows()).map((row) => row.bind_scope)), new Set(["127.0.0.1", "127.0.0.2", "::1"]));
      }
    });

    test("released rows revive without releasing the other protocol or another concrete scope", async () => {
      const f = await fixture(["tcp", "udp", "tls", "tcp"]);
      const [tcp, udp] = (await concurrent([f.acquire(f.owners[0]), f.acquire(f.owners[1])])).map(allocated);
      assert.equal(await releaseLease({ leaseId: tcp.leaseId }, f.deps), true);
      assert.equal((await db.nodePortLease.findUniqueOrThrow({ where: { id: udp.leaseId } })).status, "active");
      const revived = allocated(await f.acquire(f.owners[2]));
      assert.equal(revived.leaseId, tcp.leaseId);
      assert.equal(revived.reused, true);
      assert.equal(revived.tunnelId, f.owners[2].id);
      assert.equal((await f.rows()).length, 2);

      const port = 21001;
      const first = allocated(await f.acquire(f.owners[0], { preferredPort: port, bindScope: "127.0.0.1" }));
      const other = allocated(await f.acquire(f.owners[3], { preferredPort: port, bindScope: "127.0.0.2" }));
      await releaseLease({ leaseId: first.leaseId }, f.deps);
      const mapped = allocated(await f.acquire(f.owners[2], { preferredPort: port, bindScope: "[::ffff:127.0.0.1]" }));
      assert.equal(mapped.leaseId, first.leaseId);
      assert.equal(mapped.bindScope, "127.0.0.1");
      assert.equal((await db.nodePortLease.findUniqueOrThrow({ where: { id: other.leaseId } })).status, "active");
      taken(await f.acquire(f.owners[0], { preferredPort: port, bindScope: "::" }));
    });

    test("same Link owner retries return one durable lease for automatic and preferred allocation", async () => {
      const f = await fixture();
      const link = await f.link();
      const request = { nodeId: f.node.id, leaseType: "ingress", linkId: link.id, protocol: "tcp", bindScope: "*" };
      const first = allocated(await acquirePort(request, f.deps));
      const retries = await concurrent(Array.from({ length: 6 }, (_, i) => acquirePort({ ...request,
        ...(i % 2 ? { preferredPort: first.port } : {}),
      }, f.deps)));
      for (const outcome of retries) {
        const result = allocated(outcome);
        assert.equal(result.leaseId, first.leaseId);
        assert.equal(result.port, first.port);
        assert.equal(result.linkId, link.id);
        assert.equal(result.tunnelId, null);
        assert.equal(result.reused, true);
      }
      assert.equal((await f.rows(first.port)).length, 1);
      const row = await db.nodePortLease.findUniqueOrThrow({ where: { id: first.leaseId } });
      assert.equal(row.tunnel_id, null);
      assert.equal(row.link_id, link.id);
      assert.equal(row.expires_at, null);
      taken(await f.acquire(f.owners[0], { preferredPort: first.port }));
    });

    test("reconcile retains Link claims with null tunnel_id and even expired TTL; Tunnel deletion cannot release them", async () => {
      const f = await fixture();
      const link = await f.link();
      const children = (await concurrent(["tcp", "udp"].map((protocol) => acquirePort({
        nodeId: f.node.id, leaseType: "ingress", linkId: link.id, protocol, preferredPort: 21000,
        expiresAt: protocol === "tcp" ? null : new Date(0),
      }, f.deps)))).map(allocated);
      const business = allocated(await f.acquire(f.owners[0], { preferredPort: 21001 }));
      assert.equal(await releaseLease({ tunnelId: f.owners[2].id }, f.deps), false);
      await db.tunnel.delete({ where: { id: f.owners[0].id } });
      assert.equal((await db.nodePortLease.findUniqueOrThrow({ where: { id: business.leaseId } })).tunnel_id, null);
      const dryRun = await reconcileLeases({ deps: f.deps, dryRun: true });
      assert.deepEqual(dryRun, { releasedDanglingTunnel: 0, releasedExpired: 1 });
      assert.deepEqual(await reconcileLeases({ deps: f.deps }), dryRun);
      assert.equal((await db.nodePortLease.findUniqueOrThrow({ where: { id: business.leaseId } })).status, "released");
      for (const child of children) {
        const row = await db.nodePortLease.findUniqueOrThrow({ where: { id: child.leaseId } });
        assert.equal(row.status, "active");
        assert.equal(row.link_id, link.id);
        assert.equal(row.tunnel_id, null);
      }
      // This gate has no runner processes. Only the explicit owner-retirement
      // release may free these children; production calls it after confirmed stop.
      assert.equal(await releaseLease({ linkId: link.id }, f.deps), true);
      assert.equal(await releaseLease({ linkId: link.id }, f.deps), false);
      assert.ok((await f.rows()).every((row) => row.status === "released"));
      allocated(await f.acquire(f.owners[1]));
    });

    test("scheduler reservedPorts uses actual persisted protocol/scope before flattening numeric ports", async () => {
      const f = await fixture(["tcp", "udp", "udp", "tcp"]);
      await db.tunnel.update({ where: { id: f.owners[0].id }, data: { listen_port: 21000, listen_ip: "127.0.0.1" } });
      allocated(await f.acquire(f.owners[0], { bindScope: "127.0.0.1" }));
      const readReserved = () => db.tunnel.findMany({ where: { id: { in: f.owners.map((owner) => owner.id) } },
        select: { id: true, listen_port: true, listen_ip: true, forward_protocol: true, tunnel_type: true },
      });
      let rows = await readReserved();
      const udpReserved = collectReservedPorts(rows, { protocol: "udp", bindScope: "*" });
      assert.ok(!udpReserved.includes(21000), "a TCP rule must not reserve the UDP namespace");
      allocated(await f.acquire(f.owners[1], { reservedPorts: udpReserved }));
      await db.tunnel.update({ where: { id: f.owners[1].id }, data: { listen_port: 21000, listen_ip: "*" } });
      rows = await readReserved();
      const sameProtocol = collectReservedPorts(rows.filter((row) => row.id !== f.owners[2].id), { protocol: "udp", bindScope: "*" });
      assert.ok(sameProtocol.includes(21000));
      taken(await f.acquire(f.owners[2], { reservedPorts: sameProtocol }));
      const otherScope = collectReservedPorts(rows, { protocol: "tcp", bindScope: "127.0.0.2" });
      assert.ok(!otherScope.includes(21000), "a disjoint literal scope must not be coarsely reserved");
      allocated(await f.acquire(f.owners[3], { bindScope: "127.0.0.2", reservedPorts: otherScope }));
      assert.equal((await f.rows()).length, 3);
    });

    test("unknown durable protocol and Agent facts conservatively reserve both namespaces", async () => {
      const f = await fixture();
      const unknown = allocated(await f.acquire(f.owners[0], { protocol: null }));
      assert.equal(unknown.protocol, "unknown");
      for (const protocol of ["tcp", "udp"]) {
        taken(await f.acquire(f.owners[1], { protocol }));
        taken(await acquirePort({ nodeId: f.node.id, leaseType: "ingress", preferredPort: 21001, protocol },
          { ...f.deps, agentUsedPorts: async () => [{ port: 21001 }] }));
      }
      assert.equal((await f.rows(21001)).length, 0);
    });
  });
}
