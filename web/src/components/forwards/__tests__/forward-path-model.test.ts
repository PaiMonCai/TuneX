/**
 * R4-B1 —— 创建对话框的「线路预览」模型（纯函数）。
 *
 * 这个文件守的是**预览说出来的事实**，不是像素：
 *   · DIRECT 段数 = 1（「入口 → 目标」）且理由是 `direct_design` —— **没有节点间跳是设计
 *     结论**，不是缺数据，绝不退化成空态/缺口；
 *   · RELAY 段数 = 2、节点间跳 = 1（「入口 → 出口 → 目标」）；
 *   · 绑定事实三态（有 / 确实没有 / **取不到**）互不合并，且"取不到"永远不会被算成
 *     "没有可用出口"；
 *   · 节点名/地址缺失只降级，不留空白；
 *   · DIRECT 不因为草稿里残留的出口 id 而多出一步（提交语义不变）。
 *
 * 跑法（web 目录）：bun test src/components/forwards/__tests__/forward-path-model.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  buildForwardPathPreview,
  connectAddress,
  forwardPathScopeKey,
  isEgressBound,
  nodeLabel,
  pathBindingsStatus,
  resolveEgressNode,
  type ForwardPathInput,
} from "@/components/forwards/forward-path-model";
import { emptyForwardCreateDraft, type ForwardCreateDraft } from "@/components/forwards/forward-create-model";
import type { NodeBinding, UserNode } from "@/lib/types";

function node(over: Partial<UserNode> = {}): UserNode {
  return {
    id: 1,
    node_id: "hk-in-01",
    agent_id: "agent-1",
    connect_ip: "10.0.0.11",
    role: "ingress",
    node_group_id: 3,
    ...over,
  } as UserNode;
}

function binding(over: Partial<NodeBinding> = {}): NodeBinding {
  return {
    id: 1,
    ingress_node_id: 1,
    egress_node_id: 2,
    egress_node: node({ id: 2, node_id: "jp-out-01", connect_ip: "10.0.0.21", role: "egress" }),
    created_at: "2026-10-06T00:00:00.000Z",
    used_by_forward_count: 0,
    unbind_blocked: false,
    ...over,
  };
}

const SCOPE = forwardPathScopeKey({ workspaceId: 1, ingressId: "1" });

function draft(over: Partial<ForwardCreateDraft> = {}): ForwardCreateDraft {
  return {
    ...emptyForwardCreateDraft("direct", node()),
    name: "web-hk",
    targetHost: "example.com",
    targetPort: "443",
    ...over,
  };
}

function preview(over: Partial<ForwardPathInput> = {}) {
  const base: ForwardPathInput = {
    draft: draft(),
    ingress: node(),
    egress: null,
    scopeKey: SCOPE,
    bindingsFacts: { scopeKey: SCOPE, bindings: [] },
    bindableEgressCount: 0,
  };
  return buildForwardPathPreview({ ...base, ...over });
}

const roles = (input: Partial<ForwardPathInput> = {}) =>
  preview(input).steps.map((step) => step.role);

/* ================================================================== */
/* DIRECT                                                              */
/* ================================================================== */

describe("DIRECT：一段，且「没有节点间跳」是设计结论", () => {
  test("段数 1、节点间跳 0、理由 = direct_design（不是缺数据/空态）", () => {
    const model = preview();
    expect(model.mode).toBe("direct");
    expect(model.segmentCount).toBe(1);
    expect(model.interNodeHops).toBe(0);
    expect(model.segmentReason).toBe("direct_design");
    expect(roles()).toEqual(["ingress", "target"]);
    // 没有任何"缺一步"的缺口：DIRECT 本来就只有这两步。
    expect(model.gaps).not.toContain("egress_not_chosen");
    expect(model.gaps).not.toContain("egress_not_bound");
  });

  test("草稿里残留出口 id 也不会多出一步（提交语义不变）", () => {
    const model = preview({
      draft: draft({ mode: "direct", egressId: "2" }),
      egress: node({ id: 2, node_id: "jp-out-01", role: "egress" }),
    });
    expect(model.segmentCount).toBe(1);
    expect(roles({ draft: draft({ mode: "direct", egressId: "2" }) })).toEqual(["ingress", "target"]);
    expect(model.gaps).not.toContain("egress_not_bound");
  });

  test("direct 的空草稿出口字段保持空串（提交时不会带出口）", () => {
    expect(emptyForwardCreateDraft("direct", node()).egressId).toBe("");
    // 中间跳只是结构预留，且不进请求（载荷由 forward-workspace 逐字段赋值）。
    expect(emptyForwardCreateDraft("direct", node()).middleNodeId).toBe("");
  });
});

/* ================================================================== */
/* RELAY                                                               */
/* ================================================================== */

describe("RELAY：两段（入口 → 出口 → 目标）", () => {
  const relayDraft = draft({ mode: "relay", egressId: "2" });

  test("段数 2、节点间跳 1、理由 = relay_two_segments", () => {
    const model = preview({
      draft: relayDraft,
      egress: node({ id: 2, node_id: "jp-out-01", connect_ip: "10.0.0.21", role: "egress" }),
      bindingsFacts: { scopeKey: SCOPE, bindings: [binding()] },
    });
    expect(model.mode).toBe("relay");
    expect(model.segmentCount).toBe(2);
    expect(model.interNodeHops).toBe(1);
    expect(model.segmentReason).toBe("relay_two_segments");
    expect(roles({ draft: relayDraft, bindingsFacts: { scopeKey: SCOPE, bindings: [binding()] } }))
      .toEqual(["ingress", "egress", "target"]);
  });

  test("每一步都带节点名与连接地址", () => {
    const model = preview({
      draft: relayDraft,
      egress: node({ id: 2, node_id: "jp-out-01", connect_ip: "10.0.0.21", role: "egress" }),
      bindingsFacts: { scopeKey: SCOPE, bindings: [binding()] },
    });
    expect(model.steps[0]!.label).toBe("hk-in-01");
    expect(model.steps[0]!.address).toBe("10.0.0.11");
    expect(model.steps[1]!.label).toBe("jp-out-01");
    expect(model.steps[1]!.address).toBe("10.0.0.21");
    // 名字只取 host，完整地址在 address 上（同一个值写两遍会像重复渲染）。
    expect(model.steps[2]!.label).toBe("example.com");
    expect(model.steps[2]!.address).toBe("example.com:443");
  });

  test("连接地址未上报 ⇒ address 为 null 且有独立缺口码（不是空白）", () => {
    const model = preview({
      draft: relayDraft,
      ingress: node({ connect_ip: null }),
      egress: node({ id: 2, node_id: "jp-out-01", connect_ip: "", role: "egress" }),
      bindingsFacts: { scopeKey: SCOPE, bindings: [binding()] },
    });
    expect(model.steps[0]!.address).toBeNull();
    expect(model.steps[1]!.address).toBeNull();
    expect(model.gaps).toContain("ingress_address_unreported");
    expect(model.gaps).toContain("egress_address_unreported");
    // 名字照旧有：地址缺失不影响节点名。
    expect(model.steps[1]!.label).toBe("jp-out-01");
  });

  test("没选出口 ⇒ 缺的是「选出口」，不是「没绑定」", () => {
    const model = preview({ draft: draft({ mode: "relay", egressId: "" }), egress: null });
    expect(model.gaps).toContain("egress_not_chosen");
    expect(model.gaps).not.toContain("egress_not_bound");
    expect(model.gaps).not.toContain("bindings_unavailable");
  });

  test("所选出口不在绑定列表里 ⇒ egress_not_bound（事实核对，不放行「看着像绑定」）", () => {
    const model = preview({
      draft: relayDraft,
      egress: node({ id: 2, node_id: "jp-out-01", role: "egress" }),
      bindingsFacts: { scopeKey: SCOPE, bindings: [binding({ egress_node_id: 9 })] },
    });
    expect(model.gaps).toContain("egress_not_bound");
  });
});

/* ================================================================== */
/* 绑定三态                                                            */
/* ================================================================== */

describe("绑定事实：有 / 确实没有 / 取不到，三态不可合并", () => {
  test("有绑定 ⇒ bound，且不产生缺口", () => {
    const model = preview({
      draft: draft({ mode: "relay", egressId: "2" }),
      egress: node({ id: 2, node_id: "jp-out-01", role: "egress" }),
      bindingsFacts: { scopeKey: SCOPE, bindings: [binding()] },
    });
    expect(model.bindingsStatus).toBe("bound");
    expect(model.gaps).not.toContain("egress_not_bound");
    expect(model.gaps).not.toContain("bindings_unavailable");
  });

  test("事实明确为空 ⇒ none（下一步是去绑定）", () => {
    const model = preview({ draft: draft({ mode: "relay" }), bindingsFacts: { scopeKey: SCOPE, bindings: [] } });
    expect(model.bindingsStatus).toBe("none");
    expect(model.gaps).not.toContain("bindings_unavailable");
  });

  test("facts 为 null（读取失败/仍在读取）⇒ unavailable + bindings_unavailable 缺口", () => {
    const model = preview({ draft: draft({ mode: "relay" }), bindingsFacts: null });
    expect(model.bindingsStatus).toBe("unavailable");
    expect(model.gaps).toContain("bindings_unavailable");
    // 关键：不许把它算成"没绑定"。
    expect(model.gaps).not.toContain("egress_not_bound");
  });

  test("晚到的旧作用域事实被丢弃 ⇒ 判成取不到，而不是沿用", () => {
    const otherScope = forwardPathScopeKey({ workspaceId: 2, ingressId: "1" });
    const model = preview({
      draft: draft({ mode: "relay", egressId: "2" }),
      egress: node({ id: 2, node_id: "jp-out-01", role: "egress" }),
      scopeKey: SCOPE,
      bindingsFacts: { scopeKey: otherScope, bindings: [binding()] },
    });
    expect(model.bindingsStatus).toBe("unavailable");
    expect(model.gaps).toContain("bindings_unavailable");
    expect(model.gaps).not.toContain("egress_not_bound");
  });

  test("pathBindingsStatus 是唯一判定点", () => {
    expect(pathBindingsStatus({ scopeKey: SCOPE, bindings: [binding()] }, SCOPE)).toBe("bound");
    expect(pathBindingsStatus({ scopeKey: SCOPE, bindings: [] }, SCOPE)).toBe("none");
    expect(pathBindingsStatus({ scopeKey: SCOPE, bindings: null }, SCOPE)).toBe("unavailable");
    expect(pathBindingsStatus(null, SCOPE)).toBe("unavailable");
    expect(
      pathBindingsStatus({ scopeKey: forwardPathScopeKey({ workspaceId: 9, ingressId: "1" }), bindings: [] }, SCOPE),
    ).toBe("unavailable");
  });

  test("resolveEgressNode：绑定事实优先（出口可能不在入口节点列表里）", () => {
    const egressNode = node({ id: 2, node_id: "jp-out-01", connect_ip: "10.0.0.21", role: "egress" });
    // 节点列表只装入入口能力的节点 ⇒ 出口不在里面，名字仍然来自绑定事实。
    expect(resolveEgressNode({ egressId: "2", bindings: [binding()], nodes: [node()] })?.node_id)
      .toBe("jp-out-01");
    // 没有事实时退回节点列表。
    expect(resolveEgressNode({ egressId: "2", bindings: null, nodes: [egressNode] })?.node_id)
      .toBe("jp-out-01");
    // 两处都没有 ⇒ null（展示层据此降级成 #id，而不是编一个名字）。
    expect(resolveEgressNode({ egressId: "7", bindings: [binding()], nodes: [node()] })).toBeNull();
    expect(resolveEgressNode({ egressId: "", bindings: [binding()], nodes: [node()] })).toBeNull();
  });

  test("isEgressBound 只认事实，空 id 不算绑定", () => {
    expect(isEgressBound([binding()], "2")).toBe(true);
    expect(isEgressBound([binding()], "3")).toBe(false);
    expect(isEgressBound(null, "2")).toBe(false);
    expect(isEgressBound([binding()], "")).toBe(false);
  });

  test("作用域键随 Workspace / 入口变化（切空间即换键）", () => {
    expect(forwardPathScopeKey({ workspaceId: 1, ingressId: "1" }))
      .toBe(forwardPathScopeKey({ workspaceId: 1, ingressId: "1" }));
    expect(forwardPathScopeKey({ workspaceId: 1, ingressId: "1" }))
      .not.toBe(forwardPathScopeKey({ workspaceId: 2, ingressId: "1" }));
    expect(forwardPathScopeKey({ workspaceId: 1, ingressId: "1" }))
      .not.toBe(forwardPathScopeKey({ workspaceId: 1, ingressId: "2" }));
  });
});

/* ================================================================== */
/* 降级与缺口                                                          */
/* ================================================================== */

describe("节点名与目标缺失只降级，不留空白", () => {
  test("node_id 为空 ⇒ 退到 #<id>", () => {
    expect(nodeLabel(node({ node_id: "" }), "1")).toBe("#1");
    expect(nodeLabel(node({ node_id: "  " }), "7")).toBe("#7");
    expect(nodeLabel(node({ node_id: "hk-in-01" }), "1")).toBe("hk-in-01");
  });

  test("节点对象整个缺失 ⇒ 用草稿里的 id 降级；两者都没有 ⇒ 破折号", () => {
    expect(nodeLabel(null, "5")).toBe("#5");
    expect(nodeLabel(null, "")).toBe("—");
  });

  test("connectAddress 把空白/缺失统一成 null", () => {
    expect(connectAddress(node({ connect_ip: null }))).toBeNull();
    expect(connectAddress(node({ connect_ip: "   " }))).toBeNull();
    expect(connectAddress(null)).toBeNull();
    expect(connectAddress(node({ connect_ip: "10.0.0.11" }))).toBe("10.0.0.11");
  });

  test("目标缺 host / 缺 port 各有独立缺口码，且只标该缺的", () => {
    expect(preview({ draft: draft({ targetHost: "", targetPort: "443" }) }).gaps)
      .toEqual(["target_host_missing"]);
    expect(preview({ draft: draft({ targetHost: "example.com", targetPort: "" }) }).gaps)
      .toEqual(["target_port_missing"]);
    expect(preview({ draft: draft({ targetHost: "example.com", targetPort: "443" }) }).gaps)
      .toEqual([]);
  });

  test("缺口去重且顺序稳定（同一个码只出现一次）", () => {
    const model = preview({
      draft: draft({ mode: "relay", targetHost: "", targetPort: "" }),
      ingress: node({ connect_ip: null }),
      bindingsFacts: null,
    });
    expect(new Set(model.gaps).size).toBe(model.gaps.length);
    expect(model.gaps).toEqual([
      "ingress_address_unreported",
      "target_host_missing",
      "egress_not_chosen",
      "bindings_unavailable",
    ]);
  });

  test("已绑定数量只在事实明确时才有值（取不到 ⇒ null，不许给 0 冒充）", () => {
    const bound = preview({
      draft: draft({ mode: "relay", egressId: "2" }),
      egress: node({ id: 2, node_id: "jp-out-01", role: "egress" }),
      bindingsFacts: { scopeKey: SCOPE, bindings: [binding(), binding({ id: 2, egress_node_id: 3 })] },
    });
    expect(bound.boundEgressCount).toBe(2);
    expect(preview({ bindingsFacts: { scopeKey: SCOPE, bindings: [] } }).boundEgressCount).toBe(0);
    expect(preview({ bindingsFacts: null }).boundEgressCount).toBeNull();
  });

  test("bindableEgressCount 原样透传（可空 = 没有事实）", () => {
    expect(preview({ bindableEgressCount: 3 }).bindableEgressCount).toBe(3);
    expect(preview({ bindableEgressCount: null }).bindableEgressCount).toBeNull();
    expect(preview({}).bindableEgressCount).toBe(0);
  });
});
