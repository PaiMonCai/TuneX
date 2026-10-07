/**
 * 面板迁移回退（task-44）——**面板侧**配置的校验与渲染（纯函数）。
 *
 * 行为参照声明见 `services/node-install.ts` 顶部。这个文件钉三件事：
 *
 *   1. **两个键齐备才启用**（备用地址 + 迁移 id），与 Agent 侧
 *      `agentconfig.Config.PanelMigration` 的口径**逐条对齐**（同一组坏形状在两侧都要被拒）；
 *   2. **未配置 ⇒ 一行都不渲染**（"齐备才写、否则三个一起删"的可撤销语义）；
 *   3. **配置坏了必须能被运维看见**（`problem` 非空），不能退化成"当作没配"。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/node-install.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  PANEL_MIGRATION_ENV_KEYS,
  panelMigrationView,
  parsePanelMigration,
  readPanelMigrationFromEnv,
  renderPanelMigrationEnv,
} from "../node-install.ts";

const GOOD = { id: "mig-2026-10-07", fallback_url: "https://panel-b.example.com/", started_at: "2026-10-07T00:00:00Z" };

describe("readPanelMigrationFromEnv：面板侧的唯一入口（部署环境变量）", () => {
  test("三个变量齐备 ⇒ 启用；只给一个 ⇒ incomplete；都没有 ⇒ 未配置", () => {
    const full = readPanelMigrationFromEnv((k) =>
      k === PANEL_MIGRATION_ENV_KEYS.fallbackUrl
        ? "https://panel-b.example.com"
        : k === PANEL_MIGRATION_ENV_KEYS.migrationId
          ? "mig-env"
          : k === PANEL_MIGRATION_ENV_KEYS.startedAt
            ? "2026-10-07T00:00:00Z"
            : undefined,
    );
    expect(full.ok).toBe(true);

    const partial = readPanelMigrationFromEnv((k) =>
      k === PANEL_MIGRATION_ENV_KEYS.fallbackUrl ? "https://panel-b.example.com" : undefined,
    );
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.reason).toBe("incomplete");

    const none = readPanelMigrationFromEnv(() => undefined);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe("not_configured");
  });
});

describe("parsePanelMigration：三态（未配置 / 已配置 / 配置坏了）", () => {
  test("未配置：null / 空串 / 空对象 / 全空白 ⇒ not_configured（不是故障）", () => {
    for (const raw of [null, undefined, "", "   ", "{}", { id: "", fallback_url: "", started_at: "" }]) {
      const parsed = parsePanelMigration(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe("not_configured");
    }
  });

  test("两个键齐备 ⇒ 启用；尾部斜杠被去掉；started_at 原样保留", () => {
    const parsed = parsePanelMigration(JSON.stringify(GOOD));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.migration.fallbackUrl).toBe("https://panel-b.example.com");
      expect(parsed.migration.id).toBe("mig-2026-10-07");
      expect(parsed.migration.startedAt).toBe("2026-10-07T00:00:00Z");
    }
  });

  test("也接受已解析的对象与 camelCase 别名（面板内部复用）", () => {
    const parsed = parsePanelMigration({ id: "m1", fallbackUrl: "http://panel-b:3000", startedAt: "1759795200" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.migration.fallbackUrl).toBe("http://panel-b:3000");
  });

  test("只填一个 ⇒ incomplete（**不**静默当成未配置；与 Agent 侧同一口径）", () => {
    for (const raw of [{ id: "m1" }, { fallback_url: "http://panel-b:3000" }, { id: "m1", fallback_url: "" }]) {
      const parsed = parsePanelMigration(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.reason).toBe("incomplete");
        expect(parsed.reason === "incomplete" ? parsed.detail.length : 0).toBeGreaterThan(0);
      }
    }
  });

  test("备用地址不是绝对 http(s) ⇒ bad_url（不猜、不补全）", () => {
    for (const bad of ["panel-b:3000", "ftp://panel-b:3000", "//panel-b", "http://", "javascript:alert(1)"]) {
      const parsed = parsePanelMigration({ id: "m1", fallback_url: bad });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe("bad_url");
    }
  });

  test("started_at 只接受 unix 秒与 RFC3339（与 Go 侧逐字同口径）", () => {
    for (const good of ["1759795200", "2026-10-07T00:00:00Z", "2026-10-07T08:00:00+08:00", "2026-10-07T00:00:00.500Z"]) {
      const parsed = parsePanelMigration({ id: "m1", fallback_url: "http://panel-b:3000", started_at: good });
      expect(parsed.ok).toBe(true);
    }
    for (const bad of ["yesterday", "2026/10/07", "0", "-5", "1759795200.5"]) {
      const parsed = parsePanelMigration({ id: "m1", fallback_url: "http://panel-b:3000", started_at: bad });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe("bad_started_at");
    }
  });

  test("JSON 坏形状 ⇒ bad_shape（不是 not_configured）", () => {
    for (const raw of ["{not json", "[1,2]", '"just a string"']) {
      const parsed = parsePanelMigration(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(["bad_shape"]).toContain(parsed.reason);
    }
  });

  test("started_at 缺失 ⇒ 仍启用，startedAt=null（Agent 侧只能用失败阈值）", () => {
    const parsed = parsePanelMigration({ id: "m1", fallback_url: "http://panel-b:3000" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.migration.startedAt).toBeNull();
  });
});

describe("renderPanelMigrationEnv：齐备才写、否则一行都不写", () => {
  test("已配置 ⇒ 三行（缺 started_at 时两行）", () => {
    expect(renderPanelMigrationEnv({ id: "m1", fallbackUrl: "http://panel-b:3000", startedAt: "2026-10-07T00:00:00Z" })).toEqual([
      "TUNEX_PANEL_FALLBACK_URL=http://panel-b:3000",
      "TUNEX_PANEL_MIGRATION_ID=m1",
      "TUNEX_PANEL_MIGRATION_STARTED_AT=2026-10-07T00:00:00Z",
    ]);
    expect(renderPanelMigrationEnv({ id: "m1", fallbackUrl: "http://panel-b:3000", startedAt: null })).toEqual([
      "TUNEX_PANEL_FALLBACK_URL=http://panel-b:3000",
      "TUNEX_PANEL_MIGRATION_ID=m1",
    ]);
  });

  test("渲染出来的键名就是 Agent 侧读的那三个（env 契约）", () => {
    const lines = renderPanelMigrationEnv({ id: "m1", fallbackUrl: "http://panel-b:3000", startedAt: "1759795200" });
    expect(lines.map((l) => l.split("=")[0])).toEqual([
      "TUNEX_PANEL_FALLBACK_URL",
      "TUNEX_PANEL_MIGRATION_ID",
      "TUNEX_PANEL_MIGRATION_STARTED_AT",
    ]);
  });
});

describe("panelMigrationView：读投影必须自曝边界", () => {
  test("已配置 ⇒ configured=true，并声明节点运行态未持久化", () => {
    const view = panelMigrationView(parsePanelMigration(JSON.stringify(GOOD)));
    expect(view.configured).toBe(true);
    expect(view.id).toBe("mig-2026-10-07");
    expect(view.fallback_url).toBe("https://panel-b.example.com");
    expect(view.problem).toBeNull();
    expect(view.node_reported_state_persisted).toBe(false);
    expect(view.source).toBe(`env:${PANEL_MIGRATION_ENV_KEYS.fallbackUrl}`);
  });

  test("未配置 ⇒ configured=false 且 problem=null（缺省不是问题）", () => {
    const view = panelMigrationView(parsePanelMigration(null));
    expect(view.configured).toBe(false);
    expect(view.problem).toBeNull();
    expect(view.node_reported_state_persisted).toBe(false);
  });

  test("读不到（DB 降级）⇒ 与「确实没配置」分开：problem 必须是 unreadable", () => {
    const view = panelMigrationView({ ok: false, reason: "unreadable", detail: "db down" });
    expect(view.configured).toBe(false);
    expect(view.problem).toContain("unreadable");
    expect(view.problem).not.toBeNull();
    // 对照：确实没配置时 problem 必须是 null（"没配"不是问题）。
    expect(panelMigrationView(parsePanelMigration(null)).problem).toBeNull();
  });

  test("配置坏了 ⇒ configured=false 但 problem 非空（运维必须能看见）", () => {
    const view = panelMigrationView(parsePanelMigration({ id: "m1" }));
    expect(view.configured).toBe(false);
    expect(view.problem).toContain("incomplete");
    expect(view.problem).toContain("fallback_url");
  });
});
