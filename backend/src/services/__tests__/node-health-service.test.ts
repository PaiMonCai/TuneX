/**
 * task-26 —— Agent 版本基线（`TUNEX_AGENT_LATEST_VERSION`）的**语义**守卫。
 *
 * 背景（真实缺陷，不是风格问题）：`scripts/ops/install.sh --version <git-sha>` 曾把这个键写成
 * **40 位 git sha**，而面板拿它去比 Agent **上报的** version
 * （`node-health.ts:synthesiseHealth`：`isVersionOlder(reported, expected)`）。`isVersionOlder`
 * 的解析要求**首段是数字**，于是：
 *
 *   · `0.13.22` vs `<sha>` → `null`（无法判定）
 *   · `<sha>` vs `<sha>`   → `null`
 *   · `0.13.22` vs `0.14.0` → `true`（落后）
 *
 * ⇒ 只要配置值是 sha，`agent_version_behind` **永远不会出现**（只剩一条「无法判定」的 info 理由），
 * 用户域 `GET /api/nodes/:id/upgrade-state` 的 `version_drift` 也永远是 `unknown`。
 * 这就是本专项反复出现的"能力有、永不触发"形态。
 *
 * 本文件钉四件事：
 *   1. `classifyAgentBaseline` 把 unset / comparable / uncomparable 三种取值分开（纯函数）；
 *   2. 三条真实形态的比较结论（上面那三条，逐条断言）；
 *   3. 服务层**不折算**：配置不可比较时，理由里**没有** `agent_version_behind`，只有
 *      「无法判定」——绝不把 `unknown` 当成 behind，也不当成"已是最新"；
 *   4. 同一条配置问题只警告一次，且警告里给出修法（否则它是个"看起来配了、其实没用"的死值）。
 *
 * 跑法（backend 目录）：bun test src/services/__tests__/node-health-service.test.ts
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { classifyAgentBaseline, getNodeHealth } from "../node-health-service.ts";
import { isVersionOlder } from "../node-health.ts";

const root = new URL("../..", import.meta.url).pathname;

/** 真实形态：installer 写进去的 git sha（40 位小写 hex）。 */
const SHA = "0123456789abcdef0123456789abcdef01234567";

/* ================================================================== */
/* ① 纯函数：三种取值分开                                              */
/* ================================================================== */

describe("classifyAgentBaseline：未声明 / 可比较 / 不可比较", () => {
  test("未声明（缺键 / 空 / 只有空白）⇒ unset，不是「已是最新」", () => {
    expect(classifyAgentBaseline(undefined).kind).toBe("unset");
    expect(classifyAgentBaseline(null).kind).toBe("unset");
    expect(classifyAgentBaseline("").kind).toBe("unset");
    expect(classifyAgentBaseline("   ").kind).toBe("unset");
  });

  test("版本号形态 ⇒ comparable（去空白后仍是原值）", () => {
    expect(classifyAgentBaseline("0.14.0")).toEqual({ kind: "comparable", value: "0.14.0" });
    expect(classifyAgentBaseline(" 0.14.0 ")).toEqual({ kind: "comparable", value: "0.14.0" });
    expect(classifyAgentBaseline("v1.5.0").kind).toBe("comparable");
    expect(classifyAgentBaseline("0.14.0-rc1").kind).toBe("comparable");
  });

  test("镜像锚 / 非法形态 ⇒ uncomparable（会显示「无法判定」，且原值保留）", () => {
    for (const value of [SHA, "latest", "unknown", "replace-with-git-sha", "main"]) {
      expect(classifyAgentBaseline(value)).toEqual({ kind: "uncomparable", value });
    }
  });
});

/* ================================================================== */
/* ② 三条真实形态的比较结论（task-26 要求逐条断言）                       */
/* ================================================================== */

describe("isVersionOlder 对安装器真实取值的结论", () => {
  test("上报 0.13.22 vs 基线 <git sha> ⇒ null（无法判定，不是落后）", () => {
    expect(isVersionOlder("0.13.22", SHA)).toBeNull();
    expect(classifyAgentBaseline(SHA).kind).toBe("uncomparable");
  });

  test("<git sha> vs <git sha> ⇒ null（两个 sha 也不可比较）", () => {
    expect(isVersionOlder(SHA, SHA)).toBeNull();
  });

  test("上报 0.13.22 vs 基线 0.14.0 ⇒ true（落后，这才是能触发的那条路）", () => {
    expect(isVersionOlder("0.13.22", "0.14.0")).toBe(true);
    expect(classifyAgentBaseline("0.14.0").kind).toBe("comparable");
  });
});

/* ================================================================== */
/* ③ 服务层：不折算 + 警告一次（子进程注入 env，避免 mock.module 泄漏）    */
/* ================================================================== */

const PRELUDE = String.raw`
import { expect } from "bun:test";
const root = process.env.TUNEX_BASELINE_ROOT;
const SHA = process.env.TUNEX_BASELINE_SHA;

/* env.ts 在 import 期读一次 process.env ⇒ 必须在 import 服务层**之前**设置。 */
process.env.TUNEX_AGENT_LATEST_VERSION = process.env.TUNEX_BASELINE_VALUE ?? "";

const NODE_ROW = {
  id: 1, node_id: "Integration-IN-A-NODE", role: "ingress", status: "active",
  lifecycle: "active", version: "unknown", last_seen_at: new Date(),
  port_range_min: 21000, port_range_max: 21999, lb_strategy: "round", node_group_id: 1,
  node_credential_hash: "deadbeef", credential_revoked: false,
};
const REPORT_ROW = { node_id: 1, version: "0.13.22", role: "INGRESS", reported_at: new Date() };

const db = {
  node: { findUnique: async () => NODE_ROW, findMany: async () => [NODE_ROW] },
  nodeStateReport: { findUnique: async () => REPORT_ROW, findMany: async () => [REPORT_ROW] },
  tunnel: { findMany: async () => [] },
};

const { getNodeHealth } = await import(root + "services/node-health-service.ts");

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };

const first = await getNodeHealth(1, { db, now: () => new Date("2026-10-07T00:00:00Z") });
const second = await getNodeHealth(1, { db, now: () => new Date("2026-10-07T00:00:01Z") });
console.warn = realWarn;

if (!first.ok) throw new Error("getNodeHealth 失败：" + JSON.stringify(first));
const codesOf = (view) => view.reasons.map((r) => r.code);
console.log(JSON.stringify({
  baseline: process.env.TUNEX_BASELINE_VALUE ?? "",
  codes: codesOf(first.view),
  codesSecond: codesOf(second.view),
  warnings,
}));
`;

function runScenario(baseline: string): { baseline: string; codes: string[]; codesSecond: string[]; warnings: string[] } {
  const result = spawnSync(process.execPath, ["-e", PRELUDE + "\nprocess.exit(0);\n"], {
    cwd: root,
    env: {
      ...process.env,
      TUNEX_BASELINE_ROOT: root,
      TUNEX_BASELINE_SHA: SHA,
      TUNEX_BASELINE_VALUE: baseline,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`子进程退出码 ${result.status}\n${output}`);
  const line = (result.stdout ?? "").trim().split("\n").pop() ?? "{}";
  try {
    return JSON.parse(line) as { baseline: string; codes: string[]; codesSecond: string[]; warnings: string[] };
  } catch {
    throw new Error(`子进程输出无法解析：${output}`);
  }
}

describe("服务层：不可比较的基线只给「无法判定」，不折算成 behind / 最新", () => {
  test("基线 = git sha ⇒ 有 agent_version_unknown、没有 agent_version_behind，且只警告一次", () => {
    const run = runScenario(SHA);
    expect(run.codes).toContain("agent_version_unknown");
    expect(run.codes).not.toContain("agent_version_behind");
    // 两次调用共享同一个进程 ⇒ 警告只应出现一次（不刷日志，但也不静默）。
    expect(run.warnings.length).toBe(1);
    expect(run.warnings[0]).toContain("不是可比较的 Agent 版本号");
    expect(run.warnings[0]).toContain("--agent-version");
    // 第二次调用仍然是同一个结论（不会因为"警告过"就改判）。
    expect(run.codesSecond).not.toContain("agent_version_behind");
  });

  test("基线 = 0.14.0 且上报 0.13.22 ⇒ 落后判定正常出现（修复后的那条路）", () => {
    const run = runScenario("0.14.0");
    expect(run.codes).toContain("agent_version_behind");
    expect(run.warnings.length).toBe(0);
  });

  test("基线未声明 ⇒ 两个版本类理由都不出现（「没意见」，不是「已是最新」）", () => {
    const run = runScenario("");
    expect(run.codes).not.toContain("agent_version_behind");
    expect(run.codes).not.toContain("agent_version_unknown");
    expect(run.warnings.length).toBe(0);
  });

  test("显式 deps 覆盖优先于部署配置（调用方口径不被 env 抢走）", async () => {
    const view = await getNodeHealth(1, {
      expectedAgentVersion: "0.13.22",
      now: () => new Date("2026-10-07T00:00:00Z"),
      db: {
        node: {
          findUnique: async () =>
            ({
              id: 1, node_id: "n", role: "ingress", status: "active", lifecycle: "active",
              version: "unknown", last_seen_at: new Date(), port_range_min: null, port_range_max: null,
              lb_strategy: null, node_group_id: 1, node_credential_hash: "x", credential_revoked: false,
            }) as never,
          findMany: async () => [],
        },
        nodeStateReport: { findUnique: async () => ({ node_id: 1, version: "0.13.22", role: "INGRESS" }) as never, findMany: async () => [] },
        tunnel: { findMany: async () => [] },
      },
    });
    expect(view.ok).toBe(true);
    if (view.ok) {
      const codes = view.view.reasons.map((r) => r.code);
      expect(codes).not.toContain("agent_version_behind");
      expect(codes).not.toContain("agent_version_unknown");
    }
  });
});
