/**
 * R4-B1 —— 创建对话框的「线路预览」展示层。
 *
 * 与 `forward-path-model.test.ts` 的分工：那边测**事实**（段数/缺口/三态），这边测
 * **用户看到的话**：
 *   · DIRECT 画成「入口 → 目标（直连）」，并明说没有节点间跳是**设计结论**（不是空态/错误）；
 *   · RELAY 画成「入口 → 出口 → 目标」，节点名 + 连接地址；地址缺失写「未上报连接地址」
 *     而不是空白；
 *   · **预览是计划不是连通性**：全文不得出现「正常 / 健康 / 可达 / 连通」，且必须显式写
 *     「未做连通性验证」；
 *   · 绑定**取不到**与**确实没有**是两个独立 testid、两段不同文案，前者不得被说成
 *     「没有可用出口」；
 *   · 组件无状态：换一个 model 渲染，前一个 model 的节点名/目标不会残留（切 Workspace 的
 *     预览重置在展示层是**结构性保证**，不是靠 useEffect 记得清）。
 *
 * 跑法（web 目录）：bun test src/components/forwards/__tests__/forward-path-preview.test.tsx
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ForwardPathPreview } from "@/components/forwards/forward-path-preview";
import {
  buildForwardPathPreview,
  forwardPathScopeKey,
  type ForwardPathPreviewModel,
} from "@/components/forwards/forward-path-model";
import { ForwardCreateDialog } from "@/components/forwards/forward-create-dialog";
import { emptyForwardCreateDraft } from "@/components/forwards/forward-create-model";
import type { Locale } from "@/lib/i18n";
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

function model(over: {
  mode?: "direct" | "relay";
  draft?: Partial<ReturnType<typeof emptyForwardCreateDraft>>;
  ingress?: UserNode | null;
  egress?: UserNode | null;
  facts?: { scopeKey: string; bindings: readonly NodeBinding[] | null } | null;
  candidates?: number;
} = {}): ForwardPathPreviewModel {
  const mode = over.mode ?? "direct";
  return buildForwardPathPreview({
    draft: {
      ...emptyForwardCreateDraft(mode, node()),
      name: "web-hk",
      targetHost: "example.com",
      targetPort: "443",
      ...over.draft,
      mode,
    },
    ingress: over.ingress === undefined ? node() : over.ingress,
    egress: over.egress ?? null,
    scopeKey: SCOPE,
    bindingsFacts: over.facts === undefined ? { scopeKey: SCOPE, bindings: [] } : over.facts,
    bindableEgressCount: over.candidates ?? 0,
  });
}

const render = (m: ForwardPathPreviewModel, locale: Locale = "zh") =>
  renderToStaticMarkup(<ForwardPathPreview model={m} locale={locale} />);

const visibleText = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * 计划 ≠ 连通性：这四个词一出现，用户就会当成"已经验证过了"。
 *
 * 例外只有一个：规范要求的否定句「未做连通性验证」本身含"连通性"，所以先把它挖掉。
 * 挖掉之后剩下的文本里若还有这些词，就是真的在给结论了。
 */
function expectNoConnectivityClaims(text: string): void {
  const withoutRequiredNotice = text.replace(/未做连通性验证/g, "");
  for (const forbidden of ["正常", "健康", "可达", "连通"]) {
    expect(withoutRequiredNotice).not.toContain(forbidden);
  }
}

describe("DIRECT：入口 → 目标（直连）", () => {
  test("标题与设计结论都在，且不给空态/错误", () => {
    const html = render(model({ mode: "direct" }));
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-path-preview"');
    expect(text).toContain("入口 → 目标（直连）");
    expect(text).toContain("没有节点之间的跳");
    expect(text).toContain("设计结论");
    expect(text).toContain("不是缺数据");
    expect(html).toContain('data-testid="forward-path-step-ingress"');
    expect(html).toContain('data-testid="forward-path-step-target"');
    // 不得退化成空态 / 错误态。
    expect(html).not.toContain('data-testid="forward-path-step-egress"');
    expect(text).not.toContain("暂无");
    expect(text).not.toContain("取不到");
    // 段数结论照实写出（1 段 / 0 跳）。
    expect(text).toContain("段数 1");
    expect(text).toContain("节点间跳 0");
  });

  test("计划 ≠ 连通性：显式写「未做连通性验证」", () => {
    const html = render(model({ mode: "direct" }));
    expect(html).toContain('data-testid="forward-path-no-check"');
    expect(visibleText(html)).toContain("未做连通性验证");
    expectNoConnectivityClaims(visibleText(html));
  });
});

describe("RELAY：入口 → 出口 → 目标", () => {
  test("三步都有节点名 + 连接地址", () => {
    const html = render(
      model({
        mode: "relay",
        draft: { egressId: "2" },
        egress: node({ id: 2, node_id: "jp-out-01", connect_ip: "10.0.0.21", role: "egress" }),
        facts: { scopeKey: SCOPE, bindings: [binding()] },
      }),
    );
    const text = visibleText(html);
    expect(text).toContain("入口 → 出口 → 目标");
    expect(text).toContain("hk-in-01");
    expect(text).toContain("10.0.0.11");
    expect(text).toContain("jp-out-01");
    expect(text).toContain("10.0.0.21");
    expect(text).toContain("example.com:443");
    expect(text).toContain("段数 2");
    expect(text).toContain("节点间跳 1");
    expectNoConnectivityClaims(text);
  });

  test("连接地址未上报 ⇒ 写「未上报连接地址」，不是空白", () => {
    const html = render(
      model({
        mode: "relay",
        draft: { egressId: "2" },
        ingress: node({ connect_ip: null }),
        egress: node({ id: 2, node_id: "jp-out-01", connect_ip: null, role: "egress" }),
        facts: { scopeKey: SCOPE, bindings: [binding()] },
      }),
    );
    const text = visibleText(html);
    // 两次出现：入口一步、出口一步。
    expect(html.split("未上报连接地址").length - 1).toBe(2);
    expect(text).toContain("入口");
    expectNoConnectivityClaims(text);
  });

  test("还没选出口 ⇒ 出口那一步写「未选择出口」（而不是空白或地址文案）", () => {
    const html = render(model({ mode: "relay", draft: { egressId: "" } }));
    const text = visibleText(html);
    expect(text).toContain("未选择出口");
    expect(text).toContain("还没有选择出口节点");
    expectNoConnectivityClaims(text);
  });

  test("缺口清单把「还差什么」逐条写出来（含下一步）", () => {
    const html = render(
      model({ mode: "relay", draft: { egressId: "", targetHost: "", targetPort: "" } }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-path-gaps"');
    expect(text).toContain("还差这些");
    expect(text).toContain("还没有填目标地址");
    expect(text).toContain("还没有选择出口节点");
  });
});

describe("出口关系三态：取不到 ≠ 没有可用出口", () => {
  const noneModel = () => model({ mode: "relay", draft: { egressId: "" }, candidates: 3 });
  const unavailableModel = () => model({ mode: "relay", draft: { egressId: "" }, facts: null });

  test("确实没有可用出口 ⇒ 独立 testid + 下一步（含候选数量）", () => {
    const html = render(noneModel());
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-path-bindings-none"');
    expect(text).toContain("还没有可用出口");
    expect(text).toContain("3 台候选出口");
    expect(html).not.toContain('data-testid="forward-path-bindings-unavailable"');
  });

  test("取不到 ⇒ 另一个独立 testid，文案含「取不到」且明说「这不等于没有可用出口」", () => {
    const html = render(unavailableModel());
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-path-bindings-unavailable"');
    expect(text).toContain("取不到");
    expect(text).toContain("这不等于");
    /**
     * 关键纪律：不许把读取失败**断言**成"没有可用出口"。
     *
     * 注意文案里刻意保留了否定句「这不等于「没有可用出口」」——所以这里先把这句
     * 规范要求的否定挖掉，再断言剩下的文本里没有这个结论。
     */
    const withoutNegation = text.replace(/这不等于「没有可用出口」/g, "").replace(/这不等于/g, "");
    expect(withoutNegation).not.toContain("没有可用出口");
    // 也不许退化成"确实没有可用出口"那句话（那是另一态）。
    expect(text).not.toContain("还没有可用出口");
    expect(html).not.toContain('data-testid="forward-path-bindings-none"');
  });

  test("取不到的文案与「确实没有」的文案不同（同一段话会掩盖真相）", () => {
    const unavailableText = visibleText(render(unavailableModel()));
    const noneText = visibleText(render(noneModel()));
    expect(unavailableText).not.toBe(noneText);
  });

  test("有可用出口 ⇒ 第三态，也不出现「取不到」", () => {
    const html = render(
      model({
        mode: "relay",
        draft: { egressId: "2" },
        egress: node({ id: 2, node_id: "jp-out-01", role: "egress" }),
        facts: { scopeKey: SCOPE, bindings: [binding()] },
      }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-path-bindings-bound"');
    expect(text).toContain("已有 1 台可用出口");
    expect(text).not.toContain("取不到");
  });

  test("晚到的旧作用域事实被丢弃 ⇒ 渲染成「取不到」，不渲染成「有绑定」", () => {
    const html = render(
      model({
        mode: "relay",
        draft: { egressId: "2" },
        egress: node({ id: 2, node_id: "jp-out-01", role: "egress" }),
        facts: {
          scopeKey: forwardPathScopeKey({ workspaceId: 99, ingressId: "1" }),
          bindings: [binding()],
        },
      }),
    );
    const text = visibleText(html);
    expect(html).toContain('data-testid="forward-path-bindings-unavailable"');
    expect(html).not.toContain('data-testid="forward-path-bindings-bound"');
    // “已有可用出口”只属于 bound 态；旧作用域事实不能把它渲染出来。
    expect(text).not.toContain("可以直接选择");
  });
});

describe("展示层无状态：切作用域即换内容，不会残留", () => {
  test("换一个 model 渲染，前一条线的节点名与目标都不出现", () => {
    const first = render(
      model({
        mode: "relay",
        draft: { egressId: "2" },
        egress: node({ id: 2, node_id: "jp-out-01", connect_ip: "10.0.0.21", role: "egress" }),
        facts: { scopeKey: SCOPE, bindings: [binding()] },
      }),
    );
    expect(visibleText(first)).toContain("jp-out-01");

    // 另一个工作空间的模型：完全不同的入口/出口/目标。
    const second = render(
      buildForwardPathPreview({
        draft: {
          ...emptyForwardCreateDraft("direct", node({ id: 7, node_id: "sg-in-01" })),
          name: "other",
          targetHost: "other.internal",
          targetPort: "8443",
          ingressId: "7",
        },
        ingress: node({ id: 7, node_id: "sg-in-01", connect_ip: "10.9.9.9" }),
        egress: null,
        scopeKey: forwardPathScopeKey({ workspaceId: 2, ingressId: "7" }),
        bindingsFacts: null,
      }),
    );
    const secondText = visibleText(second);
    for (const stale of ["jp-out-01", "10.0.0.21", "example.com", "hk-in-01"]) {
      expect(secondText).not.toContain(stale);
    }
    expect(secondText).toContain("sg-in-01");
  });
});

describe("对话框集成冒烟（挂载路径不炸 + 模型算得出来）", () => {
  /**
   * 为什么只能"不抛错"：`DialogContent` 走 Radix 的 Portal，SSR 下**不渲染内容**
   * （`renderToStaticMarkup` 出来是空串），所以这里断言不了 DOM 结构。
   * 但组件体照样执行 —— 模型计算（`buildForwardPathPreview`）与 `forwardPathCopy(locale)`
   * 都会真的跑一遍，因此这条用例能钉住"挂载路径不炸、四种状态下都能算出模型"。
   * 内容本身由上面那些用例覆盖。
   */
  const renderDialog = (over: { mode: "direct" | "relay"; bindingsUnavailable?: boolean; bindings?: NodeBinding[] }) =>
    renderToStaticMarkup(
      <ForwardCreateDialog
        open
        draft={{
          ...emptyForwardCreateDraft(over.mode, node()),
          name: "web-hk",
          targetHost: "example.com",
          targetPort: "443",
          egressId: over.mode === "relay" ? "2" : "",
        }}
        ingressNodes={[node(), node({ id: 2, node_id: "jp-out-01", connect_ip: "10.0.0.21", role: "egress" })]}
        selectedBindings={over.bindings ?? []}
        egressNodes={[node({ id: 2, node_id: "jp-out-01", connect_ip: "10.0.0.21", role: "egress" })]}
        canManageNodes
        busy={false}
        locale="zh"
        t={(key) => String(key)}
        text={(key) => String(key)}
        onOpenChange={() => {}}
        onDraftChange={() => {}}
        onCreate={() => {}}
        bindingsUnavailable={over.bindingsUnavailable ?? false}
      />,
    );

  test("direct / relay / 绑定取不到 三种输入都能渲染而不抛错", () => {
    expect(() => renderDialog({ mode: "direct" })).not.toThrow();
    expect(() => renderDialog({ mode: "relay", bindings: [binding()] })).not.toThrow();
    expect(() => renderDialog({ mode: "relay", bindingsUnavailable: true })).not.toThrow();
  });
});

describe("en 文案", () => {
  test("本模块文案不含中文；同样不出现 healthy / reachable / connected", () => {
    const models = [
      model({ mode: "direct" }),
      model({ mode: "relay", draft: { egressId: "2" }, egress: node({ id: 2, node_id: "jp-out-01", role: "egress" }), facts: { scopeKey: SCOPE, bindings: [binding()] } }),
      model({ mode: "relay", draft: { egressId: "" } }),
      model({ mode: "relay", facts: null }),
    ];
    for (const m of models) {
      const text = visibleText(render(m, "en"));
      expect(text).not.toMatch(/[\u4e00-\u9fff]/);
      for (const forbidden of ["healthy", "reachable", "connected"]) {
        expect(text.toLowerCase()).not.toContain(forbidden);
      }
      expect(text).toContain("no connectivity check");
    }
  });
});
