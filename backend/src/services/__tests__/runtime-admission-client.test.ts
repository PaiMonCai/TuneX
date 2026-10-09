import { expect, test } from "bun:test";
import { loadNodeCapabilityFacts } from "../runtime-admission.ts";

test("capability reader stays on the supplied transaction client and fences stale/future/rotated reports", async () => {
  let row: unknown = null;
  const calls: unknown[] = [];
  const client = { nodeStateReport: { findUnique: async (args: unknown) => { calls.push(args); return row; } } };
  const reader = client as unknown as NonNullable<Parameters<typeof loadNodeCapabilityFacts>[1]>;
  const now = Date.now();
  const report = (reported_at: Date, credential_rotated_at: Date | null = null) => ({
    control_protocol_version: 2, capabilities: ["forward.link.fxp.v1"], capability_manifest: null,
    reported_at, node: { credential_rotated_at },
  });
  expect(await loadNodeCapabilityFacts(11, reader)).toBeNull();
  row = report(new Date(now)); expect((await loadNodeCapabilityFacts(11, reader))?.advertisementCurrent).toBe(true);
  row = report(new Date(now - 120_001)); expect((await loadNodeCapabilityFacts(11, reader))?.advertisementCurrent).not.toBe(true);
  row = report(new Date(now + 31_000)); expect((await loadNodeCapabilityFacts(11, reader))?.advertisementCurrent).not.toBe(true);
  row = report(new Date(now), new Date(now)); expect((await loadNodeCapabilityFacts(11, reader))?.advertisementCurrent).not.toBe(true);
  expect(calls).toHaveLength(5);
  expect(calls[0]).toMatchObject({ where: { node_id: 11 }, select: { reported_at: true, node: { select: { credential_rotated_at: true } } } });
});
