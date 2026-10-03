/**
 * V4-WP11C — 探针计划的安全性质。
 *
 * 这一层的存在理由只有一个：**探测目标必须来自服务端持有的已授权期望状态**。
 * 因此测试的重点不是"能生成几个目标"，而是"任何情况下都不会退化成可以扫任意
 * 地址"：目标只可能取自 Forward 的 remote_host/port 与它自己那份出口池，缺事实
 * 时明确失败而不是猜。
 */
import { describe, expect, test } from "bun:test";
import {
  PROBE_MAX_TARGETS_PER_SEGMENT,
  dialedTargets,
  probeTargetsForForward,
  runtimeIdFor,
} from "../forward-probe-plan.ts";
import type { ForwardForDiagnose } from "../agent-diagnose.ts";

function forward(over: Partial<ForwardForDiagnose> = {}): ForwardForDiagnose {
  return {
    id: 7,
    mode: "direct",
    ingress_node_id: 3,
    ingress_node_key: "WP14-IN-A-NODE",
    ingress_connect_ip: "172.31.10.20",
    egress_node_id: null,
    egress_node_key: null,
    egress_connect_ip: null,
    egress_port: null,
    remote_host: "target-a",
    remote_port: 3030,
    config_revision: 1,
    pool_targets: [],
    ...over,
  };
}

describe("DIRECT probe plan", () => {
  test("probes the configured target from the ingress node only", () => {
    const plan = probeTargetsForForward(forward());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.segments).toHaveLength(1);
    const only = plan.segments[0];
    expect(only.kind).toBe("tcp_probe");
    if (only.kind !== "tcp_probe") return;
    expect(only).toMatchObject({
      segment: "ingress_to_target",
      node_id: 3,
      targets: [{ host: "target-a", port: 3030 }],
      resource_id: "tunex-7-direct",
    });
  });

  test("refuses without a complete target instead of guessing one", () => {
    for (const over of [{ remote_host: null }, { remote_port: null }, { remote_port: 70000 }, { remote_host: "   " }]) {
      const plan = probeTargetsForForward(forward(over as Partial<ForwardForDiagnose>));
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.code).toBe("no_target");
    }
  });

  test("refuses when the forward has no ingress node yet", () => {
    const plan = probeTargetsForForward(forward({ ingress_node_id: null }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("no_ingress_node");
  });

  test("never lets an extra address sneak in through the pool", () => {
    // A DIRECT forward has no pool by construction; even if one were attached,
    // the plan must not probe it.
    const plan = probeTargetsForForward(forward({ pool_targets: [{ host: "10.0.0.9", port: 22 }] }));
    if (!plan.ok) throw new Error("plan must succeed");
    expect(dialedTargets(plan).map((t) => t.host)).toEqual(["target-a"]);
  });
});

describe("RELAY probe plan", () => {
  const relay = (over: Partial<ForwardForDiagnose> = {}) =>
    forward({
      mode: "relay",
      egress_node_id: 4,
      egress_node_key: "WP14-OUT-A-NODE",
      egress_connect_ip: "172.31.20.20",
      egress_port: 22001,
      pool_targets: [{ host: "10.9.9.9", port: 8080 }],
      ...over,
    });

  test("never plans a probe against the egress node's BUSINESS listener", () => {
    const plan = probeTargetsForForward(relay());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // The business listener accepts, picks a target and dials upstream: dialling
    // it from a diagnostic would create a real business connection.
    expect(dialedTargets(plan)).toEqual([{ host: "10.9.9.9", port: 8080 }]);
    const facts = plan.segments[0];
    expect(facts.kind).toBe("node_facts");
    if (facts.kind !== "node_facts") return;
    expect(facts.segment).toBe("ingress_to_egress");
    // The hop is displayed, not dialled.
    expect(facts.hop).toEqual({ host: "172.31.20.20", port: 22001 });
    expect(facts.ingress_runtime_id).toBe("tunex-7-relay");
    expect(facts.egress_runtime_id).toBe("tunex-7-egress");
  });

  test("the only dialled segment is the egress node reaching its own targets", () => {
    const plan = probeTargetsForForward(relay());
    if (!plan.ok) throw new Error("plan must succeed");
    const probes = plan.segments.filter((s) => s.kind === "tcp_probe");
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({
      segment: "egress_to_target",
      node_id: 4,
      resource_id: "tunex-7-egress",
    });
  });

  test("does not 'simulate' the relay, and never touches the business hop", () => {
    const plan = probeTargetsForForward(relay());
    if (!plan.ok) throw new Error("plan must succeed");
    // The relay's own path (ingress -> egress business listener) is never dialled:
    // doing so would create a real business connection on the egress node.
    expect(dialedTargets(plan).some((t) => t.host === "172.31.20.20")).toBe(false);
    // The only probe is the egress node reaching its own targets — never the
    // ingress node guessing at the target.
    expect(dialedTargets(plan)).toEqual([{ host: "10.9.9.9", port: 8080 }]);
    const probes = plan.segments.filter((seg) => seg.kind === "tcp_probe");
    expect(probes.every((seg) => seg.node_id === 4)).toBe(true);
  });

  test("refuses when the plan cannot describe a usable diagnosis", () => {
    const cases: [Partial<ForwardForDiagnose>, string][] = [
      [{ egress_node_id: null }, "no_egress_runtime"],
      [{ pool_targets: [] }, "no_pool_targets"],
      [{ pool_targets: [{ host: "", port: 0 }] }, "no_pool_targets"],
    ];
    for (const [over, code] of cases) {
      const plan = probeTargetsForForward(relay(over));
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.code).toBe(code);
    }
  });

  test("an over-limit target pool is refused, never silently truncated", () => {
    // Truncating would report "the pool is reachable" after probing only part of
    // it — a conclusion the data does not support.
    const many = Array.from({ length: PROBE_MAX_TARGETS_PER_SEGMENT + 1 }, (_v, i) => ({
      host: `10.0.0.${i + 1}`,
      port: 9000 + i,
    }));
    const plan = probeTargetsForForward(relay({ pool_targets: many }));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe("too_many_targets");
  });

  test("unusable pool entries are dropped before the limit is applied", () => {
    const plan = probeTargetsForForward(relay({ pool_targets: [
      { host: "", port: 0 },
      { host: "10.0.0.1", port: 9000 },
      { host: "10.0.0.2", port: 0 },
    ] }));
    if (!plan.ok) throw new Error("plan must succeed");
    expect(dialedTargets(plan)).toEqual([{ host: "10.0.0.1", port: 9000 }]);
  });
});

describe("runtime ids", () => {
  test("match the runtime naming used by the data plane", () => {
    expect(runtimeIdFor(7, "direct")).toBe("tunex-7-direct");
    expect(runtimeIdFor(7, "relay")).toBe("tunex-7-relay");
    expect(runtimeIdFor(7, "relay", "egress")).toBe("tunex-7-egress");
  });
});
