/**
 * Forward 创建对话框的「线路预览」模型（**纯函数，无 IO**）。
 *
 * ── 这个文件解决什么 ──
 *
 * 创建 Forward 时用户在组装一条路径（入口 → [出口] → 目标），但对话框此前只给了一堆
 * 下拉框：选完入口/出口/目标，用户看不到"我拼出来的这条线长什么样"，relay 的前置
 * （必须先绑定出口）也只能靠"没有可用出口节点"这句空话去猜。
 *
 * ── 为什么只能是预览 ──
 *
 * 创建**前**没有 create-preview 端点：`POST /api/forwards/:id/preview` 需要已经存在的
 * id（它服务的是 update）。所以创建前的一切判定都必须由已有事实在**前端**推出来，
 * 本文件就是那一步：它只消费已载入的事实（草稿字段、入口/出口节点、**已预载的绑定列表**），
 * 不发任何请求、不猜后端会怎么放置。
 *
 * ── 三条纪律（都能被行为测试钉住）──
 *
 *  1. **这是"计划"，不是连通性结论**：模型只描述"你正在组装什么"，不做探测、也不引用
 *     任何探测结果 ⇒ 展示层全文必须写明"未做连通性验证"，且不得出现
 *     「正常 / 健康 / 可达 / 连通」这类词；
 *  2. **DIRECT 的"没有节点间跳"是设计结论**：直接把它的段数定为 1（入口 → 目标）并标
 *     `direct_design`，绝不退化成"缺数据 / 空态"；RELAY 两段（入口→出口、出口→目标）是
 *     1 跳；**选了中间跳就是三段**（入口→中间、中间→出口、出口→目标）2 跳，段名与后端
 *     topology 的 `ingress_to_middle` / `middle_to_egress` 对齐。
 *  3. **绑定事实的三种状态不可合并**：
 *     · `bound`       —— 这台入口有绑定（正常可用的 relay 前提交齐）；
 *     · `none`        —— 事实明确：这台入口**确实**没有绑定（下一步是去绑定一台出口）；
 *     · `unavailable` —— **取不到**（读取失败 / 仍在读取 / 晚到的旧作用域事实被丢弃）。
 *     第三种绝不能渲染成"没有可用出口"：那是把一次读取失败说成用户的配置缺失。
 *
 * ── 中间跳（三跳）的边界 ──
 *
 * 本模型**只画**：两段事实（`inboundBound` / `outboundBound`）由调用方从
 * `forward-multihop-model.ts` 拿进来（判定只有那一份实现：服务端判据 = 两段绑定是否都已存在）。
 * 没选中间跳时输出与历史**逐字一致**；选了三跳时缺口码追加在既有缺口之后。
 */

import type { NodeBinding, UserNode } from "@/lib/types";
import type { ForwardCreateDraft } from "@/components/forwards/forward-create-model";

/** 绑定事实的三种状态（见文件头的纪律 3）。 */
export type PathBindingsStatus = "bound" | "none" | "unavailable";

export type ForwardPathStepRole = "ingress" | "middle" | "egress" | "target";

/** 预览里可指出的缺口（展示层把每个码翻成一句人话 + 一个下一步）。 */
export type ForwardPathGapCode =
  | "ingress_address_unreported"
  | "egress_address_unreported"
  | "egress_not_chosen"
  | "egress_not_bound"
  | "target_host_missing"
  | "target_port_missing"
  | "bindings_unavailable"
  /** 中间跳（三跳）相关：地址未上报 / 某一段邻接绑定缺失 / 两段事实取不到。 */
  | "middle_address_unreported"
  | "middle_segment_ingress_missing"
  | "middle_segment_egress_missing"
  | "middle_segments_unavailable";

/**
 * 中间跳（三跳）的两段邻接事实。
 *
 * 这里刻意只收**已判定好的事实**（而不是让预览自己去推）：判定只有一处实现
 * （`forward-multihop-model.ts`，服务端判据 = 两段绑定是否都已存在），预览只负责画。
 * `null` = 取不到（**不是** false）：取不到时预览说"取不到"，不说"没绑定"。
 */
export interface ForwardPathMiddleFacts {
  nodeId: string;
  node: UserNode | null;
  inboundBound: boolean | null;
  outboundBound: boolean | null;
}

export interface ForwardPathStep {
  role: ForwardPathStepRole;
  /** 节点名（`node_id`）或目标地址；**永远不为空**（缺失时降级，见 {@link nodeLabel}）。 */
  label: string;
  /** 连接地址（`connect_ip`）或目标 `host:port`；未上报时 `null`。 */
  address: string | null;
  /** 这一步自身的缺口（地址未上报等）；没有就是 `null`。 */
  gap: ForwardPathGapCode | null;
  /** 节点步骤才有 id（target 为 `null`），供展示层做 key。 */
  nodeId: string | null;
}

export interface ForwardPathPreviewModel {
  mode: "direct" | "relay";
  /**
   * 路径形态（展示层按它选标题与说明，**不要**按 `steps.length` 反推）：
   *   · `direct`       —— 入口 → 目标；
   *   · `relay_two`    —— 入口 → 出口 → 目标（未选中间跳，与历史输出逐字一致）；
   *   · `relay_three`  —— 入口 → 中间 → 出口 → 目标（三跳）。
   */
  pathKind: "direct" | "relay_two" | "relay_three";
  /** 预览的步骤链：direct = [入口, 目标]；relay = [入口, (中间,) 出口, 目标]。 */
  steps: ForwardPathStep[];
  /** 段数：direct = 1，relay 两段 = 2，三跳 = 3。 */
  segmentCount: number;
  /** 节点间跳数：direct = 0（**设计结论**），relay 两段 = 1，三跳 = 2。 */
  interNodeHops: number;
  /** 段数为什么是这样：direct 的 0 是设计结论，不是缺数据。 */
  segmentReason: "direct_design" | "relay_two_segments" | "relay_three_segments";
  target: { host: string; port: string; address: string | null };
  bindingsStatus: PathBindingsStatus;
  /**
   * 事实明确时：这台入口**已绑定**的出口数量（`bound` 态用它）。
   * 事实取不到时为 `null` —— 不知道就是不知道，不给 0。
   */
  boundEgressCount: number | null;
  /** 这台入口**尚未绑定**、且可被绑定的出口节点数（给"下一步"用；没有事实时为 `null`）。 */
  bindableEgressCount: number | null;
  /** 缺口清单（去重、按上面的枚举顺序）。 */
  gaps: ForwardPathGapCode[];
}

/**
 * 节点名降级：`node_id` 缺失/空白时退到 `#<id>`，**不留空白**。
 *
 * 空白是这里最坏的结果：用户看到 `⌊ → 172.20.0.9 → ⌉` 会以为界面坏了，而真相只是
 * "这台节点还没有名字"。降级值至少能对上数据库里的行。
 */
export function nodeLabel(node: UserNode | null, nodeId: string): string {
  const name = node?.node_id?.trim();
  if (name) return name;
  const fallback = nodeId.trim() !== "" ? nodeId : node ? String(node.id) : "";
  return fallback === "" ? "—" : `#${fallback}`;
}

/**
 * 找出口节点对象：**绑定事实优先**，其次才是节点列表。
 *
 * 为什么顺序是这样：创建对话框的节点列表只装**入口能力**的节点，而用户选的出口来自
 * 绑定列表（它自带 `egress_node`）。只查节点列表会得到 `null`，于是预览里本该写
 * "jp-out-01" 的地方退化成 "#2" —— 名字明明就在手边的绑定事实里，不该丢掉。
 */
export function resolveEgressNode(input: {
  egressId: string;
  bindings: readonly NodeBinding[] | null;
  nodes: readonly UserNode[];
}): UserNode | null {
  const id = input.egressId.trim();
  if (id === "") return null;
  const bound = (input.bindings ?? []).find((row) => String(row.egress_node_id) === id)?.egress_node;
  if (bound) return bound;
  return input.nodes.find((node) => String(node.id) === id) ?? null;
}

/** 连接地址：`connect_ip` 未上报/空白 ⇒ `null`（展示层写"未上报连接地址"，不写空白）。 */
export function connectAddress(node: UserNode | null): string | null {
  const value = node?.connect_ip?.trim();
  return value ? value : null;
}

function targetAddress(host: string, port: string): string | null {
  const h = host.trim();
  const p = port.trim();
  if (h === "") return null;
  return p === "" ? h : `${h}:${p}`;
}

export interface ForwardPathInput {
  draft: Pick<ForwardCreateDraft, "mode" | "ingressId" | "egressId" | "targetHost" | "targetPort">;
  ingress: UserNode | null;
  egress: UserNode | null;
  /**
   * 当前预览的作用域（建议用 `workspaceId:ingressId`）：事实必须与它同源。
   *
   * 这是"切 Workspace 丢弃晚到响应"在**本层**的落点：绑定事实自带作用域标签，
   * 标签不匹配时一律当作**取不到**（旧空间的事实绝不能画进新空间的预览）。
   */
  scopeKey: string;
  /** 已预载的绑定事实；`null` = 取不到（读取失败 / 仍在读取）。 */
  bindingsFacts: { scopeKey: string; bindings: readonly NodeBinding[] | null } | null;
  /** 尚未绑定、可被绑定的出口节点数（调用方已算出的候选数）。 */
  bindableEgressCount?: number | null;
  /**
   * 中间跳（三跳）事实；缺省/`null` = 这条转发不使用中间跳（输出与历史逐字一致）。
   * `nodeId` 为空串 = 没选中间跳。
   */
  middle?: ForwardPathMiddleFacts | null;
}

/** 绑定事实的三种状态判定（唯一实现，展示层不再推断）。 */
export function pathBindingsStatus(
  facts: ForwardPathInput["bindingsFacts"],
  scopeKey: string,
): PathBindingsStatus {
  if (facts === null) return "unavailable";
  // 晚到的旧作用域事实：丢弃，并且**如实说取不到**（不许当成"没有绑定"）。
  if (facts.scopeKey !== scopeKey) return "unavailable";
  if (facts.bindings === null) return "unavailable";
  return facts.bindings.length > 0 ? "bound" : "none";
}

/** 该出口节点是否真的在这台入口的绑定列表里（预览只做事实核对，不放行"看着像绑定"）。 */
export function isEgressBound(bindings: readonly NodeBinding[] | null, egressId: string): boolean {
  if (bindings === null || egressId.trim() === "") return false;
  return bindings.some((binding) => String(binding.egress_node_id) === egressId.trim());
}

export function buildForwardPathPreview(input: ForwardPathInput): ForwardPathPreviewModel {
  const { draft } = input;
  const mode: "direct" | "relay" = draft.mode === "relay" ? "relay" : "direct";
  const bindingsStatus = pathBindingsStatus(input.bindingsFacts, input.scopeKey);
  const facts = bindingsStatus === "unavailable" ? null : input.bindingsFacts!.bindings;
  // 已绑定数量只在"事实明确"时才有值：取不到就是 null（不许给 0 冒充"一台都没绑"）。
  const boundEgressCount = facts === null ? null : facts.length;

  const ingressAddress = connectAddress(input.ingress);
  const ingressStep: ForwardPathStep = {
    role: "ingress",
    label: nodeLabel(input.ingress, draft.ingressId),
    address: ingressAddress,
    gap: ingressAddress === null ? "ingress_address_unreported" : null,
    nodeId: draft.ingressId.trim() === "" ? null : draft.ingressId.trim(),
  };

  const host = draft.targetHost.trim();
  const port = draft.targetPort.trim();
  const address = targetAddress(draft.targetHost, draft.targetPort);
  const targetGap: ForwardPathGapCode | null =
    host === "" ? "target_host_missing" : port === "" ? "target_port_missing" : null;
  const targetStep: ForwardPathStep = {
    role: "target",
    // 名字用 host、地址用 `host:port`：同一个值写两遍（"目标 target-b:3030 / target-b:3030"）
    // 在卡片上读起来像重复渲染，所以名字只取 host（缺 host 时才没有名字）。
    label: host,
    address,
    gap: targetGap,
    nodeId: null,
  };

  const gaps: ForwardPathGapCode[] = [];
  const push = (code: ForwardPathGapCode | null) => {
    if (code !== null && !gaps.includes(code)) gaps.push(code);
  };
  push(ingressStep.gap);
  push(targetGap);

  if (mode === "direct") {
    // DIRECT：入口直接到目标。**没有节点间跳是设计结论**（后端 topology 的 `segments: []`
    // 是同一个事实），所以这里既不出出口步骤，也不把出口缺口算进来。
    return {
      mode,
      pathKind: "direct",
      steps: [ingressStep, targetStep],
      segmentCount: 1,
      interNodeHops: 0,
      segmentReason: "direct_design",
      target: { host, port, address },
      bindingsStatus,
      boundEgressCount,
      bindableEgressCount: input.bindableEgressCount ?? null,
      gaps,
    };
  }

  const egressId = draft.egressId.trim();
  const egressAddress = connectAddress(input.egress);
  /**
   * 出口这一步的缺口只报**一个**：
   *   · 还没选出口 ⇒ `egress_not_chosen`（此时"地址未上报"是废话：根本没有节点可上报）；
   *   · 选了但没上报地址 ⇒ `egress_address_unreported`。
   * 两种都让展示层写出确定的话，而不是留空白。
   */
  const egressStepGap: ForwardPathGapCode | null =
    egressId === ""
      ? "egress_not_chosen"
      : egressAddress === null
        ? "egress_address_unreported"
        : null;
  const egressStep: ForwardPathStep = {
    role: "egress",
    label: egressId === "" ? "" : nodeLabel(input.egress, egressId),
    address: egressAddress,
    gap: egressStepGap,
    nodeId: egressId === "" ? null : egressId,
  };

  push(egressStepGap);
  if (egressId !== "" && bindingsStatus === "unavailable") {
    // 事实取不到 ⇒ 不许判断"没绑定"，只报"取不到"。
    push("bindings_unavailable");
  } else if (egressId !== "" && !isEgressBound(facts, egressId)) {
    push("egress_not_bound");
  }
  // 即使已经选了出口，只要绑定事实取不到，也要说清楚（避免"看起来选好了"）。
  if (bindingsStatus === "unavailable") push("bindings_unavailable");

  const middleId = (input.middle?.nodeId ?? "").trim();
  if (middleId === "") {
    // 未选中间跳：输出与历史**逐字一致**（两段/1 跳），不因为新增能力而改变既有呈现。
    return {
      mode,
      pathKind: "relay_two",
      steps: [ingressStep, egressStep, targetStep],
      segmentCount: 2,
      interNodeHops: 1,
      segmentReason: "relay_two_segments",
      target: { host, port, address },
      bindingsStatus,
      boundEgressCount,
      bindableEgressCount: input.bindableEgressCount ?? null,
      gaps,
    };
  }

  const middleAddress = connectAddress(input.middle?.node ?? null);
  const middleStep: ForwardPathStep = {
    role: "middle",
    label: nodeLabel(input.middle?.node ?? null, middleId),
    address: middleAddress,
    gap: middleAddress === null ? "middle_address_unreported" : null,
    nodeId: middleId,
  };
  // 中间跳的缺口一律**追加在既有缺口之后**：历史场景（无中间跳）的缺口顺序保持不变。
  push(middleStep.gap);
  const inboundBound = input.middle?.inboundBound ?? null;
  const outboundBound = input.middle?.outboundBound ?? null;
  if (inboundBound === null || outboundBound === null) {
    push("middle_segments_unavailable");
  } else {
    if (!inboundBound) push("middle_segment_ingress_missing");
    if (!outboundBound) push("middle_segment_egress_missing");
  }

  return {
    mode,
    pathKind: "relay_three",
    steps: [ingressStep, middleStep, egressStep, targetStep],
    segmentCount: 3,
    interNodeHops: 2,
    segmentReason: "relay_three_segments",
    target: { host, port, address },
    bindingsStatus,
    boundEgressCount,
    bindableEgressCount: input.bindableEgressCount ?? null,
    gaps,
  };
}

/**
 * 预览作用域键（建议：`workspaceId:ingressId`）。
 *
 * 作用域一变（切 Workspace 或换入口），键就变 ⇒ 上一作用域的绑定事实标签不再匹配，
 * 模型自动把它判成 `unavailable` 而不是沿用。
 */
export function forwardPathScopeKey(scope: { workspaceId: number | null; ingressId: string }): string {
  return `${scope.workspaceId ?? "?"}:${scope.ingressId.trim()}`;
}
