/**
 * V5.2 §7 —— mock 的**目标健康**端点必须与真实后端同形，演示数据自己也不能撒谎。
 *
 * 这个文件守两件事（都是「mock 存在的意义」那一类）：
 *
 *   1. **形状**：`GET /admin/node/pools/:poolId/health` 的响应必须与
 *      `backend/src/routes/node-admin.ts` + `services/target-health.ts` 的
 *      `TargetHealthView` 逐字段一致 —— 演示能跑而线上字段不存在，是最坏的一种
 *      「mock 骗人」。这里的断言是：行集 == 期望清单、每个观测者都有时间戳、
 *      `observed_at` 可解析、理由码与状态都在封闭集合里。
 *   2. **夹具自洽**：夹具是「写死的结论」而不是合成（真实状态由后端纯函数按阈值 +
 *      迟滞算出，mock 不复制那套规则，见 `data.ts` 的说明），所以必须断言每条夹具
 *      的结论与它自己的 facts 不矛盾 —— 一个 `healthy` 的夹具带着连续失败，会让
 *      评审者以为「后端就是这么算的」。
 *
 * 另外两条契约事实在 mock 上也必须成立：
 *   · 期望清单里的目标是**原样**进出的（加一个目标就多一行，不加就不少）；
 *   · 没有夹具（从未被观测）的目标是 `unknown` + `no_observation`，不是「健康」。
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import { mockTargetHealthFixtures } from "@/mocks/data";
import {
  TARGET_HEALTH_REASONS,
  TARGET_HEALTH_STATES,
  type TargetHealthTargetView,
  type TargetPoolHealth,
} from "@/lib/target-health";
import type { EgressPool, EgressTarget } from "@/lib/types";

const COOKIE = "tunex_session=u1"; // mock 演示用户（super_admin）
const call = <T>(method: string, path: string, body?: unknown) =>
  handleMock(method, path, { cookie: COOKIE, body }) as Promise<{ status: number; body: T }>;

beforeEach(() => {
  resetStore();
});

const health = async (poolId = 2) =>
  call<TargetPoolHealth>("GET", `admin/node/pools/${poolId}/health`);

/** 种子池 2（node 6）的期望目标键。 */
const SEEDED_KEYS = ["10.30.0.11:8080", "10.30.0.12:8080"];

describe("mock：健康端点的形状与真实 contract 一致", () => {
  test("200 + { targets, observers, observed_at }，行集 == 期望清单（顺序也一致）", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.targets)).toBe(true);
    expect(Array.isArray(res.body.observers)).toBe(true);
    expect(Number.isFinite(Date.parse(res.body.observed_at))).toBe(true);
    expect(res.body.targets.map((row) => row.target)).toEqual(SEEDED_KEYS);
    // `unhealthy` 的种子目标照旧在列表里：观测没有删除权（§7）
    const unhealthy = res.body.targets.find((row) => row.target === "10.30.0.12:8080");
    expect(unhealthy?.state).toBe("unhealthy");
  });

  test("每个目标的字段集与 TargetHealthView 相同，观测者带 `node:probe` 与时间戳", async () => {
    const { body } = await health();
    for (const row of body.targets) {
      expect(Object.keys(row).sort()).toEqual(
        ["facts", "flapping", "observers", "reasons", "recent_flips", "state", "target"].sort(),
      );
      expect(TARGET_HEALTH_STATES).toContain(row.state);
      for (const reason of row.reasons) expect(TARGET_HEALTH_REASONS).toContain(reason);
      expect(typeof row.flapping).toBe("boolean");
      expect(Array.isArray(row.recent_flips)).toBe(true);
      for (const observer of row.observers) {
        expect(TARGET_HEALTH_STATES).toContain(observer.state);
        expect(typeof observer.observer_label).toBe("string");
        // 时间戳由 handler 按本次请求时刻回填：永远是「刚刚算出来的一条观测」
        expect(typeof observer.last_observed_at).toBe("string");
        expect(Number.isFinite(Date.parse(observer.last_observed_at!))).toBe(true);
        expect(typeof observer.age_ms).toBe("number");
      }
      // facts 的字段集与后端 TargetHealthFacts 相同
      expect(Object.keys(row.facts).sort()).toEqual(
        [
          "age_ms",
          "consecutive_failure",
          "consecutive_success",
          "disagreement",
          "evidence",
          "fresh_observers",
          "last_observed_at",
          "latency_ms",
          "observers",
          "reachable",
          "stale_observers",
          "success_rate",
          "unusable_observers",
          "worst_observer",
        ].sort(),
      );
    }
  });

  test("观测方节点来自真的观测者（升序去重），没有观测时不假装有", async () => {
    const { body } = await health();
    expect(body.observers).toEqual([6, 9]);

    // 往池里加一个没有夹具的目标：它只能是 unknown + no_observation
    const created = await call<EgressTarget>("POST", "admin/node/pools/2/targets", {
      host: "10.30.0.99",
      port: 8080,
    });
    expect(created.status).toBe(200);
    const after = await call<TargetPoolHealth>("GET", "admin/node/pools/2/health");
    expect(after.body.targets.map((row) => row.target)).toEqual([
      "10.30.0.11:8080",
      "10.30.0.12:8080",
      "10.30.0.99:8080",
    ]);
    const fresh = after.body.targets.find((row) => row.target === "10.30.0.99:8080");
    expect(fresh?.state).toBe("unknown");
    expect(fresh?.reasons).toEqual(["no_observation"]);
    expect(fresh?.facts.evidence).toBe(false);
    expect(fresh?.observers).toEqual([]);
    // 观测方列表不会因为「有个目标没被观测」而变化
    expect(after.body.observers).toEqual([6, 9]);
  });

  test("删掉一个目标后它就不再出现在健康视图里（视图不保留幽灵行）", async () => {
    const removed = await call("DELETE", "admin/node/targets/2");
    expect(removed.status).toBe(200);
    const { body } = await health();
    expect(body.targets.map((row) => row.target)).toEqual(["10.30.0.11:8080"]);
  });

  test("非法 / 不存在的池：400 与 404 分开", async () => {
    expect((await call("GET", "admin/node/pools/abc/health")).status).toBe(400);
    expect((await call("GET", "admin/node/pools/999/health")).status).toBe(404);
  });

  test("池 1（另一台出口节点）也有夹具：不同池各自成行", async () => {
    const { body } = await health(1);
    expect(body.targets.map((row) => row.target)).toEqual(["172.16.5.10:443"]);
    expect(body.targets[0]?.state).toBe("degraded");
    expect(body.observers).toEqual([7]);
  });
});

describe("mock：夹具自洽（避免演示数据替后端撒谎）", () => {
  test("每条夹具的状态与 facts 不矛盾", () => {
    for (const row of mockTargetHealthFixtures) {
      const where = `${row.target} (${row.state})`;
      if (row.state === "healthy") {
        expect(row.facts.evidence, where).toBe(true);
        expect(row.facts.consecutive_failure, where).toBe(0);
        expect(row.facts.reachable, where).toBe(true);
      }
      if (row.state === "unhealthy") {
        expect(row.facts.consecutive_failure ?? 0, where).toBeGreaterThanOrEqual(3);
        expect(row.reasons.length, where).toBeGreaterThan(0);
      }
      if (row.state === "degraded") {
        expect(row.facts.evidence, where).toBe(true);
        expect(row.facts.consecutive_failure ?? 0, where).toBeGreaterThan(0);
      }
      if (row.state === "recovering") {
        expect(row.facts.consecutive_success ?? 0, where).toBeGreaterThan(0);
      }
      if (row.state === "unknown") {
        expect(row.facts.evidence, where).toBe(false);
      }
      // 抖动标记必须真的对应到翻转历史（不空口说抖动）
      if (row.flapping) expect(row.recent_flips.length, where).toBeGreaterThan(0);
      expect(TARGET_HEALTH_STATES).toContain(row.state);
      for (const reason of row.reasons) expect(TARGET_HEALTH_REASONS).toContain(reason);
    }
  });

  test("种子必须给出可对比的状态（healthy / degraded / unhealthy 各至少一条）", () => {
    // 这条断言**不**要求夹具覆盖全部五态：`unknown` 由「没有夹具的目标」天然产生
    // （契约事实，不是伪造），`recovering` 需要一段真实的恢复观测历史，夹具不编。
    // 它只防止有人把种子改到只剩一种状态，从而让演示看不到「好坏并列」这件事。
    const states = new Set(mockTargetHealthFixtures.map((row) => row.state));
    for (const state of ["healthy", "degraded", "unhealthy"] as const) {
      expect([...states], `${state} 应当有种子`).toContain(state);
    }
  });

  test("夹具与真实视图同类型（漏字段/写错名是编译错误，这里再钉一次形状）", () => {
    for (const row of mockTargetHealthFixtures) {
      const typed: TargetHealthTargetView = row;
      expect(typed.target).toContain(":");
      // 夹具只声明 age，不写时间戳（由 handler 按请求时刻回填）
      expect(typed.facts.last_observed_at).toBeNull();
      for (const observer of typed.observers) expect(observer.last_observed_at).toBeNull();
    }
  });

  test("池的形状仍是 EgressPool（健康视图不夹带任何写路径/新字段）", async () => {
    const pools = await call<{ data: EgressPool[] }>("GET", "admin/node/6/pools");
    expect(pools.status).toBe(200);
    expect(Array.isArray(pools.body.data[0]?.targets)).toBe(true);
    // 健康视图是只读投影：它不改动期望目标（weight/status 与拿到的一致）
    const { body } = await health();
    expect(body.targets.length).toBe(pools.body.data[0]?.targets?.length ?? -1);
  });
});
