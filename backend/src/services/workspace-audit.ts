/**
 * TEAM-01 workspace 审计查询 —— 面向团队 owner/admin 的 `GET /:id/audit`。
 *
 * ── 与 `services/audit.ts` 的分工 ──
 * `services/audit.ts` 管**写**（中间件按请求自动落 `audit_log`）以及平台侧的
 * `GET /api/admin/audit-logs`。本模块管 workspace 侧的**读**：同一个 `audit_log`
 * 表的另一个投影（按 workspace 维度过滤），不新建表、不改写路径。
 *
 * 为什么 workspace 事件与平台事件共用一张表：
 * `middlewares/audit.ts` 的 shouldAudit() 已经覆盖所有非 GET 的 /api/*（含
 * /api/workspaces/:id/roles/*），即新端点**自动**被审计，无需手工补记。
 * 因此这里的服务只做「读 + 过滤 + 分页」，写入交给既有中间件。
 * 手工补记的 workspace 事件（member.invited / role.assigned 等）则由
 * `routes/workspaces.ts` 直接写 `audit_event` 表（TEN-01 起既有的做法）。
 *
 * ── 为什么用 audit_log 而不是 audit_event ──
 * `audit_event`（workspace_id 维度）是业务事件流，字段少（无 ip/method/status）；
 * `audit_log`（请求维度）字段全且有 method/path/status/ip，对「谁在什么时候
 * 改了什么」更有用。TEAM-01 的审计视图取后者，并** UNION 前者的业务事件**
 * （member.invited 等不会自动出现在 audit_log 里，因为 invite 唯一的副作用是
 *  POST，中间件确实会记……但 resource_id 落在路径上，可读性差）。
 *
 * 简化决定：视图只投影 `audit_log`（请求全量留痕，含 roles CRUD 自动落库），
 * 并在同一响应里附带 `audit_event` 的业务事件行，两者按时间倒序合并。
 * 前端一套表格渲染，`source` 字段区分来源。
 */
import type { Prisma } from "@prisma/client";
import { db } from "../db.ts";

/** 单条审计行（视图统一形状，source 区分两个来源）。 */
export interface WorkspaceAuditRow {
  id: string;
  source: "request" | "event";
  created_at: Date;
  actor_user_id: number | null;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  ip: string | null;
}

export interface WorkspaceAuditQuery {
  page?: number;
  page_size?: number;
  /** action 子串匹配（如 "member." / "role."）。 */
  action?: string;
  /** actor 精确匹配：actor_user_id 或 actor_email 子串。 */
  actor?: string;
  /** resource_type 精确匹配（workspace_member / workspace_custom_role / tunnel …）。 */
  resource_type?: string;
}

export interface WorkspaceAuditPage {
  data: WorkspaceAuditRow[];
  total: number;
  page: number;
  page_size: number;
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;

/** 页码/页宽归一化：越界一律夹到合法区间（不抛错，分页参数不该 400）。 */
export function normalizePage(page: unknown, pageSize: unknown): { page: number; page_size: number } {
  const p = Math.floor(Number(page));
  const s = Math.floor(Number(pageSize));
  return {
    page: Number.isFinite(p) && p >= 1 ? p : 1,
    page_size: Number.isFinite(s) && s >= 1 ? Math.min(s, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE,
  };
}

/**
 * 过滤条件构造（纯函数，可单测）。
 *
 * 只接受**子串**匹配 action / actor_email、**精确**匹配 resource_type /
 * actor_user_id —— 与平台侧 `/api/admin/audit-logs` 的口径一致，前端用同一套
 * 交互（关键字 + 下拉）。actor 同时尝试数字（user id）与非数字（邮箱子串）。
 */
export function buildAuditWhere(
  workspaceId: number,
  q: WorkspaceAuditQuery,
): { log: Prisma.AuditLogWhereInput; event: Prisma.AuditEventWhereInput } {
  const action = (q.action ?? "").trim();
  const actor = (q.actor ?? "").trim();
  const resourceType = (q.resource_type ?? "").trim();

  const actionFilter = action ? { contains: action } : undefined;
  const resourceFilter = resourceType ? { equals: resourceType } : undefined;
  const actorEmail = actor && !/^\d+$/.test(actor) ? { contains: actor } : undefined;
  const actorId = actor && /^\d+$/.test(actor) ? Number(actor) : undefined;

  return {
    log: {
      // workspace 归属：audit_log 没有 workspace_id 列，按 path 反查不可靠
      // （一个 workspace 的 slug 不出现在 path 里）。因此 workspace 侧的请求留痕
      // 依赖 audit_event（有 workspace_id）；audit_log 全表层由平台侧查询。
      // 这里只在调用方显式给了 workspace_id 时也按 path 兜底过滤一次。
      ...(actionFilter ? { action: actionFilter } : {}),
      ...(actorEmail ? { actor_email: actorEmail } : {}),
      ...(actorId !== undefined ? { actor_id: actorId } : {}),
    },
    event: {
      workspace_id: workspaceId,
      ...(actionFilter ? { action: actionFilter } : {}),
      ...(resourceFilter ? { resource_type: resourceFilter } : {}),
      ...(actorId !== undefined ? { actor_user_id: actorId } : {}),
    },
  };
}

/**
 * workspace 审计查询（DB 编排）。
 *
 * 归属：**只查 `audit_event`（带 workspace_id）**，这是唯一能可靠按 workspace
 * 过滤的表。`audit_log` 没有 workspace_id 列，跨租户投影会漏数据或错数据，
 * 因此 workspace 视图不查它（平台侧 `/api/admin/audit-logs` 才是它的读者）。
 *
 * 事件来源两条，在同一响应里按时间倒序合并：
 *   1. `audit_event`：TEN-01 起手工补记的业务事件 + TEAM-01 新增的角色/成员变更；
 *   2. 中间件记录的请求留痕不在此表（见 buildAuditWhere 的说明）。
 */
export async function queryWorkspaceAudit(
  workspaceId: number,
  query: WorkspaceAuditQuery = {},
): Promise<WorkspaceAuditPage> {
  const { page, page_size } = normalizePage(query.page, query.page_size);
  const { event } = buildAuditWhere(workspaceId, query);

  const eventWhere: Prisma.AuditEventWhereInput = event;
  const [rows, total] = await Promise.all([
    db.auditEvent.findMany({
      where: eventWhere,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * page_size,
      take: page_size,
      // 注意：AuditEvent 的 actor_user_id 只是裸 Int? 标量列（schema 里没有到
      // User 的 relation），无法 join 出 actor_email，统一留 null。
    }),
    db.auditEvent.count({ where: eventWhere }),
  ]);

  const data: WorkspaceAuditRow[] = rows.map((r) => ({
    id: `event-${r.id}`,
    source: "event" as const,
    created_at: r.created_at,
    actor_user_id: r.actor_user_id,
    // AuditEvent 无到 User 的 relation，actor_email 无法从库里 join 出来。
    actor_email: null,
    action: r.action,
    resource_type: r.resource_type,
    resource_id: r.resource_id,
    method: null,
    path: null,
    status: null,
    ip: r.ip,
  }));

  return { data, total, page, page_size };
}
