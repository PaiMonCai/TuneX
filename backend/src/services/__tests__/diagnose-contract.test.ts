/**
 * V4-WP11C — 命令通道的强绑定与只读契约。
 *
 * 这些测试针对的是"结果从哪里来、能不能被信任"：一个节点（或持有它凭据的人）
 * 不能用自己的回答去充当另一条命令的结果，诊断结果也必须完整覆盖请求的目标。
 */
import { describe, expect, test } from "bun:test";
import {
  dequeueAgentCommand,
  enqueueAgentCommand,
  matchExpectedTargets,
  normalizeDiagnoseResults,
  storeAgentCommandAck,
  waitAgentCommandAck,
  type CommandBusStore,
  type QueuedAgentCommand,
} from "../agent-command-bus.ts";
import { validatePayload } from "../control-protocol/index.ts";

function memoryStore(): CommandBusStore & { data: Map<string, string>; order: string[] } {
  const data = new Map<string, string>();
  return {
    data,
    order: [] as string[],
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); this.order.push(`set:${key}`); },
    async setIfAbsent(key, value) {
      if (data.has(key)) return null;
      data.set(key, value);
      this.order.push(`setnx:${key}`);
      return "OK";
    },
    async del(key) { data.delete(key); },
    async push(key, value) { data.set(key, value); this.order.push(`push:${key}`); },
    async shift(key) { const v = data.get(key) ?? null; data.delete(key); return v; },
  } as CommandBusStore & { data: Map<string, string>; order: string[] };
}

function envelope(over: Record<string, unknown> = {}) {
  return {
    command_id: "cmd-1",
    resource: "tunnel",
    resource_id: "tunex-7-direct",
    revision: 0,
    action: "diagnose_tunnel",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  } as never;
}

/**
 * Test-local enqueue: a fixed scope stands in for the node's workspace, so the
 * ordering and binding rules can be exercised without a database.
 */
const SCOPE = 11;

async function enqueue(
  store: CommandBusStore,
  probe: QueuedAgentCommand["probe"],
  over: { envelope?: never } = {},
): Promise<{ scope: number }> {
  const scope = SCOPE;
  return enqueueAgentCommand(1, over.envelope ?? envelope(), null, store, probe, { resolveScope: async () => scope });
}

describe("the pending ledger is written before the command is published", () => {
  test("a fast ACK cannot arrive before the binding exists", async () => {
    const store = memoryStore();
    await enqueue(store, { targets: [{ host: "t", port: 1 }] }, {});
    const pendingWrite = store.order.findIndex((o) => o.startsWith("set:"));
    const queueWrite = store.order.findIndex((o) => o.startsWith("push:"));
    expect(pendingWrite).toBeGreaterThanOrEqual(0);
    expect(pendingWrite).toBeLessThan(queueWrite);
  });

  test("a queue failure does not leave a binding behind", async () => {
    const store = memoryStore();
    store.push = async () => { throw new Error("redis down"); };
    await expect(enqueue(store, null)).rejects.toThrow("redis down");
    // No binding ⇒ no ACK can ever be accepted for a command that never existed.
    await expect(storeAgentCommandAck(SCOPE, 1, {
      command_id: "cmd-1", ok: true, results: [{ host: "t", port: 1, status: "reachable", elapsed_ms: 1 }],
    }, store)).rejects.toThrow(/unknown or expired/);
  });
});

describe("an ACK must actually answer the command that was issued", () => {
  test("a mismatched action or resource id is refused", async () => {
    const store = memoryStore();
    await enqueue(store, { targets: [{ host: "t", port: 1 }] }, {});
    await expect(storeAgentCommandAck(SCOPE, 1, {
      command_id: "cmd-1", action: "apply_tunnel", ok: true,
      results: [{ host: "t", port: 1, status: "reachable", elapsed_ms: 1 }],
    } as never, store)).rejects.toThrow(/action/);
    await expect(storeAgentCommandAck(SCOPE, 1, {
      command_id: "cmd-1", resource_id: "tunex-99-direct", ok: true,
      results: [{ host: "t", port: 1, status: "reachable", elapsed_ms: 1 }],
    } as never, store)).rejects.toThrow(/resource_id/);
  });

  test("an answer after the command expired is not evidence", async () => {
    const store = memoryStore();
    await enqueue(store, { targets: [{ host: "t", port: 1 }] },
      { envelope: envelope({ expires_at: new Date(Date.now() - 1000).toISOString() }) });
    await expect(storeAgentCommandAck(SCOPE, 1, {
      command_id: "cmd-1", ok: true,
      results: [{ host: "t", port: 1, status: "reachable", elapsed_ms: 1 }],
    }, store)).rejects.toThrow(/expir/i);
  });

  test("a diagnose answer must cover exactly the requested targets", async () => {
    const store = memoryStore();
    await enqueue(store, { targets: [{ host: "a", port: 1 }, { host: "b", port: 2 }] });
    // Only one of the two targets: reading this as "all good" is the failure mode
    // the match exists to prevent.
    await expect(storeAgentCommandAck(SCOPE, 1, {
      command_id: "cmd-1", ok: true, results: [{ host: "a", port: 1, status: "reachable", elapsed_ms: 1 }],
    }, store)).rejects.toThrow(/missing target/);
  });

  test("an answer about a target nobody asked for is refused", async () => {
    const store = memoryStore();
    await enqueue(store, { targets: [{ host: "a", port: 1 }] });
    await expect(storeAgentCommandAck(SCOPE, 1, {
      command_id: "cmd-1", ok: true, results: [{ host: "evil", port: 22, status: "reachable", elapsed_ms: 1 }],
    }, store)).rejects.toThrow(/unrequested target/);
  });

  test("an OK diagnose with no results at all is refused", async () => {
    const store = memoryStore();
    await enqueue(store, { targets: [{ host: "a", port: 1 }] });
    await expect(storeAgentCommandAck(SCOPE, 1, { command_id: "cmd-1", ok: true }, store))
      .rejects.toThrow(/no results/);
  });

  test("a complete, matching answer is accepted and delivered", async () => {
    const store = memoryStore();
    const { scope } = await enqueue(store, { targets: [{ host: "a", port: 1 }, { host: "b", port: 2 }] });
    await storeAgentCommandAck(scope, 1, {
      command_id: "cmd-1", ok: true,
      results: [
        { host: "a", port: 1, status: "reachable", elapsed_ms: 3 },
        { host: "b", port: 2, status: "refused", elapsed_ms: 9 },
      ],
    }, store);
    const ack = await waitAgentCommandAck(scope, 1, "cmd-1", 500, store);
    expect(ack.results).toHaveLength(2);
    expect(ack.results?.[1].status).toBe("refused");
  });
});

describe("result matching helper", () => {
  test("accepts an exact cover and rejects every deviation", () => {
    const want = [{ host: "a", port: 1 }, { host: "b", port: 2 }];
    const r = (host: string, port: number) => ({ host, port, status: "reachable", elapsed_ms: 1 });
    expect(matchExpectedTargets(want, [r("a", 1), r("b", 2)])).toBeNull();
    expect(matchExpectedTargets(want, [r("A", 1), r("b", 2)])).toBeNull(); // host case-insensitive
    expect(matchExpectedTargets(want, [r("a", 1)])).toMatch(/missing/);
    expect(matchExpectedTargets(want, [r("a", 1), r("a", 1)])).toMatch(/missing|duplicate/);
    expect(matchExpectedTargets(want, [r("a", 1), r("b", 2), r("c", 3)])).toMatch(/unrequested/);
  });
});

describe("the diagnose payload is part of the frozen contract", () => {
  test("well-formed payloads pass and malformed ones are refused", () => {
    expect(validatePayload("diagnose_tunnel", { targets: [{ host: "a", port: 1 }] })).toBeNull();
    expect(validatePayload("diagnose_tunnel", { targets: [{ host: "a", port: 1 }], timeout_ms: 3000 })).toBeNull();
    expect(validatePayload("diagnose_tunnel", {})).toMatch(/targets/);
    expect(validatePayload("diagnose_tunnel", { targets: [] })).toMatch(/非空/);
    expect(validatePayload("diagnose_tunnel", { targets: [{ host: "", port: 1 }] })).toMatch(/host/);
    expect(validatePayload("diagnose_tunnel", { targets: [{ host: "a", port: 0 }] })).toMatch(/port/);
    expect(validatePayload("diagnose_tunnel", { targets: [{ host: "a", port: 1, extra: 1 }] })).toMatch(/未定义字段/);
    expect(validatePayload("diagnose_tunnel", { targets: [{ host: "a", port: 1 }], timeout_ms: 999999 })).toMatch(/timeout_ms/);
    expect(validatePayload("diagnose_tunnel", { targets: [{ host: "a", port: 1 }], nope: 1 })).toMatch(/未定义字段/);
    const many = Array.from({ length: 9 }, (_v, i) => ({ host: `h${i}`, port: 1 }));
    expect(validatePayload("diagnose_tunnel", { targets: many })).toMatch(/上限/);
  });
});

describe("normalizeDiagnoseResults still bounds the answer", () => {
  test("caps items, validates ports and statuses, bounds detail", () => {
    expect(normalizeDiagnoseResults(null)).toBeNull();
    expect(normalizeDiagnoseResults([])).toEqual([]);
    expect(() => normalizeDiagnoseResults({} as never)).toThrow(/array/);
    expect(() => normalizeDiagnoseResults([{ host: "a", port: 0, status: "reachable", elapsed_ms: 1 }])).toThrow(/port/);
    const one = normalizeDiagnoseResults([{ host: "a", port: 1, status: "reachable", elapsed_ms: 1, detail: "x".repeat(900) }]);
    expect(one?.[0].detail?.length).toBe(160);
  });
});

describe("queue round trip", () => {
  test("the item carries the probe next to the envelope", async () => {
    const store = memoryStore();
    await enqueue(store, { targets: [{ host: "a", port: 1 }], timeout_ms: 3000 });
    const item = await dequeueAgentCommand(SCOPE, 1, store) as QueuedAgentCommand;
    expect(item.probe?.targets).toEqual([{ host: "a", port: 1 }]);
    expect(item.config).toBeNull();
  });
});
