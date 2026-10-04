/**
 * V5.3 WP9 —— 租约规则的**纯**断言（不连库）。
 *
 * 连库那部分（认领/续约/换人的实际写入）由 Gate 端到端覆盖；这里钉住的是最容易在重构里
 * 被悄悄改掉的判定：**什么时候"不能"把归属交出去**。它是防双主的最后一道判断，而它的
 * 错误方向是"多给一次归属"——一次就够同时服务两份流量。
 */
import { describe, expect, test } from "bun:test";

import { isLeaseExpired, LEASE_RENEW_MARGIN_SECONDS, LEASE_TTL_SECONDS, type PlacementLeaseRow } from "../placement-lease.ts";

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

  test("the TTL is long enough that one report cycle cannot expire a serving owner", () => {
    // 与 Agent 上报/观测周期同频是刻意的：一次正常上报就能覆盖续约，
    // 连续三次失败才真的到期。TTL 短于上报周期会让面板抖一下就把 owner 自己停掉。
    expect(LEASE_TTL_SECONDS).toBeGreaterThanOrEqual(30);
    expect(LEASE_RENEW_MARGIN_SECONDS).toBeLessThan(LEASE_TTL_SECONDS);
  });
});
