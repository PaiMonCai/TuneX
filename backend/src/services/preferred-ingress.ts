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
/* 入口成员次序（**意图**存储：forward_ingress_member）                  */
/* ================================================================== */
//
// 行为参照（ForwardX, AGPL-3.0-only）：它的成员表用 `priority`（升序）+ `isEnabled` 表达
// 「谁是第一顺位、谁这次不参与」；恢复的**高优先级**成员要能压过当前活跃的低优先级成员。
// **代码为本项目改写，未复制其实现**；我们只落**意图**列，不落它的健康列。

/** 一条意图行（读投影：不含任何事实列）。 */
export interface IngressMemberIntentRow {
  node_id: number;
  priority: number;
  is_enabled: boolean;
}

/** 读次序所需的**最小**依赖缝隙（与既有 deps 风格一致，测试可注入）。 */
export interface IngressMemberIntentDb {
  forwardIngressMember: { findMany: (args: Prisma.ForwardIngressMemberFindManyArgs) => Promise<unknown> };
}

/**
 * 读这条转发的成员次序（意图）。
 *
 * **读不到返回 `null`**（而不是抛错、也不是空数组）：次序是**偏好**，读不到只该退回
 * "按 `node_id` 升序"的既有规则，不该让一次可修复的读错误冻结自动迁移。
 * `[]`（有意图能力、但这台转发没存过次序）与 `null`（读不到）因此是**两个不同事实**。
 */
export async function readIngressMemberIntent(
  db: IngressMemberIntentDb,
  tunnelId: number,
): Promise<IngressMemberIntentRow[] | null> {
  try {
    const rows = (await db.forwardIngressMember.findMany({
      where: { tunnel_id: tunnelId },
      select: { node_id: true, priority: true, is_enabled: true },
      orderBy: [{ priority: "asc" }, { node_id: "asc" }],
    })) as Array<{ node_id: number; priority: number; is_enabled: boolean }>;
    return rows.map((row) => ({
      node_id: row.node_id,
      priority: row.priority,
      is_enabled: row.is_enabled === true,
    }));
  } catch {
    // 读不到 ⇒ 回退到今天的次序（调用方按 `hasIntent = false` 处理）。
    return null;
  }
}

/**
 * 次序索引（纯函数，可单独断言）。
 *
 * 规则（与既有判定同源，只多一条"次序"）：
 *   · 启用中的意图行按 `(priority, node_id)` 升序编号，`order_rank` 0 起；
 *   · `is_enabled=false` 的行**保留在次序里**（用户能看到它排第几）但**不参与接管**
 *     （原因码 `member_disabled`）；
 *   · 不在表内的节点没有位次 —— 它们排在所有意图行**之后**（`order_rank = null`），
 *     内部仍按 `node_id` 升序，这就是"无行 = 迁移前行为"的来源。
 */
export interface IngressOrderIndex {
  /** 是否有存储的次序（`false` ⇒ 今天的规则）。 */
  readonly hasIntent: boolean;
  /** 意图行的声明顺位（1 起，含被停用的行）；不在表内为 null。 */
  declaredRankOf(nodeId: number): number | null;
  /** 启用中的意图行的接管顺位（0 起）；不在表内或被停用为 null。 */
  orderRankOf(nodeId: number): number | null;
  /** 显式停用。 */
  isDisabled(nodeId: number): boolean;
}

export function ingressOrderIndexOf(
  rows: readonly IngressMemberIntentRow[] | null,
): IngressOrderIndex {
  const sorted = [...(rows ?? [])].sort((a, b) => a.priority - b.priority || a.node_id - b.node_id);
  const declared = new Map<number, number>();
  const order = new Map<number, number>();
  const disabled = new Set<number>();
  let enabledRank = 0;
  sorted.forEach((row, index) => {
    declared.set(row.node_id, index + 1);
    if (row.is_enabled) {
      order.set(row.node_id, enabledRank);
      enabledRank += 1;
    } else {
      disabled.add(row.node_id);
    }
  });
  return {
    hasIntent: sorted.length > 0,
    declaredRankOf: (nodeId) => declared.get(nodeId) ?? null,
    orderRankOf: (nodeId) => order.get(nodeId) ?? null,
    isDisabled: (nodeId) => disabled.has(nodeId),
  };
}

/** 写路径的错误码（规则与 `preferred-ingress` 共享同一批函数，码名按"成员"命名以便区分操作）。 */
export const INGRESS_MEMBER_ERROR_CODES = {
  member_forward_not_found: "member_forward_not_found",
  member_node_not_found: "member_node_not_found",
  member_node_group_mismatch: "member_node_group_mismatch",
  member_role_mismatch: "member_role_mismatch",
  member_duplicated: "member_duplicated",
  member_unavailable: "member_unavailable",
} as const;
export type IngressMemberErrorCode =
  (typeof INGRESS_MEMBER_ERROR_CODES)[keyof typeof INGRESS_MEMBER_ERROR_CODES];

/** 写路径的依赖缝隙：事务 + 三张表的最小读面。 */
export interface IngressMemberWriteDb {
  tunnel: {
    findFirst: (args: Prisma.TunnelFindFirstArgs) => Promise<unknown>;
    update: (args: Prisma.TunnelUpdateArgs) => Promise<unknown>;
  };
  node: { findMany: (args: Prisma.NodeFindManyArgs) => Promise<unknown[]> };
  forwardIngressMember: {
    deleteMany: (args: Prisma.ForwardIngressMemberDeleteManyArgs) => Promise<unknown>;
    createMany: (args: Prisma.ForwardIngressMemberCreateManyArgs) => Promise<unknown>;
  };
  $transaction: <T>(fn: (tx: IngressMemberWriteDb) => Promise<T>) => Promise<T>;
}

export interface IngressMemberInput {
  node_id: number;
  is_enabled?: boolean;
}

export interface IngressMemberWriteResult {
  tunnel_id: number;
  /** 存下来的次序（`priority` = 数组下标；这里是服务端的真值回显）。 */
  members: Array<{ node_id: number; priority: number; is_enabled: boolean }>;
  /** 与 `priority[0]`（第一台**启用**的成员）同一条写入路径维护的回切目标。 */
  preferred_ingress_node_id: number | null;
}

export type SetIngressMembersResult =
  | { ok: true; value: IngressMemberWriteResult }
  | { ok: false; code: IngressMemberErrorCode; error: string };

interface MemberTunnelRow {
  id: number;
  in_node_group_id: number;
  ingress_node_id: number | null;
  preferred_ingress_node_id: number | null;
}

interface MemberNodeRow {
  id: number;
  node_group_id: number;
  role: string | null;
}

/**
 * **全量替换**这条转发的入口成员次序（数组顺序 = 优先级，`priority = index`）。
 *
 * 三条纪律写在这里：
 *   1. **数组顺序是唯一输入**：不接收客户端传来的 `priority`，因此不存在"priority 冲突"
 *      —— 重复的 `node_id` 被显式拒绝（不静默去重，那会让用户以为存进去了 5 台实际 4 台）；
 *   2. **同一条写入路径维护回切目标**：`preferred_ingress_node_id` = 第一台**启用**的成员，
 *      与成员表在同一次事务里写。这样"首选入口"不会出现两份真相（一个是表、一个是列）；
 *   3. **换了次序就重新计数**：`failback_healthy_checks = 0`，否则旧次序攒下的"连续健康"
 *      会被算到新的第一顺位头上（与 `setPreferredIngressNode` 同一条理由）。
 *
 * `members: []` = **清除自定义次序**，回到"合格候选按 `node_id` 升序"的既有行为（并清空回切目标）。
 */
export async function setIngressMembers(
  deps: { db: IngressMemberWriteDb },
  input: { workspaceId: number; tunnelId: number; members: readonly IngressMemberInput[] },
): Promise<SetIngressMembersResult> {
  const seen = new Set<number>();
  for (const member of input.members) {
    if (seen.has(member.node_id)) {
      return {
        ok: false,
        code: INGRESS_MEMBER_ERROR_CODES.member_duplicated,
        error: `成员次序里出现重复的节点 #${member.node_id}`,
      };
    }
    seen.add(member.node_id);
  }
  try {
    return await deps.db.$transaction(async (tx) => {
      const tunnel = (await tx.tunnel.findFirst({
        where: { id: input.tunnelId, workspace_id: input.workspaceId, category: "port_forward" },
        select: { id: true, in_node_group_id: true, ingress_node_id: true, preferred_ingress_node_id: true },
      })) as MemberTunnelRow | null;
      if (!tunnel) {
        return {
          ok: false as const,
          code: INGRESS_MEMBER_ERROR_CODES.member_forward_not_found,
          error: "端口转发不存在",
        };
      }

      if (input.members.length > 0) {
        const rows = (await tx.node.findMany({
          where: { id: { in: input.members.map((m) => m.node_id) }, node_group: { workspace_id: input.workspaceId } },
          select: { id: true, node_group_id: true, role: true },
        })) as MemberNodeRow[];
        const byId = new Map(rows.map((row) => [row.id, row]));
        for (const member of input.members) {
          const node = byId.get(member.node_id);
          // 不存在 / 不属于本 workspace 的节点：同一个码（否则响应体成了跨租户存在性探针）。
          if (!node) {
            return {
              ok: false as const,
              code: INGRESS_MEMBER_ERROR_CODES.member_node_not_found,
              error: `节点 #${member.node_id} 不存在`,
            };
          }
          if (node.node_group_id !== tunnel.in_node_group_id) {
            return {
              ok: false as const,
              code: INGRESS_MEMBER_ERROR_CODES.member_node_group_mismatch,
              error: `节点 #${member.node_id} 不在该转发的入口节点组里`,
            };
          }
          if (!roleAcceptsPosition(node.role ?? null, "ingress")) {
            return {
              ok: false as const,
              code: INGRESS_MEMBER_ERROR_CODES.member_role_mismatch,
              error: `节点 #${member.node_id} 的角色不能作为入口（需要 ingress 或 both）`,
            };
          }
        }
      }

      await tx.forwardIngressMember.deleteMany({ where: { tunnel_id: tunnel.id } });
      const stored = input.members.map((member, index) => ({
        node_id: member.node_id,
        priority: index,
        is_enabled: member.is_enabled !== false,
      }));
      if (stored.length > 0) {
        await tx.forwardIngressMember.createMany({
          data: stored.map((row) => ({
            tunnel_id: tunnel.id,
            node_id: row.node_id,
            priority: row.priority,
            is_enabled: row.is_enabled,
          })),
        });
      }
      const preferred = stored.find((row) => row.is_enabled)?.node_id ?? null;
      await tx.tunnel.update({
        where: { id: tunnel.id },
        data: { preferred_ingress_node_id: preferred, failback_healthy_checks: 0 },
      });
      return {
        ok: true as const,
        value: { tunnel_id: tunnel.id, members: stored, preferred_ingress_node_id: preferred },
      };
    });
  } catch {
    return {
      ok: false,
      code: INGRESS_MEMBER_ERROR_CODES.member_unavailable,
      error: "成员次序写入失败（数据库不可用）",
    };
  }
}

/* ================================================================== */
/* 入口成员视图（有序）                                                 */
/* ================================================================== */
//
// 行为参照（ForwardX, AGPL-3.0-only）：转发组的成员列表「顺序即优先级，排最前者为首选
// 入口」；当前入口失效并持续达到故障窗口后，切到**下一个可用成员**；「恢复后切回」开关决定
// 高优先级成员回来之后要不要切回。**代码为本项目改写，未复制其实现。**
//
// 我们只借行为，不借它的资源/存储模型：
//   · 成员集合 —— 「这条转发的入口节点组里的节点」是既有真相（`tunnel.in_node_group_id`）；
//     组里没有节点就是「没有成员」这个可区分的态；
//   · 顺序 —— task-43 起有了一份**按转发的意图存储**（`forward_ingress_member`，行为参照它的
//     成员表 `priority` + `isEnabled`）：表内有行 ⇒ 按表内次序；**无行 ⇒ 与迁移前逐位一致**
//     （合格候选按 `node_id` 升序）。表里**只有意图**，连接/准入/健康仍来自上报与既有投影。
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
   * 与 `pickFailoverDestination` 同源：**有用户次序就按用户次序**，没有就按 `node_id` 升序。
   */
  failover_rank: number | null;
  /** 它是否出现在用户保存过的次序里（`false` = 只是组内成员，排在已保存成员之后）。 */
  in_saved_order: boolean;
  /** 在**已保存次序**里的声明顺位（1 起，含被停用的行）；没有保存过 / 不在表内为 `null`。 */
  member_rank: number | null;
  /** 用户在这次次序里**显式停用**了它（它不再被选来接管，但仍显示在列表里）。 */
  is_disabled: boolean;
}

/**
 * 把入口组的节点行投影成**有序**成员视图。纯函数：无 IO、无时钟，`now` 必须显式传入
 * （在线判定不注入时钟会让结论随墙上时钟漂移 —— 本仓已为这类夹具腐化付过学费）。
 *
 * 顺序 = **用户保存过的次序优先**（`forward_ingress_member.priority` 升序），其余组内成员
 * 按 `node_id` 升序排在后面；`intent === null`（读不到）与 `[]`（没保存过）都落回
 * "按 `node_id` 升序"，也就是迁移前的行为。因此 `failover_rank === 1` 的那台就是
 * "现任失联时会被选中的那台"，与 `pickFailoverDestination` 走同一份次序。
 */
export function buildIngressMemberViews(
  rows: readonly IngressMemberRow[],
  input: {
    activeIngressId: number | null;
    preferredId: number | null;
    now: Date;
    /** 已保存的成员次序；`null` = 读不到（按既有规则），`[]` = 没保存过（同上）。 */
    intent?: readonly IngressMemberIntentRow[] | null;
  },
): IngressMemberView[] {
  const order = ingressOrderIndexOf(input.intent ?? null);
  const ordered = [...rows].sort((a, b) => {
    // 用**声明顺位**（含被停用的行）：用户在界面里看到的次序就是他保存下来的次序 ——
    // 被停用的成员留在原来的位置上（带原因码），不会跳到列表末尾。
    const ra = order.declaredRankOf(a.id);
    const rb = order.declaredRankOf(b.id);
    if (ra !== null && rb !== null) return ra - rb;
    if (ra !== null) return -1;
    if (rb !== null) return 1;
    return a.id - b.id;
  });
  const views: IngressMemberView[] = [];
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
    // 次序上显式停用的成员：保留显示（用户要知道自己停用了谁），但不参与接管。
    // 这条**不是** `candidateRejection` 的一部分（那是事实判定），而是这次次序的意图。
    const isDisabled = order.isDisabled(row.id);
    const rejection = isOwner
      ? "current_owner"
      : isDisabled
        ? "member_disabled"
        : candidateRejection(facts, "ingress", { requireOnline: true, now: input.now });
    const canTakeOver = rejection === null;
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
      failover_rank: null,
      in_saved_order: order.declaredRankOf(row.id) !== null,
      member_rank: order.declaredRankOf(row.id),
      is_disabled: isDisabled,
    });
  }

  // 接管次序单独算：**只对能接管的成员**按"用户次序优先、其余按 node_id 升序"编号 ——
  // 与 `pickFailoverDestination` 的排序是同一份规则（同一份 `IngressOrderIndex`），
  // 所以界面上的第 1 名就是平台 tick 会挑中的那一台。
  const candidates = views
    .filter((view) => view.can_take_over)
    .sort((a, b) => {
      const ra = order.orderRankOf(a.node_id);
      const rb = order.orderRankOf(b.node_id);
      if (ra !== null && rb !== null) return ra - rb;
      if (ra !== null) return -1;
      if (rb !== null) return 1;
      return a.node_id - b.node_id;
    });
  candidates.forEach((view, index) => {
    view.failover_rank = index + 1;
  });
  return views;
}
