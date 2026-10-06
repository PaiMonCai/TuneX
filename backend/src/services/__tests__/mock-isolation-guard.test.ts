/**
 * 进程级模块替身的**隔离守卫**（task-28）。
 *
 * ── 它防的是什么 ──
 *
 * `mock.module` 是**进程级**注册表、**先加载者生效**（仓里 `services/node-health-service.ts:76-77`
 * 已文档化这个陷阱）。于是一个"只给几个字段"的替身会**泄漏给同进程的其它测试文件**，
 * 而失败出现在**别人**那里、且往往不带 `(fail)` 前缀（加载期 SyntaxError）：
 *
 *   · `workspace.ts` 替身缺 `createPersonalWorkspace` ⇒ `route-mount-coverage.test.ts`
 *     报 `Export named 'createPersonalWorkspace' not found`（现场 1）；
 *   · `env.ts` 替身缺 `mail` ⇒ `services/mail.ts` 读 `env.mail.host` 抛 TypeError，
 *     把 `mail-smtp-session.test.ts` 的 4 条真实会话测试全打红（现场 2）。
 *
 * 两者都**只在特定跑法下出现**（`bun test <两个文件>` 红、全量绿、单独跑绿），所以这里
 * 把"替身必须语义完整"变成可执行的合同，而不是留给下一个人在别的文件里踩。
 *
 * ── 为什么是**扫源码**而不是运行期断言 ──
 *
 * 运行期拿不到"注册过的全部替身"（注册表不可枚举，且本文件能看到的是**自己**那一份）。
 * 能自动覆盖"未来新增的替身文件"的只有源码扫描 —— 与仓里既有的静态守卫
 * （`node-view.test.ts:169`、`f-diag-boundaries.test.ts`）同一取向。
 *
 * ── 判定规则（刻意保守）──
 *
 * 对每个"目标是 `env.ts` 的 `mock.module` 调用"：
 *   · 返回的对象里有 **spread**（`...realEnv` 这类"真实 env + 覆盖个别字段"形态）
 *     ⇒ 视为**完整**（构造上就没有缺段，env.ts 新增段也不会漏）；
 *   · 否则把它出现过的键收集起来，要求 ⊇ 真实 `env` 的**全部顶层键**（缺哪个就报哪个）。
 *
 * 已知的乐观边界（写清，不假装更强）：spread 的来源不解析（`{ ...某个残缺对象 }` 会通过）；
 * 键提取是文本近似（`^\s*name:`）。它挡的是**实际发生过的两种形态**：手写的部分替身、
 * 以及真实模块新增段后手写替身没跟上。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../..", import.meta.url).pathname; // …/backend/src/
const ENV_SOURCE = readFileSync(new URL("../../env.ts", import.meta.url), "utf8");

/** 真实 `env` 的顶层键（`export const env = { … }` 里两空格缩进的键）。 */
function realEnvKeys(source: string): string[] {
  const body = source.slice(source.indexOf("export const env = {"));
  return [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]!);
}

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

interface EnvMockSite {
  file: string;
  /** 该替身出现过的键（文本近似）。 */
  keys: string[];
  /** 是否用了 spread（"真实模块 + 覆盖"形态）。 */
  spread: boolean;
}

/**
 * 找出所有"替换 `env.ts`"的 `mock.module` 调用。
 *
 * 说明符可能是字面量（`${ROOT}/env.ts`）或**别名**（`csrf.test.ts` 的 `MODULE_ENV`），
 * 所以别名先在本文件里解析一次：凡是赋值语句右边出现过 `env.ts` 的标识符都算别名。
 */
function envMockSites(file: string): EnvMockSite[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const alias = new Set<string>();
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*env\.ts/g)) {
    alias.add(m[1]!);
  }

  const sites: EnvMockSite[] = [];
  const calls = [...source.matchAll(/mock\.module\(/g)];
  calls.forEach((call, index) => {
    const start = call.index!;
    const end = index + 1 < calls.length ? calls[index + 1]!.index! : source.length;
    const window = source.slice(start, Math.min(end, start + 2_000));
    const specifier = window.slice(window.indexOf("(") + 1).split(",")[0] ?? "";
    const targetsEnv = specifier.includes("env.ts") || [...alias].some((name) => new RegExp(`^\\s*${name}\\s*$`).test(specifier.trim()));
    if (!targetsEnv) return;
    const keys = [...window.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]!);
    // spread 必须出现在**返回对象字面量的开头**（`() => ({ ...realEnv, … })`）。
    // 不能只搜窗口里有没有 `...`：窗口会覆盖到后面的代码，那里随便一个 `...` 就会把
    // "部分替身"洗成"完整"（我自己在反向变异时踩到过这个假阴性）。
    const spread = /\{\s*\.\.\./.test(window);
    sites.push({ file, keys, spread });
  });
  return sites;
}

/**
 * **已知未修**的部分替身（豁免名单）—— 它们不在本次任务的写入范围里。
 *
 * 这两个条目**必须被清掉**：豁免只是"我在自己的 scope 内改不了它"。清掉的方式与现场 2
 * 相同 —— 改成"真实 env + 覆盖个别字段"（`{ ...realEnv, env: { ...realEnv.env, … } }`）：
 *   · `services/__tests__/mail-tokens.test.ts`（3 个键：siteUrl / emailVerifyTtlSeconds /
 *     resendVerificationIntervalSeconds）—— 归 mail 域；本次任务未授权改它。
 * 一旦某个文件补全，删掉对应那一行即可（本守卫不因此变红，也不会因为豁免而过期失效：
 * 新出现的部分替身仍然会红）。
 */
const ALLOWED_PARTIAL_ENV_MOCKS = new Set<string>(["src/services/__tests__/mail-tokens.test.ts"]);

describe("进程级替身隔离：env.ts 替身必须语义完整", () => {
  const expected = realEnvKeys(ENV_SOURCE);
  const files = testFiles(SRC);

  test("守卫自身的前提成立（能解析出真实 env 的键、能扫到替身）", () => {
    expect(expected).toContain("mail");
    expect(expected.length).toBeGreaterThan(15);
    expect(files.length).toBeGreaterThan(50);
    // 至少能扫到现场 2 里的 4 个替身 —— 否则这条守卫只是"扫了个空"。
    const withEnvMock = files.filter((f) => envMockSites(f).length > 0);
    expect(withEnvMock.length).toBeGreaterThanOrEqual(4);
  });

  test("每一个 env.ts 替身都覆盖真实 env 的全部顶层键（或使用 spread 形态）", () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const site of envMockSites(file)) {
        if (site.spread) continue; // "真实 env + 覆盖个别字段"：构造上完整。
        const present = new Set(site.keys);
        const missing = expected.filter((key) => !present.has(key));
        // `SRC` 自带尾斜杠，`join` 后不会有双斜杠；仍去掉可能的前导斜杠，保证键稳定。
        const relative = site.file.startsWith(SRC) ? site.file.slice(SRC.length).replace(/^\/+/, "") : site.file;
        if (ALLOWED_PARTIAL_ENV_MOCKS.has(`src/${relative}`)) continue; // 见上方豁免说明
        if (missing.length > 0) violations.push(`${relative} 缺: ${missing.join(", ")}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("回归反例：把现场 2 的原写法（只有 redisUrl/databaseUrl）当作输入，会被判缺段", () => {
    // 证明上面的规则**真的会红**，而不是一条恒真断言。
    const legacyKeys = ["env", "redisUrl", "databaseUrl"];
    const missing = expected.filter((key) => !legacyKeys.includes(key));
    expect(missing).toContain("mail");
    expect(missing.length).toBeGreaterThan(15);
  });
});
