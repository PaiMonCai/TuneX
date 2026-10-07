/**
 * 切片 N4-UI —— 「投递记录」卡片的行为测试。
 *
 * A. 纯逻辑：五态、读失败分档、载荷辨认、失败原因文案（含**未知码不解释**）。
 * B. 呈现：逐分支静态渲染 `NotificationDeliveriesBody`，钉住本切片最怕的几件事：
 *    - `degraded` 与 `failed` **正交**（一次"已发送"的行也可能带降级标记，且必须可见）；
 *    - `rejected_target` / `secret_unreadable` 各有各的说法，**不得**渲染成"正常/已发送"；
 *    - 未知失败码**原样显示**并标注"本页不认识"，不猜一个解释；
 *    - 空账本明写「没有记录 ≠ 没有失败」；
 *    - `truncated` 明说"不是只有这些"；
 *    - 目标只有脱敏形态（本组件不做任何还原）。
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "@/lib/api";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import {
  DELIVERY_KNOWN_FAILURE_CODES,
  NotificationDeliveriesBody,
  classifyDeliveryReadError,
  deliveryFailureText,
  deliveryStatusText,
  deliveryView,
  type DeliveryView,
} from "@/components/settings/notification-deliveries";
import {
  readDeliveryPage,
  type DeliveryPage,
  type DeliveryRow,
} from "@/lib/api/notifications";

/* ================================================================== */
/* 工具                                                                */
/* ================================================================== */

function row(over: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    id: 1,
    status: "failed",
    failure_reason: "rejected_target",
    failure_reason_known: true,
    attempts: 0,
    degraded: false,
    channel_kind: "email",
    target: "***@example.com",
    target_masked: true,
    targets_count: 1,
    error: "RCPT TO:<***> returned 550",
    source_kind: "forward",
    source_id: "42",
    reason_code: "forward_apply_error",
    severity: "error",
    resource_type: "forward",
    resource_id: "42",
    occurred_at: "2026-10-06T10:00:00.000Z",
    window_start: "2026-10-06T10:00:00.000Z",
    ...over,
  };
}

function page(over: Partial<DeliveryPage> = {}): DeliveryPage {
  const rows = over.rows ?? [row()];
  return {
    scope_kind: "workspace",
    workspace_id: 10,
    truncated: false,
    limit: 50,
    summary: {
      total: rows.length,
      sent: rows.filter((r) => r.status === "sent").length,
      failed: rows.filter((r) => r.status === "failed").length,
      sending: rows.filter((r) => r.status === "sending").length,
      degraded: rows.filter((r) => r.degraded).length,
      by_failure_reason: {},
    },
    rows,
    ...over,
  };
}

const noop = () => undefined;

function body(over: { view?: DeliveryView; locale?: "zh" | "en"; statusFilter?: string | null } = {}): string {
  const locale = over.locale ?? "zh";
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { locale, dict: getDictionary(locale) },
      createElement(NotificationDeliveriesBody as never, {
        view: over.view ?? { kind: "ready", page: page() },
        locale,
        statusFilter: over.statusFilter ?? null,
        onFilterChange: noop,
        onRetry: noop,
      }),
    ),
  );
}

function rowBlock(html: string, id: number): string {
  const start = html.indexOf(`data-testid="delivery-row-${id}"`);
  expect(start).toBeGreaterThan(-1);
  const next = html.indexOf('data-testid="delivery-row-', start + 10);
  return html.slice(start, next === -1 ? undefined : next);
}

/* ================================================================== */
/* A. 纯逻辑                                                           */
/* ================================================================== */

describe("N4 五态：空账本 ≠ 一切正常", () => {
  test("五态各自成立，empty 只在真的读到 0 行时出现", () => {
    expect(deliveryView({ kind: "loading" }).kind).toBe("loading");
    expect(deliveryView({ kind: "forbidden", message: "x" }).kind).toBe("forbidden");
    expect(deliveryView({ kind: "unavailable", code: "storage_error", message: "x" }).kind).toBe("unavailable");
    expect(deliveryView({ kind: "ready", page: page({ rows: [] }) }).kind).toBe("empty");
    expect(deliveryView({ kind: "ready", page: page() }).kind).toBe("ready");
  });

  test("读失败分档：403 单独一态，其余按取不到（都不许变成空账本）", () => {
    expect(classifyDeliveryReadError(new ApiError(403, "无权", null), "fb")).toMatchObject({ kind: "forbidden" });
    expect(classifyDeliveryReadError(new ApiError(503, "down", { code: "storage_error" }), "fb")).toMatchObject({
      kind: "unavailable",
      code: "storage_error",
    });
    expect(classifyDeliveryReadError(new TypeError("Failed to fetch"), "fb")).toMatchObject({ kind: "unavailable", code: null });
  });

  test("载荷辨认：两种信封都收；畸形/残缺一律抛错（不显示残缺列表冒充全部）", () => {
    const bare = page();
    expect(readDeliveryPage(bare).rows).toHaveLength(1);
    expect(readDeliveryPage({ data: bare }).rows).toHaveLength(1);
    expect(() => readDeliveryPage({ summary: {} })).toThrow();
    expect(() => readDeliveryPage(null)).toThrow();
    expect(() => readDeliveryPage({ rows: [row(), { id: "x" }], summary: {} })).toThrow();
  });

  test("失败原因：6 态闭集都有独立人话；未知码原样 + 标注不认识；null 不成句", () => {
    expect(DELIVERY_KNOWN_FAILURE_CODES).toEqual([
      "not_configured",
      "transport_error",
      "rejected_target",
      "unsupported_channel",
      "secret_unreadable",
      "ledger_unavailable",
    ]);
    const texts = DELIVERY_KNOWN_FAILURE_CODES.map((code) => deliveryFailureText("zh", code, true).detail);
    expect(new Set(texts).size).toBe(6); // 六态互不重复
    for (const text of texts) expect(text.length).toBeGreaterThan(5);
    // 关键区分：解不开 ≠ 没配置
    expect(deliveryFailureText("zh", "secret_unreadable", true).detail).toContain("不是「没配置」");
    expect(deliveryFailureText("zh", "rejected_target", true).detail).toContain("不是「已发送」");
    const unknown = deliveryFailureText("zh", "brand_new_code", false);
    expect(unknown).toMatchObject({ title: "brand_new_code", known: false });
    expect(unknown.detail).toContain("不认识");
    expect(deliveryFailureText("zh", null, true).title).toBe("—");
  });

  test("状态：未知 status 原样显示，不猜成「已发送」", () => {
    expect(deliveryStatusText("zh", "sent")).toContain("已发送");
    expect(deliveryStatusText("zh", "sent")).toContain("不代表收件人已读");
    expect(deliveryStatusText("zh", "failed")).toBe("失败");
    expect(deliveryStatusText("zh", "sending")).toContain("未收敛");
    expect(deliveryStatusText("zh", "exploded")).toBe("exploded");
  });
});

/* ================================================================== */
/* B. 呈现                                                            */
/* ================================================================== */

describe("N4 呈现：取不到/无权限/空账本互不冒充", () => {
  test("loading：只显示读取中", () => {
    const html = body({ view: { kind: "loading" } });
    expect(html).toContain('data-testid="deliveries-loading"');
    expect(html).not.toContain('data-testid="deliveries-rows"');
    expect(html).not.toContain('data-testid="deliveries-empty"');
  });

  test("403：明说没有读取权限，且不是「没有失败记录」", () => {
    const html = body({ view: { kind: "forbidden", message: "无权访问" } });
    expect(html).toContain('data-testid="deliveries-forbidden"');
    expect(html).toContain("不代表");
    expect(html).not.toContain('data-testid="deliveries-empty"');
  });

  test("取不到：明说「不代表一切正常，也不代表没有失败」", () => {
    const html = body({ view: { kind: "unavailable", code: "storage_error", message: "存储不可用" } });
    expect(html).toContain('data-testid="deliveries-unavailable"');
    expect(html).toContain("不代表「一切正常」");
    expect(html).not.toContain('data-testid="deliveries-empty"');
  });

  test("空账本：明写「没有记录 ≠ 没有失败」，并显示服务端的零汇总", () => {
    const html = body({ view: { kind: "empty", page: page({ rows: [] }) } });
    expect(html).toContain('data-testid="deliveries-empty"');
    expect(html).toContain("「没有记录」只说明这段时间没有投递发生");
    expect(html).toContain("不是「没有失败」");
    expect(html).toContain('data-testid="deliveries-summary"');
    expect(html).toContain("共 0 条");
    expect(html).not.toContain('data-testid="deliveries-rows"');
  });
});

describe("N4 呈现：失败与降级各有各的说法", () => {
  test("失败行：状态=失败 + 失败原因 + 人话 + 尝试次数 + 来源/原因码/时间", () => {
    const html = body();
    const block = rowBlock(html, 1);
    expect(block).toContain("失败");
    expect(block).toContain("rejected_target");
    expect(block).toContain("目标被拒绝");
    expect(block).toContain("尝试次数 0");
    expect(block).toContain("forward #42");
    expect(block).toContain("forward_apply_error");
    expect(block).toContain("2026-");
  });

  test("rejected_target 的行**不得**出现「已发送」字样（拒绝也要可见，不能折叠成正常）", () => {
    const html = body({ view: { kind: "ready", page: page({ rows: [row({ id: 3, status: "failed", failure_reason: "rejected_target" })] }) } });
    const block = rowBlock(html, 3);
    // 状态徽章必须说"失败"（而不是把这一行显示成已发送）；人话里那句「这不是「已发送」」
    // 是刻意写的——它正是在防"折叠成正常"。
    expect(block).toMatch(/data-testid="delivery-status-3"[^>]*>失败</);
    expect(block).toContain("不是「已发送」");
  });

  test("secret_unreadable 单独成句：是「配置坏了」而不是「没配置」", () => {
    const html = body({
      view: {
        kind: "ready",
        page: page({ rows: [row({ id: 4, status: "failed", failure_reason: "secret_unreadable" })] }),
      },
    });
    const block = rowBlock(html, 4);
    expect(block).toContain("secret_unreadable");
    expect(block).toContain("凭据解不开");
    // 与 not_configured（"渠道未配置"）的说法必须不同
    expect(block).not.toContain("渠道未配置");
  });

  test("degraded 与 failed 正交：一条**已发送**的行带降级标记时，两者都要可见", () => {
    const html = body({
      view: { kind: "ready", page: page({ rows: [row({ id: 5, status: "sent", failure_reason: null, degraded: true })] }) },
    });
    const block = rowBlock(html, 5);
    expect(block).toContain("已发送");
    expect(block).toContain('data-testid="delivery-degraded-5"');
    expect(block).toContain("可能多报");
    // 降级汇总单独一行（服务端计数）
    expect(html).toContain('data-testid="deliveries-degraded-summary"');
    // 已发送的行不该出现"失败原因"块
    expect(block).not.toContain('data-testid="delivery-failure-5"');
  });

  test("未知失败码：原样显示 + 明说本页不认识（不解释成正常）", () => {
    const html = body({
      view: { kind: "ready", page: page({ rows: [row({ id: 6, failure_reason: "brand_new_code", failure_reason_known: false })] }) },
    });
    const block = rowBlock(html, 6);
    expect(block).toContain("brand_new_code");
    expect(block).toContain("本页不认识这个失败码");
    expect(block).not.toContain("正常");
  });

  test("目标只显示脱敏形态（本组件不还原），并标「已脱敏」；无目标时明说没有目标", () => {
    const html = body({
      view: {
        kind: "ready",
        page: page({
          rows: [
            row({ id: 7, target: "***@example.com", target_masked: true, targets_count: 2 }),
            row({ id: 8, target: "", target_masked: false, targets_count: 0 }),
          ],
        }),
      },
    });
    expect(rowBlock(html, 7)).toContain("***@example.com");
    expect(rowBlock(html, 7)).toContain("已脱敏");
    expect(rowBlock(html, 7)).toContain("共 2 个目标");
    expect(rowBlock(html, 8)).toContain("（没有目标）");
  });

  test("truncated 明说「不是只有这些」；未截断时不出现", () => {
    const truncated = body({ view: { kind: "ready", page: page({ truncated: true, limit: 2 }) } });
    expect(truncated).toContain('data-testid="deliveries-truncated"');
    expect(truncated).toContain("还有更早的记录没有显示");
    const full = body();
    expect(full).not.toContain('data-testid="deliveries-truncated"');
  });

  test("汇总数字来自服务端（不是前端数出来的）", () => {
    const served = page({
      rows: [row({ id: 9 })],
      summary: { total: 9, sent: 7, failed: 2, sending: 0, degraded: 1, by_failure_reason: { rejected_target: 2 } },
    });
    const html = body({ view: { kind: "ready", page: served } });
    expect(html).toContain("共 9 条：已发送 7、失败 2、发送中 0");
  });

  test("状态筛选按钮体现当前选择；失败原因块的 error 摘要照旧显示（已由服务端脱敏）", () => {
    const html = body({ statusFilter: "failed" });
    expect(html).toContain('data-testid="deliveries-filter-failed"');
    // 静态渲染会把尖括号转义：按 HTML 里的实际形态断言
    expect(html).toContain("RCPT TO:&lt;***&gt; returned 550");
  });

  test("英文分支表述同样的事实", () => {
    const html = body({ locale: "en", view: { kind: "empty", page: page({ rows: [] }) } });
    expect(html).toContain("No delivery records in this period");
    expect(html).toContain("not “no failures”");
  });
});
