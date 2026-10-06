/**
 * Forward 高可用（多入口 / 首选入口）**读投影 + 首选入口写入**的用户域客户端。
 *
 * 为什么单独一个模块而不是塞进 `lib/api/forwards.ts`：那份文件同时被别的切片占用
 * （写冲突），而且这里的形状是一条**独立契约**——它回答的是"这条转发的自动迁移事实
 * 是什么"，与列表/详情/延迟各自的形状无关。放在独立模块里，改这条契约不会碰到
 * forward 列表的类型。
 *
 * ── 这份契约里必须**分开**的四类事实（混起来就会说错话）──
 *
 *   1. `preferred_ingress_node_id` = **期望**（调度意图）。它**不代表**这台机器在线、
 *      能接业务、或者面板指挥得动 —— 写入路径刻意允许把当前离线/维护中的节点设为首选
 *      （`backend/src/services/preferred-ingress.ts` 的注释写着理由：偏好表达的是
 *      "它回来后优先归它"）。界面不得把它渲染成"已在接管"；
 *   2. `active_ingress_node_id` = **事实**（现在归谁）；
 *   3. `policy.auto_failover` / `policy.auto_failback` = **平台策略真值**（只读）。
 *      **缺省即关**：没配置过就是两个 `false`。`false` 的唯一正确呈现是
 *      「平台未启用自动迁移」，**不是**"已启用/已保护"；
 *   4. `failover_candidate.status` 三态：`available`（有一台**此刻**合格、能接管的组内
 *      入口）/ `none`（确实没有合格候选）/ `unavailable`（这次读不到）。
 *      `unavailable` **不得**被渲染成"没有高可用"——那是把"我不知道"说成了结论。
 *
 * `preference_options.nodes[].connection` / `accepts_new_business` 是**并列的事实**
 * （连接 / 准入），`can_be_preferred` 才是"能不能设为首选"（只由写入路径的两条规则决定：
 * 同入口组 + `role ∈ {ingress, both}`）。四者不可互相替代：一台维护中的节点
 * `connection=online`、`accepts_new_business=false`、却仍然 `can_be_preferred=true`。
 */
import { get, put } from "./core";
import type { ID } from "../types";

/** 平台自动迁移策略（**只读**；缺省即关）。 */
export interface ForwardHaPolicy {
  auto_failover: boolean;
  auto_failback: boolean;
  /**
   * 配置行存在但无法解析时的信息（fail-closed 会当成两个都关，但那是"配置坏了"，
   * 不是"运维没开"——两者的下一步动作不同）。正常为 `null`。
   */
  parse_error: string | null;
}

/** 自动迁移的候选入口（与后端 failover 循环**同一份判定**）。 */
export interface ForwardHaCandidate {
  status: "available" | "none" | "unavailable";
  /** 仅 `available` 时给出节点 id。 */
  node_id: number | null;
  /** 仅 `unavailable` 时给出稳定原因码（例如 `candidate_query_failed`）。 */
  reason: string | null;
}

/**
 * 入口成员（行为参照 ForwardX 转发组的"成员即优先级"）：身份 + 并列事实 + 三个**不同**的
 * 判定结果 —— 能不能当首选（写入路径规则）/ 此刻能不能接管（failover 判定）/ 平台给的接管次序。
 */
export interface ForwardHaOptionNode {
  node_id: number;
  name: string;
  role: string | null;
  node_group_id: number;
  /** 事实：现在归属它。 */
  is_active_ingress: boolean;
  /** 期望：它被设为首选。 */
  is_preferred: boolean;
  /** 写入路径规则（同入口组 + role∈{ingress,both}）⇒ 能不能设为首选。 */
  can_be_preferred: boolean;
  /** `can_be_preferred=false` 时的原因码（`role_undeclared` / `role_mismatch`）。 */
  preference_rejection: string | null;
  /** 事实：面板此刻能否与它通信（waiting | online | offline）。 */
  connection: string;
  /** 期望：生命周期（active | maintenance | disabled | retiring）。 */
  lifecycle: string;
  /** 准入结论：它能不能接新业务。 */
  accepts_new_business: boolean;
  /** `accepts_new_business=false` 时的原因码。 */
  admission_rejection: string | null;
  /** 它此刻是不是平台的**回切目标**（偏好 ≠ 现任时才成立，与 failover 同口径）。 */
  is_failback_target: boolean;
  /** 此刻能不能接管这条转发（非现任 + 准入 + 角色 + 凭据 + 在线，与 failover 同一份判定）。 */
  can_take_over: boolean;
  /** `can_take_over=false` 时的**第一个**不满足条件的原因码。 */
  takeover_rejection: string | null;
  /** 平台当前的接管次序（1 起）；不能接管时为 `null`。顺序来源见 `member_priority`。 */
  failover_rank: number | null;
}

/** 「恢复后切回」的真值与进度（阈值来自后端 `failover-thresholds.ts` 的单一数值来源）。 */
export interface ForwardHaFailback {
  /** 平台开关真值（与 `policy.auto_failback` 同源；这里重复一次是为了让"回切"可独立消费）。 */
  auto_failback: boolean;
  /** 偏好 ≠ 现任时，平台此刻会把它当回切目标；否则 `null`。 */
  target_node_id: number | null;
  preferred_ingress_node_id: number | null;
  progress: {
    /** `tunnel.failback_healthy_checks`：首选节点连续判定健康的次数（跨节拍的事实）。 */
    healthy_checks: number;
    /** 策略要求的连续次数。 */
    required_checks: number;
    met: boolean;
  };
}

export interface ForwardHaProjection {
  forward_id: number;
  /** 期望（调度意图）；`null` = 没有偏好。 */
  preferred_ingress_node_id: number | null;
  /** 事实（现在归谁）。 */
  active_ingress_node_id: number | null;
  policy: ForwardHaPolicy;
  failover_candidate: ForwardHaCandidate;
  /**
   * 入口成员的**有序**视图。三个必须分得开的态：
   *   · `status: "unavailable"` ⇒ 这次**读不到**成员列表（不是"没有成员"）；
   *   · `status: "ok"` + `nodes: []` ⇒ 组里**确实没有成员**；
   *   · `nodes` 非空但没有任何 `can_take_over` ⇒ 有成员，但此刻**没有能接管的**。
   */
  ingress_members:
    | { status: "ok"; nodes: ForwardHaOptionNode[] }
    | { status: "unavailable"; nodes: [] };
  /** 成员顺序的来源与能力：当前是平台固定规则，按转发自定义顺序**不支持**。 */
  member_priority: {
    source: "platform_rule_node_id_asc";
    custom_order_supported: boolean;
  };
  failback: ForwardHaFailback;
}

/** `PUT /forwards/:id/preferred-ingress` 的成功形状。 */
export interface PreferredIngressResult {
  tunnel_id: number;
  preferred_ingress_node_id: number | null;
}

/** 观察连接/准入事实的节拍：与 Agent 上报节拍同源（30s），更快只会重复读同一份事实。 */
export const FORWARD_HA_POLL_MS = 30_000;

/** `GET /api/forwards/:id/ha`（用户域；`forward:read`）。 */
export function getForwardHa(forwardId: ID): Promise<ForwardHaProjection> {
  return get<ForwardHaProjection>(`/forwards/${forwardId}/ha`);
}

/**
 * `PUT /api/forwards/:id/preferred-ingress`（**既有**端点；`forward:update`）。
 *
 * `nodeId === null` = 清除偏好。它**不**触发 rollout、不 bump revision —— 偏好是调度意图，
 * 什么时候真的回切由平台策略在后续节拍里判。
 */
export function setForwardPreferredIngress(
  forwardId: ID,
  nodeId: number | null,
): Promise<PreferredIngressResult> {
  return put<PreferredIngressResult>(`/forwards/${forwardId}/preferred-ingress`, { node_id: nodeId });
}

/** 界面侧的错误形状（后端 `code` + 原文 + `error_layer`）。 */
export interface ForwardHaErrorInfo {
  code: string | null;
  message: string;
  layer: string | null;
}

export function forwardHaErrorInfo(error: unknown): ForwardHaErrorInfo {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const code = typeof record?.code === "string" ? record.code : null;
  const layer = typeof record?.error_layer === "string" ? record.error_layer : null;
  return {
    code,
    message:
      error instanceof Error && error.message.trim() !== ""
        ? error.message
        : "高可用接口没有返回可用的错误信息",
    layer,
  };
}

/**
 * 写入失败时后端给的原因码（`backend/src/services/preferred-ingress.ts` 的
 * `PREFERRED_INGRESS_ERROR_CODES`，词表同源，不在前端另造一套）。
 */
export const PREFERRED_INGRESS_ERROR_CODES = {
  preferred_not_found: "preferred_not_found",
  preferred_node_group_mismatch: "preferred_node_group_mismatch",
  preferred_role_mismatch: "preferred_role_mismatch",
  preferred_unavailable: "preferred_unavailable",
} as const;
