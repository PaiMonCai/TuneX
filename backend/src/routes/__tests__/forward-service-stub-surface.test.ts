/**
 * V4-WP9 — `services/forward-service.ts` 具名导入 ↔ 测试替身导出面的**静态一致性**守卫。
 *
 * ── 为什么需要这个文件 ──
 * `mock.module` 是进程级注册表：同一进程内所有解析 `forward-service.ts` 的模块都
 * 拿到**最后注册**的那个工厂结果（本仓库已有同类先例与结论，见
 * `src/__tests__/lifecycle-db-stub.ts` 顶部）。
 *
 * `forward-list-route.test.ts` 与 `forward-batch-route.test.ts` 都会替换它。若任一
 * 方的替身只列出「自己用到的键」，那么当文件加载顺序让**由它**生效时，另一方在
 * 模块顶层对 `routes/forwards.ts` 的具名导入就会炸：
 *
 *     SyntaxError: Export named 'runForwardBatch' not found in module
 *     '.../backend/src/services/forward-service.ts'
 *
 * CI 上实际发生过（本地顺序不同，跑绿）；表现为与用例内容完全无关的红，且时红时绿。
 *
 * ── 本文件钉住的不变量 ──
 * 对每一份替换 `forward-service.ts` 的测试替身：**路由文件具名导入的每个运行时
 * 符号，替身里都必须有**。
 *
 * 只读源码、不 import 真实模块 —— `forward-service.ts` 的传递依赖会 eager 连接
 * Redis（portPool → redis.ts），单元测试不应把它拉进来（这也是这些路由测试选择
 * 替换而非直连的原因）。因此两侧都用文本解析，副作用为零。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const SRC = new URL("../../", import.meta.url).pathname; // → backend/src/

/** 会 `mock.module` 替换 forward-service 的测试文件。 */
const MOCKING_FILES = [
  "routes/__tests__/forward-list-route.test.ts",
  "routes/__tests__/forward-batch-route.test.ts",
];

/** 从某模块的具名导入里取出「运行时符号」（滤掉 `type X`），返回 "文件 → 符号" 映射。 */
function runtimeImportsOf(consumerPath: string): { source: string; names: string[] } {
  const source = readFileSync(`${SRC}${consumerPath}`, "utf8");
  // 逐条 import 语句解析：`[^}]*` 允许换行，但不会跨过 `}` 吞掉后面的 import 块。
  const names: string[] = [];
  let matched = false;
  for (const statement of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    if (!statement[2].endsWith("services/forward-service.ts")) continue;
    matched = true;
    for (const raw of statement[1].split(",")) {
      const entry = raw.trim();
      // `type ForwardAction` 是纯类型，运行时不存在，不参与具名绑定检查。
      if (entry.length === 0 || entry.startsWith("type ")) continue;
      // `createForward as createForwardService` → 取左侧原名（模块导出名）。
      names.push(entry.split(/\s+as\s+/)[0].trim());
    }
  }
  if (!matched) throw new Error(`${consumerPath} 没有从 ../services/forward-service.ts 具名导入`);
  return { source: consumerPath, names };
}

/** 从替身工厂对象字面量里取出导出的键名（只扫工厂体，不扫整个文件）。 */
function stubKeysOf(filePath: string): Set<string> {
  const source = readFileSync(`${SRC}${filePath}`, "utf8");
  const start = source.indexOf("services/forward-service.ts`, () => ({");
  if (start === -1) throw new Error(`${filePath} 没有替换 services/forward-service.ts`);
  const body = source.slice(start);
  const end = body.indexOf("\n}));");
  const factory = end === -1 ? body : body.slice(0, end);
  // 工厂体可能是对象字面量，也可能是一段箭头函数体；两种都取「行首 2+ 空格 + 标识符 + :」
  // 这一形态（本仓库两份替身都是对象字面量）。
  const keys = new Set<string>();
  for (const line of factory.split("\n")) {
    const match = line.match(/^\s{2,}(?:\/\*\*|\/\/)?\s*([A-Za-z_$][\w$]*)\s*:/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

describe("V4-WP9 forward-service 替身导出面", () => {
  const consumers = [
    runtimeImportsOf("routes/forwards.ts"),
    runtimeImportsOf("routes/nodes.ts"),
  ];
  /** 路由文件需要的运行时符号全集。 */
  const required = new Set<string>();
  for (const consumer of consumers) for (const name of consumer.names) required.add(name);

  test("守卫自身有效：确实解析出了路由的具名导入（不是空集）", () => {
    expect(required.size).toBeGreaterThan(0);
    // forward-batch 是 WP9 新增的导入；它必须在集合里，否则守卫形同虚设。
    expect(required.has("runForwardBatch")).toBe(true);
    expect(required.has("listForwardsPage")).toBe(true);
  });

  test("两份替身文件都真的替换了 forward-service（清单没过时）", () => {
    const dir = readdirSync(`${SRC}routes/__tests__`, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => `routes/__tests__/${entry.name}`);
    const mocking = dir
      .filter((file) => file !== "routes/__tests__/forward-service-stub-surface.test.ts")
      .filter((file) =>
        readFileSync(`${SRC}${file}`, "utf8").includes("services/forward-service.ts`, () => ({"),
      );
    expect(mocking.sort()).toEqual([...MOCKING_FILES].sort());
  });

  for (const file of MOCKING_FILES) {
    test(`${file} 的替身覆盖路由具名导入全集`, () => {
      const keys = stubKeysOf(file);
      const missing = [...required].filter((name) => !keys.has(name));
      expect(missing, `替身缺少导出：${missing.join(", ")}`).toEqual([]);
    });
  }
});
