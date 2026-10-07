/**
 * N4 —— 投递账本的**只读投影**（用户域，严格 workspace 作用域）。
 *
 * ── 为什么必须存在 ──
 * `notification_delivery` 此前**只写不读**：投递失败（被拒的目标、解不开的凭据、账本/存储不可用）
 * 在界面与支持包里都看不见。这是"把投递失败说成已通知"最容易发生的地方，也是本专项
 * "失败可见"纪律的落点。
 *
 * ── 三条硬纪律 ──
 *  1. **严格 workspace 作用域**：查询条件写死 `scope_kind="workspace" AND workspace_id=<当前空间>`。
 *     平台行（`workspace_id IS NULL`）在结构上就**匹配不到**——不是"查出来再过滤"，
 *     而是根本不可能出现在结果里（"平台行不得下发给租户"的可执行形式）。
 *  2. **一律读服务端字段，前端只重排不推断**：`status`/`failure_reason`/`attempts`/`degraded`
 *     全部是账本列；`failure_reason` 是**闭集**（`NOTIFICATION_FAILURE_REASONS`，6 态），
 *     不认识的取值不猜、原样透出并标注（它意味着"有新的失败原因码"，而不是"正常"）。
 *  3. **凭据与"别人的联系方式"都不出现**（这条比"失败可见"更容易被忽略，写明白）：
 *     账本的 `target` 是**收件人标识**（邮箱地址 / telegram chat id / webhook URL）。一个空间的
 *     任何活跃成员都能读这个投影，所以**不能**把同事的邮箱原样展示给全空间——那与收益不成比例。
 *     因此：`target` **对所有人一律脱敏**（见 {@link maskDeliveryTarget}），只保留"这是哪个渠道、
 *     一共有几个目标"这一层诊断信息；`targets_count` 由服务端数出来，前端不猜。
 *     另外 `error` 会**按渠道再脱敏一遍**（webhook 走 `redactWebhookDetail`、telegram/email 用
 *     原有剥换行+截断并把该行的原始目标替换掉），无法安全脱敏的渠道就**只给 `failure_reason`**。
 *     （"分辨是不是本人"需要把 target 反查回用户，而账本**不存 user_id**；为一层展示去做
 *      反查既脆弱又容易被绕过 —— 一律脱敏更简单、也更安全。）
 *
 * ── 空账本 ≠ "一切正常"（这是本端点最容易被读错的地方，写在这里免得下一个人踩）──
 * 账本记录的是**尝试过的投递**（含被拒/未配置留下的失败行）。而"一个渠道都没打开"、
 * "事实触发器没接线"这类情形下后端**根本不会调用投递层**（有意如此：避免用 `not_configured`
 * 把失败可见稀释成噪音）。所以 `total=0` 的含义是"**这段时间没有投递记录**"，不是"没有失败"、
 * 更不是"通知都在正常工作"。界面必须照这个说法写，服务端不替它下结论。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { resolveWorkspaceMembership } from "../services/workspace.ts";
import { isValidEmailTarget, NOTIFICATION_FAILURE_REASONS } from "../services/notification-delivery.ts";
import { isValidTelegramChatId, redactTelegramToken } from "../services/notification-telegram.ts";
import { redactWebhookDetail, redactWebhookTarget } from "../services/notification-webhook.ts";

export const notificationDeliveryRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

/* ================================================================== */
/* 存储形状与依赖                                                       */
/* ================================================================== */

/** 本模块只认账本这几列（`SELECT` 出来直接用）。 */
export interface DeliveryLedgerRow {
  id: number;
  scope_kind: string;
  workspace_id: number | null;
  source_kind: string;
  source_id: string;
  reason_code: string;
  severity: string;
  resource_type: string;
  resource_id: string;
  channel_kind: string;
  target: string;
  status: string;
  failure_reason: string | null;
  attempts: number;
  degraded: boolean;
  error: string | null;
  occurred_at: Date | string;
  window_start: Date | string;
  created_at?: Date | string | null;
}

export interface DeliveryLedgerDb {
  notificationDelivery: {
    findMany(args: Record<string, unknown>): Promise<DeliveryLedgerRow[]>;
  };
}

function deps(): DeliveryLedgerDb {
  return db as unknown as DeliveryLedgerDb;
}

/* ================================================================== */
/* 闭集与校验                                                          */
/* ================================================================== */

/** `status` 的闭集（schema 注释：sending | sent | failed）。 */
export const DELIVERY_STATUSES = ["sending", "sent", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** 失败原因的 6 态闭集 —— **直接复用投递层的词表**，不另抄一份。 */
export const DELIVERY_FAILURE_REASONS = NOTIFICATION_FAILURE_REASONS;

/** 分页上限：账本会随时间增长，一次最多 200 行（超出由 `truncated` 显式告知，不静默截断）。 */
export const DELIVERY_PAGE_MAX = 200;
export const DELIVERY_PAGE_DEFAULT = 50;

/** 无过滤条件的默认查询（详情端点只按 id 取，不需要过滤条件）。 */
export const DEFAULT_DELIVERY_QUERY: DeliveryQuery = {
  limit: DELIVERY_PAGE_DEFAULT,
  status: null,
  failure_reason: null,
  channel_kind: null,
  source_kind: null,
};

export interface DeliveryQuery {
  limit: number;
  status: DeliveryStatus | null;
  failure_reason: string | null;
  channel_kind: string | null;
  source_kind: string | null;
}

export type DeliveryQueryResult =
  | { ok: true; query: DeliveryQuery }
  | { ok: false; code: "invalid_filter"; message: string };

function positiveInt(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 解析查询参数。**fail-closed**：不认识的 `status` / `failure_reason` 一律 400，
 * 而不是"忽略这个过滤条件然后返回全部"——后者会让调用者以为自己在看"那一类失败"。
 */
export function parseDeliveryQuery(params: Record<string, string | undefined>): DeliveryQueryResult {
  const limit = positiveInt(params.limit, DELIVERY_PAGE_DEFAULT);
  if (limit === null || limit > DELIVERY_PAGE_MAX) {
    return { ok: false, code: "invalid_filter", message: `limit 必须是 1..${DELIVERY_PAGE_MAX} 的整数` };
  }
  const status = params.status ?? null;
  if (status !== null && !(DELIVERY_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, code: "invalid_filter", message: `未知的 status（闭集：${DELIVERY_STATUSES.join(" / ")}）` };
  }
  const failureReason = params.failure_reason ?? null;
  if (failureReason !== null && !(DELIVERY_FAILURE_REASONS as readonly string[]).includes(failureReason)) {
    return {
      ok: false,
      code: "invalid_filter",
      message: `未知的 failure_reason（闭集：${DELIVERY_FAILURE_REASONS.join(" / ")}）`,
    };
  }
  return {
    ok: true,
    query: {
      limit,
      status: status as DeliveryStatus | null,
      failure_reason: failureReason,
      channel_kind: params.channel_kind ?? null,
      source_kind: params.source_kind ?? null,
    },
  };
}

/* ================================================================== */
/* 投影（纯函数）                                                       */
/* ================================================================== */

/**
 * 目标的**可回显**形态。**一律脱敏**（见文件头 ③）：
 *  · email → 只留域名（`***@example.com`）：能看出"发给哪个域"，看不出是谁；
 *  · telegram → 整个 chat id 就是个人标识 ⇒ 全掩码 `***`；
 *  · webhook → 复用 `redactWebhookTarget`（origin + 摘要，与账本写入同一份实现）；
 *  · 未知渠道 → `***`（原文可能是误填进来的凭据）。
 * 账本把多个目标用 `,` 连起来存（邮箱/chat id/脱敏 URL 都不会含逗号），所以逐段脱敏后重连，
 * 并用 `count` 保留"这条通知一共投给了几个目标"这一层诊断信息。
 */
export function maskDeliveryTarget(row: { channel_kind: string; target: string }): {
  target: string;
  target_masked: boolean;
  count: number;
} {
  const raw = typeof row.target === "string" ? row.target : "";
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return { target: "", target_masked: false, count: 0 };
  const masked = parts.map((part) => {
    switch (row.channel_kind) {
      case "webhook": {
        // 账本写入时已经脱敏过一次（`origin/***摘要`）：这种形态原样保留，
        // 免得同一行在这里算出**另一个**摘要、让"账本里的目标"与"界面上的目标"对不上。
        if (/^https?:\/\/[^\s/]+\/\*\*\*[0-9a-f]{12}$/.test(part)) return part;
        return redactWebhookTarget(part);
      }
      case "email": {
        const at = part.lastIndexOf("@");
        // 本地部分就是"人"：只留域名；连域都没有（形状不对）⇒ 全掩码。
        return at > 0 && isValidEmailTarget(part) ? `***${part.slice(at)}` : "***";
      }
      case "telegram":
        return "***";
      default:
        return "***";
    }
  });
  return { target: masked.join(","), target_masked: true, count: parts.length };
}

/** 向后兼容的窄接口（只关心形态的调用方/测试用）。 */
export function projectDeliveryTarget(row: { channel_kind: string; target: string }): {
  target: string;
  target_masked: boolean;
} {
  const { target, target_masked } = maskDeliveryTarget(row);
  return { target, target_masked };
}

/**
 * 错误摘要：剥换行 + 截断 + **按渠道再脱敏一遍**，并把该行的原始目标（完整地址/chat id/URL）
 * 替换成脱敏形态 —— 错误原文里常常带着目标（`RCPT TO:<a@b>`、`request to <url> failed`）。
 * 无法安全脱敏的渠道（未知 kind）**只给 `failure_reason`**：宁可少给，不给泄漏。
 */
export function projectDeliveryError(
  channelKind: string,
  error: string | null,
  rawTarget = "",
): string | null {
  if (typeof error !== "string" || error === "") return null;
  if (channelKind === "webhook") return redactWebhookDetail(error, rawTarget === "" ? null : rawTarget);
  if (channelKind === "telegram") {
    const collapsed = redactTelegramToken(error);
    return rawTarget === "" ? collapsed : collapsed.split(rawTarget).join("***");
  }
  if (channelKind === "email") {
    const collapsed = error.replace(/[\r\n\t]+/g, " ").trim().slice(0, 300);
    return rawTarget === "" ? collapsed : collapsed.split(rawTarget).join("***");
  }
  return null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value !== "") return value;
  return null;
}

export interface DeliveryRowProjection {
  id: number;
  status: string;
  /** 是不是闭集内的失败原因（`false` = 出现了新码：原样透出并标注，不猜）。 */
  failure_reason_known: boolean;
  failure_reason: string | null;
  attempts: number;
  /** 静默期降级（Redis 不可用 ⇒ 抑制可能失效、**可能多报**）。这是独立事实，不与 failed 混。 */
  degraded: boolean;
  channel_kind: string;
  /** 已脱敏的目标（一律脱敏，见文件头 ③）。 */
  target: string;
  target_masked: boolean;
  /** 这条通知一共投给了几个目标（服务端数出来的，前端不猜）。 */
  targets_count: number;
  error: string | null;
  source_kind: string;
  source_id: string;
  reason_code: string;
  severity: string;
  resource_type: string;
  resource_id: string;
  occurred_at: string | null;
  window_start: string | null;
}

export function projectDeliveryRow(row: DeliveryLedgerRow): DeliveryRowProjection {
  const target = maskDeliveryTarget(row);
  const reason = typeof row.failure_reason === "string" && row.failure_reason !== "" ? row.failure_reason : null;
  return {
    id: Number(row.id),
    status: String(row.status ?? "sending"),
    failure_reason: reason,
    failure_reason_known: reason === null || (DELIVERY_FAILURE_REASONS as readonly string[]).includes(reason),
    attempts: Number.isFinite(Number(row.attempts)) ? Number(row.attempts) : 0,
    degraded: row.degraded === true,
    channel_kind: String(row.channel_kind ?? ""),
    target: target.target,
    target_masked: target.target_masked,
    targets_count: target.count,
    error: projectDeliveryError(String(row.channel_kind ?? ""), row.error, String(row.target ?? "")),
    source_kind: String(row.source_kind ?? ""),
    source_id: String(row.source_id ?? ""),
    reason_code: String(row.reason_code ?? ""),
    severity: String(row.severity ?? ""),
    resource_type: String(row.resource_type ?? ""),
    resource_id: String(row.resource_id ?? ""),
    occurred_at: toIso(row.occurred_at),
    window_start: toIso(row.window_start),
  };
}

export interface DeliverySummary {
  total: number;
  sent: number;
  failed: number;
  sending: number;
  /** `degraded=true` 的行数（与 `failed` 正交：一次成功投递也可能带着降级标记）。 */
  degraded: number;
  /** 失败原因 → 行数（闭集外的码也会出现在这里，键就是原样取值）。 */
  by_failure_reason: Record<string, number>;
}

/** 汇总由**服务端**算（前端不推断）：同一份行、同一个判据，避免两处口径分叉。 */
export function summarizeDeliveries(rows: readonly DeliveryRowProjection[]): DeliverySummary {
  const summary: DeliverySummary = { total: rows.length, sent: 0, failed: 0, sending: 0, degraded: 0, by_failure_reason: {} };
  for (const row of rows) {
    if (row.status === "sent") summary.sent += 1;
    else if (row.status === "failed") summary.failed += 1;
    else if (row.status === "sending") summary.sending += 1;
    if (row.degraded) summary.degraded += 1;
    if (row.status === "failed" && row.failure_reason !== null) {
      summary.by_failure_reason[row.failure_reason] = (summary.by_failure_reason[row.failure_reason] ?? 0) + 1;
    }
  }
  return summary;
}

/* ================================================================== */
/* 路由                                                                */
/* ================================================================== */

function workspaceScope(workspaceId: number): Record<string, unknown> {
  // 结构条件：平台行（workspace_id IS NULL）永远匹配不到。
  return { scope_kind: "workspace", workspace_id: workspaceId };
}

async function loadRows(
  workspaceId: number,
  query: DeliveryQuery,
  extraWhere: Record<string, unknown> = {},
): Promise<{ rows: DeliveryLedgerRow[]; truncated: boolean }> {
  const rows = await deps().notificationDelivery.findMany({
    where: {
      ...workspaceScope(workspaceId),
      ...(query.status !== null ? { status: query.status } : {}),
      ...(query.failure_reason !== null ? { failure_reason: query.failure_reason } : {}),
      ...(query.channel_kind !== null ? { channel_kind: query.channel_kind } : {}),
      ...(query.source_kind !== null ? { source_kind: query.source_kind } : {}),
      ...extraWhere,
    },
    orderBy: [{ id: "desc" }],
    // 多取一行只为判定"还有更多"：静默截断会让"最近 50 条都成功"看起来像"全部成功"。
    take: query.limit + 1,
  });
  const truncated = rows.length > query.limit;
  return { rows: truncated ? rows.slice(0, query.limit) : rows, truncated };
}

function readParams(c: Ctx): Record<string, string | undefined> {
  const url = new URL(c.req.url);
  const out: Record<string, string | undefined> = {};
  for (const key of ["limit", "status", "failure_reason", "channel_kind", "source_kind"]) {
    const value = url.searchParams.get(key);
    out[key] = value === null ? undefined : value;
  }
  return out;
}

notificationDeliveryRoutes.get("/deliveries", async (c) => {
  const access = await resolveWorkspaceMembership(c);
  const parsed = parseDeliveryQuery(readParams(c));
  if (!parsed.ok) return c.json({ error: parsed.message, code: parsed.code, error_layer: "notification_delivery" }, 400);

  let loaded: { rows: DeliveryLedgerRow[]; truncated: boolean };
  try {
    loaded = await loadRows(access.id, parsed.query);
  } catch {
    // 读不到 ≠ "没有失败记录"：两者绝不能同形。
    return c.json(
      {
        error: "投递账本读取失败（存储不可用）：这不等于「没有失败记录」",
        code: "storage_error",
        error_layer: "notification_delivery",
      },
      503,
    );
  }
  const rows = loaded.rows.map(projectDeliveryRow);
  return c.json({
    data: {
      scope_kind: "workspace",
      workspace_id: access.id,
      truncated: loaded.truncated,
      limit: parsed.query.limit,
      summary: summarizeDeliveries(rows),
      rows,
    },
  });
});

notificationDeliveryRoutes.get("/deliveries/:id", async (c) => {
  const access = await resolveWorkspaceMembership(c);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ error: "id 必须是正整数", code: "invalid_id", error_layer: "notification_delivery" }, 400);
  }
  let loaded: { rows: DeliveryLedgerRow[]; truncated: boolean };
  try {
    loaded = await loadRows(access.id, DEFAULT_DELIVERY_QUERY, { id });
  } catch {
    return c.json(
      { error: "投递账本读取失败（存储不可用）：这不等于「没有这条记录」", code: "storage_error", error_layer: "notification_delivery" },
      503,
    );
  }
  const row = loaded.rows[0];
  if (!row) {
    // 不存在 / 属于别的工作空间 / 是平台行 —— **逐字同形**（不做跨作用域的存在性探测）。
    return c.json({ error: "没有这条投递记录（本工作空间）", code: "not_found", error_layer: "notification_delivery" }, 404);
  }
  return c.json({ data: { scope_kind: "workspace", workspace_id: access.id, row: projectDeliveryRow(row) } });
});
