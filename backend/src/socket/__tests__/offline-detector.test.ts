import { test, expect, describe } from "bun:test";
import {
  parseDisconnectMarkerKey,
  parseMarker,
  disconnectMarkerKey,
  heartbeatKey,
  decideOffline,
  runOfflineCheck,
  DISCONNECT_DEBOUNCE_MS,
  DISCONNECT_MARKER_TTL_S,
  type OfflineCheckDeps,
  type DisconnectMarker,
  type OfflineContext,
} from "../offline-detector.ts";

describe("key helpers (TEN-02 scoped)", () => {
  test("disconnectMarkerKey / heartbeatKey carry scope", () => {
    expect(disconnectMarkerKey(1, 3, "Node-A")).toBe("ws:1:node:3:Node-A:offline");
    expect(heartbeatKey(1, 3, "Node-A")).toBe("ws:1:node:3:Node-A:heartbeat");
    // 平台组 scope=0 → tag=global
    expect(disconnectMarkerKey(0, 3, "Node-A")).toBe("ws:global:node:3:Node-A:offline");
    // 非法 scope 折叠为 global（不落到别的租户）
    expect(disconnectMarkerKey(-5, 3, "Node-A")).toBe("ws:global:node:3:Node-A:offline");
  });

  test("同一 groupId 在不同 scope 下生成互不相同的 key（同 ID 资源隔离）", () => {
    expect(disconnectMarkerKey(1, 7, "n")).not.toBe(disconnectMarkerKey(2, 7, "n"));
    expect(heartbeatKey(1, 7, "n")).not.toBe(heartbeatKey(2, 7, "n"));
  });

  test("parseDisconnectMarkerKey round-trips with scope", () => {
    expect(parseDisconnectMarkerKey("ws:1:node:3:Node-A:offline")).toEqual({
      scope: 1,
      groupId: 3,
      nodeId: "Node-A",
    });
    // node_id 含冒号/空格也能解析（转义还原为一个整体）
    expect(parseDisconnectMarkerKey("ws:7:node:9:a:b c:offline")).toEqual({
      scope: 7,
      groupId: 9,
      nodeId: "a:b c",
    });
    // 平台 scope 解析为 0
    expect(parseDisconnectMarkerKey("ws:global:node:9:n1:offline")).toEqual({
      scope: 0,
      groupId: 9,
      nodeId: "n1",
    });
  });

  test("parseDisconnectMarkerKey rejects malformed / legacy (unscoped) keys", () => {
    expect(parseDisconnectMarkerKey("ws:1:node:3:n1:heartbeat")).toBeNull();
    // 旧的无 scope 形态（dc:<groupId>:<nodeId>）必须被拒绝，避免误判租户
    expect(parseDisconnectMarkerKey("dc:3:Node-A")).toBeNull();
    expect(parseDisconnectMarkerKey("sysinfo:1:3:x")).toBeNull();
    expect(parseDisconnectMarkerKey("ws:abc:node:1:X:offline")).toBeNull();
    expect(parseDisconnectMarkerKey("ws:1:node:1:offline")).toBeNull();
    expect(parseDisconnectMarkerKey("")).toBeNull();
  });

  test("marker TTL outlives debounce window (no gap where marker expires before scan)", () => {
    // 标记 TTL 必须严格大于防抖窗口，否则 worker 可能在两次扫描间漏判。
    expect(DISCONNECT_MARKER_TTL_S * 1000).toBeGreaterThan(DISCONNECT_DEBOUNCE_MS);
  });
});

describe("parseMarker", () => {
  test("parses scope + value as ms timestamp", () => {
    const m = parseMarker("ws:1:node:2:n1:offline", "1700000000000");
    expect(m).not.toBeNull();
    expect(m!.scope).toBe(1);
    expect(m!.groupId).toBe(2);
    expect(m!.nodeId).toBe("n1");
    expect(m!.markedAt).toBe(1700000000000);
  });

  test("malformed value → markedAt 0 (treated as long overdue)", () => {
    expect(parseMarker("ws:1:node:2:n1:offline", "not-a-number")!.markedAt).toBe(0);
    expect(parseMarker("ws:1:node:2:n1:offline", "")!.markedAt).toBe(0);
  });

  test("malformed key → null (incl. legacy unscoped form)", () => {
    expect(parseMarker("bad", "1")).toBeNull();
    expect(parseMarker("dc:1:n1", "1")).toBeNull();
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
    key: "ws:1:node:1:n1:offline",
    scope: 1,
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
    hasHeartbeat: async (s, g, n) => heartbeats.has(heartbeatKey(s, g, n)),
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
    removeAliveGroup: async (s, g) => {
      srem.push(`${s}:${g}`);
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
      markers: [{ key: "ws:1:node:1:n1:offline", value: String(1_000_000 - 120_000) }],
      nodes: new Map([["n1", "active"]]),
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.scanned).toBe(1);
    expect(r.flipped).toBe(1);
    expect(flipped).toEqual(["n1"]);
    expect(deleted).toEqual(["ws:1:node:1:n1:offline"]);
  });

  test("within debounce is kept (marker NOT cleared), node untouched", async () => {
    const { deps, deleted, nodes } = fakeDeps({
      markers: [{ key: "ws:1:node:1:n1:offline", value: String(1_000_000 - 10_000) }],
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
      markers: [{ key: "ws:1:node:1:n1:offline", value: String(1_000_000 - 120_000) }],
      heartbeats: new Set([heartbeatKey(1, 1, "n1")]),
      nodes: new Map([["n1", "active"]]),
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.skippedHeartbeatAlive).toBe(1);
    expect(nodes.get("n1")).toBe("active");
    expect(deleted).toEqual(["ws:1:node:1:n1:offline"]);
  });

  test("心跳只认本 scope：别租户的心跳不能让本租户的节点逃过离线判定", async () => {
    // marker 属 scope=1；heartbeat set 里放的是 scope=2 的键（同 groupId/nodeId）。
    // hasHeartbeat 用 marker.scope 生成的键查表 → 不应命中 → 判 offline。
    const { deps, deleted, nodes } = fakeDeps({
      markers: [{ key: "ws:1:node:1:n1:offline", value: String(1_000_000 - 120_000) }],
      heartbeats: new Set([heartbeatKey(2, 1, "n1")]),
      nodes: new Map([["n1", "active"]]),
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.flipped).toBe(1);
    expect(nodes.get("n1")).toBe("inactive");
    expect(r.skippedHeartbeatAlive).toBe(0);
  });

  test("already inactive / missing node → cleared without flip", async () => {
    const { deps, flipped } = fakeDeps({
      markers: [
        { key: "ws:1:node:1:gone:offline", value: "1" },
        { key: "ws:1:node:1:off:offline", value: "1" },
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
      markers: [{ key: "ws:1:node:1:n1:heartbeat", value: "1" }],
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.scanned).toBe(0);
  });

  test("alive group is reaped only when no active node remains", async () => {
    const { deps, srem } = fakeDeps({
      markers: [{ key: "ws:1:node:4:n4a:offline", value: "1" }],
      nodes: new Map([["n4a", "active"]]),
      now: 1_000_000,
    });
    const r = await runOfflineCheck(deps);
    expect(r.flipped).toBe(1);
    // n4a 现为 inactive，组内已无 active → 从**该 scope 的**集合移除
    expect(r.clearedGroups).toEqual(["1:4"]);
    expect(srem).toEqual(["1:4"]);
  });

  test("alive group NOT reaped when another node in the group is still active", async () => {
    // 两个节点同组：一个离线翻转，另一个仍 active
    const { deps, srem } = fakeDeps({
      markers: [{ key: "ws:1:node:4:n4a:offline", value: "1" }],
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
        { key: "ws:1:node:1:n1:offline", value: "1" },
        { key: "ws:1:node:1:n2:offline", value: "1" },
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
      markers: [{ key: "ws:1:node:1:n1:offline", value: "1" }],
      nodes,
      now: 1_000_000,
    });
    const r1 = await runOfflineCheck(first.deps);
    expect(r1.flipped).toBe(1);
    // 第二轮同一标记（尚未清理的极端情况）——节点已 inactive
    const second = fakeDeps({
      markers: [{ key: "ws:1:node:1:n1:offline", value: "1" }],
      nodes,
      now: 1_000_000,
    });
    const r2 = await runOfflineCheck(second.deps);
    expect(r2.flipped).toBe(0);
    expect(r2.alreadyInactive).toBe(1);
  });
});
