"use client";

/**
 * Forward 创建对话框 · 线路预览与前置说明（自包含展示层）。
 *
 * ── 它只做一件事 ──
 *
 * 把 {@link ForwardPathPreviewModel}（纯函数产物）画成"我拼出来的这条线"：
 *   · DIRECT —— 「入口 → 目标（直连）」，并**明说没有节点间跳是设计结论**（不是缺数据、不是空态）；
 *   · RELAY  —— 「入口 → 出口 → 目标」，每一步给出节点名 + 连接地址；地址未上报时写
 *     「未上报连接地址」，**不留空白**（空白会被读成"界面坏了"）。
 *
 * ── 三条不能违反的话术纪律（都有行为测试）──
 *
 *  1. **这是计划，不是连通性结论**：组件是纯展示、没有任何探测能力，所以全文必须显式写
 *     「未做连通性验证」，并且**不得**出现「正常 / 健康 / 可达 / 连通」这类词 ——
 *     用户会拿这类词当作"已经验证过了"；
 *  2. **绑定事实取不到 ≠ 没有可用出口**：`unavailable` 有独立 testid 且文案含"取不到"，
 *     并明确写"这不等于没有可用出口"；只有 `none`（事实明确）才给"去绑定一台出口"的说法；
 *  3. **不注入任何后端事实**：节点名/地址/绑定全部来自 props；缺就是缺（降级或"未上报"），
 *     不猜、不补默认值。
 *
 * 文案走组件内 zh/en 表（`locale` 由 props 传入），**不写** `lib/i18n/dictionaries.ts`。
 */

import type {
  ForwardPathGapCode,
  ForwardPathPreviewModel,
  ForwardPathStep,
  PathBindingsStatus,
} from "@/components/forwards/forward-path-model";
import type { Locale } from "@/lib/i18n";

export interface ForwardPathCopy {
  title: string;
  planNote: string;
  noConnectivityCheck: string;
  directHeadline: string;
  directDesignNote: string;
  relayHeadline: string;
  relayNote: string;
  /** 三跳（选了中间跳）的标题与说明。 */
  relayThreeHeadline: string;
  relayThreeNote: string;
  ingressRole: string;
  middleRole: string;
  egressRole: string;
  targetRole: string;
  unreportedAddress: string;
  egressNotChosen: string;
  arrow: string;
  gapTitle: string;
  gaps: Record<ForwardPathGapCode, string>;
  /** 中间跳只在链路（topology）里可见 —— 明说列表/详情读数不含它。 */
  middleVisibilityNote: string;
  bindingsBound: (count: number) => string;
  bindingsNone: string;
  bindingsNoneNext: string;
  bindingsNoneWithCandidates: (count: number) => string;
  bindingsUnavailable: string;
  bindingsUnavailableNext: string;
}

const ZH: ForwardPathCopy = {
  title: "路径预览",
  planNote: "下面是这条转发将使用的路径；事实来自你选择的节点与当前已载入的节点关系。",
  noConnectivityCheck: "本预览未做连通性验证：它描述的是计划，不是这条线路此刻通不通。",
  directHeadline: "入口 → 目标（直连）",
  directDesignNote:
    "DIRECT 没有节点之间的跳：这是这条路径的设计结论，不是缺数据，也不代表少了什么配置。",
  relayHeadline: "入口 → 出口 → 目标",
  relayNote:
    "自定义路径由入口节点接收连接，再经出口节点访问目标；所选出口必须已为这台入口启用。",
  relayThreeHeadline: "入口 → 中间 → 出口 → 目标",
  relayThreeNote:
    "你选了中间节点：路径由入口 → 中间 → 出口 → 目标组成。创建时 TuneX 会校验相邻节点关系是否已经准备好。",
  ingressRole: "入口",
  middleRole: "中间",
  egressRole: "出口",
  targetRole: "目标",
  unreportedAddress: "未上报连接地址",
  egressNotChosen: "未选择出口",
  arrow: "→",
  gapTitle: "还差这些：",
  gaps: {
    ingress_address_unreported: "入口节点还没有上报连接地址（它上线后会带上）。",
    egress_address_unreported: "出口节点还没有上报连接地址（它上线后会带上）。",
    egress_not_chosen: "还没有选择出口节点（RELAY 必需）。",
    egress_not_bound: "所选出口尚未为这台入口启用；下面的「启用并使用」可以补齐。",
    target_host_missing: "还没有填目标地址。",
    target_port_missing: "还没有填目标端口。",
    bindings_unavailable:
      "出口关系暂时取不到：无法判断这台入口目前可用哪些出口。这不等于「没有可用出口」，请刷新后重试。",
    middle_address_unreported: "中间跳节点还没有上报连接地址（它上线后会带上）。",
    middle_segment_ingress_missing: "入口 → 中间 的节点关系尚未准备好，当前无法创建这条路径。",
    middle_segment_egress_missing: "中间 → 出口 的节点关系尚未准备好，当前无法创建这条路径。",
    middle_segments_unavailable:
      "中间节点的两段关系暂时取不到：无法判断缺哪一段，请刷新后重试。",
  },
  middleVisibilityNote:
    "中间跳只会出现在该转发详情页的「链路」卡片（三段）里：列表与详情读数不显示它。",
  bindingsBound: (count) => `已有 ${count} 台可用出口，可以直接选择。`,
  bindingsNone: "这台入口还没有可用出口。",
  bindingsNoneNext: "下一步：在下面选择一台出口并点「启用并使用」。",
  bindingsNoneWithCandidates: (count) =>
    `下一步：在下面从 ${count} 台候选出口里选一台，点「启用并使用」。`,
  bindingsUnavailable:
    "出口关系暂时取不到：可能仍在读取，也可能读取失败。这不等于「没有可用出口」。",
  bindingsUnavailableNext: "下一步：刷新页面（或稍候）再看一次；若仍取不到，请检查节点接口与权限。",
};

const EN: ForwardPathCopy = {
  title: "Path preview",
  planNote:
    "Below is the path this forward will use; the facts come from your selected nodes and the currently loaded node relationships.",
  noConnectivityCheck:
    "This preview performs no connectivity check: it describes the plan, not whether the path currently works.",
  directHeadline: "Ingress → target (direct)",
  directDesignNote:
    "A DIRECT forward has no hop between nodes: that is the design conclusion for this path, not missing data and not a missing setting.",
  relayHeadline: "Ingress → egress → target",
  relayNote:
    "A custom path accepts the connection on the ingress node and forwards it to the target from the egress node; that egress must be enabled for this ingress.",
  relayThreeHeadline: "Ingress → middle → egress → target",
  relayThreeNote:
    "You chose a middle node: the path is ingress → middle → egress → target. TuneX validates that the adjacent node relationships are ready when creating it.",
  ingressRole: "Ingress",
  middleRole: "Middle",
  egressRole: "Egress",
  targetRole: "Target",
  unreportedAddress: "connection address not reported yet",
  egressNotChosen: "no egress chosen",
  arrow: "→",
  gapTitle: "Still missing:",
  gaps: {
    ingress_address_unreported: "The ingress node has not reported a connection address yet (it will once it comes up).",
    egress_address_unreported: "The egress node has not reported a connection address yet (it will once it comes up).",
    egress_not_chosen: "No egress node chosen yet (required for RELAY).",
    egress_not_bound: "The chosen egress is not enabled for this ingress yet; use \"enable and use\" below.",
    target_host_missing: "Target host is still empty.",
    target_port_missing: "Target port is still empty.",
    bindings_unavailable:
      "Egress relationship facts are unavailable: cannot tell which egress nodes are available to this ingress. That is not the same as \"no egress available\"; reload and try again.",
    middle_address_unreported: "The middle-hop node has not reported a connection address yet (it will once it comes up).",
    middle_segment_ingress_missing: "The ingress → middle node relationship is not ready, so this path cannot be created yet.",
    middle_segment_egress_missing: "The middle → egress node relationship is not ready, so this path cannot be created yet.",
    middle_segments_unavailable:
      "The middle node's two relationship facts are unavailable, so TuneX cannot tell which segment is missing. Reload and try again.",
  },
  middleVisibilityNote:
    "The middle hop only shows up on the forward detail page's \"path\" card (three segments): list and detail reads do not include it.",
  bindingsBound: (count) => `${count} egress node(s) are available and selectable.`,
  bindingsNone: "This ingress has no available egress yet.",
  bindingsNoneNext: "Next: pick an egress below and click \"enable and use\".",
  bindingsNoneWithCandidates: (count) =>
    `Next: pick one of the ${count} candidate egress nodes below and click "enable and use".`,
  bindingsUnavailable:
    "Egress relationship facts are unavailable: the read may still be running, or it may have failed. That is not the same as \"no egress available\".",
  bindingsUnavailableNext:
    "Next: reload the page (or wait a moment). If it stays unavailable, check the nodes API and your permissions.",
};

const COPY: Record<Locale, ForwardPathCopy> = { zh: ZH, en: EN };

export function forwardPathCopy(locale: Locale): ForwardPathCopy {
  return COPY[locale];
}

const ROLE_KEY: Record<ForwardPathStep["role"], keyof ForwardPathCopy> = {
  ingress: "ingressRole",
  middle: "middleRole",
  egress: "egressRole",
  target: "targetRole",
};

/** 一步（节点或目标）：名字 + 地址；地址缺失时写确定的话，绝不留空白。 */
function StepChip({ step, copy }: { step: ForwardPathStep; copy: ForwardPathCopy }) {
  const role = copy[ROLE_KEY[step.role]] as string;
  const label = step.label.trim() === "" ? "—" : step.label;
  /**
   * 地址行三种情况各有确定文案：
   *   · 有地址 → 地址；
   *   · 还没选出口 → 「未选择出口」（说"未上报连接地址"是废话：根本没有节点可上报）；
   *   · 选了但没上报 → 「未上报连接地址」（**不是**空白：空白会被读成界面坏了）。
   */
  const addressText =
    step.address ??
    (step.gap === "egress_not_chosen" ? copy.egressNotChosen : copy.unreportedAddress);
  return (
    <span
      data-testid={`forward-path-step-${step.role}`}
      className="inline-flex flex-col rounded-md border border-[var(--border)] px-2 py-1 text-xs"
    >
      <span className="text-[var(--muted-foreground)]">{role}</span>
      <span className="font-medium">{label}</span>
      <span
        data-testid={`forward-path-address-${step.role}`}
        className={step.address === null ? "text-[var(--muted-foreground)]" : "font-mono"}
      >
        {addressText}
      </span>
    </span>
  );
}

function BindingsNote({
  model,
  copy,
}: {
  model: ForwardPathPreviewModel;
  copy: ForwardPathCopy;
}) {
  const status: PathBindingsStatus = model.bindingsStatus;
  if (status === "bound") {
    return (
      <p data-testid="forward-path-bindings-bound" className="text-xs">
        {copy.bindingsBound(model.boundEgressCount ?? 0)}
      </p>
    );
  }
  if (status === "none") {
    return (
      <div data-testid="forward-path-bindings-none" className="text-xs">
        <p>{copy.bindingsNone}</p>
        <p className="mt-0.5">
          {model.bindableEgressCount !== null && model.bindableEgressCount > 0
            ? copy.bindingsNoneWithCandidates(model.bindableEgressCount)
            : copy.bindingsNoneNext}
        </p>
      </div>
    );
  }
  return (
    <div data-testid="forward-path-bindings-unavailable" className="text-xs">
      <p>{copy.bindingsUnavailable}</p>
      <p className="mt-0.5">{copy.bindingsUnavailableNext}</p>
    </div>
  );
}

/**
 * 线路预览（纯展示：同一个 model 一定渲染出同样的 HTML，自己没有任何状态）。
 *
 * 没有内部状态是**刻意的**：预览里不可能残留上一个 Workspace 的内容 —— 切空间时
 * 作用域键一变，模型就把旧作用域的绑定事实判成"取不到"（见 `forward-path-model.ts`）。
 */
export function ForwardPathPreview({
  model,
  locale,
}: {
  model: ForwardPathPreviewModel;
  locale: Locale;
}) {
  const copy = forwardPathCopy(locale);
  return (
    <section
      data-testid="forward-path-preview"
      data-mode={model.mode}
      data-path-kind={model.pathKind}
      className="rounded-md border border-[var(--border)] p-3"
    >
      <header>
        <div className="text-xs font-medium">{copy.title}</div>
        <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{copy.planNote}</p>
      </header>

      <p className="mt-2 text-sm font-medium" data-testid="forward-path-headline">
        {model.pathKind === "direct"
          ? copy.directHeadline
          : model.pathKind === "relay_three"
            ? copy.relayThreeHeadline
            : copy.relayHeadline}
      </p>
      <p className="mt-0.5 text-xs text-[var(--muted-foreground)]" data-testid="forward-path-segment-note">
        {model.pathKind === "direct"
          ? copy.directDesignNote
          : model.pathKind === "relay_three"
            ? copy.relayThreeNote
            : copy.relayNote}
      </p>
      {/* 三跳时明说"哪里能看到它"：列表/详情读数不含中间跳，只有链路卡片有三段。 */}
      {model.pathKind === "relay_three" ? (
        <p className="mt-0.5 text-xs text-[var(--muted-foreground)]" data-testid="forward-path-middle-visibility">
          {copy.middleVisibilityNote}
        </p>
      ) : null}

      {/* 段数/跳数是**结论**，直接来自模型（direct 的 0 跳是设计结论）。 */}
      <p className="mt-1 text-xs text-[var(--muted-foreground)]" data-testid="forward-path-segments">
        {locale === "zh"
          ? `段数 ${model.segmentCount} · 节点间跳 ${model.interNodeHops}`
          : `${model.segmentCount} segment(s) · ${model.interNodeHops} inter-node hop(s)`}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {model.steps.map((step, index) => (
          <span key={`${step.role}-${index}`} className="inline-flex items-center gap-1">
            {index > 0 ? <span className="text-xs">{copy.arrow}</span> : null}
            <StepChip step={step} copy={copy} />
          </span>
        ))}
      </div>

      <BindingsNote model={model} copy={copy} />

      {model.gaps.length > 0 ? (
        <div className="mt-2 text-xs" data-testid="forward-path-gaps">
          <div className="text-[var(--muted-foreground)]">{copy.gapTitle}</div>
          <ul className="mt-0.5 list-disc pl-4">
            {model.gaps.map((gap) => (
              <li key={gap}>{copy.gaps[gap]}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-2 text-xs text-[var(--muted-foreground)]" data-testid="forward-path-no-check">
        {copy.noConnectivityCheck}
      </p>
    </section>
  );
}
