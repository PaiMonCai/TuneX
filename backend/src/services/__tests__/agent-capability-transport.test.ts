/**
 * V4-WP11B — 下发前的协商闸门（真实 transport 路径）。
 *
 * 判定逻辑本身在 agent-capability-v4.test.ts 里逐条覆盖；这里证明的是**它真的
 * 挂在生产下发路径上**：能力不支持时必须在下发之前就失败，而且不产生任何队列
 * 写入（否则节点侧会收到一条它只会回 `unsupported_action` 的命令，超时被误诊
 * 为网络问题）。
 */
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { OutboundAgentTransport, type CommandBusStore } from "../agent-command-bus.ts";
import type { AgentV2CapabilityFacts } from "../runtime-admission.ts";

/**
 * V5-WP1: the outbound gate now consumes the v2 fact set (actions + manifest),
 * so the V4-shaped literals below are widened with the manifest defaults an
 * Agent that never reported one produces. The V4 assertions themselves are
 * unchanged — that is the point of this file.
 */
function v2Facts(partial: {
  capabilities: string[] | null;
  protocolVersion: number | null;
  capabilitiesMalformed?: boolean;
  manifest?: AgentV2CapabilityFacts["manifest"];
  manifestMalformed?: boolean;
}): AgentV2CapabilityFacts {
  return {
    capabilitiesMalformed: false,
    manifest: null,
    manifestMalformed: false,
    ...partial,
  };
}

/** Records every write so the test can prove nothing was queued. */
function memoryStore() {
  const writes: string[] = [];
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const store: CommandBusStore = {
    async get(key) {
      return values.get(key) ?? null;
    },
    async del(key) {
      writes.push(`del:${key}`);
      values.delete(key);
      lists.delete(key);
      return 1;
    },
    async push(key, value, ttlSeconds) {
      void ttlSeconds;
      writes.push(`push:${key}`);
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
    },
    async set(key, value, ttlSeconds) {
      void ttlSeconds;
      writes.push(`set:${key}`);
      values.set(key, value);
    },
    async setIfAbsent(key, value, ttlSeconds) {
      void ttlSeconds;
      writes.push(`nx:${key}`);
      if (values.has(key)) return null;
      values.set(key, value);
      return "OK";
    },
    async shift(key) {
      const list = lists.get(key) ?? [];
      return list.shift() ?? null;
    },
  };
  return { store, writes };
}

const node = { id: 7, node_id: "n7", connect_ip: null, role: null } as never;
const config = { id: "tunex-1-direct" } as never;
const envelope = {
  command_id: "cmd-1",
  action: "apply_tunnel",
  resource_id: "tunex-1-direct",
  revision: 3,
} as never;

function transportFor(facts: AgentV2CapabilityFacts | null | (() => never)) {
  const { store, writes } = memoryStore();
  const loader = typeof facts === "function"
    ? (async () => facts()) as unknown as (nodeId: number) => Promise<AgentV2CapabilityFacts | null>
    : (async () => facts) as unknown as (nodeId: number) => Promise<AgentV2CapabilityFacts | null>;
  return { transport: new OutboundAgentTransport(loader, store), writes };
}

describe("WP11B outbound capability gate", () => {
  test("a non-baseline action is refused when the agent advertised nothing", async () => {
    const { transport, writes } = transportFor(v2Facts({ capabilities: null, protocolVersion: null }));
    await expect(
      transport.applyDirect(node, config, { ...(envelope as object), action: "diagnose_forward" } as never),
    ).rejects.toThrow(/未上报控制协议能力/);
    // The refusal must happen before anything is queued.
    expect(writes).toEqual([]);
  });

  test("a non-baseline action is refused when the agent reported a short list", async () => {
    const { transport, writes } = transportFor(v2Facts({ capabilities: ["apply_tunnel"], protocolVersion: 1 }));
    await expect(
      transport.applyDirect(node, config, { ...(envelope as object), action: "drain_node" } as never),
    ).rejects.toThrow(/未实现 drain_node/);
    expect(writes).toEqual([]);
  });

  test("an explicitly advertised action queues and consumes a matching ACK", () => {
    // The positive path reaches scope lookup AND waits for an Agent ACK. A
    // store that never answers cannot prove admission by catching any error.
    const scenario = `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      mock.module("ioredis", () => ({ default: class { on() { return this; } } }));
      let scopeReads = 0;
      mock.module(${JSON.stringify(fileURLToPath(new URL("../../db.ts", import.meta.url)))}, () => ({ db: {
        node: { findUnique: async () => { scopeReads++; return { node_group: { workspace_id: 1 } }; } },
      } }));
      const { OutboundAgentTransport } = await import(${JSON.stringify(fileURLToPath(new URL("../agent-command-bus.ts", import.meta.url)))});
      const ledger = new Map();
      let queued;
      const store = {
        get: async (key) => ledger.get(key) ?? null,
        del: async (key) => ledger.delete(key),
        set: async (key, value) => { ledger.set(key, value); },
        setIfAbsent: async (key, value) => { ledger.set(key, value); return "OK"; },
        shift: async () => null,
        push: async (key, value) => {
          queued = JSON.parse(value);
          ledger.set(key.replace(/:queue$/, ":ack:" + queued.envelope.command_id),
            JSON.stringify({ command_id: queued.envelope.command_id, ok: true, applied_revision: 3 }));
        },
      };
      const facts = ${JSON.stringify(v2Facts({ capabilities: ["apply_tunnel"], protocolVersion: 1 }))};
      const transport = new OutboundAgentTransport(async () => facts, store);
      assert.deepEqual(await transport.applyDirect(${JSON.stringify(node)}, ${JSON.stringify(config)}, ${JSON.stringify(envelope)}),
        { ok: true, applied_revision: 3 });
      assert.equal(scopeReads, 1);
      assert.equal(queued.envelope.command_id, "cmd-1");
      assert.equal(queued.envelope.action, "apply_tunnel");
      assert.equal(ledger.size, 0, "the matching ACK and pending record were consumed");
      console.log("capability-admission-ack-ok");
    `;
    const child = Bun.spawnSync([process.execPath, "--eval", scenario], {
      stdout: "pipe", stderr: "pipe", timeout: 5000,
    });
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
    expect(new TextDecoder().decode(child.stdout)).toContain("capability-admission-ack-ok");
  });

  test("unparseable stored capabilities are refused instead of degrading to baseline", async () => {
    // A corrupt stored value must not become "never reported": that would turn a
    // fail-closed case into a baseline pass. V5-WP1 represents the corruption as
    // an explicit flag on the fact object (so freshness can still be evaluated),
    // and the gate must honour it exactly like the V4 throw did.
    const { transport, writes } = transportFor(
      v2Facts({ capabilities: null, protocolVersion: 1, capabilitiesMalformed: true }),
    );
    await expect(transport.applyDirect(node, config, envelope)).rejects.toThrow(/未实现 apply_tunnel/);
    expect(writes).toEqual([]);
  });

  test("a fact read that fails outright is refused, not silently treated as baseline", async () => {
    // The loader throwing means "these facts are unusable"; degrading to baseline
    // here would dispatch to a binary nobody has described.
    const { transport, writes } = transportFor(() => {
      throw new TypeError("capabilities must be an array of strings");
    });
    await expect(transport.applyDirect(node, config, envelope)).rejects.toThrow(/能力上报无法读取/);
    expect(writes).toEqual([]);
  });

  test("an empty advertisement refuses even the baseline actions", async () => {
    const { transport, writes } = transportFor(v2Facts({ capabilities: [], protocolVersion: 1 }));
    await expect(transport.applyDirect(node, config, envelope)).rejects.toThrow(/未实现 apply_tunnel/);
    expect(writes).toEqual([]);
  });
});
