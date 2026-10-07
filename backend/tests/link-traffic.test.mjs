/**
 * Optional real MySQL lock/rollback test. Never uses ambient DATABASE_URL.
 * Requires an already migrated, dedicated loopback scratch database whose name
 * ends in _link_traffic_test, TUNEX_DB_TEST=1, and
 * TUNEX_LINK_TRAFFIC_TEST_DATABASE_URL. No migrations are applied by this test.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";

const enabled = process.env.TUNEX_DB_TEST === "1" && !!process.env.TUNEX_LINK_TRAFFIC_TEST_DATABASE_URL;
if (!enabled) {
  test("Link traffic MySQL concurrency/rollback (dedicated scratch DB required)", { skip: true }, () => {});
} else {
  const url = new URL(process.env.TUNEX_LINK_TRAFFIC_TEST_DATABASE_URL);
  if (url.protocol !== "mysql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/^\/[A-Za-z0-9_]+_link_traffic_test$/.test(url.pathname)) {
    throw new Error("Link traffic DB tests require a dedicated loopback *_link_traffic_test database");
  }
  const { PrismaClient } = await import("@prisma/client");
  const { createPrismaLinkTrafficStore, submitLinkTraffic } = await import("../src/services/link-traffic.ts");
  const client = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] });
  const store = createPrismaLinkTrafficStore(client);
  const workspaceId = randomInt(1_000_000_000, 1_100_000_000);
  const nodeId = randomInt(1_100_000_000, 1_200_000_000);
  const forwardIds = [randomInt(1_200_000_000, 1_300_000_000), randomInt(1_300_000_000, 1_400_000_000)];
  const producerIds = [randomBytes(16).toString("hex"), randomBytes(16).toString("hex")];
  const date = new Date("2037-11-01T00:00:00Z");
  let linkId;
  after(async () => {
    try {
      await client.linkTrafficCheckpoint.deleteMany({ where: { node_id: nodeId, workspace_id: workspaceId } });
      await client.tunnelTraffic.deleteMany({ where: { workspace_id: { in: [workspaceId, workspaceId + 1] },
        tunnel_id: { in: forwardIds } } });
      if (linkId) {
        await client.linkPlacement.deleteMany({ where: { deployment: { link_id: linkId } } });
        await client.linkDeployment.deleteMany({ where: { link_id: linkId } });
        await client.linkResource.delete({ where: { id: linkId } });
      }
    } finally { await client.$disconnect(); }
  });

  test("real native upsert/row locks dedupe concurrent reversed batches and roll back conflicting facts", async () => {
    const link = await client.linkResource.create({ data: {
      workspace_id: workspaceId, name: `traffic-test-${randomBytes(12).toString("hex")}`,
      created_by: 1, generation: 99, status: "retired",
    } });
    linkId = link.id;
    // No live Forward or Node is created. Historical ownership is sufficient,
    // including an expired/retired generation while the Link has moved on.
    await client.linkDeployment.create({ data: {
      link_id: linkId, generation: 2, version: 1, status: "retired", lease_expires_at: new Date("2020-01-01"),
      binding_snapshot: { spec: { link_id: linkId, workspace_id: workspaceId, generation: 2,
        ingress: { id: nodeId, workspace_id: workspaceId }, bindings: forwardIds.map((forward_id) => ({ forward_id })) } },
      placements: { create: [{ node_id: nodeId, role: "ingress", generation: 2,
        runtime_id: `traffic-test-${nodeId}`, config_digest: "ab".repeat(32) }] },
    } });
    const sample = (n, forward_id = forwardIds[0], producer_id = producerIds[0]) => ({
      node_id: nodeId, producer_id, forward_id, link_id: linkId, workspace_id: workspaceId,
      generation: 2, config_digest: "ab".repeat(32), date: "2037-11-01",
      bytes_in: String(n * 10), bytes_out: String(n * 20), connections: String(n),
    });
    const send = (samples) => submitLinkTraffic(nodeId, { samples }, { store });
    const requests = [9, 2, 8, 1, 9, 5, 3, 4, 7, 6].map((n) => {
      const batch = forwardIds.flatMap((forward) => producerIds.map((producer) => sample(n, forward, producer)));
      return send(n % 2 ? batch.reverse() : batch);
    });
    const results = await Promise.all(requests);
    assert.ok(results.every((result) => result.ok), "concurrent transactions should all commit");
    const rows = await client.linkTrafficCheckpoint.findMany({ where: { node_id: nodeId } });
    assert.equal(rows.length, 4);
    for (const row of rows) assert.deepEqual([row.bytes_in, row.bytes_out, row.connections], [90n, 180n, 9n]);
    const facts = await client.tunnelTraffic.findMany({ where: { workspace_id: workspaceId } });
    assert.equal(facts.length, 2);
    for (const fact of facts) assert.deepEqual([fact.traffic, fact.traffic_cost], [540, 540]);

    const old = sample(1);
    assert.deepEqual(await send([old]), { ok: true, accepted: [old] });
    const original = rows.find((row) => row.forward_id === old.forward_id && row.producer_id === old.producer_id);
    const staleRow = await client.linkTrafficCheckpoint.findUnique({ where: { id: original.id } });
    assert.equal(staleRow.updated_at.getTime(), original.updated_at.getTime());
    assert.deepEqual(await send([sample(10), { ...sample(10), forward_id: 1 }]),
      { ok: false, status: 403, reason: "link_traffic_not_owned" });

    await client.tunnelTraffic.update({ where: { tunnel_id_date: { tunnel_id: forwardIds[1], date } },
      data: { workspace_id: workspaceId + 1 } });
    assert.deepEqual(await send([sample(10, forwardIds[0]), sample(10, forwardIds[1])]),
      { ok: false, status: 409, reason: "link_traffic_identity_conflict" });
    const unchanged = await client.linkTrafficCheckpoint.findMany({ where: { node_id: nodeId } });
    for (const row of unchanged) assert.deepEqual([row.bytes_in, row.bytes_out, row.connections], [90n, 180n, 9n]);
    const firstFact = await client.tunnelTraffic.findUnique({ where: { tunnel_id_date: { tunnel_id: forwardIds[0], date } } });
    assert.equal(firstFact.traffic, 540, "the earlier daily increment rolled back with the later conflict");
    // Restore fixture attribution so cleanup only removes this test's rows.
    await client.tunnelTraffic.update({ where: { tunnel_id_date: { tunnel_id: forwardIds[1], date } },
      data: { workspace_id: workspaceId } });
    const restarted = sample(1, forwardIds[0], randomBytes(16).toString("hex"));
    assert.equal((await send([restarted, restarted])).ok, true);
    const afterRestart = await client.tunnelTraffic.findUnique({ where: { tunnel_id_date: { tunnel_id: forwardIds[0], date } } });
    assert.equal(afterRestart.traffic, 570);
  });
}
