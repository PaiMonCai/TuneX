/**
 * 策略/额度服务（DB 编排层）
 *
 * 把 `capability-policy.ts` 的纯合成逻辑接到数据库上：
 *   · 读取 workspace 的有效发放与平台硬上限 → `getEffectivePolicy`
 *   · 新建 workspace 时事务性发放免费策略 → `ensureDefaultPolicy`
 *   · 隧道/节点/成员创建的**并发原子**额度判定 → `withWorkspaceQuotaLock`
 *
 * ── 为什么需要行锁 ──
 * MySQL 不提供租户行级隔离，且「先查计数再插入」在并发下会双双通过（检查即用，
 * TOCTOU）。这里对 `workspace` 行 `SELECT ... FOR UPDATE`，使同一 workspace 的
 * 建隧道/建节点/加成员串行化：后进入者能看到前者已提交的计数，从而在本进程内
 * 不可能突破额度（见 SOFT-01 验收：并发限额不越界）。
 *
 * ── 为什么不吃 UserPlan ──
 * 判定只依赖 CapabilityPolicy/Assignment；支付、订单、余额与许可一概不参与。
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "../db.ts";
import {
  composeEffectivePolicy,
  type ComposeInput,
  type EffectivePolicy,
  type PolicyAssignment,
  type PolicyLimitSet,
  type PolicyRecord,
  type PolicySourceName,
  type TrafficPeriodName,
} from "./capability-policy.ts";

export const DEFAULT_POLICY_KEYS = { personal: "free_personal", team: "free_team", ceiling: "platform_ceiling" } as const;

/** 到期降级宽限期（毫秒）：策略到期后仍短暂放行，给运营/用户处置窗口。 */
export const POLICY_GRACE_MS = Number(process.env.POLICY_GRACE_MS ?? 3 * 24 * 60 * 60 * 1000);

/* ------------------------------------------------------------------ */
/* 行规范化                                                            */
/* ------------------------------------------------------------------ */

type PolicyRow = {
  id: number;
  key: string;
  name: string;
  source: string;
  is_default: boolean;
  applies_to: string | null;
  is_ceiling: boolean;
  status: string;
  revision: number;
  tunnel_types: Prisma.JsonValue;
  allow_custom_in_group: boolean;
  allow_custom_out_group: boolean;
  allowed_in_group_ids: Prisma.JsonValue;
  allowed_out_group_ids: Prisma.JsonValue;
  allow_shared_entry: boolean;
  max_tunnels: number | null;
  max_nodes: number | null;
  max_members: number | null;
  traffic_limit: number | null;
  traffic_period: string;
  bandwidth_limit: number | null;
  client_limit: number | null;
  ip_limit: number | null;
  whitelist_ips: Prisma.JsonValue;
};

function asStringArray(v: Prisma.JsonValue): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

function asNumberArrayOrNull(v: Prisma.JsonValue): number[] | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return null;
  return v
    .map((x) => Number(x))
    .filter((x) => Number.isInteger(x) && x > 0);
}

function asTrafficPeriod(v: string): TrafficPeriodName {
  return v === "month" || v === "day" ? v : "total";
}

function asSource(v: string): PolicySourceName {
  return v === "admin_grant" || v === "trial" || v === "purchase" ? v : "system_default";
}

export function normalizePolicy(row: PolicyRow): PolicyRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    source: asSource(row.source),
    revision: row.revision,
    is_ceiling: row.is_ceiling,
    applies_to: row.applies_to === "personal" || row.applies_to === "team" ? row.applies_to : null,
    status: row.status === "inactive" ? "inactive" : "active",
    tunnel_types: asStringArray(row.tunnel_types),
    allow_custom_in_group: row.allow_custom_in_group,
    allow_custom_out_group: row.allow_custom_out_group,
    allowed_in_group_ids: asNumberArrayOrNull(row.allowed_in_group_ids),
    allowed_out_group_ids: asNumberArrayOrNull(row.allowed_out_group_ids),
    allow_shared_entry: row.allow_shared_entry,
    max_tunnels: row.max_tunnels,
    max_nodes: row.max_nodes,
    max_members: row.max_members,
    traffic_limit: row.traffic_limit,
    traffic_period: asTrafficPeriod(row.traffic_period),
    bandwidth_limit: row.bandwidth_limit,
    client_limit: row.client_limit,
    ip_limit: row.ip_limit,
    whitelist_ips: row.whitelist_ips === null || row.whitelist_ips === undefined ? null : asStringArray(row.whitelist_ips),
  };
}

const POLICY_SELECT = {
  id: true, key: true, name: true, source: true, is_default: true, applies_to: true, is_ceiling: true,
  status: true, revision: true, tunnel_types: true, allow_custom_in_group: true, allow_custom_out_group: true,
  allowed_in_group_ids: true, allowed_out_group_ids: true, allow_shared_entry: true,
  max_tunnels: true, max_nodes: true, max_members: true, traffic_limit: true, traffic_period: true,
  bandwidth_limit: true, client_limit: true, ip_limit: true, whitelist_ips: true,
} as const;

/* ------------------------------------------------------------------ */
/* 缓存（显式失效 + 短 TTL 兜底）                                       */
/* ------------------------------------------------------------------ */

const cache = new Map<number, { value: EffectivePolicy; at: number }>();
const CACHE_TTL_MS = Number(process.env.POLICY_CACHE_TTL_MS ?? 1000);

/** 策略发放变更（授予/撤销/到期/修改）后必须调用，保证「撤权立即生效」。 */
export function invalidatePolicyCache(workspaceId?: number): void {
  if (workspaceId === undefined) cache.clear();
  else cache.delete(workspaceId);
}

/* ------------------------------------------------------------------ */
/* 读取有效策略                                                        */
/* ------------------------------------------------------------------ */

type DbLike = PrismaClient | Prisma.TransactionClient;

export async function loadPolicyInputs(
  workspaceId: number,
  client: DbLike = db,
): Promise<Omit<ComposeInput, "now" | "graceMs" | "workspace_id">> {
  const [assignments, ceilings] = await Promise.all([
    client.workspacePolicyAssignment.findMany({
      where: { workspace_id: workspaceId },
      select: {
        source: true, effective_at: true, expires_at: true, revoked_at: true, note: true,
        policy: { select: POLICY_SELECT },
      },
    }),
    client.capabilityPolicy.findMany({ where: { is_ceiling: true, status: "active" }, select: POLICY_SELECT }),
  ]);
  return {
    assignments: assignments.map(
      (a): PolicyAssignment => ({
        policy: normalizePolicy(a.policy as unknown as PolicyRow),
        source: asSource(a.source),
        effective_at: a.effective_at,
        expires_at: a.expires_at,
        revoked_at: a.revoked_at,
        note: a.note,
      }),
    ),
    ceilings: ceilings.map((c) => normalizePolicy(c as unknown as PolicyRow)),
  };
}

/** 读取并合成某 workspace 的有效策略（带短缓存；撤销时显式失效）。 */
export async function getEffectivePolicy(
  workspaceId: number,
  opts: { now?: Date; client?: DbLike; noCache?: boolean } = {},
): Promise<EffectivePolicy> {
  const now = opts.now ?? new Date();
  if (!opts.client && !opts.noCache) {
    const hit = cache.get(workspaceId);
    if (hit && now.getTime() - hit.at < CACHE_TTL_MS) return hit.value;
  }
  const inputs = await loadPolicyInputs(workspaceId, opts.client ?? db);
  const policy = composeEffectivePolicy({ workspace_id: workspaceId, ...inputs, now, graceMs: POLICY_GRACE_MS });
  if (!opts.client) cache.set(workspaceId, { value: policy, at: now.getTime() });
  return policy;
}

/** 批量读取（配置生成用），返回 `Map<workspaceId, EffectivePolicy>`。 */
export async function getEffectivePolicies(
  workspaceIds: readonly number[],
  opts: { now?: Date } = {},
): Promise<Map<number, EffectivePolicy>> {
  const now = opts.now ?? new Date();
  const unique = [...new Set(workspaceIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, EffectivePolicy>();

  // 一次拉全量发放与上限，避免按 workspace 触发 N 次查询。
  const [assignments, ceilings] = await Promise.all([
    db.workspacePolicyAssignment.findMany({
      where: { workspace_id: { in: unique } },
      select: {
        workspace_id: true, source: true, effective_at: true, expires_at: true, revoked_at: true, note: true,
        policy: { select: POLICY_SELECT },
      },
    }),
    db.capabilityPolicy.findMany({ where: { is_ceiling: true, status: "active" }, select: POLICY_SELECT }),
  ]);
  const ceilingRecords = ceilings.map((c) => normalizePolicy(c as unknown as PolicyRow));
  const byWorkspace = new Map<number, PolicyAssignment[]>();
  for (const a of assignments) {
    const list = byWorkspace.get(a.workspace_id) ?? [];
    list.push({
      policy: normalizePolicy(a.policy as unknown as PolicyRow),
      source: asSource(a.source),
      effective_at: a.effective_at,
      expires_at: a.expires_at,
      revoked_at: a.revoked_at,
      note: a.note,
    });
    byWorkspace.set(a.workspace_id, list);
  }
  for (const id of unique) {
    out.set(
      id,
      composeEffectivePolicy({
        workspace_id: id,
        assignments: byWorkspace.get(id) ?? [],
        ceilings: ceilingRecords,
        now,
        graceMs: POLICY_GRACE_MS,
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 用量统计                                                            */
/* ------------------------------------------------------------------ */

export interface WorkspaceUsage {
  tunnels: number;
  nodes: number;
  members: number;
  /** 当前计量周期内已用流量（字节） */
  traffic_used: number;
}

/** 某 workspace 的有效隧道数（active + inactive 都占额度，与用户预期一致）。 */
export async function countWorkspaceTunnels(workspaceId: number, client: DbLike = db): Promise<number> {
  return client.tunnel.count({ where: { workspace_id: workspaceId } });
}

export async function countWorkspaceNodes(workspaceId: number, client: DbLike = db): Promise<number> {
  return client.node.count({ where: { node_group: { workspace_id: workspaceId } } });
}

export async function countWorkspaceMembers(workspaceId: number, client: DbLike = db): Promise<number> {
  return client.workspaceMember.count({ where: { workspace_id: workspaceId, active: true } });
}

/** 计量周期内已用流量（字节）。total → 全量累计。 */
export async function sumWorkspaceTraffic(
  workspaceId: number,
  period: TrafficPeriodName,
  now: Date = new Date(),
  client: DbLike = db,
): Promise<number> {
  const since = trafficStart(period, now);
  const where: Prisma.TunnelTrafficWhereInput = { tunnel: { workspace_id: workspaceId } };
  if (since) where.date = { gte: since };
  const agg = await client.tunnelTraffic.aggregate({ where, _sum: { traffic: true } });
  return agg._sum.traffic ?? 0;
}

function trafficStart(period: TrafficPeriodName, now: Date): Date | null {
  if (period === "total") return null;
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  if (period === "day") return d;
  d.setDate(1);
  return d;
}

export interface WorkspaceUsageReport extends WorkspaceUsage {
  policy: EffectivePolicy;
  limits: PolicyLimitSet;
}

/** 给 `/api/me/capabilities` 与仪表盘用的完整用量 + 限额视图。 */
export async function getWorkspaceUsageReport(
  workspaceId: number,
  opts: { now?: Date } = {},
): Promise<WorkspaceUsageReport> {
  const now = opts.now ?? new Date();
  const policy = await getEffectivePolicy(workspaceId, { now });
  const [tunnels, nodes, members, traffic_used] = await Promise.all([
    countWorkspaceTunnels(workspaceId),
    countWorkspaceNodes(workspaceId),
    countWorkspaceMembers(workspaceId),
    sumWorkspaceTraffic(workspaceId, policy.limits.traffic_period, now),
  ]);
  return { tunnels, nodes, members, traffic_used, policy, limits: policy.limits };
}

/* ------------------------------------------------------------------ */
/* 事务性发放免费策略                                                  */
/* ------------------------------------------------------------------ */

/**
 * 新建 workspace 时在同一事务内发放免费默认策略。
 * 幂等：同一 workspace 重复调用只会 upsert 同一条发放。
 */
export async function assignDefaultPolicy(
  tx: Prisma.TransactionClient,
  workspace: { id: number; kind: "personal" | "team" },
): Promise<void> {
  const key = workspace.kind === "team" ? DEFAULT_POLICY_KEYS.team : DEFAULT_POLICY_KEYS.personal;
  const policy = await tx.capabilityPolicy.findFirst({ where: { key, status: "active" }, select: { id: true } });
  if (!policy) return; // 模板缺失（老库未迁移）→ 不阻塞注册；由迁移/管理员补齐
  await tx.workspacePolicyAssignment.upsert({
    where: { workspace_id_policy_id: { workspace_id: workspace.id, policy_id: policy.id } },
    create: { workspace_id: workspace.id, policy_id: policy.id, source: "system_default" },
    update: { revoked_at: null, expires_at: null, effective_at: new Date() },
  });
}

/** 已有 workspace 的幂等修复（seed / 迁移后）。 */
export async function ensureDefaultPolicy(workspaceId: number): Promise<void> {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, kind: true } });
  if (!ws) return;
  await db.$transaction(async (tx) => {
    await assignDefaultPolicy(tx, { id: ws.id, kind: ws.kind });
  });
  invalidatePolicyCache(workspaceId);
}

/* ------------------------------------------------------------------ */
/* 并发原子额度守卫                                                    */
/* ------------------------------------------------------------------ */

/** 在事务内对 workspace 行加排他锁；同 workspace 的额度判定串行化。 */
export async function lockWorkspaceRow(tx: Prisma.TransactionClient, workspaceId: number): Promise<void> {
  await tx.$queryRaw`SELECT id FROM workspace WHERE id = ${workspaceId} FOR UPDATE`;
}

/**
 * 在 workspace 行锁保护下执行额度判定 + 落库。
 *
 * 用法：
 * ```ts
 * const result = await withWorkspaceQuotaLock(workspace.id, async (tx, policy) => {
 *   const decision = checkTunnelCreation(policy, { tunnelCount, ... });
 *   if (!decision.allowed) return { denied: decision };
 *   const tunnel = await tx.tunnel.create({...});
 *   return { tunnel };
 * });
 * ```
 * 传入的 `policy` 在锁内以 `noCache` 方式重新读取，保证看到最新发放。
 */
export async function withWorkspaceQuotaLock<T>(
  workspaceId: number,
  fn: (tx: Prisma.TransactionClient, policy: EffectivePolicy) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await lockWorkspaceRow(tx, workspaceId);
    const policy = await getEffectivePolicy(workspaceId, { client: tx, noCache: true });
    return fn(tx, policy);
  });
}
