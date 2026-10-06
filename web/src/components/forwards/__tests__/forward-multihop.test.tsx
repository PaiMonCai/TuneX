/**
 * 多跳（三跳）接线的**行为测试**：真实函数 + 真实 JSX 渲染 + 真实 mock 分发。
 *
 * 钉住的是本切片最容易做错的六件事：
 *   ① **可用性判据 = 服务端真实判据（两段邻接绑定是否都已存在）**，不是前端自造的角色闸门；
 *   ② **不可选的节点必须列出来并说明原因**，缺段时只在"能补建"的前提下给"去绑定"的下一步
 *      —— 角色不允许时给的是"不能建"的原因，而不是一条撞 409 的死路；
 *   ③ **取不到 ≠ 没有**：事实缺失/作用域不符时判 `facts_unavailable`，绝不说"没有可用节点"；
 *   ④ 载荷 fail-closed：不是 relay / 没选 / 选中项不可提交 ⇒ **不发** `middle_node_id`；
 *   ⑤ 创建前的必要校验 → 不撞 409；**撞上了也要有人话 + 下一步**（409 分支逐条断言）；
 *   ⑥ 三跳的路径是**四步三段**，且不假装列表/详情读数能看到中间跳。
 *
 * 跑法（web 目录）：bun test src/components/forwards/__tests__/forward-multihop.test.tsx
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import { handleMock } from "@/mocks/handler";
import { getStore, resetStore } from "@/mocks/state";
import {
  buildForwardMultihopModel,
  buildMultihopFacts,
  forwardMultihopScopeKey,
  multihopCreateFields,
  multihopCreateFieldsFor,
  multihopFailureInfo,
  multihopMissingSegment,
  type MultihopInput,
} from "@/components/forwards/forward-multihop-model";
import { ForwardMultihopSection, forwardMultihopCopy } from "@/components/forwards/forward-multihop-select";
import { buildForwardPathPreview, forwardPathScopeKey } from "@/components/forwards/forward-path-model";
import { ForwardPathPreview, forwardPathCopy } from "@/components/forwards/forward-path-preview";
import type { NodeBinding, UserNode } from "@/lib/types";

const SCOPE = forwardMultihopScopeKey(7); // 与 cases 里传的 workspaceId 一致
const PATH_SCOPE = forwardPathScopeKey({ workspaceId: 7, ingressId: "1" });

function node(over: Partial<UserNode> = {}): UserNode {
  return { id: 1, node_id: "hk-in-01", role: "ingress", connect_ip: "10.0.0.11", ...over } as UserNode;
}
function binding(ingress: number, egress: number, egressNode: UserNode): NodeBinding {
  return {
    id: ingress * 100 + egress,
    ingress_node_id: ingress,
    egress_node_id: egress,
    created_at: "2026-10-01T00:00:00.000Z",
    egress_node: egressNode,
  } as unknown as NodeBinding;
}

/** 三跳的完整事实：入口 1 → 中间 6（both）→ 出口 4，两段都在。 */
const MIDDLE = node({ id: 6, node_id: "sg-out-01", role: "both", connect_ip: "10.0.0.61" });
const EGRESS = node({ id: 4, node_id: "jp-out-01", role: "egress", connect_ip: "10.0.0.41" });
const INGRESS = node({ id: 1, node_id: "hk-in-01", role: "ingress", connect_ip: "10.0.0.11" });

const FULL_FACTS = {
  scopeKey: SCOPE,
  byIngress: {
    "1": [binding(1, 6, MIDDLE), binding(1, 4, EGRESS)],
    "6": [binding(6, 4, EGRESS)],
  },
};

function model(over: Partial<MultihopInput> = {}) {
  return buildForwardMultihopModel({
    mode: "relay",
    ingressId: "1",
    egressId: "4",
    middleNodeId: "",
    canManageNodes: true,
    scopeKey: SCOPE,
    facts: FULL_FACTS,
    nodes: [INGRESS, MIDDLE, EGRESS, node({ id: 5, node_id: "jp-out-02", role: "egress" })],
    ...over,
  });
}

function render(node_: React.ReactNode, locale: "zh" | "en" = "zh") {
  return renderToStaticMarkup(<I18nProvider locale={locale} dict={getDictionary(locale)}>{node_}</I18nProvider>);
}

function section(over: Partial<Parameters<typeof ForwardMultihopSection>[0]> = {}) {
  return render(
    <ForwardMultihopSection
      model={over.model ?? model()}
      locale={over.locale ?? "zh"}
      value={over.value ?? ""}
      onChange={() => undefined}
    />,
  );
}

/* ================================================================== */
/* 模型：判据、不可选原因、载荷                                          */
/* ================================================================== */

describe("可用性判据 = 服务端真实判据（两段绑定都已存在）", () => {
  test("两段都在 ⇒ 可选；候选全集内的其余节点 ⇒ 不可选并给对应原因", () => {
    const ready = model();
    expect(ready.phase).toBe("ready");
    expect(ready.candidates.map((row) => row.nodeId)).toEqual(["6"]);
    // 候选全集 = role=both 的节点 ∪ 第一段绑定里出现过的节点：
    // 出口 4 在第一段绑定里（1→4），所以它出现在"不可选"清单里并被说明原因。
    expect(ready.excluded.map((row) => row.nodeId)).toEqual(["4"]);
    expect(ready.excluded[0]!.reason).toBe("same_as_egress");
  });

  test("候选全集的边界：role=both 的节点一律列出（哪怕一段都没有），无关节点不进清单", () => {
    const bothAnywhere = node({ id: 5, node_id: "sg-out-02", role: "both", connect_ip: "10.0.0.51" });
    const unrelated = node({ id: 7, node_id: "jp-out-03", role: "egress", connect_ip: "10.0.0.71" });
    const ready = model({
      nodes: [INGRESS, MIDDLE, EGRESS, bothAnywhere, unrelated],
      // 真实预载会把"这台入口/节点没有任何绑定"登记为 `[]`（不是"没给我这份事实"）——
      // 这个区别决定了结论是"缺一段"还是"取不到"。
      facts: {
        scopeKey: SCOPE,
        byIngress: { "1": [binding(1, 6, MIDDLE)], "5": [], "6": [binding(6, 4, EGRESS)], "7": [] },
      },
    });
    expect(ready.candidates.map((row) => row.nodeId)).toEqual(["6"]);
    // 5 是 role=both（唯一能建成两段的角色）⇒ 必须列出来并说明缺哪一段；
    // 7 是 role=egress 且与入口无绑定 ⇒ 结构上不可能当中间跳，不进噪音清单。
    expect(ready.excluded.map((row) => row.nodeId)).toEqual(["5"]);
    expect(ready.excluded[0]!.reason).toBe("segment_ingress_to_middle_missing");
  });

  test("中间跳的 role=both 不是前端自造的闸门：两段都在的节点就是可选", () => {
    // 角色是 egress、但两段绑定都已存在的节点（历史角色变更）也必须可选 —— 服务端只查绑定存在性。
    const legacy = node({ id: 9, node_id: "legacy-01", role: "egress", connect_ip: "10.0.0.91" });
    const ready = model({
      nodes: [INGRESS, MIDDLE, EGRESS, legacy],
      facts: {
        scopeKey: SCOPE,
        byIngress: {
          "1": [binding(1, 6, MIDDLE), binding(1, 9, legacy)],
          "6": [binding(6, 4, EGRESS)],
          "9": [binding(9, 4, EGRESS)],
        },
      },
    });
    expect(ready.candidates.map((row) => row.nodeId).sort()).toEqual(["6", "9"]);
  });

  test("同节点：与入口/出口相同的 id 各有独立原因", () => {
    const sameIngress = model({ middleNodeId: "1" });
    expect(sameIngress.selected?.reason).toBe("same_as_ingress");
    expect(sameIngress.submitBlockedReason).toBe("same_as_ingress");
    const sameEgress = model({ middleNodeId: "4" });
    expect(sameEgress.selected?.reason).toBe("same_as_egress");
  });

  test("缺段时按角色给出「能不能补建」（第一段当目标 / 第二段当源）", () => {
    // 缺第一段：该节点要当**目标** ⇒ 需 egress|both；它是 role=both ⇒ 能补。
    const roleBoth = model({
      nodes: [INGRESS, MIDDLE],
      facts: { scopeKey: SCOPE, byIngress: { "1": [], "6": [binding(6, 4, EGRESS)] } },
    });
    const both = roleBoth.excluded.find((item) => item.nodeId === "6")!;
    expect(both.reason).toBe("segment_ingress_to_middle_missing");
    expect(both.canCreateInbound).toBe(true);
    expect(multihopMissingSegment(both)).toEqual({ segment: "ingress_to_middle", creatable: true });

    // 缺第二段：该节点要当**源** ⇒ 需 ingress|both；它是 egress ⇒ 建不了，不能给"去绑定"。
    const legacy = node({ id: 9, node_id: "legacy-01", role: "egress", connect_ip: "10.0.0.91" });
    const missingOutbound = model({
      nodes: [INGRESS, MIDDLE, legacy],
      facts: { scopeKey: SCOPE, byIngress: { "1": [binding(1, 6, MIDDLE), binding(1, 9, legacy)], "9": [] } },
    });
    const outRow = missingOutbound.excluded.find((item) => item.nodeId === "9")!;
    expect(outRow.reason).toBe("segment_middle_to_egress_missing");
    expect(outRow.canCreateOutbound).toBe(false);
    expect(multihopMissingSegment(outRow)).toEqual({ segment: "middle_to_egress", creatable: false });

    // 缺第二段且角色允许（role=both）⇒ 能补。
    const missingOutboundBoth = model({
      nodes: [INGRESS, MIDDLE],
      facts: { scopeKey: SCOPE, byIngress: { "1": [binding(1, 6, MIDDLE)], "6": [] } },
    });
    const outBoth = missingOutboundBoth.excluded.find((item) => item.nodeId === "6")!;
    expect(multihopMissingSegment(outBoth)).toEqual({ segment: "middle_to_egress", creatable: true });
  });

  test("没有 node:manage ⇒ 缺段时两段都不可补建（不给一条自己点不了的路）", () => {
    const row = model({
      canManageNodes: false,
      nodes: [INGRESS, MIDDLE],
      facts: { scopeKey: SCOPE, byIngress: { "1": [], "6": [] } },
    }).excluded.find((item) => item.nodeId === "6")!;
    expect(row.reason).toBe("segment_ingress_to_middle_missing");
    expect(row.canCreateInbound).toBe(false);
    expect(row.canCreateOutbound).toBe(false);
    expect(multihopMissingSegment(row)).toEqual({ segment: "ingress_to_middle", creatable: false });

    // 反例：同样缺段但有 node:manage ⇒ 能补（证明这一位真的在起作用）。
    const withManage = model({ nodes: [INGRESS, MIDDLE], facts: { scopeKey: SCOPE, byIngress: { "1": [], "6": [] } } });
    expect(multihopMissingSegment(withManage.excluded.find((item) => item.nodeId === "6")!).creatable).toBe(true);
  });

  test("DIRECT：不适用（不渲染，也不产生候选）", () => {
    const direct = model({ mode: "direct" });
    expect(direct.applicable).toBe(false);
    expect(direct.phase).toBe("not_relay");
    expect(direct.candidates).toEqual([]);
  });

  test("relay 缺入口/缺出口：两个阶段都只有一句可执行的提示，不给候选结论", () => {
    expect(model({ ingressId: "" }).phase).toBe("need_ingress");
    expect(model({ egressId: "" }).phase).toBe("need_egress");
    expect(model({ egressId: "" }).candidates).toEqual([]);
    expect(model({ egressId: "" }).excluded).toEqual([]);
  });
});

describe("取不到 ≠ 没有", () => {
  test("facts=null ⇒ unavailable，且不产生任何「没有可用节点」式结论", () => {
    const row = model({ facts: null });
    expect(row.phase).toBe("unavailable");
    expect(row.candidates).toEqual([]);
    expect(row.excluded).toEqual([]);
  });

  test("作用域不符（切了 Workspace）⇒ 事实作废，判成取不到", () => {
    const row = model({ scopeKey: "ws:99" });
    expect(row.phase).toBe("unavailable");
    expect(row.submitBlockedReason).toBeNull(); // 还没选中间跳 ⇒ 只是"取不到"，不是"阻止提交"
    const chosen = model({ scopeKey: "ws:99", middleNodeId: "6" });
    expect(chosen.submitBlockedReason).toBe("facts_unavailable");
  });

  test("没登记到某个来源的绑定 ⇒ 那一段是「取不到」，不是「没有绑定」", () => {
    const row = model({ facts: { scopeKey: SCOPE, byIngress: { "6": [binding(6, 4, EGRESS)] } } });
    const candidate = row.excluded.find((item) => item.nodeId === "6")!;
    expect(candidate.inboundBound).toBeNull();
    expect(candidate.reason).toBe("facts_unavailable");
  });

  test("选中的 id 连节点都不认识 ⇒ unknown_node；认识但事实没登记 ⇒ facts_unavailable", () => {
    const unknown = model({ middleNodeId: "777" });
    expect(unknown.selected?.reason).toBe("unknown_node");
    expect(unknown.submitBlockedReason).toBe("unknown_node");

    // 一个**已知**节点（role=both）但它的出段事实没登记 ⇒ 取不到（不是"没绑定"、也不是"不认识"）。
    const known = model({
      middleNodeId: "6",
      nodes: [INGRESS, MIDDLE],
      facts: { scopeKey: SCOPE, byIngress: { "1": [binding(1, 6, MIDDLE)] } },
    });
    expect(known.selected?.reason).toBe("facts_unavailable");
    expect(known.submitBlockedReason).toBe("facts_unavailable");
  });
});

describe("载荷 fail-closed（唯一的生成点）", () => {
  test("两段都在 ⇒ 发 middle_node_id", () => {
    expect(multihopCreateFields("relay", "6", model({ middleNodeId: "6" }))).toEqual({ middle_node_id: 6 });
  });

  test("DIRECT 一律不发（后端对 DIRECT 既不校验也不使用它）", () => {
    expect(multihopCreateFields("direct", "6", model({ mode: "direct" }))).toEqual({});
  });

  test("没选 / 非法 id ⇒ 不发", () => {
    const ready = model();
    expect(multihopCreateFields("relay", "", ready)).toEqual({});
    expect(multihopCreateFields("relay", "abc", ready)).toEqual({});
    expect(multihopCreateFields("relay", "0", ready)).toEqual({});
  });

  test("选中项此刻不可提交 ⇒ 不发（由界面给出原因并禁用提交）", () => {
    expect(multihopCreateFields("relay", "5", model({ middleNodeId: "5" }))).toEqual({});
    expect(multihopCreateFields("relay", "6", model({ scopeKey: "ws:99", middleNodeId: "6" }))).toEqual({});
  });

  test("从原始事实直接生成（workspace 的载荷路径）与模型路径结果一致", () => {
    const raw = {
      mode: "relay" as const,
      ingressId: "1",
      egressId: "4",
      middleNodeId: "6",
      canManageNodes: true,
      workspaceId: 7,
      nodes: [INGRESS, MIDDLE, EGRESS],
      bindingsByIngress: FULL_FACTS.byIngress,
      bindingsUnavailable: false,
    };
    expect(multihopCreateFieldsFor(raw)).toEqual({ middle_node_id: 6 });
    expect(multihopCreateFieldsFor({ ...raw, bindingsUnavailable: true })).toEqual({});
    expect(multihopCreateFieldsFor({ ...raw, egressId: "5" })).toEqual({});
  });

  test("事实装配：bindingsUnavailable ⇒ byIngress 整份为 null（唯一装配点）", () => {
    expect(buildMultihopFacts({ workspaceId: 7, nodes: [], bindingsByIngress: {}, bindingsUnavailable: true })).toEqual({
      scopeKey: SCOPE,
      byIngress: null,
    });
    expect(buildMultihopFacts({ workspaceId: null, nodes: [], bindingsByIngress: {}, bindingsUnavailable: false })).toEqual({
      scopeKey: "ws:?",
      byIngress: {},
    });
  });
});

/* ================================================================== */
/* 409 / 失败码 → 人话 + 下一步                                          */
/* ================================================================== */

describe("创建失败的 409 分支逐条有人话与下一步", () => {
  test("binding_required（真实后端小写）⇒ 明说两段并给可执行下一步", () => {
    const info = multihopFailureInfo("zh", {
      status: 409,
      message: "三跳路由要求入口→中间、中间→出口两段都已绑定",
      data: { error: "三跳路由要求入口→中间、中间→出口两段都已绑定", code: "binding_required" },
    });
    expect(info.code).toBe("binding_required");
    expect(info.title).toContain("两段");
    expect(info.next).toContain("入口 → 中间");
    expect(info.next).toContain("中间 → 出口");
    expect(info.message).toContain("三跳路由要求");
    expect(info.retryable).toBe(false);
  });

  test("mock 既有的大写码也认（大小写不敏感），不因为码风格不同就丢掉下一步", () => {
    const info = multihopFailureInfo("zh", { status: 409, message: "两段", data: { code: "BINDING_REQUIRED" } });
    expect(info.code).toBe("binding_required");
    expect(info.next).not.toBeNull();
  });

  test("conflict：有 condition 时复用既有条件码词条（不自己写第二张表）", () => {
    const info = multihopFailureInfo("zh", {
      status: 409,
      message: "节点维护中，不接受新业务",
      data: { code: "conflict", condition: "node_in_maintenance" },
    });
    expect(info.title).toBe("节点维护中，不接受新业务");
    expect(info.next).not.toBeNull();
  });

  test("conflict：没有 condition ⇒ 角色/组合的说法，而不是空话", () => {
    const info = multihopFailureInfo("zh", { status: 409, message: "选择的节点不具备出口能力", data: { code: "conflict" } });
    expect(info.title).toContain("角色");
    expect(info.next).toContain("both");
  });

  test("其余已知码各有说法：port_conflict / not_found / invalid_input", () => {
    for (const code of ["port_conflict", "not_found", "invalid_input"]) {
      const info = multihopFailureInfo("zh", { status: 409, message: "后端原句", data: { code } });
      expect(info.title).not.toBe("后端原句");
      expect(info.next).not.toBeNull();
    }
  });

  test("未知码 ⇒ 原样回落后端原句，且**不编**下一步", () => {
    const info = multihopFailureInfo("zh", { status: 409, message: "某种新错误", data: { code: "brand_new_code" } });
    expect(info.title).toBe("某种新错误");
    expect(info.next).toBeNull();
    expect(info.retryable).toBe(false);
  });

  test("5xx / db_unavailable ⇒ 可重试（这是唯一给「再试一次」的分支）", () => {
    expect(multihopFailureInfo("zh", { status: 503, message: "创建端口转发失败", data: { code: "db_unavailable" } }).retryable).toBe(true);
    expect(multihopFailureInfo("zh", { status: 502, message: "Bad Gateway", data: null }).retryable).toBe(true);
  });

  test("en 文案存在且不含中文", () => {
    const info = multihopFailureInfo("en", { status: 409, message: "two segments", data: { code: "binding_required" } });
    expect(info.title).not.toMatch(/[\u4e00-\u9fff]/);
    expect(info.next).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

/* ================================================================== */
/* 展示层                                                              */
/* ================================================================== */

describe("选择器渲染：三态 + 不可选原因 + 禁词", () => {
  test("DIRECT 不渲染这个区块", () => {
    expect(section({ model: model({ mode: "direct" }) })).toBe("");
  });

  test("缺出口 ⇒ 说明为什么现在无法判定（第二段以中间跳为源）", () => {
    const html = section({ model: model({ egressId: "" }) });
    expect(html).toContain('data-testid="forward-multihop-need-egress"');
    expect(html).toContain("中间 → 出口");
  });

  test("事实取不到 ⇒ 独立 testid + 明说「不等于没有可用节点」", () => {
    const html = section({ model: model({ facts: null }) });
    expect(html).toContain('data-testid="forward-multihop-facts-unavailable"');
    expect(html).toContain("取不到绑定事实");
    expect(html).toContain("不等于「没有可用节点」");
    expect(html).not.toContain('data-testid="forward-multihop-none"');
    expect(html).not.toContain('data-testid="forward-multihop-select"');
  });

  test("ready：可选节点进下拉；不可选的**列出来并说明原因**", () => {
    const html = section();
    expect(html).toContain('data-testid="forward-multihop-select"');
    expect(html).toContain('data-testid="forward-multihop-option-6"');
    expect(html).toContain('data-testid="forward-multihop-excluded"');
    // 出口 4 在第一段绑定里 ⇒ 进清单，并说明"与出口是同一台"。
    expect(html).toContain('data-testid="forward-multihop-excluded-4"');
    expect(html).toContain("它与出口节点是同一台");

    const missing = section({
      model: model({ nodes: [INGRESS, MIDDLE], facts: { scopeKey: SCOPE, byIngress: { "1": [], "6": [binding(6, 4, EGRESS)] } } }),
    });
    expect(missing).toContain('data-testid="forward-multihop-excluded-6"');
    expect(missing).toContain("缺少「入口 → 该节点」这条绑定");
  });

  test("缺段且能补 ⇒ 给「去绑定」；缺段但不能补 ⇒ 只说角色原因，不给死路", () => {
    const bothMissingInbound = section({
      model: model({ nodes: [INGRESS, MIDDLE], facts: { scopeKey: SCOPE, byIngress: { "1": [], "6": [binding(6, 4, EGRESS)] } } }),
    });
    expect(bothMissingInbound).toContain("绑定并使用");
    expect(bothMissingInbound).not.toContain("角色不能作为第一段的出口");

    // 缺第二段且角色是 egress（不能当第二段的源）⇒ 只说角色原因，不给"去绑定"。
    const legacy = node({ id: 9, node_id: "legacy-01", role: "egress", connect_ip: "10.0.0.91" });
    const roleBlocked = section({
      model: model({
        nodes: [INGRESS, MIDDLE, legacy],
        facts: { scopeKey: SCOPE, byIngress: { "1": [binding(1, 9, legacy)], "9": [] } },
      }),
    });
    expect(roleBlocked).toContain("角色不能作为第二段的入口");
    expect(roleBlocked).not.toContain("第二段只能在节点页建");
  });

  test("第二段缺失 ⇒ 指向节点页（它只能在节点页以中间跳为源创建）", () => {
    const html = section({
      model: model({ nodes: [INGRESS, MIDDLE], facts: { scopeKey: SCOPE, byIngress: { "1": [binding(1, 6, MIDDLE)], "6": [] } } }),
    });
    expect(html).toContain("第二段只能在节点页建");
    expect(html).toContain('href="/nodes"');
  });

  test("选中可提交 ⇒ 明说这条路是四步三段；不可提交 ⇒ 独立告警 + 原因", () => {
    const ok = section({ model: model({ middleNodeId: "6" }), value: "6" });
    expect(ok).toContain('data-testid="forward-multihop-three-segments"');
    expect(ok).toContain("入口 → 中间 → 出口 → 目标");

    const blocked = section({ model: model({ middleNodeId: "5" }), value: "5" });
    expect(blocked).toContain('data-testid="forward-multihop-blocked"');
    expect(blocked).not.toContain('data-testid="forward-multihop-three-segments"');
  });

  test("不假装列表/详情能看到中间跳", () => {
    const html = section();
    expect(html).toContain('data-testid="forward-multihop-visibility"');
    expect(html).toContain("链路");
    expect(html).toContain("列表与详情读数不显示中间跳");
  });

  test("全部状态里都不出现「正常 / 健康 / 可达」", () => {
    const branches = [
      section(),
      section({ model: model({ facts: null }) }),
      section({ model: model({ mode: "direct" }) }),
      section({ model: model({ egressId: "" }) }),
      section({ model: model({ middleNodeId: "6" }), value: "6" }),
      section({ model: model({ middleNodeId: "5" }), value: "5" }),
      section({ locale: "en" }),
    ];
    for (const html of branches) {
      for (const word of ["正常", "健康", "可达", "连通"]) expect(html).not.toContain(word);
    }
  });

  test("en 文案无中文，且三态都有话可说", () => {
    const html = section({ locale: "en" });
    expect(html).not.toMatch(/[\u4e00-\u9fff]/);
    expect(html).toContain("Middle hop");
    expect(html).not.toContain("healthy");
  });
});

/* ================================================================== */
/* 三跳的线路预览：四步三段                                             */
/* ================================================================== */

describe("线路预览：三跳 = 四步三段（两段输出保持不变）", () => {
  const middleFacts = { nodeId: "6", node: MIDDLE, inboundBound: true, outboundBound: true };

  function preview(over: Partial<Parameters<typeof buildForwardPathPreview>[0]> = {}) {
    return buildForwardPathPreview({
      draft: { mode: "relay", ingressId: "1", egressId: "4", targetHost: "example.com", targetPort: "443" },
      ingress: INGRESS,
      egress: EGRESS,
      scopeKey: PATH_SCOPE,
      bindingsFacts: {
        scopeKey: PATH_SCOPE,
        bindings: [binding(1, 6, MIDDLE), binding(1, 4, EGRESS)],
      },
      bindableEgressCount: 0,
      ...over,
    });
  }

  test("没有中间跳时输出与历史完全一致（两段 / 1 跳 / relay_two）", () => {
    const row = preview();
    expect(row.pathKind).toBe("relay_two");
    expect(row.segmentCount).toBe(2);
    expect(row.interNodeHops).toBe(1);
    expect(row.steps.map((step) => step.role)).toEqual(["ingress", "egress", "target"]);
    expect(row.gaps).toEqual([]);
  });

  test("选了中间跳 ⇒ 四步三段两跳，中间那步有名有址", () => {
    const row = preview({ middle: middleFacts });
    expect(row.pathKind).toBe("relay_three");
    expect(row.segmentCount).toBe(3);
    expect(row.interNodeHops).toBe(2);
    expect(row.steps.map((step) => step.role)).toEqual(["ingress", "middle", "egress", "target"]);
    expect(row.steps[1]!.label).toBe("sg-out-01");
    expect(row.steps[1]!.address).toBe("10.0.0.61");
    expect(row.segmentReason).toBe("relay_three_segments");
    expect(row.gaps).toEqual([]);
  });

  test("中间跳地址未上报 / 缺某一段 ⇒ 独立缺口码（不是空白、不是「没绑定」）", () => {
    const noAddress = preview({ middle: { ...middleFacts, node: node({ id: 6, node_id: "sg-out-01", role: "both", connect_ip: null }) } });
    expect(noAddress.steps[1]!.address).toBeNull();
    expect(noAddress.gaps).toContain("middle_address_unreported");

    const missingInbound = preview({ middle: { ...middleFacts, inboundBound: false } });
    expect(missingInbound.gaps).toContain("middle_segment_ingress_missing");
    const missingOutbound = preview({ middle: { ...middleFacts, outboundBound: false } });
    expect(missingOutbound.gaps).toContain("middle_segment_egress_missing");
  });

  test("两段事实取不到 ⇒ 说「取不到」，不说缺哪一段", () => {
    const row = preview({ middle: { nodeId: "6", node: MIDDLE, inboundBound: null, outboundBound: null } });
    expect(row.gaps).toContain("middle_segments_unavailable");
    expect(row.gaps).not.toContain("middle_segment_ingress_missing");
    expect(row.gaps).not.toContain("middle_segment_egress_missing");
  });

  test("渲染：标题、段数行、中间步骤与「哪里能看到它」都在", () => {
    const html = render(<ForwardPathPreview model={preview({ middle: middleFacts })} locale="zh" />);
    expect(html).toContain('data-path-kind="relay_three"');
    expect(html).toContain("入口 → 中间 → 出口 → 目标");
    expect(html).toContain('data-testid="forward-path-step-middle"');
    expect(html).toContain("sg-out-01");
    expect(html).toContain("段数 3 · 节点间跳 2");
    expect(html).toContain('data-testid="forward-path-middle-visibility"');
    expect(html).toContain("列表与详情读数不显示它");
    expect(html).toContain("未做连通性验证");
    for (const word of ["正常", "健康", "可达"]) expect(html).not.toContain(word);
  });

  test("渲染：两段时**没有**中间步骤，段数行保持 2/1（任务 9 的呈现不变）", () => {
    const html = render(<ForwardPathPreview model={preview()} locale="zh" />);
    expect(html).toContain('data-path-kind="relay_two"');
    expect(html).not.toContain('data-testid="forward-path-step-middle"');
    expect(html).toContain("段数 2 · 节点间跳 1");
    expect(html).not.toContain('data-testid="forward-path-middle-visibility"');
  });

  test("预览文案的键集完整（缺码会渲染出 undefined）", () => {
    const copy = forwardPathCopy("zh");
    for (const gap of [
      "middle_address_unreported",
      "middle_segment_ingress_missing",
      "middle_segment_egress_missing",
      "middle_segments_unavailable",
    ] as const) {
      expect(typeof copy.gaps[gap]).toBe("string");
      expect(copy.gaps[gap].length).toBeGreaterThan(0);
    }
    expect(forwardMultihopCopy("zh").threeSegments).toContain("三段");
  });
});

/* ================================================================== */
/* mock：与真后端同判据（两段绑定）                                      */
/* ================================================================== */

describe("mock：POST /forwards 接住 middle_node_id（不再忽略）", () => {
  const OWNER = "tunex_session=u1";
  // `.tsx` 里泛型箭头函数会被解析成 JSX，所以这里用函数声明。
  async function call<T>(method: string, path: string, options: { body?: unknown } = {}) {
    const res = await handleMock(method, path, {
      cookie: OWNER,
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    return res as { status: number; body: T };
  }

  beforeEach(() => {
    resetStore();
  });

  test("种子里 1→6 与 6→4 两段都在 ⇒ 三跳创建成功，且 topology 给两段（不再谎报两跳）", async () => {
    const created = await call<{ id: number; mode: string }>("POST", "forwards", {
      body: {
        mode: "relay",
        name: "三跳演示",
        ingress_node_id: 1,
        egress_node_id: 4,
        middle_node_id: 6,
        target_host: "example.com",
        target_port: 443,
      },
    });
    expect(created.status).toBe(200);
    const id = created.body.id;

    // forwardView 与真后端一样**不含** middle_node：列表/详情读数看不到它。
    const detail = await call<Record<string, unknown>>("GET", `forwards/${id}`);
    expect(detail.body.middle_node_id).toBeUndefined();
    expect(detail.body.middle_node).toBeUndefined();

    const topology = await call<{ segments: { segment: string }[]; stale_segments: number }>("GET", `forwards/${id}/topology`);
    expect(topology.body.segments.map((row) => row.segment)).toEqual(["ingress_to_middle", "middle_to_egress"]);
  });

  test("缺一段 ⇒ 409 BINDING_REQUIRED（与后端同判据），且**没有**建出转发", async () => {
    const before = getStore().tunnels.length;
    const res = await call<{ code: string; message: string }>("POST", "forwards", {
      body: {
        mode: "relay",
        name: "缺段",
        ingress_node_id: 1,
        egress_node_id: 4,
        middle_node_id: 5,
        target_host: "example.com",
        target_port: 443,
      },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("BINDING_REQUIRED");
    expect(res.body.message).toContain("入口→中间");
    expect(getStore().tunnels.length).toBe(before);
  });

  test("不带 middle_node_id 的 relay 仍是两段（老路径零回归）", async () => {
    const created = await call<{ id: number }>("POST", "forwards", {
      body: { mode: "relay", name: "两段", ingress_node_id: 1, egress_node_id: 4, target_host: "example.com", target_port: 443 },
    });
    expect(created.status).toBe(200);
    const topology = await call<{ segments: { segment: string }[] }>("GET", `forwards/${created.body.id}/topology`);
    expect(topology.body.segments.map((row) => row.segment)).toEqual(["ingress_to_egress"]);
  });

  test("DIRECT 带上 middle_node_id：mock 与真后端同样不校验（已知缺口，UI 结构上不发送）", async () => {
    // 真后端 create 只在 `if (egress)` 里校验两段（forward-service.ts:761）⇒ DIRECT 不校验。
    // 这条断言的作用是**把这个缺口钉在明处**，避免日后有人以为 mock 漏了校验。
    const res = await call<{ id: number }>("POST", "forwards", {
      body: { mode: "direct", name: "direct+middle", ingress_node_id: 1, middle_node_id: 6, target_host: "example.com", target_port: 443 },
    });
    expect(res.status).toBe(200);
    const topology = await call<{ segments: unknown[] }>("GET", `forwards/${res.body.id}/topology`);
    expect(topology.body.segments).toEqual([]); // DIRECT：段数 0 是设计结论
  });
});
