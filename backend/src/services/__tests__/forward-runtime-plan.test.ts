/**
 * V5-WP2 —— RuntimePlan 是**纯计划**。
 *
 * 计划存在的意义是让「协议 / 传输 / 拓扑 / 位置 / 监听 / 远端」这六件事有一个
 * 单一的说法，供 Gate 与后续协议断言，而不是让每个调用点各自拼一遍。所以本文件
 * 守两件事：
 *
 *   1. 计划里**只有事实**（可序列化，无 socket、无函数、无实时状态）；
 *   2. 计划必须**自洽**——协议与传输不能矛盾，拓扑与位置/远端不能矛盾。
 *      这一类错误用类型表达不了（都是 string/number），只能靠显式校验。
 */
import { describe, expect, test } from "bun:test";
import {
  FORWARD_PROTOCOLS,
  FORWARD_TRANSPORTS,
  FORWARD_TRANSPORT_SPECS,
  buildForwardRuntimePlan,
  forwardRuntimePlanViolations,
  type ForwardRuntimePlan,
} from "../forward-contract.ts";

function directPlan(over: Parameters<typeof buildForwardRuntimePlan>[2] = {}): ForwardRuntimePlan {
  return buildForwardRuntimePlan("direct", "tcp", {
    revision: 3,
    placement: { ingress_node_id: 1 },
    listener: { host: "0.0.0.0", port: 20001 },
    upstream: { targets: [{ host: "192.168.1.10", port: 8080 }] },
    ...over,
  });
}

function relayPlan(over: Parameters<typeof buildForwardRuntimePlan>[2] = {}): ForwardRuntimePlan {
  return buildForwardRuntimePlan("relay", "tcp", {
    revision: 4,
    placement: { ingress_node_id: 1, egress_node_id: 2, egress_pool_id: 99 },
    listener: { port: 20002 },
    upstream: { targets: [{ host: "192.168.1.10", port: 8080 }], next_hop: "10.0.0.2:30001" },
    ...over,
  });
}

describe("plan facts", () => {
  test("a fully specified plan is valid", () => {
    expect(forwardRuntimePlanViolations(directPlan())).toEqual([]);
    expect(forwardRuntimePlanViolations(relayPlan())).toEqual([]);
  });

  test("the plan carries the six dimensions WP2 froze", () => {
    const plan = relayPlan();
    expect(Object.keys(plan).sort()).toEqual([
      "listener",
      "placement",
      "protocol",
      "revision",
      "topology",
      "transport",
      "upstream",
    ]);
  });

  test("the plan is pure data: JSON round-trips without losing anything", () => {
    const plan = relayPlan();
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  });

  test("omitted facts are explicit nulls, never undefined or zero", () => {
    const plan = buildForwardRuntimePlan("relay");
    expect(plan.revision).toBe(0);
    expect(plan.placement).toEqual({ ingress_node_id: null, egress_node_id: null, egress_pool_id: null });
    expect(plan.listener).toEqual({ host: null, port: null });
    expect(plan.upstream).toEqual({ targets: [], next_hop: null });
    // A relay plan with no facts is legitimately incomplete — the validator says
    // exactly what is missing instead of letting it through.
    expect(forwardRuntimePlanViolations(plan)).toEqual([
      "RELAY plan needs an egress node",
      "RELAY plan needs a <host>:<port> next_hop",
    ]);
  });

  test("the transport follows the protocol, and nothing else chooses it", () => {
    // V5-WP5-A1 added tls (a protocol on the SAME stream transport); V5.1b added
    // udp, the first protocol on `datagram`. Both halves matter: a new protocol
    // must not need a new transport, and a new transport must not appear without
    // a protocol that derives it — transport is never a user field (WP0).
    expect([...FORWARD_PROTOCOLS]).toEqual(["tcp", "tls", "ws", "udp", "both"]);
    expect([...FORWARD_TRANSPORTS]).toEqual(["stream", "datagram", "mixed"]);

    const expected: Record<
      (typeof FORWARD_PROTOCOLS)[number],
      { name: "stream" | "datagram" | "mixed"; lifecycle: "connection" | "mapping" | "connection_and_mapping" }
    > = {
      tcp: { name: "stream", lifecycle: "connection" },
      tls: { name: "stream", lifecycle: "connection" },
      ws: { name: "stream", lifecycle: "connection" },
      udp: { name: "datagram", lifecycle: "mapping" },
      both: { name: "mixed", lifecycle: "connection_and_mapping" },
    };
    for (const protocol of FORWARD_PROTOCOLS) {
      const plan = buildForwardRuntimePlan("direct", protocol);
      expect(plan.transport).toEqual(expected[protocol]);
      expect(plan.protocol).toEqual({ name: protocol });
    }
    // A datagram tunnel has no connection to drain: the lifecycle is what says so,
    // and it is derived, never passed in.
    expect(FORWARD_TRANSPORT_SPECS.datagram.lifecycle).toBe("mapping");
  });

  test("an unknown protocol or mode is refused at build time, not silently planned", () => {
    expect(() => buildForwardRuntimePlan("tcp" as never)).toThrow();
    for (const unopened of ["quic", "wss"]) {
      expect(() => buildForwardRuntimePlan("direct", unopened as never)).toThrow();
    }
  });
});

describe("plan self-consistency", () => {
  test("transport must be the one that carries the protocol", () => {
    const plan = directPlan();
    const tampered = { ...plan, transport: { ...plan.transport, name: "datagram" as never } };
    expect(forwardRuntimePlanViolations(tampered)).toContain(
      "transport datagram does not carry protocol tcp",
    );
  });

  test("the transport lifecycle must match the frozen transport spec", () => {
    const plan = directPlan();
    const tampered = { ...plan, transport: { name: "stream" as const, lifecycle: "packet" as never } };
    expect(forwardRuntimePlanViolations(tampered)).toContain("transport stream lifecycle mismatch");
  });

  /**
   * 拓扑与位置/远端的矛盾是这一类里最危险的：RELAY 少了 next_hop 会下发一条
   * 永远连不上的入口；DIRECT 带着出口节点说明编排把两种拓扑混了。
   */
  test("DIRECT must not have an egress node, pool or next_hop", () => {
    const plan = directPlan();
    expect(
      forwardRuntimePlanViolations({ ...plan, placement: { ...plan.placement, egress_node_id: 2 } }),
    ).toContain("DIRECT plan must not have an egress node");
    expect(
      forwardRuntimePlanViolations({ ...plan, placement: { ...plan.placement, egress_pool_id: 99 } }),
    ).toContain("DIRECT plan must not have an egress pool");
    expect(
      forwardRuntimePlanViolations({ ...plan, upstream: { ...plan.upstream, next_hop: "10.0.0.2:30001" } }),
    ).toContain("DIRECT plan must not have a next_hop");
  });

  test("RELAY must have an egress node and a well-formed next_hop", () => {
    const plan = relayPlan();
    expect(
      forwardRuntimePlanViolations({ ...plan, placement: { ...plan.placement, egress_node_id: null } }),
    ).toContain("RELAY plan needs an egress node");
    for (const next_hop of [null, "", "10.0.0.2", ":30001", "10.0.0.2:"]) {
      const violations = forwardRuntimePlanViolations({ ...plan, upstream: { ...plan.upstream, next_hop } });
      expect(violations).toContain("RELAY plan needs a <host>:<port> next_hop");
    }
  });

  test("revision and listener port must be sane before anything is dispatched", () => {
    expect(forwardRuntimePlanViolations(directPlan({ revision: -1 }))).toContain(
      "revision -1 is not a non-negative integer",
    );
    expect(forwardRuntimePlanViolations(directPlan({ revision: 1.5 }))).toContain(
      "revision 1.5 is not a non-negative integer",
    );
    for (const port of [0, -1, 65536, 1.5]) {
      const violations = forwardRuntimePlanViolations(directPlan({ listener: { port } }));
      expect(violations.some((v) => v.startsWith("listener port"))).toBe(true);
    }
    // null = not allocated yet is not a violation; a plan can describe a
    // forward whose port has not been picked.
    expect(forwardRuntimePlanViolations(directPlan({ listener: { port: null } }))).toEqual([]);
  });

  test("upstream targets must be addressable", () => {
    const plan = directPlan();
    expect(
      forwardRuntimePlanViolations({
        ...plan,
        upstream: { next_hop: null, targets: [{ host: "  ", port: 8080 }] },
      }),
    ).toContain("upstream target 0 has no host");
    expect(
      forwardRuntimePlanViolations({
        ...plan,
        upstream: { next_hop: null, targets: [{ host: "a.example", port: 0 }] },
      }),
    ).toContain("upstream target 0 has an invalid port");
  });

  test("violations accumulate instead of stopping at the first one", () => {
    const broken = {
      ...directPlan(),
      revision: -1,
      placement: { ingress_node_id: null, egress_node_id: 2, egress_pool_id: 9 },
      listener: { host: null, port: 99999 },
      upstream: { targets: [], next_hop: "10.0.0.2:1" },
    } as ForwardRuntimePlan;
    expect(forwardRuntimePlanViolations(broken).length).toBeGreaterThan(3);
  });
});
