import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  createPrismaLinkTrafficStore, LinkTrafficError, LINK_TRAFFIC_MAX_BODY_BYTES,
  linkTrafficDate, readLinkTrafficBody, submitLinkTraffic,
  type LinkTrafficCheckpoint, type LinkTrafficDeployment, type LinkTrafficSample,
  type LinkTrafficStore, type LinkTrafficTransaction,
} from "../link-traffic.ts";

const sample = (over: Partial<LinkTrafficSample> = {}): LinkTrafficSample => ({
  producer_id: "12".repeat(16), link_id: 7, workspace_id: 3, node_id: 11,
  forward_id: 41, generation: 2, config_digest: "ab".repeat(32), date: "2026-11-01",
  bytes_in: "100", bytes_out: "200", connections: "3", ...over,
});
function deployment(over: Partial<LinkTrafficDeployment> = {}): LinkTrafficDeployment {
  return {
    link_id: 7, generation: 2, link: { workspace_id: 3 },
    binding_snapshot: { spec: { link_id: 7, workspace_id: 3, generation: 2,
      ingress: { id: 11, workspace_id: 3 }, bindings: [{ forward_id: 41 }, { forward_id: 42 }] } },
    placements: [
      { node_id: 11, role: "ingress", generation: 2, config_digest: "ab".repeat(32) },
      { node_id: 12, role: "egress", generation: 2, config_digest: "cd".repeat(32) },
    ], ...over,
  };
}

/** Transactional storage, including rollback/commit failure and serialized lock contention.
 * No live Tunnel/Forward table exists: querying one cannot silently make these tests pass.
 */
function memoryStore() {
  let checkpoints = new Map<string, LinkTrafficCheckpoint>();
  let daily = new Map<string, { workspace_id: number; traffic: number; traffic_cost: number }>();
  let queue = Promise.resolve();
  const history = new Map<string, LinkTrafficDeployment>([["7:2", deployment()]]);
  const events: string[] = [];
  let receiptClock = 0;
  const store = {
    history, events,
    failure: null as "read" | "checkpoint" | "daily" | "commit" | null,
    failDailyAt: 0,
    get checkpoints() { return checkpoints; },
    get daily() { return daily; },
    async transaction<T>(work: (tx: LinkTrafficTransaction) => Promise<T>): Promise<T> {
      let release!: () => void;
      const previous = queue;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const rows = structuredClone(checkpoints);
      const facts = structuredClone(daily);
      let dailyStarted = false;
      let dailyWrites = 0;
      const locked = new Set<number>();
      try {
        const result = await work({
          async findDeployment(linkId, generation) {
            events.push("history");
            if (store.failure === "read") throw new Error("read failed");
            return structuredClone(history.get(`${linkId}:${generation}`) ?? null);
          },
          async lockCheckpoint(nodeId, input, date) {
            assert.equal(dailyStarted, false, "all checkpoint locks precede daily fact locks");
            events.push(`lock:${nodeId}:${input.producer_id}:${input.forward_id}:${input.date}`);
            const key = `${nodeId}:${input.producer_id}:${input.forward_id}:${input.date}`;
            if (!rows.has(key)) rows.set(key, { id: rows.size + 1, node_id: nodeId,
              producer_id: input.producer_id, forward_id: input.forward_id, date,
              link_id: input.link_id, workspace_id: input.workspace_id, generation: input.generation,
              config_digest: input.config_digest, bytes_in: 0n, bytes_out: 0n, connections: 0n,
              updated_at: new Date("2026-11-01T00:00:00Z") });
            const row = rows.get(key)!;
            locked.add(row.id);
            return structuredClone(row);
          },
          async updateCheckpoint(id, totals) {
            assert.ok(locked.has(id));
            if (store.failure === "checkpoint") throw new Error("checkpoint write failed");
            const row = [...rows.values()].find((row) => row.id === id)!;
            Object.assign(row, totals);
            row.updated_at = new Date(Date.UTC(2026, 10, 1) + ++receiptClock * 1000);
            events.push("checkpoint");
          },
          async incrementDailyTraffic(forwardId, workspaceId, date, bytes) {
            dailyStarted = true;
            const key = `${forwardId}:${date.toISOString().slice(0, 10)}`;
            const fact = facts.get(key) ?? { workspace_id: workspaceId, traffic: 0, traffic_cost: 0 };
            if (fact.workspace_id !== workspaceId) throw new LinkTrafficError("link_traffic_identity_conflict", 409);
            fact.traffic += Number(bytes);
            fact.traffic_cost += Number(bytes);
            facts.set(key, fact);
            events.push("daily");
            if (store.failure === "daily" || (++dailyWrites === store.failDailyAt)) throw new Error("daily write failed");
          },
        });
        if (store.failure === "commit") throw new Error("commit failed");
        checkpoints = rows;
        daily = facts;
        events.push("commit");
        return result;
      } finally { release(); }
    },
  };
  return store;
}
const send = (store: LinkTrafficStore, samples: unknown[], nodeId = 11) => submitLinkTraffic(nodeId, { samples }, { store });
const fact = (store: ReturnType<typeof memoryStore>, forward = 41, day = "2026-11-01") => store.daily.get(`${forward}:${day}`)!;
const totals = (store: ReturnType<typeof memoryStore>) => [...store.checkpoints.values()][0]!;

describe("Link traffic accounting with injected transactional storage", () => {
  test("same-day deltas sum both byte directions once; replay/stale ACKs echo exact inputs", async () => {
    const store = memoryStore();
    const first = sample();
    assert.deepEqual(await send(store, [first]), { ok: true, accepted: [first] });
    assert.deepEqual(fact(store), { workspace_id: 3, traffic: 300, traffic_cost: 300 });
    await send(store, [first, first]);
    const next = sample({ bytes_in: "130", bytes_out: "250", connections: "4" });
    await send(store, [next]);
    assert.equal(fact(store).traffic, 380);
    assert.deepEqual(await send(store, [first]), { ok: true, accepted: [first] });
    assert.equal(fact(store).traffic_cost, 380);
    assert.equal(totals(store).bytes_in, 130n);
    assert.equal(totals(store).bytes_out, 250n);
    assert.equal(totals(store).connections, 4n);
    const connectionsOnly = sample({ bytes_in: "130", bytes_out: "250", connections: "8" });
    await send(store, [connectionsOnly]);
    assert.equal(totals(store).connections, 8n);
    assert.equal(fact(store).traffic, 380);
  });

  test("a decrease in ANY field makes the whole row stale, including mixed resets", async () => {
    for (const lower of [{ bytes_in: "99", bytes_out: "500", connections: "10" },
      { bytes_in: "500", bytes_out: "199", connections: "10" },
      { bytes_in: "500", bytes_out: "500", connections: "2" }]) {
      const store = memoryStore();
      await send(store, [sample()]);
      const stale = sample(lower);
      assert.deepEqual(await send(store, [stale]), { ok: true, accepted: [stale] });
      assert.equal(fact(store).traffic, 300);
      assert.deepEqual([totals(store).bytes_in, totals(store).bytes_out, totals(store).connections], [100n, 200n, 3n]);
    }
  });

  test("receipt timestamp refreshes on equal/zero accepted samples but not any stale sample", async () => {
    const store = memoryStore();
    const zero = sample({ bytes_in: "0", bytes_out: "0", connections: "0" });
    await send(store, [zero]);
    const first = totals(store).updated_at.getTime();
    await send(store, [zero]);
    assert.ok(totals(store).updated_at.getTime() > first);
    await send(store, [sample()]);
    const current = totals(store).updated_at.getTime();
    await send(store, [sample({ bytes_in: "99", bytes_out: "500" })]);
    assert.equal(totals(store).updated_at.getTime(), current);
    await send(store, [sample()]);
    assert.ok(totals(store).updated_at.getTime() > current);
    assert.equal(fact(store).traffic, 300);
  });

  test("out-of-order concurrent requests and overlapping reversed batches count only high water marks", async () => {
    const store = memoryStore();
    const requests = [9, 2, 8, 1, 9, 5, 3, 4, 7, 6].map((n) => {
      const a = sample({ bytes_in: String(n * 10), bytes_out: String(n * 20), connections: String(n) });
      const b = sample({ forward_id: 42, producer_id: "34".repeat(16), bytes_in: String(n * 10), bytes_out: String(n * 20), connections: String(n) });
      return send(store, n % 2 === 0 ? [a, b] : [b, a]);
    });
    const results = await Promise.all(requests);
    assert.ok(results.every((result) => result.ok));
    assert.equal(store.checkpoints.size, 2);
    assert.equal(fact(store, 41).traffic, 270);
    assert.equal(fact(store, 42).traffic_cost, 270);
    assert.equal(store.events.filter((event) => event === "commit").length, requests.length);
  });

  test("new producer after restart adds a new epoch; next Shanghai day is independent", async () => {
    const store = memoryStore();
    await send(store, [sample()]);
    const restarted = sample({ producer_id: "34".repeat(16), bytes_in: "10", bytes_out: "20", connections: "1" });
    await send(store, [restarted, restarted]);
    const tomorrow = sample({ date: "2026-11-02", bytes_in: "5", bytes_out: "10", connections: "1" });
    await send(store, [tomorrow, tomorrow]);
    assert.equal(store.checkpoints.size, 3);
    assert.equal(fact(store).traffic, 330);
    assert.equal(fact(store, 41, "2026-11-02").traffic_cost, 15);
  });

  test("F1 rotates producers without a deployment change; lost ACK and replay after local reclamation keep both epochs", async () => {
    const store = memoryStore();
    const oldStart = sample({ producer_id: randomBytes(16).toString("hex") });
    const newStart = sample({ producer_id: randomBytes(16).toString("hex"),
      bytes_in: "5", bytes_out: "10", connections: "1" });
    assert.notEqual(newStart.producer_id, oldStart.producer_id);
    const oldFinal = { ...oldStart, bytes_in: "130", bytes_out: "250", connections: "4" };
    const newFinal = { ...newStart, bytes_in: "15", bytes_out: "25", connections: "2" };
    // Only local snapshot retention is modeled here; the real receiver owns all accounting.
    const localSnapshots = new Map([[oldFinal.producer_id, oldFinal]]);
    const delayedRetry = structuredClone(oldFinal);
    assert.deepEqual(await send(store, [oldStart, newStart]), { ok: true, accepted: [oldStart, newStart] });
    assert.equal(fact(store).traffic, 315);

    store.failure = "commit";
    assert.deepEqual(await send(store, [oldFinal]),
      { ok: false, status: 503, reason: "link_traffic_storage_failure" });
    assert.ok(localSnapshots.has(oldFinal.producer_id), "an uncommitted final snapshot remains pending");
    assert.equal(fact(store).traffic, 315);
    store.failure = null;
    // The transaction commits, but the caller loses the response and retains its sealed snapshot.
    await send(store, [oldFinal]);
    assert.equal(fact(store).traffic, 395, "the old epoch tail commits before its ACK is received");
    assert.ok(localSnapshots.has(oldFinal.producer_id));
    assert.deepEqual(await send(store, [newFinal]), { ok: true, accepted: [newFinal] });
    assert.deepEqual(await send(store, [localSnapshots.get(oldFinal.producer_id)!]),
      { ok: true, accepted: [oldFinal] }, "retry returns the exact committed final snapshot");
    localSnapshots.delete(oldFinal.producer_id);
    assert.equal(localSnapshots.size, 0);
    assert.equal(store.checkpoints.size, 2, "local reclamation must leave both DB high-water marks intact");

    assert.deepEqual(await send(store, [delayedRetry, oldStart, newFinal]),
      { ok: true, accepted: [delayedRetry, oldStart, newFinal] });
    assert.deepEqual(fact(store), { workspace_id: 3, traffic: 420, traffic_cost: 420 },
      "both epoch finals count once even after a delayed retry of the reclaimed snapshot");
    for (const [producer, expected] of [[oldFinal.producer_id, [130n, 250n, 4n]],
      [newFinal.producer_id, [15n, 25n, 2n]]] as const) {
      const row = store.checkpoints.get(`11:${producer}:41:2026-11-01`)!;
      assert.deepEqual([row.bytes_in, row.bytes_out, row.connections], expected);
      assert.equal(row.generation, 2);
      assert.equal(row.config_digest, oldStart.config_digest);
    }
  });

  test("F1 epoch tails retain historical generation/digest authorization after the rule is removed", async () => {
    const store = memoryStore();
    const oldStart = sample({ producer_id: randomBytes(16).toString("hex") });
    const newStart = sample({ producer_id: randomBytes(16).toString("hex"), generation: 3,
      config_digest: "ef".repeat(32), bytes_in: "5", bytes_out: "10", connections: "1" });
    store.history.set("7:3", deployment({ generation: 3,
      binding_snapshot: { spec: { link_id: 7, workspace_id: 3, generation: 3,
        ingress: { id: 11, workspace_id: 3 }, bindings: [{ forward_id: 41 }] } },
      placements: [{ node_id: 11, role: "ingress", generation: 3, config_digest: newStart.config_digest }],
    }));
    assert.deepEqual(await send(store, [oldStart, newStart]), { ok: true, accepted: [oldStart, newStart] });
    // No live Forward table exists in this fixture. The latest deployment no longer binds the rule.
    for (const history of store.history.values()) Object.assign(history, {
      status: "retired", lease_expires_at: new Date("2020-01-01"), link: { workspace_id: 3, generation: 4 },
    });
    store.history.set("7:4", deployment({ generation: 4,
      binding_snapshot: { spec: { link_id: 7, workspace_id: 3, generation: 4,
        ingress: { id: 11, workspace_id: 3 }, bindings: [] } },
      placements: [{ node_id: 11, role: "ingress", generation: 4, config_digest: "01".repeat(32) }],
    }));
    const oldFinal = { ...oldStart, bytes_in: "130", bytes_out: "250", connections: "4" };
    const newFinal = { ...newStart, bytes_in: "15", bytes_out: "25", connections: "2" };
    for (const forged of [{ ...oldFinal, config_digest: newStart.config_digest },
      { ...newFinal, config_digest: oldStart.config_digest },
      { ...newFinal, generation: 4, config_digest: "01".repeat(32) }]) {
      assert.deepEqual(await send(store, [oldFinal, forged]),
        { ok: false, status: 403, reason: "link_traffic_not_owned" });
      assert.equal(fact(store).traffic, 315, "invalid historical identity rolls back every epoch tail");
    }
    assert.deepEqual(await send(store, [newFinal, oldFinal]), { ok: true, accepted: [newFinal, oldFinal] });
    assert.deepEqual(await send(store, [oldFinal, newFinal]), { ok: true, accepted: [oldFinal, newFinal] });
    assert.deepEqual(fact(store), { workspace_id: 3, traffic: 420, traffic_cost: 420 },
      "deleting a rule cannot discard either historically authorized epoch tail");
    assert.equal(store.checkpoints.size, 2);
    for (const final of [oldFinal, newFinal]) {
      const row = store.checkpoints.get(`11:${final.producer_id}:41:2026-11-01`)!;
      assert.equal(row.generation, final.generation);
      assert.equal(row.config_digest, final.config_digest);
      assert.deepEqual([row.bytes_in, row.bytes_out, row.connections],
        [BigInt(final.bytes_in), BigInt(final.bytes_out), BigInt(final.connections)]);
    }
  });

  test("cross-workspace/node/egress, bad generation/digest and absent bindings are unauthorized", async () => {
    for (const forged of [sample({ workspace_id: 9 }), sample({ node_id: 12 }),
      sample({ link_id: 8 }), sample({ generation: 3 }), sample({ config_digest: "ef".repeat(32) }),
      sample({ forward_id: 999 })]) {
      const store = memoryStore();
      const result = await send(store, [sample(), forged]);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.status, 403);
      assert.equal(store.checkpoints.size, 0);
      assert.equal(store.daily.size, 0);
    }
    const store = memoryStore();
    const egress = sample({ node_id: 12, config_digest: "cd".repeat(32) });
    assert.deepEqual(await send(store, [egress], 12), { ok: false, status: 403, reason: "link_traffic_not_owned" });
    await send(store, [sample()]);
    await send(store, [egress], 12);
    assert.equal(fact(store).traffic, 300, "egress cannot double the ingress bill");
  });

  test("both placement and immutable snapshot ownership must match", async () => {
    const histories = [
      deployment({ link: { workspace_id: 9 } }),
      deployment({ placements: [{ node_id: 11, role: "ingress", generation: 3, config_digest: "ab".repeat(32) }] }),
      deployment({ placements: [{ node_id: 99, role: "ingress", generation: 2, config_digest: "ab".repeat(32) }] }),
      deployment({ binding_snapshot: { spec: { link_id: 7, workspace_id: 9, generation: 2,
        ingress: { id: 11, workspace_id: 3 }, bindings: [{ forward_id: 41 }] } } }),
      deployment({ binding_snapshot: { spec: { link_id: 7, workspace_id: 3, generation: 2,
        ingress: { id: 12, workspace_id: 3 }, bindings: [{ forward_id: 41 }] } } }),
      deployment({ binding_snapshot: { bindings: [{ forward_id: 41 }] } }),
    ];
    for (const history of histories) {
      const store = memoryStore();
      store.history.set("7:2", history);
      const result = await send(store, [sample()]);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.status, 403);
      assert.equal(store.daily.size, 0);
    }
  });

  test("valid newer history cannot rebind an existing producer/Forward/day identity", async () => {
    for (const over of [{ generation: 3 }, { link_id: 8 }, { workspace_id: 9 }, { config_digest: "ef".repeat(32) }]) {
      const store = memoryStore();
      await send(store, [sample()]);
      const changed = sample({ ...over, bytes_in: "1", bytes_out: "1", connections: "0" });
      store.history.set(`${changed.link_id}:${changed.generation}`, deployment({
        link_id: changed.link_id, generation: changed.generation, link: { workspace_id: changed.workspace_id },
        binding_snapshot: { spec: { link_id: changed.link_id, workspace_id: changed.workspace_id,
          generation: changed.generation, ingress: { id: 11, workspace_id: changed.workspace_id }, bindings: [{ forward_id: 41 }] } },
        placements: [{ node_id: 11, role: "ingress", generation: changed.generation, config_digest: changed.config_digest }],
      }));
      assert.deepEqual(await send(store, [changed]), { ok: false, status: 409, reason: "link_traffic_identity_conflict" });
      assert.equal(fact(store).traffic, 300);
      assert.equal(totals(store).generation, 2);
      assert.equal(totals(store).link_id, 7);
      assert.equal(totals(store).workspace_id, 3);
      assert.equal(totals(store).config_digest, "ab".repeat(32));
    }
  });

  test("conflicting daily tenant and same-batch metadata fail atomically", async () => {
    const store = memoryStore();
    store.daily.set("41:2026-11-01", { workspace_id: 9, traffic: 55, traffic_cost: 55 });
    assert.deepEqual(await send(store, [sample()]), { ok: false, status: 409, reason: "link_traffic_identity_conflict" });
    assert.equal(store.checkpoints.size, 0);
    assert.equal(fact(store).traffic, 55);
    const clean = memoryStore();
    clean.history.set("7:3", deployment({ generation: 3,
      binding_snapshot: { spec: { link_id: 7, workspace_id: 3, generation: 3,
        ingress: { id: 11, workspace_id: 3 }, bindings: [{ forward_id: 41 }] } },
      placements: [{ node_id: 11, role: "ingress", generation: 3, config_digest: "ab".repeat(32) }],
    }));
    assert.equal((await send(clean, [sample(), sample({ generation: 3 })])).ok, false);
    assert.equal(clean.checkpoints.size, 0);
    assert.equal(clean.daily.size, 0);
  });

  test("DB read/write/commit failures and late batch failures roll back both facts and checkpoints", async () => {
    for (const failure of ["read", "checkpoint", "daily", "commit"] as const) {
      const store = memoryStore();
      await send(store, [sample()]);
      store.failure = failure;
      const next = sample({ bytes_in: "150", bytes_out: "250", connections: "5" });
      assert.deepEqual(await send(store, [next]), { ok: false, status: 503, reason: "link_traffic_storage_failure" });
      assert.equal(totals(store).bytes_in, 100n);
      assert.equal(fact(store).traffic, 300);
      store.failure = null;
      await send(store, [next]);
      assert.equal(fact(store).traffic, 400, "retry does not lose the rolled-back delta");
    }
    const store = memoryStore();
    store.failDailyAt = 2;
    assert.equal((await send(store, [sample(), sample({ forward_id: 42 })])).ok, false);
    assert.equal(store.checkpoints.size, 0);
    assert.equal(store.daily.size, 0);
  });

  test("historical retired deployments with no live Forward still accept final increments and dedupe", async () => {
    const store = memoryStore();
    Object.assign(store.history.get("7:2")!, { status: "retired", lease_expires_at: new Date("2020-01-01"),
      link: { workspace_id: 3, generation: 99, status: "retired" } });
    await send(store, [sample()]);
    const final = sample({ bytes_in: "110", bytes_out: "220", connections: "4" });
    await send(store, [final, final]);
    assert.equal(fact(store).traffic, 330);
    assert.equal(fact(store).traffic_cost, 330);
  });
});

test("strict validation rejects malformed decimals, unsafe sums, dates, IDs and unknown keys before storage", async () => {
  const store = memoryStore();
  const invalid: unknown[] = [null, [], { samples: null }, { samples: [], extra: true },
    { samples: Array.from({ length: 2049 }, () => sample()) }];
  for (const over of [{ bytes_in: "abc" }, { bytes_in: "" }, { bytes_in: "-1" }, { bytes_in: "+1" },
    { bytes_in: "01" }, { bytes_in: "1.0" }, { bytes_in: "1e2" }, { bytes_in: 1 }, { bytes_in: null },
    { bytes_in: "1\n" }, { bytes_out: "1\r\n" }, { connections: "1\u2028" },
    { producer_id: "12".repeat(16) + "\n" }, { config_digest: "ab".repeat(32) + "\n" },
    { connections: "9007199254740992" }, { bytes_in: "9007199254740991", bytes_out: "1" },
    { producer_id: "AB".repeat(16) }, { producer_id: "12" }, { config_digest: "zz".repeat(32) },
    { date: "2026-02-29" }, { date: "2026-11-31" }, { date: "2026-13-01" }, { date: "2026-1-01" },
    { date: "2026-11-01T00:00:00Z" }, { forward_id: 0 }, { node_id: 1.5 }, { workspace_id: "3" },
    { generation: 2_147_483_648 }, { extra: true }]) invalid.push({ samples: [{ ...sample(), ...over }] });
  for (const body of invalid) assert.deepEqual(await submitLinkTraffic(11, body, { store }),
    { ok: false, status: 400, reason: "invalid_link_traffic" });
  assert.deepEqual(store.events, []);
  assert.deepEqual(await send(store, []), { ok: true, accepted: [] });
  assert.equal(linkTrafficDate("2024-02-29")!.toISOString(), "2024-02-29T00:00:00.000Z");
  const maximum = sample({ bytes_in: "9007199254740990", bytes_out: "1", connections: "9007199254740991" });
  assert.equal((await send(store, [maximum])).ok, true);
  assert.equal(totals(store).bytes_in + totals(store).bytes_out, BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal((await send(memoryStore(), Array.from({ length: 2048 }, () => sample()))).ok, true);
});

test("body limit counts actual UTF-8/chunked bytes, permits exactly 1MiB, and rejects malformed JSON", async () => {
  const request = (body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => new Request("http://localhost", {
    method: "POST", body, headers, ...({ duplex: "half" } as object),
  });
  const empty = '{"samples":[]}';
  assert.deepEqual(await readLinkTrafficBody(request(empty + " ".repeat(LINK_TRAFFIC_MAX_BODY_BYTES - empty.length))), { samples: [] });
  const rejects = [request("{"), request(""), request(" ".repeat(LINK_TRAFFIC_MAX_BODY_BYTES + 1)),
    request('"' + "中".repeat(LINK_TRAFFIC_MAX_BODY_BYTES / 2) + '"'),
    request(empty, { "content-length": String(LINK_TRAFFIC_MAX_BODY_BYTES + 1) })];
  let cancelled = false;
  rejects.push(request(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(LINK_TRAFFIC_MAX_BODY_BYTES)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  }), { "content-length": "1" }));
  for (const req of rejects) await assert.rejects(() => readLinkTrafficBody(req),
    (error: unknown) => error instanceof LinkTrafficError && error.status === 400);
  assert.equal(cancelled, true);
});

test("Prisma adapter keeps locked writes native and checks daily attribution even at zero delta", async () => {
  const trace: string[] = [];
  let dailyWorkspace = 3;
  let traffic = 0;
  const checkpoint = { ...sample(), id: 91, date: linkTrafficDate("2026-11-01")!, bytes_in: 0n, bytes_out: 0n, connections: 0n,
    updated_at: new Date("2026-11-01T00:00:00Z") };
  const tx = {
    linkDeployment: { findUnique: async () => deployment() },
    async $executeRaw(query: Prisma.Sql) {
      trace.push(query.sql);
      if (query.sql.includes("UPDATE link_traffic_checkpoint")) {
        assert.match(query.sql, /updated_at = \?/);
        assert.ok(query.values[3] instanceof Date);
        assert.equal(query.values.at(-1), checkpoint.id);
        [checkpoint.bytes_in, checkpoint.bytes_out, checkpoint.connections] = query.values.slice(0, 3) as bigint[];
      } else if (query.sql.includes("UPDATE tunnel_traffic")) {
        const [bytes, cost, dailyId] = query.values;
        assert.equal(bytes, 300);
        assert.equal(cost, bytes);
        assert.equal(dailyId, 92);
        traffic += Number(bytes);
      } else {
        assert.match(query.sql, /INSERT INTO (link_traffic_checkpoint|tunnel_traffic)/);
        assert.match(query.sql, /ON DUPLICATE KEY UPDATE id = id/);
        assert.ok(query.values.includes(linkTrafficDate("2026-11-01")!.toISOString())
          || query.values.some((value) => value instanceof Date && value.toISOString() === "2026-11-01T00:00:00.000Z"));
      }
      return 1;
    },
    async $queryRaw(query: Prisma.Sql) {
      trace.push(query.sql);
      assert.match(query.sql, /FOR UPDATE/);
      return query.sql.includes("FROM link_traffic_checkpoint") ? [{ ...checkpoint }]
        : [{ id: 92, workspace_id: dailyWorkspace, traffic, traffic_cost: traffic }];
    },
    // A consistent snapshot may not contain rows a different transaction has
    // just inserted. These ORM paths must never be used after current-row locks.
    linkTrafficCheckpoint: { update: async () => { throw new Error("snapshot checkpoint unavailable"); } },
    tunnelTraffic: { update: async () => { throw new Error("snapshot daily fact unavailable"); } },
  };
  type AdapterTransaction = typeof tx;
  const client = { async $transaction<T>(work: (tx: AdapterTransaction) => Promise<T>) { return work(tx); } };
  const store = createPrismaLinkTrafficStore(client as unknown as Pick<PrismaClient, "$transaction">);
  await send(store, [sample()]);
  assert.equal(traffic, 300);
  assert.match(trace[0]!, /INSERT INTO link_traffic_checkpoint/);
  assert.match(trace[1]!, /FROM link_traffic_checkpoint/);
  assert.match(trace[2]!, /UPDATE link_traffic_checkpoint/);
  assert.match(trace[3]!, /INSERT INTO tunnel_traffic/);
  assert.match(trace[4]!, /FROM tunnel_traffic/);
  assert.match(trace[5]!, /UPDATE tunnel_traffic/);
  dailyWorkspace = 9;
  assert.deepEqual(await send(store, [sample()]), { ok: false, status: 409, reason: "link_traffic_identity_conflict" });
  assert.equal(traffic, 300);
  dailyWorkspace = 3;
  traffic = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(await send(store, [sample({ bytes_in: "101" })]),
    { ok: false, status: 503, reason: "link_traffic_storage_failure" });
});

// Bun's unit-test glob can load node:test files, but its executable is not the
// Node loader used by this isolated HTTP scenario. Skip only this scenario if
// a Node runtime with module hooks is unavailable; DI tests remain runnable.
const httpNode = process.versions.bun ? "node" : process.execPath;
const httpNodeAvailable = spawnSync(httpNode,
  ["--eval", "process.exit(typeof require('node:module').registerHooks === 'function' ? 0 : 1)"],
  { encoding: "utf8", timeout: 5000 }).status === 0;
test("HTTP route uses Bearer-derived node identity and exact persisted ACKs with 400/403/409/503 boundaries",
  { skip: httpNodeAvailable ? false : "Node module hooks unavailable" }, () => {
  const path = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
  const scenario = `
    import assert from "node:assert/strict";
    import { randomBytes } from "node:crypto";
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (new URL(resolved.url).pathname.endsWith('/src/db.ts')) {
        return { url: 'data:text/javascript,export const db = {};', shortCircuit: true };
      }
      return resolved;
    } });
    const real = await import(${path("../link-traffic.ts")});
    const deployment = ${deployment.toString()};
    const LinkTrafficError = real.LinkTrafficError;
    const store = (${memoryStore.toString()})();
    globalThis.real = real;
    globalThis.store = store;
    globalThis.auth = { ok: true, node_id: 11, scope: 0 };
    const stubs = new Map([
      ["/services/node-credential.ts", "export const authenticateNode = async () => globalThis.auth;"],
      ["/services/node-state.ts", "export const extractBearerCredential = value => value?.startsWith('Bearer ') ? value.slice(7) : null; export const buildReconnectSnapshot = async () => null; export const renewOwnedLeases = async () => {}; export const submitStateReport = async () => {};"],
      ["/services/node-enrollment.ts", "export const consumeNodeEnrollment = async () => {}; export const extractEnrollmentToken = () => null; export const renderNodeInstallScript = () => '';"],
      ["/services/agent-command-bus.ts", "export const buildDesiredNodeSnapshot = async () => {}; export const dequeueAgentCommand = async () => {}; export const storeAgentCommandAck = async () => {};"],
      ["/services/link-traffic.ts", "export const LinkTrafficError = globalThis.real.LinkTrafficError; export const readLinkTrafficBody = globalThis.real.readLinkTrafficBody; export const submitLinkTraffic = (node, raw) => globalThis.real.submitLinkTraffic(node, raw, { store: globalThis.store });"],
    ]);
    registerHooks({ resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      for (const [suffix, code] of stubs) if (new URL(resolved.url).pathname.endsWith(suffix)) {
        return { url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true };
      }
      return resolved;
    } });
    const { Hono } = await import('hono');
    const { internalNodeRoutes } = await import(${path("../../routes/internal-node.ts")});
    const app = new Hono(); app.route('/api/internal', internalNodeRoutes);
    const first = ${JSON.stringify(sample())};
    const request = (body, headers = { authorization: 'Bearer offline-only' }) => app.request('/api/internal/node/link-traffic', {
      method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    let response = await request({ samples: [first] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { accepted: [first] } });
    const old = { ...first, bytes_in: '1', bytes_out: '2', connections: '0' };
    response = await request({ samples: [old] });
    assert.deepEqual(await response.json(), { data: { accepted: [old] } });
    assert.equal([...store.daily.values()][0].traffic, 300);

    const epochStore = (${memoryStore.toString()})();
    globalThis.store = epochStore;
    const oldEpoch = { ...first, producer_id: randomBytes(16).toString('hex') };
    const newEpoch = { ...first, producer_id: randomBytes(16).toString('hex'),
      bytes_in: '5', bytes_out: '10', connections: '1' };
    assert.notEqual(oldEpoch.producer_id, newEpoch.producer_id);
    const oldFinal = { ...oldEpoch, bytes_in: '130', bytes_out: '250', connections: '4' };
    const newFinal = { ...newEpoch, bytes_in: '15', bytes_out: '25', connections: '2' };
    let pendingOld = oldFinal;
    const delayedRetry = structuredClone(oldFinal);
    response = await request({ samples: [oldEpoch, newEpoch] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { accepted: [oldEpoch, newEpoch] } });
    // Deliberately drop this HTTP response after the old final has committed.
    await request({ samples: [oldFinal] });
    assert.equal([...epochStore.daily.values()][0].traffic, 395);
    assert.ok(pendingOld);
    response = await request({ samples: [newFinal, pendingOld] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { accepted: [newFinal, oldFinal] } });
    pendingOld = null; // Local reclamation follows the exact committed ACK above.
    assert.equal(epochStore.checkpoints.size, 2);
    response = await request({ samples: [delayedRetry, oldEpoch] });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { accepted: [delayedRetry, oldEpoch] } });
    assert.deepEqual([...epochStore.daily.values()][0], { workspace_id: 3, traffic: 420, traffic_cost: 420 });
    assert.equal(pendingOld, null);
    assert.equal(epochStore.checkpoints.size, 2, 'reclaimed local snapshots retain server deduplication');
    globalThis.store = store;

    response = await request({ samples: [first] }, {}); assert.equal(response.status, 401);
    response = await request('{'); assert.equal(response.status, 400);
    response = await request(' '.repeat(1048577)); assert.equal(response.status, 400);
    response = await request({ samples: [{ ...first, node_id: 12 }] }); assert.equal(response.status, 403);
    response = await request({ samples: [first], extra: true }); assert.equal(response.status, 400);
    const row = [...store.checkpoints.values()][0]; row.workspace_id = 9;
    response = await request({ samples: [first] }); assert.equal(response.status, 409);
    row.workspace_id = 3; store.failure = 'commit';
    response = await request({ samples: [first] }); assert.equal(response.status, 503);
    globalThis.auth = { ok: false, reason: 'revoked' };
    response = await request({ samples: [first] }); assert.equal(response.status, 401);
    globalThis.auth = { ok: false, reason: 'db_unavailable' };
    response = await request({ samples: [first] }); assert.equal(response.status, 503);
  `;
  const child = spawnSync(httpNode, ["--experimental-transform-types", "--input-type=module", "--eval", scenario],
    { cwd: fileURLToPath(new URL("../../..", import.meta.url)), encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message || "HTTP scenario failed");
});
