import { mock } from "bun:test";
import { fileURLToPath } from "node:url";
import { FORWARD_NATIVE_BOTH_CAPABILITY } from "../forward-native-both.ts";

// Every IO boundary is memory-only. Unknown DB operations throw, not connect.
export const bothFixture = { rows: [] as any[], snapshots: [] as any[], pools: [] as any[],
  writes: [] as string[], queries: [] as any[], reports: new Map<number, any>(),
  types: ["tcp", "udp", "tls", "ws"], role: "owner", memberActive: true, customPermissions: null as any,
  failCommit: false, nextId: 71, egressStrategy: "round" };
export function bothNode(id: number) { return { id, node_id: `n-${id}`, agent_id: `a-${id}`, role: id === 11 ? "ingress" : "egress",
  connect_ip: `127.0.0.${id}`, node_group_id: id, node_group: { workspace_id: 7 }, lifecycle: "active", status: "active",
  node_credential_hash: "fixture", credential_revoked: false, last_seen_at: new Date(),
  port_range_min: 23000, port_range_max: 23100, lb_strategy: id === 22 ? bothFixture.egressStrategy : "round" }; }
export function resetBothFixture() {
  bothFixture.rows = []; bothFixture.snapshots = []; bothFixture.pools = []; bothFixture.writes = []; bothFixture.queries = [];
  bothFixture.types = ["tcp", "udp", "tls", "ws"]; bothFixture.role = "owner"; bothFixture.memberActive = true;
  bothFixture.customPermissions = null; bothFixture.failCommit = false; bothFixture.nextId = 71;
  bothFixture.egressStrategy = "round";
  bothFixture.reports = new Map([11, 22].map((id) => [id, { control_protocol_version: 2,
    capabilities: ["apply_tunnel", "remove_tunnel", "diagnose_tunnel", "forward.policy.runtime.v1", FORWARD_NATIVE_BOTH_CAPABILITY],
    capability_manifest: { schema_version: 2, protocols: ["tcp", "udp", "both"], transports: ["stream", "datagram", "mixed"], runtime: [], diagnostics: [] },
    reported_at: new Date(), node: { credential_rotated_at: new Date(Date.now() - 5000) } }]));
}
resetBothFixture();
const matches = (row: any, where: any = {}): boolean => Object.entries(where).every(([key, value]: any) => {
  if (value === undefined) return true;
  if (key === "OR") return value.some((w: any) => matches(row, w));
  if (key === "AND") return value.every((w: any) => matches(row, w));
  if (key === "NOT") return !matches(row, value);
  if (typeof value === "object" && value !== null) {
    if ("in" in value) return value.in.includes(row[key]);
    if ("not" in value) return row[key] !== value.not;
    if ("lt" in value) return row[key] != null && row[key] < value.lt;
    return matches(row[key] ?? {}, value);
  }
  return row[key] === value;
});
const enrich = (row: any) => row ? { ...row, ingress_node: row.ingress_node_id ? bothNode(row.ingress_node_id) : null,
  egress_node: row.egress_node_id ? bothNode(row.egress_node_id) : null,
  egress_pool: bothFixture.pools.find((p) => p.id === row.egress_pool_id) ?? null, port_leases: [] } : null;
const policy = () => ({ workspace_id: 7, deny_scope: false, revision: 1, active_policies: [], grace_policies: [],
  limits: { max_tunnels: 20, traffic_limit: null, traffic_period: "month", bandwidth_limit: null, client_limit: null, ip_limit: null },
  entitlements: { tunnel_types: bothFixture.types, allowed_in_group_ids: null, allowed_out_group_ids: null } });
const models: any = {
  user: { findUnique: async () => ({ id: 1, email: "fixture@tunex.test", status: "active", super_admin: false, admin_roles: [] }) },
  workspace: { findUnique: async () => ({ id: 7 }) },
  workspaceMember: { findUnique: async ({ where }: any) => where.workspace_id_user_id.workspace_id === 7 ? {
    active: bothFixture.memberActive, role: bothFixture.role, role_id: bothFixture.customPermissions ? 1 : null,
    workspace: { kind: "personal" }, custom_role: bothFixture.customPermissions ? { id: 1, workspace_id: 7, permissions: bothFixture.customPermissions } : null } : null },
  node: { findFirst: async ({ where }: any) => where.node_group?.workspace_id === 7 ? bothNode(where.id) : null,
    findUnique: async ({ where }: any) => bothNode(where.id) },
  nodeGroup: { findUnique: async ({ where }: any) => ({ id: where.id, workspace_id: 7, user_id: 1 }) },
  nodeStateReport: { findUnique: async ({ where }: any) => bothFixture.reports.get(where.node_id) ?? null },
  tunnel: {
    findFirst: async ({ where }: any) => enrich(bothFixture.rows.find((r) => matches(r, where))),
    findUnique: async ({ where }: any) => enrich(bothFixture.rows.find((r) => matches(r, where))),
    findMany: async ({ where }: any) => bothFixture.rows.filter((r) => matches(r, where)).map(enrich),
    count: async ({ where }: any) => bothFixture.rows.filter((r) => matches(r, where)).length,
    aggregate: async () => ({ _max: { order_by: 0 } }),
    create: async ({ data }: any) => { bothFixture.writes.push("tunnel.create"); const row = { id: bothFixture.nextId++, link_resource_id: null, ...data }; bothFixture.rows.push(row); return enrich(row); },
    update: async ({ where, data }: any) => { const row = bothFixture.rows.find((r) => matches(r, where)); if (!row) throw new Error("missing row"); bothFixture.writes.push("tunnel.update"); Object.assign(row, data); return enrich(row); },
    updateMany: async ({ where, data }: any) => { const rows = bothFixture.rows.filter((r) => matches(r, where)); bothFixture.writes.push("tunnel.updateMany"); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; },
  },
  forwardRevision: {
    findMany: async ({ where }: any) => bothFixture.snapshots.filter((s) => matches(s, where)).sort((a,b) => b.revision-a.revision),
    findFirst: async ({ where }: any) => bothFixture.snapshots.find((s) => matches(s, where)) ?? null,
    findUnique: async () => null,
    create: async ({ data }: any) => { bothFixture.writes.push("forwardRevision.create"); const row = { id: bothFixture.snapshots.length + 1, ...data }; bothFixture.snapshots.push(row); return row; },
  },
  egressPool: {
    create: async ({ data }: any) => { bothFixture.writes.push("egressPool.create"); const row = { id: 91, ...data, targets: data.targets?.create ? [data.targets.create] : [] }; bothFixture.pools.push(row); return row; },
    findUnique: async ({ where }: any) => bothFixture.pools.find((p) => where.node_id_name
      ? p.node_id === where.node_id_name.node_id && p.name === where.node_id_name.name : p.id === where.id) ?? null,
    update: async ({ where, data }: any) => { const row = bothFixture.pools.find((p) => p.id === where.id);
      if (!row) throw new Error("missing pool"); bothFixture.writes.push("egressPool.update"); Object.assign(row, data); return row; },
  },
  egressTarget: {
    findMany: async ({ where }: any) => bothFixture.pools.find((p) => p.id === where.pool_id)?.targets ?? [],
    deleteMany: async ({ where }: any) => { const row = bothFixture.pools.find((p) => p.id === where.pool_id);
      if (!row) throw new Error("missing pool"); const count = row.targets.length; row.targets = []; return { count }; },
    create: async ({ data }: any) => { const row = bothFixture.pools.find((p) => p.id === data.pool_id);
      if (!row) throw new Error("missing pool"); row.targets.push(data); return data; },
  },
  nodeBinding: { findUnique: async () => ({ id: 1 }), findMany: async () => [] },
  nodePortLease: { findMany: async () => [] },
  placementLease: { findMany: async () => [] },
  federationLease: { findMany: async () => [] },
  targetObservation: { findMany: async () => [] },
};
const db = new Proxy(models, { get(target, model: string) {
  if (model === "then") return undefined;
  if (model === "$transaction") return async (fn: any) => {
    const backup = structuredClone({ rows: bothFixture.rows, snapshots: bothFixture.snapshots, pools: bothFixture.pools });
    try { const result = await fn(db); if (bothFixture.failCommit) throw new Error("offline commit failure"); return result; }
    catch (error) { Object.assign(bothFixture, backup); throw error; }
  };
  if (model === "$queryRawUnsafe") return async () => [];
  return new Proxy(target[model] ?? {}, { get(table, op: string) {
    return async (...args: any[]) => { bothFixture.queries.push({ model, op, args });
      if (!table[op]) throw new Error(`offline fixture forbids ${model}.${op}`);
      return table[op](...args); };
  } });
} });
mock.module(fileURLToPath(new URL("../../db.ts", import.meta.url)), () => ({ db }));
mock.module(fileURLToPath(new URL("../policy-service.ts", import.meta.url)), () => ({
  getEffectivePolicy: async () => policy(), countWorkspaceTunnels: async () => bothFixture.rows.length,
  sumWorkspaceTraffic: async () => 0, sumFederatedUnattributedTraffic: async () => 0,
  withWorkspaceQuotaLock: async (_id: number, fn: any) => db.$transaction((tx: any) => fn(tx, policy())),
  assignDefaultPolicy: async () => {},
}));
mock.module(fileURLToPath(new URL("../relay-wiring.ts", import.meta.url)), () => ({ getOrchestrator: () => null }));
mock.module(fileURLToPath(new URL("../link-resource.ts", import.meta.url)), () => ({ desiredNodeLinks: async () => [] }));
mock.module("ioredis", () => ({ default: class OfflineRedis {
  on() { return this; } get() { return Promise.resolve(null); } set() { return Promise.resolve("OK"); }
  del() { return Promise.resolve(0); } scan() { return Promise.resolve(["0", []]); } disconnect() {}
} }));
