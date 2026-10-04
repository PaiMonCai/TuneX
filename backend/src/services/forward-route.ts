/**
 * V5.4 WP11/WP12 —— 线性路由（RoutePlan）的**纯**模型。
 *
 * 契约冻结在 `DEVELOPMENT.md` §9 的「V5.4 冻结契约」。这里只做三件事，且都是纯函数：
 *   1. 把一跳 / 两跳 / 三跳的放置事实整理成**有序路由**（hop 0 … hop N-1）；
 *   2. 校验路由合法性（线性、上限、相邻绑定、归属唯一）；
 *   3. 给出每一跳该做什么（面向客户端 / 中转 / 拨号到目标），供下发方按序执行。
 *
 * 刻意不做的事：
 *   · 不产生任何下发命令（那属于编排器，且必须是既有原语的**组合**）；
 *   · 不碰数据库（相邻绑定由调用方作为事实传入）；
 *   · 不允许分支/环/动态寻路（§9.3 的禁止项在这里是**类型与校验**上的禁止，不是注释里的禁止）。
 */

/** 一跳在路由里的角色。 */
export type RouteHopRole = "ingress" | "middle" | "egress";

export interface RouteHop {
  /** 0 起的位置 —— **身份是位置，不是节点**（§9 冻结契约第 1 条）。 */
  readonly hop_index: number;
  readonly role: RouteHopRole;
  readonly node_id: number;
}

export interface RoutePlan {
  /** 有序 hop 列表，`hop_index` 严格递增且从 0 起。 */
  readonly hops: readonly RouteHop[];
  /** 面向客户端的那一跳（唯一归属持有者）。 */
  readonly ingress_node_id: number;
  /** 拨号到目标的那一跳。 */
  readonly egress_node_id: number;
  /** 中间跳（单跳时为 null）。 */
  readonly middle_node_id: number | null;
  /**
   * **整条路由只有一个 revision**（§9 冻结契约第 6 条）。
   * 不提供 per-hop revision：那会允许"部分链路的版本互不匹配"的活配置。
   */
  readonly revision: number;
}

export interface RoutePlacement {
  readonly ingress_node_id: number | null;
  readonly egress_node_id: number | null;
  readonly middle_node_id: number | null;
  readonly tunnel_mode: "direct" | "relay";
  readonly revision: number;
}

/** §9.3：第一版上限 3 跳，`hop_index` 最大 2。 */
export const MAX_ROUTE_HOPS = 3;

export type RouteViolation =
  | "missing_ingress"
  | "missing_egress"
  | "too_many_hops"
  | "middle_on_single_hop"
  | "middle_equals_ingress"
  | "middle_equals_egress"
  | "unknown_topology";

/**
 * 把放置事实整理成有序路由；非法组合返回 null（**调用方必须 fail-closed**，不要自己猜）。
 *
 * 单跳：`direct` 且没有中间跳 ⇒ [ingress, egress]（DIRECT 下两者相同，见下方说明）。
 * 两跳：`direct` + 中间跳 ⇒ [ingress, middle, egress]。
 * RELAY：入口与出口固定为两端，中间跳可选（RELAY 的"出口"就是拨号到目标的那一跳）。
 *
 * DIRECT 的 `egress_node_id`：V4 里 DIRECT 没有出口节点（目标是直连的），因此此时
 * hop N-1 **就是 ingress 自己**（它同时是客户端面与目标面）。这与 `dispatchDirect` 的现状一致，
 * 而把它建模成"两个角色同一个节点"而不是"两个 hop"，正是为了让单跳路由**恰好两跳**：
 * hop 0 面向客户端、hop 1 拨号到目标 —— 同一台机器上的两件事，中间跳因此才有位置。
 */
export function buildRoutePlan(placement: RoutePlacement): RoutePlan | null {
  const { ingress_node_id: ingress, egress_node_id: egress, middle_node_id: middle } = placement;
  if (ingress === null || ingress <= 0) return null;

  if (placement.tunnel_mode === "direct") {
    // 目标面与客户端面在同一台节点上（V4 行为）。
    const targetNode = egress === null ? ingress : egress;
    if (middle === null) {
      return {
        hops: [
          { hop_index: 0, role: "ingress", node_id: ingress },
          { hop_index: 1, role: "egress", node_id: targetNode },
        ],
        ingress_node_id: ingress,
        egress_node_id: targetNode,
        middle_node_id: null,
        revision: placement.revision,
      };
    }
    if (middle === ingress || middle === targetNode) return null;
    return {
      hops: [
        { hop_index: 0, role: "ingress", node_id: ingress },
        { hop_index: 1, role: "middle", node_id: middle },
        { hop_index: 2, role: "egress", node_id: targetNode },
      ],
      ingress_node_id: ingress,
      egress_node_id: targetNode,
      middle_node_id: middle,
      revision: placement.revision,
    };
  }

  // RELAY：两头都是显式的，缺一不可。
  if (egress === null || egress <= 0) {
    return middle === null
      ? null
      : null; // RELAY 缺出口是非法配置，而不是"退化成单跳"
  }
  if (middle === null) {
    return {
      hops: [
        { hop_index: 0, role: "ingress", node_id: ingress },
        { hop_index: 1, role: "egress", node_id: egress },
      ],
      ingress_node_id: ingress,
      egress_node_id: egress,
      middle_node_id: null,
      revision: placement.revision,
    };
  }
  if (middle === ingress || middle === egress) return null;
  return {
    hops: [
      { hop_index: 0, role: "ingress", node_id: ingress },
      { hop_index: 1, role: "middle", node_id: middle },
      { hop_index: 2, role: "egress", node_id: egress },
    ],
    ingress_node_id: ingress,
    egress_node_id: egress,
    middle_node_id: middle,
    revision: placement.revision,
  };
}

/**
 * 路由的合法性校验（独立于 buildRoutePlan，因为它还检查**外部事实**：相邻绑定）。
 *
 * `boundPairs` 是已存在的 NodeBinding 集合（`"a->b"` 形式），由调用方作为事实传入 ——
 * 本函数不读库，但也不放松：**相邻两跳之间必须有绑定**（§9 冻结契约第 3 条），
 * 否则路由在多跳上就是"没有许可的链路"。
 */
export function routeViolations(
  plan: RoutePlan,
  boundPairs: ReadonlySet<string>,
): RouteViolation[] {
  const out: RouteViolation[] = [];
  if (plan.hops.length > MAX_ROUTE_HOPS) out.push("too_many_hops");
  if (plan.hops.length < 2) out.push("unknown_topology");

  // hop_index 必须严格递增且从 0 起 —— 这是"有序"的全部含义。
  for (let i = 0; i < plan.hops.length; i += 1) {
    if (plan.hops[i]?.hop_index !== i) out.push("unknown_topology");
  }

  // 注意：**同一台节点可以同时持有相邻两个角色**，这不是错误 —— DIRECT 就是这样
  // （hop 0 面向客户端、hop 1 拨号到目标，同一台机器）。第一版这里有一条 `duplicate_node`
  // 检查，它唯一会命中的场景恰恰是这个合法场景，于是把"DIRECT 的单跳"判成非法。
  // 真正需要禁止的是"同一个节点同时当中间跳和一个端点"，那由下面两条专门检查覆盖。

  if (plan.middle_node_id === plan.ingress_node_id) out.push("middle_equals_ingress");
  if (plan.middle_node_id === plan.egress_node_id) out.push("middle_equals_egress");

  // 相邻跳必须有绑定（同一节点上的"两端"不需要绑定：那是同一台机器）。
  for (let i = 0; i + 1 < plan.hops.length; i += 1) {
    const a = plan.hops[i]!;
    const b = plan.hops[i + 1]!;
    if (a.node_id === b.node_id) continue;
    if (!boundPairs.has(`${a.node_id}->${b.node_id}`)) out.push("unknown_topology");
  }
  return out;
}

/**
 * 每一跳要做的事（供下发方**按序**执行）。
 *
 * 顺序不是风格问题：§1 的铁律是"先远后近"（出口先起、ACK 之后再切入口），在 N 跳上推广为
 * **正向从最远的一跳开始，逆向从最近的一跳开始**。这里给出正向顺序，补偿由调用方 reverse()。
 */
export interface RouteStep {
  readonly hop_index: number;
  readonly node_id: number;
  readonly action: "apply_client_front" | "apply_transit" | "apply_target_dial";
}

export function routeSteps(plan: RoutePlan): RouteStep[] {
  const out: RouteStep[] = [];
  const last = plan.hops.length - 1;
  for (const hop of plan.hops) {
    const action =
      hop.hop_index === 0
        ? "apply_client_front"
        : hop.hop_index === last
          ? "apply_target_dial"
          : "apply_transit";
    out.push({ hop_index: hop.hop_index, node_id: hop.node_id, action });
  }
  // 正向先远后近：最远的一跳先起，客户端面前最后。
  return [...out].reverse();
}

/** 补偿顺序：正向的反序（先近后远）。 */
export function compensationSteps(plan: RoutePlan): RouteStep[] {
  return [...routeSteps(plan)].reverse();
}

/**
 * 错误归属：任何一跳的下发/ACK 错误都必须带上 `hop_index`。
 *
 * 三跳下没有它，运维只能知道"这条转发失败了"，不能知道**哪一跳**失败了 —— 而 G4 明确要求
 * "遥测能定位失败跳"。
 */
export function attributeFailure(
  plan: RoutePlan,
  failedNodeId: number,
): { hop_index: number; node_id: number } | null {
  const hop = plan.hops.find((h) => h.node_id === failedNodeId);
  return hop ? { hop_index: hop.hop_index, node_id: hop.node_id } : null;
}

/* ================================================================== */
/* 下发前的路由准入（fail-closed）                                      */
/* ================================================================== */

export type RouteAdmission =
  | { ok: true; plan: RoutePlan; hop_indices: readonly number[] }
  | { ok: false; code: "route_invalid" | "route_not_dispatchable"; error: string; violation?: RouteViolation };

/**
 * 下发前判定这条路由**能不能**按当前实现发出去。
 *
 * 为什么必须在这里拒绝而不是"先按单跳发出去"：`middle_node_id` 非空意味着用户要的是三跳。
 * 如果实现只发单跳形状，转发**会正常工作，但走的是另一条路** —— 没有任何错误、没有告警，
 * 只有拓扑与用户配置不一致。这类"静默地做了别的事"是本项目最贵的一类缺陷，因此这里
 * **fail-closed**：未实现的多跳一律拒绝，并且错误里点名"哪一跳"和"哪个约束"。
 *
 * `boundPairs` 由调用方作为事实传入（相邻跳必须有 NodeBinding）；本函数不读库。
 */
export function admitRoute(
  placement: RoutePlacement,
  boundPairs: ReadonlySet<string>,
  opts: { multiHopImplemented?: boolean } = {},
): RouteAdmission {
  const plan = buildRoutePlan(placement);
  if (plan === null) {
    return { ok: false, code: "route_invalid", error: "路由放置事实不完整或自相矛盾（缺入口/出口，或中间跳与端点重合）" };
  }
  const violations = routeViolations(plan, boundPairs);
  if (violations.length > 0) {
    return {
      ok: false,
      code: "route_invalid",
      error: `路由校验未通过：${[...new Set(violations)].join(", ")}`,
      violation: violations[0],
    };
  }
  // 三跳 = 存在中间跳。除非调用方明确声明多跳下发已实现，否则拒绝。
  if (plan.middle_node_id !== null && opts.multiHopImplemented !== true) {
    return {
      ok: false,
      code: "route_not_dispatchable",
      error:
        `该转发配置了中间跳（hop 1 = 节点 ${plan.middle_node_id}，共 ${plan.hops.length} 跳），` +
        "但多跳下发尚未实现（WP12）。拒绝下发以避免静默地按单跳工作",
    };
  }
  return { ok: true, plan, hop_indices: plan.hops.map((h) => h.hop_index) };
}
