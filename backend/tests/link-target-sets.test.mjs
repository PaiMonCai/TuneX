/**
 * Real F2/F3 persistence gate. Requires an already migrated, dedicated loopback
 * *_link_target_sets_test database, TUNEX_DB_TEST=1 and the explicit URL below.
 * Never loads .env, falls back to ambient DATABASE_URL, or applies migrations.
 * Run with node --experimental-transform-types --test tests/link-target-sets.test.mjs.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const enabled = process.env.TUNEX_DB_TEST === "1" && !!process.env.TUNEX_LINK_TARGET_SETS_TEST_DATABASE_URL;
if (!enabled) {
  test("Link target sets MySQL persistence (dedicated scratch DB required)", { skip: true }, () => {});
} else {
  const url = new URL(process.env.TUNEX_LINK_TARGET_SETS_TEST_DATABASE_URL);
  if (process.env.NODE_ENV === "production" || url.protocol !== "mysql:"
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/^\/[A-Za-z0-9_]+_link_target_sets_test$/.test(url.pathname)) {
    throw new Error("Link target set DB tests require a dedicated loopback *_link_target_sets_test database outside production");
  }
  url.searchParams.set("connect_timeout", "3");
  url.searchParams.set("pool_timeout", "5");
  url.searchParams.set("connection_limit", "4");
  // Bind all application imports to the same guarded database, even if CI has
  // an unrelated ambient URL. All revision calls additionally receive a real tx.
  process.env.DATABASE_URL = url.href;
  process.env.AUTH_SECRET ??= "link-target-set-test-only-auth-secret";
  const { Prisma, PrismaClient } = await import("@prisma/client");
  const options = { datasources: { db: { url: url.href } }, log: [],
    transactionOptions: { maxWait: 5_000, timeout: 10_000 } };
  const client = new PrismaClient(options);
  const previousPrisma = globalThis.__tunexPrisma;
  globalThis.__tunexPrisma = client;
  const created = { user: null, workspace: null, group: null, nodes: [], link: null, tunnels: [] };
  after(async () => {
    try {
      if (created.tunnels.length) await client.tunnel.deleteMany({ where: { id: { in: created.tunnels } } });
      if (created.link) await client.linkResource.delete({ where: { id: created.link.id } });
      if (created.nodes.length) await client.node.deleteMany({ where: { id: { in: created.nodes } } });
      if (created.group) await client.nodeGroup.delete({ where: { id: created.group.id } });
      if (created.workspace) await client.workspace.delete({ where: { id: created.workspace.id } });
      if (created.user) await client.user.delete({ where: { id: created.user.id } });
    } finally {
      await client.$disconnect();
      if (globalThis.__tunexPrisma === client) globalThis.__tunexPrisma = previousPrisma;
    }
  });
  const { createForwardRevision, ensureForwardBaselineRevision, currentDesiredConfig } =
    await import("../src/services/forward-revision.ts");
  const { compileFxpLink } = await import("../src/integrations/forwardx/link-compiler.ts");
  const { persistedLinkTargetSet } = await import("../src/integrations/forwardx/target-set.ts");
  const { persistedLinkClientSource } = await import("../src/integrations/forwardx/client-source.ts");
  const nonce = randomUUID();
  const completeSet = { version: 1,
    targets: [{ host: "primary.example", port: 443 },
      ...Array.from({ length: 9 }, (_, i) => ({ host: `backup-${i}.example`, port: 8443 + i }))],
    strategy: "fallback", failure_seconds: 10, recover_seconds: 3600, probe: "tcp" };
  const targetFacts = (set) => set
    ? set.targets.map((target, order_by) => ({ ...target, weight: 1, order_by }))
    : [{ host: completeSet.targets[0].host, port: completeSet.targets[0].port, weight: 1, order_by: 1000 }];

  function tunnelData(label, extra = {}) {
    return { name: `target-set-${nonce}-${label}`, workspace_id: created.workspace.id,
      user_id: created.user.id, in_node_group_id: created.group.id, out_node_group_id: created.group.id,
      category: "port_forward", tunnel_type: "tcp", forward_protocol: "both", tunnel_mode: "relay",
      link_resource_id: created.link.id, ingress_node_id: created.nodes[0], egress_node_id: created.nodes[1],
      forward_addresses: [], load_balance_type: "round", listen_ip: "127.0.0.1", listen_port: 26000,
      remote_host: completeSet.targets[0].host, remote_port: completeSet.targets[0].port,
      egress_port: 25000, desired_status: "active", apply_status: "pending", config_revision: 0, ...extra };
  }
  function revisionInput(row, set, status = "active", expectedRevision = row.config_revision ?? 0) {
    return { tunnelId: row.id, link_resource_id: created.link.id, expectedRevision,
      desiredStatus: status, createdById: created.user.id, resolvedListenIp: row.listen_ip, egressPort: 25000,
      candidate: { name: row.name, mode: "relay", protocol: row.forward_protocol, link_resource_id: created.link.id,
        ingress_node_id: created.nodes[0], egress_node_id: created.nodes[1], listen_port: row.listen_port,
        target_host: row.remote_host, target_port: row.remote_port,
        ...(set === undefined ? {} : { target_set: structuredClone(set) }) } };
  }
  async function createForward(label, set) {
    const id = await client.$transaction(async (tx) => {
      const row = await tx.tunnel.create({ data: tunnelData(label) });
      const written = await createForwardRevision(revisionInput(row, set), tx);
      assert.equal(written.revision, 1);assert.equal(written.wroteSnapshot, true);
      return row.id;
    });
    created.tunnels.push(id);
    return id;
  }
  async function write(id, set, status = "active", expectedRevision) {
    const row = await client.tunnel.findUniqueOrThrow({ where: { id } });
    return client.$transaction((tx) => createForwardRevision(revisionInput(row, set, status, expectedRevision), tx));
  }
  async function readFacts(id, reader = client) {
    return { row: await reader.tunnel.findUniqueOrThrow({ where: { id } }),
      revisions: await reader.forwardRevision.findMany({ where: { tunnel_id: id }, orderBy: { revision: "asc" } }) };
  }
  async function assertComplete(id, set, status = "active", reader = client) {
    const { row, revisions } = await readFacts(id, reader);
    const snapshot = revisions.find((r) => r.id === row.desired_revision_id);
    assert.ok(snapshot, "the desired pointer resolves to a committed immutable snapshot");
    assert.equal(snapshot.revision, row.config_revision);
    assert.deepEqual(row.link_target_config, set ?? null);
    assert.deepEqual(snapshot.link_target_config, set ?? null);
    assert.deepEqual(snapshot.targets, targetFacts(set), "all ordered targets survive the JSON round trip");
    assert.equal(row.desired_status, status);assert.equal(snapshot.desired_status, status);
    assert.equal(row.remote_host, completeSet.targets[0].host);assert.equal(row.remote_port, completeSet.targets[0].port);
    assert.equal(snapshot.target_host, row.remote_host);assert.equal(snapshot.target_port, row.remote_port);
    for (const fact of [row, snapshot]) {
      assert.equal(fact.link_resource_id, created.link.id);
      assert.equal(fact.ingress_node_id, created.nodes[0]);assert.equal(fact.egress_node_id, created.nodes[1]);
      assert.equal(fact.egress_pool_id, null);assert.equal(fact.forward_protocol ?? fact.protocol, row.forward_protocol);
    }
    assert.deepEqual(row.forward_addresses, []);
    const desired = currentDesiredConfig(row);
    if (set) assert.deepEqual(desired.target_set, set);
    else assert.equal("target_set" in desired, false, "NULL legacy rows stay single-target without inventing a set");
    return { row, snapshot, revisions, desired };
  }
  function recoverConfig(id, binding) {
    const endpoint = { workspace_id: created.workspace.id, connect_host: "127.0.0.1",
      version: "0.0.0-dev", capabilities: ["forward.link.fxp.v1", "forward.targets.fxp.v1", "forward.client-source.fxp.v1"] };
    return compileFxpLink({ link_id: created.link.id, workspace_id: created.workspace.id, version: 1, generation: 1,
      ingress: { ...endpoint, id: created.nodes[0] }, egress: { ...endpoint, id: created.nodes[1] },
      carrier_port: 25000, lease_expires_at: "2037-01-01T00:00:00Z", bindings: [{ forward_id: id,
        protocol: binding.protocol, listen_port: binding.listen_port, listen_host: "127.0.0.1",
        target_host: binding.target_host, target_port: binding.target_port,
        ...(binding.target_set === undefined ? {} : { target_set: binding.target_set }),
        ...(binding.client_source === undefined ? {} : { client_source: binding.client_source }) }] }, "ab".repeat(32));
  }
  function snapshotBinding(snapshot) {
    return { protocol: snapshot.protocol, listen_port: snapshot.listen_port,
      target_host: snapshot.target_host, target_port: snapshot.target_port,
      target_set: persistedLinkTargetSet(snapshot.link_target_config),
      client_source: persistedLinkClientSource(snapshot.link_source_config) };
  }

  test("real F2 revision transactions preserve immutable target sets, projections and recovery", { timeout: 60_000 }, async (t) => {
    await client.$connect();
    created.user = await client.user.create({ data: { email: `target-set-${nonce}@example.test` } });
    created.workspace = await client.workspace.create({ data: { slug: `target-set-${nonce}`,
      name: `target sets ${nonce}`, kind: "team", created_by_id: created.user.id } });
    created.group = await client.nodeGroup.create({ data: { name: `target-set-${nonce}`, node_type: "in",
      workspace_id: created.workspace.id, user_id: created.user.id } });
    for (const role of ["ingress", "egress"]) {
      const node = await client.node.create({ data: { node_id: `target-set-${nonce}-${role}`,
        node_group_id: created.group.id, connect_ip: "127.0.0.1", role } });
      created.nodes.push(node.id);
    }
    created.link = await client.linkResource.create({ data: { workspace_id: created.workspace.id,
      name: `target-set-${nonce}`, created_by: created.user.id } });

    await t.test("ten ordered targets and all strategies survive create, edit, suspension and resume", async () => {
      for (const strategy of ["fallback", "round_robin", "random"]) {
        const initial = { ...structuredClone(completeSet), strategy, probe: strategy === "random" ? "none" : "tcp" };
        const id = await createForward(strategy, initial);
        const first = await assertComplete(id, initial);
        const edited = structuredClone(initial);
        edited.targets[1].host = "edited-backup.example";
        [edited.targets[2], edited.targets[9]] = [edited.targets[9], edited.targets[2]];
        await write(id, edited);
        const second = await assertComplete(id, edited);
        assert.equal(second.row.config_revision, 2);
        assert.deepEqual(second.revisions[0], first.snapshot, "backup edits cannot mutate the previous revision");
        await write(id, edited, "inactive");await assertComplete(id, edited, "inactive");
        const suspendedEdit = { ...structuredClone(edited), failure_seconds: 3600, recover_seconds: 10 };
        suspendedEdit.targets[9].port++;
        await write(id, suspendedEdit, "inactive");await assertComplete(id, suspendedEdit, "inactive");
        // The writer defensively preserves a stored set on omission. Public
        // service edits must reject omission; that boundary is tested in Bun.
        await write(id, undefined, "active");
        const resumed = await assertComplete(id, suspendedEdit);
        assert.equal(resumed.row.config_revision, 5);
        assert.deepEqual(resumed.revisions[0], first.snapshot);
        assert.deepEqual(resumed.revisions[1], second.snapshot);

        const restarted = new PrismaClient(options);
        try {
          const recovered = await assertComplete(id, suspendedEdit, "active", restarted);
          const config = recoverConfig(id, recovered.desired);
          const snapshotConfig = recoverConfig(id, snapshotBinding(recovered.snapshot));
          assert.deepEqual(config, snapshotConfig, "fresh-connection desired and revision facts compile the same complete configuration");
          assert.deepEqual(config.egress.runner_config.targetSets[0].targets, suspendedEdit.targets);
          assert.equal(config.egress.runner_config.allowedBindings.length, 20);
          assert.deepEqual(config.ingress.runner_config.entries[0].targetSet.targets, suspendedEdit.targets);
          const oldConfig = recoverConfig(id, snapshotBinding(first.snapshot));
          assert.deepEqual(oldConfig.egress.runner_config.targetSets[0].targets, initial.targets);
          assert.notEqual(config.egress.config_digest, oldConfig.egress.config_digest);
          assert.notEqual(config.ingress.config_digest, oldConfig.ingress.config_digest);
        } finally { await restarted.$disconnect(); }
      }
    });


    await t.test("F3 TCP source canonicalization, immutable snapshots, explicit disable, CAS, rollback and reconnect", async () => {
      const hashSet = { ...structuredClone(completeSet), strategy: "ip_hash" };
      const rawSource = { version: 1, receive_proxy: true,
        trusted_cidrs: ["192.0.2.129/24", "2001:0DB8:1234:5678::1/48"], send_proxy: "v2" };
      const canonical = { ...rawSource, trusted_cidrs: ["192.0.2.0/24", "2001:db8:1234::/48"] };
      const disabled = { version: 1, receive_proxy: false, trusted_cidrs: [], send_proxy: "off" };
      const sourceInput = (row, source, status = "active", expectedRevision = row.config_revision) => {
        const input = revisionInput(row, hashSet, status, expectedRevision);
        if (source !== undefined) input.candidate.client_source = structuredClone(source);
        return input;
      };
      const id = await client.$transaction(async (tx) => {
        const row = await tx.tunnel.create({ data: tunnelData("source", { forward_protocol: "tcp" }) });
        await createForwardRevision(sourceInput(row, rawSource), tx);
        return row.id;
      });
      created.tunnels.push(id);
      const sourceFacts = async (expected, status = "active", reader = client, forwardId = id) => {
        const facts = await assertComplete(forwardId, hashSet, status, reader);
        assert.deepEqual(facts.row.link_source_config, expected);
        assert.deepEqual(facts.snapshot.link_source_config, expected);
        assert.deepEqual(facts.desired.client_source, expected);
        const compiled = recoverConfig(forwardId, facts.desired);
        const restored = recoverConfig(forwardId, snapshotBinding(facts.snapshot));
        assert.deepEqual(compiled, restored);
        const runtime = { version: 1, receiveProxy: expected.receive_proxy,
          trustedCIDRs: expected.trusted_cidrs, sendProxy: expected.send_proxy };
        assert.deepEqual(compiled.ingress.runner_config.entries[0].clientSource, runtime);
        assert.deepEqual(compiled.egress.runner_config.clientSources, [{ ...runtime, ruleId: forwardId }]);
        assert.equal(compiled.egress.runner_config.allowedBindings.length, 10);
        assert.equal(compiled.egress.runner_config.targetSets[0].strategy, "ip_hash");
        return facts;
      };
      const initial = await sourceFacts(canonical);
      const edit = async (source, status = "active", expectedRevision) => {
        const row = await client.tunnel.findUniqueOrThrow({ where: { id } });
        return client.$transaction(tx => createForwardRevision(sourceInput(row, source, status, expectedRevision), tx));
      };
      const beforeInvalid = await readFacts(id);
      for (const invalid of [{...canonical,trusted_cidrs:["192.0.2.1/24","192.0.2.129/24"]},
        {...canonical,trusted_cidrs:["::ffff:192.0.2.1/104"]}]) {
        await assert.rejects(() => edit(invalid));
        assert.deepEqual(await readFacts(id), beforeInvalid);
      }
      const changed = { ...canonical, send_proxy: "v1" };
      await edit(changed); const edited = await sourceFacts(changed);
      assert.deepEqual(edited.revisions[0], initial.snapshot);
      assert.notEqual(recoverConfig(id, initial.desired).ingress.config_digest, recoverConfig(id, edited.desired).ingress.config_digest);
      assert.notEqual(recoverConfig(id, initial.desired).egress.config_digest, recoverConfig(id, edited.desired).egress.config_digest);
      await edit(undefined, "inactive");await sourceFacts(changed, "inactive");
      await edit(disabled, "inactive");await sourceFacts(disabled, "inactive");
      await edit(undefined);const resumed = await sourceFacts(disabled);
      assert.deepEqual(resumed.revisions[0], initial.snapshot);

      const before = await readFacts(id);
      await assert.rejects(() => edit(rawSource, "active", 0), e => e.code === "revision_conflict");
      assert.deepEqual(await readFacts(id), before);
      await assert.rejects(() => client.$transaction(async tx => {
        await createForwardRevision(sourceInput(before.row, rawSource), tx);
        const pending = await sourceFacts(canonical, "active", tx);
        assert.equal(pending.row.config_revision, before.row.config_revision + 1);
        throw Error("client_source_transaction_rollback");
      }), /client_source_transaction_rollback/);
      assert.deepEqual(await readFacts(id), before);

      const restarted = new PrismaClient(options);
      try { await sourceFacts(disabled, "active", restarted); } finally { await restarted.$disconnect(); }

      const baselineRow = await client.tunnel.create({ data: tunnelData("source-baseline", {
        forward_protocol: "tcp", link_target_config: hashSet, link_source_config: canonical,
        config_revision: 7, applied_revision: 7, desired_revision_id: null, apply_status: "active" }) });
      created.tunnels.push(baselineRow.id);
      const desiredBefore = currentDesiredConfig(baselineRow);
      const baseline = await client.$transaction(tx => ensureForwardBaselineRevision(baselineRow.id, created.user.id, tx));
      assert.equal(baseline.created, true);assert.equal(baseline.revision, 7);
      const frozen = await sourceFacts(canonical, "active", client, baselineRow.id);
      assert.deepEqual(frozen.desired, desiredBefore);
      assert.equal(frozen.row.applied_revision, 7);assert.equal(frozen.row.config_revision, 7);
      assert.deepEqual(await client.$transaction(tx => ensureForwardBaselineRevision(baselineRow.id, created.user.id, tx)),
        { ...baseline, created: false });
      await client.$transaction(tx => createForwardRevision(sourceInput(frozen.row, disabled), tx));
      const next = await sourceFacts(disabled, "active", client, baselineRow.id);
      assert.deepEqual(next.revisions[0], frozen.snapshot);assert.equal(next.row.config_revision, 8);
    });

    await t.test("stale CAS and an aborted transaction leave neither partial config nor orphan snapshots", async () => {
      const id = await createForward("rollback", completeSet);
      const before = await readFacts(id);
      const edited = structuredClone(completeSet);edited.targets[1].port++;
      await assert.rejects(() => write(id, edited, "active", 0), (e) => e.code === "revision_conflict");
      assert.deepEqual(await readFacts(id), before);
      await assert.rejects(() => client.$transaction(async (tx) => {
        await createForwardRevision(revisionInput(before.row, edited), tx);
        const pending = await tx.tunnel.findUniqueOrThrow({ where: { id } });
        assert.deepEqual(pending.link_target_config, edited);
        const snapshot = await tx.forwardRevision.findUniqueOrThrow({ where: { id: pending.desired_revision_id } });
        assert.deepEqual(snapshot.targets, targetFacts(edited));
        throw new Error("target_set_transaction_rollback");
      }), /target_set_transaction_rollback/);
      assert.deepEqual(await readFacts(id), before, "projection, revision pointer and immutable JSON roll back together");
      const written = await write(id, edited, "active", 1);
      assert.equal(written.revision, 2);await assertComplete(id, edited);
      assert.deepEqual((await readFacts(id)).revisions[0], before.revisions[0]);
    });

    await t.test("baseline freezes the complete set without advancing desired/config and stays immutable after edits", async () => {
      const row = await client.tunnel.create({ data: tunnelData("baseline", {
        link_target_config: completeSet, config_revision: 4, applied_revision: 4,
        desired_revision_id: null, apply_status: "active" }) });
      created.tunnels.push(row.id);
      const desiredBefore = currentDesiredConfig(row);
      const baseline = await client.$transaction((tx) => ensureForwardBaselineRevision(row.id, created.user.id, tx));
      assert.equal(baseline.created, true);assert.equal(baseline.revision, 4);
      const frozen = await assertComplete(row.id, completeSet);
      assert.equal(frozen.row.config_revision, 4);assert.equal(frozen.row.applied_revision, 4);
      assert.deepEqual(frozen.desired, desiredBefore);
      const again = await client.$transaction((tx) => ensureForwardBaselineRevision(row.id, created.user.id, tx));
      assert.deepEqual(again, { ...baseline, created: false });
      assert.deepEqual(await readFacts(row.id), { row: frozen.row, revisions: frozen.revisions });
      const edited = structuredClone(completeSet);edited.targets[9].host = "post-baseline.example";
      await write(row.id, edited);
      const next = await assertComplete(row.id, edited);
      assert.equal(next.row.config_revision, 5);assert.equal(next.row.applied_revision, 4);
      assert.deepEqual(next.revisions[0], frozen.snapshot);
    });

    await t.test("legacy SQL NULL and JSON null read as single-target and baseline/write keep compatibility columns", async () => {
      for (const [label, value] of [["sql-null", Prisma.DbNull], ["json-null", Prisma.JsonNull]]) {
        const row = await client.tunnel.create({ data: tunnelData(label, { link_target_config: value, link_source_config: value,
          config_revision: 3, applied_revision: 3, apply_status: "active" }) });
        created.tunnels.push(row.id);
        assert.equal(persistedLinkTargetSet(row.link_target_config), undefined);
        assert.equal("target_set" in currentDesiredConfig(row), false);
        assert.equal(persistedLinkClientSource(row.link_source_config), undefined);
        assert.equal("client_source" in currentDesiredConfig(row), false);
        const baseline = await client.$transaction((tx) => ensureForwardBaselineRevision(row.id, created.user.id, tx));
        assert.equal(baseline.created, true);
        const legacy = await assertComplete(row.id, undefined);
        assert.equal(legacy.row.config_revision, 3);
        await write(row.id, undefined, "inactive");
        const suspended = await assertComplete(row.id, undefined, "inactive");
        assert.equal(suspended.row.config_revision, 4);
        assert.deepEqual(suspended.revisions[0], legacy.snapshot);
        const config = recoverConfig(row.id, suspended.desired);
        assert.equal(config.egress.runner_config.targetSets, undefined);
        assert.equal(config.egress.runner_config.allowedBindings.length, 2);
        assert.equal(config.ingress.runner_config.entries[0].targetSet, undefined);
        assert.equal(config.ingress.runner_config.entries[0].clientSource, undefined);
        assert.equal(config.egress.runner_config.clientSources, undefined);
        assert.equal(suspended.row.link_source_config, null);assert.equal(suspended.snapshot.link_source_config, null);
      }
    });
  });
}
