/**
 * V5.4 WP11/WP12 —— 线性路由的契约（`DEVELOPMENT.md` §9「V5.4 冻结契约」）。
 *
 * 这一层的价值在于把**禁止项**变成可执行断言：线性、上限 3 跳、相邻必须有绑定、位置而非节点、
 * 单 revision、归属唯一（hop 0）、失败必带 hop_index。它们写在注释里不会拦住任何人。
 */
import { describe, expect, test } from "bun:test";

import {
  MAX_ROUTE_HOPS,
  admitRoute,
  attributeFailure,
  buildRoutePlan,
  compensationSteps,
  routeSteps,
  routeViolations,
} from "../forward-route.ts";

const direct = (over: Record<string, unknown> = {}) =>
  buildRoutePlan({ ingress_node_id: 3, egress_node_id: null, middle_node_id: null, tunnel_mode: "direct", revision: 7, ...over } as never);
const relay = (over: Record<string, unknown> = {}) =>
  buildRoutePlan({ ingress_node_id: 3, egress_node_id: 4, middle_node_id: null, tunnel_mode: "relay", revision: 7, ...over } as never);

describe("V5.4: the route is linear, bounded and positional", () => {
  test("a DIRECT Forward is exactly two hops on ONE node (client face + target face)", () => {
    const plan = direct()!;
    expect(plan.hops.map((h) => h.hop_index)).toEqual([0, 1]);
    // 同一台机器承担两个角色 —— 这正是中间跳能插进来的位置。
    expect(plan.hops.every((h) => h.node_id === 3)).toBe(true);
    expect(plan.hops.map((h) => h.role)).toEqual(["ingress", "egress"]);
  });

  test("a 2-hop DIRECT inserts a middle hop and keeps hop 0 as the only owner", () => {
    const plan = direct({ middle_node_id: 5 })!;
    expect(plan.hops.map((h) => [h.hop_index, h.role, h.node_id])).toEqual([
      [0, "ingress", 3],
      [1, "middle", 5],
      [2, "egress", 3],
    ]);
    // hop 0 是唯一归属持有者（§9 第 7 条）—— 中间跳是资源，不是 owner。
    expect(plan.ingress_node_id).toBe(3);
  });

  test("a RELAY with a middle hop is three hops", () => {
    const plan = relay({ middle_node_id: 5 })!;
    expect(plan.hops).toHaveLength(3);
    expect(plan.egress_node_id).toBe(4);
  });

  test("there is ONE revision for the whole route — no per-hop revisions", () => {
    const plan = relay({ middle_node_id: 5 })!;
    expect(plan.revision).toBe(7);
    // 类型层面就不存在 per-hop revision：路由是一个整体。
    expect(Object.keys(plan)).not.toContain("hop_revisions");
  });

  test("degenerate placements are refused rather than guessed", () => {
    expect(buildRoutePlan({ ingress_node_id: null, egress_node_id: 4, middle_node_id: null, tunnel_mode: "relay", revision: 1 })).toBeNull();
    expect(buildRoutePlan({ ingress_node_id: 3, egress_node_id: null, middle_node_id: null, tunnel_mode: "relay", revision: 1 })).toBeNull();
    // 中间跳等于两端是同一个节点 ⇒ 那不是"三跳"，是配置错误。
    expect(direct({ middle_node_id: 3 })).toBeNull();
    expect(relay({ middle_node_id: 4 })).toBeNull();
  });

  test("the hop cap is 3 and it is a constant, not a comment", () => {
    expect(MAX_ROUTE_HOPS).toBe(3);
  });
});

describe("V5.4: adjacency needs a binding, and errors name the hop", () => {
  test("a three-hop route without bindings between neighbours is refused", () => {
    const plan = relay({ middle_node_id: 5 })!;
    expect(routeViolations(plan, new Set())).toContain("unknown_topology");
    expect(routeViolations(plan, new Set(["3->5", "5->4"]))).toEqual([]);
  });

  test("the SAME node may hold two adjacent roles — that is what DIRECT is", () => {
    // 第一版有一条 `duplicate_node` 检查，而它唯一会命中的场景就是这个合法场景：
    // DIRECT 的 hop 0（面向客户端）与 hop 1（拨号到目标）在同一台机器上。
    // 把"合法的单跳"判成非法，比漏判更糟 —— 它会拦掉 V4 以来一直正常工作的配置。
    const plan = direct()!;
    expect(plan.hops[0]!.node_id).toBe(plan.hops[1]!.node_id);
    expect(routeViolations(plan, new Set())).toEqual([]);
  });

  test("but a node cannot be BOTH a middle hop and an end", () => {
    // 那两条才是真正要禁止的，而且由 buildRoutePlan 直接拒绝（不进校验层）。
    expect(direct({ middle_node_id: 3 })).toBeNull();
    expect(relay({ middle_node_id: 3 })).toBeNull();
    expect(relay({ middle_node_id: 4 })).toBeNull();
  });

  test("forward applies FAR first, compensation tears down NEAR first", () => {
    const plan = relay({ middle_node_id: 5 })!;
    const forward = routeSteps(plan).map((s) => s.hop_index);
    const compensate = compensationSteps(plan).map((s) => s.hop_index);
    // §1 铁律在 N 跳上的推广：正向先远后近（2,1,0），拆除先近后远（0,1,2）。
    expect(forward).toEqual([2, 1, 0]);
    expect(compensate).toEqual([0, 1, 2]);
  });

  test("every step says which role it is, so a caller cannot apply the wrong thing", () => {
    const steps = routeSteps(relay({ middle_node_id: 5 })!);
    expect(steps.map((s) => s.action)).toEqual(["apply_target_dial", "apply_transit", "apply_client_front"]);
  });

  test("a failure is attributed to a HOP, not just to a Forward", () => {
    const plan = relay({ middle_node_id: 5 })!;
    expect(attributeFailure(plan, 5)).toEqual({ hop_index: 1, node_id: 5 });
    expect(attributeFailure(plan, 999)).toBeNull();
  });
});

describe("V5.4: a route that cannot be dispatched is REFUSED, not silently degraded", () => {
  test("a single-hop route is admitted regardless of bindings", () => {
    const relayPlacement = {
      ingress_node_id: 3, egress_node_id: 4, middle_node_id: null, tunnel_mode: "relay" as const, revision: 1,
    };
    const admitted = admitRoute(relayPlacement, new Set());
    expect(admitted.ok).toBe(true);
  });

  test("a configured middle hop is refused while multi-hop dispatch is unimplemented", () => {
    // 这是本阶段最重要的一条：`middle_node_id` 非空意味着用户要三跳，而当前下发只会发出
    // 单跳形状 —— 放行的话转发**会正常工作，但走的是另一条路**，没有任何错误。因此拒绝。
    const admitted = admitRoute(
      { ingress_node_id: 3, egress_node_id: 4, middle_node_id: 5, tunnel_mode: "relay", revision: 1 },
      new Set(["3->5", "5->4"]),
    );
    expect(admitted.ok).toBe(false);
    if (!admitted.ok) {
      expect(admitted.code).toBe("route_not_dispatchable");
      // 错误必须点名"哪一跳"—— 三跳下"这条转发失败了"无法定位。
      expect(admitted.error).toContain("hop 1");
      expect(admitted.error).toContain("节点 5");
    }
  });

  test("multi-hop is admitted once the caller declares it implemented", () => {
    const admitted = admitRoute(
      { ingress_node_id: 3, egress_node_id: 4, middle_node_id: 5, tunnel_mode: "relay", revision: 1 },
      new Set(["3->5", "5->4"]),
      { multiHopImplemented: true },
    );
    expect(admitted.ok).toBe(true);
    if (admitted.ok) expect(admitted.hop_indices).toEqual([0, 1, 2]);
  });

  test("a multi-hop route whose neighbours are not bound is route_invalid, not just refused", () => {
    // 两种拒绝必须可区分：一个是"这个形状还没做"，一个是"这个配置根本不合法"。
    const admitted = admitRoute(
      { ingress_node_id: 3, egress_node_id: 4, middle_node_id: 5, tunnel_mode: "relay", revision: 1 },
      new Set(),
      { multiHopImplemented: true },
    );
    expect(admitted.ok).toBe(false);
    if (!admitted.ok) expect(admitted.code).toBe("route_invalid");
  });

  test("contradictory placement facts are refused before anything else", () => {
    const admitted = admitRoute(
      { ingress_node_id: 3, egress_node_id: null, middle_node_id: null, tunnel_mode: "relay", revision: 1 },
      new Set(),
    );
    expect(admitted.ok).toBe(false);
    if (!admitted.ok) expect(admitted.code).toBe("route_invalid");
  });
});
