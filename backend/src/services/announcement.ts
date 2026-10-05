/**
 * V5-WP18.5 —— 公告（契约 §F6 / §7 DoD6、DoD7、DoD8）。
 *
 * ── 这一层回答什么 ──
 * 「平台/租户写给人的内容」：谁看得见（platform ∪ 本 workspace，**其它 workspace 永不返回**）、
 * 谁读过（每用户一条 dismiss）、同 scope 只能有一条活跃弹窗、正文是纯文本。
 *
 * ── 三条刻意的"不"──
 *  1. **不做 HTML**：正文按纯文本存、按纯文本渲染（`title`/`body` 只做控制字符清理与截断，
 *     不做标签剥离 —— 那等于自研一个正则净化器，正是契约 §2.2/§F6.6 拒绝的东西）。
 *     不引入 HTML 就没有 XSS 面，DoD7 因此是一条可 grep 的断言（全仓零
 *     `dangerouslySetInnerHTML`）。
 *  2. **不猜**：撤回/已读一律先判可见性，不可见与不存在返回**同一个** 404 —— 否则接口会变成
 *     「这个 id 在别的租户存不存在」的探测器。旧 `NOTICE` 迁移来的行没有作者，`created_by_id`
 *     留 NULL，绝不填一个"看起来像"的人。
 *  3. **不新增第二份真相**：公告的内容真相就在 `announcement` 表（C2）；投递账本只描述
 *     「尝试投递」（WP18.2），删光它不影响这里的任何判定。
 *
 * ── 为什么入参类型是 `NotificationScope` 而不是自定义的 `{scope_kind, workspace_id}` ──
 * 它与 WP18.1 的 `NotificationScope` **是同一个类型**（判别联合：`kind:"platform"` 时
 * `workspace_id` 只能是 `null`）。契约 F6.2 要求「用结构约束表达，不用约定」——在 TypeScript
 * 里，结构就是判别联合：`createAnnouncement({scope: {kind:"platform", workspace_id: 7}})`
 * 根本编译不过，运行期再由 `isNotificationScope` 挡一次外部输入（JSON 边界）。
 *
 * ── db 依赖是注入的普通对象 ──
 * 与 `notification-delivery.ts` / `ddns-binding.ts` 同一取向：本模块**不 import 生成的
 * Prisma client**。要断言"可见性/已读/弹窗唯一"这些规则的调用方，不该被 db 拽进模块图。
 */
import { isUniqueViolation, NOTIFICATION_RENDER_LIMITS } from "./notification-delivery.ts";
import type { RenderedNotification } from "./notification-delivery.ts";
import { isNotificationScope } from "./notification-facts.ts";
import type { NotificationScope } from "./notification-facts.ts";
import { scopeTag } from "../tenant-scope.ts";

/* ================================================================== */
/* 作用域与类型（F6.1 / F6.2 / F6.3）                                  */
/* ================================================================== */

/** 公告作用域 = **同一个** `NotificationScope`（平台 ⟹ `workspace_id === null`）。 */
export type AnnouncementScope = NotificationScope;

/**
 * 运行期形状校验（路由的 JSON 边界用）。
 *
 * **是别名而不是包装函数**：包装一层就等于"同一份判定"变成两份实现（今天一模一样，
 * 明天有人给其中一份加一条规则）。别名让"公告与通知用同一套作用域形状"成为**结构性**事实 ——
 * 单测用 `toBe` 钉住这一点。
 */
export const isAnnouncementScope = isNotificationScope;

/** 公告类型（闭集）。`upgrade_popup` 不移植：TuneX 没有权威版本矩阵（契约 O3）。 */
export const ANNOUNCEMENT_TYPES = ["normal", "popup"] as const;
export type AnnouncementType = (typeof ANNOUNCEMENT_TYPES)[number];

export function isAnnouncementType(value: unknown): value is AnnouncementType {
  return typeof value === "string" && (ANNOUNCEMENT_TYPES as readonly string[]).includes(value);
}

/** 作用域 → 落库列。**唯一**的转换点：写路径只从这里取值，platform 永远配 `NULL`。 */
export function announcementScopeColumns(scope: AnnouncementScope): {
  scope_kind: "platform" | "workspace";
  workspace_id: number | null;
} {
  return scope.kind === "platform"
    ? { scope_kind: "platform", workspace_id: null }
    : { scope_kind: "workspace", workspace_id: scope.workspace_id };
}

/**
 * 活跃弹窗的**结构唯一键**（落 `announcement.active_popup_key`，该列上有唯一索引）。
 *
 * 为什么不是 `@@unique([scope_kind, workspace_id, type])`：MySQL 的唯一索引把 NULL 视为
 * 互不相等，平台行（`workspace_id IS NULL`）之间永远不冲突 —— 约束形同虚设，正是
 * Forwardx「先关旧的再插新的」在并发下留下两条活跃弹窗的原因（F6.3）。
 * 把「哪一格被占」写成非空标量之后，第二条活跃弹窗会被 **DB**拒绝，而不是靠调用方自觉。
 *
 * 前缀 `popup:` 是有意的：将来若出现别的"同 scope 只允许一条"的槽位，它们各有各的键空间，
 * 不会互相顶掉（改这个名字等于改已落库的值，所以现在就写清楚）。
 */
export function activePopupKey(scope: AnnouncementScope): string {
  return `popup:${scopeTag(scope.workspace_id)}`;
}

/* ================================================================== */
/* 正文与标题：纯文本（F6.6）                                          */
/* ================================================================== */

/**
 * 长度上限。`TITLE_MAX` 与列宽（`VARCHAR(200)`）一致；
 * `BODY_MAX` **不是**列宽：MySQL 的 `TEXT` 上限是 65535 **字节**不是字符，
 * 按字符截断必须给多字节字符留余量（4 字节/字符 → 10000 字符最坏 40KB）。
 * 超限**拒绝**而不是静默截断：公告是给人读的内容，被悄悄砍掉一半比报错更糟。
 */
export const ANNOUNCEMENT_LIMITS = Object.freeze({
  TITLE_MAX: 200,
  BODY_MAX: 10_000,
});

/**
 * 正文/标题的规范形态：CRLF→LF、去掉除 `\n`/`\t` 之外的 C0/C1 控制字符、trim。
 *
 * 为什么**不**剥 HTML 标签：那是自研净化器（契约 §2.2 已论证其失效面），而正文按纯文本
 * 渲染时标签本来就是惰性文本。前端一个 `dangerouslySetInnerHTML` 都不许出现（DoD7）。
 * 为什么留着 `\n`：多行公告是常态；控制字符才是要防的（日志伪造 / 终端转义序列）。
 */
export function normalizeAnnouncementText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex -- 这里要删的正是控制字符（\n \t 除外）。
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return normalized;
}

export function normalizeAnnouncementTitle(value: unknown): string | null {
  const title = normalizeAnnouncementText(value);
  if (title === null) return null;
  const single = title.replace(/\n+/g, " ").trim();
  if (single.length === 0 || single.length > ANNOUNCEMENT_LIMITS.TITLE_MAX) return null;
  return single;
}

export function normalizeAnnouncementBody(value: unknown): string | null {
  const body = normalizeAnnouncementText(value);
  if (body === null) return null;
  if (body.length === 0 || body.length > ANNOUNCEMENT_LIMITS.BODY_MAX) return null;
  return body;
}

/**
 * 渠道渲染（邮件/Telegram 各自再按渠道规则转义）：**纯文本**，无 HTML、无模板引擎
 * （F6.6 / F10）。正文里的换行保留 —— 与 `notification-delivery.ts` 的
 * `sanitizeInterpolation`（剥换行，用于**单行**插值）是两个用途，别混用。
 */
export function renderAnnouncementText(row: {
  title: string;
  body: string;
  type: string;
  published_at: Date;
}): RenderedNotification {
  const subject = `[TuneX][公告] ${row.title}`.slice(0, 200);
  const text = [row.title, "", row.body, "", `— 发布时间 ${row.published_at.toISOString()}`]
    .join("\n")
    .slice(0, NOTIFICATION_RENDER_LIMITS.TEXT_MAX);
  return { subject, text };
}

/* ================================================================== */
/* 行 / 视图                                                           */
/* ================================================================== */

/** 落库行（只列本模块用到的列；与 `model Announcement` 一一对应）。 */
export interface AnnouncementRow {
  id: number;
  scope_kind: string;
  workspace_id: number | null;
  type: string;
  title: string;
  body: string;
  active_popup_key: string | null;
  published_at: Date;
  revoked_at: Date | null;
  created_by_id: number | null;
  created_at: Date;
  updated_at: Date;
}

/** 下发给前端的视图。**不含** `created_by_id`（前端用不到，少一个可枚举字段）。 */
export interface AnnouncementView {
  id: number;
  scope_kind: "platform" | "workspace";
  workspace_id: number | null;
  type: string;
  title: string;
  body: string;
  published_at: string;
  /** 管理列表用：可见列表里恒为 null（撤回后本来就不返回）。 */
  revoked_at: string | null;
  dismissed: boolean;
  dismissed_at: string | null;
}

export function toAnnouncementView(row: AnnouncementRow, dismissedAt: Date | null): AnnouncementView {
  return {
    id: row.id,
    scope_kind: row.scope_kind === "platform" ? "platform" : "workspace",
    workspace_id: row.workspace_id,
    type: row.type,
    title: row.title,
    body: row.body,
    published_at: row.published_at.toISOString(),
    revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
    dismissed: dismissedAt !== null,
    dismissed_at: dismissedAt ? dismissedAt.toISOString() : null,
  };
}

/* ================================================================== */
/* 可见性（F6.2 / DoD6 / R7）                                          */
/* ================================================================== */

/**
 * 租户侧读取的**强制**条件：platform（且 `workspace_id IS NULL`）∪ 本 workspace，且未撤回。
 *
 * `workspace_id: null` 与 `scope_kind: "platform"` 是**并列**的两个条件，不是其中一个：
 * 一个 `scope_kind="platform"` 却带着 `workspace_id` 的行是坏数据，它既不该对所有人可见，
 * 也不该悄悄落进某个租户的列表（`isAnnouncementVisible` 在内存里做同一判定，两道）。
 */
export function visibleAnnouncementWhere(workspaceId: number): {
  revoked_at: null;
  OR: Array<Record<string, unknown>>;
} {
  return {
    revoked_at: null,
    OR: [
      { scope_kind: "platform", workspace_id: null },
      { scope_kind: "workspace", workspace_id: workspaceId },
    ],
  };
}

/** 行级可见性判定（与上面的 where 同一条判据；查询与内存过滤各一道，防漏条件）。 */
export function isAnnouncementVisible(row: AnnouncementRow, workspaceId: number): boolean {
  if (row.revoked_at !== null) return false;
  if (row.scope_kind === "platform") return row.workspace_id === null;
  return row.scope_kind === "workspace" && row.workspace_id === workspaceId;
}

/** 排序：新的在前（同刻用 id 兜底，保证两次查询顺序确定）。 */
export const ANNOUNCEMENT_ORDER_BY = [{ published_at: "desc" as const }, { id: "desc" as const }];

/* ================================================================== */
/* 结果与错误码                                                       */
/* ================================================================== */

export const ANNOUNCEMENT_ERROR_CODES = [
  /** 作用域形状不合法（platform 带 workspace_id / workspace 带坏 id）。 */
  "invalid_scope",
  /** 未知类型（闭集之外）。 */
  "invalid_type",
  /** 标题非法（空 / 超长 / 非字符串）。 */
  "invalid_title",
  /** 正文非法（空 / 超长 / 非字符串）。 */
  "invalid_body",
  /** 不可见 或 不存在 —— **故意不区分**（否则接口变成跨租户探测器）。 */
  "not_found",
  /** 同 scope 已有活跃弹窗（DB 唯一索引拒绝，F6.3）。 */
  "active_popup_exists",
  /** 存储不可用（DB 抛错）。旁路不拖挂主业务，收敛成结果。 */
  "storage_error",
] as const;
export type AnnouncementErrorCode = (typeof ANNOUNCEMENT_ERROR_CODES)[number];

export type AnnouncementResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: AnnouncementErrorCode; error: string };

const ERROR_TEXT: Record<AnnouncementErrorCode, string> = {
  invalid_scope: "公告作用域不合法",
  invalid_type: "公告类型不合法",
  invalid_title: `公告标题必须是 1-${ANNOUNCEMENT_LIMITS.TITLE_MAX} 字的单行文本`,
  invalid_body: `公告正文必须是 1-${ANNOUNCEMENT_LIMITS.BODY_MAX} 字的纯文本`,
  not_found: "公告不存在",
  active_popup_exists: "该作用域已有一条活跃弹窗，请先撤回它",
  storage_error: "公告存储暂时不可用",
};

function fail(code: AnnouncementErrorCode): { ok: false; code: AnnouncementErrorCode; error: string } {
  return { ok: false, code, error: ERROR_TEXT[code] };
}

/* ================================================================== */
/* 注入的存储接口（不 import 生成的 Prisma client）                     */
/* ================================================================== */

export interface AnnouncementDb {
  announcement: {
    findMany(args: Record<string, unknown>): Promise<AnnouncementRow[]>;
    findUnique(args: Record<string, unknown>): Promise<AnnouncementRow | null>;
    create(args: Record<string, unknown>): Promise<AnnouncementRow>;
    update(args: Record<string, unknown>): Promise<AnnouncementRow>;
  };
  announcementDismissal: {
    findMany(args: Record<string, unknown>): Promise<Array<{ announcement_id: number; dismissed_at: Date }>>;
    create(args: Record<string, unknown>): Promise<unknown>;
  };
}

export interface AnnouncementDeps {
  db: AnnouncementDb;
  /** 告警出口：旁路异常在这里留痕，不抛出。 */
  onWarn?: (message: string, err?: unknown) => void;
}

const defaultWarn = (message: string, err?: unknown): void => {
  console.warn(`[announcement] ${message}`, err instanceof Error ? err.message : (err ?? ""));
};

/* ================================================================== */
/* 读：可见列表 + 已读                                                 */
/* ================================================================== */

export interface ListVisibleInput {
  scope: AnnouncementScope;
  userId: number;
  /** 注入时钟只为测试；生产不传。 */
  now?: Date;
}

/**
 * 可见公告 + **当前用户**的已读标记。
 *
 * `dismissed` 由一次「本用户在这批公告里的 dismiss 行」查询决定 —— 不是"读过的就消失"：
 * 契约 F6.5 把已读做成标记，列表仍然返回它（前端可折叠/置灰），
 * 因为「你错过了什么」和「什么还存在」是两个问题。
 */
export async function listVisibleAnnouncements(
  deps: AnnouncementDeps,
  input: ListVisibleInput,
): Promise<AnnouncementResult<AnnouncementView[]>> {
  if (!isAnnouncementScope(input.scope) || input.scope.kind !== "workspace") return fail("invalid_scope");
  const workspaceId = input.scope.workspace_id;
  const warn = deps.onWarn ?? defaultWarn;

  try {
    const rows = await deps.db.announcement.findMany({
      where: visibleAnnouncementWhere(workspaceId),
      orderBy: ANNOUNCEMENT_ORDER_BY,
    });
    // 内存里再过滤一次：查询条件与判定函数是两道（R7 的"查询强制条件"+行级判定）。
    const visible = rows.filter((row) => isAnnouncementVisible(row, workspaceId));
    const ids = visible.map((row) => row.id);
    const dismissed = new Map<number, Date>();
    if (ids.length > 0) {
      const marks = await deps.db.announcementDismissal.findMany({
        where: { user_id: input.userId, announcement_id: { in: ids } },
        select: { announcement_id: true, dismissed_at: true },
      });
      for (const mark of marks) dismissed.set(mark.announcement_id, mark.dismissed_at);
    }
    return { ok: true, value: visible.map((row) => toAnnouncementView(row, dismissed.get(row.id) ?? null)) };
  } catch (err) {
    warn("读取可见公告失败", err);
    return fail("storage_error");
  }
}

/** 管理视角：**恰好**本作用域的公告（含已撤回）。平台侧看 platform，租户侧看自己那条。 */
export async function listAnnouncementsForManagement(
  deps: AnnouncementDeps,
  scope: AnnouncementScope,
): Promise<AnnouncementResult<AnnouncementView[]>> {
  if (!isAnnouncementScope(scope)) return fail("invalid_scope");
  const warn = deps.onWarn ?? defaultWarn;
  const columns = announcementScopeColumns(scope);
  try {
    const rows = await deps.db.announcement.findMany({
      where: columns,
      orderBy: ANNOUNCEMENT_ORDER_BY,
    });
    return {
      ok: true,
      value: rows.map((row) => toAnnouncementView(row, null)),
    };
  } catch (err) {
    warn("读取公告管理列表失败", err);
    return fail("storage_error");
  }
}

export interface DismissInput {
  scope: AnnouncementScope;
  userId: number;
  announcementId: number;
  now?: Date;
}

/** 已读（幂等）：第二次调用返回 `already: true`，不报错 —— 重复点"知道了"不是错误。 */
export async function dismissAnnouncement(
  deps: AnnouncementDeps,
  input: DismissInput,
): Promise<AnnouncementResult<{ announcement_id: number; already: boolean; dismissed_at: string }>> {
  if (!isAnnouncementScope(input.scope) || input.scope.kind !== "workspace") return fail("invalid_scope");
  if (!Number.isInteger(input.announcementId) || input.announcementId <= 0) return fail("not_found");
  const warn = deps.onWarn ?? defaultWarn;

  let row: AnnouncementRow | null;
  try {
    row = await deps.db.announcement.findUnique({ where: { id: input.announcementId } });
  } catch (err) {
    warn("已读前读取公告失败", err);
    return fail("storage_error");
  }
  // 不可见 = 不存在：不泄露「别的租户有没有这条公告」。
  if (!row || !isAnnouncementVisible(row, input.scope.workspace_id)) return fail("not_found");

  const at = input.now ?? new Date();
  try {
    await deps.db.announcementDismissal.create({
      data: { announcement_id: row.id, user_id: input.userId, dismissed_at: at },
    });
    return { ok: true, value: { announcement_id: row.id, already: false, dismissed_at: at.toISOString() } };
  } catch (err) {
    // 唯一索引（announcement_id, user_id）命中 = 已经读过：正常路径，不是错误。
    if (isUniqueViolation(err)) {
      return { ok: true, value: { announcement_id: row.id, already: true, dismissed_at: at.toISOString() } };
    }
    warn("写已读记录失败", err);
    return fail("storage_error");
  }
}

/* ================================================================== */
/* 写：发布 / 撤回                                                     */
/* ================================================================== */

export interface CreateAnnouncementInput {
  scope: AnnouncementScope;
  type: string;
  title: unknown;
  body: unknown;
  /** 发布者（平台侧 = 超管 id）。 */
  userId: number | null;
  /** 注入时钟只为测试；生产不传（= 此刻发布）。 */
  now?: Date;
}

/**
 * 发布公告。
 *
 * **平台作用域不可能带上 workspace_id**（`announcementScopeColumns` 的唯一出口），
 * 所以 DoD6 的「`scope_kind="platform"` 且 `workspace_id != NULL` 的行写不进去」在这里成立：
 * ① 入参类型是判别联合（编译期）；② 运行期 `isAnnouncementScope` 再挡一次（JSON 边界）；
 * ③ 落库值只来自唯一转换点。这一列在 DB 层没有 CHECK 约束 —— 见契约 §12 的取舍记录。
 *
 * 弹窗冲突（同 scope 已有活跃）**拒绝**而不是"先关旧的再插新的"：悄悄撤回另一个管理员
 * 正在用的公告，比一个 409 危险得多；唯一索引让冲突变得可见（F6.3）。
 */
export async function createAnnouncement(
  deps: AnnouncementDeps,
  input: CreateAnnouncementInput,
): Promise<AnnouncementResult<AnnouncementView>> {
  if (!isAnnouncementScope(input.scope)) return fail("invalid_scope");
  if (!isAnnouncementType(input.type)) return fail("invalid_type");
  const title = normalizeAnnouncementTitle(input.title);
  if (title === null) return fail("invalid_title");
  const body = normalizeAnnouncementBody(input.body);
  if (body === null) return fail("invalid_body");

  const warn = deps.onWarn ?? defaultWarn;
  const columns = announcementScopeColumns(input.scope);
  try {
    const row = await deps.db.announcement.create({
      data: {
        ...columns,
        type: input.type,
        title,
        body,
        active_popup_key: input.type === "popup" ? activePopupKey(input.scope) : null,
        published_at: input.now ?? new Date(),
        revoked_at: null,
        created_by_id: input.userId,
      },
    });
    return { ok: true, value: toAnnouncementView(row, null) };
  } catch (err) {
    if (isUniqueViolation(err)) return fail("active_popup_exists");
    warn("发布公告失败", err);
    return fail("storage_error");
  }
}

export interface RevokeAnnouncementInput {
  scope: AnnouncementScope;
  announcementId: number;
  now?: Date;
}

/**
 * 撤回（不是删除）：置 `revoked_at` 并**清掉 `active_popup_key`** ——
 * 不清就等于弹窗槽位被一条已撤回的公告永久占着（下一次发布永远 409）。
 *
 * 作用域必须**恰好相等**（不是"可见"）：平台公告只能由平台侧撤回，租户公告只能由那个租户
 * 撤回。用可见性判定会把"平台公告"误判成租户也能撤回（可见 ⊋ 可管理）。
 */
export async function revokeAnnouncement(
  deps: AnnouncementDeps,
  input: RevokeAnnouncementInput,
): Promise<AnnouncementResult<AnnouncementView>> {
  if (!isAnnouncementScope(input.scope)) return fail("invalid_scope");
  if (!Number.isInteger(input.announcementId) || input.announcementId <= 0) return fail("not_found");
  const warn = deps.onWarn ?? defaultWarn;
  const columns = announcementScopeColumns(input.scope);

  let row: AnnouncementRow | null;
  try {
    row = await deps.db.announcement.findUnique({ where: { id: input.announcementId } });
  } catch (err) {
    warn("撤回前读取公告失败", err);
    return fail("storage_error");
  }
  const owned = row !== null && row.scope_kind === columns.scope_kind && row.workspace_id === columns.workspace_id;
  if (!row || !owned) return fail("not_found");
  if (row.revoked_at !== null) {
    // 已撤回：幂等返回当前行（重复撤回不是错误，也不改时间戳 —— 首次撤回时刻才是事实）。
    return { ok: true, value: toAnnouncementView(row, null) };
  }

  try {
    const updated = await deps.db.announcement.update({
      where: { id: row.id },
      data: { revoked_at: input.now ?? new Date(), active_popup_key: null },
    });
    return { ok: true, value: toAnnouncementView(updated, null) };
  } catch (err) {
    warn("撤回公告失败", err);
    return fail("storage_error");
  }
}
