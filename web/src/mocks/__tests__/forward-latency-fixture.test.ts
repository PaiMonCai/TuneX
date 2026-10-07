/**
 * 延迟卡片夹具守卫 —— mock 里必须**能**打出 `ok` 态。
 *
 * 背景：延迟四态（`ok` / `no_samples` / `no_observer` / `ambiguous_target`）里，`ok`
 * 要求「池恰好收敛到 1 个 active 目标」。修这条夹具之前 mock 里每个池要么有 2 个 active
 * 目标、要么根本没有池归属，于是开发/联调期**永远打不出** `ok` —— 而真实集成拓扑上
 * `ok` 是存在的（见 `components/forwards/__tests__/forward-latency.test.tsx` 的真实样本）。
 *
 * 这里钉住三件事：
 *   1. `ok` 在 mock 里可达，且形状与后端同（四态判据都在服务端，mock 只是照做）；
 *   2. 与真实后端**同形**：出口池由 `Tunnel.egress_pool_id` 显式指向，target 行有 status 列；
 *   3. 补齐夹具**没有**顺带改掉这条转发的展示目标（host/port 与 legacy 地址一致）。
 *
 * 跑法（web 目录）：bun test src/mocks/__tests__/forward-latency-fixture.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { getStore, resetStore } from "@/mocks/state";
import { mockTunnels } from "@/mocks/data";

const session = (userId: number) => `tunex_session=u${userId}`;

const call = (path: string, query: Record<string, string> = {}) =>
  handleMock("GET", path, { query, cookie: session(1), workspaceId: 1 } as never);

const RELAY_FORWARD_ID = 2;

beforeEach(() => {
  resetStore();
});

describe("mock 延迟夹具：单目标 active 池 → ok 可达", () => {
  test("种子与真实后端同形：转发显式指向出口池，池只有一个 active 目标", () => {
    const db = getStore();
    const tunnel = db.tunnels.find((t) => t.id === RELAY_FORWARD_ID)!;
    expect(tunnel.tunnel_mode).toBe("relay");
    expect(tunnel.egress_pool_id).not.toBeNull();

    const poolId = tunnel.egress_pool_id!;
    const pool = (db.egressPools.get(tunnel.egress_node_id!) ?? []).find((p) => p.id === poolId);
    expect(pool).toBeDefined();
    // 池归属与转发的出口节点一致（否则「哪个池」这件事自相矛盾）
    expect(pool!.node_id).toBe(tunnel.egress_node_id);

    const active = (db.egressTargets.get(poolId) ?? []).filter((target) => target.status === "active");
    expect(active).toHaveLength(1);
  });

  test("GET /forwards/2/latency → 200 + status=ok + 维度由服务端推导", async () => {
    const res = await call(`forwards/${RELAY_FORWARD_ID}/latency`, { granularity: "sample", hours: "1" });
    expect(res.status).toBe(200);
    const body = res.body as {
      status: string;
      mode: string;
      dimension: { observer_node_id: number; target_key: string } | null;
      series: { at: string; latency_ms: number | null }[];
      truncated: boolean;
      window: { hours: number };
    };
    expect(body.status).toBe("ok");
    expect(body.mode).toBe("relay");
    expect(body.dimension).toEqual({ observer_node_id: 4, target_key: "10.0.0.21:22" });
    expect(body.series.length).toBeGreaterThan(10);
    expect(body.truncated).toBe(false);
    expect(body.window.hours).toBeCloseTo(1, 3);
    // `null`（那一次没测得）与真 `0` 必须都在夹具里 —— 否则「null 不补零」这类断言
    // 在开发环境里永远没有反例。
    expect(body.series.some((point) => point.latency_ms === null)).toBe(true);
    expect(body.series.some((point) => point.latency_ms === 0)).toBe(true);
  });

  test("补齐夹具没有改掉这条转发的展示目标（host/port 与 legacy 地址一致）", async () => {
    const res = await call(`forwards/${RELAY_FORWARD_ID}`);
    expect(res.status).toBe(200);
    const forward = (res.body as { data: Record<string, unknown> }).data ?? (res.body as Record<string, unknown>);
    expect(forward.target_host).toBe("10.0.0.21");
    expect(forward.target_port).toBe(22);
    const seed = mockTunnels.find((t) => t.id === RELAY_FORWARD_ID)!;
    expect(seed.forward_addresses[0]).toBe("10.0.0.21:22");
  });

  test("四态没有被这次补齐抹平：direct → no_observer；多目标池 → ambiguous_target", async () => {
    const direct = await call("forwards/1/latency", { granularity: "sample", hours: "1" });
    expect(direct.status).toBe(200);
    expect((direct.body as { status: string }).status).toBe("no_observer");

    const ambiguous = await call("forwards/3/latency", { granularity: "sample", hours: "1" });
    expect(ambiguous.status).toBe(200);
    expect((ambiguous.body as { status: string }).status).toBe("ambiguous_target");
    expect((ambiguous.body as { candidate_targets: number }).candidate_targets).toBe(2);
  });
});
