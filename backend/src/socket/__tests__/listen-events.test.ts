import { test, expect, describe } from "bun:test";
import {
  parseListenName,
  isPortInUseError,
  handleListenError,
  ERR_PORT_IN_USE,
  type ListenErrorDeps,
} from "../listen-events.ts";

/** 记录调用的 fake deps。 */
function fakeDeps() {
  const marked: { tunnelId: number; at: Date }[] = [];
  const logs: { message: string; meta: Record<string, unknown> }[] = [];
  const deps: ListenErrorDeps = {
    markPortConflict: async (tunnelId, at) => {
      marked.push({ tunnelId, at });
    },
    log: (message, meta) => logs.push({ message, meta }),
  };
  return { deps, marked, logs };
}

describe("parseListenName", () => {
  test("tcp-N / udp-N → tunnel id", () => {
    expect(parseListenName("tcp-8").tunnelId).toBe(8);
    expect(parseListenName("udp-9").tunnelId).toBe(9);
    expect(parseListenName("tcp-123").tunnelId).toBe(123);
  });
  test("out-node service name → null", () => {
    expect(parseListenName("relay").tunnelId).toBeNull();
    expect(parseListenName("tcp").tunnelId).toBeNull();
    expect(parseListenName("").tunnelId).toBeNull();
  });
});

describe("isPortInUseError", () => {
  test("only ERR_PORT_IN_USE is truthy", () => {
    expect(isPortInUseError(ERR_PORT_IN_USE)).toBe(true);
    expect(isPortInUseError("ERR_NO_FREE_PORT")).toBe(false);
    expect(isPortInUseError(undefined)).toBe(false);
  });
});

describe("handleListenError", () => {
  test("ERR_PORT_IN_USE on a tunnel marks it inactive + port_conflict_at (original semantics)", async () => {
    const { deps, marked } = fakeDeps();
    const changed = await handleListenError(
      { node_id: "Node-A", name: "tcp-8", error: ERR_PORT_IN_USE },
      deps,
    );
    expect(changed).toBe(true);
    expect(marked).toHaveLength(1);
    expect(marked[0].tunnelId).toBe(8);
    expect(marked[0].at).toBeInstanceOf(Date);
  });

  test("udp-N also marks", async () => {
    const { deps, marked } = fakeDeps();
    await handleListenError({ node_id: "n", name: "udp-9", error: ERR_PORT_IN_USE }, deps);
    expect(marked.map((m) => m.tunnelId)).toEqual([9]);
  });

  test("out-node service name is ignored (no tunnel to mark)", async () => {
    const { deps, marked } = fakeDeps();
    const changed = await handleListenError(
      { node_id: "n", name: "relay", error: ERR_PORT_IN_USE },
      deps,
    );
    expect(changed).toBe(false);
    expect(marked).toHaveLength(0);
  });

  test("non port-in-use error is recorded but does not mutate state", async () => {
    const { deps, marked, logs } = fakeDeps();
    const changed = await handleListenError(
      { node_id: "n", name: "tcp-8", error: "ERR_NO_FREE_PORT" },
      deps,
    );
    expect(changed).toBe(false);
    expect(marked).toHaveLength(0);
    expect(logs.some((l) => l.message.includes("recorded only"))).toBe(true);
  });

  test("mark failure is swallowed", async () => {
    const logs: unknown[] = [];
    const changed = await handleListenError(
      { node_id: "n", name: "tcp-8", error: ERR_PORT_IN_USE },
      {
        markPortConflict: async () => {
          throw new Error("db down");
        },
        log: (m, meta) => logs.push([m, meta]),
      },
    );
    expect(changed).toBe(false);
    expect(logs).toHaveLength(1);
  });
});
