/**
 * 审计日志 —— 纯逻辑（路径归一化 / 资源解析 / 敏感判定 / actor 分类）+ 写入器
 *
 * 与中间件（`src/middlewares/audit.ts`）分离：本模块的纯函数可离线单测，
 * 写入器用 {@link AuditSink} 抽象，测试注入 fake 即可断言写入内容。
 *
 * ── 记录什么 ──
 *  谁（actor）· 何时（created_at）· 在什么上下文（ip / ua）· 对什么资源
 *  （resource + resource_id）· 做了什么（action = `METHOD 归一化路径`）· 结果（status）。
 *  **不落请求体**：避免把密码 / 卡片 / 验证码等敏感内容带进日志。
 */
import { db } from "../db.ts";

/* ================================================================== */
/* 类型                                                               */
/* ================================================================== */

export type AuditActorType = "user" | "super_admin" | "admin" | "system" | "anonymous";

/** 操作者摘要（来自 authRequired 注入的 user，或匿名/system）。 */
export interface AuditActor {
  id?: number | null;
  email?: string | null;
  super_admin?: boolean;
  admin_roles?: unknown[] | null;
}

/** 一条审计记录（写入前的形态，不含 id/created_at）。 */
export interface AuditEntry {
  actor_type: AuditActorType;
  actor_id: number | null;
  actor_email: string | null;
  action: string;
  resource: string;
  resource_id: string | null;
  method: string;
  path: string;
  status: number;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown> | null;
}

/** 写入器接口（默认 Prisma；测试注入 fake）。 */
export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

/* ================================================================== */
/* 常量                                                               */
/* ================================================================== */

/** action 列宽 191：超长截断。 */
export const MAX_ACTION_LEN = 191;
const MAX_IP_LEN = 64;
const MAX_UA_LEN = 255;
const MAX_PATH_LEN = 255;

/**
 * 敏感路径片段：命中后**强制丢弃 metadata**，且（对 GET）也纳入审计，
 * 因为这些端点触及凭据 / 令牌语义。
 */
const SENSITIVE_RE =
  /(password|passwd|secret|token|credential|reset|verify|otp|code|callback|impersonation|api[_-]?key|card|cvv|payment|login|register|forgot)/i;

/** 不产生审计的公共健康检查。 */
const SKIP_PREFIXES = ["/healthz", "/readyz", "/socket.io", "/_next", "/favicon", "/openapi.json", "/docs", "/queuedash"];

/* ================================================================== */
/* 纯逻辑                                                             */
/* ================================================================== */

/** 路径归一化：数字段 → `:id`，去掉 query，截断到 255。 */
export function normalizePath(path: string): string {
  const noQuery = path.split("?")[0];
  const normalized = noQuery
    .split("/")
    .map((seg) => (/^\d+$/.test(seg) ? ":id" : seg))
    .join("/");
  return normalized.slice(0, MAX_PATH_LEN);
}

/** 解析资源名与资源主键：`/api/admin/users/5/roles` → { resource:"admin/users", resource_id:"5" }。 */
export function analyzePath(path: string): { resource: string; resourceId: string | null } {
  const segs = path.split("?")[0].split("/").filter(Boolean);
  if (segs[0] === "api") segs.shift();
  let resourceId: string | null = null;
  const named: string[] = [];
  for (const seg of segs) {
    if (/^\d+$/.test(seg)) {
      if (resourceId === null) resourceId = seg;
      continue;
    }
    named.push(seg);
  }
  const resource = (named.slice(0, 2).join("/") || "root").slice(0, 64);
  return { resource, resourceId };
}

/** 组装 action：`METHOD 归一化路径`。 */
export function buildAction(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`.slice(0, MAX_ACTION_LEN);
}

/** 是否敏感路径（应丢弃 metadata）。 */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_RE.test(path.split("?")[0]);
}

/**
 * 是否应记录该请求。
 *
 * 策略（在「可审计」与「不淹没日志」之间取平衡）：
 *  · 只审计 `/api/*`（其余静态/健康检查跳过）；
 *  · 非 GET（POST/PATCH/PUT/DELETE）一律记录 —— 所有变更都要留痕；
 *  · GET/HEAD 仅在「管理端读取」或「敏感路径」时记录 —— 普通用户的列表/详情
 *    轮询（dashboard、/auth/me）量大且无变更语义，不入库。
 */
export function shouldAudit(path: string, method: string): boolean {
  const p = path.split("?")[0];
  if (SKIP_PREFIXES.some((pre) => p.startsWith(pre))) return false;
  if (!p.startsWith("/api/")) return false;
  const m = method.toUpperCase();
  const isRead = m === "GET" || m === "HEAD" || m === "OPTIONS";
  if (!isRead) return true;
  if (p.startsWith("/api/admin/")) {
    // 读取审计日志本身不记录：否则每次刷新审计页都会再写一条，噪音自增。
    if (p.startsWith("/api/admin/audit-logs")) return false;
    return true;
  }
  return isSensitivePath(p);
}

/** 分类操作者：super_admin > admin（有后台角色） > user > anonymous。 */
export function classifyActor(user: AuditActor | null | undefined): AuditActorType {
  if (!user) return "anonymous";
  if (user.super_admin) return "super_admin";
  if (Array.isArray(user.admin_roles) && user.admin_roles.length > 0) return "admin";
  return "user";
}

/** 截断工具。 */
function clip(v: string | null | undefined, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s ? s.slice(0, max) : null;
}

/** 由请求上下文构造审计记录（纯函数，便于单测）。 */
export function buildAuditEntry(input: {
  method: string;
  path: string;
  status: number;
  ip?: string | null;
  userAgent?: string | null;
  user?: AuditActor | null;
  metadata?: Record<string, unknown> | null;
}): AuditEntry {
  const path = input.path.split("?")[0];
  const { resource, resourceId } = analyzePath(path);
  const actorType = classifyActor(input.user);
  // 敏感端点一律丢弃 metadata，杜绝把凭据/令牌写进日志。
  const metadata = isSensitivePath(path) ? null : (input.metadata ?? null);
  return {
    actor_type: actorType,
    actor_id: input.user?.id ?? null,
    actor_email: clip(input.user?.email ?? null, 255),
    action: buildAction(input.method, path),
    resource,
    resource_id: resourceId,
    method: input.method.toUpperCase().slice(0, 10),
    path: path.slice(0, MAX_PATH_LEN),
    status: Number.isFinite(input.status) ? Math.trunc(input.status) : 0,
    ip: clip(input.ip ?? null, MAX_IP_LEN),
    user_agent: clip(input.userAgent ?? null, MAX_UA_LEN),
    metadata,
  };
}

/* ================================================================== */
/* 写入                                                               */
/* ================================================================== */

/** 默认 Prisma 写入器。 */
export function prismaAuditSink(): AuditSink {
  return {
    async write(entry) {
      await db.auditLog.create({
        data: {
          actor_type: entry.actor_type,
          actor_id: entry.actor_id,
          actor_email: entry.actor_email,
          action: entry.action,
          resource: entry.resource,
          resource_id: entry.resource_id,
          method: entry.method,
          path: entry.path,
          status: entry.status,
          ip: entry.ip,
          user_agent: entry.user_agent,
          metadata: entry.metadata === null ? undefined : (entry.metadata as object),
        },
      });
    },
  };
}

let sink: AuditSink = prismaAuditSink();

/** 覆盖写入器（测试用）。 */
export function setAuditSink(next: AuditSink): void {
  sink = next;
}

/** 复位为默认 Prisma 写入器。 */
export function resetAuditSink(): void {
  sink = prismaAuditSink();
}

/**
 * 写入一条审计记录。**永不抛出**：审计是旁路副作用，失败只打日志，
 * 绝不能影响主业务响应（与配置刷新 hook 同样的取向）。
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await sink.write(entry);
  } catch (e) {
    console.warn("[audit] write failed:", (e as Error)?.message ?? e);
  }
}

/** fire-and-forget 封装。 */
export function enqueueAudit(entry: AuditEntry): void {
  void writeAudit(entry);
}
