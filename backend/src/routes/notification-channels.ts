/**
 * 平台级通知渠道配置的**读写端点**（切片 N2；退出条件 #6 的必需前置）。
 *
 * ── 为什么必须有这个文件 ──
 * `notification_channel` 表此前**没有任何读写 API**，`sealNotificationSecret()` 也**没有生产写入方**：
 * telegram 渠道的 `sealedToken` 恒为 `null` ⇒ `isConfigured()` 恒 false ⇒ 投递时永远留一条
 * `not_configured`，看起来像"没人配过"，实际是"没人接上"。webhook 同理（且今天还在注册表之外）。
 * 本端点补的是**配置面**，不是投递面：**不改投递逻辑、不加表/列/迁移**。
 *
 * ── 三条不可能越过的线 ──
 *  ① **凭据只写不读**：`secret` 只在 `PUT` 里出现一次，经 `sealNotificationSecret()`（唯一落库入口）
 *     变成密文；`GET`/`PUT` 响应**永远不含密文，也永远不含明文**（`value` 恒为 `""`，
 *     与 `admin.ts` 的 `SECRET_CONFIG_NAMES` 同款）。webhook 的 URL **本身就是凭据**
 *     （Slack/Discord 的 hook URL 拿到就能发消息），因此回显一律走 `redactWebhookTarget()`，
 *     与投递账本用的是同一份脱敏实现。
 *  ② **平台级，不接受作用域覆盖**：写死的 `scope_kind="platform"` + `workspace_id IS NULL`
 *     （与 `loadPlatformChannelConfig` 的结构条件同源）。请求体是**封闭**的：出现
 *     `workspace_id` / `scope_kind` 之类的键一律 400 —— 用户域不存在"我的 webhook / 我的 bot"
 *     这种概念（租户自带渠道是契约 O6 未拍板的事）。
 *  ③ **不折叠状态**：`secret_state` 把"没配过(unset) / 配了能解开(sealed) / 密文解不开(unreadable)"
 *     分成三态，`enabled` 与"未配置"也分开。把 `not_configured` / `rejected_target` /
 *     `secret_unreadable` 折叠成"已配置/正常"是本专项明令禁止的行为。
 *
 * ── 为什么还要下发"哪些渠道真的会被投递" ──
 * 保存成功 ≠ 会被投递。`buildPlatformNotificationChannels()` **有意排除 webhook**（今天没有消费者），
 * 而 telegram/email 还要过各自的部署开关（`enabledNotificationChannels()`）。这两条事实都用
 * **既有构造函数现场算**（`delivery_kinds`），不在这里抄一份会漂移的清单：`registered` 是注册表构造
 * 结果，`enabled` 是过了部署闸门的结果，`announcement` 是公告这条**今天唯一真正接线的投递路径**
 * （`announcement-delivery.ts`）实际会用的渠道。
 *
 * ── 表没有唯一索引，所以"多行"必须给出确定语义（不假装它不会发生）──
 * F5 的表**没有** `(scope_kind, workspace_id, kind)` 唯一索引（MySQL 里 NULL 互不相等，见契约
 * §12.2-D4 的实测），所以同一个 kind 多行是**真实可发生的状态**：
 *  · `telegram` 是**实例级一份**（一个 bot token 对应一个 bot）：`PUT` 更新"加载器实际会读的那一行"
 *    （最新一条启用行；没有启用行时取 id 最大的一条），并在 `warnings` 里报出多行事实；
 *  · `webhook` 每一行是一个**独立接收方**：`PUT` 以 `target` 为身份（同 URL 更新、新 URL 新增），
 *    `DELETE .../:kind/:id` 可精确删除其中一条。
 *
 * 端点（挂在 `/api/admin` 之下 ⇒ 继承 `adminRequired` + `adminPermissionGuard`）：
 *   GET    /api/admin/notification-channels              平台渠道状态投影（无凭据）
 *   PUT    /api/admin/notification-channels/:kind        upsert 配置（telegram: enabled/secret；webhook: target/enabled）
 *   DELETE /api/admin/notification-channels/:kind        移除该渠道的全部平台行（返回 deleted/ids）
 *   DELETE /api/admin/notification-channels/:kind/:id    精确删除一条平台行
 *
 * ── 明确不做（写清楚，免得被当成"已经能用了"）──
 *  · **没有"测试发送"**：那会是一次真实外呼，且没有入站握手就无法宣称"这个 bot/chat 属于你"；
 *  · **没有 telegram 绑定握手**：`User.tg_id` 仍是自由填写、未验证字段（见 `notification-telegram.ts` 的取舍），
 *    本端点不提供任何"已绑定/已验证"的语义；
 *  · **不做租户级渠道**：一律写平台行（O6 未拍板）；
 *  · **不读投递账本**：`notification_delivery` 的只读投影是切片 N4，不在本文件；
 *  · **不改投递逻辑**：这里的输出只是状态投影与配置写入，投递行为由既有渠道与投递层决定。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { db } from "../db.ts";
import type { AppVariables } from "../middlewares/auth.ts";
import { announcementChannels } from "../services/announcement-delivery.ts";
import {
  buildPlatformNotificationChannels,
  loadPlatformChannelConfig,
  type NotificationChannelRow,
  type PlatformChannelConfig,
} from "../services/notification-channel-config.ts";
import { enabledNotificationChannels, isValidEmailTarget } from "../services/notification-delivery.ts";
import {
  notificationSealMasterSecret,
  sealNotificationSecret,
  unsealNotificationSecret,
} from "../services/notification-seal.ts";
import { createTelegramChannel, isValidTelegramBotToken } from "../services/notification-telegram.ts";
import {
  isWebhookInsecureHttpAllowed,
  parseWebhookTarget,
  redactWebhookTarget,
} from "../services/notification-webhook.ts";

export const notificationChannelRoutes = new Hono<{ Variables: AppVariables }>();

type Ctx = Context<{ Variables: AppVariables }>;

/* ================================================================== */
/* 存储形状（SELECT * 与列宽）                                          */
/* ================================================================== */

/**
 * 行 + 两个时间列。`loadPlatformChannelConfig()` 的 `findMany` 没有 `select`，
 * 所以真实 Prisma 会把整行返回（含 `created_at` / `updated_at`）——这里的扩展只是让类型追上现实。
 */
export interface NotificationChannelAdminRow extends NotificationChannelRow {
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
}

/** 本模块用到的 Prisma 委托。只用 `findMany` / `create` / `update` / `deleteMany`，不新增表也不新增列。 */
export interface NotificationChannelAdminDb {
  notificationChannel: {
    findMany(args: Record<string, unknown>): Promise<NotificationChannelAdminRow[]>;
    create(args: Record<string, unknown>): Promise<NotificationChannelAdminRow>;
    update(args: Record<string, unknown>): Promise<NotificationChannelAdminRow>;
    deleteMany(args: Record<string, unknown>): Promise<{ count: number }>;
  };
}

function deps(): NotificationChannelAdminDb {
  return db as unknown as NotificationChannelAdminDb;
}

/** 平台作用域：结构条件，与 `loadPlatformChannelConfig` 的 `where` 同款（无唯一索引，靠这里收敛）。 */
const PLATFORM_SCOPE = { scope_kind: "platform", workspace_id: null } as const;

/**
 * `target` 列的宽度（`schema.prisma` 的 `target String @db.VarChar(512)`）。
 * `parseWebhookTarget()` 自己的上限是 2048 —— 形状合法但塞不进列的值必须在**落库前**拒掉，
 * 否则 MySQL 报 P2000，接口只能回一个含糊的 503（那是把"输入太长"伪装成"存储坏了"）。
 * 改列宽要同时改这里（本切片不允许加列/改迁移）。
 */
export const TARGET_COLUMN_MAX = 512;

/** 可以写入的 kind 闭集：只含**加载器真的会读**的两个（email 的凭据来自部署 env，不来自本表）。 */
export const WRITABLE_CHANNEL_KINDS = ["telegram", "webhook"] as const;
type WritableKind = (typeof WRITABLE_CHANNEL_KINDS)[number];

function isWritableKind(kind: string): kind is WritableKind {
  return (WRITABLE_CHANNEL_KINDS as readonly string[]).includes(kind);
}

/** 请求体闭集：`scope_kind` / `workspace_id` / `id` 之类的键一律拒绝（见文件头 ① ②）。 */
const WRITE_BODY_KEYS = new Set(["enabled", "target", "secret"]);

/** 错误码闭集（未知码一律 500，不把编程错误伪装成业务拒绝）。 */
type ErrorCode =
  | "unsupported_kind"
  | "unknown_field"
  | "unsupported_field"
  | "invalid_body"
  | "invalid_target"
  | "invalid_secret"
  | "not_found"
  | "seal_unavailable"
  | "storage_error";

function fail(
  c: Ctx,
  status: 400 | 404 | 503,
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return c.json({ error: message, code, error_layer: "notification_channel", ...extra }, status);
}

/* ================================================================== */
/* 只读投影（纯函数，可离线断言）                                        */
/* ================================================================== */

export type SecretState = "unset" | "sealed" | "unreadable";

export interface ChannelRowProjection {
  id: number;
  kind: string;
  enabled: boolean;
  /** 可回显形态：webhook 走 `redactWebhookTarget()`，telegram/email 只在形状合法时原样回。 */
  target: string;
  /** 是否被脱敏/掩码过（前端据此显示"已隐藏"而不是把掩码当成真值）。 */
  target_masked: boolean;
  /** 密文是否存在（**不代表可用**：解不开时仍然是 true，配合 `secret_state` 读）。 */
  secret_configured: boolean;
  secret_state: SecretState;
  /** 这一行是否被 `loadPlatformChannelConfig()` 实际读取（≠ 会被投递，后者看 `delivery_kinds`）。 */
  config_loaded: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/** 密文 → 三态。解封只为**判定可用性**，明文立刻丢弃：绝不返回、绝不落日志。 */
function projectSecret(
  row: NotificationChannelAdminRow,
  masterSecret: string,
): { secret_configured: boolean; secret_state: SecretState } {
  const sealed = typeof row.secret_enc === "string" ? row.secret_enc.trim() : "";
  if (sealed === "") return { secret_configured: false, secret_state: "unset" };
  try {
    unsealNotificationSecret(sealed, masterSecret);
    return { secret_configured: true, secret_state: "sealed" };
  } catch {
    return { secret_configured: true, secret_state: "unreadable" };
  }
}

/** 目标的可回显形态。**未知 kind 一律掩码**：原文可能是误填进来的凭据。 */
function projectTarget(row: NotificationChannelAdminRow): { target: string; target_masked: boolean } {
  const raw = typeof row.target === "string" ? row.target : "";
  // 空目标就是"没有目标"：回一个 `***` 会让人以为藏了一个值（telegram 行的 target 本来就是空串）。
  if (raw.trim() === "") return { target: "", target_masked: false };
  switch (row.kind) {
    case "webhook":
      // URL 本身就是凭据 ⇒ 一律走投递账本用的同一份脱敏（origin + 摘要，不含路径/查询）。
      return { target: redactWebhookTarget(raw), target_masked: true };
    case "telegram": {
      // 复用 telegram 渠道自己的 redactTarget 规则（形状合法 = chat id 可回显，否则 ***）。
      const redacted = createTelegramChannel().redactTarget?.(raw) ?? "***";
      return { target: redacted, target_masked: redacted !== raw.trim() };
    }
    case "email": {
      const trimmed = raw.trim();
      return isValidEmailTarget(trimmed) ? { target: trimmed, target_masked: false } : { target: "***", target_masked: true };
    }
    default:
      return { target: "***", target_masked: true };
  }
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" && value !== "") return value;
  return null;
}

/**
 * 加载器**实际读到**的行（与 `loadPlatformChannelConfig()` 的算法逐条对应）：
 *  · telegram：`telegram_sealed_token !== null` 时，取"最新一条启用行"（加载器就是这么取的）；
 *  · webhook：每条启用行且 target 非空 —— 这些正是 `webhook_targets` 的成员；
 *  · email：加载器不读它的行（SMTP 凭据来自部署 env）⇒ 恒 false。
 */
function configLoadedRowIds(config: PlatformChannelConfig): Set<number> {
  const loaded = new Set<number>();
  const enabledRows = config.rows.filter((row) => row.enabled !== false);
  const telegramRows = enabledRows.filter((row) => row.kind === "telegram");
  if (telegramRows.length > 0 && config.telegram_sealed_token !== null) {
    loaded.add(telegramRows[telegramRows.length - 1]!.id);
  }
  for (const row of enabledRows) {
    if (row.kind !== "webhook") continue;
    const target = typeof row.target === "string" ? row.target.trim() : "";
    if (target !== "") loaded.add(row.id);
  }
  return loaded;
}

export function projectChannelRow(
  row: NotificationChannelAdminRow,
  config: PlatformChannelConfig,
  masterSecret: string = notificationSealMasterSecret(),
): ChannelRowProjection {
  const target = projectTarget(row);
  const secret = projectSecret(row, masterSecret);
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled !== false,
    target: target.target,
    target_masked: target.target_masked,
    secret_configured: secret.secret_configured,
    secret_state: secret.secret_state,
    config_loaded: configLoadedRowIds(config).has(row.id),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

/* ================================================================== */
/* "保存成功 ≠ 会被投递" 的现场推导                                     */
/* ================================================================== */

export interface DeliveryKinds {
  /** 注册表构造结果（渠道**支持**哪些）。 */
  registered: string[];
  /** 过了各自部署闸门（`isConfigured`）的结果 —— 这才是投递层会用的集合。 */
  enabled: string[];
  /** 公告路径（今天唯一真正接线的投递者）实际会用到的渠道。 */
  announcement: string[];
}

export function deliveryKinds(config: PlatformChannelConfig): DeliveryKinds {
  const registered = buildPlatformNotificationChannels(config);
  const enabled = enabledNotificationChannels(registered);
  return {
    registered: registered.map((channel) => channel.kind),
    enabled: enabled.map((channel) => channel.kind),
    announcement: announcementChannels(enabled).map((channel) => channel.kind),
  };
}

function isInsecureHttpTarget(target: string): boolean {
  try {
    return new URL(target.trim()).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * 诊断性警告：加载器自己的 warnings（多行 / 有行但没密文）**原样透出**，
 * 另加两条本项目特有的、**现场推导**的事实：
 *  · 表里有行但该 kind 不在投递注册表里 ⇒ 保存成功也不会被投递（webhook 今天就是这样）；
 *  · 目标是明文 http:// ⇒ 本实例当前允许（非生产 + 显式开关），但生产环境会被拒。
 */
export function channelWarnings(config: PlatformChannelConfig): string[] {
  const warnings = [...config.warnings];
  const registered: string[] = buildPlatformNotificationChannels(config).map((channel) => channel.kind);
  const kinds = [...new Set(config.rows.map((row) => row.kind))];
  for (const kind of kinds) {
    if (registered.includes(kind)) continue;
    const count = config.rows.filter((row) => row.kind === kind).length;
    warnings.push(
      `${kind}：表里有 ${count} 条平台行，但 ${kind} 不在投递渠道注册表中（当前注册表：${
        registered.join(" / ") || "空"
      }）—— 保存成功不等于会被投递`,
    );
  }
  const insecure = config.rows.filter((row) => row.kind === "webhook" && isInsecureHttpTarget(row.target ?? ""));
  if (insecure.length > 0) {
    warnings.push(`webhook：有 ${insecure.length} 条目标是明文 http://（本实例当前允许，生产环境会被拒绝）`);
  }
  if (config.rows.some((row) => row.kind === "webhook" && row.enabled !== false)) {
    // `validateConfig` 是**同步静态**判定（形状/protocol/字面 IP）；DNS 与可达性由出站时的
    // `resolveWebhookTarget()` 判 —— 所以"保存成功"既不等于会被投递，也不等于目标可用。
    warnings.push(
      "webhook：目标只做了静态形状校验（https / 字面 IP）；DNS 解析、私网判定与可达性在出站投递时判定，保存成功不代表目标可用",
    );
  }
  return warnings;
}

/* ================================================================== */
/* 读取                                                                */
/* ================================================================== */

function rowsOf(config: PlatformChannelConfig): NotificationChannelAdminRow[] {
  return config.rows as unknown as NotificationChannelAdminRow[];
}

function listPayload(config: PlatformChannelConfig) {
  return {
    scope_kind: "platform" as const,
    channels: rowsOf(config).map((row) => projectChannelRow(row, config)),
    delivery_kinds: deliveryKinds(config),
    warnings: channelWarnings(config),
  };
}

notificationChannelRoutes.get("/notification-channels", async (c) => {
  const loaded = await loadPlatformChannelConfig(deps());
  if (!loaded.ok) {
    // 读不到 ≠ 没配置：把两者混起来会让一次 DB 抖动变成"这台安装没有渠道"。
    return fail(c, 503, "storage_error", "渠道配置读取失败（存储不可用）：这不等于「这台安装没有配置渠道」");
  }
  return c.json({ data: listPayload(loaded.value) });
});

/* ================================================================== */
/* 写入                                                                */
/* ================================================================== */

interface ParsedBody {
  enabled?: boolean;
  target?: string;
  secret?: string;
}

interface ParseFailure {
  status: 400;
  code: ErrorCode;
  message: string;
  extra: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 静态形状校验（不碰数据库）。顺序：kind → 请求体闭集 → 字段类型 → 渠道各自的形状校验
 * （telegram 用 `isValidTelegramBotToken()`、webhook 用 `parseWebhookTarget()`，**都是既有实现**）。
 */
function parseWriteBody(kind: WritableKind, raw: unknown): ParsedBody | ParseFailure {
  if (!isPlainObject(raw)) {
    return { status: 400, code: "invalid_body", message: "请求体必须是 JSON 对象", extra: {} };
  }
  const unknownFields = Object.keys(raw).filter((key) => !WRITE_BODY_KEYS.has(key));
  if (unknownFields.length > 0) {
    return {
      status: 400,
      code: "unknown_field",
      message: `请求体不接受字段：${unknownFields.join(", ")}（作用域由端点结构决定，接受覆盖会让人以为存在租户级渠道）`,
      extra: { fields: unknownFields },
    };
  }

  const parsed: ParsedBody = {};
  if ("enabled" in raw) {
    if (typeof raw.enabled !== "boolean") {
      return { status: 400, code: "invalid_body", message: "enabled 必须是布尔值", extra: {} };
    }
    parsed.enabled = raw.enabled;
  }

  if (kind === "telegram") {
    if ("target" in raw) {
      return {
        status: 400,
        code: "unsupported_field",
        message:
          "telegram 行不承载平台级收件人：收件人来自每个用户自己的 tg_id（自由填写且**未经校验**），" +
          "本端点不接受 target（写一个「平台 chat id」会让人以为通知会发到那里）",
        extra: {},
      };
    }
    if ("secret" in raw) {
      const secret = raw.secret;
      if (typeof secret !== "string" || secret.trim() === "") {
        return {
          status: 400,
          code: "invalid_secret",
          message: "secret 必须是非空字符串（清空凭据用 DELETE 移除该渠道配置）",
          extra: {},
        };
      }
      if (!isValidTelegramBotToken(secret)) {
        return {
          status: 400,
          code: "invalid_secret",
          message: "secret 的形状不是 Telegram bot token（<bot_id>:<secret>），未落库",
          extra: {},
        };
      }
      parsed.secret = secret.trim();
    }
    if (parsed.enabled === undefined && parsed.secret === undefined) {
      return { status: 400, code: "invalid_body", message: "至少要提供 enabled 或 secret 之一", extra: {} };
    }
    return parsed;
  }

  // webhook：`target` 是身份（同 URL 更新、新 URL 新增），因此必填。
  if (!("target" in raw)) {
    return {
      status: 400,
      code: "invalid_body",
      message: "webhook 配置必须提供 target（URL 就是这一行接收方的身份）",
      extra: {},
    };
  }
  if ("secret" in raw) {
    return {
      status: 400,
      code: "unsupported_field",
      message:
        "webhook 不接受 secret：URL 本身就是凭据（存在 target 列）。今天也没有签名密钥的消费者，" +
        "收下一个从不被读取的 secret 就是把「已配置」变成一句假话",
      extra: {},
    };
  }
  if (typeof raw.target !== "string" || raw.target.trim() === "") {
    return { status: 400, code: "invalid_target", message: "target 必须是非空 URL 字符串", extra: { reason: "empty" } };
  }
  const trimmed = raw.target.trim();
  // 复用 webhook 渠道自己的静态解析器（含 https-only、公网 IP、禁 URL 内凭据等 SSRF 边界）。
  const check = parseWebhookTarget(trimmed, { allowInsecureHttp: isWebhookInsecureHttpAllowed() });
  if (!check.ok) {
    return {
      status: 400,
      code: "invalid_target",
      message: "webhook 目标被既有解析器拒绝（未落库）",
      extra: { reason: check.reason },
    };
  }
  if (trimmed.length > TARGET_COLUMN_MAX) {
    return {
      status: 400,
      code: "invalid_target",
      message: `target 超过 target 列宽度（${TARGET_COLUMN_MAX} 字符），未落库`,
      extra: { reason: "exceeds_column_width" },
    };
  }
  parsed.target = trimmed;
  return parsed;
}

function isParseFailure(value: ParsedBody | ParseFailure): value is ParseFailure {
  return "status" in value;
}

/** 落库前把明文封装成密文。主密钥缺失 = 部署配置错误 ⇒ 503，绝不退回明文或明文列。 */
function sealTelegramSecret(secret: string): { ok: true; sealed: string } | { ok: false } {
  try {
    return { ok: true, sealed: sealNotificationSecret(secret, notificationSealMasterSecret()) };
  } catch {
    // 错误消息刻意不含明文/密文（`notification-seal.ts` 的取向），本层也不做例外。
    return { ok: false };
  }
}

/** 写完后的状态重读。读不回来时**明说"已写入"**，不让调用方以为白写了。 */
async function reread(
  c: Ctx,
  writeApplied: boolean,
): Promise<{ ok: true; config: PlatformChannelConfig } | { ok: false; response: Response }> {
  const after = await loadPlatformChannelConfig(deps());
  if (after.ok) return { ok: true, config: after.value };
  return {
    ok: false,
    response: fail(c, 503, "storage_error", "配置状态重读失败（请重新获取列表确认当前状态）", {
      write_applied: writeApplied,
    }),
  };
}

notificationChannelRoutes.put("/notification-channels/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!isWritableKind(kind)) {
    return fail(c, 400, "unsupported_kind", `本端点只写入这些渠道：${WRITABLE_CHANNEL_KINDS.join(" / ")}`, {
      writable_kinds: [...WRITABLE_CHANNEL_KINDS],
    });
  }

  const raw = await c.req.json().catch(() => null);
  const parsed = parseWriteBody(kind, raw);
  if (isParseFailure(parsed)) return fail(c, parsed.status, parsed.code, parsed.message, parsed.extra);

  let sealed: string | undefined;
  if (parsed.secret !== undefined) {
    const result = sealTelegramSecret(parsed.secret);
    if (!result.ok) {
      return fail(
        c,
        503,
        "seal_unavailable",
        "通知凭据封装密钥不可用（AUTH_SECRET 缺失/为空）：配置未写入，也没有任何明文落库",
      );
    }
    sealed = result.sealed;
  }

  const loaded = await loadPlatformChannelConfig(deps());
  if (!loaded.ok) return fail(c, 503, "storage_error", "渠道配置读取失败（存储不可用），未写入");
  const kindRows = rowsOf(loaded.value).filter((row) => row.kind === kind);

  try {
    const userId = c.get("user")?.id ?? null;
    let writtenId: number;
    let rowCreated: boolean;

    if (kind === "telegram") {
      // 与加载器同一取向：更新"实际会被读的那一行"（最新启用行；无启用行则 id 最大的一条）。
      const enabledRows = kindRows.filter((row) => row.enabled !== false);
      const candidate =
        enabledRows.length > 0 ? enabledRows[enabledRows.length - 1]! : (kindRows[kindRows.length - 1] ?? null);
      if (candidate === null && sealed === undefined) {
        return fail(c, 400, "invalid_body", "首次配置 telegram 必须同时提供 secret（bot token）", {});
      }
      const data: Record<string, unknown> = {};
      if (parsed.enabled !== undefined) data.enabled = parsed.enabled;
      if (sealed !== undefined) data.secret_enc = sealed;
      if (candidate === null) {
        const created = await deps().notificationChannel.create({
          data: {
            ...PLATFORM_SCOPE,
            kind,
            // `target` 列 NOT NULL，但 telegram 行不承载收件人（见 parseWriteBody）⇒ 空串是诚实取值。
            target: "",
            secret_enc: sealed ?? null,
            enabled: parsed.enabled ?? true,
            created_by_id: userId,
          },
        });
        writtenId = created.id;
        rowCreated = true;
      } else {
        const updated = await deps().notificationChannel.update({ where: { id: candidate.id }, data });
        writtenId = updated.id;
        rowCreated = false;
      }
    } else {
      const target = parsed.target;
      if (target === undefined) {
        // parseWriteBody 已经保证 webhook 必有 target（这里只是让类型收敛，不重复业务判定）。
        return fail(c, 400, "invalid_body", "webhook 配置必须提供 target");
      }
      const existing = kindRows.find((row) => (row.target ?? "").trim() === target);
      if (existing) {
        const data: Record<string, unknown> = {};
        if (parsed.enabled !== undefined) data.enabled = parsed.enabled;
        const updated = await deps().notificationChannel.update({ where: { id: existing.id }, data });
        writtenId = updated.id;
        rowCreated = false;
      } else {
        const created = await deps().notificationChannel.create({
          data: {
            ...PLATFORM_SCOPE,
            kind,
            target,
            secret_enc: null,
            enabled: parsed.enabled ?? true,
            created_by_id: userId,
          },
        });
        writtenId = created.id;
        rowCreated = true;
      }
    }

    const fresh = await reread(c, true);
    if (!fresh.ok) return fresh.response;
    const freshRow = rowsOf(fresh.config).find((row) => row.id === writtenId);
    const projection =
      freshRow !== undefined
        ? projectChannelRow(freshRow, fresh.config)
        : {
            id: writtenId,
            kind,
            enabled: parsed.enabled ?? true,
            target: "",
            target_masked: true,
            secret_configured: sealed !== undefined,
            secret_state: (sealed === undefined ? "unset" : "sealed") as SecretState,
            config_loaded: false,
            created_at: null,
            updated_at: null,
          };

    return c.json({
      data: {
        ...projection,
        // 与 `admin.ts` 的 `SECRET_CONFIG_NAMES` 同款：值恒为空串，只给"配没配"。
        value: "",
        row_created: rowCreated,
        affected_ids: [writtenId],
        delivery_kinds: deliveryKinds(fresh.config),
        warnings: channelWarnings(fresh.config),
      },
    });
  } catch {
    // 写入失败：不把 DB 异常文本回显（可能带上 URI/参数），也不谎报成功。
    return fail(c, 503, "storage_error", "渠道配置写入失败（存储不可用），未写入", { write_applied: false });
  }
});

/* ================================================================== */
/* 删除                                                                */
/* ================================================================== */

notificationChannelRoutes.delete("/notification-channels/:kind", async (c) => {
  const kind = c.req.param("kind");
  if (!isWritableKind(kind)) {
    return fail(c, 400, "unsupported_kind", `本端点只写入这些渠道：${WRITABLE_CHANNEL_KINDS.join(" / ")}`, {
      writable_kinds: [...WRITABLE_CHANNEL_KINDS],
    });
  }

  const loaded = await loadPlatformChannelConfig(deps());
  if (!loaded.ok) return fail(c, 503, "storage_error", "渠道配置读取失败（存储不可用），未删除");
  const ids = rowsOf(loaded.value)
    .filter((row) => row.kind === kind)
    .map((row) => row.id);

  let deleted = 0;
  if (ids.length > 0) {
    try {
      // 按 id 删除：作用域条件已经由加载器施加（platform + workspace_id IS NULL），
      // 这里再带上同样的条件，避免"读的是平台行、删的却是别的行"。
      const result = await deps().notificationChannel.deleteMany({
        where: { id: { in: ids }, ...PLATFORM_SCOPE, kind },
      });
      deleted = result.count;
    } catch {
      return fail(c, 503, "storage_error", "渠道配置删除失败（存储不可用），未删除", { write_applied: false });
    }
  }

  const fresh = await reread(c, ids.length > 0);
  if (!fresh.ok) return fresh.response;
  return c.json({
    data: {
      kind,
      deleted,
      deleted_ids: ids,
      delivery_kinds: deliveryKinds(fresh.config),
      warnings: channelWarnings(fresh.config),
    },
  });
});

notificationChannelRoutes.delete("/notification-channels/:kind/:id", async (c) => {
  const kind = c.req.param("kind");
  if (!isWritableKind(kind)) {
    return fail(c, 400, "unsupported_kind", `本端点只写入这些渠道：${WRITABLE_CHANNEL_KINDS.join(" / ")}`, {
      writable_kinds: [...WRITABLE_CHANNEL_KINDS],
    });
  }
  const idParam = c.req.param("id");
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) {
    return fail(c, 400, "invalid_body", "id 必须是正整数");
  }

  let deleted = 0;
  try {
    const result = await deps().notificationChannel.deleteMany({
      where: { id, ...PLATFORM_SCOPE, kind },
    });
    deleted = result.count;
  } catch {
    return fail(c, 503, "storage_error", "渠道配置删除失败（存储不可用），未删除", { write_applied: false });
  }
  if (deleted === 0) {
    // "不存在"与"存在但不是平台行/不属于该 kind"逐字同形：不给出跨作用域的存在性探测。
    return fail(c, 404, "not_found", "没有匹配的平台级渠道行（平台作用域 + 该渠道）");
  }

  const fresh = await reread(c, true);
  if (!fresh.ok) return fresh.response;
  return c.json({
    data: {
      kind,
      id,
      deleted,
      delivery_kinds: deliveryKinds(fresh.config),
      warnings: channelWarnings(fresh.config),
    },
  });
});
