/**
 * V4-WP8 §13.7 Wave 4 —— Dashboard 路由接线守卫（只读源码，不启 HTTP）。
 *
 * `routes/dashboard.ts` 依赖 `resolveWorkspaceAccess` → workspace/权限服务 →
 * db，导入即需要 Prisma；单测里起真请求要么拉起 DB，要么把整个鉴权链替身化，
 * 成本远高于它守的那点接线。这里改为静态钉住**接线事实**（端点存在、复用
 * 聚合层、装 { data } 信封、失败时降级而不是 500），由 CI 的 typecheck +
 * backend 单测一起兜住。
 *
 * 注意：本文件**不**替身 `services/forward-service.ts`，因此不落进
 * routes/__tests__/forward-service-stub-surface.test.ts 的清单守卫范围。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("../dashboard.ts", import.meta.url), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("V4-WP8 /api/dashboard/attention 接线", () => {
  test("端点注册为 GET /attention", () => {
    expect(code).toMatch(/dashboardRoutes\.get\(\s*["']\/attention["']/);
  });

  test("判定委托给 services/attention.ts（不在路由里复制在线/准入逻辑）", () => {
    expect(code).toContain('from "../services/attention.ts"');
    expect(code).toContain("collectAttention(");
    // 路由层不得自带窗口/心跳判据。
    expect(code).not.toMatch(/90_?000|CONNECTION_ONLINE_WINDOW_MS|deriveConnection|nodeAdmission/);
  });

  test("按 workspace 授权后取数（不跨空间泄漏）", () => {
    expect(code).toMatch(/resolveWorkspaceAccess\(c,\s*["']read["']\)/);
  });

  test("返回标准 { data } 信封", () => {
    expect(code).toMatch(/c\.json\(\{\s*data:\s*payload\s*\}\)/);
  });

  test("聚合失败降级：不抛 500，且带 degraded 标记（空清单 ≠ 没有待办）", () => {
    expect(code).toContain("degraded: true");
    // 降级分支必须给出完整 summary 形状，避免前端读到 undefined 计数。
    expect(code).toMatch(/nodes_waiting_install:\s*0/);
    expect(code).toMatch(/forwards_error:\s*0/);
  });

  test("/stats 的节点在线数复用用户侧投影（不再数 legacy status===\"active\"）", () => {
    expect(code).toContain("projectUserNode(");
  });
});
