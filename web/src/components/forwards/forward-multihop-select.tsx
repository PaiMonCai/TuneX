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
  title: "中间节点（可选）",
  planNote:
    "选择中间节点后，路径会变成：入口 → 中间 → 出口 → 目标。TuneX 会检查相邻节点关系是否已经准备好。",
  empty: "不使用中间节点（入口 → 出口 → 目标）",
  excludedTitle: "这些节点当前不能作为中间节点：",
  noneSelectable: "当前没有节点同时满足两段路径关系，所以暂时没有可选中间节点。",
  needIngress: "先选择入口节点，才能列出可用的中间节点。",
  needEgress: "先选择出口节点；没有出口时无法判断中间 → 出口这一段是否可用。",
  factsUnavailable:
    "节点关系暂时取不到：无法判断哪些节点能同时完成两段路径。这不等于「没有可用节点」，请刷新后重试。",
  factsUnavailableNext: "下一步：刷新页面（或稍候）再看一次；若仍取不到，请检查节点接口与权限。",
  noMiddleOption: "不使用中间节点",
  threeSegments: "已选中间节点：路径是 入口 → 中间 → 出口 → 目标（三段）。",
  visibilityNote:
    "创建后可在该转发详情页的「路径」卡片查看完整节点链；列表页只展示路径摘要。",
  bindHint: "去节点页",
  bindInboundHint: "第一段可以在上面的出口区域里选择这台节点并「启用并使用」。",
  bindOutboundHint: "第二段需要到节点页配置：让这台节点可以继续转到所选出口。",
  roleHintInbound: "该节点角色不能接在入口之后；请把角色调整为出口或兼任。",
  roleHintOutbound: "该节点角色不能继续转到下一跳；请把角色调整为入口或兼任。",
  blockedTitle: "当前选中的中间节点还不能使用：",
  reasons: {
    same_as_ingress: "它与入口节点是同一台（中间节点必须是另一台机器）。",
    same_as_egress: "它与出口节点是同一台（中间节点必须是另一台机器）。",
    facts_unavailable: "暂时取不到它的节点关系，无法判断能否使用；请刷新后重试。",
    unknown_node: "这台节点不在当前已知的节点列表里。",
    segment_ingress_to_middle_missing: "入口 → 该节点 这一段关系尚未准备好。",
    segment_middle_to_egress_missing: "该节点 → 出口 这一段关系尚未准备好。",
  },
  segmentInbound: "第一段（入口 → 该节点）",
  segmentOutbound: "第二段（该节点 → 出口）",
};

const EN: ForwardMultihopCopy = {
  title: "Middle node (optional)",
  planNote:
    "With a middle node, the path becomes ingress → middle → egress → target. TuneX checks that the adjacent node relationships are ready.",
  empty: "No middle node (ingress → egress → target)",
  excludedTitle: "These nodes cannot currently be used as the middle node:",
  noneSelectable: "No node currently satisfies both path relationships, so there is no middle node to pick yet.",
  needIngress: "Choose an ingress node first; only then can candidate middle nodes be listed.",
  needEgress: "Choose an egress node first; without it TuneX cannot evaluate the middle → egress segment.",
  factsUnavailable:
    "Node relationship facts are unavailable, so TuneX cannot tell which nodes can complete both path segments. Reload and try again.",
  factsUnavailableNext:
    "Next: reload the page (or wait a moment). If it stays unavailable, check the nodes API and your permissions.",
  noMiddleOption: "No middle node",
  threeSegments: "Middle node chosen: this forward's path is ingress → middle → egress → target (three segments).",
  visibilityNote:
    "After creating it, the forward detail page's “path” card shows the complete node chain; the list only shows a path summary.",
  bindHint: "nodes page",
  bindInboundHint: "The first segment can be prepared above by choosing this node and clicking “enable and use”.",
  bindOutboundHint: "The second segment must be prepared on the nodes page so this node can continue to the selected egress.",
  roleHintInbound: "This node cannot receive the first segment with its current role; change it to egress or both.",
  roleHintOutbound: "This node cannot forward the second segment with its current role; change it to ingress or both.",
  blockedTitle: "The selected middle node cannot be used yet:",
  reasons: {
    same_as_ingress: "It is the same node as the ingress (the middle node must be a different machine).",
    same_as_egress: "It is the same node as the egress (the middle node must be a different machine).",
    facts_unavailable: "Its node relationship facts are unavailable, so TuneX cannot determine whether it can be used; reload and try again.",
    unknown_node: "This node is not in the currently known node list.",
    segment_ingress_to_middle_missing: "The ingress → this node relationship is not ready.",
    segment_middle_to_egress_missing: "The this node → egress relationship is not ready.",
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
