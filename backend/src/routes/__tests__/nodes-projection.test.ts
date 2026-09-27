/**
 * V4-WP8 §13.4.1 —— 用户侧 `/api/nodes` 路由的**接线守卫**（静态，只读源码）。
 *
 * ── 为什么是静态断言而不是起 HTTP 请求 ──
 * `routes/nodes.ts` 的传递依赖（forward-service → scheduler → portPool → redis）
 * 会在导入期 eager 连接 Redis；单元测试不应把它拉进来（本仓库既有先例：
 * `forward-service-stub-surface.test.ts` 同样只用文本解析，副作用为零）。
 *
 * 判定逻辑本身由 `services/__tests__/node-view.test.ts` 逐条覆盖；本文件只钉
 * 「路由确实把判定外包出去了」这一件事：
 *   1. 路由从 `services/node-view.ts` 导入 `projectUserNode`；
 *   2. 路由**自己不再**出现在线窗口阈值或 status 判据（改造前它有两份）；
 *   3. `nodeSelect` 真的 select 了 WP5 的 `lifecycle` 列（否则投影永远读不到管理态）。
 *
 * 跑法（backend 目录）：bun test src/routes/__tests__/nodes-projection.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("../nodes.ts", import.meta.url), "utf8");
/** 去掉注释后扫代码：文档里提到阈值/判据是正常的，不该把守卫自己扫红。 */
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("用户侧 /api/nodes 复用后端判定（不许自带第二套）", () => {
  test("路由把三层状态投影外包给 services/node-view.ts", () => {
    expect(raw).toMatch(
      /import\s*\{[^}]*projectUserNode[^}]*\}\s*from\s*"\.\.\/services\/node-view\.ts"/,
    );
    expect(code).toContain("projectUserNode(");
  });

  test("路由源码里不再有在线窗口阈值（90_000 / 90000 / CONNECTION_ONLINE_WINDOW_MS）", () => {
    expect(code).not.toMatch(/90_?000|CONNECTION_ONLINE_WINDOW_MS/);
  });

  test("路由源码里不再有 status===\"active\" 形式的在线判据", () => {
    expect(code).not.toMatch(/status\s*===\s*["']active["']/);
  });

  test("nodeSelect 选中了 lifecycle（否则用户侧永远读不到管理态）", () => {
    const select = raw.slice(raw.indexOf("const nodeSelect"), raw.indexOf("} as const;"));
    expect(select).toMatch(/\blifecycle:\s*true/);
  });

  test("nodeSelect 不含凭据之外的敏感列（只保留 node_credential_hash 供布尔推导）", () => {
    const select = raw.slice(raw.indexOf("const nodeSelect"), raw.indexOf("} as const;"));
    // 凭据只用于 has_credential 布尔；投影函数会把它剥掉（见 node-view 测试）。
    expect(select).not.toMatch(/credential_secret|api_key|token/);
  });
});
