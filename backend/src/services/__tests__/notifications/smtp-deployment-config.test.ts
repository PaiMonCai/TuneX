/**
 * N-F1 —— 「SMTP 的 UI 配置不生效」的**行为**测试（真话收口）。
 *
 * 背景（R4-A 的 N-F1）：管理端能写 `SMTP_*`（含 `SMTP_PASS` 只写不读），但 `services/mail.ts`
 * 只读 `env.ts` 的 `mail` 段（`process.env.SMTP_*`）⇒ **在 UI 配 SMTP 对邮件渠道与验证/重置
 * 邮件完全不生效**。那个表单在主动骗人（保存成功 = 界面显示成功，而信永远发不出去）。
 *
 * 处置（Lead 批准 (b)）：**不列、不写、写明理由**（给出具体环境变量名与文档入口），
 * 历史行**留在库里但不被当作可配置项**（不删除——删是破坏性动作）。
 *
 * 本文件钉住三条：
 *  ① `PUT /api/admin/system/config/SMTP_*` → **明确拒绝**（400 + `deployment_level_config` +
 *     理由里点到环境变量），**零落库**（存储写入根本没被调用）；
 *  ② `GET /api/admin/system/config` → **不再列出** SMTP_* 键（历史行仍在库里）；
 *  ③ 其它配置项的读写路径**不受影响**（回归保护）。
 *
 * task-33 把审计扩到**全部配置键**：本文件同时钉住"未接线键"（没有任何生产读者）与"已废弃键"
 * （NOTICE*：真相已迁到 announcement 表）的处置 —— 同样"写入被拒 + 零落库 + GET 不再列为可配置"，
 * 并断言历史行**原样在位**（忽略 ≠ 删除）。
 *
 * 位置说明：task-14 的 writeScopes 里没有列出新的后端测试文件，这里放在
 * `src/services/__tests__/notifications/`（本切片与通知 email 渠道同域，且该目录由 notify-center
 * 持有），避免动别人的测试文件。
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { Hono } from "hono";

/* ------------------------------------------------------------------ */
/* 受控存储：与真实 `services/config.ts` 同形状（listAll / setConfig）    */
/* ------------------------------------------------------------------ */

interface ConfigRow {
  id: number;
  name: string;
  value: string;
  created_at: string;
  updated_at: string;
}

let store: ConfigRow[] = [];
const writes: Array<{ name: string; value: string }> = [];

// 替身必须**语义完整**（`mock.module` 是进程级注册表，部分字面量会泄漏到别的文件）：
// 先取真实模块再 spread，只覆盖 `systemConfig` 这一个导出。
import * as realConfig from "../../../services/config.ts";

mock.module("../../../services/config.ts", () => ({
  ...realConfig,
  systemConfig: {
    async listAll() {
      return store.map((row) => ({ ...row }));
    },
    async setConfig(name: string, value: string) {
      writes.push({ name, value });
      const row = store.find((r) => r.name === name);
      if (row) row.value = value;
    },
    async getConfig() {
      return null;
    },
    async getBool() {
      return false;
    },
    async getNumber() {
      return 0;
    },
  },
}));

const { adminRoutes } = await import("../../../routes/admin.ts");

const app = new Hono();
app.route("/api/admin", adminRoutes);

function row(name: string, value = ""): ConfigRow {
  return { id: 1, name, value, created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" };
}

beforeEach(() => {
  writes.length = 0;
  store = [
    row("SITE_NAME", "TuneX"),
    // 历史行：库里曾经写过 SMTP_*（本切片不删它，只是不再当配置项）
    row("SMTP_HOST", "smtp.legacy.example"),
    row("SMTP_PASS", "legacy-secret"),
    row("RESEND_API_KEY", "re_legacy"),
  ];
});

describe("N-F1 写入：SMTP_* 被明确拒绝且零落库", () => {
  test("PUT SMTP_HOST → 400 deployment_level_config，理由点到环境变量与文档", async () => {
    const res = await app.request("/api/admin/system/config/SMTP_HOST", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "smtp.example.com" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string; env_names: string[] };
    expect(body.code).toBe("deployment_level_config");
    expect(body.error).toContain("环境变量");
    expect(body.error).toContain("SMTP_HOST");
    expect(body.error).toContain("docs/production-deploy.md");
    expect(body.env_names).toEqual(["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_SECURE"]);
    // 关键：**零落库**（不是"接受后忽略"）
    expect(writes).toEqual([]);
    expect(store.find((r) => r.name === "SMTP_HOST")!.value).toBe("smtp.legacy.example");
  });

  test("PUT SMTP_PASS 同样被拒（凭据类键也不能走这条路），且绝不回 200", async () => {
    for (const name of ["SMTP_PASS", "SMTP_PORT", "SMTP_USER", "SMTP_FROM", "SMTP_SECURE"]) {
      const res = await app.request(`/api/admin/system/config/${name}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x" }),
      });
      expect({ name, status: res.status }).toEqual({ name, status: 400 });
      expect(((await res.json()) as { code: string }).code).toBe("deployment_level_config");
    }
    expect(writes).toEqual([]);
  });

  test("其它配置项照常可写（回归保护），未知键仍是 400", async () => {
    const ok = await app.request("/api/admin/system/config/SITE_NAME", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "TuneX Prod" }),
    });
    expect(ok.status).toBe(200);
    expect(writes).toEqual([{ name: "SITE_NAME", value: "TuneX Prod" }]);

    const unknown = await app.request("/api/admin/system/config/NOT_A_KEY", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain("未知配置项");
  });
});

describe("N-F1 读取：不再把 SMTP_* 列为可配置项（历史行仍在库里）", () => {
  test("GET 过滤掉 SMTP_*，其它键照常返回；凭据类键仍只给「配没配」", async () => {
    const res = await app.request("/api/admin/system/config");
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { data: ConfigRow[] }).data;
    const names = rows.map((r) => r.name);
    expect(names).toContain("SITE_NAME");
    expect(names).not.toContain("SMTP_HOST");
    expect(names).not.toContain("SMTP_PASS");
    // task-33 之后，**凭据类键一个都不在列表里了**：`SECRET_CONFIG_NAMES` 的三个键分别属于
    // "部署级"（SMTP_PASS）与"未接线"（RESEND_API_KEY / CHATWOOT_TOKEN）⇒ 都被过滤。
    // 掩码分支（`value:""` + `secret_configured`）因此对**当前这批键**不可达；它仍然留着，
    // 供将来"有读者的凭据键"使用 —— 这一点如实写在这里，不让测试假装它还在生效。
    expect(names).not.toContain("RESEND_API_KEY");
    expect(names).not.toContain("CHATWOOT_TOKEN");
    expect(names).not.toContain("SMTP_PASS");
  });

  test("历史行被**忽略**而不是被删除（库里仍然有那两行）", async () => {
    await app.request("/api/admin/system/config");
    await app.request("/api/admin/system/config/SMTP_HOST", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(store.map((r) => r.name)).toContain("SMTP_HOST");
    expect(store.map((r) => r.name)).toContain("SMTP_PASS");
    expect(store.find((r) => r.name === "SMTP_PASS")!.value).toBe("legacy-secret");
  });
});

/* ================================================================== */
/* task-33：未接线键与已废弃键（穷举审计的处置）                          */
/* ================================================================== */

/** 审计结论：这些键在 backend/src、web/src、agent/ 三处全文检索都**没有消费点**。 */
const UNWIRED_KEYS = [
  "EMAIL_PROVIDER",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "CHATWOOT_BASE_URL",
  "CHATWOOT_TOKEN",
  "REFERRAL_COMMISSION_RATE",
  "REFERRAL_FIRST_ONLY",
  "REFERRAL_MODE",
  "MIN_WITHDRAW_AMOUNT",
  "WITHDRAW_METHODS",
  "LIMIT_SCOPE",
  "AUTO_UPDATE_AGENT",
  "OBSERVER_PERIOD",
] as const;

const DEPRECATED_KEYS = ["NOTICE", "NOTICE_POPUP", "NOTICE_POPUP_INTERVAL_HOURS"] as const;

describe("task-33 未接线键：写入被明确拒绝且零落库", () => {
  test("每个未接线键：PUT → 400 config_not_wired，且**一次写调用都没有**", async () => {
    for (const name of UNWIRED_KEYS) {
      const res = await app.request(`/api/admin/system/config/${name}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x" }),
      });
      expect({ name, status: res.status }).toEqual({ name, status: 400 });
      const body = (await res.json()) as { code: string; error: string };
      expect({ name, code: body.code }).toEqual({ name, code: "config_not_wired" });
      // 理由必须说清"没有生产读者/尚未接线"，而不是一个泛化的 400
      expect(body.error).toContain("生产读者");
      expect(body.error).toContain("不会生效");
    }
    expect(writes).toEqual([]);
  });

  test("GET 不再把未接线键列为可配置项；历史行仍在库里（忽略 ≠ 删除）", async () => {
    store.push(row("CHATWOOT_TOKEN", "legacy-chatwoot"), row("RESEND_API_KEY", "re_legacy"), row("EMAIL_PROVIDER", "resend"));
    const rows = ((await (await app.request("/api/admin/system/config")).json()) as { data: ConfigRow[] }).data;
    const names = rows.map((r) => r.name);
    for (const key of UNWIRED_KEYS) expect(names).not.toContain(key);
    expect(names).toContain("SITE_NAME");
    // 历史行原样在位
    expect(store.find((r) => r.name === "CHATWOOT_TOKEN")!.value).toBe("legacy-chatwoot");
    expect(store.find((r) => r.name === "EMAIL_PROVIDER")!.value).toBe("resend");
  });
});

describe("task-33 已废弃键：只读列出（旧值可见）+ 写入被拒", () => {
  test("每个已废弃键：PUT → 400 config_deprecated，理由指向 announcement 表", async () => {
    for (const name of DEPRECATED_KEYS) {
      const res = await app.request(`/api/admin/system/config/${name}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "x" }),
      });
      expect({ name, status: res.status }).toEqual({ name, status: 400 });
      const body = (await res.json()) as { code: string; error: string };
      expect({ name, code: body.code }).toEqual({ name, code: "config_deprecated" });
      expect(body.error).toContain("announcement");
    }
    expect(writes).toEqual([]);
  });

  test("GET 仍列出它们（旧值可见）但带 read_only 标记；值本身不被清空", async () => {
    store.push(row("NOTICE", "旧公告正文"));
    const rows = ((await (await app.request("/api/admin/system/config")).json()) as { data: Array<ConfigRow & { read_only?: boolean; read_only_reason?: string }> }).data;
    const notice = rows.find((r) => r.name === "NOTICE")!;
    expect(notice.read_only).toBe(true);
    expect(notice.read_only_reason).toBe("deprecated");
    expect(notice.value).toBe("旧公告正文");
    // 其它未废弃的键**不带** read_only（不能顺手把整页变只读）
    expect(rows.find((r) => r.name === "SITE_NAME")!.read_only).toBeUndefined();
  });
});
