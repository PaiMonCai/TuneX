/**
 * V5.2 读路径：desired 与 observation 的合并**只有一处实现**。
 *
 * 这层的测试不碰数据库（`db` 的读取路径由 Gate 端到端覆盖），而是钉住三件容易在
 * 重构里丢掉的性质：
 *   1. 期望清单**原样**进入合成——顺序、条数、重复项都不变，unhealthy 的也在；
 *   2. 没有任何观测时结论必须是 `unknown`，且观测者列表为空——"没人看过"与
 *      "看过且都健康"必须是两个不同的结论；
 *   3. 同一份结果里所有目标共用调用方给的 `now`（时间是一次参数，不是模块自己取的）。
 */
import { describe, expect, test } from "bun:test";
import { readTargetHealth, type TargetObservationRow } from "../target-health-read.ts";

/** 离线 store：本文件的断言与数据库无关（DB 的读得到由 Gate 端到端覆盖）。 */
function storeWith(rows: TargetObservationRow[]) {
  return { findMany: async () => rows };
}
const NOW = new Date(1_800_000_000_000);
const row = (over: Partial<TargetObservationRow> = {}): TargetObservationRow => ({
  node_id: 3,
  target_key: "10.0.0.5:8080",
  reachable: true,
  latency_ms: 12,
  consecutive_success: 5,
  consecutive_failure: 0,
  success_rate: 1,
  observed_at: new Date(NOW.getTime() - 5_000),
  observation_source: "3/tcp_connect",
  ...over,
});

describe("target health read path", () => {
  test("an empty desired list answers without inventing observations", async () => {
    const result = await readTargetHealth({ desired: [], now: NOW, store: storeWith([]) });
    expect(result.targets).toEqual([]);
    expect(result.observers).toEqual([]);
    expect(result.now.getTime()).toBe(NOW.getTime());
  });

  test("targets with no observations at all are `unknown`, never `healthy`", async () => {
    // 这条是 fail-closed 的核心：没有证据时唯一诚实的结论是 unknown。
    const result = await readTargetHealth({
      desired: [{ host: "10.0.0.5", port: 8080 }],
      now: NOW,
      store: storeWith([]),
    });
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.target).toBe("10.0.0.5:8080");
    expect(result.targets[0]?.state).toBe("unknown");
    expect(result.observers).toEqual([]);
  });

  test("a fresh reachable observation reaches the synthesis as healthy", async () => {
    const result = await readTargetHealth({
      desired: [{ host: "10.0.0.5", port: 8080 }],
      now: NOW,
      store: storeWith([row()]),
    });
    expect(result.targets[0]?.state).toBe("healthy");
    expect(result.observers).toEqual([3]);
    expect(result.targets[0]?.observers).toHaveLength(1);
  });

  test("a STALE observation is treated as no evidence (panel restart safety)", async () => {
    // 面板重启后旧观测不得被当新鲜：age 在这里按调用方的 now 现算，
    // 超过 STALE_AFTER 就等同于"没有证据"。
    const stale = row({ observed_at: new Date(NOW.getTime() - 10 * 60 * 1000) });
    const result = await readTargetHealth({
      desired: [{ host: "10.0.0.5", port: 8080 }],
      now: NOW,
      store: storeWith([stale]),
    });
    expect(result.targets[0]?.state).toBe("unknown");
  });

  test("two observers are two facts, and the disagreement is visible", async () => {
    const result = await readTargetHealth({
      desired: [{ host: "10.0.0.5", port: 8080 }],
      now: NOW,
      store: storeWith([
        row({ node_id: 3, observation_source: "3/tcp_connect" }),
        row({
          node_id: 4,
          observation_source: "4/tcp_connect",
          reachable: false,
          latency_ms: null,
          consecutive_failure: 9,
          consecutive_success: 0,
          success_rate: 0,
        }),
      ]),
    });
    expect(result.observers).toEqual([3, 4]);
    expect(result.targets[0]?.observers).toHaveLength(2);
    // 取最坏：一个节点说通、另一个说断 —— 结论不能是 healthy。
    expect(result.targets[0]?.state).not.toBe("healthy");
  });

  test("the desired list is passed through unchanged, duplicates included", async () => {
    const result = await readTargetHealth({
      desired: [
        { host: "B.example.com.", port: 443 },
        { host: "a.example.com", port: 80 },
        { host: "B.example.com.", port: 443 },
      ],
      now: NOW,
      store: storeWith([]),
    });
    // 身份归一化会生效（大小写/尾点），但**条数与顺序**属于期望清单，合成没有删除权。
    expect(result.targets.map((t) => t.target)).toEqual([
      "b.example.com:443",
      "a.example.com:80",
      "b.example.com:443",
    ]);
  });

  test("an invalid desired target is skipped, not given an invented identity", async () => {
    const result = await readTargetHealth({
      desired: [
        { host: "", port: 80 },
        { host: "ok.example.com", port: 8080 },
        { host: "ok2.example.com", port: 0 },
      ],
      now: NOW,
      store: storeWith([]),
    });
    expect(result.targets.map((t) => t.target)).toEqual(["ok.example.com:8080"]);
  });
});
