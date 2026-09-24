import { test, expect, describe, mock } from "bun:test";
import type { PolicyContext } from "../config-generator.ts";
import type { EffectivePolicy, PolicyAssignment, PolicyRecord } from "../../services/capability-policy.ts";

/**
 * AUTHZ-02：config-generator 不再读 `user.user_plan`。
 *
 * 覆盖：
 *   · `filterAvailableTunnels` 的额度（max_tunnels / traffic）来源换成
 *     `PolicyContext`（CapabilityPolicy），且**无策略 → 默认拒绝不下发**；
 *   · `buildInNodeConfig` 的 admission 白名单来自策略 entitlement
 *     （`whitelist_ips`），而不是 user_plan；
 *   · `computeAllLimits` 的限速来源换成策略限额；
 *   · 残留的 `user_plan` 只在 legacy 兼容表里存在，配置生成路径不再触碰它。
 *
 * 用 `mock.module` 屏蔽 db/redis/env/config，使纯函数路径离线可跑。
 */
const ROOT = new URL("../..", import.meta.url).pathname;
mock.module(`${ROOT}/db.ts`, () => ({ db: {} }));
mock.module(`${ROOT}/redis.ts`, () => ({
  redis: {
    hgetall: async () => ({}),
    hget: async () => null,
    hset: async () => 1,
  },
}));
mock.module(`${ROOT}/env.ts`, () => ({ env: { siteUrl: "http://127.0.0.1:8788" } }));
mock.module(`${ROOT}/services/config.ts`, () => ({
  systemConfig: { getConfig: async () => null },
}));

const {
  filterAvailableTunnels,
  buildInNodeConfig,
  computeAllLimits,
} = await import("../config-generator.ts");
const { composeEffectivePolicy } = await import("../../services/capability-policy.ts");

const NOW = new Date("2026-09-24T00:00:00.000Z");

function policy(over: Partial<PolicyRecord> = {}): PolicyRecord {
  return {
    id: 1,
    key: "free_personal",
    name: "Free Personal",
    source: "system_default",
    revision: 1,
    is_ceiling: false,
    applies_to: "personal",
    status: "active",
    tunnel_types: ["tcp", "udp"],
    allow_custom_in_group: true,
    allow_custom_out_group: true,
    allowed_in_group_ids: null,
    allowed_out_group_ids: null,
    allow_shared_entry: false,
    max_tunnels: 2,
    max_nodes: null,
    max_members: null,
    traffic_limit: 1000,
    traffic_period: "total",
    bandwidth_limit: null,
    client_limit: null,
    ip_limit: null,
    whitelist_ips: null,
    ...over,
  };
}

function assignment(p: PolicyRecord): PolicyAssignment {
  return {
    policy: p,
    source: "system_default",
    effective_at: new Date(NOW.getTime() - 86_400_000),
    expires_at: null,
    revoked_at: null,
    note: null,
  };
}

/** 按 workspace_id 精确构造策略上下文。 */
function ctx(entries: { workspaceId: number; policies: PolicyRecord[]; trafficUsed?: number }[]): PolicyContext {
  const policies = new Map<number, EffectivePolicy>();
  const traffic = new Map<number, number>();
  for (const e of entries) {
    policies.set(
      e.workspaceId,
      composeEffectivePolicy({
        workspace_id: e.workspaceId,
        assignments: e.policies.map(assignment),
        now: NOW,
        graceMs: 0,
      }),
    );
    if (e.trafficUsed !== undefined) traffic.set(e.workspaceId, e.trafficUsed);
  }
  return { policies, trafficUsed: traffic };
}

interface TunnelOpts {
  id: number;
  workspaceId?: number;
  userId?: number;
  ipLimit?: number | null;
  clientLimit?: number | null;
  bandwidthLimit?: number | null;
}

function tunnel(o: TunnelOpts) {
  const workspaceId = o.workspaceId ?? 1;
  return {
    id: o.id,
    name: `t${o.id}`,
    tunnel_type: "tcp",
    category: "port_forward",
    listen_ip: "",
    listen_port: 19001 + o.id,
    listen_protocol: null,
    forward_addresses: [{ address: "127.0.0.1:19911", weight: 1 }],
    forward_addresses_protocol: null,
    load_balance_type: "round",
    ip_type: "ipv4",
    ip_limit: o.ipLimit ?? null,
    client_limit: o.clientLimit ?? null,
    bandwidth_limit: o.bandwidthLimit ?? null,
    proxy_protocol: false,
    status: "active",
    in_node_group_id: 4,
    // isNodeGroupGranted：组归属该 workspace 即放行（自有组）。
    in_node_group: { id: 4, user_id: 1, workspace_id: workspaceId },
    out_node_group_id: null,
    out_node_group: null,
    tunnel_chains: [],
    user_id: o.userId ?? 1,
    workspace_id: workspaceId,
    user: {
      id: 1,
      // 关键：user 上**不再有** user_plan。任何残留依赖都会在这里得到 undefined。
      legacy_user_plan_absent: true,
    },
  } as never;
}

describe("filterAvailableTunnels quotas from CapabilityPolicy (no user_plan)", () => {
  test("max_tunnels from policy limits the number of pushed tunnels", () => {
    const list = [tunnel({ id: 1 }), tunnel({ id: 2 }), tunnel({ id: 3 })];
    const c = ctx([{ workspaceId: 1, policies: [policy({ max_tunnels: 2 })] }]);
    const out = filterAvailableTunnels(list, undefined, undefined, c);
    expect(out.map((t) => t.id)).toEqual([1, 2]);
  });

  test("max_tunnels = null means unlimited", () => {
    const list = [tunnel({ id: 1 }), tunnel({ id: 2 }), tunnel({ id: 3 })];
    const c = ctx([{ workspaceId: 1, policies: [policy({ max_tunnels: null })] }]);
    expect(filterAvailableTunnels(list, undefined, undefined, c)).toHaveLength(3);
  });

  test("exhausted traffic limits the workspace's tunnels to none", () => {
    const list = [tunnel({ id: 1 }), tunnel({ id: 2 })];
    const c = ctx([{ workspaceId: 1, policies: [policy({ traffic_limit: 1000 })], trafficUsed: 1000 }]);
    expect(filterAvailableTunnels(list, undefined, undefined, c)).toHaveLength(0);
  });

  test("traffic under the limit still pushes", () => {
    const list = [tunnel({ id: 1 })];
    const c = ctx([{ workspaceId: 1, policies: [policy({ traffic_limit: 1000 })], trafficUsed: 500 }]);
    expect(filterAvailableTunnels(list, undefined, undefined, c)).toHaveLength(1);
  });

  test("per-user counting is independent per workspace policy", () => {
    // 同一用户名出现在两个 workspace：各自的 max_tunnels 单独计算。
    const list = [
      tunnel({ id: 1, workspaceId: 1 }),
      tunnel({ id: 2, workspaceId: 1 }),
      tunnel({ id: 3, workspaceId: 2 }),
    ];
    const c = ctx([
      { workspaceId: 1, policies: [policy({ max_tunnels: 1 })] },
      { workspaceId: 2, policies: [policy({ max_tunnels: 5 })] },
    ]);
    const out = filterAvailableTunnels(list, undefined, undefined, c);
    expect(out.map((t) => t.id)).toEqual([1, 3]);
  });

  test("no policy entry for the workspace → deny by default (nothing pushed)", () => {
    // PLAN §4.2「绝不因没有套餐就默认放行」的回归保险。
    const list = [tunnel({ id: 1 })];
    const empty = ctx([]);
    expect(filterAvailableTunnels(list, undefined, undefined, empty)).toHaveLength(0);
  });

  test("expired policy beyond grace (deny_scope) → nothing pushed", () => {
    const list = [tunnel({ id: 1 })];
    const c = ctx([{ workspaceId: 1, policies: [] }]); // 无任何生效发放 → deny_scope
    expect(c.policies.get(1)!.deny_scope).toBe(true);
    expect(filterAvailableTunnels(list, undefined, undefined, c)).toHaveLength(0);
  });

  test("no policy context (pure internal path) keeps old unlimited behaviour", () => {
    const list = [tunnel({ id: 1 }), tunnel({ id: 2 }), tunnel({ id: 3 })];
    expect(filterAvailableTunnels(list, undefined, undefined, undefined)).toHaveLength(3);
  });
});

describe("admission whitelist from policy entitlement", () => {
  function buildWithPolicy(whitelistIps: string[] | null) {
    const p = policy({ whitelist_ips: whitelistIps });
    const c = ctx([{ workspaceId: 1, policies: [p] }]);
    return buildInNodeConfig({
      inNodeGroupId: 4,
      portRange: null,
      allowListenProtocol: false,
      allTunnels: [tunnel({ id: 1 })],
      outListens: {},
      tunnelLimits: new Map(),
      siteUrl: "http://127.0.0.1:8788",
      observerPeriod: "5s",
      // 入口组开启 admission，白名单才有意义。
      bypass: { type: "whitelist", list: [], admission: true },
      policyContext: c,
    });
  }

  test("policy whitelist_ips → admission matchers pushed", () => {
    const cfg = buildWithPolicy(["10.0.0.0/8", "192.168.1.10"]);
    const admissions = (cfg.admissions ?? []) as { name: string; whitelist: boolean; matchers: string[] }[];
    expect(admissions).toHaveLength(1);
    expect(admissions[0]!.matchers).toEqual(["10.0.0.0/8", "192.168.1.10"]);
    expect(admissions[0]!.whitelist).toBe(true);
  });

  test("policy whitelist_ips = null → no admission (never default-allow)", () => {
    const cfg = buildWithPolicy(null);
    expect(cfg.admissions ?? []).toHaveLength(0);
  });

  test("empty whitelist array → no admission entry", () => {
    const cfg = buildWithPolicy([]);
    expect(cfg.admissions ?? []).toHaveLength(0);
  });

  test("admission disabled on the group → no admission even with a whitelist", () => {
    const p = policy({ whitelist_ips: ["10.0.0.1"] });
    const c = ctx([{ workspaceId: 1, policies: [p] }]);
    const cfg = buildInNodeConfig({
      inNodeGroupId: 4,
      portRange: null,
      allowListenProtocol: false,
      allTunnels: [tunnel({ id: 1 })],
      outListens: {},
      tunnelLimits: new Map(),
      siteUrl: "http://127.0.0.1:8788",
      observerPeriod: "5s",
      bypass: { type: "blacklist", list: [], admission: false },
      policyContext: c,
    });
    expect(cfg.admissions ?? []).toHaveLength(0);
  });
});

describe("computeAllLimits limits from policy", () => {
  test("tunnel scope: min(tunnel, policy) per field", () => {
    const c = ctx([{ workspaceId: 1, policies: [policy({ ip_limit: 64, client_limit: 10, bandwidth_limit: 100 })] }]);
    const list = [tunnel({ id: 1, ipLimit: 32, clientLimit: 100, bandwidthLimit: 200 })];
    const limits = computeAllLimits(list, "tunnel", c);
    expect(limits.get(1)!.ip_limit).toBe(32); // min(32, 64)
    expect(limits.get(1)!.client_limit).toBe(10); // min(100, 10)
    expect(limits.get(1)!.bandwidth_limit).toBe(100); // min(200, 100)
    expect(limits.get(1)!.climiter_name).toBe("climiter-1");
    expect(limits.get(1)!.limiter_name).toBe("limiter-1");
  });

  test("user scope: limiter names are per-user and values come from policy", () => {
    const c = ctx([{ workspaceId: 1, policies: [policy({ ip_limit: 8, bandwidth_limit: 80 })] }]);
    const list = [tunnel({ id: 7, userId: 42 })];
    const limits = computeAllLimits(list, "user", c);
    expect(limits.get(7)!.ip_limit).toBe(8);
    expect(limits.get(7)!.bandwidth_limit).toBe(80);
    expect(limits.get(7)!.climiter_name).toBe("climiter-u42");
    expect(limits.get(7)!.limiter_name).toBe("limiter-u42");
  });

  test("missing policy entry → no limits (fails open only on the rate limiter)", () => {
    const c = ctx([]);
    const limits = computeAllLimits([tunnel({ id: 1 })], "tunnel", c);
    expect(limits.get(1)!.ip_limit).toBeUndefined();
    expect(limits.get(1)!.climiter_name).toBeUndefined();
  });
});

describe("generated config carries no user_plan leakage", () => {
  test("in-config JSON has no user_plan field", () => {
    const c = ctx([{ workspaceId: 1, policies: [policy()] }]);
    const cfg = buildInNodeConfig({
      inNodeGroupId: 4,
      portRange: "19000-19010",
      allowListenProtocol: false,
      allTunnels: [tunnel({ id: 1 })],
      outListens: {},
      tunnelLimits: computeAllLimits([tunnel({ id: 1 })], "tunnel", c),
      siteUrl: "http://127.0.0.1:8788",
      observerPeriod: "5s",
      policyContext: c,
    });
    const json = JSON.stringify(cfg);
    expect(json).not.toContain("user_plan");
    expect(json).not.toContain("traffic_used");
    expect(cfg.services!.length).toBeGreaterThan(0);
  });
});
