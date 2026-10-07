/**
 * 进程级模块替身的**隔离守卫**（task-28 / task-30）。
 *
 * ── 它防的是什么 ──
 *
 * `mock.module` 是**进程级**注册表、**先加载者生效**（仓里 `services/node-health-service.ts:76-77`
 * 已文档化这个陷阱）。于是一个"只给几个字段/导出"的替身会**泄漏给同进程的其它测试文件**，
 * 而失败出现在**别人**那里、且往往不带 `(fail)` 前缀（加载期 SyntaxError）：
 *
 *   · `workspace.ts` 替身缺 `createPersonalWorkspace` ⇒ `route-mount-coverage.test.ts`
 *     报 `Export named 'createPersonalWorkspace' not found`（现场 1 + task-30 的三处）；
 *   · `env.ts` 替身缺 `mail` ⇒ `services/mail.ts` 读 `env.mail.host` 抛 TypeError，
 *     把 `mail-smtp-session.test.ts` 的 4 条真实会话测试全打红（现场 2）。
 *
 * 两者都**只在特定跑法下出现**（`bun test <两个文件>` 红、全量绿、单独跑绿），所以这里
 * 把"替身必须语义完整"变成可执行的合同，而不是留给下一个人在别的文件里踩。
 *
 * ── 为什么是**扫源码**而不是运行期断言 ──
 *
 * 运行期拿不到"注册过的全部替身"（注册表不可枚举），而且**本文件永远看不到自己的替身**
 * （见下面 `MOCK_REGISTRY_MECHANICS`）。能自动覆盖"未来新增的替身文件"的只有源码扫描 ——
 * 与仓里既有的静态守卫（`node-view.test.ts:169`、`f-diag-boundaries.test.ts`）同一取向。
 *
 * ── 判定规则（刻意保守）──
 *
 * 对每个"目标是受监控模块的 `mock.module` 调用"：
 *   · 它在**模板字符串里** ⇒ **跳过**：那种形态是"子进程 scenario"（`me-capabilities-route`
 *     就是这样，头部注释写明"跑在子进程里，避免与其它路由套件同进程互相污染"），替换只发生在
 *     子进程，**不会泄漏到本进程**；
 *   · 返回对象里有 **spread**（`...realEnv` / `...realWorkspace` 这类"真实模块 + 覆盖个别
 *     导出"）⇒ 视为**完整**（构造上就没有缺项，真实模块新增导出也不会漏）；
 *   · 否则把它出现过的键收集起来，要求 ⊇ 真实模块的**全部运行时导出**（缺哪个就报哪个）。
 *
 * 已知的乐观边界（写清，不假装更强）：spread 的来源不解析（`{ ...某个残缺对象 }` 会通过）；
 * 键提取是文本近似（`^\s*name:`）；"在模板字符串里"用反引号奇偶数近似（`${…}` 里再嵌模板
 * 会误判，但那种写法在测试里没有）。它挡的是**实际发生过的形态**：手写的部分替身、以及真实
 * 模块新增导出后手写替身没跟上。
 *
 * ── 机制（实测，task-28/30 的一次关键发现）──
 *
 * `mock.module` 只对**之后首次 import 该模块的文件**生效：
 *   · 注册替身的那个文件，如果**先** `await import` 过真实现，之后自己再 `await import`
 *     同一模块（无论用原 specifier 还是绝对路径 specifier）拿到的都是**真实现** —— 也就是说
 *     **本文件永远看不到自己的替身**；
 *   · 受害的**永远是另一个文件**（它才是该进程里第一次真正 import 该模块的人）。
 * 这解释了为什么这类缺陷只在特定跑法下红、且失败信息不带 `(fail)` 前缀。因此本守卫检查的是
 * "交给注册表的那个对象"，而不是"import 回来看到的东西"。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../..", import.meta.url).pathname; // …/backend/src/

/** 真实模块的运行时导出面。 */
function envKeys(): string[] {
  const source = readFileSync(new URL("../../env.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export const env = {"));
  return [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]!);
}

function valueExports(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/^export (?:async )?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!),
    ),
  ];
}

/** 受监控的模块：任何进程内替身都必须语义完整。 */
const TARGETS = [
  { label: "env.ts", expected: envKeys() },
  {
    label: "services/workspace.ts",
    expected: valueExports(readFileSync(new URL("../../services/workspace.ts", import.meta.url), "utf8")),
  },
] as const;

/**
 * **已知未修**的进程内部分替身（豁免名单）—— 它们不在 task-30 的写入范围里。
 *
 * 这两个条目**必须被清掉**（清法与其余各处相同：`{ ...realWorkspace, 覆盖项 }`）；
 * 它们只是"我在自己的 scope 内改不了"：
 *   · `services/__tests__/notifications/deliveries.test.ts` —— **notify-center 在写**
 *     （task-11 的 scope 包含 `services/__tests__/notifications`），不动它以免冲突；
 *   （`routes/__tests__/forward-list-route.test.ts` 已在 task-29 里顺手收掉，故不在此列。）
 * 新出现的部分替身**仍然会红**（豁免只按精确路径匹配，不会因为名单存在而放宽规则）。
 */
const ALLOWED_PARTIAL_WORKSPACE_MOCKS = new Set<string>([
  "services/__tests__/notifications/deliveries.test.ts",
]);

/** 递归收集 src/ 下的测试文件（跳过依赖与构建产物）。 */
function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".next", "dist", "coverage"].includes(entry.name)) continue;
      out.push(...testFiles(full));
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 去掉注释再扫。
 *
 * 不这么做会**误报**：`mail-smtp-session.test.ts` 的头部注释里就写着 `mock.module()` 与
 * `env.ts`（它在解释这个陷阱），文本匹配会把它当成一个"部分替身"。仓里既有守卫
 * （`node-view.test.ts:157-161`）用同一套做法，这里沿用（`//` 的规则保留 `https://`）。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

interface MockSite {
  file: string;
  target: string;
  /** 该替身出现过的键（文本近似）。 */
  keys: string[];
  /** 是否用了 spread（"真实模块 + 覆盖"形态）。 */
  spread: boolean;
  /** 是否位于模板字符串里（= 子进程 scenario，不会泄漏到本进程）。 */
  insideTemplate: boolean;
}

/** 找出所有"替换受监控模块"的 `mock.module` 调用。 */
function mockSites(file: string): MockSite[] {
  const source = stripComments(readFileSync(file, "utf8"));
  // 别名：`const MODULE_ENV = new URL("../../env.ts", …)` 这类间接说明符。
  const alias = new Map<string, string>();
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*?(env\.ts|workspace\.ts)/g)) {
    alias.set(m[1]!, m[2]!);
  }

  const sites: MockSite[] = [];
  const calls = [...source.matchAll(/mock\.module\(/g)];
  calls.forEach((call, index) => {
    const start = call.index!;
    const end = index + 1 < calls.length ? calls[index + 1]!.index! : source.length;
    const window = source.slice(start, Math.min(end, start + 2_000));
    const rawSpecifier = window.slice(window.indexOf("(") + 1).split(",")[0] ?? "";
    const specifier = rawSpecifier.trim();
    const resolved = alias.get(specifier) ?? specifier;
    // 按**文件名**匹配：说明符可能是 `${ROOT}services/workspace.ts`、`../../services/workspace.ts`
    // 或别名解析出来的裸文件名（`workspace.ts`），三者都是同一个模块。
    const fileName = (label: string) => label.split("/").pop()!;
    const target = TARGETS.find((t) => resolved.includes(fileName(t.label)));
    if (!target) return;

    // 工厂可能是**具名函数**（`function buildWorkspaceMock() { return { ...real, … } }` +
    // `mock.module(spec, buildWorkspaceMock)`）：那样对象字面量不在本调用窗口里，
    // 必须到它的定义处去取，否则会把一个完整的替身误判成"缺全部导出"。
    const namedFactory = window.match(/,\s*([A-Za-z_$][\w$]*)\s*\)/);
    let body = window;
    if (namedFactory) {
      const definition = source.search(new RegExp(`(?:function|const|let|var)\\s+${namedFactory[1]}\\b`));
      if (definition >= 0) body = source.slice(definition, definition + 2_000);
    }

    const keys = [...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]!);
    // spread 必须出现在**返回对象字面量的开头**（`() => ({ ...realEnv, … })`）。
    // 不能只搜窗口里有没有 `...`：窗口会覆盖到后面的代码，那里随便一个 `...` 就会把
    // "部分替身"洗成"完整"（我在反向变异时踩到过这个假阴性）。
    const spread = /\{\s*\.\.\./.test(body);
    // 反引号奇偶数 = 近似判断"这行在模板字符串里"。模板 scenario 只在子进程里跑替身。
    const insideTemplate = (source.slice(0, start).match(/`/g)?.length ?? 0) % 2 === 1;
    sites.push({ file, target: target.label, keys, spread, insideTemplate });
  });
  return sites;
}

const relativePath = (file: string) => (file.startsWith(SRC) ? file.slice(SRC.length).replace(/^\/+/, "") : file);

describe("进程级替身隔离：受监控模块的替身必须语义完整", () => {
  const files = testFiles(SRC);
  const allSites = files.flatMap((file) => mockSites(file));
  const inProcess = allSites.filter((site) => !site.insideTemplate);

  test("守卫自身的前提成立（能解析真实导出、能扫到替身、不是扫了个空）", () => {
    expect(TARGETS[0]!.expected).toContain("mail");
    expect(TARGETS[0]!.expected.length).toBeGreaterThan(15);
    expect(TARGETS[1]!.expected).toContain("createPersonalWorkspace");
    expect(TARGETS[1]!.expected.length).toBeGreaterThanOrEqual(8);
    expect(files.length).toBeGreaterThan(50);
    // 进程内替身至少覆盖到这几个现场文件 —— 否则守卫只是"扫了个空"。
    const paths = new Set(inProcess.map((site) => relativePath(site.file)));
    for (const expected of [
      "__tests__/redis-scope.test.ts",
      "__tests__/traffic-pipeline.test.ts",
      "__tests__/policy-concurrency.test.ts",
      "middlewares/__tests__/csrf.test.ts",
      "routes/__tests__/ddns-provider-route.test.ts",
      "routes/__tests__/forward-route-topology.test.ts",
      "routes/__tests__/forward-batch-route.test.ts",
    ]) {
      expect([...paths]).toContain(expected);
    }
  });

  test("子进程 scenario 里的替身被识别为隔离（me-capabilities-route 就是这一类）", () => {
    const templated = allSites.filter((site) => site.insideTemplate);
    expect(templated.map((site) => relativePath(site.file))).toContain("routes/__tests__/me-capabilities-route.test.ts");
  });

  test("每一个进程内替身都覆盖真实模块的全部运行时导出（或使用 spread 形态）", () => {
    const violations: string[] = [];
    for (const site of inProcess) {
      if (site.spread) continue; // "真实模块 + 覆盖个别导出"：构造上完整。
      const expected = TARGETS.find((t) => t.label === site.target)!.expected;
      const present = new Set(site.keys);
      const missing = expected.filter((key) => !present.has(key));
      if (missing.length === 0) continue;
      // 豁免只对 workspace.ts 那两处已知未修生效；env.ts 一处都不豁免。
      if (site.target === "services/workspace.ts" && ALLOWED_PARTIAL_WORKSPACE_MOCKS.has(relativePath(site.file))) continue;
      violations.push(`${relativePath(site.file)} [${site.target}] 缺: ${missing.join(", ")}`);
    }
    expect(violations).toEqual([]);
  });

  test("回归反例：两个现场的原写法都会被判缺项（守卫不是恒真断言）", () => {
    const legacyEnvKeys = ["env", "redisUrl", "databaseUrl"];
    const envMissing = TARGETS[0]!.expected.filter((key) => !legacyEnvKeys.includes(key));
    expect(envMissing).toContain("mail");
    expect(envMissing.length).toBeGreaterThan(15);

    const legacyWorkspaceKeys = ["resolveWorkspaceAccess"];
    const workspaceMissing = TARGETS[1]!.expected.filter((key) => !legacyWorkspaceKeys.includes(key));
    expect(workspaceMissing).toContain("createPersonalWorkspace");
    expect(workspaceMissing.length).toBeGreaterThanOrEqual(7);
  });
});
