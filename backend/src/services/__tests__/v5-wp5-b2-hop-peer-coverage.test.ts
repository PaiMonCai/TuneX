/**
 * V5.1b WP5-B2 源码级守卫：**每一条下发 datagram 出口腿的路径都必须带 `hop_peer`**。
 *
 * 为什么需要机械守卫而不是靠人眼：这个事实有 **9 条投递路径**（scheduler 的 create /
 * 同一个文件的 reapply / rollout 的 3 处 / reconcile 回放 / 路由分发 / 联邦 host / 多跳中转），
 * 而"只接了一半"的症状是**在很远的地方炸**——第一版就漏了 `reapplyRelayTunnel`，直到
 * Gate V5-G1B 在真实拓扑上以 `egress_apply_rejected … hop_peer` 报出来才发现。
 * 那种失败模式正是本仓库反复付学费的一类（协议、证书路径、健康数组都踩过），
 * 所以这里把它钉成一条**读源码**的断言：新加一个下发点却忘了带 hop_peer，CI 立刻红。
 *
 * 例外必须有名字、有理由、写在下面——"静默放过"才是这条守卫要防的。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICES = join(HERE, "..");

/**
 * 允许**不带** hop_peer 的下发点，每条都要写清为什么。
 *
 * 这不是"白名单逃逸"：两个例外都是**故意不带**，而且都靠 orchestrator 的
 * `datagram_hop_peer_missing` 兜底 fail-closed（宁可拒绝，也不发一份出口会拒绝的配置）。
 */
const EXEMPT = [
  {
    file: "orchestrator.ts",
    reason:
      "dispatchTransit：中转跳是被它**前一跳**喂的，不是被入口喂的；datagram 中转不在 B2 范围（面板对 udp 多跳另有精确拒绝）",
  },
  {
    file: "federation/lease.ts",
    reason:
      "跨面板远端腿由 host 面板下发，出口要取证的是另一块面板上的入口——B2 明确不做（面板在声明时就以 datagram_federated_unsupported 拒绝）",
  },
];

/** 从一次 `dispatchEgress({` 起，向后看多少行算"这次调用的实参范围"。 */
const ARG_WINDOW = 18;

function callSites(file: string): { line: number; hasHopPeer: boolean }[] {
  const text = readFileSync(join(SERVICES, file), "utf8");
  const lines = text.split("\n");
  const out: { line: number; hasHopPeer: boolean }[] = [];
  lines.forEach((line, i) => {
    // 只看**调用**：定义处的签名是 `async dispatchEgress(input: ...)`，没有左括号接对象。
    if (!line.includes("dispatchEgress({")) return;
    const window = lines.slice(i, i + ARG_WINDOW).join("\n");
    out.push({ line: i + 1, hasHopPeer: /hopPeer\s*:/.test(window) });
  });
  return out;
}

describe("V5.1b WP5-B2: every egress dispatch path carries hop_peer (source-level guard)", () => {
  const files = ["orchestrator.ts", "scheduler.ts", "forward-rollout-exec.ts", "runtime-reconcile-sink.ts", "federation/lease.ts"];

  test("the guard itself is not vacuous: it really finds the call sites", () => {
    const total = files.reduce((n, f) => n + callSites(f).length, 0);
    // 今天是 9 处。写下界而不是等号：**新增**下发点正是我们要它继续管的事，
    // 所以守卫不该因为"多了一处"而红；但"一处都没扫到"必须红（否则替身/正则失效时它静默通过）。
    expect(total).toBeGreaterThanOrEqual(9);
  });

  for (const file of files) {
    const exempt = EXEMPT.find((e) => e.file === file);
    test(`${file}: hop_peer present${exempt ? "（本文件有一个已登记的例外）" : ""}`, () => {
      const missing = callSites(file).filter((s) => !s.hasHopPeer);
      if (exempt) {
        // 例外文件：允许**恰好**缺失的下发点存在，但数量写死——多一处就要有人来解释。
        expect(missing.length).toBeLessThanOrEqual(1);
        return;
      }
      expect(missing).toEqual([]);
    });
  }

  test("the exemptions are all still real (no stale reasons)", () => {
    for (const e of EXEMPT) {
      expect(e.reason.length).toBeGreaterThan(20);
      // 例外必须仍然**有**那个不带 hopPeer 的下发点；否则它就成了一段过期注释。
      const missing = callSites(e.file).filter((s) => !s.hasHopPeer);
      expect(missing.length).toBeGreaterThan(0);
    }
  });
});
