import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

describe("final outbound selector gate", () => {
  test("bypassing Orchestrator cannot queue an unsupported selector, advertised fallback gets an ACK", () => {
    const dbPath = fileURLToPath(new URL("../../db.ts", import.meta.url));
    const busPath = fileURLToPath(new URL("../agent-command-bus.ts", import.meta.url));
    const scenario = `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      process.env.AUTH_SECRET = "offline-selector-transport-only";
      process.env.DATABASE_URL = "mysql://unused:unused@127.0.0.1:1/unused";
      mock.module("ioredis", () => ({ default: class { on() { return this; } } }));
      let scopeReads = 0;
      mock.module(${JSON.stringify(dbPath)}, () => ({ db: {
        node: { findUnique: async () => { scopeReads++; return { node_group: { workspace_id: 1 } }; } },
      } }));
      const { OutboundAgentTransport } = await import(${JSON.stringify(busPath)});
      let facts = null;
      const writes = [];
      let queued;
      const store = {
        get: async () => JSON.stringify({ command_id: "selector-test", ok: true, applied_revision: 3 }),
        del: async () => 1,
        set: async (key, value) => { writes.push(key); },
        push: async (key, value) => { writes.push(key); queued = JSON.parse(value); },
        setIfAbsent: async () => "OK",
        shift: async () => null,
      };
      const transport = new OutboundAgentTransport(async () => facts, store);
      const node = { id: 2, node_id: "exit", connect_ip: null, role: "egress" };
      const envelope = { command_id: "selector-test", action: "apply_tunnel", resource_id: "tunex-1-egress", revision: 3 };
      const config = { id: "tunex-1-egress", mode: "EGRESS", protocol: "tcp", lb_strategy: "FALLBACK" };
      await assert.rejects(transport.applyEgress(node, config, envelope), /upgrade_required/);
      assert.equal(writes.length, 0);
      facts = { protocolVersion: 2, capabilities: ["apply_tunnel"], capabilitiesMalformed: false, manifestMalformed: false,
        manifest: { schema_version: 2, protocols: ["tcp", "udp"], transports: ["stream", "datagram"], runtime: ["selector_fallback", "selector_ip_hash_client_ip"], diagnostics: [] } };
      for (const mode of ["DIRECT", "RELAY", "EGRESS"]) {
        for (const protocol of ["tcp", "udp"]) {
          await assert.rejects(transport.applyDirect(node, { ...config, mode, protocol, lb_strategy: "IP_HASH" }, envelope), /selector_client_ip_required/);
        }
      }
      assert.equal(writes.length, 0);
      assert.equal(scopeReads, 0);
      facts.manifest.runtime = [];
      await assert.rejects(transport.applyEgress(node, config, envelope), /runtime_feature_not_supported/);
      assert.equal(writes.length, 0);
      facts.manifest.runtime = ["selector_fallback"];
      assert.deepEqual(await transport.applyEgress(node, config, envelope), { ok: true, applied_revision: 3 });
      assert.equal(writes.length, 2);
      assert.equal(queued.config.lb_strategy, "FALLBACK");
      assert.equal(scopeReads, 1);
      console.log("selector-transport-ok");
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", scenario], { stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    expect(new TextDecoder().decode(child.stdout)).toContain("selector-transport-ok");
  });
});
