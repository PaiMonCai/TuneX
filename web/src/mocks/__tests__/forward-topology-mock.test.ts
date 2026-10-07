/**
 * R3-B1 —— mock 的 `GET /forwards/:id/topology` 必须与真实后端**同路、同形、同语义**。
 *
 * 这个文件守的是「mock 存在的意义」那一类事实（同 `node-runtime-state-mock.test.ts`）：
 *
 *   1. **形状**：DIRECT 的响应必须逐字等于真实样本
 *      （`{forward_id, mode, segments: [], observed_at: null, stale_segments: 0}`）——
 *      mock 若在这里塞一段假链路，"DIRECT 没有节点间跳"这个设计结论在开发期就再也看不到；
 *   2. **来源**：RELAY 两端的 `running` / `revision` 必须来自 mock 的**节点状态上报**
 *      （`db.nodeStates`），而不是"看起来在跑"的默认值 —— 没有上报就是 `false`/`null`；
 *   3. **语义**：`observed_at` 只在**有上报**时才有值；`stale_segments` 只统计
 *      「节点有过上报、但最近一次上报里没有这一端」—— 「从没说过话」由 `observed_at`
 *      表达，不该被算成 stale（否则两个不同的未知会被混成一个数字）。
 *
 * 跑法（web 目录）：bun test src/mocks/__tests__/forward-topology-mock.test.ts
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { handleMock } from "@/mocks/handler";
import { resetStore } from "@/mocks/state";
import type { ForwardTopology } from "@/lib/api/forwards";

const COOKIE = "tunex_session=u1"; // mock 演示用户（super_admin）
const topologyOf = async (id: number) => {
  const res = (await handleMock("GET", `forwards/${id}/topology`, { cookie: COOKIE })) as {
    status: number;
    body: ForwardTopology;
  };
  return res;
};

/** 种子事实（`mocks/data.ts`）：forward 1/4 是 DIRECT；2/3 是 RELAY。 */
const DIRECT_FORWARD = 1;
/** RELAY 且两端节点都从未上报（node 1 / node 4 都不在 mockNodeStateReports 里）。 */
const RELAY_SILENT_FORWARD = 2;
/** RELAY 且出口节点（node 6）有上报：`tunex-3-egress` revision 3。 */
const RELAY_REPORTED_FORWARD = 3;

beforeEach(() => {
  resetStore();
});

describe("mock：DIRECT 与真实响应逐字同形", () => {
  test("segments 是空数组、observed_at 是 null —— 这是设计结论，不是缺数据", async () => {
    const res = await topologyOf(DIRECT_FORWARD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      forward_id: DIRECT_FORWARD,
      mode: "direct",
      segments: [],
      observed_at: null,
      stale_segments: 0,
    });
    // 反向：mock 不得给出真实后端不会给的键（键集也是契约的一部分）。
    expect(Object.keys(res.body).sort()).toEqual([
      "forward_id",
      "mode",
      "observed_at",
      "segments",
      "stale_segments",
    ]);
  });
});

describe("mock：RELAY 的事实来自节点上报，不来自默认值", () => {
  test("有上报的一端落在响应里：running/revision 与上报一致，另一端如实为 false/null", async () => {
    const res = await topologyOf(RELAY_REPORTED_FORWARD);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("relay");
    expect(res.body.segments.length).toBe(1);
    const segment = res.body.segments[0]!;
    expect(segment.segment).toBe("ingress_to_egress");
    // runtime id 用后端同一个命名约定（`forward-probe-plan.ts:runtimeIdFor`）。
    expect(segment.from.runtime_id).toBe(`tunex-${RELAY_REPORTED_FORWARD}-relay`);
    expect(segment.to.runtime_id).toBe(`tunex-${RELAY_REPORTED_FORWARD}-egress`);
    // 出口节点 6 上报过 `tunex-3-egress` revision 3；入口节点从未上报。
    expect(segment.to.running).toBe(true);
    expect(segment.to.revision).toBe(3);
    expect(segment.from.running).toBe(false);
    expect(segment.from.revision).toBeNull();
    // 下一跳是出口节点的内部地址 + 该转发的出口端口。
    expect(segment.hop).not.toBeNull();
    expect(segment.hop?.port).toBeGreaterThan(0);
    expect(segment.expected_revision).toBe(segment.to.revision ?? null);
  });

  test("两端都没上报过 ⇒ observed_at 为 null，且 stale_segments 不把「没说过话」算成 stale", async () => {
    const res = await topologyOf(RELAY_SILENT_FORWARD);
    const segment = res.body.segments[0]!;
    expect(segment.from.running).toBe(false);
    expect(segment.to.running).toBe(false);
    expect(segment.from.revision).toBeNull();
    expect(segment.to.revision).toBeNull();
    expect(res.body.observed_at).toBeNull();
    expect(res.body.stale_segments).toBe(0);
  });

  test("有节点上报过 ⇒ observed_at 是该节点最新上报的时刻", async () => {
    const res = await topologyOf(RELAY_REPORTED_FORWARD);
    expect(typeof res.body.observed_at).toBe("string");
    expect(res.body.observed_at).not.toBe("");
  });

  test("DIRECT 转发即便节点有上报，也不产生节点间段", async () => {
    const res = await topologyOf(4); // 第二条 DIRECT
    expect(res.body.mode).toBe("direct");
    expect(res.body.segments).toEqual([]);
    expect(res.body.observed_at).toBeNull();
  });
});

describe("mock：不存在的转发仍然是 404，不假装成空拓扑", () => {
  test("取一条不存在的转发 → 404（空 segments 不是「找不到」的替身）", async () => {
    const res = (await handleMock("GET", "forwards/999999/topology", { cookie: COOKIE })) as {
      status: number;
    };
    expect(res.status).toBe(404);
  });
});
