/**
 * D5 —— 「管理员节点运行态」的**三态行为**测试（渲染 + 取数，不靠源码字符串冒充）。
 *
 * 这个文件钉住三件在生产里真实出过问题的事：
 *
 *   1. **路径**：`loadNodeState` 实际请求的 URL 必须命中
 *      `backend/src/routes/node-admin.ts` 里**真实声明**的路由（单数
 *      `/node/:id/state`），而旧的复数 `/admin/nodes/:id/state` 必须命中
 *      **任何**后端声明 —— 旧的 404 就是这么来的（mock 曾用复数实现盖住它）。
 *      断言方式是抓 `fetch` 的真实 URL（行为），再与后端声明对照；
 *      不是 grep 前端源码里的字符串。
 *   2. **「取不到」≠「没有上报」**：`200 + reported_at 为空` → 无上报；
 *      `404/5xx/形状不认识` → 取不到。四类响应各钉一条，且载荷为 `null`
 *      时**不得**被当成「没有上报」（那是最容易写错的一条）。
 *   3. **界面可分**：三态的 testid 与文案互不相同；降级态出现可重试入口，
 *      并且**不出现**任何正向结论措辞。
 *
 * 跑法（web 目录）：bun test src/components/admin/__tests__/node-runtime-state.test.tsx
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { I18nProvider } from "@/components/providers";
import { getDictionary } from "@/lib/i18n";
import { NodeRuntimePanel, NodeRuntimeUnavailable } from "@/components/admin/node-runtime-panel";
import { API_MOCK } from "@/lib/api";
import { loadNodeState } from "@/lib/node-runtime-loader";
import {
  nodeRuntimeStateFromPayload,
  nodeRuntimeText,
  type NodeRuntimeState,
  type NodeStatePayload,
} from "@/lib/node-runtime-state";
import type { NodeStateReport } from "@/lib/types";

const BACKEND = (relative: string) =>
  readFileSync(new URL(`../../../../../backend/${relative}`, import.meta.url), "utf8");

const render = (node: React.ReactNode, locale: "zh" | "en" = "zh") =>
  renderToStaticMarkup(<I18nProvider locale={locale} dict={getDictionary(locale)}>{node}</I18nProvider>);

const reportedReport = (over: Partial<NodeStateReport> = {}): NodeStateReport => ({
  node_id: 42,
  version: "1.8.4",
  role: "both",
  reported_revision: 7,
  tunnels: [{ id: "tunex-3-egress", mode: "relay", egress_port: 31011, revision: 3 }],
  egress_pools: { "2": { strategy: "round", targets: ["10.0.0.31:3389"] } },
  used_ports: [20010, 31011],
  last_error: null,
  reported_at: "2026-10-06T12:00:00.000Z",
  updated_at: "2026-10-06T12:00:00.000Z",
  ...over,
});

/**
 * 真实后端「从未上报」的空态视图（`NodeStateView`，见
 * `backend/src/services/node-admin-state.ts` 的 `getNodeState`）。
 * 字段集刻意与后端一致：客户端要靠这个形状判断「200 + 无记录」。
 */
function emptyPayload() {
  return {
    node_id: 42,
    node_key: "hk-in-01",
    role: "ingress" as string | null,
    reported_role: null as string | null,
    role_mismatch: false,
    online: true,
    status: "active",
    last_seen_at: null as string | null,
    reported_at: null as string | null,
    age_seconds: null as number | null,
    stale: true,
    version: null as string | null,
    reported_revision: null as number | null,
    tunnels: [] as never[],
    used_ports: [] as number[],
    egress_pools: {} as Record<string, never>,
    last_error: null as string | null,
    control_protocol_version: null as number | null,
    capabilities: null as string[] | null,
  };
}

const findTestId = (node: React.ReactNode, testid: string): React.ReactElement | null => {
  if (!React.isValidElement(node)) return null;
  const props = node.props as { "data-testid"?: string; children?: React.ReactNode };
  if (props["data-testid"] === testid) return node;
  for (const child of React.Children.toArray(props.children)) {
    const hit = findTestId(child, testid);
    if (hit) return hit;
  }
  return null;
};

/* ================================================================== */
/* A. 界面：三态互不相同                                                */
/* ================================================================== */

describe("A. 面板三态：有上报 / 没有上报 / 取不到", () => {
  const renderState = (state: NodeRuntimeState, locale: "zh" | "en" = "zh") =>
    render(<NodeRuntimePanel nodeId={42} state={state} onRetry={() => undefined} />, locale);

  test("reported：只出快照表，既不是「没有上报」也不是「取不到」", () => {
    const html = renderState({ status: "reported", report: reportedReport() });
    expect(html).toContain('data-testid="runtime-report"');
    expect(html).toContain("1.8.4");
    expect(html).not.toContain('data-testid="runtime-never-reported"');
    expect(html).not.toContain('data-testid="runtime-unavailable"');
    expect(html).not.toContain('data-testid="runtime-retry"');
  });

  test("never_reported：文案=admin.runtimeEmpty，testid=runtime-never-reported", () => {
    const html = renderState({ status: "never_reported" });
    expect(html).toContain('data-testid="runtime-never-reported"');
    expect(html).toContain(getDictionary("zh").admin.runtimeEmpty);
    expect(html).not.toContain('data-testid="runtime-unavailable"');
    expect(html).not.toContain(nodeRuntimeText("zh").unavailableTitle);
    expect(html).not.toContain('data-testid="runtime-retry"');
  });

  test("unavailable：文案与 testid 都与「没有上报」不同，且带可重试入口", () => {
    const html = renderState({
      status: "unavailable",
      reason: "request_failed",
      message: "Request failed with status 404",
    });
    expect(html).toContain('data-testid="runtime-unavailable"');
    expect(html).toContain('data-testid="runtime-retry"');
    // 两者不可混：testid 不同，且对方的判据文案一个都不出现
    expect(html).not.toContain('data-testid="runtime-never-reported"');
    expect(html).not.toContain(getDictionary("zh").admin.runtimeEmpty);
    expect(html).not.toContain("尚未上报");
    // 后端的原始 message 原样展示（便于定位；不替换成「没有上报」）
    expect(html).toContain('data-testid="runtime-unavailable-detail"');
    expect(html).toContain("Request failed with status 404");
  });

  test("unavailable：不出现正向结论措辞（中/英都要）", () => {
    for (const locale of ["zh", "en"] as const) {
      const html = renderState({ status: "unavailable", reason: "request_failed", message: "HTTP 500" }, locale);
      const positive =
        locale === "zh" ? ["正常", "健康", "在线", "良好"] : ["healthy", "online", "normal", "all good"];
      for (const word of positive) {
        expect(html.includes(word), `${locale} 的降级态不得出现「${word}」`).toBe(false);
      }
    }
  });

  test("两种「取不到」原因各自有文案，且都不冒充「没有上报」", () => {
    const zhText = nodeRuntimeText("zh");
    const shape = render(
      <NodeRuntimePanel
        nodeId={42}
        state={{ status: "unavailable", reason: "unrecognized_payload", message: "state payload is not an object" }}
      />,
    );
    expect(shape).toContain(zhText.unrecognizedTitle);
    expect(shape).not.toContain(zhText.unavailableTitle);
    expect(shape).not.toContain(getDictionary("zh").admin.runtimeEmpty);
  });
});

describe("A2. 重试入口真的接在 onRetry 上（纯展示组件，直接取元素树）", () => {
  test("给了 onRetry → 按钮存在且点击调用它；没给 → 不出现死按钮", () => {
    let calls = 0;
    const el = NodeRuntimeUnavailable({
      text: nodeRuntimeText("zh"),
      reason: "request_failed",
      message: "boom",
      onRetry: () => {
        calls += 1;
      },
    });
    const button = findTestId(el, "runtime-retry");
    expect(button).not.toBeNull();
    const onClick = (button!.props as { onClick?: () => void }).onClick;
    expect(typeof onClick).toBe("function");
    onClick!();
    expect(calls).toBe(1);

    const without = NodeRuntimeUnavailable({
      text: nodeRuntimeText("zh"),
      reason: "request_failed",
      message: "boom",
    });
    expect(findTestId(without, "runtime-retry")).toBeNull();
  });
});

/* ================================================================== */
/* B. 取数：三态映射 + 路径与后端声明一致                                */
/* ================================================================== */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** 抓 `api` 客户端真正请求的 URL（行为），并按给定状态码/体回应。 */
async function captureRequest(
  status: number,
  body: unknown,
): Promise<{ result: NodeRuntimeState; urls: string[] }> {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const result = await loadNodeState(42, "tunex_session=u1");
  return { result, urls };
}

/** 后端声明的路由（method + 相对挂载点的路径模式）。 */
function declaredRoutes(source: string): { method: string; pattern: string }[] {
  return [...source.matchAll(/nodeAdminRoutes\.(get|post|patch|put|delete)\("([^"]+)"/g)].map((m) => ({
    method: m[1]!,
    pattern: m[2]!,
  }));
}

function patternMatches(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]+/g, "[^/]+");
  return new RegExp(`^${escaped}$`).test(path);
}

/** `app.ts` 里 node-admin 的挂载点。 */
const MOUNT = "/api/admin";

describe("B. loader 三态映射（真实模式下与后端的真实路径）", () => {
  const routes = declaredRoutes(BACKEND("src/routes/node-admin.ts"));

  test("前置：本用例跑在真实（非 mock）分支，否则下面的路径断言没有意义", () => {
    expect(API_MOCK).toBe(false);
    expect(
      routes.some((r) => r.method === "get" && r.pattern === "/node/:id/state"),
      "后端必须声明 GET /node/:id/state",
    ).toBe(true);
  });

  test("请求的 URL 命中后端声明的 GET /node/:id/state；旧的复数路径不命中任何声明", async () => {
    const { urls } = await captureRequest(200, { data: reportedReport() });
    expect(urls.length).toBe(1);
    const clientPath = new URL(urls[0]!).pathname;
    expect(clientPath).toBe(`${MOUNT}/node/42/state`);
    const relative = clientPath.slice(MOUNT.length);
    const matched = routes.filter((r) => r.method === "get" && patternMatches(r.pattern, relative));
    expect(matched.map((r) => r.pattern)).toEqual(["/node/:id/state"]);
    // 旧实现写的复数路径：后端**一条都没有**，所以它必然 404（回归守卫）
    expect(routes.some((r) => patternMatches(r.pattern, "/nodes/42/state"))).toBe(false);
  });

  test("200 + reported_at 有值 → reported（带完整快照）", async () => {
    const { result } = await captureRequest(200, { data: reportedReport() });
    expect(result.status).toBe("reported");
    if (result.status === "reported") {
      expect(result.report.version).toBe("1.8.4");
      expect(result.report.reported_at).toBe("2026-10-06T12:00:00.000Z");
    }
  });

  test("200 + reported_at 为空 → never_reported（不是错误、不是取不到）", async () => {
    const { result } = await captureRequest(200, { data: emptyPayload() });
    expect(result.status).toBe("never_reported");
  });

  test("200 + 载荷为 null → unavailable(unrecognized_payload)，绝不等于「没有上报」", async () => {
    const { result } = await captureRequest(200, { data: null });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("unrecognized_payload");
    }
  });

  test("404 → unavailable(request_failed)，用后端的 message，不冒充「没有上报」", async () => {
    const { result } = await captureRequest(404, { message: "节点不存在", code: "NOT_FOUND" });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("request_failed");
      expect(result.message).toContain("节点不存在");
    }
  });

  test("5xx → unavailable(request_failed)（可重试，不抛穿页面）", async () => {
    const { result } = await captureRequest(500, { message: "Internal Server Error" });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("request_failed");
      expect(result.message).toContain("Internal Server Error");
    }
  });
});

describe("B2. nodeRuntimeStateFromPayload 的边界", () => {
  test("undefined / null / 非对象 / 数组 一律 unavailable（形状不认识），都不等于「没有上报」", () => {
    for (const payload of [undefined, null, [1, 2, 3], "boom"]) {
      const state = nodeRuntimeStateFromPayload(payload as never);
      expect(state.status).toBe("unavailable");
      if (state.status === "unavailable") expect(state.reason).toBe("unrecognized_payload");
    }
  });

  test("reported_at 的唯一判据：null / 缺键 / 空串 → never_reported", () => {
    const base = emptyPayload();
    expect(nodeRuntimeStateFromPayload(base).status).toBe("never_reported");
    // 「键缺失」与「空串」在真实响应里都可能出现（老后端/投影裁剪），必须同样落无上报
    const noKey: Record<string, unknown> = { ...base };
    delete noKey.reported_at;
    expect(nodeRuntimeStateFromPayload(noKey as never).status).toBe("never_reported");
    expect(nodeRuntimeStateFromPayload({ ...base, reported_at: "" }).status).toBe("never_reported");
  });

  test("reported_at 有值 → reported，且 updated_at 缺失时用 reported_at 兜底", () => {
    const state = nodeRuntimeStateFromPayload({
      ...emptyPayload(),
      reported_at: "2026-10-06T00:00:00.000Z",
    });
    expect(state.status).toBe("reported");
    if (state.status === "reported") {
      expect(state.report.updated_at).toBe("2026-10-06T00:00:00.000Z");
    }
  });
});
