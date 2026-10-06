"use client";

/**
 * Forward 创建对话框 · **中间跳（三跳）选择器**（自包含展示层）。
 *
 * ── 它只做一件事 ──
 *
 * 把 {@link ForwardMultihopModel}（纯函数产物）画出来，让用户在**提交前**就看清：
 *   · 哪些节点能当中间跳（两段邻接绑定都已存在 —— 这正是服务端创建时会判的判据）；
 *   · 哪些**不能**、**为什么不能**，以及缺的那一段能不能补（补不了就绝不给"去绑定"的死路）；
 *   · 事实取不到时说"取不到"，**不**说"没有可用节点"。
 *
 * ── 三条话术纪律（行为测试钉住）──
 *  1. **这是前置说明，不是连通性结论**：全文不出现「正常 / 健康 / 可达」，也不承诺这条路径此刻可用；
 *  2. **不假装列表/详情能看到中间跳**：`forwardView` 不含 `middle_node`，只有详情页的「链路」
 *     （topology，含 `ingress_to_middle` / `middle_to_egress` 两段）能核验 —— 文案照实说；
 *  3. **DIRECT 不出现中间跳**：非 relay 直接不渲染（后端 create 只在 `if (egress)` 里校验两段，
 *     DIRECT 带上它会被静默落库且永不使用 ⇒ 结构上不给这个入口）。
 *
 * 文案走组件内 zh/en 表（`locale` 由 props 传入），**不写** `lib/i18n/dictionaries.ts`。
 */

import Link from "next/link";
import type {
  ForwardMultihopModel,
  MultihopCandidate,
  MultihopReasonCode,
} from "@/components/forwards/forward-multihop-model";
import { multihopMissingSegment } from "@/components/forwards/forward-multihop-model";
import type { Locale } from "@/lib/i18n";

export interface ForwardMultihopCopy {
  title: string;
  planNote: string;
  empty: string;
  excludedTitle: string;
  noneSelectable: string;
  needIngress: string;
  needEgress: string;
  factsUnavailable: string;
  factsUnavailableNext: string;
  noMiddleOption: string;
  threeSegments: string;
  visibilityNote: string;
  /** 去节点页绑定的链接文案（第二段只能在节点页建：绑定以该节点为源）。 */
  bindHint: string;
  /** 第一段可补：对话框下面 relay 的「绑定并使用」就能补齐。 */
  bindInboundHint: string;
  /** 第二段可补：以中间跳为源的绑定只能在节点页建。 */
  bindOutboundHint: string;
  /** 角色不允许建第一段（该节点当目标 ⇒ 需 egress|both）。 */
  roleHintInbound: string;
  /** 角色不允许建第二段（该节点当源 ⇒ 需 ingress|both）。 */
  roleHintOutbound: string;
  blockedTitle: string;
  reasons: Record<MultihopReasonCode, string>;
  segmentInbound: string;
  segmentOutbound: string;
}

const ZH: ForwardMultihopCopy = {
  title: "中间跳（可选，做成三跳）",
  planNote:
    "选了中间跳，这条转发就由三段组成：入口 → 中间 → 出口 → 目标。两段邻接绑定都必须已经存在，服务端在创建时会校验它们。",
  empty: "不使用中间跳（两段：入口 → 出口 → 目标）",
  excludedTitle: "这些节点不能当中间跳：",
  noneSelectable: "当前没有节点同时具备两段绑定，所以这一步暂时没有可选项。",
  needIngress: "先选择入口节点，才能列出可用的中间跳。",
  needEgress: "先选择出口节点：第二段绑定是「中间 → 出口」，没有出口就无从判定。",
  factsUnavailable:
    "取不到绑定事实：无法判断哪些节点同时具备两段绑定。这不等于「没有可用节点」，请刷新后重试。",
  factsUnavailableNext: "下一步：刷新页面（或稍候）再看一次；若仍取不到，请检查节点接口与权限。",
  noMiddleOption: "不使用中间跳（两段）",
  threeSegments: "已选中间跳：这条转发的路径是 入口 → 中间 → 出口 → 目标（三段）。",
  visibilityNote:
    "创建后可在该转发详情页的「链路」卡片核验三段（段名 ingress_to_middle / middle_to_egress）；列表与详情读数不显示中间跳。",
  bindHint: "去节点页",
  bindInboundHint: "第一段可以在上面的「绑定并使用」里选择这台节点来补齐。",
  bindOutboundHint: "第二段只能在节点页建：以这台节点为来源，绑定到所选出口。",
  roleHintInbound: "该节点角色不能作为第一段的出口（那张绑定要求目标为 egress 或 both）。",
  roleHintOutbound: "该节点角色不能作为第二段的入口（那张绑定要求来源为 ingress 或 both）。",
  blockedTitle: "当前选中的中间跳不能提交：",
  reasons: {
    same_as_ingress: "它与入口节点是同一台（中间跳必须是另一台节点）。",
    same_as_egress: "它与出口节点是同一台（中间跳必须是另一台节点）。",
    facts_unavailable: "取不到它的绑定事实：这不等于「没有绑定」，请刷新后重试。",
    unknown_node: "这台节点不在当前已知的节点列表里。",
    segment_ingress_to_middle_missing: "缺少「入口 → 该节点」这条绑定。",
    segment_middle_to_egress_missing: "缺少「该节点 → 出口」这条绑定。",
  },
  segmentInbound: "第一段（入口 → 该节点）",
  segmentOutbound: "第二段（该节点 → 出口）",
};

const EN: ForwardMultihopCopy = {
  title: "Middle hop (optional, makes it three segments)",
  planNote:
    "With a middle hop this forward is assembled from three segments: ingress → middle → egress → target. Both adjacent bindings must already exist; the server validates them on create.",
  empty: "No middle hop (two segments: ingress → egress → target)",
  excludedTitle: "These nodes cannot be the middle hop:",
  noneSelectable: "No node currently has both bindings, so there is nothing to pick here yet.",
  needIngress: "Choose an ingress node first; only then can candidate middle hops be listed.",
  needEgress: "Choose an egress node first: the second binding is “middle → egress”, and there is nothing to check without it.",
  factsUnavailable:
    "Binding facts unavailable: cannot tell which nodes have both bindings. That is not the same as “no node available”; reload and try again.",
  factsUnavailableNext:
    "Next: reload the page (or wait a moment). If it stays unavailable, check the nodes API and your permissions.",
  noMiddleOption: "No middle hop (two segments)",
  threeSegments: "Middle hop chosen: this forward's path is ingress → middle → egress → target (three segments).",
  visibilityNote:
    "After creating it, the “path” card on the forward detail page shows all three segments (segment names ingress_to_middle / middle_to_egress); list and detail reads do not include the middle hop.",
  bindHint: "nodes page",
  bindInboundHint: "The first segment can be completed with “bind and use” above by picking this node.",
  bindOutboundHint: "The second segment can only be created on the nodes page: bind from this node to the chosen egress.",
  roleHintInbound: "This node's role cannot be the egress of the first segment (that binding requires the target to be egress or both).",
  roleHintOutbound: "This node's role cannot be the ingress of the second segment (that binding requires the source to be ingress or both).",
  blockedTitle: "The selected middle hop cannot be submitted:",
  reasons: {
    same_as_ingress: "It is the same node as the ingress (the middle hop must be a different node).",
    same_as_egress: "It is the same node as the egress (the middle hop must be a different node).",
    facts_unavailable: "Its binding facts are unavailable: that is not the same as “not bound”; reload and try again.",
    unknown_node: "This node is not in the currently known node list.",
    segment_ingress_to_middle_missing: "The binding “ingress → this node” is missing.",
    segment_middle_to_egress_missing: "The binding “this node → egress” is missing.",
  },
  segmentInbound: "First segment (ingress → this node)",
  segmentOutbound: "Second segment (this node → egress)",
};

const COPY: Record<Locale, ForwardMultihopCopy> = { zh: ZH, en: EN };

export function forwardMultihopCopy(locale: Locale): ForwardMultihopCopy {
  return COPY[locale];
}

/**
 * 候选一行的动作建议：缺的是哪一段、能不能补、怎么补。
 *
 * 两段的补法**不一样**：第一段以入口为源（对话框里 relay 的「绑定并使用」就能建），
 * 第二段以中间跳为源（只能在节点页建）——把它们都说成"去绑定"会让用户在第一段上白跑一趟。
 */
function candidateNextStep(candidate: MultihopCandidate): { text: "bind" | "role" | null; segment: "inbound" | "outbound" | null } {
  const missing = multihopMissingSegment(candidate);
  if (missing === null) return { text: null, segment: null };
  return {
    text: missing.creatable ? "bind" : "role",
    segment: missing.segment === "ingress_to_middle" ? "inbound" : "outbound",
  };
}

/**
 * 「缺的是哪一段 + 能不能补 + 怎么补」——**唯一**的实现，排除清单与"选中的不能提交"告警共用
 * （两处各写一遍必然漂移：一处说能补、另一处说不能，用户就不知道该信谁）。
 */
function NextStepNote({ candidate, copy }: { candidate: MultihopCandidate; copy: ForwardMultihopCopy }) {
  const next = candidateNextStep(candidate);
  if (next.text === null || next.segment === null) return null;
  return (
    <span className="text-[var(--muted-foreground)]">
      {" "}
      <span data-testid={`forward-multihop-segment-${candidate.nodeId}`}>
        {next.segment === "inbound" ? copy.segmentInbound : copy.segmentOutbound}
      </span>
      {" · "}
      {next.text === "bind" ? (
        next.segment === "inbound" ? (
          copy.bindInboundHint
        ) : (
          <>
            {copy.bindOutboundHint}{" "}
            <Link href="/nodes" className="underline underline-offset-2">
              {copy.bindHint}
            </Link>
          </>
        )
      ) : next.segment === "inbound" ? (
        copy.roleHintInbound
      ) : (
        copy.roleHintOutbound
      )}
    </span>
  );
}

function CandidateRow({ candidate, copy }: { candidate: MultihopCandidate; copy: ForwardMultihopCopy }) {
  const reason = candidate.reason;
  return (
    <li data-testid={`forward-multihop-excluded-${candidate.nodeId}`} className="mt-1">
      <span className="font-medium">{candidate.label}</span>
      <span className="text-[var(--muted-foreground)]">
        {" · "}
        {reason === null ? "" : copy.reasons[reason]}
      </span>
      <NextStepNote candidate={candidate} copy={copy} />
    </li>
  );
}

function ExcludedNote({ model, copy }: { model: ForwardMultihopModel; copy: ForwardMultihopCopy }) {
  if (model.phase !== "ready" || model.excluded.length === 0) return null;
  return (
    <div className="text-xs" data-testid="forward-multihop-excluded">
      <div className="text-[var(--muted-foreground)]">{copy.excludedTitle}</div>
      <ul className="list-disc pl-4">
        {model.excluded.map((candidate) => (
          <CandidateRow key={candidate.nodeId} candidate={candidate} copy={copy} />
        ))}
      </ul>
    </div>
  );
}

/**
 * 中间跳区块。**纯展示**：同一个 model + value 一定渲染出同样的 HTML，自己没有任何状态，
 * 因此切 Workspace 后不可能残留上一个空间的内容（作用域键变了，模型就把事实判成取不到）。
 */
export function ForwardMultihopSection({
  model,
  locale,
  value,
  onChange,
}: {
  model: ForwardMultihopModel;
  locale: Locale;
  value: string;
  onChange: (next: string) => void;
}) {
  const copy = forwardMultihopCopy(locale);
  // DIRECT：结构上不给这个入口（后端对 DIRECT 的 middle_node_id 既不校验也不使用）。
  if (!model.applicable) return null;

  const blocked = value.trim() !== "" ? model.submitBlockedReason : null;

  return (
    <section
      data-testid="forward-multihop-section"
      data-phase={model.phase}
      className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-3"
    >
      <div className="text-sm font-medium">{copy.title}</div>
      <p className="text-xs text-[var(--muted-foreground)]">{copy.planNote}</p>

      {model.phase === "need_ingress" ? (
        <p className="text-xs text-[var(--muted-foreground)]" data-testid="forward-multihop-need-ingress">
          {copy.needIngress}
        </p>
      ) : null}

      {model.phase === "need_egress" ? (
        <p className="text-xs text-[var(--muted-foreground)]" data-testid="forward-multihop-need-egress">
          {copy.needEgress}
        </p>
      ) : null}

      {model.phase === "unavailable" ? (
        <div className="text-xs" data-testid="forward-multihop-facts-unavailable">
          <p>{copy.factsUnavailable}</p>
          <p className="mt-0.5">{copy.factsUnavailableNext}</p>
        </div>
      ) : null}

      {model.phase === "ready" ? (
        <>
          <select
            value={value}
            onChange={(event) => onChange(event.target.value)}
            data-testid="forward-multihop-select"
            className="flex h-9 w-full rounded-md border border-[var(--input)] bg-[var(--card)] px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            <option value="">{copy.empty}</option>
            {model.candidates.map((candidate) => (
              <option key={candidate.nodeId} value={candidate.nodeId} data-testid={`forward-multihop-option-${candidate.nodeId}`}>
                {candidate.label}
                {candidate.node?.connect_ip ? ` · ${candidate.node.connect_ip}` : ""}
              </option>
            ))}
          </select>

          {model.candidates.length === 0 ? (
            <p className="text-xs text-[var(--muted-foreground)]" data-testid="forward-multihop-none">
              {copy.noneSelectable}
            </p>
          ) : null}

          {value.trim() !== "" && model.selected?.selectable ? (
            <p className="text-xs" data-testid="forward-multihop-three-segments">
              {copy.threeSegments}
            </p>
          ) : null}

          <ExcludedNote model={model} copy={copy} />
        </>
      ) : null}

      {blocked !== null ? (
        <p
          className="rounded-md border border-[var(--destructive)]/40 bg-[var(--destructive)]/5 px-2 py-1 text-xs"
          data-testid="forward-multihop-blocked"
          role="alert"
        >
          {copy.blockedTitle}
          {copy.reasons[blocked]}
          {/* 选中的那台缺哪一段、能不能补、怎么补 —— 与排除清单同一份实现。 */}
          {model.selected ? <NextStepNote candidate={model.selected} copy={copy} /> : null}
        </p>
      ) : null}

      <p className="text-xs text-[var(--muted-foreground)]" data-testid="forward-multihop-visibility">
        {copy.visibilityNote}
      </p>
    </section>
  );
}
