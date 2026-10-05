/**
 * V5-WP17.1（契约 D4 收口）—— **首选入口节点**的写入路径。
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
 */
import { Prisma } from "@prisma/client";
import { roleAcceptsPosition, type CandidateFacts } from "./ingress-candidate.ts";

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
