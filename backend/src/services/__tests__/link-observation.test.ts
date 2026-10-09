import { describe, expect, test } from "bun:test";
import { linkObservation } from "../link-observation.ts";
import type { ReportedTrafficStatus, ReportedTargetStatus } from "../node-state-report.ts";
const now = new Date("2030-01-01T00:00:00Z");
const expected = { runtime_id: "tunex-link-7-p12-egress", node_id: 12, role: "egress", generation: 8, config_digest: "51".repeat(32),
  target_counts: new Map([[101, 2]]) };
const fact = { id: expected.runtime_id, node_id: 12, workspace_id: 3, link_id: 7, role: "egress",
  generation: 8, observed_generation: 8, config_digest: expected.config_digest, desired_config_digest: expected.config_digest,
  state: "ready", ready: true, lease_expires_at: "2030-01-01T00:01:00Z", runtime_ids: [], ports: [] };
test("target health follows current running digest, generation, report and lease", () => {
  const target: ReportedTargetStatus = { forward_id: 101, states: ["unhealthy", "healthy"], selected_tcp: 1, selected_udp: 1,
    last_checked_at: now.toISOString(), reason: "target_failed" };
  const observe = (patch = {}, reported_at = now) => linkObservation(expected, 3, 7,
    { reported_at, link_placements: [{ ...fact, target_status: [target], ...patch }] }, now);
  expect(observe().target_status).toEqual([target]);
  expect(observe().ready).toBe(true); // Listener readiness is independent of target health.
  for (const patch of [{ ready: false, state: "failed" }, { config_digest: "52".repeat(32) },
    { observed_generation: 7 }, { desired_config_digest: "53".repeat(32) }, { lease_expires_at: now.toISOString() }]) {
    expect(observe(patch)).not.toHaveProperty("target_status");
  }
  expect(observe({}, new Date(now.getTime() - 60001))).not.toHaveProperty("target_status");
  expect(observe({ target_status: [{ ...target, last_checked_at: new Date(now.getTime() - 60001).toISOString() }] }).target_status).toEqual([]);
  expect(observe({ target_status: [{ ...target, forward_id: 102 }] }).target_status).toEqual([]);
  expect(observe({ target_status: [{ ...target, states: ["healthy"], selected_tcp: 0, selected_udp: 0 }] }).target_status).toEqual([]);
});
test("ACK history never becomes a live Link observation; exact fresh leased facts do", () => {
  expect(linkObservation(expected, 3, 7, null, now).ready).toBeNull();
  expect(linkObservation(expected, 3, 7, { reported_at: now, link_placements: undefined }, now).ready).toBeNull();
  const report = { reported_at: now, link_placements: [fact] };
  expect(linkObservation(expected, 3, 7, report, now)).toMatchObject({ state: "ready", ready: true });
  expect(linkObservation(expected, 3, 7, { ...report, reported_at: new Date(now.getTime() - 61_000) }, now).state).toBe("stale");
  expect(linkObservation(expected, 3, 7, { ...report, link_placements: [{ ...fact, generation: 9 }] }, now).ready).toBe(false);
  expect(linkObservation(expected, 3, 7, { ...report, link_placements: [{ ...fact, config_digest: "52".repeat(32) }] }, now).ready).toBe(false);
  expect(linkObservation(expected, 3, 7, { ...report, link_placements: [{ ...fact, workspace_id: 9 }] }, now).state).toBe("absent");
  expect(linkObservation(expected, 3, 7, { ...report, link_placements: [{ ...fact, lease_expires_at: now.toISOString() }] }, now).state).toBe("expired");
  expect(linkObservation(expected, 3, 7, { ...report, link_placements: [{ ...fact, state: "passive", ready: false }] }, now)).toMatchObject({ state: "passive", ready: false });
});

describe("capacity follows exact fresh observation identity and never replaces Ready", () => {
  const statistics: ReportedTrafficStatus = { rotation_supported: true, producer_count: 1, sample_count: 3, rule_count: 2,
    spool_bytes: 1234, last_ack_at: now.toISOString(), state: "blocked" };
  const capacityFact = { ...fact, traffic_status: statistics };
  function observe(patch: Record<string, unknown> = {}, reported_at = now) {
    return linkObservation(expected, 3, 7, { reported_at, link_placements: [{ ...capacityFact, ...patch }] }, now);
  }
  test("matching capacity is projected for ready and non-ready runtimes independently", () => {
    expect(observe()).toEqual({ state: "ready", ready: true, observed_generation: 8, traffic_status: statistics });
    for (const state of ["updating", "failed", "passive", "cached", "closed", "exited"]) {
      expect(observe({ ready: false, state })).toEqual({ state, ready: false, observed_generation: 8, traffic_status: statistics });
    }
    expect(observe({ traffic_status: { ...statistics, last_ack_at: null }, state: "failed", ready: false }).ready).toBe(false);
    const legacy = linkObservation(expected, 3, 7, { reported_at: now, link_placements: [fact] }, now);
    expect(legacy).not.toHaveProperty("traffic_status");
  });
  test("unknown, stale, foreign, mismatched and expired observations carry no known capacity", () => {
    for (const reported_at of [new Date(now.getTime() - 60001), new Date(now.getTime() + 5001), new Date(NaN)]) {
      expect(observe({}, reported_at)).not.toHaveProperty("traffic_status");
    }
    expect(observe({}, new Date(now.getTime() - 60000))).toHaveProperty("traffic_status", statistics);
    for (const patch of [{ id: "another-placement" }, { node_id: 13 }, { role: "ingress" }, { workspace_id: 9 }, { link_id: 9 },
      { generation: 9 }, { observed_generation: 7 }, { config_digest: "52".repeat(32) }, { desired_config_digest: "53".repeat(32) },
      { lease_expires_at: now.toISOString() }, { lease_expires_at: "" }, { ready: false, state: "expired" },
      { traffic_status: { ...statistics, key: "never-visible" } }]) {
      expect(observe(patch)).not.toHaveProperty("traffic_status");
    }
    expect(linkObservation(expected, 3, 7, null, now)).not.toHaveProperty("traffic_status");
    expect(linkObservation(expected, 3, 7, { reported_at: now, link_placements: [] }, now)).not.toHaveProperty("traffic_status");
  });
  test("stopped or starting child with no live generation can still report blocked storage", () => {
    for (const state of ["failed", "exited", "closed", "passive", "updating", "cached"]) {
      const result = observe({ ready: false, state, observed_generation: 0 });
      expect(result.ready).toBe(false); expect(result.observed_generation).toBe(0);
      expect(result.traffic_status).toEqual(statistics);
    }
    expect(observe({ ready: false, state: "failed", observed_generation: 0, config_digest: "52".repeat(32) }))
      .not.toHaveProperty("traffic_status");
  });
  test("closed statistics projection does not alias the stored report", () => {
    const result = observe(); result.traffic_status!.producer_count = 99;
    expect(statistics.producer_count).toBe(1);
    expect(observe().traffic_status).toEqual(statistics);
  });
});
