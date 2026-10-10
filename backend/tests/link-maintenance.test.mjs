/** Real MySQL intent/fence/transaction contracts, not Agent or browser acceptance. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const enabled = process.env.TUNEX_DB_TEST === "1" && !!process.env.TUNEX_LINK_TARGET_SETS_TEST_DATABASE_URL;
if (!enabled) {
  test("F5 durable maintenance MySQL (dedicated scratch DB required)", { skip: true }, () => {});
} else {
  const url = new URL(process.env.TUNEX_LINK_TARGET_SETS_TEST_DATABASE_URL);
  if (process.env.NODE_ENV === "production" || url.protocol !== "mysql:"
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/^\/[A-Za-z0-9_]+_link_target_sets_test$/.test(url.pathname)) {
    throw new Error("F5 DB tests require dedicated loopback *_link_target_sets_test database outside production");
  }
  const { Prisma, PrismaClient } = await import("@prisma/client");
  const client = new PrismaClient({ datasources: { db: { url: url.href } }, log: [],
    transactionOptions: { maxWait: 5000, timeout: 10000 } });
  const { canonicalConfigDigest } = await import("../src/integrations/forwardx/core-contract.ts");
  const { closeMaintenanceIntent, currentMaintenanceIntent } = await import("../src/services/link-maintenance-guard.ts");
  const nonce = randomUUID();
  const links = [];
  after(async () => {
    try {
      await client.linkMaintenanceEvent.deleteMany({ where: { migration: { link_id: { in: links } } } });
      await client.linkMaintenanceMigration.deleteMany({ where: { link_id: { in: links } } });
      await client.linkResource.deleteMany({ where: { id: { in: links } } });
    } finally { await client.$disconnect(); }
  });
  const base = { schema_version: 1, immutable: { suspended_revision: 3, target: "fixture.example" } };
  const data = (linkId, key = randomUUID()) => ({ link_id: linkId, workspace_id: 3, created_by: 8,
    idempotency_key: key, request_digest: "ab".repeat(32), operation: "rotate_key", active_link_id: linkId,
    expected_version: 2, expected_generation: 4, state_token: "cd".repeat(32),
    snapshot: base, snapshot_digest: canonicalConfigDigest(base), hold_expires_at: new Date(Date.now() + 300_000) });
  const locked = (linkId, run) => client.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM link_resource WHERE id=${linkId} FOR UPDATE`);
    return run(tx);
  });
  let linkId, rowId;
  test("F5 fixture creates isolated Links without changing an existing deployment", async () => {
    for (let i = 0; i < 2; i++) links.push((await client.linkResource.create({ data: {
      workspace_id: 3, created_by: 8, name: `f5-intent-db-${nonce}-${i}` } })).id);
    linkId = links[0];
  });
  test("same-key concurrent submissions serialize to one record and one event", async () => {
    const key = randomUUID();
    const publish = () => locked(linkId, async (tx) => {
      const existing = await tx.linkMaintenanceMigration.findUnique({ where: { link_id_idempotency_key: { link_id: linkId, idempotency_key: key } } });
      if (existing) return existing;
      return tx.linkMaintenanceMigration.create({ data: { ...data(linkId, key),
        events: { create: { state_version: 1, status: "awaiting_executor", created_by: 8 } } } });
    });
    const results = await Promise.all([publish(), publish(), publish(), publish()]);
    rowId = results[0].id;
    assert.ok(results.every((r) => r.id === rowId));
    assert.equal(await client.linkMaintenanceMigration.count({ where: { link_id: linkId } }), 1);
    assert.equal(await client.linkMaintenanceEvent.count({ where: { migration_id: rowId } }), 1);
    assert.deepEqual((await client.linkMaintenanceMigration.findUniqueOrThrow({ where: { id: rowId } })).snapshot, base);
  });
  test("DB unique fence and CHECK reject a second intent or false terminal state", async () => {
    await assert.rejects(() => client.linkMaintenanceMigration.create({ data: data(linkId) }), (e) => e.code === "P2002");
    await assert.rejects(() => client.linkMaintenanceMigration.create({ data: { ...data(links[1]), active_link_id: null } }));
    await assert.rejects(() => client.linkMaintenanceMigration.create({ data: { ...data(links[1]), status: "completed" } }));
    await assert.rejects(() => client.linkMaintenanceMigration.create({ data: { ...data(links[1]), status: "cancelled" } }));
    assert.equal(await client.linkMaintenanceMigration.count({ where: { link_id: links[1] } }), 0);
  });
  test("state CAS accepts only one closer and retains immutable facts", async () => {
    const close = () => locked(linkId, async (tx) => {
      const row = await tx.linkMaintenanceMigration.findUniqueOrThrow({ where: { id: rowId } });
      if (row.state_version !== 1) return false;
      await closeMaintenanceIntent(tx, row, "cancelled", "link_maintenance_cancelled", 8, new Date());
      return true;
    });
    assert.deepEqual((await Promise.all([close(), close()])).sort(), [false, true]);
    const final = await client.linkMaintenanceMigration.findUniqueOrThrow({ where: { id: rowId } });
    assert.equal(final.state_version, 2);assert.equal(final.active_link_id, null);assert.deepEqual(final.snapshot, base);
    assert.equal(await client.linkMaintenanceEvent.count({ where: { migration_id: rowId } }), 2);
    const next = await client.linkMaintenanceMigration.create({ data: data(linkId) });
    assert.notEqual(next.id, rowId);
  });
  test("record/event failure rolls back both, and expiry recovers the logical fence only", async () => {
    const before = await client.linkMaintenanceMigration.count({ where: { link_id: links[1] } });
    await assert.rejects(() => locked(links[1], async (tx) => {
      const row = await tx.linkMaintenanceMigration.create({ data: data(links[1]) });
      await tx.linkMaintenanceEvent.createMany({ data: [1, 1].map((version) => ({ migration_id: row.id, state_version: version, status: "awaiting_executor" })) });
    }), (e) => e.code === "P2002");
    assert.equal(await client.linkMaintenanceMigration.count({ where: { link_id: links[1] } }), before);
    const row = await client.linkMaintenanceMigration.create({ data: { ...data(links[1]), hold_expires_at: new Date(0) } });
    assert.equal(await locked(links[1], (tx) => currentMaintenanceIntent(tx, links[1])), null);
    const expired = await client.linkMaintenanceMigration.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(expired.status, "expired");assert.equal(expired.state_version, 2);assert.equal(expired.active_link_id, null);
    assert.equal(await client.linkVersion.count({ where: { link_id: { in: links } } }), 0);
    assert.equal(await client.linkDeployment.count({ where: { link_id: { in: links } } }), 0);
    assert.equal(await client.nodePortLease.count({ where: { link_id: { in: links } } }), 0);
  });
}
