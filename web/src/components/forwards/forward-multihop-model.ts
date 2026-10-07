/**
 * 三跳（多跳）接线的**纯模型**：候选分类、不可选原因、创建载荷字段、失败码→人话/下一步。
 * 无 IO、无 React、无状态 —— 组件只负责画，判定只有这一份实现。
 *
 * ── 事实基础（都读过并核对过后端源码，不是推断）──
 *
 *  1. **服务端在创建时判的就是"两段绑定是否都已存在"**：`forward-service.ts:764-783`
 *     —— 三跳用到的两条邻接是 (入口→中间) 与 (中间→出口)，缺任何一段即 409
 *     `binding_required`（`(入口→出口)` 那条**不被使用**）。它**只查绑定存在性，不查角色**。
 *  2. **角色检查在"绑定创建"处**（`routes/nodes.ts:378-383`）：同一条路由同时要求
 *     **源** ∈ {ingress, both} 且 **目标** ∈ {egress, both}。于是：
 *       · 第一段 `入口→中间`：中间是**目标** ⇒ 需 `egress|both`；
 *       · 第二段 `中间→出口`：中间是**源** ⇒ 需 `ingress|both`；
 *       · ⇒ 通过 API 能**同时建成两段**的只有 `role === "both"`（Lead 已采纳此结论）。
 *     绑定写入还需 `node:manage`（`nodes.ts:50-53`）。
 *  3. 因此本模型的口径是：**可用性 = 服务端真实判据（两段都在）**；只有缺段时才看角色——
 *     能补建才给"去绑定"的下一步，不能补建就进"不可选 + 原因"，绝不把用户引到一个撞 409 的死路。
 *  4. **DIRECT 绝不携带 `middle_node_id`**：后端 create 路径只在 `if (egress)` 里校验两段
 *     （`forward-service.ts:761`），DIRECT 的 `middle_node_id` 会被**静默落库且永不使用**
 *     —— 那是后端目前的一处缺口，前端不踩它（{@link multihopCreateFields} 里 fail-closed）。
 *
 * ── 展示纪律（行为测试钉住）──
 *   · "取不到" 与 "确实没有某段绑定" 是两个分支：`null` 事实一律判 `facts_unavailable`；
 *   · 文案里不出现「正常 / 健康 / 可达 / 连通」，也不宣称列表/详情读数能看到中间跳
 *     （`forwardView` 不含 `middle_node`，只有 topology 有三段）。
 */
import { nodeLabel } from "@/components/forwards/forward-path-model";
import { conditionTitle } from "@/lib/node-lifecycle-i18n";
import type { Locale } from "@/lib/i18n";
import type { NodeBinding, UserNode } from "@/lib/types";

/** 不可选的原因码（展示层逐码翻一句人话 + 一个下一步）。 */
export type MultihopReasonCode =
  | "same_as_ingress"
  | "same_as_egress"
  | "facts_unavailable"
  | "unknown_node"
  | "role_not_both"
  | "segment_ingress_to_middle_missing"
  | "segment_middle_to_egress_missing";

export type MultihopPhase = "not_relay" | "need_ingress" | "need_egress" | "unavailable" | "ready";

export interface MultihopCandidate {
  nodeId: string;
  /** 已知节点视图；未知时为 `null`（标签降级，不留空白）。 */
  node: UserNode | null;
  /** 展示标签（`node_id`，缺失时降级到 `#id`）。 */
  label: string;
  role: UserNode["role"] | null;
  /** 第一段 `入口→该节点` 是否已绑定；`null` = 事实取不到（**不是** false）。 */
  inboundBound: boolean | null;
  /** 第二段 `该节点→出口` 是否已绑定；`null` = 事实取不到。 */
  outboundBound: boolean | null;
  /** true ⇔ 服务端会接受它当中间跳（两段都已存在）。 */
  selectable: boolean;
  /** 不可选的原因；可选时为 `null`。 */
  reason: MultihopReasonCode | null;
  /**
   * 缺失的那一段**能否**补建（角色 + `node:manage`）。
   *
   *   · 第一段把该节点当**目标** ⇒ 需 `egress|both`；
   *   · 第二段把该节点当**源** ⇒ 需 `ingress|both`。
   * 两段都不行（角色不满足且没有 `node:manage`）时，展示层**不得**给"去绑定"的死路。
   */
  canCreateInbound: boolean;
  canCreateOutbound: boolean;
}

export interface ForwardMultihopModel {
  /** 只有 relay 才有中间跳（DIRECT 不适用）。 */
  applicable: boolean;
  phase: MultihopPhase;
  /** 可选的候选（两段都已绑定）。 */
  candidates: MultihopCandidate[];
  /** 不可选的候选（**列出来并说明原因**，而不是从界面上消失）。 */
  excluded: MultihopCandidate[];
  /** 当前草稿选中的候选（找不到时为 `null`）。 */
  selected: MultihopCandidate | null;
  /** 选了中间跳却**不能**提交时的原因（提交按钮据此禁用 + 给出下一步）。 */
  submitBlockedReason: MultihopReasonCode | null;
}

export interface MultihopFacts {
  /** 事实自带的作用域标签（`workspaceId:ingressId`）。 */
  scopeKey: string;
  /** 按**来源节点**分组的绑定（key = 源节点 id）；`null` = 整份取不到。 */
  byIngress: Record<string, NodeBinding[]> | null;
}

export interface MultihopInput {
  mode: "direct" | "relay";
  ingressId: string;
  egressId: string;
  middleNodeId: string;
  canManageNodes: boolean;
  /** 当前预览的作用域键；与事实标签不一致 ⇒ 一律当作取不到。 */
  scopeKey: string;
  facts: MultihopFacts | null;
  /** 已知节点（对话框给入口能力节点即可满足 role=both 的枚举；组件可自取全量）。 */
  nodes: readonly UserNode[];
}

function bindingsOf(facts: MultihopFacts | null, nodeId: string): NodeBinding[] | null {
  if (facts === null || facts.byIngress === null) return null;
  const rows = facts.byIngress[nodeId];
  // 没登记 = 这份事实里没有该来源的绑定 ⇒ **未取到**（不是"确实没有"）：
  // 调用方预载了哪些来源是它的事，模型不许把"没给我"读成"不存在"。
  return rows ?? null;
}

function hasEgressNode(bindings: NodeBinding[] | null, egressId: string): boolean | null {
  if (bindings === null) return null;
  return bindings.some((row) => String(row.egress_node_id) === egressId);
}

/** 角色能否让该节点补建某一段（`null` 角色 = 未知 ⇒ 一律按不能，fail-closed）。 */
export function roleAllowsInboundTarget(role: UserNode["role"] | null): boolean {
  return role === "egress" || role === "both";
}
export function roleAllowsOutboundSource(role: UserNode["role"] | null): boolean {
  return role === "ingress" || role === "both";
}

/**
 * 候选全集：已知节点里 `role === "both"` 的 ∪ 第一段绑定里出现过的节点（去重、保序）。
 *
 * 为什么是这两类，而不是"工作空间里所有节点"：
 *   · `role === "both"` 是**唯一**能通过 API 同时建成两段的角色（见文件头 2）——所有"将来可能
 *     可用"的节点都在这个集合里，因此"不可选 + 原因"清单覆盖了用户能想到的每一台；
 *   · 第一段绑定里出现过的节点：可能是**角色后来变过**的历史中间跳（服务端只查绑定存在性），
 *     不把它们列出来，用户就会遇到"明明线上在跑三跳、创建时却选不到那台节点"；
 *   · 纯 `egress` 且与入口无绑定的节点**不可能**成为中间跳（第二段以它为源，角色的检查在
 *     绑定创建处），把它列进"不可选"只会增加噪音；它也根本不在创建对话框拿到的节点列表里
 *     （对话框只装入口能力节点）。这条边界由测试钉住。
 */
export function multihopUniverse(input: {
  nodes: readonly UserNode[];
  inboundBindings: readonly NodeBinding[] | null;
}): UserNode[] {
  const out: UserNode[] = [];
  const seen = new Set<string>();
  const push = (node: UserNode) => {
    const key = String(node.id);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(node);
  };
  for (const node of input.nodes) if (node.role === "both") push(node);
  for (const binding of input.inboundBindings ?? []) {
    if (binding.egress_node) push(binding.egress_node);
  }
  return out;
}

function classify(input: {
  node: UserNode | null;
  nodeId: string;
  role: UserNode["role"] | null;
  inboundBound: boolean | null;
  outboundBound: boolean | null;
  ingressId: string;
  egressId: string;
  canManageNodes: boolean;
}): MultihopCandidate {
  const { nodeId, role, inboundBound, outboundBound, ingressId, egressId, canManageNodes } = input;
  const canCreateInbound = canManageNodes && roleAllowsInboundTarget(role);
  const canCreateOutbound = canManageNodes && roleAllowsOutboundSource(role);
  const base = {
    nodeId,
    node: input.node,
    label: nodeLabel(input.node, nodeId),
    role,
    inboundBound,
    outboundBound,
    canCreateInbound,
    canCreateOutbound,
  };
  /**
   * 原因优先级（越靠前越"不可修复"，也越该先说）：
   *   同节点 → **节点本身都不认识**（node 为 null）→ 事实取不到 → 具体缺哪一段。
   * "不认识这台节点"要先于"它的绑定取不到"：后者会让人以为去绑定就能修好。
   */
  const reason: MultihopReasonCode | null =
    nodeId === ingressId
      ? "same_as_ingress"
      : nodeId === egressId && egressId !== ""
        ? "same_as_egress"
        : input.node === null
          ? "unknown_node"
          : role !== "both"
            ? "role_not_both"
            : inboundBound === null || outboundBound === null
              ? canManageNodes
                ? null
                : "facts_unavailable"
              : inboundBound && outboundBound
                ? null
                : canManageNodes
                  ? null
                  : !inboundBound
                    ? "segment_ingress_to_middle_missing"
                    : "segment_middle_to_egress_missing";
  return { ...base, selectable: reason === null, reason };
}

export function buildForwardMultihopModel(input: MultihopInput): ForwardMultihopModel {
  const empty: ForwardMultihopModel = {
    applicable: false,
    phase: "not_relay",
    candidates: [],
    excluded: [],
    selected: null,
    submitBlockedReason: null,
  };
  if (input.mode !== "relay") return empty;
  if (input.ingressId.trim() === "") return { ...empty, applicable: true, phase: "need_ingress" };
  if (input.egressId.trim() === "") return { ...empty, applicable: true, phase: "need_egress" };

  // 作用域不一致（切了 Workspace / 换了入口）⇒ 事实作废，如实说取不到。
  const factsUsable = input.facts !== null && input.facts.scopeKey === input.scopeKey;
  const facts = factsUsable ? input.facts : null;
  const inboundBindings = bindingsOf(facts, input.ingressId.trim());

  if (facts === null && !input.canManageNodes) {
    // 没有自动准备权限时，关系事实不可读就无法判断这条路径是否已经准备好。
    const selectedId = input.middleNodeId.trim();
    return {
      applicable: true,
      phase: "unavailable",
      candidates: [],
      excluded: [],
      selected:
        selectedId === ""
          ? null
          : classify({
              node: input.nodes.find((node) => String(node.id) === selectedId) ?? null,
              nodeId: selectedId,
              role: input.nodes.find((node) => String(node.id) === selectedId)?.role ?? null,
              inboundBound: null,
              outboundBound: null,
              ingressId: input.ingressId.trim(),
              egressId: input.egressId.trim(),
              canManageNodes: input.canManageNodes,
            }),
      submitBlockedReason: selectedId === "" ? null : "facts_unavailable",
    };
  }

  const egressId = input.egressId.trim();
  const ingressId = input.ingressId.trim();
  const rows = multihopUniverse({ nodes: input.nodes, inboundBindings }).map((node) =>
    classify({
      node,
      nodeId: String(node.id),
      role: node.role,
      inboundBound: hasEgressNode(inboundBindings, String(node.id)),
      outboundBound: hasEgressNode(bindingsOf(facts, String(node.id)), egressId),
      ingressId,
      egressId,
      canManageNodes: input.canManageNodes,
    }),
  );

  const selectedId = input.middleNodeId.trim();
  let selected: MultihopCandidate | null = rows.find((row) => row.nodeId === selectedId) ?? null;
  // 选中的 id 不在候选全集里（例如它既不是 role=both、也不在入口的第一段绑定里）：
  // 不能装作"没选"，也不能给它编一个"可选"的结论 —— 单列出来、说明取不到事实。
  if (selected === null && selectedId !== "") {
    selected = classify({
      node: input.nodes.find((node) => String(node.id) === selectedId) ?? null,
      nodeId: selectedId,
      role: input.nodes.find((node) => String(node.id) === selectedId)?.role ?? null,
      inboundBound: hasEgressNode(inboundBindings, selectedId),
      outboundBound: hasEgressNode(bindingsOf(facts, selectedId), egressId),
      ingressId,
      egressId,
      canManageNodes: input.canManageNodes,
    });
  }

  const submitBlockedReason: MultihopReasonCode | null =
    selectedId === ""
      ? null
      : selected === null
        ? "unknown_node"
        : selected.selectable
          ? null
          : selected.reason;

  return {
    applicable: true,
    phase: "ready",
    candidates: rows.filter((row) => row.selectable),
    excluded: rows.filter((row) => !row.selectable),
    selected,
    submitBlockedReason,
  };
}

/**
 * 中间跳事实的作用域键。
 *
 * 只跟 **workspace** 走（不像预览键那样还带 ingressId）：这份事实是"按来源节点分组的绑定"，
 * 换入口不影响它；换 Workspace 才使它整份失效 —— 旧空间的事实绝不能用来判定新空间的两段。
 */
export function forwardMultihopScopeKey(workspaceId: number | null): string {
  return `ws:${workspaceId ?? "?"}`;
}

export interface MultihopFactInput {
  workspaceId: number | null;
  nodes: readonly UserNode[];
  bindingsByIngress: Record<string, NodeBinding[]> | null;
  /** 事实不可信（读取失败 / 仍在读取 / 无读权限）⇒ 整份判成取不到。 */
  bindingsUnavailable: boolean;
}

/** 唯一的事实装配点：对话框（画）与载荷生成（提交）共用，避免两处各拼一份。 */
export function buildMultihopFacts(input: MultihopFactInput): MultihopFacts {
  return {
    scopeKey: forwardMultihopScopeKey(input.workspaceId),
    byIngress: input.bindingsUnavailable ? null : input.bindingsByIngress,
  };
}

/**
 * 创建请求里的多跳字段（**唯一的载荷生成点**）。
 *
 * fail-closed 的四条：不是 relay、没选、选的 id 非法、选中项此刻不可提交 ⇒ 一律返回 `{}`
 * （不发送一个会被服务端 409 的字段，也不在 DIRECT 上发送它——那会被静默落库且永不使用）。
 */
export function multihopCreateFields(
  mode: "direct" | "relay",
  middleNodeId: string,
  model: ForwardMultihopModel,
): { middle_node_id?: number } {
  if (mode !== "relay") return {};
  const raw = middleNodeId.trim();
  if (raw === "" || !/^\d+$/.test(raw)) return {};
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) return {};
  if (model.submitBlockedReason !== null) return {};
  if (model.selected === null || !model.selected.selectable) return {};
  return { middle_node_id: id };
}

export interface MultihopCreateInput extends MultihopFactInput {
  mode: "direct" | "relay";
  ingressId: string;
  egressId: string;
  middleNodeId: string;
  canManageNodes: boolean;
}

/**
 * 从**原始事实**直接算出创建请求里的多跳字段（调用点不必先自己建模型）。
 *
 * 这是给"载荷构造在别处"的调用点用的（`forward-workspace.tsx` 逐字段拼请求体），
 * 与对话框渲染用的是**同一套**输入与同一份判定 —— 不会出现"界面说可选、提交时被丢掉"。
 */
export function multihopCreateFieldsFor(input: MultihopCreateInput): { middle_node_id?: number } {
  const model = buildForwardMultihopModel({
    mode: input.mode,
    ingressId: input.ingressId,
    egressId: input.egressId,
    middleNodeId: input.middleNodeId,
    canManageNodes: input.canManageNodes,
    scopeKey: forwardMultihopScopeKey(input.workspaceId),
    facts: buildMultihopFacts(input),
    nodes: input.nodes,
  });
  return multihopCreateFields(input.mode, input.middleNodeId, model);
}

/** 提交前必须补齐的那一段（给"去绑定"的下一步用）；不适用/未知时为 `null`。 */
export function multihopMissingSegment(
  candidate: MultihopCandidate | null,
): { segment: "ingress_to_middle" | "middle_to_egress"; creatable: boolean } | null {
  if (candidate === null) return null;
  if (candidate.inboundBound === false) {
    return { segment: "ingress_to_middle", creatable: candidate.canCreateInbound };
  }
  if (candidate.outboundBound === false) {
    return { segment: "middle_to_egress", creatable: candidate.canCreateOutbound };
  }
  return null;
}

/* ================================================================== */
/* 失败码 → 人话 + 下一步                                               */
/* ================================================================== */

export interface MultihopFailureInfo {
  code: string | null;
  /** 服务端原句（**永远**照实带上，不替换、不加工）。 */
  message: string;
  title: string;
  /** 可执行的下一步；没有可信建议时为 `null`（不编）。 */
  next: string | null;
  retryable: boolean;
}

interface FailureCopy {
  bindingRequiredTitle: string;
  bindingRequiredNext: string;
  pathPermissionTitle: string;
  pathPermissionNext: string;
  conflictTitle: string;
  conflictNext: string;
  portConflictTitle: string;
  portConflictNext: string;
  notFoundTitle: string;
  notFoundNext: string;
  invalidTitle: string;
  invalidNext: string;
  transientTitle: string;
  transientNext: string;
}

const FAILURE_ZH: FailureCopy = {
  bindingRequiredTitle: "路径关系尚未准备好",
  bindingRequiredNext: "刷新后重试；如果仍然失败，请检查节点路径关系与权限。",
  pathPermissionTitle: "自动准备路径需要节点管理权限",
  pathPermissionNext: "请选择已经准备好的路径，或联系有节点管理权限的成员完成创建。",
  conflictTitle: "节点角色或组合不被接受",
  conflictNext:
    "检查三台节点的角色：中间跳必须同时能当第一段的出口与第二段的入口（role = both），且入口/中间/出口不能是同一台。",
  portConflictTitle: "入口端口已被占用",
  portConflictNext: "换一个监听端口，或先处理占用它的那条转发。",
  notFoundTitle: "节点或转发不存在",
  notFoundNext: "刷新节点列表后重新选择入口/中间/出口。",
  invalidTitle: "参数不合法",
  invalidNext: "按提示修正后重试。",
  transientTitle: "服务端暂时不可用",
  transientNext: "这是可重试的失败：稍后再提交一次。",
};

const FAILURE_EN: FailureCopy = {
  bindingRequiredTitle: "Path relationships are not ready",
  bindingRequiredNext: "Reload and retry. If it still fails, check the node path relationships and permissions.",
  pathPermissionTitle: "Automatic path setup needs node-management permission",
  pathPermissionNext: "Choose a path that is already prepared, or ask a member with node-management permission to create it.",
  conflictTitle: "Node roles or the chosen combination are not accepted",
  conflictNext:
    "Check the three nodes' roles: the middle hop must be able to act as the egress of segment one and the ingress of segment two (role = both), and ingress/middle/egress must not be the same node.",
  portConflictTitle: "The ingress port is already in use",
  portConflictNext: "Pick another listen port, or deal with the forward that occupies it.",
  notFoundTitle: "Node or forward not found",
  notFoundNext: "Reload the node list and pick ingress/middle/egress again.",
  invalidTitle: "Invalid input",
  invalidNext: "Fix the highlighted values and retry.",
  transientTitle: "The server is temporarily unavailable",
  transientNext: "This failure is retryable: submit again shortly.",
};

/** 大小写不敏感地取错误码（真实后端是小写 `binding_required`，mock 既有大写风格）。 */
function normalizeCode(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim().toLowerCase() : null;
}

/**
 * 创建失败 → 人话。**只**按服务端给的 `code`（+ admission 的 `data.condition`）分支，
 * 未知码原样回落后端 message，绝不编一个更具体的理由。
 */
export function multihopFailureInfo(locale: Locale, error: unknown): MultihopFailureInfo {
  const copy = locale === "en" ? FAILURE_EN : FAILURE_ZH;
  const payload = (error as { data?: unknown } | null)?.data;
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const code = normalizeCode(data?.code);
  const status = typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : null;
  const message =
    typeof (error as { message?: unknown } | null)?.message === "string" && (error as { message: string }).message.trim() !== ""
      ? (error as { message: string }).message
      : "";

  if (code === "binding_required") {
    return { code, message, title: copy.bindingRequiredTitle, next: copy.bindingRequiredNext, retryable: false };
  }
  if (code === "path_setup_permission_required") {
    return { code, message, title: copy.pathPermissionTitle, next: copy.pathPermissionNext, retryable: false };
  }
  if (code === "conflict") {
    // admission 拒绝（maintenance/disabled/retiring/waiting_install…）也走 `conflict`，
    // 只有 `data.condition` 才能定位。复用既有的条件码词条（`node-lifecycle-i18n`），
    // 未知码回落到"角色/组合"那句 —— 不自己再写一张会漂移的表。
    const condition = typeof data?.condition === "string" ? data.condition : null;
    return {
      code,
      message,
      title: conditionTitle(locale, condition, copy.conflictTitle),
      next: copy.conflictNext,
      retryable: false,
    };
  }
  if (code === "port_conflict") {
    return { code, message, title: copy.portConflictTitle, next: copy.portConflictNext, retryable: false };
  }
  if (code === "not_found") {
    return { code, message, title: copy.notFoundTitle, next: copy.notFoundNext, retryable: false };
  }
  if (code === "invalid_input") {
    return { code, message, title: copy.invalidTitle, next: copy.invalidNext, retryable: false };
  }
  if (code === "db_unavailable" || status === null || (status !== null && status >= 500)) {
    return { code, message, title: copy.transientTitle, next: copy.transientNext, retryable: true };
  }
  return { code, message, title: message === "" ? copy.invalidTitle : message, next: null, retryable: false };
}
