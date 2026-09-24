/**
 * 能力策略合成（纯函数，无 IO）
 *
 * 这一层只回答两个问题（PLAN §4.2）：
 *   · 该 workspace **允许使用什么**（功能准入 / Entitlement）
 *   · 该 workspace **最多能用多少**（资源额度 / Quota）
 *
 * 它**不**读取价格、订单、余额，也**不**依赖 License。数据来源由
 * `policy-service.ts` 从 DB 读出后传入，这里只做确定性的合成与判定，
 * 因此可离线单测，且服务端每次判定都重新计算（前端展示不可信）。
 *
 * ── 合成规则 ──
 *  · 授予取并集：多条有效策略叠加时，协议取并集、额度取各授予的**较大值**
 *  · 平台硬上限优先：额度最终 = min(授予, 平台上限)，绝不被授予放大
 *  · 白名单为空 = 无访问；`allowed_*_group_ids` 为 `null` = 仅自有节点组
 *  · 到期/撤销：显式撤销立即失效；到期有不带授予的**降级宽限期**
 *  · 无任何有效策略 → 拒绝（fail-closed），不因“没有套餐”默认放行
 */

export type PolicySourceName = "system_default" | "admin_grant" | "trial" | "purchase";
export type TrafficPeriodName = "total" | "month" | "day";

/** 资源额度集合。`null` = 无额外限制（仍受平台上限约束）；`0` = 禁止。 */
export interface PolicyLimitSet {
  max_tunnels: number | null;
  max_nodes: number | null;
  max_members: number | null;
  /** 流量额度（字节） */
  traffic_limit: number | null;
  traffic_period: TrafficPeriodName;
  /** 带宽上限（Mbps） */
  bandwidth_limit: number | null;
  client_limit: number | null;
  ip_limit: number | null;
}

/** 功能准入集合。 */
export interface PolicyEntitlement {
  /** 允许的隧道协议；[] = 不允许任何协议 */
  tunnel_types: string[];
  allow_custom_in_group: boolean;
  allow_custom_out_group: boolean;
  /** 显式允许使用的共享入口节点组 id；null = 仅自有节点组 */
  allowed_in_group_ids: number[] | null;
  /** 显式允许使用的共享出口节点组 id；null = 仅自有节点组 */
  allowed_out_group_ids: number[] | null;
  allow_shared_entry: boolean;
  /** 入口 admission 白名单（IP/CIDR）；null = 不启用 */
  whitelist_ips: string[] | null;
}

/** 策略模板（DB 行的规范化视图）。 */
export interface PolicyRecord extends PolicyLimitSet, PolicyEntitlement {
  id: number;
  key: string;
  name: string;
  source: PolicySourceName;
  /** 内容版本；用于 `policy_revision` 与缓存失效 */
  revision: number;
  is_ceiling: boolean;
  applies_to: "personal" | "team" | null;
  status: "active" | "inactive";
}

/** 发放记录（DB 行的规范化视图）。 */
export interface PolicyAssignment {
  policy: PolicyRecord;
  source: PolicySourceName;
  effective_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  note: string | null;
}

/** 机器可读的拒绝原因。 */
export type DenyReason =
  | "no_active_policy"
  | "policy_expired"
  | "tunnel_limit"
  | "traffic_exhausted"
  | "protocol_not_allowed"
  | "node_limit"
  | "member_limit"
  | "in_group_not_allowed"
  | "out_group_not_allowed";

/** 拒绝原因 → 可解释的中文文案（超限绝不引导充值）。 */
export function describeDeny(reason: DenyReason, params: Record<string, unknown> = {}): string {
  switch (reason) {
    case "no_active_policy":
      return "工作空间没有任何生效的能力策略";
    case "policy_expired":
      return "工作空间的能力策略已到期，请管理员重新发放";
    case "tunnel_limit":
      return `已达隧道数量上限（${params.limit ?? "?"} 条）`;
    case "traffic_exhausted":
      return "已用流量达到策略额度上限";
    case "protocol_not_allowed":
      return `当前策略不允许使用该协议（${params.protocol ?? "?"}）`;
    case "node_limit":
      return `已达节点数量上限（${params.limit ?? "?"} 个）`;
    case "member_limit":
      return `已达成员数量上限（${params.limit ?? "?"} 人）`;
    case "in_group_not_allowed":
      return "当前策略不允许使用该入口节点组";
    case "out_group_not_allowed":
      return "当前策略不允许使用该出口节点组";
    default:
      return "操作被能力策略拒绝";
  }
}

/** 合成后的有效策略快照。 */
export interface EffectivePolicy {
  workspace_id: number;
  /** 确定性版本：有效策略 revision 之和 + 有效发放条数 */
  revision: number;
  entitlements: PolicyEntitlement;
  limits: PolicyLimitSet;
  /** 平台硬上限（已与授予求交后的最终值即 `limits`） */
  ceiling: PolicyLimitSet;
  active_policies: { id: number; key: string; name: string; source: PolicySourceName; expires_at: string | null }[];
  /** 宽限期内仍生效、但已到期的策略 key */
  grace_policies: string[];
  grace_expires_at: string | null;
  /** true = 无任何有效策略（含宽限），应拒绝一切能力 */
  deny_scope: boolean;
  deny_reason: DenyReason | null;
}

export interface ComposeInput {
  workspace_id: number;
  assignments: readonly PolicyAssignment[];
  /** 平台硬上限模板（is_ceiling=true）；缺省时不做额外收窄 */
  ceilings?: readonly PolicyRecord[];
  now: Date;
  /** 降级宽限期（毫秒）；0 = 不设宽限 */
  graceMs?: number;
}

const UNLIMITED_LIMITS: PolicyLimitSet = {
  max_tunnels: null,
  max_nodes: null,
  max_members: null,
  traffic_limit: null,
  traffic_period: "total",
  bandwidth_limit: null,
  client_limit: null,
  ip_limit: null,
};

const EMPTY_ENTITLEMENT: PolicyEntitlement = {
  tunnel_types: [],
  allow_custom_in_group: false,
  allow_custom_out_group: false,
  allowed_in_group_ids: [],
  allowed_out_group_ids: [],
  allow_shared_entry: false,
  whitelist_ips: null,
};

/** 发放记录是否在 `now` 时点有效（未被撤销、已生效、未到期）。 */
export function isAssignmentActive(a: PolicyAssignment, now: Date): boolean {
  if (a.revoked_at) return false;
  if (a.effective_at.getTime() > now.getTime()) return false;
  if (a.expires_at && a.expires_at.getTime() <= now.getTime()) return false;
  return a.policy.status === "active";
}

/** 是否处于「已到期但仍在宽限期」的状态。 */
export function isWithinGrace(a: PolicyAssignment, now: Date, graceMs: number): boolean {
  if (graceMs <= 0) return false;
  if (a.revoked_at) return false;
  if (a.effective_at.getTime() > now.getTime()) return false;
  if (!a.expires_at) return false;
  if (a.policy.status !== "active") return false;
  const t = now.getTime();
  const exp = a.expires_at.getTime();
  return t > exp && t <= exp + graceMs;
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/** 授予并集：额度取较大值（0 视为禁用，但被其它策略放大时取大值）。 */
export function unionLimits(a: PolicyLimitSet, b: PolicyLimitSet): PolicyLimitSet {
  return {
    max_tunnels: maxNullable(a.max_tunnels, b.max_tunnels),
    max_nodes: maxNullable(a.max_nodes, b.max_nodes),
    max_members: maxNullable(a.max_members, b.max_members),
    traffic_limit: maxNullable(a.traffic_limit, b.traffic_limit),
    // 周期以更宽松（更长窗口）的一方为准：total > month > day
    traffic_period: widerPeriod(a.traffic_period, b.traffic_period),
    bandwidth_limit: maxNullable(a.bandwidth_limit, b.bandwidth_limit),
    client_limit: maxNullable(a.client_limit, b.client_limit),
    ip_limit: maxNullable(a.ip_limit, b.ip_limit),
  };
}

const PERIOD_WIDTH: Record<TrafficPeriodName, number> = { total: 3, month: 2, day: 1 };

function widerPeriod(a: TrafficPeriodName, b: TrafficPeriodName): TrafficPeriodName {
  return PERIOD_WIDTH[a] >= PERIOD_WIDTH[b] ? a : b;
}

/** 与平台硬上限求交：额度取较小值，协议取交集，准入开关取与。 */
export function intersectCeiling(grant: PolicyLimitSet, ceiling: PolicyLimitSet): PolicyLimitSet {
  return {
    max_tunnels: minNullable(grant.max_tunnels, ceiling.max_tunnels),
    max_nodes: minNullable(grant.max_nodes, ceiling.max_nodes),
    max_members: minNullable(grant.max_members, ceiling.max_members),
    traffic_limit: minNullable(grant.traffic_limit, ceiling.traffic_limit),
    traffic_period: ceiling.traffic_period === "total" ? grant.traffic_period : widerPeriod(grant.traffic_period, ceiling.traffic_period),
    bandwidth_limit: minNullable(grant.bandwidth_limit, ceiling.bandwidth_limit),
    client_limit: minNullable(grant.client_limit, ceiling.client_limit),
    ip_limit: minNullable(grant.ip_limit, ceiling.ip_limit),
  };
}

function unionEntitlement(a: PolicyEntitlement, b: PolicyEntitlement): PolicyEntitlement {
  return {
    tunnel_types: [...new Set([...a.tunnel_types, ...b.tunnel_types])],
    allow_custom_in_group: a.allow_custom_in_group || b.allow_custom_in_group,
    allow_custom_out_group: a.allow_custom_out_group || b.allow_custom_out_group,
    allowed_in_group_ids: mergeIdLists(a.allowed_in_group_ids, b.allowed_in_group_ids),
    allowed_out_group_ids: mergeIdLists(a.allowed_out_group_ids, b.allowed_out_group_ids),
    allow_shared_entry: a.allow_shared_entry || b.allow_shared_entry,
    // 白名单：只要有一条策略给了白名单就启用（更严格的一方不应被放宽）；
    // null 表示不启用，两条都 null 时才为 null。
    whitelist_ips: mergeWhitelist(a.whitelist_ips, b.whitelist_ips),
  };
}

/** null 代表「仅自有」；只要有一方给了显式列表，就取两方列表的并集。 */
function mergeIdLists(a: number[] | null, b: number[] | null): number[] | null {
  if (a === null && b === null) return null;
  return [...new Set([...(a ?? []), ...(b ?? [])])].sort((x, y) => x - y);
}

function mergeWhitelist(a: string[] | null, b: string[] | null): string[] | null {
  if (a === null) return b;
  if (b === null) return a;
  return [...new Set([...a, ...b])];
}

function limitsFromPolicy(p: PolicyRecord): PolicyLimitSet {
  return {
    max_tunnels: p.max_tunnels,
    max_nodes: p.max_nodes,
    max_members: p.max_members,
    traffic_limit: p.traffic_limit,
    traffic_period: p.traffic_period,
    bandwidth_limit: p.bandwidth_limit,
    client_limit: p.client_limit,
    ip_limit: p.ip_limit,
  };
}

function entitlementFromPolicy(p: PolicyRecord): PolicyEntitlement {
  return {
    tunnel_types: [...p.tunnel_types],
    allow_custom_in_group: p.allow_custom_in_group,
    allow_custom_out_group: p.allow_custom_out_group,
    allowed_in_group_ids: p.allowed_in_group_ids === null ? null : [...p.allowed_in_group_ids],
    allowed_out_group_ids: p.allowed_out_group_ids === null ? null : [...p.allowed_out_group_ids],
    allow_shared_entry: p.allow_shared_entry,
    whitelist_ips: p.whitelist_ips === null ? null : [...p.whitelist_ips],
  };
}

/** 平台硬上限：多条 ceiling 取最严格（逐个字段取 min）。 */
export function combineCeilings(ceilings: readonly PolicyRecord[]): PolicyLimitSet {
  let acc: PolicyLimitSet = { ...UNLIMITED_LIMITS };
  for (const c of ceilings) acc = intersectCeiling(acc, limitsFromPolicy(c));
  return acc;
}

/**
 * 合成 workspace 的有效策略。
 *
 * @param input 已从 DB 读出的发放与平台上限
 */
export function composeEffectivePolicy(input: ComposeInput): EffectivePolicy {
  const now = input.now;
  const graceMs = input.graceMs ?? 0;

  const active = input.assignments.filter((a) => isAssignmentActive(a, now));
  const grace = active.length === 0 ? input.assignments.filter((a) => isWithinGrace(a, now, graceMs)) : [];

  const effectiveAssignments = active.length > 0 ? active : grace;
  const ceiling = combineCeilings(input.ceilings ?? []);

  const activePolicies = effectiveAssignments
    .map((a) => ({ ...a.policy, _source: a.source, _expires: a.expires_at }))
    .sort((a, b) => a.id - b.id);

  if (activePolicies.length === 0) {
    return {
      workspace_id: input.workspace_id,
      revision: 0,
      entitlements: { ...EMPTY_ENTITLEMENT },
      limits: { ...UNLIMITED_LIMITS },
      ceiling,
      active_policies: [],
      grace_policies: [],
      grace_expires_at: null,
      deny_scope: true,
      deny_reason: "no_active_policy",
    };
  }

  let grantedLimits: PolicyLimitSet = { ...UNLIMITED_LIMITS };
  let entitlement: PolicyEntitlement = { ...EMPTY_ENTITLEMENT };
  let revision = 0;
  for (const p of activePolicies) {
    grantedLimits = unionLimits(grantedLimits, limitsFromPolicy(p));
    entitlement = unionEntitlement(entitlement, entitlementFromPolicy(p));
    revision += p.revision;
  }

  // 平台硬上限收紧协议白名单（交集）与额度（min）。
  const ceilingPolicies = input.ceilings ?? [];
  if (ceilingPolicies.length > 0) {
    const ceilingTypes = new Set<string>();
    for (const c of ceilingPolicies) for (const t of c.tunnel_types) ceilingTypes.add(t);
    entitlement.tunnel_types = entitlement.tunnel_types.filter((t) => ceilingTypes.has(t));
  }

  const limits = intersectCeiling(grantedLimits, ceiling);
  const gracePolicies = grace.map((a) => a.policy.key);
  const graceExpiresAt = grace.length
    ? new Date(Math.max(...grace.map((a) => (a.expires_at ? a.expires_at.getTime() : now.getTime())))).toISOString()
    : null;

  return {
    workspace_id: input.workspace_id,
    revision: revision + effectiveAssignments.length,
    entitlements: entitlement,
    limits,
    ceiling,
    active_policies: activePolicies.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      source: p._source,
      expires_at: p._expires ? p._expires.toISOString() : null,
    })),
    grace_policies: gracePolicies,
    grace_expires_at: graceExpiresAt,
    deny_scope: false,
    deny_reason: grace.length > 0 ? "policy_expired" : null,
  };
}

/* ================================================================== */
/* 能力判定：隧道创建（额度 + 协议 + 节点组准入）                       */
/* ================================================================== */

export interface TunnelCreateContext {
  /** 当前 workspace 已存在的有效隧道数（active + inactive，均占额度） */
  tunnelCount: number;
  /** 当前计量周期内已用流量（字节） */
  trafficUsed: number;
  protocol: string;
  /** 入口节点组是否自有（非共享） */
  inGroupOwned: boolean;
  inGroupId: number;
  outGroupId: number | null;
  outGroupOwned: boolean;
}

export interface CapabilityDecision {
  allowed: boolean;
  reason?: DenyReason;
  message?: string;
  params?: Record<string, unknown>;
}

/**
 * 是否允许创建隧道。**纯函数**：并发安全由调用方在事务内以行锁 + 计数复核保证
 * （本函数只做单次快照判定，绝不自增计数）。
 */
export function checkTunnelCreation(policy: EffectivePolicy, ctx: TunnelCreateContext): CapabilityDecision {
  if (policy.deny_scope) {
    return deny(policy.deny_reason ?? "no_active_policy", {});
  }
  if (!policy.entitlements.tunnel_types.includes(ctx.protocol)) {
    return deny("protocol_not_allowed", { protocol: ctx.protocol });
  }
  if (!ctx.inGroupOwned && !sharedGroupAllowed(policy.entitlements.allowed_in_group_ids, ctx.inGroupId)) {
    return deny("in_group_not_allowed", { group_id: ctx.inGroupId });
  }
  if (ctx.outGroupId !== null && !ctx.outGroupOwned && !sharedGroupAllowed(policy.entitlements.allowed_out_group_ids, ctx.outGroupId)) {
    return deny("out_group_not_allowed", { group_id: ctx.outGroupId });
  }
  const maxTunnels = policy.limits.max_tunnels;
  if (maxTunnels !== null && ctx.tunnelCount >= maxTunnels) {
    return deny("tunnel_limit", { limit: maxTunnels, used: ctx.tunnelCount });
  }
  const trafficLimit = policy.limits.traffic_limit;
  if (trafficLimit !== null && ctx.trafficUsed >= trafficLimit) {
    return deny("traffic_exhausted", { limit: trafficLimit, used: ctx.trafficUsed });
  }
  return { allowed: true };
}

function sharedGroupAllowed(allowList: number[] | null, groupId: number): boolean {
  if (allowList === null) return false; // 仅自有
  return allowList.includes(groupId);
}

function deny(reason: DenyReason, params: Record<string, unknown>): CapabilityDecision {
  return { allowed: false, reason, message: describeDeny(reason, params), params };
}

/** 是否允许创建节点（私有节点组）。 */
export function checkNodeCreation(policy: EffectivePolicy, nodeCount: number): CapabilityDecision {
  if (policy.deny_scope) return deny(policy.deny_reason ?? "no_active_policy", {});
  const max = policy.limits.max_nodes;
  if (max !== null && nodeCount >= max) return deny("node_limit", { limit: max, used: nodeCount });
  return { allowed: true };
}

/** 是否允许新增成员。 */
export function checkMemberAddition(policy: EffectivePolicy, memberCount: number): CapabilityDecision {
  if (policy.deny_scope) return deny(policy.deny_reason ?? "no_active_policy", {});
  const max = policy.limits.max_members;
  if (max !== null && memberCount >= max) return deny("member_limit", { limit: max, used: memberCount });
  return { allowed: true };
}

/** 计量周期起点（total 返回 null = 不限窗口）。 */
export function trafficWindowStart(period: TrafficPeriodName, now: Date): Date | null {
  if (period === "total") return null;
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  if (period === "day") return d;
  d.setDate(1);
  return d;
}
