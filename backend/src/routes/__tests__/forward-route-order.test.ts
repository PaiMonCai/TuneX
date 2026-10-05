/**
 * 路由注册顺序守卫：**字面量子路径必须早于 `:参数` catch-all**。
 *
 * 为什么需要它：Hono 对同一方法**按注册顺序**匹配。`forwards.ts` 里有一个
 * `post("/:id/:action")` catch-all（把 `action` 当动词分派），而 `POST /:id/dns` 是后加的字面量
 * 子路径 —— 注册在 catch-all 之后就会被它先吃掉，返回 400「不支持的端口转发动作」。
 *
 * 症状非常坏：**DNS 前门根本绑不上**（写入口不存在），而 GET/DELETE 因为同路径没有 catch-all
 * 反而正常 —— 于是"读得到、删得掉、就是建不了"。WP17.2 的 38 条断言全绿却漏掉它，因为路由级
 * 用例是**单独 mount** router 的，绕过了注册顺序；真正抓到它的是 WP17.5 在真实 API 上的实测。
 *
 * 所以把它钉成**类**级守卫（不只为 dns 一条路径）：对每个方法，任何 `/:id/<字面量>`
 * 都必须出现在 `/:id/:<参数>` 之前。守卫自带**探针**：用同一份检测器跑人造样本，
 * 确保它真的能判出违反（守卫最怕的不是漏报，而是口径被改窄之后仍然全绿）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTES = join(dirname(fileURLToPath(import.meta.url)), "..", "forwards.ts");

interface Route {
  readonly method: string;
  readonly path: string;
  readonly line: number;
}

/** 从源码里取出注册顺序（行序即匹配序）。 */
export function parseRouteOrder(source: string): Route[] {
  const out: Route[] = [];
  source.split("\n").forEach((text, i) => {
    const m = text.match(/forwardsRoutes\.(get|post|patch|put|delete)\(\s*"([^"]+)"/);
    if (m) out.push({ method: m[1]!, path: m[2]!, line: i + 1 });
  });
  return out;
}

/** 路径按 `/` 分段。 */
function segments(path: string): string[] {
  return path.split("/").filter((s) => s !== "");
}

/**
 * 找出**违反**：某个字面量路径排在"同方法、同段数、同前缀、对应段是参数"的 catch-all 之后。
 * 返回可读的违反列表（空 = 顺序正确）。
 */
export function orderViolations(routes: readonly Route[]): string[] {
  const violations: string[] = [];
  for (let i = 0; i < routes.length; i += 1) {
    const literal = routes[i]!;
    const litSeg = segments(literal.path);
    // 判据是**末段**：`/:id/dns` 的末段 `dns` 是字面量 ⇒ 它是"具体子路径"，必须早于
    // `/:id/:action`。注意**不能**要求"整条路径不含参数段" —— 真实的字面量路由几乎都带
    // `:id`，那样判会把它们全跳过（本守卫第一版就是这么坏的，探针当场抓到）。
    const lastSeg = litSeg[litSeg.length - 1];
    if (litSeg.length === 0 || lastSeg === undefined || lastSeg.startsWith(":")) continue;
    for (let j = 0; j < i; j += 1) {
      const earlier = routes[j]!;
      if (earlier.method !== literal.method) continue;
      const earlySeg = segments(earlier.path);
      if (earlySeg.length !== litSeg.length) continue;
      // 逐段比较：早注册的那条必须每一段或相等、或是参数；并且**至少有一个参数段**。
      let shadowed = true;
      let hasParam = false;
      for (let k = 0; k < litSeg.length; k += 1) {
        const e = earlySeg[k]!;
        if (e.startsWith(":")) {
          hasParam = true;
          continue;
        }
        if (e !== litSeg[k]) {
          shadowed = false;
          break;
        }
      }
      if (shadowed && hasParam) {
        violations.push(
          `${literal.method.toUpperCase()} ${literal.path}（第 ${literal.line} 行）被更早注册的 ${earlier.path}（第 ${earlier.line} 行）拦住`,
        );
      }
    }
  }
  return violations;
}

describe("forwards.ts: 字面量子路径必须早于 :参数 catch-all", () => {
  const source = readFileSync(ROUTES, "utf8");
  const routes = parseRouteOrder(source);

  test("解析不是空转：确实读到了路由，并且含至少一个 catch-all", () => {
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.some((r) => r.path.includes(":action"))).toBe(true);
    // 这条正是被 catch-all 拦过的那条路径，它必须还在（否则守卫失去意义）。
    expect(routes.some((r) => r.method === "post" && r.path === "/:id/dns")).toBe(true);
  });

  test("没有任何字面量子路径被 catch-all 遮住", () => {
    expect(orderViolations(routes)).toEqual([]);
  });

  test("检测器本身有效（探针）：人造的「晚注册」样本必须被判为违反", () => {
    const bad = parseRouteOrder(
      [
        'forwardsRoutes.post("/:id/:action", async (c) => {',
        'forwardsRoutes.post("/:id/dns", async (c) => {',
      ].join("\n"),
    );
    expect(orderViolations(bad)).toHaveLength(1);
    // 反过来（字面量在前）必须是干净的 —— 否则守卫会对正确顺序误报。
    const good = parseRouteOrder(
      [
        'forwardsRoutes.post("/:id/dns", async (c) => {',
        'forwardsRoutes.post("/:id/:action", async (c) => {',
      ].join("\n"),
    );
    expect(orderViolations(good)).toEqual([]);
  });
});
