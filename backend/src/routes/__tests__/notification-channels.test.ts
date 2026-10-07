/**
 * 切片 N2 —— 平台级通知渠道配置端点的**行为**测试。
 *
 * ── 这份测试到底在证明什么 ──
 * 不是在证明"代码里出现了某个字符串"，而是用**真实路由 + 真实权限中间件 + 受控存储**跑请求，
 * 断言可观察的结果：
 *   ① `GET` 的响应体里**逐字不出现**密文与明文（telegram bot token / webhook URL 都是凭据）；
 *   ② `secret_state` 把 unset / sealed / unreadable 分成三态，且 `enabled=false` 与"未配置"可分；
 *   ③ `PUT` 形状非法一律 400 **且不落库**（存储替身里行数/内容不变）；
 *   ④ 权限：登记后的资源键真的按方法分级，别的键被挡，未登记路径仍然 fail-closed（对照组）；
 *   ⑤ 平台级语义：只会读/写 `scope_kind="platform" AND workspace_id IS NULL`，请求体不接受作用域覆盖。
 *
 * 存储用**内存替身**（实现 where/orderBy 语义），因为这里要断言的正是"读写了哪些行"；
 * 真实 MySQL 版本的启用/禁用语义由服务层既有测试与真实拓扑验收覆盖（见交付报告"未验证项"）。
 */
import { test, expect, describe, beforeEach, mock } from "bun:test";
import { Hono } from "hono";
import {
  ADMIN_RESOURCE_KEYS,
  getEffectiveAccess,
  levelSatisfies,
  requiredLevel,
  resolveAdminRoute,
  sanitizePermissions,
} from "../../permissions.ts";
import { adminPermissionGuard, type AppVariables } from "../../middlewares/auth.ts";
import { isTelegramChannelEnabled } from "../../services/notification-telegram.ts";
import { sealNotificationSecret, unsealNotificationSecret } from "../../services/notification-seal.ts";
import { redactWebhookTarget } from "../../services/notification-webhook.ts";

/* ================================================================== */
/* 受控存储替身（在路由 import **之前**注册 mock.module）                */
/* ================================================================== */

interface FakeRow {
  id: number;
  scope_kind: string;
  workspace_id: number | null;
  kind: string;
  target: string;
  secret_enc: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  created_by_id?: number | null;
}

let table: FakeRow[] = [];
let nextId = 1;
const calls: Array<{ op: string; args: unknown }> = [];

function matchesWhere(row: FakeRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    const actual = (row as unknown as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const inClause = (value as { in?: unknown[] }).in;
      if (Array.isArray(inClause)) return inClause.includes(actual);
    }
    return actual === value;
  });
}

const fakeDelegate = {
  async findMany(args: Record<string, unknown>) {
    calls.push({ op: "findMany", args });
    const where = (args.where ?? {}) as Record<string, unknown>;
    const rows = table.filter((row) => matchesWhere(row, where));
    const orderBy = args.orderBy as { id?: "asc" | "desc" } | undefined;
    if (orderBy?.id === "asc") rows.sort((a, b) => a.id - b.id);
    if (orderBy?.id === "desc") rows.sort((a, b) => b.id - a.id);
    return rows.map((row) => ({ ...row }));
  },
  async create(args: Record<string, unknown>) {
    calls.push({ op: "create", args });
    const data = (args.data ?? {}) as Partial<FakeRow>;
    const now = new Date();
    const row: FakeRow = {
      id: nextId++,
      scope_kind: String(data.scope_kind ?? ""),
      workspace_id: (data.workspace_id ?? null) as number | null,
      kind: String(data.kind ?? ""),
      target: String(data.target ?? ""),
      secret_enc: (data.secret_enc ?? null) as string | null,
      enabled: data.enabled !== false,
      created_at: now,
      updated_at: now,
      created_by_id: (data.created_by_id ?? null) as number | null,
    };
    table.push(row);
    return { ...row };
  },
  async update(args: Record<string, unknown>) {
    calls.push({ op: "update", args });
    const id = ((args.where ?? {}) as { id?: number }).id;
    const row = table.find((candidate) => candidate.id === id);
    if (!row) throw new Error("row not found");
    Object.assign(row, (args.data ?? {}) as Partial<FakeRow>, { updated_at: new Date() });
    return { ...row };
  },
  async deleteMany(args: Record<string, unknown>) {
    calls.push({ op: "deleteMany", args });
    const where = (args.where ?? {}) as Record<string, unknown>;
    const keep = table.filter((row) => !matchesWhere(row, where));
    const removed = table.length - keep.length;
    table = keep;
    return { count: removed };
  },
};

mock.module("../../db.ts", () => ({ db: { notificationChannel: fakeDelegate } }));

const { notificationChannelRoutes } = await import("../notification-channels.ts");

/* ================================================================== */
/* 应用装配：真实的 adminPermissionGuard（认证链在别处，这里只放 user）  */
/* ================================================================== */

let currentUser: { id: number; super_admin: boolean; admin_roles: Array<{ permissions: Record<string, string> }> } | null =
  { id: 1, super_admin: true, admin_roles: [] };

function buildApp() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("/api/admin/*", async (c, next) => {
    if (currentUser !== null) c.set("user", currentUser as unknown as NonNullable<AppVariables["user"]>);
    await next();
  });
  app.use("/api/admin/*", adminPermissionGuard);
  app.route("/api/admin", notificationChannelRoutes);
  return app;
}

const app = buildApp();

// 未登记路径的对照组：同一个真实中间件，路径不在权限表里。
const controlApp = new Hono<{ Variables: AppVariables }>();
controlApp.use("/api/admin/*", async (c, next) => {
  if (currentUser !== null) c.set("user", currentUser as unknown as NonNullable<AppVariables["user"]>);
  await next();
});
controlApp.use("/api/admin/*", adminPermissionGuard);
controlApp.get("/api/admin/definitely-unregistered", (c) => c.json({ data: "reached" }));

const ADMIN = "http://localhost/api/admin/notification-channels";

const MASTER = "unit-test-auth-secret-value-0123456789";
const TOKEN = "123456789:AAHtest0000000000000000000000000";
const OTHER_MASTER = "a-completely-different-master-secret-value";
const SLACK = "https://hooks.slack.com/services/T000/B000/SECRETPART";

function row(overrides: Partial<FakeRow>): FakeRow {
  const now = new Date("2026-10-07T00:00:00.000Z");
  return {
    id: nextId++,
    scope_kind: "platform",
    workspace_id: null,
    kind: "telegram",
    target: "",
    secret_enc: null,
    enabled: true,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function seed(rows: FakeRow[]): FakeRow[] {
  table = rows;
  nextId = rows.reduce((max, r) => Math.max(max, r.id), 0) + 1;
  return rows;
}

function noSmtpEnv(): void {
  for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_PORT", "SMTP_FROM"]) delete process.env[key];
  process.env.AUTH_SECRET = MASTER;
  delete process.env.TUNEX_NOTIFICATION_TELEGRAM_ENABLED;
  delete process.env.TUNEX_NOTIFICATION_WEBHOOK_ENABLED;
  delete process.env.TUNEX_NOTIFICATION_WEBHOOK_ALLOW_HTTP;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  seed([]);
  calls.length = 0;
  noSmtpEnv();
  currentUser = { id: 1, super_admin: true, admin_roles: [] };
});

/* ================================================================== */
/* ① GET：凭据不回显 + 三态 + 平台作用域                                */
/* ================================================================== */

describe("N2 GET：只给状态投影，绝不回显凭据", () => {
  test("密文与明文都逐字不出现在响应里；webhook URL 走同一份脱敏", async () => {
    const sealed = sealNotificationSecret(TOKEN, MASTER);
    seed([
      row({ id: 1, kind: "telegram", secret_enc: sealed, enabled: true }),
      row({ id: 2, kind: "webhook", target: SLACK, secret_enc: null, enabled: true }),
    ]);

    const res = await app.request(ADMIN);
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    // ① 明文 token、② 密文、③ webhook 的 URL 主体（路径/查询就是凭据）——一个都不许出现。
    expect(text.includes(TOKEN)).toBe(false);
    expect(text.includes(sealed)).toBe(false);
    expect(text.includes("SECRETPART")).toBe(false);
    expect(text.includes("/services/")).toBe(false);
    expect(text.includes("secret_enc")).toBe(false);

    const body = await json(res);
    const data = body.data as {
      scope_kind: string;
      channels: Array<Record<string, unknown>>;
    };
    expect(data.scope_kind).toBe("platform");
    const telegram = data.channels.find((c) => c.kind === "telegram")!;
    expect(telegram.secret_configured).toBe(true);
    expect(telegram.secret_state).toBe("sealed");
    const webhook = data.channels.find((c) => c.kind === "webhook")!;
    // 回显的是与投递账本同一份脱敏实现（origin + 摘要），不是原文。
    expect(webhook.target).toBe(redactWebhookTarget(SLACK));
    expect(webhook.target_masked).toBe(true);
  });

  test("secret_state 三态：unset / sealed / unreadable（解不开不等于没配、也不等于可用）", async () => {
    const sealedHere = sealNotificationSecret(TOKEN, MASTER);
    const sealedElsewhere = sealNotificationSecret(TOKEN, OTHER_MASTER);
    seed([
      row({ id: 1, kind: "telegram", secret_enc: null, enabled: true }), // 没配过
      row({ id: 2, kind: "telegram", secret_enc: sealedHere, enabled: true }), // 配了且能用
      row({ id: 3, kind: "telegram", secret_enc: sealedElsewhere, enabled: true }), // 密文在但解不开
    ]);

    const data = (await json(await app.request(ADMIN))).data as {
      channels: Array<Record<string, unknown>>;
    };
    const byId = new Map(data.channels.map((c) => [c.id as number, c]));
    expect(byId.get(1)).toMatchObject({ secret_configured: false, secret_state: "unset" });
    expect(byId.get(2)).toMatchObject({ secret_configured: true, secret_state: "sealed" });
    expect(byId.get(3)).toMatchObject({ secret_configured: true, secret_state: "unreadable" });
    // 加载器取"最新一条启用行"（id=3，解不开）⇒ 它才是被读取的那一行 —— 这正是可见的坏数据。
    expect(byId.get(3)).toMatchObject({ config_loaded: true });
    expect(byId.get(2)).toMatchObject({ config_loaded: false });
  });

  test("只读平台行：workspace 作用域与其它 scope_kind 一律不出现在列表里", async () => {
    seed([
      row({ id: 1, kind: "telegram", secret_enc: sealNotificationSecret(TOKEN, MASTER) }),
      row({ id: 2, kind: "telegram", scope_kind: "workspace", workspace_id: 7, secret_enc: "x" }),
      row({ id: 3, kind: "webhook", scope_kind: "workspace", workspace_id: 7, target: SLACK }),
    ]);
    const data = (await json(await app.request(ADMIN))).data as { channels: Array<{ id: number }> };
    expect(data.channels.map((c) => c.id)).toEqual([1]);
    const findMany = calls.find((call) => call.op === "findMany")!;
    expect((findMany.args as { where: unknown }).where).toEqual({ scope_kind: "platform", workspace_id: null });
  });

  test("enabled=false 与「未配置」可分：停用保留凭据，但不再进入投递集合", async () => {
    process.env.TUNEX_NOTIFICATION_TELEGRAM_ENABLED = "true";
    seed([row({ id: 1, kind: "telegram", secret_enc: sealNotificationSecret(TOKEN, MASTER), enabled: false })]);

    const data = (await json(await app.request(ADMIN))).data as {
      channels: Array<Record<string, unknown>>;
      delivery_kinds: { registered: string[]; enabled: string[] };
    };
    expect(data.channels[0]).toMatchObject({
      enabled: false,
      secret_configured: true,
      secret_state: "sealed",
      config_loaded: false,
      // 空目标就是"没有目标"：回 `***` 会让人以为藏了一个值。
      target: "",
      target_masked: false,
    });
    expect(data.delivery_kinds.registered).toContain("telegram");
    expect(data.delivery_kinds.enabled).not.toContain("telegram");
  });

  test("保存成功 ≠ 会被投递：部署开关关着时 telegram 有配置但不在 enabled 集合", async () => {
    seed([row({ id: 1, kind: "telegram", secret_enc: sealNotificationSecret(TOKEN, MASTER), enabled: true })]);

    const off = (await json(await app.request(ADMIN))).data as {
      delivery_kinds: { registered: string[]; enabled: string[]; announcement: string[] };
    };
    expect(off.delivery_kinds.registered).toContain("telegram");
    expect(off.delivery_kinds.enabled).not.toContain("telegram");
    expect(off.delivery_kinds.announcement).not.toContain("telegram");

    process.env.TUNEX_NOTIFICATION_TELEGRAM_ENABLED = "true";
    const on = (await json(await app.request(ADMIN))).data as {
      delivery_kinds: { enabled: string[]; announcement: string[] };
    };
    expect(isTelegramChannelEnabled()).toBe(true);
    expect(on.delivery_kinds.enabled).toContain("telegram");
    expect(on.delivery_kinds.announcement).toContain("telegram");
  });

  test("webhook 有行也不在投递注册表：warnings 里说清「保存成功不等于会被投递」", async () => {
    seed([row({ id: 1, kind: "webhook", target: "https://hooks.example.com/hook", enabled: true })]);
    const data = (await json(await app.request(ADMIN))).data as {
      delivery_kinds: { registered: string[] };
      warnings: string[];
    };
    expect(data.delivery_kinds.registered).not.toContain("webhook");
    expect(data.warnings.some((w) => w.includes("webhook") && w.includes("不等于会被投递"))).toBe(true);
    // 静态校验通过 ≠ 目标可用：DNS/IP 在出站时判定（与 `resolveWebhookTarget` 的既有分层一致）。
    expect(data.warnings.some((w) => w.includes("静态形状校验"))).toBe(true);
  });

  test("存储不可用 = 503 storage_error（不与「没有配置渠道」同形）", async () => {
    const original = fakeDelegate.findMany;
    fakeDelegate.findMany = async () => {
      throw new Error("db down");
    };
    try {
      const res = await app.request(ADMIN);
      expect(res.status).toBe(503);
      const body = await json(res);
      expect(body.code).toBe("storage_error");
    } finally {
      fakeDelegate.findMany = original;
    }
  });
});

/* ================================================================== */
/* ② PUT：唯一落库入口 + 形状校验 + 不落库                              */
/* ================================================================== */

describe("N2 PUT：密文落库、明文不回显、坏形状不落库", () => {
  test("telegram 首次配置：走 sealNotificationSecret，库里只有密文，响应 value 恒为空串", async () => {
    const res = await app.request(ADMIN + "/telegram", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, secret: TOKEN }),
    });
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    expect(text.includes(TOKEN)).toBe(false);
    const data = (await json(res)).data as Record<string, unknown>;
    // 与 admin.ts 的 SECRET_CONFIG_NAMES 同款：值恒空 + 只给"配没配"。
    expect(data.value).toBe("");
    expect(data.secret_configured).toBe(true);
    expect(data.secret_state).toBe("sealed");
    expect(data.row_created).toBe(true);

    // 库里那行：平台作用域、target 不承载收件人、secret_enc 是密文且能解回原 token。
    expect(table.length).toBe(1);
    const stored = table[0]!;
    expect(stored.scope_kind).toBe("platform");
    expect(stored.workspace_id).toBeNull();
    expect(stored.target).toBe("");
    expect(stored.secret_enc).not.toBeNull();
    expect(stored.secret_enc).not.toBe(TOKEN);
    expect(unsealNotificationSecret(stored.secret_enc!, MASTER)).toBe(TOKEN);
  });

  test("telegram 第二次 PUT 只改那一行（不新增），enabled=false 保留密文", async () => {
    seed([row({ id: 5, kind: "telegram", secret_enc: sealNotificationSecret(TOKEN, MASTER), enabled: true })]);
    const res = await app.request(ADMIN + "/telegram", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const data = (await json(res)).data as Record<string, unknown>;
    expect(data.row_created).toBe(false);
    expect(data.affected_ids).toEqual([5]);
    expect(data.enabled).toBe(false);
    expect(data.secret_configured).toBe(true);
    expect(table.length).toBe(1);
    // 停用 ≠ 删除：密文仍在（明文只能解出来，不是原样落库）。
    expect(unsealNotificationSecret(table[0]!.secret_enc!, MASTER)).toBe(TOKEN);
  });

  test("telegram 多行时更新「加载器实际会读的那一行」并报出多行事实", async () => {
    const first = sealNotificationSecret(TOKEN, MASTER);
    seed([
      row({ id: 1, kind: "telegram", secret_enc: first, enabled: true }),
      row({ id: 2, kind: "telegram", secret_enc: sealNotificationSecret(TOKEN, MASTER), enabled: true }),
    ]);
    const newToken = "987654321:BBHrotated000000000000000000000000";
    const data = (await json(
      await app.request(ADMIN + "/telegram", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: newToken }),
      }),
    )).data as { affected_ids: number[]; warnings: string[]; id: number };
    // 加载器是"取 id 最大的启用行"，所以更新必须落在那一条上；老行原样不动。
    expect(data.affected_ids).toEqual([2]);
    expect(data.id).toBe(2);
    expect(data.warnings.some((w) => w.includes("2 条启用行"))).toBe(true);
    expect(unsealNotificationSecret(table.find((r) => r.id === 2)!.secret_enc!, MASTER)).toBe(newToken);
    expect(table.find((r) => r.id === 1)!.secret_enc).toBe(first);
  });

  test("webhook：以 target 为身份，同 URL 更新、新 URL 新增", async () => {
    const first = await app.request(ADMIN + "/webhook", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: SLACK }),
    });
    expect(first.status).toBe(200);
    expect(((await json(first)).data as { row_created: boolean }).row_created).toBe(true);

    const again = await app.request(ADMIN + "/webhook", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: SLACK, enabled: false }),
    });
    expect(again.status).toBe(200);
    const againData = (await json(again)).data as { row_created: boolean; enabled: boolean };
    expect(againData.row_created).toBe(false);
    expect(againData.enabled).toBe(false);
    expect(table.length).toBe(1);

    const other = await app.request(ADMIN + "/webhook", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "https://hooks.example.com/other" }),
    });
    expect(other.status).toBe(200);
    expect(table.length).toBe(2);
  });

  test("非法形状一律 400 且零写入（存储替身完全没有写调用）", async () => {
    const cases: Array<{ name: string; path: string; body: unknown; code: string; reason?: string }> = [
      { name: "telegram token 形状非法", path: "/telegram", body: { secret: "not-a-token" }, code: "invalid_secret" },
      { name: "telegram 空 secret", path: "/telegram", body: { secret: "   " }, code: "invalid_secret" },
      { name: "telegram 不接受 target", path: "/telegram", body: { target: "12345" }, code: "unsupported_field" },
      { name: "telegram 首次配置缺 secret", path: "/telegram", body: { enabled: true }, code: "invalid_body" },
      { name: "telegram enabled 类型错", path: "/telegram", body: { enabled: "yes" }, code: "invalid_body" },
      {
        name: "webhook 明文 http 被既有解析器拒",
        path: "/webhook",
        body: { target: "http://hooks.example.com/hook" },
        code: "invalid_target",
        reason: "insecure_protocol_disallowed",
      },
      {
        name: "webhook 内网地址",
        path: "/webhook",
        body: { target: "https://10.0.0.1/hook" },
        code: "invalid_target",
        reason: "forbidden_address",
      },
      {
        name: "webhook URL 里带凭据",
        path: "/webhook",
        body: { target: "https://user:pass@hooks.example.com/hook" },
        code: "invalid_target",
        reason: "credentials_in_url",
      },
      { name: "webhook 不接受 secret", path: "/webhook", body: { target: SLACK, secret: "s" }, code: "unsupported_field" },
      { name: "webhook 缺 target", path: "/webhook", body: { enabled: true }, code: "invalid_body" },
      { name: "webhook target 超列宽", path: "/webhook", body: { target: `https://hooks.example.com/${"a".repeat(600)}` }, code: "invalid_target", reason: "exceeds_column_width" },
      { name: "作用域覆盖被拒", path: "/telegram", body: { secret: TOKEN, workspace_id: 3 }, code: "unknown_field" },
      { name: "scope_kind 覆盖被拒", path: "/telegram", body: { secret: TOKEN, scope_kind: "workspace" }, code: "unknown_field" },
      { name: "不可写的 kind", path: "/email", body: { secret: TOKEN }, code: "unsupported_kind" },
    ];

    for (const item of cases) {
      calls.length = 0;
      const res = await app.request(ADMIN + item.path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(item.body),
      });
      expect({ name: item.name, status: res.status }).toEqual({ name: item.name, status: 400 });
      // 先取原文再解析：`res.clone()` 在 body 已被读走之后会抛 ERR_BODY_ALREADY_USED。
      const text = await res.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      expect({ name: item.name, code: body.code }).toEqual({ name: item.name, code: item.code });
      if (item.reason !== undefined) expect({ name: item.name, reason: body.reason }).toEqual({ name: item.name, reason: item.reason });
      expect({ name: item.name, writes: calls.filter((call) => call.op !== "findMany").length }).toEqual({ name: item.name, writes: 0 });
      expect({ name: item.name, rows: table.length }).toEqual({ name: item.name, rows: 0 });
      // 请求体里塞进来的值不得回显（尤其是被拒的 target/secret 原文）。
      expect({ name: item.name, echoes: text.includes(TOKEN) || text.includes("not-a-token") || text.includes("user:pass") }).toEqual({ name: item.name, echoes: false });
    }
    expect(table.length).toBe(0);
  });

  test("非 JSON 请求体 = 400 invalid_body，不落库", async () => {
    const res = await app.request(ADMIN + "/telegram", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect(((await json(res)).code)).toBe("invalid_body");
    expect(table.length).toBe(0);
  });

  test("主密钥缺失 = 503 seal_unavailable，明文不落库、不回显", async () => {
    delete process.env.AUTH_SECRET;
    const res = await app.request(ADMIN + "/telegram", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: TOKEN }),
    });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect((JSON.parse(text) as Record<string, unknown>).code).toBe("seal_unavailable");
    expect(table.length).toBe(0);
    expect(text.includes(TOKEN)).toBe(false);
  });

  test("作用域由端点结构决定：写入行永远是 platform + workspace_id NULL", async () => {
    await app.request(ADMIN + "/telegram", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: TOKEN }),
    });
    const created = calls.find((call) => call.op === "create")!;
    const data = (created.args as { data: Record<string, unknown> }).data;
    expect(data.scope_kind).toBe("platform");
    expect(data.workspace_id).toBeNull();
    expect(data.created_by_id).toBe(1);
  });
});

/* ================================================================== */
/* ③ DELETE：只删平台行、可精确到单行                                    */
/* ================================================================== */

describe("N2 DELETE：只作用于平台行", () => {
  test("按 kind 删除只删平台行，workspace 行原样保留", async () => {
    seed([
      row({ id: 1, kind: "telegram", secret_enc: sealNotificationSecret(TOKEN, MASTER) }),
      row({ id: 2, kind: "telegram", secret_enc: "sealed-elsewhere" }),
      row({ id: 3, kind: "telegram", scope_kind: "workspace", workspace_id: 9, secret_enc: "x" }),
      row({ id: 4, kind: "webhook", target: SLACK }),
    ]);
    const res = await app.request(ADMIN + "/telegram", { method: "DELETE" });
    expect(res.status).toBe(200);
    const data = (await json(res)).data as { deleted: number; deleted_ids: number[]; delivery_kinds: { enabled: string[] } };
    expect(data.deleted).toBe(2);
    expect(data.deleted_ids).toEqual([1, 2]);
    expect(table.map((r) => r.id)).toEqual([3, 4]);
    // 平台行没了 ⇒ 投递集合里不再有 telegram（`enabled` 是现场重算的，不是缓存）。
    expect(data.delivery_kinds.enabled).not.toContain("telegram");
  });

  test("按 id 精确删除；跨作用域/不存在一律同形 404（不做存在性探测）", async () => {
    seed([
      row({ id: 1, kind: "telegram", secret_enc: sealNotificationSecret(TOKEN, MASTER) }),
      row({ id: 2, kind: "telegram", secret_enc: sealNotificationSecret(TOKEN, MASTER) }),
      row({ id: 3, kind: "telegram", scope_kind: "workspace", workspace_id: 9, secret_enc: "x" }),
    ]);
    const ok = await app.request(ADMIN + "/telegram/1", { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect(((await json(ok)).data as { deleted: number }).deleted).toBe(1);
    expect(table.map((r) => r.id)).toEqual([2, 3]);

    const gone = await app.request(ADMIN + "/telegram/1", { method: "DELETE" });
    expect(gone.status).toBe(404);
    expect(((await json(gone)).code)).toBe("not_found");

    // workspace 行即使 id 对得上也不是本端点的对象。
    const crossScope = await app.request(ADMIN + "/telegram/3", { method: "DELETE" });
    expect(crossScope.status).toBe(404);
    expect(table.map((r) => r.id)).toEqual([2, 3]);

    const badId = await app.request(ADMIN + "/telegram/abc", { method: "DELETE" });
    expect(badId.status).toBe(400);
  });

  test("删除一个从未配置过的渠道 = deleted 0（幂等，不谎报失败）", async () => {
    const res = await app.request(ADMIN + "/webhook", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(((await json(res)).data as { deleted: number }).deleted).toBe(0);
  });
});

/* ================================================================== */
/* ④ 权限：登记后的资源键真的按方法分级（真实 adminPermissionGuard）      */
/* ================================================================== */

describe("N2 权限：登记生效、按方法分级、别的键被挡、未登记路径仍 fail-closed", () => {
  function nonSuper(permissions: Record<string, string>) {
    currentUser = { id: 2, super_admin: false, admin_roles: [{ permissions }] };
  }

  test("没有任何该键 = 读与写都 403，且请求到不了处理器（零存储调用）", async () => {
    nonSuper({ nodes: "write" });
    calls.length = 0;
    expect((await app.request(ADMIN)).status).toBe(403);
    expect(
      (
        await app.request(ADMIN + "/telegram", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret: TOKEN }),
        })
      ).status,
    ).toBe(403);
    expect((await app.request(ADMIN + "/telegram", { method: "DELETE" })).status).toBe(403);
    expect(calls.length).toBe(0);
  });

  test("read 只能 GET；write 才能 PUT/DELETE（按方法分级，不是「有键就全通」）", async () => {
    nonSuper({ notification_channels: "read" });
    expect((await app.request(ADMIN)).status).toBe(200);
    expect(
      (
        await app.request(ADMIN + "/telegram", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret: TOKEN }),
        })
      ).status,
    ).toBe(403);

    nonSuper({ notification_channels: "write" });
    const put = await app.request(ADMIN + "/telegram", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: TOKEN }),
    });
    expect(put.status).toBe(200);
    expect((await app.request(ADMIN + "/telegram", { method: "DELETE" })).status).toBe(200);
  });

  test("未认证（无 user）= 401", async () => {
    currentUser = null;
    expect((await app.request(ADMIN)).status).toBe(401);
  });

  test("未登记路径的对照组仍然是 403（fail-closed 没被这次登记拆掉）", async () => {
    nonSuper({ notification_channels: "write" });
    expect((await controlApp.request("http://localhost/api/admin/definitely-unregistered")).status).toBe(403);
    expect(resolveAdminRoute("/admin/definitely-unregistered")).toBeUndefined();
  });

  test("权限表层面的可授权性：键能被保存、子路径同族、URL 唯一、无重复键", () => {
    expect(resolveAdminRoute("/admin/notification-channels")).toEqual({
      prefix: "/admin/notification-channels",
      key: "notification_channels",
    });
    // 子路径（PUT/DELETE 单行）必须落在同一前缀上，否则写操作会掉进"未登记 ⇒ 403"。
    expect(resolveAdminRoute("/admin/notification-channels/telegram")?.key).toBe("notification_channels");
    expect(resolveAdminRoute("/admin/notification-channels/telegram/7")?.key).toBe("notification_channels");
    // 段边界收住：相似名字不是这个资源。
    expect(resolveAdminRoute("/admin/notification-channels-x")).toBeUndefined();
    // 角色入库前的白名单必须收得下这个键，否则"能授权"是假的。
    expect(sanitizePermissions({ notification_channels: "write", "not-a-resource": "write" })).toEqual({
      notification_channels: "write",
    });
    const reader = getEffectiveAccess({ super_admin: false, admin_roles: [{ permissions: { notification_channels: "read" } }] });
    expect(levelSatisfies(reader.get("notification_channels")!, requiredLevel("GET"))).toBe(true);
    expect(levelSatisfies(reader.get("notification_channels")!, requiredLevel("PUT"))).toBe(false);
    expect(new Set(ADMIN_RESOURCE_KEYS).size).toBe(ADMIN_RESOURCE_KEYS.length);
  });
});
