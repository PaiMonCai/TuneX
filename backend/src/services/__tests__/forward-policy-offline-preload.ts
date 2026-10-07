import { mock } from "bun:test";
import { fileURLToPath } from "node:url";

// No Prisma/Redis client is constructed. Only fixture reads are permitted.
process.env.AUTH_SECRET ||= "offline-forward-policy-only";
process.env.DATABASE_URL ||= "mysql://unused:unused@127.0.0.1:1/unused";
export const policyFixture = {
  rows: [] as any[], snapshot: null as any, report: null as any,
  limits: { bandwidth_limit: null as number | null, client_limit: null as number | null },
  policyReads: 0, reads: [] as string[], mutations: 0,
};
const fail = (name: string) => async () => { policyFixture.mutations++; throw new Error(`offline fixture forbids ${name}`); };
const policyRow = () => ({ id: 1, key: "fixture", name: "fixture", source: "admin_grant", revision: 1,
  is_ceiling: false, applies_to: null, status: "active", tunnel_types: ["tcp", "udp", "tls", "ws"],
  allow_custom_in_group: true, allow_custom_out_group: true, allowed_in_group_ids: null, allowed_out_group_ids: null,
  allow_shared_entry: true, max_tunnels: null, max_nodes: null, max_members: null, traffic_limit: null,
  traffic_period: "total", ip_limit: null, whitelist_ips: null, ...policyFixture.limits });
const models: Record<string, unknown> = {
  tunnel: {
    findMany: async () => policyFixture.rows,
    findFirst: async () => policyFixture.rows[0] ?? null,
    findUnique: async () => policyFixture.rows[0] ?? null,
  },
  forwardRevision: { findUnique: async () => policyFixture.snapshot,
    findMany: async () => policyFixture.snapshot ? [{ tunnel_id: policyFixture.rows[0]?.id,
      revision: policyFixture.rows[0]?.config_revision, ...policyFixture.snapshot }] : [] },
  node: { findUnique: async () => ({ node_group: { workspace_id: 7 } }) },
  nodeStateReport: { findUnique: async () => policyFixture.report },
  workspacePolicyAssignment: { findMany: async () => {
    policyFixture.policyReads++;
    return [{ source: "admin_grant", effective_at: new Date(0), expires_at: null, revoked_at: null, note: null, policy: policyRow() }];
  } },
  capabilityPolicy: { findMany: async () => [] },
  placementLease: { findMany: async () => [] },
  federationLease: { findMany: async () => [] },
  targetObservation: { findMany: async () => [] },
};
const db = new Proxy(models, { get(target, model: string) {
  if (model === "then") return undefined;
  if (model === "$transaction") return fail(model);
  return new Proxy((target[model] ?? {}) as object, { get(table: any, op: string) {
    if (typeof table[op] === "function") return async (...args: any[]) => {
      policyFixture.reads.push(`${model}.${op}`); return table[op](...args);
    };
    return fail(`${model}.${op}`);
  } });
} });
mock.module(fileURLToPath(new URL("../../db.ts", import.meta.url)), () => ({ db }));
mock.module(fileURLToPath(new URL("../link-resource.ts", import.meta.url)), () => ({ desiredNodeLinks: async () => [] }));
mock.module("ioredis", () => ({ default: class OfflineRedis {
  on() { return this; }
  constructor() { return new Proxy(this, { get: (target, key: string) => key === "on" ? target.on.bind(target) : fail(`redis.${key}`) }); }
} }));
