import { expect, test } from "bun:test";
import { linkObservation } from "../link-observation.ts";
const now = new Date("2030-01-01T00:00:00Z");
const expected = { runtime_id: "tunex-link-7-p12-egress", node_id: 12, role: "egress", generation: 8, config_digest: "51".repeat(32) };
const fact = { id: expected.runtime_id, node_id: 12, workspace_id: 3, link_id: 7, role: "egress",
  generation: 8, observed_generation: 8, config_digest: expected.config_digest, desired_config_digest: expected.config_digest,
  state: "ready", ready: true, lease_expires_at: "2030-01-01T00:01:00Z", runtime_ids: [], ports: [] };
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
