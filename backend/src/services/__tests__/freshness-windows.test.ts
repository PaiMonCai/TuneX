/**
 * F2 审计的落点（task-22）：**「90s」只有一个物理来历，但它不是一个概念。**
 *
 * 审计结论（证据在文件末尾的清单与各常量的就地注释）：
 *   · 物理基准只有一个：`REPORT_PERIOD_MS = 30s`（Agent 上报节拍），
 *     "3 个周期" ⇒ 90s。
 *   · **同源族**（问的是同一个问题："这台节点还活着吗"）：
 *     `CONNECTION_ONLINE_WINDOW_MS` / `scheduler-support.HEARTBEAT_TIMEOUT_MS` /
 *     `reconciler.DEFAULT_NODE_STALE_AFTER_MS` —— 阈值必须同源，谓词可以更保守。
 *   · **不同概念**（对象不同、后果不同）：目标观测新鲜度、错误事件"最近"窗口、
 *     联邦 ingress 上报新鲜度、归属租约 TTL（同一物理节拍）；以及 rollout 执行
 *     租约（**数值纯属巧合**，与上报周期无关）。
 *
 * 这个文件把两件事都钉住：
 *   ① 同源族的**行为一致**（89.999s / 90s / 90.001s 三个边界上三个消费者答案相同）；
 *   ② 不同概念的**数值关系是显式的**（改一处必须显式决定另一处，而不是连带漂移），
 *      以及 Web 侧镜像值（跨运行时不能 import，只能靠这条守卫）。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { CONNECTION_ONLINE_WINDOW_MS, REPORT_PERIOD_MS, deriveConnection } from "../node-lifecycle.ts";
import { DEFAULT_NODE_STALE_AFTER_MS, isNodeUnreachable } from "../reconciler.ts";
import { TARGET_HEALTH_THRESHOLDS } from "../target-health-thresholds.ts";
import { HEALTH_THRESHOLDS } from "../node-health.ts";
import { LEASE_TTL_SECONDS } from "../placement-lease.ts";
import { FEDERATED_INGRESS_REPORT_FRESH_MS } from "../federation/forward-hop.ts";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const at = (ageMs: number) => new Date(NOW.getTime() - ageMs);

/**
 * 一份"刚上报过、状态 active"的节点事实；age 是 last_seen_at 的年龄。
 *
 * `node_id` 是 `isNodeUnreachable` 的入参要求（它只读 status/last_seen_at/reported_at）。
 */
function facts(ageMs: number) {
  return { node_id: 1, status: "active" as const, last_seen_at: at(ageMs), reported_at: at(ageMs) };
}

describe("物理基准：90s 只有一个来历", () => {
  test("基准是上报节拍 30s，窗口 = 3 × 节拍", () => {
    expect(REPORT_PERIOD_MS).toBe(30_000);
    expect(CONNECTION_ONLINE_WINDOW_MS).toBe(3 * REPORT_PERIOD_MS);
    expect(CONNECTION_ONLINE_WINDOW_MS).toBe(90_000);
  });
});

describe("同源族（这台节点还活着吗）：三个消费者的阈值必须相同", () => {
  test("协调器侧的默认窗口引用连接投影的常量", () => {
    expect(DEFAULT_NODE_STALE_AFTER_MS).toBe(CONNECTION_ONLINE_WINDOW_MS);
  });

  test("调度侧窗口也是**引用**而不是字面量（import 它会拖进 redis，所以用源码形状钉住）", () => {
    // 为什么不直接 import `scheduler-support.ts` 断言 HEARTBEAT_TIMEOUT_MS：
    // 它的 import 链会拉起 `redis.ts` 并在测试进程里真连 6379（`[redis] error:
    // connect ECONNREFUSED`），而全量测试的既有噪音是 0 —— 不为一条等式给所有
    // 门禁加噪音。改成钉住**声明形状**：必须是引用共享常量，不能是字面量。
    const source = readFileSync(new URL("../scheduler-support.ts", import.meta.url), "utf8");
    const decl = source.split("\n").find((line) => line.startsWith("export const HEARTBEAT_TIMEOUT_MS")) ?? "";
    expect(decl).toBe("export const HEARTBEAT_TIMEOUT_MS = CONNECTION_ONLINE_WINDOW_MS;");
    // 而且它的判定与 deriveConnection 是同一个问题：status=active + 最近上报在窗口内。
    expect(source).toContain("return now.getTime() - node.last_seen_at.getTime() <= timeoutMs;");
  });

  test("边界行为一致：89.999s / 90s 三个消费者都说「在」，90.001s 都说「不在」", () => {
    // 两个可离线加载的判定（UI 投影 / 自动下发闸门）对**同一份事实**在同一时刻必须
    // 给出同一个答案，否则就是 E2 说的"面板显示在线、协调器判定不可达"；调度侧的
    // 窗口与谓词由上面那条源码形状守卫钉住（它 importing 会拉起 redis）。
    for (const ageMs of [0, 89_999, CONNECTION_ONLINE_WINDOW_MS]) {
      const label = `${ageMs}ms`;
      expect(`connection@${label}=${deriveConnection({ ...facts(ageMs), has_credential: true, now: NOW })}`).toBe(
        `connection@${label}=online`,
      );
      expect(`unreachable@${label}=${isNodeUnreachable(facts(ageMs), NOW)}`).toBe(`unreachable@${label}=false`);
    }
    for (const ageMs of [CONNECTION_ONLINE_WINDOW_MS + 1, 120_000]) {
      const label = `${ageMs}ms`;
      expect(`connection@${label}=${deriveConnection({ ...facts(ageMs), has_credential: true, now: NOW })}`).toBe(
        `connection@${label}=offline`,
      );
      expect(`unreachable@${label}=${isNodeUnreachable(facts(ageMs), NOW)}`).toBe(`unreachable@${label}=true`);
    }
  });

  test("谓词可以更保守（这是有意的差异，不是口径分叉）", () => {
    // 窗口内、但 status 已被判 inactive ⇒ 连接投影 offline、协调器不可达（两者一致）。
    expect(deriveConnection({ status: "inactive", last_seen_at: at(1_000), has_credential: true, now: NOW })).toBe("offline");
    expect(isNodeUnreachable({ node_id: 1, status: "inactive", last_seen_at: at(1_000), reported_at: at(1_000) }, NOW)).toBe(true);
    // 从未上报 ⇒ 投影 offline、协调器不可达（"不知道"在两侧都按不可用处理）。
    expect(deriveConnection({ status: "active", last_seen_at: null, has_credential: true, now: NOW })).toBe("offline");
    expect(isNodeUnreachable({ node_id: 1, status: "active", last_seen_at: null, reported_at: null }, NOW)).toBe(true);
  });
});

describe("不同概念：数值相等是**显式的**，不是可以连带漂移的", () => {
  test("同一物理节拍、不同对象的那些窗口", () => {
    // 目标观测新鲜度（对象 = 一条探测结果）
    expect(TARGET_HEALTH_THRESHOLDS.STALE_AFTER_MS).toBe(CONNECTION_ONLINE_WINDOW_MS);
    // 错误事件「最近」窗口（对象 = 一条错误事件，展示口径）
    expect(HEALTH_THRESHOLDS.errorRecentMs).toBe(CONNECTION_ONLINE_WINDOW_MS);
    // 联邦 ingress 上报新鲜度（对象 = 联邦侧上报）
    expect(FEDERATED_INGRESS_REPORT_FRESH_MS).toBe(CONNECTION_ONLINE_WINDOW_MS);
    // 归属租约 TTL（单位秒；"多久算丢归属"≠"多久算离线"）
    expect(LEASE_TTL_SECONDS * 1_000).toBe(CONNECTION_ONLINE_WINDOW_MS);
  });

  test("rollout 执行租约的 90s 是巧合：它**不得**与上报窗口绑定", () => {
    // 这条不是"数值必须不同"，而是"来历必须不同"：它是执行阶段的预算
    // （15s × 若干次远程操作 + 接管余量），与 30s 上报节拍无关。
    // 一旦有人把它改成 CONNECTION_ONLINE_WINDOW_MS，两个概念就被焊死了。
    const source = readFileSync(new URL("../forward-rollout-runtime-confirm.ts", import.meta.url), "utf8");
    const decl = source.split("\n").find((line) => line.startsWith("export const ROLLOUT_EXECUTOR_LEASE_MS")) ?? "";
    expect(decl).toContain("90_000");
    expect(decl).not.toContain("CONNECTION_ONLINE_WINDOW_MS");
    expect(decl).not.toContain("REPORT_PERIOD_MS");
  });
});

describe("Web 镜像（跨运行时不能 import，只能钉住数值）", () => {
  const web = (rel: string) => readFileSync(new URL(`../../../../web/src/${rel}`, import.meta.url), "utf8");

  /** 抽出 `IDENT = 90_000` / `ident: 90_000` 里的数值。 */
  function literalAfter(source: string, identifier: string): number | null {
    const match = source.match(new RegExp(`${identifier}\\s*(?::|=)\\s*([\\d_]+)`));
    return match ? Number(match[1]!.replace(/_/g, "")) : null;
  }

  test("web 的在线窗口镜像 = 后端连接窗口", () => {
    expect(literalAfter(web("lib/target-health.ts"), "TARGET_HEALTH_STALE_AFTER_MS")).toBe(TARGET_HEALTH_THRESHOLDS.STALE_AFTER_MS);
    expect(literalAfter(web("mocks/node-lifecycle.ts"), "ONLINE_WINDOW_MS")).toBe(CONNECTION_ONLINE_WINDOW_MS);
    expect(literalAfter(web("mocks/node-health.ts"), "ONLINE_WINDOW_MS")).toBe(CONNECTION_ONLINE_WINDOW_MS);
  });

  test("web 的错误最近窗口镜像 = 后端 HEALTH_THRESHOLDS.errorRecentMs", () => {
    expect(literalAfter(web("mocks/node-health.ts"), "errorRecentMs")).toBe(HEALTH_THRESHOLDS.errorRecentMs);
  });
});
