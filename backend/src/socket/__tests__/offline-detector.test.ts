import { test, expect, describe } from "bun:test";
import {
  parseDisconnectMarkerKey,
  parseMarker,
  disconnectMarkerKey,
  sysinfoKey,
  decideOffline,
  runOfflineCheck,
  DISCONNECT_DEBOUNCE_MS,
  DISCONNECT_MARKER_TTL_S,
  type OfflineCheckDeps,
  type DisconnectMarker,
  type OfflineContext,
} from "../offline-detector.ts";

describe("key helpers", () => {
  test("disconnectMarkerKey / sysinfoKey shape", () => {
    expect(disconnectMarkerKey(3, "Node-A")).toBe("dc:3:Node-A");
    expect(sysinfoKey(3, "Node-A")).toBe("sysinfo:3:Node-A");
  });

  test("parseDisconnectMarkerKey round-trips", () => {
    expect(parseDisconnectMarkerKey("dc:3:Node-A")).toEqual({ groupId: 3, nodeId: "Node-A" });
    // node_id 含冒号/空格也能解析（只取第一个冒号后半段整体）
    expect(parseDisconnectMarkerKey("dc:7:a:b c")).toEqual({ groupId: 7, nodeId: "a:b c" });
  });

  test("parseDisconnectMarkerKey rejects malformed keys", () => {
    expect(parseDisconnectMarkerKey("sysinfo:1:x")).toBeNull();
    expect(parseDisconnectMarkerKey("dc:abc:X")).toBeNull();
    expect(parseDisconnectMarkerKey("dc:1")).toBeNull();
    expect(parseDisconnectMarkerKey("")).toBeNull();
  });

  test("marker TTL outlives debounce window (no gap where marker expires before scan)", () => {
    // 标记 TTL 必须严格大于防抖窗口，否则 worker 可能在两次扫描间漏判。
    expect(DISCONNECT_MARKER_TTL_S * 1000).toBeGreaterThan(DISCONNECT_DEBOUNCE_MS);
  });
});

describe("parseMarker", () => {
  test("parses value as ms timestamp", () => {
    const m = parseMarker("dc:2:n1", "1700000000000");
    expect(m).not.toBeNull();
    expect(m!.groupId).toBe(2);
    expect(m!.nodeId).toBe("n1");
    expect(m!.markedAt).toBe(1700000000000);
  });

  test("malformed value → markedAt 0 (treated as long overdue)", () => {
    expect(parseMarker("dc:2:n1", "not-a-number")!.markedAt).toBe(0);
    expect(parseMarker("dc:2:n1", "")!.markedAt).toBe(0);
  });

  test("malformed key → null", () => {
    expect(parseMarker("bad", "1")).toBeNull();
  });
});

describe("decideOffline", () => {
  const base: OfflineContext = {
    now: 1_000_000,
    debounceMs: DISCONNECT_DEBOUNCE_MS,
    hasHeartbeat: false,
    nodeStatus: "active",
  };
  const marker = (markedAt: number): DisconnectMarker => ({
    key: "dc:1:n1",
    groupId: 1,
    nodeId: "n1",
    markedAt,
  });

  test("debounce elapsed + no heartbeat + active → offline", () => {
    expect(decideOffline(marker(1_000_000 - DISCONNECT_DEBOUNCE_MS - 1), base)).toBe("offline");
  });

  test("exactly at debounce boundary → offline (>=)", () => {
    expect(decideOffline(marker(1_000_000 - DISCONNECT_DEBOUNCE_MS), base)).toBe("offline");
  });

  test("within debounce window → within_debounce (even if mark just written)", () => {
    expect(decideOffline(marker(1_000_000), base)).toBe("within_debounce");
    expect(decideOffline(marker(1_000_000 - 30_000), base)).toBe("within_debounce");
  });

  test("heartbeat alive → heartbeat_alive (marker is stale)", () => {
    expect(
      decideOffline(marker(1_000_000 - 120_000), { ...base, hasHeartbeat: true }),
    ).toBe("heartbeat_alive");
  });

  test("missing node → node_missing (takes precedence)", () => {
    expect(decideOffline(marker(0), { ...base, nodeStatus: "missing" })).toBe("node_missing");
  });

  test("already inactive → already_inactive", () => {
    expect(
      decideOffline(marker(1_000_000 - 120_000), { ...base, nodeStatus: "inactive" }),
    ).toBe("already_inactive");
  });

  test("heartbeat wins over already_inactive ordering is irrelevant; both skip", () => {
    // 心跳存活时优先短路，不关心 DB 状态
    expect(
      decideOffline(marker(1_000_000 - 120_000), {
        ...base,
        hasHeartbeat: true,
        nodeStatus: "inactive",
      }),
    ).toBe("heartbeat_alive");
  });
});

/** 内存 fake 依赖，模拟 Redis/DB/时间。 */
function fakeDeps(opts: {
  markers: Array<{ key: string; value: string }>;
  heartbeats?: Set<string>;
  nodes?: Map<string, "active" | "inactive">;
  now?: number;
  debounceMs?: number;
}) {
  const heartbeats = opts.heartbeats ?? new Set<string>();
  const nodes = opts.nodes ?? new Map<string, "active" | "inactive">();
  const deleted: string[] = [];
  const flipped: string[] = [];
  const srem: string[] = [];
  const logs: string[] = [];

  const deps: OfflineCheckDeps = {
    listMarkers: async () => opts.markers,
    hasHeartbeat: async (g, n) => heartbeats.has(sysinfoKey(g, n)),
    getNodeStatus: async (n) => nodes.get(n) ?? "missing",
    markInactive: async (n) => {
      if (nodes.get(n) === "active") {
        nodes.set(n, "inactive");
        flipped.push(n);
        return true;
      }
      return false;
    },
    clearMarker: async (k) => {
      deleted.push(k);
    },
    groupHasActiveNode: async (g) =>
      [...nodes.entries()].some(([k, v]) => k.startsWith(`n${g}`) && v === "active"),
    removeAliveGroup: async (g) => {
      srem.push(String(g));
    },
    now: () => opts.now ?? 1_000_000,
    debounceMs: opts.debounceMs,
    log: (m, meta) => logs.push(`${m} ${JSON.stringify(meta)}`),
  };
  return { deps, deleted, flipped, srem, logs, nodes, heartbeats };
}

describe("runOfflineCheck", () => {
  test("offline node is flipped + marker cleared", async () => {
    const { deps, deleted, flipped } = fakeDeps({
      markers: [{ key: "dc:1:n1", value: String(1_000_000 - 120_000) }],
      nodes: new Map([["n1", "active"]]),
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.scanned).toBe(1);
    expect(r.flipped).toBe(1);
    expect(flipped).toEqual(["n1"]);
    expect(deleted).toEqual(["dc:1:n1"]);
  });

  test("within debounce is kept (marker NOT cleared), node untouched", async () => {
    const { deps, deleted, nodes } = fakeDeps({
      markers: [{ key: "dc:1:n1", value: String(1_000_000 - 10_000) }],
      nodes: new Map([["n1", "active"]]),
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.skippedWithinDebounce).toBe(1);
    expect(r.flipped).toBe(0);
    expect(deleted).toEqual([]); // 保留标记等下一轮
    expect(nodes.get("n1")).toBe("active");
  });

  test("heartbeat alive → marker cleared, node stays active", async () => {
    const { deps, deleted, nodes } = fakeDeps({
      markers: [{ key: "dc:1:n1", value: String(1_000_000 - 120_000) }],
      heartbeats: new Set([sysinfoKey(1, "n1")]),
      nodes: new Map([["n1", "active"]]),
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.skippedHeartbeatAlive).toBe(1);
    expect(nodes.get("n1")).toBe("active");
    expect(deleted).toEqual(["dc:1:n1"]);
  });

  test("already inactive / missing node → cleared without flip", async () => {
    const { deps, flipped } = fakeDeps({
      markers: [
        { key: "dc:1:gone", value: "1" },
        { key: "dc:1:off", value: "1" },
      ],
      nodes: new Map([["off", "inactive"]]),
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.nodeMissing).toBe(1);
    expect(r.alreadyInactive).toBe(1);
    expect(flipped).toEqual([]);
  });

  test("malformed marker key is ignored (not scanned)", async () => {
    const { deps } = fakeDeps({
      markers: [{ key: "sysinfo:1:n1", value: "1" }],
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.scanned).toBe(0);
  });

  test("alive group is reaped only when no active node remains", async () => {
    const { deps, srem } = fakeDeps({
      markers: [{ key: "dc:4:n4a", value: "1" }],
      nodes: new Map([["n4a", "active"]]),
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.flipped).toBe(1);
    // n4a 现为 inactive，组内已无 active → 移除
    expect(r.clearedGroups).toEqual([4]);
    expect(srem).toEqual(["4"]);
  });

  test("alive group NOT reaped when another node in the group is still active", async () => {
    // 两个节点同组：一个离线翻转，另一个仍 active
    const { deps, srem } = fakeDeps({
      markers: [{ key: "dc:4:n4a", value: "1" }],
      nodes: new Map([
        ["n4a", "active"],
        ["n4b", "active"],
      ]),
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.flipped).toBe(1);
    expect(r.clearedGroups).toEqual([]);
    expect(srem).toEqual([]);
  });

  test("per-marker failure is swallowed and counted", async () => {
    const { deps } = fakeDeps({
      markers: [
        { key: "dc:1:n1", value: "1" },
        { key: "dc:1:n2", value: "1" },
      ],
      nodes: new Map([
        ["n1", "active"],
        ["n2", "active"],
      ]),
      now: 1_000_000,
    });
    // 第一条 markInactive 抛错，第二条仍应成功
    const orig = deps.markInactive;
    let calls = 0;
    deps.markInactive = async (n) => {
      calls++;
      if (n === "n1") throw new Error("db down");
      return orig(n);
    };
    const r = await runOfflineCheck(deps);
    expect(r.errors).toBe(1);
    expect(r.flipped).toBe(1);
    expect(calls).toBe(2); // 未因首条失败而短路
  });

  test("idempotent: re-running after flip reports already_inactive, no double count", async () => {
    const nodes = new Map<string, "active" | "inactive">([["n1", "active"]]);
    const first = fakeDeps({
      markers: [{ key: "dc:1:n1", value: "1" }],
      nodes,
      now: 1_000_000,
    });
    const r1 = await runOfflineCheck(first.deps);
    expect(r1.flipped).toBe(1);
    // 第二轮同一标记（尚未清理的极端情况）——节点已 inactive
    const second = fakeDeps({
      markers: [{ key: "dc:1:n1", value: "1" }],
      nodes,
      now: 1_000_000,
    });
    const r2 = await runOfflineCheck(second.deps);
    expect(r2.flipped).toBe(0);
    expect(r2.alreadyInactive).toBe(1);
  });
});
