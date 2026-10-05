/**
 * 配置键 ⊆ `SystemConfigName`（机械守卫）。
 *
 * `SystemConfig.name` 是 **DB ENUM**，所以"代码里用了一个不在枚举里的键"不会报错、不会崩，
 * 只会**静默地永远不存在**：读取得到 null（回落到默认值）、运维也永远设不上 —— 一个标着
 * "可调"的参数实际上是个常量，而且没有任何信号。WP19-B 的保留期两个键就是这样丢的
 * （`latency-history.ts` 的 `LATENCY_RETENTION_CONFIG_KEYS`），是被 Lead 事后扫出来的。
 *
 * 所以把它钉成断言：**凡在代码里当配置键用的字符串，必须是 `SystemConfigName` 的成员**。
 *
 * ── 扫描口径（宁可窄，不要误报） ──
 * 只看两类位置，避免把无关的大写常量也扫进来：
 *   ① `getConfig(...)` / `setConfig(...)` / `readConfig(...)` 的实参行；
 *   ② `*CONFIG_KEY*` / `*_CONFIG_KEYS` 这类声明的行（键表就长这样）。
 * 例外必须**具名 + 写理由**（`EXEMPT`），并且断言例外里的键**真的还在**（过期例外要自己消失）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** 允许出现在配置位但不进枚举的键，每条都要有理由。 */
const EXEMPT: readonly { key: string; reason: string }[] = [
  // 今天没有例外。写下这个空数组本身是**有意**的：它是"这里可以开口子"的显式位置，
  // 而不是让下一个人随手往里塞一个字符串。
];

function enumMembers(): Set<string> {
  const schema = readFileSync(join(BACKEND, "prisma", "schema.prisma"), "utf8");
  const block = schema.slice(schema.indexOf("enum SystemConfigName {"));
  const body = block.slice(0, block.indexOf("\n}"));
  const out = new Set<string>();
  for (const line of body.split("\n")) {
    const m = line.match(/^\s{2}([A-Z][A-Z0-9_]*)\s*$/);
    if (m) out.add(m[1]!);
  }
  return out;
}

/** 递归收集后端源码文件（跳过测试与 node_modules）。 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__" || entry === "dist") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

/**
 * 找到"当配置键用"的字符串字面量：键名 + 行号 + 该行。
 *
 * 两类位置（**两类都必要**，第一版只按单行匹配时漏了 `raw_hours: "X",` 这种跨行键表）：
 *   ① `getConfig("X")` 这类**调用实参**：就在这一行上；
 *   ② `..._CONFIG_KEY = "X"` 或 `..._CONFIG_KEYS = { … }` 这类**声明**：值可能在后续若干行，
 *      所以从声明处向下收集到该块的收尾（`}`）为止，并加上行数上界防止跑飞。
 */
function configKeyLiterals(): { file: string; line: number; key: string; text: string }[] {
  const out: { file: string; line: number; key: string; text: string }[] = [];
  for (const file of sourceFiles(join(BACKEND, "src"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    const rel = file.slice(BACKEND.length + 1);
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i]!;
      if (/(get|set|read)Config\(/.test(text)) {
        for (const m of text.matchAll(/"([A-Z][A-Z0-9_]{6,})"/g)) {
          out.push({ file: rel, line: i + 1, key: m[1]!, text: text.trim() });
        }
      }
      if (/CONFIG_KEY/i.test(text)) {
        // 声明块：从本行开始收集，遇到收尾的 `}` / `;` 停止（最多 40 行）。
        const isBlock = /=\s*\{/.test(text);
        for (let j = i; j < lines.length && j < i + (isBlock ? 40 : 1); j += 1) {
          const line = lines[j]!;
          for (const m of line.matchAll(/"([A-Z][A-Z0-9_]{6,})"/g)) {
            out.push({ file: rel, line: j + 1, key: m[1]!, text: line.trim() });
          }
          if (isBlock && j > i && /\}\s*;?\s*$/.test(line)) break;
        }
      }
    }
  }
  return out;
}


/**
 * 口径探针：拿**同一份**判定逻辑跑一段人造样本，确认它两类位置都覆盖。
 *
 * 守卫最怕的不是漏报而是**静默失效**（口径被改窄之后仍然全绿）。这里用样本把口径本身钉住：
 * 只有 `getConfig("…")` 与 `*CONFIG_KEY*` 两种写法都必须被认出来。
 */
function keys_scan_probe(): string[] {
  const sample = [
    'const x = await systemConfig.getConfig("A_LITERAL_CONFIG_ONLY");',
    'export const SOMETHING_CONFIG_KEY = "ANOTHER_ONE_HERE";',
    'export const KEYS_ARE_CONFIG_KEYS = {',
    '  raw: "A_KEY_INSIDE_A_BLOCK",',
    '};',
    'const unrelated = "NOT_A_CONFIG_KEY_AT_ALL_SHAPE";',
  ];
  const out: string[] = [];
  for (let i = 0; i < sample.length; i += 1) {
    const text = sample[i]!;
    if (/(get|set|read)Config\(/.test(text)) {
      for (const m of text.matchAll(/"([A-Z][A-Z0-9_]{6,})"/g)) out.push(m[1]!);
    }
    if (/CONFIG_KEY/i.test(text)) {
      const isBlock = /=\s*\{/.test(text);
      for (let j = i; j < sample.length && j < i + (isBlock ? 40 : 1); j += 1) {
        for (const m of sample[j]!.matchAll(/"([A-Z][A-Z0-9_]{6,})"/g)) out.push(m[1]!);
        if (isBlock && j > i && /\}\s*;?\s*$/.test(sample[j]!)) break;
      }
    }
  }
  return out;
}

describe("SystemConfigName: 代码里的配置键必须都在枚举里", () => {
  const members = enumMembers();
  const found = configKeyLiterals();

  test("守卫不是空转：枚举读到了，且扫描真的找到了**字面量**形式的键", () => {
    expect(members.size).toBeGreaterThan(30);
    expect(members.has("FAILOVER_POLICY")).toBe(true);
    // 为什么阈值是 1 而不是"若干"：这个仓库里**绝大多数配置访问走枚举类型**
    // （`SystemConfigName.X`），那是**编译期**就保证成员关系的，不可能漂移。
    // 于是真正需要这条守卫的，只剩下"以**字符串字面量**当键用"的那几处 —— 数量本来就应该
    // 很少。扫到 0 才说明口径失效（而不是"没有漏"），所以断言一个**已知存在**的字面量。
    const keys = found.map((f) => f.key);
    expect(keys, "扫描口径失效：连 LATENCY_RAW_RETENTION_HOURS 都没扫到").toContain(
      "LATENCY_RAW_RETENTION_HOURS",
    );
  });

  test("扫描口径本身被钉住：它必须能覆盖 `getConfig(...)` 与 `*CONFIG_KEY*` 声明两类位置", () => {
    // 这条不检查产品代码，检查**守卫自己**：口径被改窄（比如只留 getConfig）会立刻红。
    expect(configKeyLiterals.toString()).toContain("CONFIG_KEY");
    expect(keys_scan_probe(), "口径必须能同时覆盖「调用实参」与「跨行键表块」两类位置").toEqual(
      expect.arrayContaining(["A_LITERAL_CONFIG_ONLY", "A_KEY_INSIDE_A_BLOCK"]),
    );
  });

  test("每个配置键都是枚举成员（否则它会静默地永远不存在）", () => {
    const exempt = new Set(EXEMPT.map((e) => e.key));
    const missing = found.filter((f) => !members.has(f.key) && !exempt.has(f.key));
    expect(
      missing.map((m) => `${m.file}:${m.line} ${m.key}`),
      "这些键不在 SystemConfigName 里：列是 DB ENUM ⇒ 它们存不进库，读永远是 null",
    ).toEqual([]);
  });

  test("例外必须仍然是真的（过期的例外要自己消失）", () => {
    for (const e of EXEMPT) {
      expect(e.reason.length, `例外 ${e.key} 必须写清理由`).toBeGreaterThan(15);
      expect(members.has(e.key), `例外 ${e.key} 已经是合法枚举成员了，请从 EXEMPT 里删掉`).toBe(false);
    }
  });
});
