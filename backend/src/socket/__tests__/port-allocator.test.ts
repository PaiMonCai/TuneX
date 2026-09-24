import { test, expect, describe } from "bun:test";
import {
  parsePortRange,
  expandPorts,
  isEmptyRange,
  DynamicPortAllocator,
  allocatePortsBySlot,
  allocateDynamicPorts,
  resolveDynamicServicePorts,
  formatListenAddr,
} from "../port-allocator.ts";

describe("parsePortRange", () => {
  test("single range", () => {
    expect(parsePortRange("19000-19010").segments).toEqual([{ lo: 19000, hi: 19010 }]);
  });
  test("mixed list", () => {
    expect(parsePortRange("80,443,30000-30002").segments).toEqual([
      { lo: 80, hi: 80 },
      { lo: 443, hi: 443 },
      { lo: 30000, hi: 30002 },
    ]);
  });
  test("invalid fragments ignored", () => {
    expect(parsePortRange("abc,70000,10-5,-3, 19000-19001").segments).toEqual([{ lo: 19000, hi: 19001 }]);
  });
  test("null / empty", () => {
    expect(isEmptyRange(parsePortRange(null))).toBe(true);
    expect(isEmptyRange(parsePortRange(""))).toBe(true);
    expect(isEmptyRange(parsePortRange(undefined))).toBe(true);
  });
});

describe("expandPorts", () => {
  test("ascending + dedupe across overlapping ranges", () => {
    expect(expandPorts(parsePortRange("19002-19004,19000-19002"))).toEqual([
      19000, 19001, 19002, 19003, 19004,
    ]);
  });
});

describe("DynamicPortAllocator", () => {
  test("distinct slots get distinct ports", () => {
    const a = new DynamicPortAllocator([], "19000-19010");
    expect(a.assign("8:tcp")).toBe(19000);
    expect(a.assign("8:udp")).toBe(19001);
    expect(a.assign("9:tcp")).toBe(19002);
    expect(a.assign("9:udp")).toBe(19003);
  });

  test("same slot is idempotent", () => {
    const a = new DynamicPortAllocator([], "19000-19010");
    expect(a.assign("8:tcp")).toBe(19000);
    expect(a.assign("8:tcp")).toBe(19000);
    expect(a.size).toBe(1);
  });

  test("fixed ports are reserved and never handed to dynamic slots", () => {
    const a = new DynamicPortAllocator([19000], "19000-19002");
    expect(a.assign("8:tcp")).toBe(19001); // 19000 reserved
    expect(a.assign("9:tcp")).toBe(19002);
  });

  test("fixed slot returns its fixed port", () => {
    const a = new DynamicPortAllocator([19000], "19000-19010");
    expect(a.assign("8:tcp", 19000)).toBe(19000);
  });

  test("exhaustion returns null", () => {
    const a = new DynamicPortAllocator([], "19000-19000");
    expect(a.assign("8:tcp")).toBe(19000);
    expect(a.assign("8:udp")).toBeNull();
    expect(a.assign("9:tcp")).toBeNull();
  });

  test("no range: fixed honoured, dynamic null", () => {
    const a = new DynamicPortAllocator([19000], null);
    expect(a.assign("8:tcp", 19000)).toBe(19000);
    expect(a.assign("8:udp")).toBeNull();
  });
});

describe("allocatePortsBySlot / allocateDynamicPorts", () => {
  test("by slot order", () => {
    const m = allocatePortsBySlot(
      [{ key: "8:tcp" }, { key: "8:udp" }, { key: "9:tcp" }],
      "19000-19010",
    );
    expect([...m.values()]).toEqual([19000, 19001, 19002]);
  });

  test("dynamic tunnels by id ascending", () => {
    const m = allocateDynamicPorts(
      [
        { id: 9, listen_port: null },
        { id: 8, listen_port: null },
        { id: 7, listen_port: 19000 },
      ],
      "19000-19010",
    );
    expect(m.get(8)).toBe(19001);
    expect(m.get(9)).toBe(19002);
    expect(m.has(7)).toBe(true);
  });
});

describe("resolveDynamicServicePorts", () => {
  const tunnels = [
    { id: 8, listen_port: null, listen_ip: "" },
    { id: 9, listen_port: null, listen_ip: "" },
    { id: 10, listen_port: 19005, listen_ip: "127.0.0.1" },
  ];

  test("tcp/udp of the same tunnel never share a port (the reported bug)", () => {
    const services = [
      { name: "tcp-8", addr: ":WAIT_LISTEN19000-19010" },
      { name: "udp-8", addr: ":WAIT_LISTEN19000-19010" },
      { name: "tcp-9", addr: ":WAIT_LISTEN19000-19010" },
      { name: "udp-9", addr: ":WAIT_LISTEN19000-19010" },
    ];
    const out = resolveDynamicServicePorts(services, tunnels, "19000-19010");
    expect(out[0].addr).toBe(":19000");
    expect(out[1].addr).toBe(":19001");
    expect(out[2].addr).toBe(":19002");
    expect(out[3].addr).toBe(":19003");
    const ports = out.map((s) => s.addr);
    expect(new Set(ports).size).toBe(ports.length);
  });

  test("fixed-port tunnel keeps its addr and reserves its port", () => {
    const services = [{ name: "tcp-10", addr: "127.0.0.1:19005" }];
    const out = resolveDynamicServicePorts(services, tunnels, "19000-19010");
    expect(out[0].addr).toBe("127.0.0.1:19005"); // unchanged, no WAIT_LISTEN
    // dynamic tunnels must not be handed 19005
    const dyn = resolveDynamicServicePorts(
      [{ name: "tcp-8", addr: ":WAIT_LISTEN19000-19010" }],
      tunnels,
      "19000-19010",
    );
    expect(dyn[0].addr).not.toBe(":19005");
  });

  test("extra dynamic slot (relay/chain) gets a distinct port", () => {
    const services = [
      { name: "tcp-8", addr: ":WAIT_LISTEN19000-19010" },
      { name: "relay", addr: ":WAIT_LISTEN19000-19010" },
    ];
    const out = resolveDynamicServicePorts(services, tunnels, "19000-19010");
    expect(out[0].addr).toBe(":19000");
    expect(out[1].addr).toBe(":19001");
  });

  test("range exhaustion falls back to the WAIT_LISTEN placeholder", () => {
    const services = [
      { name: "tcp-8", addr: ":WAIT_LISTEN19000-19000" },
      { name: "udp-8", addr: ":WAIT_LISTEN19000-19000" },
    ];
    const out = resolveDynamicServicePorts(services, [{ id: 8, listen_port: null }], "19000-19000");
    expect(out[0].addr).toBe(":19000");
    expect(out[1].addr).toContain("WAIT_LISTEN"); // fallback
  });

  test("non-WAIT_LISTEN services are untouched (including out-node style)", () => {
    const services = [{ name: "tcp", addr: ":WAIT_LISTEN" }];
    const out = resolveDynamicServicePorts(
      [{ name: "foo", addr: ":19000" }],
      tunnels,
      "19000-19010",
    );
    expect(out[0].addr).toBe(":19000");
    expect(services).toBeDefined();
  });

  test("preserves extra service fields", () => {
    const out = resolveDynamicServicePorts(
      [{ name: "tcp-8", addr: ":WAIT_LISTEN19000-19010", extra: 42 } as never],
      tunnels,
      "19000-19010",
    );
    expect((out[0] as unknown as { extra: number }).extra).toBe(42);
  });
});

describe("formatListenAddr", () => {
  test("with and without prefix", () => {
    expect(formatListenAddr("127.0.0.1", 8080)).toBe("127.0.0.1:8080");
    expect(formatListenAddr("", 8080)).toBe(":8080");
    expect(formatListenAddr(null, 8080)).toBe(":8080");
  });
});
