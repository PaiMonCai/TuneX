/**
 * 路由模块**必须真的被挂载**（机械守卫）。
 *
 * 为什么需要它：本仓已经栽过同一族缺陷三次 ——
 *
 *   1. `POST /:id/dns` 被更早注册的 `/:id/:action` catch-all 吃掉（写入口不可达）；
 *   2. `preferred-ingress` 因 Prisma 关系名写错，任何调用都 500；
 *   3. Looking Glass 交付时**忘了在 `app.ts` 挂一行**（模块、路由、150 条断言全绿，
 *      而 `/api/looking-glass/*` 在应用里根本不存在）。
 *
 * 三次的共同点：**单元/路由级用例都是绿的**，因为它们要么单独 mount router、要么只测纯函数。
 * "这个 router 在应用里真的可达吗"只有挂载点能回答 —— 所以这里把挂载点本身钉住：
 * **凡导出名以 `Routes`/`Router` 结尾的 router，都必须在 `src/app.ts` 里被引用**。
 *
 * 例外必须**具名 + 写理由**（`EXEMPT`）：有意的"不挂"是合法设计，但必须留下痕迹，
 * 否则下一个人分不清"故意不挂"与"忘了挂"。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ROUTES_DIR = join(BACKEND, "src", "routes");

/** 有意不挂载的 router：每条都要写清为什么（今天没有例外）。 */
const EXEMPT: readonly { readonly module: string; readonly reason: string }[] = [];

interface RouterExport {
  readonly file: string;
  readonly name: string;
}

/** 收集所有路由模块里的 router 导出（`export const xxxRoutes|xxxRouter`）。 */
function routerExports(): RouterExport[] {
  const out: RouterExport[] = [];
  for (const file of readdirSync(ROUTES_DIR).sort()) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    for (const m of src.matchAll(/export const (\w+)\s*[:=]/g)) {
      const name = m[1]!;
      if (name.endsWith("Routes") || name.endsWith("Router")) out.push({ file, name });
    }
  }
  return out;
}

describe("app.ts: 每个路由模块都必须真的被挂载", () => {
  const app = readFileSync(join(BACKEND, "src", "app.ts"), "utf8");
  const exports = routerExports();

  test("守卫不是空转：确实扫到了路由模块（含一个已知的）", () => {
    expect(exports.length).toBeGreaterThanOrEqual(20);
    expect(exports.some((e) => e.name === "forwardsRoutes")).toBe(true);
  });

  /**
   * 名字必须出现在 **`app.route(...)` 的实参里**，而不是"文件里出现过" —— 后者只要有一行
   * `import { xRoutes }` 就满足了，而那正是漏挂的形态（本守卫第一版就这么弱：反向验证时
   * 我摘掉挂载行、只留 import，守卫照样全绿）。
   */
  const isMounted = (name: string): boolean => {
    const lines = app.split("\n");
    const at = lines.findIndex((l) => /app\.route\(/.test(l) && new RegExp(`\\b${name}\\b`).test(l));
    if (at >= 0) return true;
    // 允许调用换行写法：`app.route(` 与实参不在同一行时看紧邻的两行。
    return lines.some((l, i) => /app\.route\(/.test(l) && lines.slice(i, i + 3).some((w) => new RegExp(`\\b${name}\\b`).test(w)));
  };

  test("没有任何 router 只存在于模块里、在应用里不存在", () => {
    const exempt = new Set(EXEMPT.map((e) => e.module));
    const unmounted = exports
      .filter((e) => !exempt.has(e.file))
      .filter((e) => !isMounted(e.name))
      .map((e) => `${e.file}:${e.name}`);
    expect(
      unmounted,
      "这些 router 没有被 app.ts 引用：模块存在、单测可能全绿，而应用里根本没有这个接口",
    ).toEqual([]);
  });

  test("例外必须仍然是真的（过期的例外要自己消失）", () => {
    for (const e of EXEMPT) {
      expect(e.reason.length, `例外 ${e.module} 必须写清理由`).toBeGreaterThan(15);
      // 例外文件仍然存在，否则它就该被删掉。
      expect(readdirSync(ROUTES_DIR)).toContain(e.module);
    }
  });
});
