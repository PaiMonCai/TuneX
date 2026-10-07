import { expect, test } from "bun:test";
import { createForwardRevision, computeForwardImpact, currentDesiredConfig, isMetadataOnlyPatch, mergeForwardCandidate,
  type ForwardCandidateConfig } from "../forward-revision.ts";

const candidate: ForwardCandidateConfig = { name: "policy", mode: "relay", protocol: "tcp", ingress_node_id: 11,
  egress_node_id: 22, listen_port: 23000, target_host: "business.example", target_port: 8080 };
function fixture(linkId: number | null = null, count = 1) {
  const snapshots: any[] = [], writes: any[] = [];
  const row = { id: 1, config_revision: 3, link_resource_id: linkId, listen_ip: "0.0.0.0", listen_port: 23000,
    bytes_per_second_in: 2_000_000, bytes_per_second_out: 0, max_connections: 20, max_connections_per_ip: 2 };
  const tx = { tunnel: { findUnique: async () => row, updateMany: async (args: any) => { writes.push(args); return { count }; } },
    forwardRevision: { findMany: async () => [{ revision: 3 }], create: async (args: any) => { snapshots.push(args.data); return { id: 9 }; } } };
  const write = (c: ForwardCandidateConfig, extra: any = {}) => createForwardRevision({ tunnelId: 1, candidate: c,
    desiredStatus: "active", createdById: 7, ...extra }, tx as any);
  return { snapshots, writes, write };
}
test("policy is immutable snapshot plus projection with revision CAS, preserving requested values", async () => {
  const f = fixture();
  expect(await f.write({ ...candidate, bytes_per_second_out: 123, max_connections: 0 }, { expectedRevision: 3 })).toMatchObject({ revision: 4 });
  expect(f.snapshots[0]).toMatchObject({ bytes_per_second_in: 2_000_000, bytes_per_second_out: 123, max_connections: 0, max_connections_per_ip: 2 });
  expect(f.writes[0].where).toEqual({ id: 1, config_revision: 3 });
  expect(f.writes[0].data).toMatchObject({ config_revision: 4, desired_revision_id: 9, max_connections: 0 });
});
test("stale expected revision rejects before writing; losing CAS rejects the transaction", async () => {
  const stale = fixture();
  await expect(stale.write(candidate, { expectedRevision: 2 })).rejects.toMatchObject({ code: "revision_conflict" });
  expect(stale.snapshots).toHaveLength(0);
  await expect(fixture(null, 0).write(candidate)).rejects.toMatchObject({ code: "revision_conflict" });
});
test("both requires explicit persisted Link identity; forged/missing/native authorization fails", async () => {
  for (const [persisted, c, input] of [
    [null, { ...candidate, protocol: "both" }, {}],
    [5, { ...candidate, protocol: "both", link_resource_id: 5 }, {}],
    [5, { ...candidate, protocol: "both", link_resource_id: 6 }, { link_resource_id: 6 }],
    [5, { ...candidate, protocol: "both", link_resource_id: 5 }, { link_resource_id: 6 }],
  ] as const) {
    const f = fixture(persisted);
    await expect(f.write(c, input)).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.snapshots).toHaveLength(0);
  }
  const f = fixture(5);
  await f.write({ ...candidate, protocol: "both", link_resource_id: 5 }, { link_resource_id: 5, egressPoolId: 99,
    egressTargets: [{ host: "wrong.example", port: 9000, weight: 1, order_by: 1 }] });
  expect(f.snapshots[0]).toMatchObject({ protocol: "both", link_resource_id: 5, egress_pool_id: null,
    target_host: "business.example", target_port: 8080,
    targets: [{ host: "business.example", port: 8080, weight: 1, order_by: 1000 }], federated_egress_peer: null });
  expect(f.writes[0].data).toMatchObject({ remote_host: "business.example", remote_port: 8080, egress_pool_id: null });
});
test("policy-only edits trigger runtime revision and listener replacement; unrelated edits retain policy and Link", () => {
  const base = { ...candidate, link_resource_id: 5, max_connections: 7 };
  const changed = mergeForwardCandidate(base, { max_connections: 8 });
  expect(isMetadataOnlyPatch(base, changed)).toBe(false);
  expect(mergeForwardCandidate(base, { name: "renamed" })).toMatchObject({ link_resource_id: 5, max_connections: 7 });
  expect(computeForwardImpact({ current: base, candidate: changed, ingressNodeId: "in", egressNodeId: "out",
    currentIngressNodeId: "in", currentEgressNodeId: "out", ingressConnectIp: "127.0.0.1", resolvedListenPort: 23000,
    currentResolvedListenPort: 23000, bindingRequired: false }).listener_replacement).toBe(true);
});
