import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  parseLinkPlacements, checkLinkPlacementOwnership, LINK_REPORT_MAX_ENTRIES,
  type ReportedLinkPlacement, type LinkPlacementOwnership,
} from "../node-state-report.ts";

const fact: ReportedLinkPlacement = {
  id: "tunex-link-8-p2-egress", link_id: 8, workspace_id: 7, node_id: 2, role: "egress",
  generation: 6, observed_generation: 5, config_digest: "b".repeat(64), desired_config_digest: "a".repeat(64),
  ready: true, state: "rolled_back", lease_expires_at: "2026-10-07T08:00:00.123456789Z",
  ports: [{ protocol: "tcp", host: "", port: 22000 }], runtime_ids: ["link-8-exit-tcp"],
};
const owner: LinkPlacementOwnership = {
  runtime_id: fact.id, node_id: 2, role: "egress", deployment: { link_id: 8, link: { workspace_id: 7 } },
};

describe("Link state report closed shape and ownership", () => {
  test("rollback stays distinct from desired generation, missing facts stay unknown", () => {
    expect(parseLinkPlacements([fact])).toEqual({ ok: true, placements: [fact] });
    expect(parseLinkPlacements(undefined)).toEqual({ ok: true, placements: null });
    expect(parseLinkPlacements([])).toEqual({ ok: true, placements: [] });
    expect(parseLinkPlacements(null).ok).toBe(false);
    expect(parseLinkPlacements([{ ...fact, ready: false, state: "cached", observed_generation: 0 }]).ok).toBe(true);
    expect(parseLinkPlacements([{ ...fact, ready: false, state: "removed", observed_generation: 0,
      config_digest: "", desired_config_digest: "", lease_expires_at: "", ports: [], runtime_ids: [] }]).ok).toBe(true);
  });
  test("rejects secret-bearing extras, malformed identity and unbounded facts", () => {
    for (const key of ["logs", "rawrunner", "runner_config", "transport_key", "key", "last_error", "pid"]) {
      expect(parseLinkPlacements([{ ...fact, [key]: "secret" }]).ok).toBe(false);
    }
    for (const patch of [
      { node_id: 0 }, { workspace_id: 2 ** 40 }, { generation: 0 }, { observed_generation: 7 },
      { config_digest: "secret" }, { role: "other" }, { state: "running-from-ack" }, { ready: true, state: "expired" },
      { lease_expires_at: "not-a-date" }, { runtime_ids: ["has whitespace"] }, { runtime_ids: ["duplicate", "duplicate"] },
      { ports: [{ protocol: "tcp", host: "", port: 22000, key: "secret" }] },
      { ports: [{ protocol: "udp", host: "", port: 65536 }] },
    ]) expect(parseLinkPlacements([{ ...fact, ...patch }]).ok).toBe(false);
    expect(parseLinkPlacements([fact, fact]).ok).toBe(false);
    expect(parseLinkPlacements(Array.from({ length: LINK_REPORT_MAX_ENTRIES + 1 }, () => fact)).ok).toBe(false);
    const large = Array.from({ length: 200 }, (_, n) => ({ ...fact, id: `placement-${n}`,
      runtime_ids: Array.from({ length: 100 }, (_, i) => `runtime-${i}-${"a".repeat(145)}`) }));
    expect(parseLinkPlacements(large).ok).toBe(false);
  });
  test("credential node and tenant claims must match a persisted placement owner", () => {
    expect(checkLinkPlacementOwnership([fact], 2, 7, [owner])).toEqual({ ok: true });
    expect(checkLinkPlacementOwnership([fact], 3, 7, [owner])).toMatchObject({ ok: false, reason: "link_placement_node_mismatch" });
    expect(checkLinkPlacementOwnership([fact], 2, 9, [owner])).toMatchObject({ ok: false, reason: "link_placement_workspace_mismatch" });
    for (const patch of [{ id: "another-placement" }, { link_id: 9 }, { role: "ingress" as const }]) {
      expect(checkLinkPlacementOwnership([{ ...fact, ...patch }], 2, 7, [owner]))
        .toMatchObject({ ok: false, reason: "link_placement_not_owned" });
    }
    expect(checkLinkPlacementOwnership([{ ...fact, workspace_id: 9 }], 2, 0, [owner]).ok).toBe(false);
    expect(checkLinkPlacementOwnership([fact], 2, 0, [owner]).ok).toBe(true);
  });
});

test("the authenticated inbound route validates and stores Link facts before accepting, old reports clear them", () => {
  const dbPath = fileURLToPath(new URL("../../db.ts", import.meta.url));
  const credentialPath = fileURLToPath(new URL("../node-credential.ts", import.meta.url));
  const routesPath = fileURLToPath(new URL("../../routes/internal-node.ts", import.meta.url));
  const scenario = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    process.env.AUTH_SECRET = "offline-link-report-test-only";
    process.env.DATABASE_URL = "mysql://unused:unused@127.0.0.1:1/unused";
    mock.module("ioredis", () => ({ default: class { on() { return this; } } }));
    const fact = ${JSON.stringify(fact)};
    const owner = ${JSON.stringify(owner)};
    let writes = [];
    let transactionActive = false;
    let owners = [owner];
    let readFails = false;
    let authed = true;
    const db = {
      linkPlacement: { findMany: async () => {
        assert.equal(transactionActive, true);
        if (readFails) throw new Error("offline ownership read failure");
        return owners;
      } },
      nodeStateReport: { upsert: async (input) => { writes.push(input); return input.create; } },
      placementLease: { updateMany: async () => ({ count: 0 }) },
      node: { updateMany: async () => ({ count: 1 }) },
      nodeGroup: { updateMany: async () => ({ count: 1 }) },
      $transaction: async (fn, options) => {
        assert.equal(options.isolationLevel, "Serializable");
        transactionActive = true;
        try { return await fn(db); } finally { transactionActive = false; }
      },
    };
    mock.module(${JSON.stringify(dbPath)}, () => ({ db }));
    const credentialModule = await import(${JSON.stringify(credentialPath)});
    mock.module(${JSON.stringify(credentialPath)}, () => ({ ...credentialModule,
      authenticateNode: async () => authed ? { ok: true, node_id: 2, scope: 7, agent_id: "agent-2" } : { ok: false, reason: "revoked" },
      hashNodeCredential: () => "offline-hash",
    }));
    const { internalNodeRoutes } = await import(${JSON.stringify(routesPath)});
    const request = (body) => internalNodeRoutes.request("/node/state", {
      method: "POST", headers: { authorization: "Bearer offline-test", "content-type": "application/json" }, body: JSON.stringify(body),
    });
    let response = await request({ agent_id: "agent-2", link_placements: [fact] });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(writes[0].update.link_placements, [fact]);
    assert.deepEqual(writes[0].create.link_placements, [fact]);
    const acceptedWrites = writes.length;
    for (const forged of [{ ...fact, node_id: 3 }, { ...fact, workspace_id: 9 }, { ...fact, link_id: 9 }, { ...fact, logs: ["secret"] }]) {
      response = await request({ link_placements: [forged] });
      assert.equal(response.status, 400);
      assert.equal(writes.length, acceptedWrites);
    }
    owners = [];
    response = await request({ link_placements: [fact] });
    assert.equal(response.status, 400);
    assert.equal(writes.length, acceptedWrites);
    readFails = true;
    response = await request({ link_placements: [fact] });
    assert.equal(response.status, 503);
    assert.equal(writes.length, acceptedWrites);
    readFails = false;
    response = await request({ agent_id: "agent-2" });
    assert.equal(response.status, 200);
    const { Prisma } = await import("@prisma/client");
    assert.equal(writes.at(-1).update.link_placements, Prisma.DbNull);
    response = await request({ link_placements: [] });
    assert.equal(response.status, 200);
    assert.deepEqual(writes.at(-1).update.link_placements, []);
    authed = false;
    response = await request({ link_placements: [fact] });
    assert.equal(response.status, 401);
    console.log("link-report-route-ok");
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", scenario], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
  expect(new TextDecoder().decode(child.stdout)).toContain("link-report-route-ok");
});
