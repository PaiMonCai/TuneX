/**
 * Admin 域：**平台级通知渠道配置**的 API 客户端（切片 N2-UI，消费 task-10 已交付的端点）。
 *
 * 端点（`backend/src/routes/notification-channels.ts`，挂 `/api/admin` ⇒ 需 `notification_channels` 资源键）：
 *   GET    /api/admin/notification-channels            平台渠道状态投影（**永不含凭据**）
 *   PUT    /api/admin/notification-channels/:kind      telegram `{enabled?, secret?}` / webhook `{target, enabled?}`
 *   DELETE /api/admin/notification-channels/:kind      移除该渠道的全部平台行
 *   DELETE /api/admin/notification-channels/:kind/:id  精确删除一条平台行
 *
 * ── 为什么这里**不解包后立刻丢掉未知字段**，而是显式列出每个字段 ──
 * 这个页面的全部价值就是"不撒谎"：`secret_state` 的三态、`delivery_kinds` 的"注册表 / 已开启 /
 * 公告实际用的"三份集合、以及 `warnings`，都必须**原样**到达界面。用一个宽松的 `any` 透传会
 * 让后端新增字段时前端悄悄看不见（那就等于用"没显示"冒充"没问题"）。
 *
 * ── secret 只写不读 ──
 * 响应里的 `value` 恒为空串（与 `admin.ts` 的 `SECRET_CONFIG_NAMES` 同款）；本客户端**不读取、
 * 不缓存、不回填**任何凭据。PUT 的 `secret` 只出现在请求体里（不进 URL、不进日志）。
 */
import { del, get, put } from "./core";

export type SecretState = "unset" | "sealed" | "unreadable";

export interface NotificationChannelRow {
  id: number;
  kind: string;
  enabled: boolean;
  /** 服务端已脱敏/掩码后的目标（webhook 是 `origin/***摘要`）。 */
  target: string;
  target_masked: boolean;
  secret_configured: boolean;
  secret_state: SecretState;
  /** 该行是否被渠道配置加载器实际读取（≠ 会被投递，后者看 `delivery_kinds`）。 */
  config_loaded: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/** "保存成功 ≠ 会被投递"的三份集合（**服务端现场推导**，前端不自己推）。 */
export interface DeliveryKinds {
  registered: string[];
  enabled: string[];
  announcement: string[];
}

export interface NotificationChannelsPayload {
  scope_kind: string;
  channels: NotificationChannelRow[];
  delivery_kinds: DeliveryKinds;
  warnings: string[];
}

export interface AdminPermissionProjection {
  super_admin: boolean;
  roles: Array<{ permissions?: Record<string, string> }>;
}

/** 本次会话在 `notification_channels` 上的**已知**能力。`unknown` = 权限接口读不到。 */
export type NotificationChannelPermission = "unknown" | "read" | "write";

function unwrapEnvelope(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "data" in (raw as Record<string, unknown>)) {
    return (raw as Record<string, unknown>).data;
  }
  return raw;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const SECRET_STATES: readonly SecretState[] = ["unset", "sealed", "unreadable"];

function toRow(raw: unknown): NotificationChannelRow | null {
  const row = asRecord(raw);
  if (!row || typeof row.id !== "number" || typeof row.kind !== "string") return null;
  const secretState = row.secret_state;
  return {
    id: row.id,
    kind: row.kind,
    enabled: row.enabled !== false,
    target: typeof row.target === "string" ? row.target : "",
    target_masked: row.target_masked === true,
    secret_configured: row.secret_configured === true,
    // 未知取值一律落到 `unreadable`：宁可说"这个状态我看不懂"，也不要说成"没配置"。
    secret_state: SECRET_STATES.includes(secretState as SecretState) ? (secretState as SecretState) : "unreadable",
    config_loaded: row.config_loaded === true,
    created_at: typeof row.created_at === "string" ? row.created_at : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

/** 辨认 `{scope_kind, channels, delivery_kinds, warnings}`。辨认不出来 ⇒ 抛错（上层进"取不到"分支）。 */
export function readChannelsPayload(raw: unknown): NotificationChannelsPayload {
  const payload = asRecord(unwrapEnvelope(raw));
  const channels = payload?.channels;
  const delivery = asRecord(payload?.delivery_kinds);
  if (!payload || !Array.isArray(channels) || !delivery) {
    throw new Error("通知渠道应答无法辨认（缺少 channels / delivery_kinds）：已按「取不到」处理，不做任何推测");
  }
  const rows = channels.map(toRow).filter((row): row is NotificationChannelRow => row !== null);
  if (rows.length !== channels.length) {
    // 有行读不出来 ⇒ 不假装"只有这几行"：整份载荷视为不可辨认。
    throw new Error("通知渠道应答里有无法辨认的行：已按「取不到」处理，不显示残缺列表");
  }
  return {
    scope_kind: typeof payload.scope_kind === "string" ? payload.scope_kind : "platform",
    channels: rows,
    delivery_kinds: {
      registered: stringArray(delivery.registered),
      enabled: stringArray(delivery.enabled),
      announcement: stringArray(delivery.announcement),
    },
    warnings: stringArray(payload.warnings),
  };
}

/** `/auth/permissions` → 本次会话在 `notification_channels` 上的能力。读不到返回 `unknown`。 */
export function readPermissionProjection(raw: unknown): NotificationChannelPermission {
  const payload = asRecord(unwrapEnvelope(raw));
  if (!payload) return "unknown";
  const superAdmin = payload.super_admin === true;
  if (superAdmin) return "write";
  const roles = Array.isArray(payload.roles) ? payload.roles : [];
  let best: NotificationChannelPermission = "none" as NotificationChannelPermission;
  let seen = false;
  for (const role of roles) {
    const permissions = asRecord(asRecord(role)?.permissions);
    const level = permissions?.notification_channels;
    if (level !== "read" && level !== "write") continue;
    seen = true;
    if (level === "write") return "write";
    best = "read";
  }
  return seen ? best : "read"; // 已认证的后台用户：没有该键 ⇒ 只有超管能过（后端 fail-closed），前端按只读呈现
}

export interface AdminActionResult {
  /** 服务端回显的已落库形态（`value` 恒为空串）。 */
  secret_configured: boolean;
  secret_state: SecretState;
  warnings: string[];
}

export const notificationAdminApi = {
  channels: async (): Promise<NotificationChannelsPayload> => readChannelsPayload(await get<unknown>("/admin/notification-channels")),
  permission: async (): Promise<NotificationChannelPermission> => {
    try {
      return readPermissionProjection(await get<unknown>("/auth/permissions"));
    } catch {
      return "unknown";
    }
  },
  /** 配置 telegram（**首次**必须带 secret；不带 secret 只改 enabled）。 */
  putTelegram: async (input: { enabled?: boolean; secret?: string }): Promise<AdminActionResult> => {
    const body: Record<string, unknown> = {};
    if (input.enabled !== undefined) body.enabled = input.enabled;
    if (typeof input.secret === "string" && input.secret !== "") body.secret = input.secret;
    const data = asRecord(unwrapEnvelope(await put<unknown>("/admin/notification-channels/telegram", body)));
    return {
      secret_configured: data?.secret_configured === true,
      secret_state: SECRET_STATES.includes(data?.secret_state as SecretState)
        ? (data?.secret_state as SecretState)
        : "unreadable",
      warnings: stringArray(data?.warnings),
    };
  },
  /** 添加/更新一个 webhook 接收方（**以 URL 为身份**：同 URL 更新、新 URL 新增）。 */
  putWebhook: async (input: { target: string; enabled?: boolean }): Promise<AdminActionResult> => {
    const body: Record<string, unknown> = { target: input.target };
    if (input.enabled !== undefined) body.enabled = input.enabled;
    const data = asRecord(unwrapEnvelope(await put<unknown>("/admin/notification-channels/webhook", body)));
    return {
      secret_configured: data?.secret_configured === true,
      secret_state: SECRET_STATES.includes(data?.secret_state as SecretState)
        ? (data?.secret_state as SecretState)
        : "unreadable",
      warnings: stringArray(data?.warnings),
    };
  },
  /** 移除该渠道的**全部**平台行（返回删掉的行数）。 */
  removeKind: async (kind: string): Promise<{ deleted: number }> => {
    const data = asRecord(unwrapEnvelope(await del<unknown>(`/admin/notification-channels/${kind}`)));
    return { deleted: typeof data?.deleted === "number" ? data.deleted : 0 };
  },
  /** 精确删除一条平台行。 */
  removeRow: async (kind: string, id: number): Promise<{ deleted: number }> => {
    const data = asRecord(unwrapEnvelope(await del<unknown>(`/admin/notification-channels/${kind}/${id}`)));
    return { deleted: typeof data?.deleted === "number" ? data.deleted : 0 };
  },
};
