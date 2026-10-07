/**
 * 切片 N2-UI —— admin「通知渠道配置」的行为测试。
 *
 * 分两层（本仓没有 happy-dom/testing-library，组件测试一律走 `renderToStaticMarkup`）：
 *
 *  A. **纯逻辑**：五态选择、读/写失败分档、载荷辨认（含"未知 `secret_state` 只能落 unreadable"）、
 *     权限投影。这些是"界面会说什么"的判据，用真实函数驱动。
 *  B. **呈现**：逐分支静态渲染 `NotificationChannelsBody`，钉住本切片最怕的几件事：
 *     `secret_state` 三态必须分开（`unreadable` ≠ 没配置）、`delivery_kinds`/`warnings` **原样**透传
 *     （"保存成功 ≠ 会被投递"）、403 **不得**渲染成"暂无渠道"、同 kind 多行是真实状态、
 *     凭据输入框**不回填**（HTML 里没有 `value=`）。
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ApiError } from "@/lib/api";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import {
  NotificationChannelsBody,
  classifyAdminActionError,
  classifyReadError,
  notificationChannelsView,
  type ChannelsView,
} from "@/components/admin/notification-channels-manager";
import {
  readChannelsPayload,
  readPermissionProjection,
  type NotificationChannelRow,
  type NotificationChannelsPayload,
} from "@/lib/api/notification-admin";
import type { NotificationChannelPermission } from "@/lib/api/notification-admin";

/* ================================================================== */
/* 工具                                                                */
/* ================================================================== */

function row(over: Partial<NotificationChannelRow> = {}): NotificationChannelRow {
  return {
    id: 1,
    kind: "telegram",
    enabled: true,
    target: "",
    target_masked: false,
    secret_configured: true,
    secret_state: "sealed",
    config_loaded: true,
    created_at: "2026-10-06T10:00:00.000Z",
    updated_at: "2026-10-06T10:00:00.000Z",
    ...over,
  };
}

function payload(over: Partial<NotificationChannelsPayload> = {}): NotificationChannelsPayload {
  return {
    scope_kind: "platform",
    channels: [row()],
    delivery_kinds: { registered: ["email", "telegram"], enabled: ["email"], announcement: ["email"] },
    warnings: [],
    ...over,
  };
}

const noop = () => undefined;

function body(over: {
  view?: ChannelsView;
  permission?: NotificationChannelPermission;
  locale?: "zh" | "en";
  busy?: string | null;
  actionError?: ReturnType<typeof classifyAdminActionError> | null;
  actionNotice?: string | null;
  telegramEnabled?: boolean;
  webhookEnabled?: boolean;
  pendingRemove?: string | null;
} = {}): string {
  const locale = over.locale ?? "zh";
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale, dict: getDictionary(locale) },
      createElement(NotificationChannelsBody as never, {
        view: over.view ?? { kind: "ready", payload: payload() },
        permission: over.permission ?? "write",
        locale,
        busy: over.busy ?? null,
        actionError: over.actionError ?? null,
        actionNotice: over.actionNotice ?? null,
        telegramEnabled: over.telegramEnabled ?? true,
        webhookEnabled: over.webhookEnabled ?? true,
        credentialRef: { current: null },
        targetRef: { current: null },
        pendingRemove: over.pendingRemove ?? null,
        onRetry: noop,
        onToggleTelegram: noop,
        onToggleWebhook: noop,
        onSaveTelegram: noop,
        onSaveWebhook: noop,
        onRequestRemove: noop,
        onRemoveKind: noop,
        onRemoveRow: noop,
      }),
    ),
  );
}

/** 是否**真的**带 disabled 属性（不能用 includes("disabled")：class 里有 `disabled:opacity-50`）。 */
function hasDisabledAttr(html: string, testid: string): boolean {
  const at = html.indexOf(`data-testid="${testid}"`);
  if (at < 0) return false;
  const tagStart = html.lastIndexOf("<", at);
  const tagEnd = html.indexOf(">", at);
  return /\sdisabled(=""|\s|>)/.test(html.slice(tagStart, tagEnd));
}

function tagOf(html: string, testid: string): string {
  const at = html.indexOf(`data-testid="${testid}"`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
}

/* ================================================================== */
/* A. 纯逻辑                                                           */
/* ================================================================== */

describe("N2-UI 五态：取不到 ≠ 没有 ≠ 无权限", () => {
  test("五态各自成立，且 empty 只在**真的读到 0 行**时出现", () => {
    expect(notificationChannelsView({ kind: "loading" }).kind).toBe("loading");
    expect(notificationChannelsView({ kind: "forbidden", message: "403" }).kind).toBe("forbidden");
    expect(notificationChannelsView({ kind: "unavailable", code: "storage_error", message: "down" }).kind).toBe("unavailable");
    expect(notificationChannelsView({ kind: "ready", payload: payload({ channels: [] }) }).kind).toBe("empty");
    expect(notificationChannelsView({ kind: "ready", payload: payload() }).kind).toBe("ready");
  });

  test("读失败分档：403 单独一态，其余按「取不到」（都不许变成空列表）", () => {
    expect(classifyReadError(new ApiError(403, "无权访问该功能", { code: "FORBIDDEN" }), "fb")).toMatchObject({
      kind: "forbidden",
    });
    expect(classifyReadError(new ApiError(503, "存储不可用", { code: "storage_error" }), "fb")).toMatchObject({
      kind: "unavailable",
      code: "storage_error",
    });
    expect(classifyReadError(new TypeError("Failed to fetch"), "fb")).toMatchObject({
      kind: "unavailable",
      code: null,
    });
  });

  test("写失败分档：403（无写权限）/ 400（提交被拒）/ 其它（可重试）三档互不冒充", () => {
    expect(classifyAdminActionError(new ApiError(403, "无权", null), "fb").kind).toBe("forbidden");
    expect(classifyAdminActionError(new ApiError(400, "形状非法", { code: "invalid_target" }), "fb")).toMatchObject({
      kind: "rejected",
      code: "invalid_target",
    });
    expect(classifyAdminActionError(new ApiError(503, "down", { code: "storage_error" }), "fb")).toMatchObject({
      kind: "unavailable",
      code: "storage_error",
    });
    expect(classifyAdminActionError(new TypeError("Failed to fetch"), "fb").kind).toBe("unavailable");
  });
});

describe("N2-UI 载荷辨认：不撒谎从这一层开始", () => {
  test("两种信封都收（真实模式 core 已解包；mock 模式带一层 data）", () => {
    const bare = { scope_kind: "platform", channels: [], delivery_kinds: { registered: [], enabled: [], announcement: [] }, warnings: ["w"] };
    expect(readChannelsPayload(bare)).toMatchObject({ warnings: ["w"] });
    expect(readChannelsPayload({ data: bare })).toMatchObject({ warnings: ["w"] });
  });

  test("辨认不出来 ⇒ 抛错（上层进「取不到」），绝不退回空列表", () => {
    expect(() => readChannelsPayload({ channels: [] })).toThrow();
    expect(() => readChannelsPayload(null)).toThrow();
  });

  test("有行读不出来 ⇒ 整份载荷判为不可辨认（不显示残缺列表冒充全部）", () => {
    expect(() =>
      readChannelsPayload({
        channels: [row(), { id: "not-a-number" }],
        delivery_kinds: { registered: [], enabled: [], announcement: [] },
      }),
    ).toThrow();
  });

  test("未知 secret_state 只能落 unreadable（宁可说「看不懂」，也不说「没配置」）", () => {
    const parsed = readChannelsPayload({
      channels: [{ ...row(), secret_state: "some_future_state", secret_configured: true }],
      delivery_kinds: { registered: [], enabled: [], announcement: [] },
    });
    expect(parsed.channels[0]!.secret_state).toBe("unreadable");
  });

  test("权限投影：超管 write、角色按 level、读不到 ⇒ unknown、已认证但没有该键 ⇒ read", () => {
    expect(readPermissionProjection({ super_admin: true, roles: [] })).toBe("write");
    expect(readPermissionProjection({ super_admin: false, roles: [{ permissions: { notification_channels: "read" } }] })).toBe("read");
    expect(readPermissionProjection({ super_admin: false, roles: [{ permissions: { notification_channels: "write" } }] })).toBe("write");
    expect(readPermissionProjection({ super_admin: false, roles: [{ permissions: { nodes: "write" } }] })).toBe("read");
    expect(readPermissionProjection(null)).toBe("unknown");
  });
});

/* ================================================================== */
/* B. 呈现                                                            */
/* ================================================================== */

describe("N2-UI 呈现：五态与 403", () => {
  test("loading：只显示读取中，不渲染任何渠道行/表单", () => {
    const html = body({ view: { kind: "loading" } });
    expect(html).toContain('data-testid="notification-channels-loading"');
    expect(html).not.toContain('data-testid="notification-rows"');
    expect(html).not.toContain('data-testid="notification-telegram-form"');
  });

  test("403：明说「没有读取权限」且**不是**「暂无渠道」，也不显示任何渠道状态", () => {
    const html = body({ view: { kind: "forbidden", message: "无权访问该功能" } });
    expect(html).toContain('data-testid="notification-channels-forbidden"');
    expect(html).toContain("不是");
    expect(html).not.toContain('data-testid="notification-channels-empty"');
    expect(html).not.toContain('data-testid="notification-rows"');
    expect(html).not.toContain('data-testid="notification-delivery"');
  });

  test("取不到：与「暂无渠道」「无权限」都不同形", () => {
    const html = body({ view: { kind: "unavailable", code: "storage_error", message: "存储暂时不可用" } });
    expect(html).toContain('data-testid="notification-channels-unavailable"');
    expect(html).toContain("不代表");
    expect(html).not.toContain('data-testid="notification-channels-empty"');
    expect(html).not.toContain('data-testid="notification-channels-forbidden"');
  });

  test("empty：真的读到 0 行 ⇒ 明说「一行都没有 ≠ 取不到」，但投递状态照旧显示（服务端事实）", () => {
    const html = body({ view: { kind: "empty", payload: payload({ channels: [], warnings: [] }) } });
    expect(html).toContain('data-testid="notification-channels-empty"');
    expect(html).toContain('data-testid="notification-delivery"');
    expect(html).not.toContain('data-testid="notification-rows"');
  });
});

describe("N2-UI 呈现：secret_state 三态分开 + 同一 kind 多行是真实状态", () => {
  test("三态各有各的说法：没有凭据 / 已封存 / 解不开（坏配置）", () => {
    const html = body({
      view: {
        kind: "ready",
        payload: payload({
          channels: [
            row({ id: 1, secret_state: "unset", secret_configured: false }),
            row({ id: 2, secret_state: "sealed", secret_configured: true }),
            row({ id: 3, secret_state: "unreadable", secret_configured: true }),
          ],
        }),
      },
    });
    // 徽章的文字在开标签之后，所以按"从 testid 到该行加载态标记"之间整段来断言。
    const secretBlock = (id: number): string =>
      html.slice(html.indexOf(`data-testid="notification-secret-${id}"`), html.indexOf(`data-testid="notification-row-loaded-${id}"`));
    expect(secretBlock(1)).toContain("没有凭据");
    expect(secretBlock(2)).toContain("凭据已封存");
    expect(secretBlock(3)).toContain("解不开");
    expect(secretBlock(3)).toContain("配置坏了");
    // 关键：unreadable 那一行**不得**与"没有凭据"同形
    expect(secretBlock(3)).toContain("不是");
    expect(secretBlock(3)).not.toContain("没有凭据");
  });

  test("同一 kind 两行都渲染（表没有唯一索引，界面不假装「一个渠道一行」）", () => {
    const html = body({
      view: {
        kind: "ready",
        payload: payload({
          channels: [row({ id: 4 }), row({ id: 5, enabled: false })],
          warnings: ["telegram 有 2 条启用行，取 id 最大的一条（5）"],
        }),
      },
    });
    expect(html).toContain('data-testid="notification-row-4"');
    expect(html).toContain('data-testid="notification-row-5"');
    expect(html).toContain("telegram 有 2 条启用行");
    expect(html).toContain('data-testid="notification-warning"');
  });

  test("webhook 目标只显示服务端脱敏形态，并标出「已脱敏」", () => {
    const html = body({
      view: {
        kind: "ready",
        payload: payload({
          channels: [row({ id: 9, kind: "webhook", target: "https://hooks.slack.com/***89b0e692fc1e", target_masked: true, secret_state: "unset", secret_configured: false })],
        }),
      },
    });
    expect(html).toContain("https://hooks.slack.com/***89b0e692fc1e");
    expect(html).toContain("已脱敏");
    expect(html).not.toContain("SECRETPART");
  });
});

describe("N2-UI 呈现：保存成功 ≠ 会被投递（原样透传服务端事实）", () => {
  test("delivery_kinds 三份集合 + warnings 都由服务端给出，且文案明确否认「保存 = 会投递」", () => {
    const html = body({
      view: {
        kind: "ready",
        payload: payload({
          channels: [row({ id: 1, kind: "telegram" }), row({ id: 2, kind: "webhook", target: "https://hooks.example.com/***ab", target_masked: true, secret_state: "unset" })],
          delivery_kinds: { registered: ["email", "telegram"], enabled: [], announcement: [] },
          warnings: ["webhook：表里有 1 条平台行，但 webhook 不在投递渠道注册表中（当前注册表：email / telegram）—— 保存成功不等于会被投递"],
        }),
      },
    });
    expect(html).toContain('data-testid="notification-delivery-registered"');
    expect(html).toContain("邮件、Telegram");
    // enabled 是空的 ⇒ 必须如实显示"（空）"，而不是把它渲染成"已开启"
    expect(html).toContain('data-testid="notification-delivery-enabled"');
    expect(html).toContain("（空）");
    expect(html).toContain('data-testid="notification-warnings"');
    expect(html).toContain("webhook 不在投递渠道注册表中");
    expect(html).toContain("不等于会被投递");
    expect(html).toContain('data-testid="notification-delivery-note"');
    expect(html).toContain("不会让未接线的渠道开始投递");
  });

  test("email 渠道凭据不在本页（避免让管理员以为在这里配 SMTP）", () => {
    expect(body()).toContain("部署级 SMTP 配置");
  });
});

describe("N2-UI 呈现：权限三态与凭据只写不读", () => {
  test("permission=read ⇒ 保存/移除/开关都禁用，并说明需要写权限", () => {
    const html = body({ permission: "read" });
    expect(html).toContain('data-testid="notification-permission"');
    expect(html).toContain("只读");
    expect(hasDisabledAttr(html, "notification-telegram-save")).toBe(true);
    expect(hasDisabledAttr(html, "notification-webhook-save")).toBe(true);
    expect(hasDisabledAttr(html, "notification-telegram-remove")).toBe(true);
    expect(hasDisabledAttr(html, "notification-row-remove-1")).toBe(true);
    expect(hasDisabledAttr(html, "notification-telegram-token")).toBe(true);
    expect(hasDisabledAttr(html, "notification-webhook-target")).toBe(true);
  });

  test("permission=write ⇒ 可操作", () => {
    const html = body({ permission: "write" });
    expect(hasDisabledAttr(html, "notification-telegram-save")).toBe(false);
    expect(hasDisabledAttr(html, "notification-row-remove-1")).toBe(false);
  });

  test("permission=unknown ⇒ 按只读处理（权限读不到时不做乐观隐藏）", () => {
    const html = body({ permission: "unknown" });
    expect(html).toContain("权限尚未确定");
    expect(hasDisabledAttr(html, "notification-telegram-save")).toBe(true);
  });

  test("凭据输入框**不回填**：HTML 里没有 value 属性（只写不读的可执行形式）", () => {
    const html = body({ permission: "write" });
    const tokenTag = tagOf(html, "notification-telegram-token");
    const targetTag = tagOf(html, "notification-webhook-target");
    expect(tokenTag).toContain('type="password"');
    expect(tokenTag).not.toContain("value=");
    expect(targetTag).not.toContain("value=");
    // 服务端回显的 `value` 恒为空串，界面里也不存在任何凭据文本
    expect(html).not.toContain("s3cret");
  });

  test("移除是两步确认（第一步只出现「移除」，不会一点就删）", () => {
    const idle = body({ pendingRemove: null });
    expect(idle).toContain('data-testid="notification-row-remove-1"');
    expect(idle).not.toContain('data-testid="notification-row-remove-confirm-1"');
    const pending = body({ pendingRemove: "row:telegram:1" });
    expect(pending).toContain('data-testid="notification-row-remove-confirm-1"');
  });
});

describe("N2-UI 呈现：写操作失败三档与成功提示", () => {
  test("403 / 400 / 503 三段文案互不冒充", () => {
    const forbidden = body({ actionError: classifyAdminActionError(new ApiError(403, "无权", null), "fb") });
    expect(forbidden).toContain("没有写权限");
    const rejected = body({ actionError: classifyAdminActionError(new ApiError(400, "形状非法", { code: "invalid_target" }), "fb") });
    expect(rejected).toContain("服务端拒绝了这次提交");
    expect(rejected).toContain("invalid_target");
    const unavailable = body({ actionError: classifyAdminActionError(new ApiError(503, "down", { code: "storage_error" }), "fb") });
    expect(unavailable).toContain("存储暂时不可用");
  });

  test("保存成功只给一次性提示（且不暗示投递已生效）", () => {
    const html = body({ actionNotice: "Telegram 配置已保存（凭据不再回显）" });
    expect(html).toContain('data-testid="notification-action-notice"');
    expect(html).toContain("凭据不再回显");
    expect(html).toContain("不会让未接线的渠道开始投递");
  });

  test("英文分支同样表述这些事实", () => {
    const html = body({ locale: "en", permission: "read" });
    expect(html).toContain("Read-only");
    expect(html).toContain("write-only");
    expect(html).toContain("does not start delivering");
  });
});
