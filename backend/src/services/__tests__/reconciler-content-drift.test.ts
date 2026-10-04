/**
 * V5.3（round 6/7）—— reconcile 必须比较**内容**，不只是"存在性与 revision"。
 *
 * 这一个缺口同时解释三个实测症状：
 *   · agent 的池变空（隧道"在"，所以健康）；
 *   · 健康数组过期（"在且 revision 对"，所以不重发）；
 *   · `resent: 0` —— 那不是独立缺陷，而是这个判定的直接后果。
 * 结果是转发"连得上、转发不出数据"，而面板认为一切正常。
 */
import { describe, expect, test } from "bun:test";

import { computeDrift, planTunnelActions } from "../reconciler.ts";
import type { AgentTunnelState, DesiredTunnel } from "../reconciler.ts";

const NOW = new Date("2026-10-04T12:00:00Z");

const desired = (over: Partial<DesiredTunnel> = {}): DesiredTunnel => ({
  id: 2,
  tunnel_mode: "relay",
  desired_status: "active",
  config_revision: 5,
  applied_revision: 5,
  ingress_node_id: 3,
  egress_node_id: 4,
  ...over,
});

const applied = (over: Partial<AgentTunnelState> = {}): AgentTunnelState => ({
  id: "2",
  mode: "relay",
  revision: 5,
  ...over,
});

const node = { node_id: 4, status: "active" as const, last_seen_at: new Date(NOW.getTime() - 5_000), reported_at: null };

describe("V5.3: content drift (existence is not enough)", () => {
  test("an EMPTY applied pool against a non-empty desired pool is drift, and says why", () => {
    const drifts = computeDrift(
      desired({ desired_pool_targets: ["target-a:3030", "target-a:9"] }),
      applied({ applied_pool_targets: [] }),
      node,
      NOW,
    );
    const content = drifts.filter((d) => d.kind === "content_drift");
    expect(content).toHaveLength(1);
    // 症状写进 detail：运维看到的是"连得上但没数据"，日志里必须直接给出这个因果。
    expect(content[0]?.detail).toContain("agent 池为空");
  });

  test("a pool that matches exactly is NOT drift (no resend storms)", () => {
    const drifts = computeDrift(
      desired({ desired_pool_targets: ["target-a:3030", "target-a:9"] }),
      applied({ applied_pool_targets: ["target-a:9", "target-a:3030"] }),
      node,
      NOW,
    );
    expect(drifts.filter((d) => d.kind === "content_drift")).toHaveLength(0);
  });

  test("a stale health array is drift", () => {
    const drifts = computeDrift(
      desired({ desired_target_health: ["target-a:3030=healthy", "target-a:9=unhealthy"] }),
      applied({ applied_target_health: ["target-a:3030=healthy", "target-a:9=healthy"] }),
      node,
      NOW,
    );
    expect(drifts.filter((d) => d.kind === "content_drift")).toHaveLength(1);
  });

  test("an ABSENT fact on either side is not drift — 'not loaded' is not 'empty'", () => {
    // 这一条防的是"每拍无谓重发"：面板没加载池内容时，不能把它读成空池。
    for (const [d, a] of [
      [desired({}), applied({ applied_pool_targets: [] })],
      [desired({ desired_pool_targets: ["x:1"] }), applied({})],
    ] as const) {
      expect(computeDrift(d, a, node, NOW).filter((x) => x.kind === "content_drift")).toHaveLength(0);
    }
  });

  test("content drift plans a SAME-REVISION resend (content is not part of a revision)", () => {
    const drifts = computeDrift(
      desired({ desired_pool_targets: ["target-a:3030"] }),
      applied({ applied_pool_targets: [] }),
      node,
      NOW,
    );
    const actions = planTunnelActions(desired({ desired_pool_targets: ["target-a:3030"] }), drifts, NOW, {
      nodeReachable: true,
      nodeInMaintenance: false,
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe("resend_same_revision");
    // 同 revision：池目标与健康来自面板的实时读，不属于 revision 的内容。
    expect(actions[0]?.revision).toBe(5);
  });
});
