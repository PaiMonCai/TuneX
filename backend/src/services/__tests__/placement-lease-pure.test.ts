/**
 * V5.3 WP9 —— 租约规则的**纯**断言（不连库）。
 *
 * 连库那部分（认领/续约/换人的实际写入）由 Gate 端到端覆盖；这里钉住的是最容易在重构里
 * 被悄悄改掉的判定：**什么时候"不能"把归属交出去**。它是防双主的最后一道判断，而它的
 * 错误方向是"多给一次归属"——一次就够同时服务两份流量。
 */
import { describe, expect, test } from "bun:test";

import { isLeaseExpired, LEASE_TTL_SECONDS, type PlacementLeaseRow } from "../placement-lease.ts";

const NOW = new Date("2026-10-04T12:00:00Z");
const lease = (over: Partial<PlacementLeaseRow> = {}): PlacementLeaseRow => ({
  tunnel_id: 1,
  owner_node_id: 4,
  epoch: 3,
  lease_expires_at: new Date(NOW.getTime() + 20_000),
  revision: 7,
  ...over,
});

describe("V5.3 WP9: lease expiry is the two-phase handover gate", () => {
  test("a live lease is NOT expired — handing over now would create two owners", () => {
    expect(isLeaseExpired(lease(), NOW)).toBe(false);
  });

  test("an exactly-at-now lease counts as expired (fail-safe at the boundary)", () => {
    // 边界取"已过期"：多等一个瞬间的代价是可用性，少判一个瞬间的代价是双主。
    expect(isLeaseExpired(lease({ lease_expires_at: new Date(NOW.getTime()) }), NOW)).toBe(true);
  });

  test("a stale lease is expired, and a missing lease counts as expired", () => {
    expect(isLeaseExpired(lease({ lease_expires_at: new Date(NOW.getTime() - 1) }), NOW)).toBe(true);
    expect(isLeaseExpired(null, NOW)).toBe(true);
  });

  test("the TTL is a MULTIPLE of the report cadence, not equal to it", () => {
    // 这条断言来自一个真实的集成缺陷：第一版把 TTL 设成与上报周期相同（30s），于是截止
    // 时刻恰好落在下一次上报**发出**的瞬间，而续约要等往返之后才回到 Agent —— 每个周期
    // 都有一个窗口，那一刻租约**确实**已过期，Agent 会忠实地停掉隧道。
    //
    // 所以这里断言的**不是**"≥ 上报周期"，而是"≥ 上报周期的 3 倍"：一次上报丢失不该
    // 让 owner 自停，连续三次丢失才该。Agent 的上报/观测周期是 30s（§7 冻结）。
    const AGENT_REPORT_INTERVAL_SECONDS = 30;
    expect(LEASE_TTL_SECONDS).toBeGreaterThanOrEqual(3 * AGENT_REPORT_INTERVAL_SECONDS);
  });
});

/**
 * V5.3 WP9 —— 续约必须有**回程**。
 *
 * 契约要求 Agent"租约到期即停"，而续约是面板侧写的。如果续约只落在库里、不回给 Agent，
 * 那么每个隧道在最后一次下发后一个 TTL 就会自停 —— 在**健康节点**上制造全量中断。
 * 这是本阶段实现者发现的真实集成缺口，不是理论风险。
 *
 * 这里钉住回程的**形状**（连库写入由 Gate 覆盖）：响应里必须带 `leases`，且每条都含
 * 三个 Agent 真正需要的字段。
 */
describe("V5.3 WP9: startup restore renews the current owner first", () => {
  test("the desired endpoint renews ownership before building the restart snapshot", async () => {
    const src = await Bun.file(new URL("../../routes/internal-node.ts", import.meta.url)).text();
    const route = src.indexOf('internalNodeRoutes.get("/node/desired"');
    const renew = src.indexOf("renewOwnedLeases(auth.node_id", route);
    const snapshot = src.indexOf("buildDesiredNodeSnapshot(auth.node_id)", route);

    expect(route).toBeGreaterThanOrEqual(0);
    expect(renew).toBeGreaterThan(route);
    expect(snapshot).toBeGreaterThan(renew);
  });

  test("startup renewal reuses the liveness renewal primitive instead of claiming ownership", async () => {
    const src = await Bun.file(new URL("../../routes/internal-node.ts", import.meta.url)).text();
    const routeStart = src.indexOf('internalNodeRoutes.get("/node/desired"');
    const routeEnd = src.indexOf("\n});", routeStart);
    const routeBody = src.slice(routeStart, routeEnd);

    expect(routeBody).toContain("renewOwnedLeases");
    expect(routeBody).not.toContain("claimLease");
    expect(routeBody).not.toContain("claimOwnership");
  });
});

describe("V5.3 WP9: the renewal must travel back to the agent", () => {
  test("the submit result type carries the renewed lease facts", async () => {
    const src = await Bun.file(new URL("../node-state.ts", import.meta.url)).text();
    // 响应形状是线上契约的一部分：字段名与"必须存在"这两件事都值得被断言。
    expect(src).toContain("leases: LeaseFact[]");
    expect(src).toContain("export interface LeaseFact");
    for (const field of ["tunnel_id", "epoch", "lease_expires_at", "revision"]) {
      expect(src).toContain(`${field}:`);
    }
  });

  test("the route returns them, so the agent can extend its deadline", async () => {
    const src = await Bun.file(new URL("../../routes/internal-node.ts", import.meta.url)).text();
    expect(src).toContain("leases: result.leases");
  });
});

/**
 * V5.3 WP9（round 6 修正）—— 续约的依据是**节点活着**，不是"它上报了那条隧道"。
 *
 * 第一版按上报的隧道续约，于是自锁：栅栏停掉隧道 → agent 不再上报它 → 续约永远续不到 →
 * 租约一直过期 → 隧道一直停（实测落后 83s 且不恢复）。
 *
 * 这里钉住的是**契约文本**（连库行为由 Gate 覆盖）：`renewOwnedLeases` 只接受 nodeId 与时间，
 * 不再有"tunnelIds"这个参数 —— 一旦有人把那个参数加回来，这个测试就该失败，因为那意味着
 * 自锁有可能被重新引入。
 */
describe("V5.3 WP9: renewal follows liveness, not the reported tunnnels", () => {
  test("the renewal signature takes only the node and the clock", async () => {
    const src = await Bun.file(new URL("../node-state.ts", import.meta.url)).text();
    expect(src).toContain("export async function renewOwnedLeases(nodeId: number, now: Date)");
    // 旧的"按上报隧道续约"参数不得回归。
    expect(src).not.toContain("tunnelIds: readonly number[]");
  });

  test("renewal is fail-soft: a lease-store problem must not break the report", async () => {
    const src = await Bun.file(new URL("../node-state.ts", import.meta.url)).text();
    // 上报是节点的主要职责；续约是面板侧记账。让次要功能把主要功能打成 500 是错的取舍。
    expect(src).toContain("renewOwnedLeasesUnsafe");
    expect(src).toContain("return [];");
  });

  test("heartbeat only renews and returns leases that are still live", async () => {
    const src = await Bun.file(new URL("../node-state.ts", import.meta.url)).text();
    const start = src.indexOf("async function renewOwnedLeasesUnsafe");
    const end = src.indexOf("/**：一次续约后回给 Agent", start);
    const body = src.slice(start, end);

    // update 与 response 查询都必须带 live fence。少任意一个，显式 release
    // （expires_at=now）都可能被下一次心跳复活或重新发回 Agent。
    expect(body.match(/lease_expires_at:\s*\{\s*gt:\s*now\s*\}/g)?.length).toBe(2);
  });

  test("expired ownership cannot be renewed in-place with the old epoch", async () => {
    const src = await Bun.file(new URL("../placement-lease.ts", import.meta.url)).text();
    expect(src).toContain("current.owner_node_id === input.nodeId && !isLeaseExpired(current, input.now)");
    expect(src).toContain("epoch: current.epoch + 1");
    expect(src).toContain("lease_expires_at: current.lease_expires_at");
  });
});
