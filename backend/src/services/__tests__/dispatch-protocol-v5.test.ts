/**
 * V5-WP4/G0 —— 每一条下发路径都必须携带协议事实。
 *
 * 这条守卫是 Gate V5-G0 抓到的真实缺陷的机械化形式。`Orchestrator` 的
 * `dispatch*` 在**没有** `protocol` 时会退到 `DEFAULT_FORWARD_PROTOCOL`（tcp）
 * ——这个默认值本身是对的（V4 客户端省略协议就是 TCP），但它让"忘了传协议"变成
 * 一个**静默**错误：
 *
 *   · 下发出去的 config 说 tcp（错误的事实）；
 *   · 命令总线最后一关读的也是同一个 config.protocol，所以它**同意**这份事实；
 *   · 一条历史 `wss` / `udp` Forward 会在 reconcile / rollout 路径上被当成 TCP
 *     真实跑起来，而面板记一笔成功。
 *
 * WP0 只守住了 scheduler；reconcile sink 与 rollout executor 当时没有传协议。
 * 现在四处都传，而且都用同一份 `admitPersistedProtocol` 判定。这条守卫把"以后新增
 * 一条下发路径也不能漏"变成 CI 会红的事实。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../..", import.meta.url).pathname;

/** 会真正向 Agent 下发命令的方法名（Orchestrator 的下发面）。 */
const DISPATCH_METHODS = [
  "dispatchDirect",
  "dispatchIngress",
  "dispatchEgress",
] as const;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // 测试与替身不算下发路径：它们验证的是"有没有传"，不是"传得对不对"。
      if (entry === "__tests__") continue;
      out.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

/** 去掉注释，避免注释里提到的 `protocol:` 让守卫自己放行。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

interface CallSite {
  file: string;
  method: string;
  args: string;
}

function dispatchCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const method of DISPATCH_METHODS) {
      const pattern = new RegExp(`\\.${method}\\s*\\(`, "g");
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        // 调用实参：从 `(` 起取到配对的那一个 `)`。
        let depth = 0;
        let end = match.index + match[0].length - 1;
        for (let i = end; i < text.length; i += 1) {
          if (text[i] === "(") depth += 1;
          else if (text[i] === ")") {
            depth -= 1;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        sites.push({ file: file.replace(`${SRC}/`, ""), method, args: text.slice(match.index, end + 1) });
      }
    }
  }
  return sites;
}

describe("V5-G0 every dispatch path carries the protocol fact", () => {
  const sites = dispatchCallSites();

  test("the guard is not vacuous: it really finds the dispatch paths", () => {
    // scheduler (create/direct/relay) + reconcile sink + rollout cutover/replay.
    expect(sites.length).toBeGreaterThanOrEqual(6);
    const files = new Set(sites.map((s) => s.file));
    for (const expected of ["services/scheduler.ts", "services/runtime-reconcile-sink.ts", "services/forward-rollout-exec.ts"]) {
      expect([...files].some((f) => f.endsWith(expected))).toBe(true);
    }
  });

  test("every call site passes an explicit protocol", () => {
    // Accept both `protocol: x` and the shorthand `protocol,` — the point is that
    // the fact travels, not how it is spelled.
    const missing = sites.filter((s) => !/\bprotocol\s*[:,]/.test(s.args));
    expect(missing.map((s) => `${s.file}: ${s.method}`)).toEqual([]);
  });

  /**
   * Gate V5-G0 抓到的第二处：`buildDesiredNodeSnapshot`（Agent 启动恢复的期望快照）
   * 把每一条期望行都写成 `protocol: "tcp"`。它不是 `dispatch*` 调用，所以上面那条
   * 守卫看不见它——而它是**每次 Agent 重启都会走**的下发面。
   *
   * 规则：协议值永远来自契约常量或行本身，**不能是字面量**。写成字面量的那一刻，
   * 协议就变成了"代码里写死的那一个"，而不是"这条转发实际用的那一个"。
   */
  test("no source file writes a protocol value as a literal", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const match of text.matchAll(/protocol\s*:\s*"tcp"/g)) {
        offenders.push(`${file.replace(`${SRC}/`, "")}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the desired-state snapshot resolves the protocol per row", () => {
    // The specific builder that used to hardcode it must call the shared resolver.
    const src = readFileSync(join(SRC, "services/agent-command-bus.ts"), "utf8");
    expect(src.includes("admitPersistedProtocol")).toBe(true);
    expect(src.includes("desiredTunnelConfigFor")).toBe(true);
    // `skipped` is what keeps an omitted row observable instead of silent.
    expect(src.includes("skipped")).toBe(true);
  });

  test("the orchestrator's tcp default stays, as the V4 compatibility path", async () => {
    // The default must NOT be removed to "make this guard pass": an omitted
    // protocol from a V4 client legitimately means TCP. What must never happen is
    // a *panel* code path relying on it.
    const src = readFileSync(join(SRC, "services/orchestrator.ts"), "utf8");
    expect(src.includes("DEFAULT_FORWARD_PROTOCOL")).toBe(true);
    expect((src.match(/input\.protocol \?\? DEFAULT_FORWARD_PROTOCOL/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
