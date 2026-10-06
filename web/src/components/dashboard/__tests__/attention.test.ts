/**
 * V4-WP8 §13.7 Wave 4 —— Dashboard「需要处理」待办的契约测试。
 *
 * 四件事：
 *   A. `lib/attention.ts` 的翻译层：归组、码 → 下一步、重试三态、跳转目标；
 *   B. 容错归一：`degraded` 三态（取不到 ≠ 一切正常）、缺字段不渲染 undefined；
 *   C. mock 与后端**同形**：`/dashboard/attention` 的条目、计数与排序逐条对照
 *      `backend/src/services/attention.ts` 的规则（含可重试结论同一来源）；
 *   D. 静态守卫：面板必须存在于 Dashboard，且**判定只有后端一处** ——
 *      前端不得出现心跳窗口 / revision 比较 / 自造重试表。
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  attentionAction,
  attentionHref,
  attentionRetryable,
  groupAttention,
  normalizeAttentionPayload,
} from "../../../lib/attention";
import { attentionText, ATTENTION_DICTS } from "../../../lib/attention-i18n";
import { conditionAction } from "../../../lib/node-lifecycle-i18n";
import { reasonAction } from "../../../lib/node-health-i18n";
import { applyErrorAction, applyErrorIsRetryable } from "../../../lib/forward-status";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import type { AttentionItem, AttentionPayload } from "../../../lib/types";

const readWeb = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
const readBackend = (rel: string) =>
  readFileSync(new URL(`../../../../../backend/src/${rel}`, import.meta.url), "utf8");

const COOKIE = "tunex_session=u1";

const call = <T>(method: string, path: string, body?: unknown) =>
  handleMock(method, path, { cookie: COOKIE, body }) as Promise<{ status: number; body: T }>;

function item(over: Partial<AttentionItem> & Pick<AttentionItem, "reason_code">): AttentionItem {
  return { kind: "forward", id: 1, name: "f", severity: "warning", ...over } as AttentionItem;
}

beforeEach(() => resetStore());

/* ================================================================== */
/* A. 翻译层（只翻译不判定）                                            */
/* ================================================================== */

describe("A. 待办条目 → 下一步动作 / 跳转", () => {
  test("节点准入码走 WP7 的 conditionAction（不自己写第二套文案）", () => {
    for (const code of ["node_in_maintenance", "node_disabled", "node_retiring", "node_waiting_install"] as const) {
      const nodeItem = item({ kind: "node", reason_code: code });
      for (const locale of ["zh", "en"] as const) {
        expect(`${code}/${locale}:${attentionAction(locale, nodeItem)}`).toBe(
          `${code}/${locale}:${conditionAction(locale, code)}`,
        );
      }
    }
  });

  test("健康理由码走 WP6 的 reasonAction（connection_offline / runtime_revision_behind）", () => {
    for (const code of ["connection_offline", "runtime_revision_behind"] as const) {
      const nodeItem = item({ kind: "node", id: 2, reason_code: code });
      for (const locale of ["zh", "en"] as const) {
        expect(`${code}:${attentionAction(locale, nodeItem)}`).toBe(`${code}:${reasonAction(locale, code)}`);
      }
    }
  });

  test("下发失败码走 applyErrorAction；未知码按 retryable 给「原文在详情」或「需要管理员」", () => {
    const known = item({
      reason_code: "forward_apply_error",
      severity: "error",
      apply_error_code: "port_allocation_failed",
      retryable: true,
    });
    expect(attentionAction("zh", known)).toBe(applyErrorAction("zh", "port_allocation_failed"));

    // 后端加了码而前端漏词条：不能编造建议，但必须给一步。
    const unknownRetryable = item({
      reason_code: "forward_apply_error",
      severity: "error",
      apply_error_code: "brand_new_backend_code",
      retryable: true,
    });
    expect(attentionAction("zh", unknownRetryable)).toBe(attentionText("zh").openDetail);
    expect(attentionAction("en", unknownRetryable)).toBe(attentionText("en").openDetail);

    const unknownNotRetryable = item({
      reason_code: "forward_apply_error",
      severity: "error",
      apply_error_code: "brand_new_backend_code",
      retryable: false,
    });
    expect(attentionAction("zh", unknownNotRetryable)).toBe(attentionText("zh").needsOperator);

    // 该行压根没有错误码 → 不猜，去详情看原文。
    const noCode = item({ reason_code: "forward_apply_error", severity: "error", apply_error_code: null });
    expect(attentionAction("zh", noCode)).toBe(attentionText("zh").openDetail);
  });

  test("「正在下发」不是故障：给「等」而不是编一个动作", () => {
    const pending = item({ reason_code: "forward_pending_apply", severity: "info" });
    expect(attentionAction("zh", pending)).toBe(attentionText("zh").waitingDelivery);
    expect(attentionAction("en", pending)).toBe(attentionText("en").waitingDelivery);
    // 「已运行但落后」走 WP6 的码表 —— 两句话不同（一个是故障排查，一个是等待），
    // 但都不猜：各自来自一张既有表。
    expect(attentionAction("zh", item({ reason_code: "runtime_revision_behind" }))).toBe(
      reasonAction("zh", "runtime_revision_behind"),
    );
  });

  test("重试三态：只有后端明确说 true 才给「重试」（null = 没有结论）", () => {
    expect(attentionRetryable(item({ reason_code: "forward_apply_error", retryable: true }))).toBe(true);
    expect(attentionRetryable(item({ reason_code: "forward_apply_error", retryable: false }))).toBe(false);
    expect(attentionRetryable(item({ reason_code: "forward_apply_error", retryable: null }))).toBe(null);
    // 缺字段同样等于「没结论」（旧后端），不是 false。
    expect(attentionRetryable(item({ reason_code: "forward_apply_error" }))).toBe(null);
  });

  test("跳转落到具体那一行（节点带 focus、转发进详情）", () => {
    expect(attentionHref({ kind: "node", id: 7 })).toBe("/nodes?focus=7");
    expect(attentionHref({ kind: "forward", id: 12 })).toBe("/forwards/12");
  });
});

describe("B. 容错归一与降级", () => {
  test("degraded 三态：true 保留、缺字段不当作 true", () => {
    const degraded = normalizeAttentionPayload({
      items: [],
      summary: {},
      total: 0,
      generated_at: "",
      degraded: true,
    })!;
    expect(degraded.degraded).toBe(true);

    const normal = normalizeAttentionPayload({ items: [], summary: {}, total: 0, generated_at: "" })!;
    expect(normal.degraded).toBe(undefined);
    expect("degraded" in normal).toBe(false);
  });

  test("缺字段补齐：summary 归零、total 回落到 items.length、脏输入返回 null", () => {
    expect(normalizeAttentionPayload(null)).toBe(null);
    expect(normalizeAttentionPayload("nope")).toBe(null);

    const messy = normalizeAttentionPayload({
      items: [{ kind: "node", id: 1, name: "n", severity: "warning", reason_code: "connection_offline" }],
      summary: { nodes_offline: "3" },
      generated_at: 42,
    })!;
    expect(messy.summary).toEqual({
      nodes_offline: 0,
      nodes_waiting_install: 0,
      nodes_restricted: 0,
      forwards_error: 0,
      forwards_pending: 0,
    });
    expect(messy.total).toBe(1);
    expect(messy.generated_at).toBe("");
  });

  test("归组保持后端给的顺序（组内顺序 = 严重度顺序），不重新排序", () => {
    const items: AttentionItem[] = [
      item({ kind: "node", id: 1, reason_code: "connection_offline" }),
      item({ kind: "node", id: 2, reason_code: "node_in_maintenance" }),
      item({ kind: "forward", id: 9, reason_code: "forward_apply_error", severity: "error" }),
    ];
    const groups = groupAttention(items);
    expect(groups.map((g) => g.kind)).toEqual(["node", "forward"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual([1, 2]);
    expect(groups[1]!.items.map((i) => i.id)).toEqual([9]);
    expect(groupAttention(null)).toEqual([]);
    expect(groupAttention([])).toEqual([]);
  });
});

/* ================================================================== */
/* C. mock 与后端同形                                                  */
/* ================================================================== */

describe("C. mock /dashboard/attention 与后端同形", () => {
  test("端点存在、返回 200、形状与 web 类型一致", async () => {
    const res = await call<AttentionPayload>("GET", "/dashboard/attention");
    expect(res.status).toBe(200);
    const payload = res.body;
    expect(Array.isArray(payload.items)).toBe(true);
    expect(typeof payload.generated_at).toBe("string");
    expect(payload.total).toBe(payload.items.length);
    for (const row of payload.items) {
      expect(["node", "forward"]).toContain(row.kind);
      expect(["error", "warning", "info"]).toContain(row.severity);
      expect(typeof row.name).toBe("string");
      // 普通页面**不**暴露 raw revision / desired internals。
      for (const leaked of ["config_revision", "applied_revision", "desired_status", "desired_revision_id"]) {
        expect(Object.keys(row)).not.toContain(leaked);
      }
    }
  });

  test("排序 == 后端：severity(error→warning→info) → kind(node 先) → id 升序", async () => {
    const { body } = await call<AttentionPayload>("GET", "/dashboard/attention");
    const weight = { error: 0, warning: 1, info: 2 } as const;
    const expected = [...body.items].sort((a, b) => {
      const bySeverity = weight[a.severity] - weight[b.severity];
      if (bySeverity !== 0) return bySeverity;
      if (a.kind !== b.kind) return a.kind === "node" ? -1 : 1;
      return Number(a.id) - Number(b.id);
    });
    expect(body.items.map((i) => `${i.severity}:${i.kind}:${i.id}`)).toEqual(
      expected.map((i) => `${i.severity}:${i.kind}:${i.id}`),
    );
  });

  test("summary 与 items 同源：每个计数都能在条目里找到对应", async () => {
    const { body } = await call<AttentionPayload>("GET", "/dashboard/attention");
    const count = (code: string) => body.items.filter((i) => i.reason_code === code).length;
    expect(body.summary.nodes_waiting_install).toBe(count("node_waiting_install"));
    expect(body.summary.nodes_offline).toBe(count("connection_offline"));
    expect(body.summary.forwards_error).toBe(count("forward_apply_error"));
    expect(body.summary.forwards_pending).toBe(count("runtime_revision_behind") + count("forward_pending_apply"));
    expect(body.summary.nodes_restricted).toBe(
      count("node_in_maintenance") + count("node_disabled") + count("node_retiring"),
    );
  });

  test("可重试结论只有一处来源：mock 调 applyErrorIsRetryable，不自己抄表", async () => {
    const runtime = readWeb("mocks/runtime.ts");
    expect(runtime).toContain("applyErrorIsRetryable(");
    // 曾经出现过的形态：mock 自己再写一份「哪些码可重试」。
    expect(runtime).not.toMatch(/mockForwardRetryable/);
    expect(runtime).not.toMatch(/RETRYABLE\s*=\s*new Set/);

    // 且结论确实按既有表给出（demo 数据里有错误行时才有；没有则本断言不成立的对象为空）。
    const { body } = await call<AttentionPayload>("GET", "/dashboard/attention");
    for (const row of body.items.filter((i) => i.reason_code === "forward_apply_error")) {
      if (row.apply_error_code) {
        expect(row.retryable).toBe(applyErrorIsRetryable(row.apply_error_code));
      } else {
        expect(row.retryable).toBe(null);
      }
    }
  });

  test("上限与聚合口径的常量与后端一致（读后端源码断言）", async () => {
    const backend = readBackend("services/attention.ts");
    const backendMax = /ATTENTION_MAX_ITEMS\s*=\s*(\d+)/.exec(backend);
    expect(backendMax).not.toBe(null);
    const mockConst = /MOCK_ATTENTION_MAX_ITEMS\s*=\s*(\d+)/.exec(readWeb("mocks/runtime.ts"));
    expect(mockConst?.[1]).toBe(backendMax?.[1]);

    // legacy 的 remote_port_forward 不进待办（后端 where category: "port_forward"）。
    expect(readWeb("mocks/runtime.ts")).toContain('tunnel.category !== "port_forward"');
    expect(backend).toContain('category: "port_forward"');
  });

  test("mock 的节点三层判定复用 mocks/node-lifecycle.ts，不重写窗口", () => {
    const lifecycle = readWeb("mocks/node-lifecycle.ts");
    expect(lifecycle).toContain("export function mockUserNodeStatus");
    expect(lifecycle).toContain("mockConnection(");
    expect(lifecycle).toContain("mockAcceptsBusiness(");
    // 90s 窗口在 mock 里只允许出现一次（mockConnection 自己）。
    expect([...lifecycle.matchAll(/ONLINE_WINDOW_MS\s*=/g)]).toHaveLength(1);
  });
});

/* ================================================================== */
/* D. 静态守卫：判定只有一处、入口在 Dashboard 上                        */
/* ================================================================== */

describe("D. 静态守卫", () => {
  test("Dashboard 先给待办再给曲线（异常入口不被埋在计数卡片之后）", () => {
    const body = readWeb("components/dashboard/dashboard-body.tsx");
    const panelAt = body.indexOf("<AttentionPanel");
    const trafficAt = body.indexOf("dashboard.trafficTrend");
    expect(panelAt).toBeGreaterThan(-1);
    expect(trafficAt).toBeGreaterThan(-1);
    expect(panelAt).toBeLessThan(trafficAt);
  });

  test("面板具备三态（内容 / 正常 / 取不到），且不使用本地轮询常量", () => {
    const panel = readWeb("components/dashboard/attention-panel.tsx");
    for (const state of ['data-attention-state="items"', 'data-attention-state="clear"', 'data-attention-state="degraded"']) {
      expect(panel).toContain(state);
    }
    // 轮询复用 WP7 的安装等待常量（第二套节奏 = 两处都要改）。
    expect(panel).toContain("INSTALL_POLL_INTERVAL_MS");
    expect(panel).toContain("INSTALL_POLL_MAX_MS");
    expect(panel).not.toMatch(/setInterval\([^,]+,\s*\d{4,}/);
    // 重试失败也按码给下一步（409 condition 必须被消费）。
    expect(panel).toContain("forwardErrorActions");
  });

  test("前端不重新判定：面板/列表页不出现心跳窗口或 revision 比较", () => {
    /**
     * 注释要剥掉再做结构断言。
     *
     * 这些文件的注释**故意**提到 `last_seen_at` / 90s 窗口（说明「本模块不判它」），
     * 不剥离就会把「解释为什么不判定」的文字当成「又一次判定」—— 守卫自己给自己
     * 报假警，然后被人顺手删掉。
     */
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const comparison =
      /applied_revision[^\n]*[<>][^\n]*config_revision|config_revision[^\n]*[<>][^\n]*applied_revision/;
    for (const file of [
      "components/dashboard/attention-panel.tsx",
      "lib/attention.ts",
      "lib/node-status.ts",
      "components/nodes/node-workspace.tsx",
    ]) {
      const src = stripComments(readWeb(file));
      expect(`${file}:${/last_seen_at|CONNECTION_ONLINE_WINDOW|90_000|90000/.test(src)}`).toBe(`${file}:false`);
      expect(`${file}:${comparison.test(src)}`).toBe(`${file}:false`);
    }
  });

  test("节点页消费后端三层字段（lifecycle / connection / accepts_new_business）", () => {
    const nodeTypes = readWeb("lib/types/node-forward.ts");
    const baseTypes = readWeb("lib/types/base.ts");
    for (const field of ["connection?", "accepts_new_business?", "admission_rejection?"]) {
      expect(nodeTypes).toContain(field);
    }
    expect(baseTypes).toContain("lifecycle?");
    const nodes = readWeb("components/nodes/node-workspace.tsx");
    expect(nodes).toContain("userNodeStatus(");
    // 老的 `node.online ? 在线 : 离线` 单层写法必须消失（否则「维护中」会被说成「离线」）。
    expect(nodes).not.toMatch(/node\.online\s*\?/);
  });

  test("词条中英键集一致，且不把 raw key 画到界面上", () => {
    expect(Object.keys(ATTENTION_DICTS.zh).sort()).toEqual(Object.keys(ATTENTION_DICTS.en).sort());
    for (const dict of [ATTENTION_DICTS.zh, ATTENTION_DICTS.en]) {
      for (const [key, value] of Object.entries(dict)) {
        if (key === "totalItems") continue;
        expect(`${key}:${typeof value === "string" && value.trim() !== ""}`).toBe(`${key}:true`);
      }
    }
    const panel = readWeb("components/dashboard/attention-panel.tsx");
    // 面板只从两张表取词；没有裸文案字面量冒充 i18n。
    expect(panel).toContain("attentionText(");
    expect(panel).toContain("attentionGroupLabel(");
    expect(panel).toContain("attentionSeverityLabel(");
  });
});
