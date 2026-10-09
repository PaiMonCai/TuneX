import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("egress policy survives Agent startup restore", () => {
  test("pool override, node inheritance and the DB projection agree with live dispatch", () => {
    const dbPath = fileURLToPath(new URL("../../db.ts", import.meta.url));
    const busPath = fileURLToPath(new URL("../agent-command-bus.ts", import.meta.url));
    const linkPath = fileURLToPath(new URL("../link-resource.ts", import.meta.url));
    const scenario = `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      process.env.AUTH_SECRET = "offline-egress-strategy-test-only";
      process.env.DATABASE_URL = "mysql://unused:unused@127.0.0.1:1/unused";
      mock.module("ioredis", () => ({ default: class { on() { return this; } } }));
      let query;
      let desiredRows = [];
      let report = null;
      mock.module(${JSON.stringify(linkPath)}, () => ({ desiredNodeLinks: async () => [] }));
      mock.module(${JSON.stringify(dbPath)}, () => ({ db: {
        tunnel: { findMany: async (args) => { query = args; return desiredRows; } },
        forwardRevision: { findMany: async () => [] },
        placementLease: { findMany: async () => [] },
        federationLease: { findMany: async () => [] },
        nodeStateReport: { findUnique: async () => report },
        targetObservation: { findMany: async () => [] },
      } }));
      const { desiredTunnelConfigFor, buildDesiredNodeSnapshot } = await import(${JSON.stringify(busPath)});
      const row = {
        id: 42, tunnel_mode: "relay", desired_status: "active", config_revision: 9,
        forward_protocol: "tcp", tunnel_type: "tcp", ingress_node_id: 1, egress_node_id: 2,
        listen_port: 21010, listen_ip: null, remote_host: null, remote_port: null, egress_port: 23010,
        egress_node: { connect_ip: "127.0.0.1", lb_strategy: "weighted_round" },
        egress_pool: { lb_strategy: null, targets: [{ host: "127.0.0.1", port: 8080, weight: 3, order_by: 1 }] },
      };
      const cases = [
        [null, "weighted_round", "WEIGHTED_ROUND_ROBIN"],
        [null, "rand", "RANDOM"],
        [null, null, "ROUND_ROBIN"],
        ["round", "weighted_round", "ROUND_ROBIN"],
        ["weighted_round", "rand", "WEIGHTED_ROUND_ROBIN"],
        ["fallback", "rand", "FALLBACK"],
        [null, "fallback", "FALLBACK"],
        ["rand", "round", "RANDOM"],
      ];
      const facts = {
        protocolVersion: 2, capabilities: ["apply_tunnel"], capabilitiesMalformed: false, manifestMalformed: false,
        manifest: { schema_version: 2, protocols: ["tcp", "udp"], transports: ["stream", "datagram"], runtime: ["selector_fallback", "selector_ip_hash_client_ip"], diagnostics: [] },
      };
      for (const [pool, node, expected] of cases) {
        row.egress_pool.lb_strategy = pool;
        row.egress_node.lb_strategy = node;
        const result = desiredTunnelConfigFor(row, 2, new Map(), facts);
        assert.equal(result.kind, "config");
        assert.equal(result.config.lb_strategy, expected);
        assert.equal(result.config.targets[0].weight, 3);
        assert.equal(result.config.revision, 9);
      }
      assert.deepEqual((await buildDesiredNodeSnapshot(2)).tunnels, []);
      assert.equal(query.include.egress_node.select.lb_strategy, true);
      for (const protocol of ["tcp", "udp"]) {
        row.forward_protocol = protocol;
        row.egress_pool.lb_strategy = "ip_hash";
        for (const nodeId of [1, 2]) {
          assert.deepEqual(desiredTunnelConfigFor(row, nodeId, new Map(), facts), { kind: "skip", reason: "selector_client_ip_required" });
        }
      }
      row.forward_protocol = "tcp";
      row.egress_pool.lb_strategy = "fallback";
      assert.deepEqual(desiredTunnelConfigFor(row, 2), { kind: "skip", reason: "upgrade_required" });
      desiredRows = [row];
      let snapshot = await buildDesiredNodeSnapshot(2);
      assert.deepEqual(snapshot.tunnels, []);
      assert.deepEqual(snapshot.skipped, [{ id: 42, reason: "upgrade_required" }]);
      report = { control_protocol_version: 2, capabilities: facts.capabilities, capability_manifest: facts.manifest, reported_at: new Date(), node: { credential_rotated_at: null } };
      snapshot = await buildDesiredNodeSnapshot(2);
      assert.equal(snapshot.tunnels[0].lb_strategy, "FALLBACK");
      assert.deepEqual(snapshot.skipped, []);
      report.node.credential_rotated_at = new Date(report.reported_at.getTime() + 1);
      assert.deepEqual((await buildDesiredNodeSnapshot(2)).skipped, [{ id: 42, reason: "upgrade_required" }]);
      row.egress_pool.lb_strategy = "ip_hash";
      assert.deepEqual((await buildDesiredNodeSnapshot(2)).skipped, [{ id: 42, reason: "selector_client_ip_required" }]);
      console.log("egress-restore-ok");
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", scenario], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    expect(new TextDecoder().decode(child.stdout)).toContain("egress-restore-ok");
  });
});
