/**
 * **首选入口节点**的写入路径。
 *
 * 为什么它必须存在：`failover-policy` 早就支持 `failback` 路径，但 `pickFailoverDestination`
 * 恒返回 `preferred_node_id = null` ⇒ **自动回切今天永不发生**。这是"写了功能但没有任何写入
 * 路径"的一类缺陷（与 WP19 的 `diag` 白名单陷阱同源）：策略、执行器、阈值全都在，只差
 * 一个能把意图存下来的地方。契约把它判为既有缺陷并要求收口。
 *
 * ── 为什么是独立端点，而不是 `PATCH /api/forwards/:id` 的一个字段 ──
 *
 * `PATCH` 的语义是"编辑运行态字段"：它会走 `resolveForwardCandidate` → 生成新 revision →
 * 触发 rollout。把偏好塞进去会有两个后果，而且都是错的：
 *
 *   ① 改一个**偏好**会重启转发（换端口、断连接）——偏好本意是"下次迁移时优先它"；
 *   ② 更糟的是它可能**立刻把归属搬到首选节点**，绕过 `FAILBACK_HEALTHY_CHECKS` 与冷却期
 *      ——那正是策略存在的意义。
 *
 * 所以偏好是一条**调度意图**，不是运行态事实：写它不 bump revision、不触发 rollout，
 * 由 failover sweep 在后续节拍里按策略决定要不要真的回切（那才是一次正常的 epoch+1 迁移）。
 *
 * ── 多入口成员视图（task-38）──
 * 行为参照：ForwardX（AGPL-3.0-only）——多入口/转发组的「成员顺序即优先级、当前入口失效时
 * 切到下一个可用成员、恢复后可按开关切回」；**代码为本项目改写，未复制其实现**。
 * 我们的落点不同：成员集合 = 这条转发的**入口节点组**（既有真相，不是新表）；顺序 =
 * 平台既有的确定性规则（非现任候选按 node id 升序，与 `pickFailoverDestination` 同源）。
 */
import { Prisma } from "@prisma/client";
import { candidateRejection, roleAcceptsPosition, type CandidateFacts } from "./ingress-candidate.ts";
import { projectUserNode } from "./node-view.ts";

export const PREFERRED_INGRESS_ERROR_CODES = {
  preferred_not_found: "preferred_not_found",
  /** 目标节点不在该转发的入口节点组里 —— 偏好一个组外的节点没有任何意义。 */
  preferred_node_group_mismatch: "preferred_node_group_mismatch",
  /** 目标节点角色不能当入口（`role` 为 egress/null）。 */
  preferred_role_mismatch: "preferred_role_mismatch",
  preferred_unavailable: "preferred_unavailable",
} as const;

export type PreferredIngressErrorCode =
  (typeof PREFERRED_INGRESS_ERROR_CODES)[keyof typeof PREFERRED_INGRESS_ERROR_CODES];

/**
 * 依赖缝隙。参数用**真实 Prisma 参数类型**：`has_credential` 不是 `Node` 的列（它是
 * `node_credential_hash != null` 的派生事实），而这个缝隙原本写成 `unknown` ⇒ 把 Prisma 的
 * 字段校验关掉了，于是那次写错在**编译期与单测里都通过**，直到真拓扑里 500 才暴露。
 */
export interface PreferredIngressDb {
  tunnel: { findFirst: (args: Prisma.TunnelFindFirstArgs) => Promise<unknown>; update: (args: Prisma.TunnelUpdateArgs) => Promise<unknown> };
  node: { findUnique: (args: Prisma.NodeFindUniqueArgs) => Promise<unknown> };
}

export interface PreferredIngressDeps {
  db: PreferredIngressDb;
  now?: () => Date;
}

export type PreferredIngressResult =
  | { ok: true; value: { tunnel_id: number; preferred_ingress_node_id: number | null } }
  | { ok: false; code: PreferredIngressErrorCode; error: string };

interface TunnelRow {
  id: number;
  in_node_group_id: number;
  ingress_node_id: number | null;
  preferred_ingress_node_id: number | null;
}

interface NodeRow extends CandidateFacts {
  id: number;
}

/**
 * 设置（或清除）首选入口。`nodeId === null` = 清除偏好（回到今天"不回切"的行为）。
 *
 * **允许把当前离线的节点设为首选**：偏好表达的是"这台机器回来后优先归它"，而不是"它此刻必须
 * 在线"。真正的健康门槛由策略在每一拍判定（`FAILBACK_HEALTHY_CHECKS` + 冷却），所以这里
 * 拦在线状态只会让运维在节点维护时无法预先表达意图。
 */
export async function setPreferredIngressNode(
  deps: PreferredIngressDeps,
  input: { workspaceId: number; tunnelId: number; nodeId: number | null },
): Promise<PreferredIngressResult> {
  const tunnel = (await deps.db.tunnel.findFirst({
    where: { id: input.tunnelId, workspace_id: input.workspaceId, category: "port_forward" },
    select: { id: true, in_node_group_id: true, ingress_node_id: true, preferred_ingress_node_id: true },
  })) as TunnelRow | null;
  if (!tunnel) return { ok: false, code: PREFERRED_INGRESS_ERROR_CODES.preferred_not_found, error: "端口转发不存在" };

  if (input.nodeId !== null) {
    const node = (await deps.db.node.findUnique({
      where: { id: input.nodeId },
      select: {
        id: true,
        node_group_id: true,
        role: true,
        lifecycle: true,
        status: true,
        last_seen_at: true,
        // 见上：`has_credential` 是派生事实，不是列。
        node_credential_hash: true,
        credential_revoked: true,
      },
    })) as (NodeRow & { node_credential_hash?: string | null }) | null;
    if (!node) {
      return { ok: false, code: PREFERRED_INGRESS_ERROR_CODES.preferred_not_found, error: "节点不存在" };
    }
    if (node.node_group_id !== tunnel.in_node_group_id) {
      return {
        ok: false,
        code: PREFERRED_INGRESS_ERROR_CODES.preferred_node_group_mismatch,
        error: "首选节点必须属于该转发的入口节点组",
      };
    }
    // 角色判定与准入**同一份实现**（`ingress-candidate.ts`）：偏好一台当不了入口的机器，
    // 结果是每一拍都算出一个永远不满足的回切条件。
    if (!roleAcceptsPosition(node.role ?? null, "ingress")) {
      return {
        ok: false,
        code: PREFERRED_INGRESS_ERROR_CODES.preferred_role_mismatch,
        error: "该节点的角色不能作为入口（需要 ingress 或 both）",
      };
    }
  }

  await deps.db.tunnel.update({
    where: { id: tunnel.id },
    data: {
      preferred_ingress_node_id: input.nodeId,
      // 换了偏好就**重新计数**：否则旧偏好攒下的"连续健康 N 次"会被算到新节点头上，
      // 一次刚设好的回切可能立刻满足阈值 —— 那等于绕过了这条门槛要防的事。
      failback_healthy_checks: 0,
    },
  });

  return { ok: true, value: { tunnel_id: tunnel.id, preferred_ingress_node_id: input.nodeId } };
}

/** 读当前偏好（供列表/详情与排障用；没有单独存储时的默认是 null = 不回切）。 */
export function preferredIngressOf(row: { preferred_ingress_node_id?: unknown }): number | null {
  return typeof row.preferred_ingress_node_id === "number" ? row.preferred_ingress_node_id : null;
}

/* ================================================================== */
/* 入口成员视图（有序）                                                 */
/* ================================================================== */
//
// 行为参照（ForwardX, AGPL-3.0-only）：转发组的成员列表「顺序即优先级，排最前者为首选
// 入口」；当前入口失效并持续达到故障窗口后，切到**下一个可用成员**；「恢复后切回」开关决定
// 高优先级成员回来之后要不要切回。**代码为本项目改写，未复制其实现。**
//
// 我们只借这三条**产品行为**，不借它的资源/存储模型（那是第二套归属真相）：
//   · 成员集合 —— 「这条转发的入口节点组里的节点」是既有真相（`tunnel.in_node_group_id`），
//     不新增成员表；组里没有节点就是「没有成员」这个可区分的态；
//   · 顺序 —— 现在由平台既有规则决定（`pickFailoverDestination` 对合格候选显式按
//     `node_id` 升序取第一台），所以这里把同一顺序算成 `failover_rank` 如实展示；
//     **不假装**用户可以自由排序：按转发自定义顺序需要一份"按转发的"存储，而节点组是
//     多条转发共享的资源，把顺序塞进节点列会让别的转发一起变形（见 task-38 报告）。
//   · 「可用」≠「在线」—— 沿用 `candidateRejection`（准入 → 生命周期 → 角色 → 凭据 → 在线）
//     与 `deriveConnection` 的既有判定：一台 `connection=online` 但 `lifecycle=maintenance`
//     的机器「在线」但**不能接新业务**，这两个事实在响应里分开。

/** 成员行所需的事实列（不含任何凭据材料，`node_credential_hash` 只用于派生布尔）。 */
export interface IngressMemberRow {
  id: number;
  node_id: string;
  role: string | null;
  status: string | null;
  lifecycle?: string | null;
  last_seen_at: Date | null;
  node_group_id: number;
  node_credential_hash?: string | null;
  credential_revoked?: boolean;
}

/** 一个入口成员：身份 + 期望/事实 + 「能不能当首选」+「此刻能不能接管」。 */
export interface IngressMemberView {
  node_id: number;
  /** 用户可读的节点名（`Node.node_id` 列）。 */
  name: string;
  role: string | null;
  node_group_id: number;
  /** 事实：现在归它。 */
  is_active_ingress: boolean;
  /** 期望：它被设为首选入口。 */
  is_preferred: boolean;
  /** 它此刻是平台的**回切目标**（偏好 ≠ 现任时才成立，与 failover 同口径）。 */
  is_failback_target: boolean;
  /** 写入路径规则（同入口组 + role∈{ingress,both}）⇒ 能不能设为首选。 */
  can_be_preferred: boolean;
  preference_rejection: string | null;
  /** 事实：连接（`deriveConnection`：waiting | online | offline）。 */
  connection: string;
  /** 期望：生命周期（`nodeAdmission` 的输入）。 */
  lifecycle: string;
  /** 准入结论：能不能接新业务（与用户节点列表同一份投影）。 */
  accepts_new_business: boolean;
  admission_rejection: string | null;
  /**
   * 此刻能不能**接管**这条转发（与 failover 候选同一份判定：非现任 + 准入 + 角色 +
   * 凭据 + 在线）。`false` 时 {@link takeover_rejection} 给出**第一个**不满足的条件码。
   */
  can_take_over: boolean;
  /** `can_take_over=false` 时**第一个**不满足的条件码；现任为 `current_owner`。 */
  takeover_rejection: string | null;
  /**
   * 平台当前的接管次序（1 起）；不能接管的成员为 `null`。
   * 与 `pickFailoverDestination` 同源：合格候选按 `node_id` 升序取第一台。
   */
  failover_rank: number | null;
}

/**
 * 把入口组的节点行投影成**有序**成员视图。纯函数：无 IO、无时钟，`now` 必须显式传入
 * （在线判定不注入时钟会让结论随墙上时钟漂移 —— 本仓已为这类夹具腐化付过学费）。
 *
 * 顺序 = `node_id` 升序（平台现有规则，也是 `pickFailoverDestination` 的显式排序），
 * 因此 `failover_rank === 1` 的那台就是"现任失联时会被选中的那台"。
 */
export function buildIngressMemberViews(
  rows: readonly IngressMemberRow[],
  input: { activeIngressId: number | null; preferredId: number | null; now: Date },
): IngressMemberView[] {
  const ordered = [...rows].sort((a, b) => a.id - b.id);
  const views: IngressMemberView[] = [];
  let rank = 0;
  for (const row of ordered) {
    const facts: CandidateFacts = {
      node_id: row.id,
      node_group_id: row.node_group_id,
      role: row.role ?? null,
      lifecycle: row.lifecycle ?? null,
      status: row.status ?? null,
      last_seen_at: row.last_seen_at ?? null,
      has_credential: Boolean(row.node_credential_hash),
      credential_revoked: row.credential_revoked === true,
    };
    const roleOk = roleAcceptsPosition(row.role ?? null, "ingress");
    const projected = projectUserNode({
      status: row.status,
      last_seen_at: row.last_seen_at,
      has_credential: facts.has_credential,
      credential_revoked: row.credential_revoked,
      lifecycle: row.lifecycle,
    });
    // 现任不能被当作"接管者"（failover 的定义就是离开现任，`pickFailoverDestination` 也是这样
    // 显式排除的），所以先排除再算次序。`current_owner` 是**这条排除规则**的名字，不是新判定：
    // 准入/角色/凭据/在线四条仍然全部来自 `candidateRejection`。
    const isOwner = input.activeIngressId !== null && row.id === input.activeIngressId;
    const rejection = isOwner
      ? "current_owner"
      : candidateRejection(facts, "ingress", { requireOnline: true, now: input.now });
    const canTakeOver = rejection === null;
    if (canTakeOver) rank += 1;
    views.push({
      node_id: row.id,
      name: row.node_id,
      role: row.role ?? null,
      node_group_id: row.node_group_id,
      is_active_ingress: row.id === input.activeIngressId,
      is_preferred: row.id === input.preferredId,
      is_failback_target:
        input.preferredId !== null && row.id === input.preferredId && input.preferredId !== input.activeIngressId,
      can_be_preferred: roleOk,
      // 词表与 `ingress-candidate.ts` 的 `role_undeclared` / `role_mismatch` 同一套。
      preference_rejection: roleOk ? null : row.role == null ? "role_undeclared" : "role_mismatch",
      connection: projected.connection,
      lifecycle: projected.lifecycle,
      accepts_new_business: projected.accepts_new_business,
      admission_rejection: projected.admission_rejection,
      can_take_over: canTakeOver,
      takeover_rejection: canTakeOver ? null : rejection,
      failover_rank: canTakeOver ? rank : null,
    });
  }
  return views;
}
