/**
 * N4 —— 投递账本只读投影的**行为**测试。
 *
 * 两层：
 *  A. **纯函数**：脱敏（target/error）、闭集校验、汇总口径。这些决定"界面会说什么"。
 *  B. **路由**：用真实 router + 受控 membership/存储替身跑请求，证明**结构与作用域**：
 *     平台行在 SQL 条件上就匹配不到、跨 workspace 读不到、未知过滤条件 400（而不是"忽略它"）、
 *     读失败 503 与"没有记录"不同形、`truncated` 不静默截断。
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { createHash } from "node:crypto";
import { Hono } from "hono";

/* ------------------------------------------------------------------ */
/* 替身：membership + 账本（必须在被测路由 import 之前注册）             */
/* ------------------------------------------------------------------ */

let currentWorkspace = 10;
const ledgerRows: Array<Record<string, unknown>> = [];
let findByManyError: Error | null = null;
const findManyCalls: Array<Record<string, unknown>> = [];

/** 只实现本模块用到的 where/orderBy/take 形状，行为与真实查询逐条对应。 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

mock.module("../../../services/workspace.ts", () => ({
  resolveWorkspaceMembership: async () => ({ id: currentWorkspace, role: "member" as const }),
  resolveWorkspaceAccess: async () => ({ id: currentWorkspace, role: "member" as const }),
}));

mock.module("../../../db.ts", () => ({
  db: {
    notificationDelivery: {
      async findMany(args: Record<string, unknown>) {
        findManyCalls.push(args);
        if (findByManyError) throw findByManyError;
        const where = (args.where ?? {}) as Record<string, unknown>;
        const orderBy = args.orderBy as Array<{ id?: "asc" | "desc" }> | undefined;
        const take = typeof args.take === "number" ? args.take : undefined;
        let rows = ledgerRows.filter((row) => matches(row, where));
        if (orderBy?.[0]?.id === "desc") rows = [...rows].sort((a, b) => Number(b.id) - Number(a.id));
        if (take !== undefined) rows = rows.slice(0, take);
        return rows.map((row) => ({ ...row }));
      },
    },
  },
}));

const { notificationDeliveryRoutes } = await import("../../../routes/notification-deliveries.ts");
const {
  DELIVERY_FAILURE_REASONS,
  maskDeliveryTarget,
  parseDeliveryQuery,
  projectDeliveryError,
  projectDeliveryRow,
  summarizeDeliveries,
} = await import("../../../routes/notification-deliveries.ts");

const app = new Hono();
app.route("/api/notifications", notificationDeliveryRoutes);

const URL_BASE = "http://localhost/api/notifications/deliveries";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    scope_kind: "workspace",
    workspace_id: 10,
    source_kind: "forward",
    source_id: "42",
    reason_code: "forward_apply_error",
    severity: "error",
    resource_type: "forward",
    resource_id: "42",
    channel_kind: "email",
    target: "ops@example.com",
    status: "failed",
    failure_reason: "rejected_target",
    attempts: 0,
    degraded: false,
    error: null,
    occurred_at: new Date("2026-10-06T10:00:00.000Z"),
    window_start: new Date("2026-10-06T10:00:00.000Z"),
    created_at: new Date("2026-10-06T10:00:01.000Z"),
    ...over,
  };
}

beforeEach(() => {
  ledgerRows.length = 0;
  findManyCalls.length = 0;
  findByManyError = null;
  currentWorkspace = 10;
});

/* ================================================================== */
/* A. 纯函数                                                           */
/* ================================================================== */

describe("N4 脱敏：凭据与『别人的联系方式』都不从这里出去", () => {
  test("webhook 目标只给 origin + 摘要；原文不出现", () => {
    const slack = "https://hooks.slack.com/services/T000/B000/SECRETPART";
    const projected = maskDeliveryTarget({ channel_kind: "webhook", target: slack });
    expect(projected.target).toBe("https://hooks.slack.com/***" + createHash("sha256").update(slack, "utf8").digest("hex").slice(0, 12));
    expect(projected.target_masked).toBe(true);
    expect(projected.target).not.toContain("SECRETPART");
  });

  test("邮箱只留域名（本地部分就是「人」）；telegram 全掩码；未知渠道一律 ***", () => {
    // 这条是 Lead 加硬的隐私要求：本空间任何活跃成员都能读这个投影，
    // 所以**任何一行**的完整收件地址都不许出现。
    expect(maskDeliveryTarget({ channel_kind: "email", target: "ops@example.com" })).toEqual({
      target: "***@example.com",
      target_masked: true,
      count: 1,
    });
    expect(maskDeliveryTarget({ channel_kind: "telegram", target: "100200300" })).toEqual({ target: "***", target_masked: true, count: 1 });
    expect(maskDeliveryTarget({ channel_kind: "telegram", target: "123456789:AAHtoken" })).toEqual({ target: "***", target_masked: true, count: 1 });
    expect(maskDeliveryTarget({ channel_kind: "email", target: "not-an-address" })).toEqual({ target: "***", target_masked: true, count: 1 });
    expect(maskDeliveryTarget({ channel_kind: "carrier_pigeon", target: "whatever" })).toEqual({ target: "***", target_masked: true, count: 1 });
    expect(maskDeliveryTarget({ channel_kind: "email", target: "  " })).toEqual({ target: "", target_masked: false, count: 0 });
  });

  test("已经是脱敏形态的 webhook 目标不被二次脱敏（跨表对照要能对上号）", () => {
    const already = "https://hooks.slack.com/***89b0e692fc1e";
    expect(maskDeliveryTarget({ channel_kind: "webhook", target: already }).target).toBe(already);
    // 但**原始** URL（含路径/查询）仍然会被脱敏
    const raw = maskDeliveryTarget({ channel_kind: "webhook", target: "https://hooks.slack.com/services/T000/B000/SECRETPART" });
    expect(raw.target).not.toContain("SECRETPART");
    expect(raw.target).toContain("https://hooks.slack.com/***");
  });

  test("多目标：逐段脱敏后重连，并保留「一共投给了几个目标」这一层信息", () => {
    const masked = maskDeliveryTarget({ channel_kind: "email", target: "a@example.com,b@corp.example" });
    expect(masked.target).toBe("***@example.com,***@corp.example");
    expect(masked.count).toBe(2);
    expect(masked.target).not.toContain("a@");
    expect(masked.target).not.toContain("b@");
  });

  test("错误摘要：剥换行 + 截断 + 按渠道再脱敏，并把该行的原始目标替换掉", () => {
    const slack = "https://hooks.slack.com/services/T000/B000/SECRETPART";
    const masked = projectDeliveryError("webhook", `request to ${slack} failed\nwith 500`, slack);
    expect(masked).not.toContain("SECRETPART");
    expect(masked).not.toContain("\n");
    // 邮箱/telegram 的 error 里常带收件人 ⇒ 必须被替换成掩码
    const emailError = projectDeliveryError("email", "RCPT TO:<ops@example.com> returned 550", "ops@example.com");
    expect(emailError).not.toContain("ops@example.com");
    expect(emailError).toContain("***");
    // 未知渠道：无法安全脱敏 ⇒ 只给 failure_reason（这里返回 null）
    expect(projectDeliveryError("carrier_pigeon", "some raw text", "whatever")).toBeNull();
    expect(projectDeliveryError("telegram", "line1\nline2", "")).toBe("line1 line2");
    expect(projectDeliveryError("email", null, "ops@example.com")).toBeNull();
  });

  test("行投影包含全部服务端字段，且密文/明文一个都不出现", () => {
    const projected = projectDeliveryRow(row({ error: "secret-token=abcdef" }) as never);
    expect(Object.keys(projected).sort()).toEqual(
      [
        "attempts",
        "channel_kind",
        "degraded",
        "error",
        "failure_reason",
        "failure_reason_known",
        "id",
        "occurred_at",
        "reason_code",
        "resource_id",
        "resource_type",
        "severity",
        "source_id",
        "source_kind",
        "status",
        "target",
        "target_masked",
        "targets_count",
        "window_start",
      ].sort(),
    );
    expect(JSON.stringify(projected)).not.toContain("secret_enc");
  });

  test("闭集外的 failure_reason 不猜：原样透出并标 failure_reason_known=false", () => {
    const projected = projectDeliveryRow(row({ failure_reason: "brand_new_reason" }) as never);
    expect(projected.failure_reason).toBe("brand_new_reason");
    expect(projected.failure_reason_known).toBe(false);
    const known = projectDeliveryRow(row({ failure_reason: DELIVERY_FAILURE_REASONS[0]! }) as never);
    expect(known.failure_reason_known).toBe(true);
  });

  test("汇总：status 与 degraded **正交**计数，失败原因按原样取值分组", () => {
    const summary = summarizeDeliveries(
      [
        projectDeliveryRow(row({ id: 1, status: "failed", failure_reason: "rejected_target", degraded: true }) as never),
        projectDeliveryRow(row({ id: 2, status: "failed", failure_reason: "secret_unreadable" }) as never),
        projectDeliveryRow(row({ id: 3, status: "sent", failure_reason: null }) as never),
        projectDeliveryRow(row({ id: 4, status: "sending", failure_reason: null }) as never),
      ],
    );
    expect(summary).toEqual({
      total: 4,
      sent: 1,
      failed: 2,
      sending: 1,
      degraded: 1,
      by_failure_reason: { rejected_target: 1, secret_unreadable: 1 },
    });
  });

  test("未知过滤条件一律 400（不许忽略条件后返回全部）", () => {
    expect(parseDeliveryQuery({})).toMatchObject({ ok: true, query: { limit: 50, status: null } });
    expect(parseDeliveryQuery({ limit: "201" }).ok).toBe(false);
    expect(parseDeliveryQuery({ limit: "0" }).ok).toBe(false);
    expect(parseDeliveryQuery({ status: "exploded" })).toMatchObject({ ok: false, code: "invalid_filter" });
    expect(parseDeliveryQuery({ failure_reason: "not_a_reason" })).toMatchObject({ ok: false, code: "invalid_filter" });
    expect(parseDeliveryQuery({ status: "failed" })).toMatchObject({ ok: true, query: { status: "failed" } });
  });
});

/* ================================================================== */
/* B. 路由：作用域与失败分档                                            */
/* ================================================================== */

describe("N4 路由：严格 workspace 作用域（平台行结构上不可能出现）", () => {
  test("查询条件写死 workspace + 当前空间 id；平台行与别的空间的行都取不到", async () => {
    ledgerRows.push(
      row({ id: 1, workspace_id: 10 }),
      row({ id: 2, workspace_id: 11 }),
      row({ id: 3, scope_kind: "platform", workspace_id: null }),
    );
    const res = await app.request(URL_BASE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { workspace_id: number; rows: Array<{ id: number }>; summary: { total: number } } };
    expect(body.data.workspace_id).toBe(10);
    expect(body.data.rows.map((r) => r.id)).toEqual([1]);
    expect(body.data.summary.total).toBe(1);
    // 结构条件：不是"查出来再过滤"，而是条件里就带着 scope_kind + workspace_id。
    const where = findManyCalls[0]!.where as Record<string, unknown>;
    expect(where.scope_kind).toBe("workspace");
    expect(where.workspace_id).toBe(10);
  });

  test("列表里**完整收件地址永不出现**（本空间成员看得到失败，但看不到别人的联系方式）", async () => {
    ledgerRows.push(
      row({ id: 1, channel_kind: "email", target: "colleague@example.com" }),
      row({ id: 2, channel_kind: "email", target: "colleague@example.com,second@corp.example" }),
      row({ id: 3, channel_kind: "telegram", target: "100200300" }),
    );
    const res = await app.request(URL_BASE);
    const text = await res.clone().text();
    expect(text).not.toContain("colleague@example.com");
    expect(text).not.toContain("second@corp.example");
    expect(text).not.toContain("100200300");
    expect(text).toContain("***@example.com");
    const body = (await res.json()) as { data: { rows: Array<{ id: number; target: string; targets_count: number }> } };
    expect(body.data.rows.find((r) => r.id === 1)!.target).toBe("***@example.com");
    expect(body.data.rows.find((r) => r.id === 2)!.targets_count).toBe(2);
    expect(body.data.rows.find((r) => r.id === 3)!.target).toBe("***");
  });

  test("换个空间（membership 变了）看到的是那个空间的行，互不串", async () => {
    ledgerRows.push(row({ id: 1, workspace_id: 10 }), row({ id: 2, workspace_id: 11 }));
    currentWorkspace = 11;
    const body = (await (await app.request(URL_BASE)).json()) as { data: { rows: Array<{ id: number }> } };
    expect(body.data.rows.map((r) => r.id)).toEqual([2]);
  });

  test("详情：不存在 / 别的空间 / 平台行 逐字同形 404（不做跨作用域存在性探测）", async () => {
    ledgerRows.push(row({ id: 5, workspace_id: 11 }), row({ id: 6, scope_kind: "platform", workspace_id: null }));
    for (const id of [5, 6, 999]) {
      const res = await app.request(`${URL_BASE}/${id}`);
      expect({ id, status: res.status }).toEqual({ id, status: 404 });
      expect(((await res.json()) as { code: string }).code).toBe("not_found");
    }
    const mine = await app.request(`${URL_BASE}/1`);
    expect(mine.status).toBe(404); // 本空间没有 id=1
  });

  test("详情：自己的行可以读，且不含凭据", async () => {
    ledgerRows.push(
      row({
        id: 7,
        channel_kind: "webhook",
        target: "https://hooks.slack.com/***89b0e692fc1e",
        error: "webhook redirect not allowed: http_302",
      }),
    );
    const res = await app.request(`${URL_BASE}/7`);
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    // 账本里已经是脱敏形态（`origin/***摘要`）⇒ 原样保留：界面与账本对得上号。
    expect(text).toContain("https://hooks.slack.com/***89b0e692fc1e");
    expect(text).not.toContain("secret_enc");
    expect(text).not.toContain("SECRETPART");
  });
});

describe("N4 路由：失败分档与分页诚实性", () => {
  test("读失败 503 与「没有记录」不同形（空账本 200 + total=0）", async () => {
    findByManyError = new Error("db down");
    const failed = await app.request(URL_BASE);
    expect(failed.status).toBe(503);
    const failedBody = (await failed.json()) as { code: string; error: string };
    expect(failedBody.code).toBe("storage_error");
    expect(failedBody.error).toContain("不等于");

    findByManyError = null;
    const empty = await app.request(URL_BASE);
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { data: { rows: unknown[]; summary: { total: number } } };
    expect(emptyBody.data.rows).toEqual([]);
    expect(emptyBody.data.summary.total).toBe(0);
  });

  test("未知过滤条件 400（带闭集提示），不会静默忽略", async () => {
    const res = await app.request(`${URL_BASE}?status=exploded`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("invalid_filter");
    expect(body.error).toContain("sending");
    expect(findManyCalls.length).toBe(0); // 根本没碰数据库
  });

  test("超过上限的条数不被静默截断：truncated=true + limit 回显", async () => {
    for (let i = 1; i <= 5; i += 1) ledgerRows.push(row({ id: i }));
    const res = await app.request(`${URL_BASE}?limit=2`);
    const body = (await res.json()) as { data: { rows: Array<{ id: number }>; truncated: boolean; limit: number } };
    expect(body.data.rows.map((r) => r.id)).toEqual([5, 4]);
    expect(body.data.truncated).toBe(true);
    expect(body.data.limit).toBe(2);
  });

  test("过滤条件透传到 SQL：status / failure_reason / channel_kind / source_kind", async () => {
    ledgerRows.push(
      row({ id: 1, status: "failed", failure_reason: "rejected_target", channel_kind: "email" }),
      row({ id: 2, status: "failed", failure_reason: "secret_unreadable", channel_kind: "telegram" }),
      row({ id: 3, status: "sent", failure_reason: null, channel_kind: "email" }),
    );
    const res = await app.request(`${URL_BASE}?status=failed&channel_kind=telegram`);
    const body = (await res.json()) as { data: { rows: Array<{ id: number }> } };
    expect(body.data.rows.map((r) => r.id)).toEqual([2]);
    const where = findManyCalls[0]!.where as Record<string, unknown>;
    expect(where).toMatchObject({ status: "failed", channel_kind: "telegram", scope_kind: "workspace", workspace_id: 10 });
  });
});
