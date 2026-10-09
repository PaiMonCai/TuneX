import { expect, test } from "bun:test";
import { Prisma } from "@prisma/client";
import { createForwardRevision, ensureForwardBaselineRevision, currentDesiredConfig, mergeForwardCandidate,
  isMetadataOnlyPatch, type ForwardCandidateConfig } from "../forward-revision.ts";

const rawSource = { version: 1 as const, receive_proxy: true, trusted_cidrs: ["192.0.2.129/24", "2001:0DB8::7/32"], send_proxy: "v2" as const };
const source = { ...rawSource, trusted_cidrs: ["192.0.2.0/24", "2001:db8::/32"] };
const disabled = { version: 1 as const, receive_proxy: false, trusted_cidrs: [], send_proxy: "off" as const };
const targetSet = { version: 1 as const, targets: [{ host: "business.example", port: 443 }, { host: "backup.example", port: 8443 }],
  strategy: "ip_hash" as const, failure_seconds: 10, recover_seconds: 20, probe: "tcp" as const };
const candidate: ForwardCandidateConfig = { name: "source", mode: "relay", protocol: "tcp", ingress_node_id: 11,
  egress_node_id: 12, listen_port: 26000, target_host: "business.example", target_port: 443, link_resource_id: 5 };

function fixture(extra: Record<string, unknown> = {}) {
  const row: any = { id: 21, workspace_id: 3, category: "port_forward", name: candidate.name,
    tunnel_mode: "relay", tunnel_type: "tcp", forward_protocol: "tcp", ingress_node_id: 11, egress_node_id: 12,
    link_resource_id: 5, listen_ip: "127.0.0.1", listen_port: 26000, remote_host: candidate.target_host,
    remote_port: 443, config_revision: 0, applied_revision: 0, desired_revision_id: null,
    desired_status: "active", forward_addresses: [], ...extra };
  const snapshots: any[] = [], writes: any[] = [];
  const normalize = (data: any) => Object.fromEntries(Object.entries(data).map(([key, value]) =>
    [key, value === Prisma.JsonNull ? null : structuredClone(value)]));
  const tx: any = { tunnel: {
    findUnique: async ({ select }: any) => { expect(select.link_source_config).toBe(true); return row; },
    updateMany: async (args: any) => { writes.push(args); Object.assign(row, normalize(args.data)); return { count: 1 }; },
  }, forwardRevision: {
    findFirst: async ({ where }: any) => snapshots.find(r => r.revision === where.revision) ?? null,
    findMany: async () => [...snapshots].reverse(),
    create: async ({ data }: any) => { const snapshot = { id: snapshots.length + 1, ...normalize(data) }; snapshots.push(snapshot); return snapshot; },
  } };
  const write = (patch: Partial<ForwardCandidateConfig> = {}, status: "active" | "inactive" = "active", expected = row.config_revision) =>
    createForwardRevision({ tunnelId: row.id, link_resource_id: row.link_resource_id, desiredStatus: status,
      createdById: 8, candidate: { ...candidate, link_resource_id: row.link_resource_id, ...patch }, expectedRevision: expected }, tx);
  return { row, snapshots, writes, tx, write };
}

test("source snapshots canonicalize initial values, preserve internal omission and freeze explicit disable", async () => {
  const f = fixture();
  await f.write({ target_set: targetSet, client_source: rawSource });
  expect(f.row.link_source_config).toEqual(source);expect(f.snapshots[0].link_source_config).toEqual(source);
  expect(f.snapshots[0].targets).toEqual(targetSet.targets.map((t, order_by) => ({ ...t, weight: 1, order_by })));
  const frozen = structuredClone(f.snapshots[0]);
  expect(currentDesiredConfig(f.row).client_source).toEqual(source);
  await f.write({}, "inactive");expect(f.row.link_source_config).toEqual(source);
  await f.write({ client_source: disabled }, "inactive");
  expect(f.snapshots.at(-1).link_source_config).toEqual(disabled);
  await f.write();expect(f.row.link_source_config).toEqual(disabled);
  expect(f.snapshots[0]).toEqual(frozen);
  expect(currentDesiredConfig(f.row).client_source).toEqual(disabled);
  expect(f.writes.every(w => typeof w.where.config_revision === "number")).toBe(true);
});

test("source baseline freezes full config, preserves desired state and remains immutable after edits", async () => {
  const f = fixture({ config_revision: 4, applied_revision: 4, link_source_config: source, link_target_config: targetSet });
  const before = currentDesiredConfig(f.row);
  const baseline = await ensureForwardBaselineRevision(f.row.id, 8, f.tx);
  expect(baseline).toMatchObject({ created: true, revision: 4 });
  expect(f.snapshots[0].link_source_config).toEqual(source);expect(f.snapshots[0].link_target_config).toEqual(targetSet);
  expect(currentDesiredConfig(f.row)).toEqual(before);
  expect(f.row.config_revision).toBe(4);expect(f.row.applied_revision).toBe(4);
  const frozen = structuredClone(f.snapshots[0]);
  expect(await ensureForwardBaselineRevision(f.row.id, 8, f.tx)).toMatchObject({ created: false, revision: 4 });
  expect(f.snapshots).toHaveLength(1);
  await f.write({ client_source: disabled });expect(f.row.config_revision).toBe(5);
  expect(f.snapshots[0]).toEqual(frozen);expect(f.snapshots[1].link_source_config).toEqual(disabled);
});

test("writer rejects source/IP_HASH on native or non-TCP paths and stale CAS before writes", async () => {
  for (const [link, patch] of [
    [null, { client_source: source }],
    [5, { client_source: source, protocol: "udp" }],
    [5, { client_source: disabled, protocol: "both" }],
    [5, { target_set: targetSet }],
    [5, { client_source: null }],
  ] as const) {
    const f = fixture({ link_resource_id: link });
    await expect(f.write(patch as any)).rejects.toBeDefined();
    expect(f.snapshots).toHaveLength(0);expect(f.writes).toHaveLength(0);
  }
  const f = fixture({ config_revision: 4 });
  await expect(f.write({ client_source: source }, "active", 3)).rejects.toMatchObject({ code: "revision_conflict" });
  expect(f.snapshots).toHaveLength(0);expect(f.writes).toHaveLength(0);
});

test("legacy absence and source-only runtime changes survive current/merge/metadata classification", async () => {
  const f = fixture(); await f.write();
  expect(f.row.link_source_config).toBeNull();expect(f.snapshots[0].link_source_config).toBeNull();
  expect("client_source" in currentDesiredConfig(f.row)).toBe(false);
  const base = { ...candidate, client_source: source };
  expect(mergeForwardCandidate(base, { name: "rename" }).client_source).toEqual(source);
  expect(isMetadataOnlyPatch(base, mergeForwardCandidate(base, { name: "rename" }))).toBe(true);
  expect(isMetadataOnlyPatch(base, mergeForwardCandidate(base, { client_source: disabled }))).toBe(false);
  expect(isMetadataOnlyPatch(candidate, { ...candidate, client_source: disabled })).toBe(false);
});
