/**
 * 入口候选的**单一定义**：候选集同源化。
 *
 * 为什么必须抽出来：故障转移循环与 Route Profile 编译器各自回答同一个问题 ——
 * "这台机器现在能不能当入口" —— 而它们**必须给出同一个答案**。两边各写一份过滤，症状是
 * "编译器认为可用、迁移却挑了一台指挥不动的机器"（或反向），而这类不一致最难查：两处看起来
 * 各自都对，只是**不同**。
 *
 * 判定顺序照抄编译器的 `candidateRejection`：先"能不能指挥这台机器"（`nodeAdmission`），
 * 再生命周期、再角色、最后在线。顺序本身就是可解释性的一部分 —— 原因码要指出**第一个**
 * 不满足的条件，否则一条 `"node_not_online"` 会盖住"它的凭据早就被吊销了"。
 *
 * 在线判定沿用 `deriveConnection`（`node-lifecycle.ts`）：与 UI、注意力面板**同一份推导**。
 * 旧代码用的是 `state_report.reported_at < 5min`，那只是"最近有人说它活着"的代理指标，
 * 与"面板能指挥它"不是同一件事。
 */
import { deriveConnection, nodeAdmission } from "./node-lifecycle.ts";

export interface CandidateFacts {
  node_id: number;
  node_group_id: number;
  role: string | null;
  lifecycle: string | null;
  status: string | null;
  last_seen_at: Date | null;
  has_credential: boolean;
  credential_revoked: boolean;
  /** 由调用方按需提供；`requireOnline` 时会用到。 */
  health?: string | null;
}

export type CandidatePosition = "ingress" | "egress" | "transit";

export interface CandidateCriteria {
  /** 缺省只允许 `active`（fail-closed，不给默认放行）。 */
  readonly allowedLifecycles?: readonly string[];
  /**
   * 是否要求"此刻在线"。
   *
   * 故障转移**必须**要求：它要挑一台**现在就能接管**的机器，而 `nodeAdmission` 只回答
   * "面板能不能指挥它"（凭据/生命周期），不回答"它此刻在不在"。编译器今天不要求（它编译的是
   * 一份可以稍后生效的计划），所以这里是一个**显式开关**而不是两套判定 —— 差异只有一处，
   * 而且写在这里能被读到。
   */
  readonly requireOnline?: boolean;
  /**
   * 显式时钟。**必须能传**：`nodeAdmission` / `deriveConnection` 缺省读真实时钟，
   * 不注入就会让"这台机器现在算不算在线"的断言随墙上时钟漂移 —— 本仓已经为这类
   * 夹具腐化付过两次学费（见 `federation-lease` 与 `portPool` 的修复）。
   */
  readonly now?: Date;
}

/**
 * 位置 → 可接受的 `Node.role`。`both` 永远可接受；未声明的角色是独立的拒绝原因。
 *
 * **transit 与 egress 同口径**：中间跳的物理形态就是 EGRESS runtime（`forward-rollout.ts`
 * 的三跳准入同此要求）。这条不是口味问题 —— 抽公共实现时我一度把它写成 `both`，
 * 而那样会**悄悄收紧三跳准入**：一台 `role=egress` 的机器今天能当中转，改完之后就不能了，
 * 而改动理由是"重构"。同源化的前提是不改变任何一方的语义。
 */
export function roleAcceptsPosition(role: string | null, position: CandidatePosition): boolean {
  if (position === "ingress") return role === "ingress" || role === "both";
  return role === "egress" || role === "both";
}

/**
 * 返回 `null` = 合格；否则是**可区分**的拒绝原因码（与编译器共用同一套词表）。
 *
 * 词表来源（**不新造**）：`nodeAdmission` 的准入条件码、`lifecycle_not_allowed`、
 * `role_undeclared` / `role_mismatch`、`node_not_online`、`node_credential_revoked` ——
 * 后两个是本模块新增的，因为"在线"与"凭据被吊销"此前从没被显式区分过（旧代码用上报时间戳
 * 间接代替，而 `deriveConnection` 又把吊销归进 `offline`）。
 */
export function candidateRejection(
  facts: CandidateFacts,
  position: CandidatePosition,
  criteria: CandidateCriteria = {},
): string | null {
  const admission = nodeAdmission({
    lifecycle: (facts.lifecycle ?? null) as never,
    status: (facts.status ?? null) as never,
    last_seen_at: facts.last_seen_at,
    has_credential: facts.has_credential,
    credential_revoked: facts.credential_revoked,
    ...(criteria.now ? { now: criteria.now } : {}),
  });
  if (!admission.ok) return admission.condition;

  // 注意这条只能**收窄**、不能放宽：`nodeAdmission` 已经要求 `lifecycle === "active"`
  //（`lifecycleAcceptsBusiness`），所以把 `allowedLifecycles` 写成 `["active", "suspended"]`
  // 也放不进一台 suspended 的机器。编译器那里的注释写着"显式白名单才放宽"，实际上放不宽 ——
  // 行为是对的（fail-closed），只是注释误导，这里照实记下来。
  const allowed = criteria.allowedLifecycles ?? ["active"];
  if (!allowed.includes(facts.lifecycle ?? "")) return "lifecycle_not_allowed";

  if (!roleAcceptsPosition(facts.role, position)) {
    return facts.role == null ? "role_undeclared" : "role_mismatch";
  }

  // 凭据被吊销要**先于**在线判定报出来。`deriveConnection` 把"吊销"和"很久没上报"
  // 一起归成 `offline`，于是运维只能看到一句"节点不在线"——而这两件事的下一步动作完全不同
  // （重新登记 vs 等它回来）。能行动的原因优先，是这套原因码存在的意义。
  if (facts.credential_revoked === true) return "node_credential_revoked";

  if (criteria.requireOnline === true) {
    // `deriveConnection` 只看"面板能否与它通信"的那几个事实（生命周期由上面的准入判定负责），
    // 所以这里刻意不把 `lifecycle` 递进去 —— 两件事分开判，原因码才分得开。
    const connection = deriveConnection({
      status: (facts.status ?? null) as never,
      last_seen_at: facts.last_seen_at,
      has_credential: facts.has_credential,
      credential_revoked: facts.credential_revoked,
      ...(criteria.now ? { now: criteria.now } : {}),
    });
    if (connection !== "online") return "node_not_online";
  }
  return null;
}
