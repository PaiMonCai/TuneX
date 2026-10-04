/**
 * V5.5 WP15 —— Resource Grant 的离线断言（bun:test，无 DB / 无网络）。
 *
 * 这里钉住的是「grant 允不允许」这一类判定——它的错误方向是**放行**，而放行一次越权
 * intent 就等于把 host 的资源交给了未经授权的范围。所以每条边界都同时有正例与反例：
 *   · scope / capacity 的未知键与非法类型必须 fail-closed（§3.5）；
 *   · 缺省 scope 必须是"什么都不允许"，而不是"不限"；
 *   · epoch 单调、撤销不可逆、撤销必须级联停服；
 *   · quota 预留要么真预留，要么拒绝签发（不许"声称预留"）。
 *
 * DB 用内存替身注入（`GrantDeps.db`），因此不需要 `mock.module`——它不会因为模块解析
 * 路径变化而静默失效（与 `portPool.test.ts` 的取向一致）。
 */
import { describe, expect, test } from "bun:test";

import {
  createGrant,
  evaluateGrant,
  expireGrants,
  nextGrantEpoch,
  parseGrantCapacity,
  parseGrantScope,
  resumeGrant,
  revokeGrant,
  suspendGrant,
  type GrantDb,
} from "../federation/grant.ts";
import type { FederationAuditInput } from "../federation/audit.ts";

/* ------------------------------------------------------------------ */
/* 内存 DB 替身                                                        */
/* ------------------------------------------------------------------ */

/**
 * 夹具行类型。测试替身只需要"能塞进注入接缝"，不需要复刻 Prisma 的投影类型；
 * 真正的类型安全由被测模块的签名保证（夹具塞错字段会在断言里立刻暴露）。
 */
type Row = any;

const NOW = new Date("2026-10-05T04:00:00Z");
const LATER = new Date("2026-10-05T05:00:00Z");

function uniqueConflict(): Error {
  const e = new Error("unique constraint");
  (e as any).code = "P2002";
  return e;
}

function makeGrantDb(fx: { peer?: Row | null; grants?: Row[]; leases?: Row[] }) {
  const grants: Row[] = (fx.grants ?? []).map((g) => ({ ...g }));
  const leases: Row[] = (fx.leases ?? []).map((l) => ({ ...l }));
  const calls = {
    grantCreate: [] as Row[],
    grantUpdateMany: [] as Row[],
    leaseUpdateMany: [] as Row[],
  };

  function selectGrant(where: Row): Row | null {
    const row = grants.find(
      (g) =>
        (where.grant_ref !== undefined && g.grant_ref === where.grant_ref) ||
        (where.id !== undefined && g.id === where.id),
    );
    if (!row) return null;
    return { ...row, peer_panel_id: row.peer_panel_id ?? fx.peer?.peer_panel_id ?? null };
  }

  const db: GrantDb = {
    federationPeer: {
      async findUnique(args: any) {
        const w = args.where ?? {};
        return fx.peer && fx.peer.peer_panel_id === w.peer_panel_id ? { ...fx.peer } : null;
      },
    },
    federationGrant: {
      async findUnique(args: any) {
        return selectGrant(args.where ?? {});
      },
      async findFirst(args: any) {
        return selectGrant(args.where ?? {});
      },
      async findMany(args: any) {
        const w = args.where ?? {};
        const wanted: string[] | undefined = w.status?.in;
        const lte: Date | undefined = w.expires_at?.lte;
        return grants
          .filter((g) => (wanted === undefined || wanted.includes(g.status)) && (lte === undefined || g.expires_at.getTime() <= lte.getTime()))
          .map((g) => ({ ...g }));
      },
      async create(args: any) {
        calls.grantCreate.push(args.data);
        const row: Row = {
          id: grants.length + 1,
          revoked_at: null,
          created_at: NOW,
          updated_at: NOW,
          ...args.data,
        };
        grants.push(row);
        return { ...row };
      },
      async updateMany(args: any) {
        calls.grantUpdateMany.push(args);
        const w = args.where ?? {};
        let count = 0;
        for (const g of grants) {
          if (w.id !== undefined && g.id !== w.id) continue;
          if (w.grant_epoch !== undefined && g.grant_epoch !== w.grant_epoch) continue;
          if (typeof w.status === "string" && g.status !== w.status) continue;
          Object.assign(g, args.data);
          count++;
        }
        return { count };
      },
    },
    federationLease: {
      async findMany(args: any) {
        const w = args.where ?? {};
        const wanted: string[] | undefined = w.state?.in;
        return leases
          .filter((l) => (w.grant_id === undefined || l.grant_id === w.grant_id) && (wanted === undefined || wanted.includes(l.state)))
          .map((l) => ({ ...l }));
      },
      async updateMany(args: any) {
        calls.leaseUpdateMany.push(args);
        const w = args.where ?? {};
        let count = 0;
        for (const l of leases) {
          if (w.id !== undefined && l.id !== w.id) continue;
          if (w.lease_epoch !== undefined && l.lease_epoch !== w.lease_epoch) continue;
          if (typeof w.state === "string" && l.state !== w.state) continue;
          if (w.state?.in !== undefined && !w.state.in.includes(l.state)) continue;
          Object.assign(l, args.data);
          count++;
        }
        return { count };
      },
    },
  };

  return { db, grants, leases, calls };
}

/** 不关心内容的调用点用它：默认 sink 会去写真实 DB，测试里没必要制造噪音。 */
const silentAudit = () => {};

function captureAudit() {
  const events: FederationAuditInput[] = [];
  return {
    events,
    sink: (input: FederationAuditInput) => {
      events.push(input);
    },
  };
}

function grantRow(over: Row = {}): Row {
  return {
    id: 1,
    grant_ref: "grant-1",
    peer_id: 9,
    peer_panel_id: "panel-a",
    workspace_id: null,
    grant_epoch: 3,
    status: "active",
    scope: { node_group_ids: [7], hop_roles: ["egress", "transit"], allow_target_policy: ["pinned"] },
    capacity: { max_legs: 3, max_bandwidth_mbps: null, max_connections: null },
    quota_reserved: false,
    expires_at: LATER,
    revoked_at: null,
    created_by_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function leaseRow(over: Row = {}): Row {
  return {
    id: 11,
    lease_ref: "lease-1",
    grant_id: 1,
    peer_panel_id: "panel-a",
    forward_ref: "fwd-1",
    intent_id: "intent-1",
    state: "active",
    lease_epoch: 4,
    hop_role: "egress",
    node_id: 5,
    listen_port: 19001,
    ...over,
  };
}

/* ================================================================== */
/* scope / capacity 解析                                               */
/* ================================================================== */

describe("WP15 grant: scope parsing is fail-closed", () => {
  test("a full valid scope is normalized and de-duplicated", () => {
    const parsed = parseGrantScope({
      node_group_ids: [7, 7, 8],
      hop_roles: ["egress", "egress"],
      allow_target_policy: ["pinned", "pinned", "round_robin"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.node_group_ids).toEqual([7, 8]);
    expect(parsed.value.hop_roles).toEqual(["egress"]);
    expect(parsed.value.allow_target_policy).toEqual(["pinned", "round_robin"]);
  });

  test("missing scope means NOTHING is allowed (deny-by-default, not 'unlimited')", () => {
    for (const raw of [undefined, null]) {
      const parsed = parseGrantScope(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.node_group_ids).toEqual([]);
      expect(parsed.value.hop_roles).toEqual([]);
    }
  });

  test("unknown keys are rejected, not ignored", () => {
    const parsed = parseGrantScope({ node_group_ids: [7], hop_roles: ["egress"], max_legs: 5 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("grant_scope_violation");
    expect(parsed.message).toContain("max_legs");
  });

  test("non-object / wrong element types are rejected", () => {
    expect(parseGrantScope("nope").ok).toBe(false);
    expect(parseGrantScope([1, 2]).ok).toBe(false);
    for (const bad of [[0], [-1], [1.5], ["7"], [null]]) {
      expect(parseGrantScope({ node_group_ids: bad }).ok).toBe(false);
    }
    expect(parseGrantScope({ hop_roles: ["egress", "uplink"] }).ok).toBe(false);
    expect(parseGrantScope({ node_group_ids: [7] }).ok).toBe(true); // 只有 hop_roles 缺省 → 空 = 全拒
  });

  test("allow_target_policy must be a list of non-empty strings", () => {
    expect(parseGrantScope({ allow_target_policy: true }).ok).toBe(false);
    expect(parseGrantScope({ allow_target_policy: [""] }).ok).toBe(false);
    expect(parseGrantScope({ allow_target_policy: ["  "] }).ok).toBe(false);
    expect(parseGrantScope({ allow_target_policy: [7] }).ok).toBe(false);
    const ok = parseGrantScope({ allow_target_policy: null });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.allow_target_policy).toBeNull();
  });
});

describe("WP15 grant: capacity parsing is fail-closed", () => {
  test("absent capacity = unlimited on every dimension", () => {
    const parsed = parseGrantCapacity(undefined);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ max_legs: null, max_bandwidth_mbps: null, max_connections: null });
  });

  test("zero is a legal (and meaningful) limit; null means unlimited", () => {
    const parsed = parseGrantCapacity({ max_legs: 0, max_bandwidth_mbps: null });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ max_legs: 0, max_bandwidth_mbps: null, max_connections: null });
  });

  test("negative / fractional / unknown keys / wrong types are rejected", () => {
    for (const bad of [{ max_legs: -1 }, { max_legs: 1.5 }, { max_legs: "3" }, { max_conns: 1 }, { max_legs: Number.NaN }]) {
      const parsed = parseGrantCapacity(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe("message_malformed");
    }
    expect(parseGrantCapacity([]).ok).toBe(false);
  });
});

/* ================================================================== */
/* evaluateGrant                                                       */
/* ================================================================== */

describe("WP15 grant: evaluateGrant decides allow/deny with closed-set codes", () => {
  const base = {
    grant: grantRow(),
    hopRole: "egress",
    nodeGroupId: 7,
    workspaceId: null,
    activeLegs: 0,
    now: NOW,
  };

  test("a well-formed active grant allows a matching intent", () => {
    const decision = evaluateGrant(base);
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.grant_epoch).toBe(3);
  });

  test("revoked / suspended / expired status map to their own codes", () => {
    const revoked = evaluateGrant({ ...base, grant: grantRow({ status: "revoked" }) });
    expect(revoked.allow).toBe(false);
    if (!revoked.allow) expect(revoked.code).toBe("grant_not_active");

    const suspended = evaluateGrant({ ...base, grant: grantRow({ status: "suspended" }) });
    expect(suspended.allow).toBe(false);
    if (!suspended.allow) expect(suspended.code).toBe("grant_not_active");

    const expiredStatus = evaluateGrant({ ...base, grant: grantRow({ status: "expired" }) });
    expect(expiredStatus.allow).toBe(false);
    if (!expiredStatus.allow) expect(expiredStatus.code).toBe("grant_expired");
  });

  test("expires_at in the past denies even when status still says active", () => {
    const decision = evaluateGrant({ ...base, grant: grantRow({ status: "active", expires_at: NOW }) });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.code).toBe("grant_expired");
  });

  test("hop role and node group must both be inside the granted scope", () => {
    const wrongRole = evaluateGrant({ ...base, hopRole: "ingress" });
    expect(wrongRole.allow).toBe(false);
    if (!wrongRole.allow) expect(wrongRole.code).toBe("grant_scope_violation");

    const wrongGroup = evaluateGrant({ ...base, nodeGroupId: 8 });
    expect(wrongGroup.allow).toBe(false);
    if (!wrongGroup.allow) expect(wrongGroup.code).toBe("grant_scope_violation");

    const unknownGroup = evaluateGrant({ ...base, nodeGroupId: null });
    expect(unknownGroup.allow).toBe(false);
    if (!unknownGroup.allow) expect(unknownGroup.code).toBe("grant_scope_violation");
  });

  test("a grant scoped to a workspace cannot be consumed by another / unknown workspace", () => {
    const scoped = grantRow({ workspace_id: 42 });
    expect(evaluateGrant({ ...base, grant: scoped, workspaceId: 42 }).allow).toBe(true);
    for (const ws of [43, null]) {
      const denied = evaluateGrant({ ...base, grant: scoped, workspaceId: ws });
      expect(denied.allow).toBe(false);
      if (!denied.allow) expect(denied.code).toBe("grant_scope_violation");
    }
    // 未限定 workspace 的 grant 对任何 workspace 都适用。
    expect(evaluateGrant({ ...base, grant: grantRow({ workspace_id: null }), workspaceId: 42 }).allow).toBe(true);
  });

  test("leg capacity: boundary is inclusive, and 0 means nothing may be placed", () => {
    const grant = grantRow({ capacity: { max_legs: 3 } });
    expect(evaluateGrant({ ...base, grant, activeLegs: 2 }).allow).toBe(true);
    const full = evaluateGrant({ ...base, grant, activeLegs: 3 });
    expect(full.allow).toBe(false);
    if (!full.allow) expect(full.code).toBe("quota_exhausted");

    const zero = evaluateGrant({ ...base, grant: grantRow({ capacity: { max_legs: 0 } }), activeLegs: 0 });
    expect(zero.allow).toBe(false);
    if (!zero.allow) expect(zero.code).toBe("quota_exhausted");
  });

  test("renewal (requestedLegs=0) is still allowed when the leg budget is exactly full", () => {
    const grant = grantRow({ capacity: { max_legs: 3 } });
    const decision = evaluateGrant({ ...base, grant, activeLegs: 3, requestedLegs: 0 });
    expect(decision.allow).toBe(true);
  });

  test("multi-leg requests are checked as a whole", () => {
    const grant = grantRow({ capacity: { max_legs: 3 } });
    expect(evaluateGrant({ ...base, grant, activeLegs: 1, requestedLegs: 2 }).allow).toBe(true);
    const denied = evaluateGrant({ ...base, grant, activeLegs: 1, requestedLegs: 3 });
    expect(denied.allow).toBe(false);
    if (!denied.allow) expect(denied.code).toBe("quota_exhausted");
  });

  test("bandwidth / connection dimensions are checked when the caller supplies usage", () => {
    const grant = grantRow({ capacity: { max_bandwidth_mbps: 100, max_connections: 10 } });
    expect(evaluateGrant({ ...base, grant, activeBandwidthMbps: 100, activeConnections: 10 }).allow).toBe(true);
    const bw = evaluateGrant({ ...base, grant, activeBandwidthMbps: 101 });
    expect(bw.allow).toBe(false);
    if (!bw.allow) expect(bw.code).toBe("quota_exhausted");
    const conns = evaluateGrant({ ...base, grant, activeConnections: 11 });
    expect(conns.allow).toBe(false);
    if (!conns.allow) expect(conns.code).toBe("quota_exhausted");
  });

  test("target policy whitelist is enforced only when a policy is requested", () => {
    expect(evaluateGrant({ ...base, requestedTargetPolicy: "pinned" }).allow).toBe(true);
    expect(evaluateGrant({ ...base, requestedTargetPolicy: null }).allow).toBe(true);
    const denied = evaluateGrant({ ...base, requestedTargetPolicy: "random" });
    expect(denied.allow).toBe(false);
    if (!denied.allow) expect(denied.code).toBe("grant_scope_violation");
  });

  test("malformed stored rows are reported as server-side problems, not caller problems", () => {
    const badScope = evaluateGrant({ ...base, grant: grantRow({ scope: { node_group_ids: [7], hop_roles: ["egress"], bogus: 1 } }) });
    expect(badScope.allow).toBe(false);
    if (!badScope.allow) expect(badScope.code).toBe("grant_scope_violation");

    const badCapacity = evaluateGrant({ ...base, grant: grantRow({ capacity: { max_legs: "three" } }) });
    expect(badCapacity.allow).toBe(false);
    if (!badCapacity.allow) expect(badCapacity.code).toBe("internal_error");

    const badStatus = evaluateGrant({ ...base, grant: grantRow({ status: "paused" }) });
    expect(badStatus.allow).toBe(false);
    if (!badStatus.allow) expect(badStatus.code).toBe("internal_error");

    const badExpiry = evaluateGrant({ ...base, grant: grantRow({ expires_at: new Date("nope") }) });
    expect(badExpiry.allow).toBe(false);
    if (!badExpiry.allow) expect(badExpiry.code).toBe("internal_error");
  });

  test("unknown hop role is a caller input problem", () => {
    const decision = evaluateGrant({ ...base, hopRole: "uplink" });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.code).toBe("message_malformed");
  });
});

/* ================================================================== */
/* epoch                                                               */
/* ================================================================== */

describe("WP15 grant: grant_epoch is monotonic and never reused", () => {
  test("epoch starts at 1 and always steps forward", () => {
    expect(nextGrantEpoch(null)).toBe(1);
    expect(nextGrantEpoch(undefined)).toBe(1);
    expect(nextGrantEpoch(1)).toBe(2);
    expect(nextGrantEpoch(41)).toBe(42);
  });

  test("a corrupted epoch refuses to roll forward instead of guessing", () => {
    expect(() => nextGrantEpoch(-1)).toThrow();
    expect(() => nextGrantEpoch(1.5)).toThrow();
  });
});

/* ================================================================== */
/* createGrant                                                         */
/* ================================================================== */

describe("WP15 grant: createGrant writes a row only after every check passes", () => {
  test("valid input creates an active epoch-1 grant and audits it", async () => {
    const { db, grants, calls } = makeGrantDb({ peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" } });
    const audit = captureAudit();
    const outcome = await createGrant(
      {
        peerPanelId: "panel-a",
        workspaceId: 3,
        scope: { node_group_ids: [7], hop_roles: ["egress"] },
        capacity: { max_legs: 2 },
        expiresAt: LATER,
        createdById: 1,
      },
      { db, audit: audit.sink, now: () => NOW },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.grant.grant_epoch).toBe(1);
    expect(outcome.grant.status).toBe("active");
    expect(grants).toHaveLength(1);
    expect(calls.grantCreate[0].scope).toEqual({ node_group_ids: [7], hop_roles: ["egress"], allow_target_policy: null });
    expect(audit.events.map((e) => e.action)).toEqual(["grant.create"]);
    expect(audit.events[0].detail?.grant_epoch).toBe(1);
  });

  test("malformed scope/capacity never reaches the database", async () => {
    const { db, calls } = makeGrantDb({ peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" } });
    const badScope = await createGrant({ peerPanelId: "panel-a", scope: { hop_roles: ["egress"], oops: 1 }, expiresAt: LATER }, { db, now: () => NOW });
    expect(badScope.ok).toBe(false);
    if (!badScope.ok) expect(badScope.code).toBe("grant_scope_violation");

    const badCapacity = await createGrant({ peerPanelId: "panel-a", scope: {}, capacity: { max_legs: -2 }, expiresAt: LATER }, { db, now: () => NOW });
    expect(badCapacity.ok).toBe(false);
    if (!badCapacity.ok) expect(badCapacity.code).toBe("message_malformed");

    expect(calls.grantCreate).toHaveLength(0);
  });

  test("an already-past expiry is refused (no 'born expired' grants)", async () => {
    const { db, calls } = makeGrantDb({ peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" } });
    const outcome = await createGrant({ peerPanelId: "panel-a", scope: {}, expiresAt: NOW }, { db, now: () => NOW });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("grant_expired");
    expect(calls.grantCreate).toHaveLength(0);
  });

  test("peer must be trusted; revoked peers are distinguishable from unknown ones", async () => {
    const pending = makeGrantDb({ peer: { id: 9, peer_panel_id: "panel-a", status: "pending" } });
    const pendingOutcome = await createGrant({ peerPanelId: "panel-a", scope: {}, expiresAt: LATER }, { db: pending.db, now: () => NOW });
    expect(pendingOutcome.ok).toBe(false);
    if (!pendingOutcome.ok) expect(pendingOutcome.code).toBe("peer_unknown");

    const revoked = makeGrantDb({ peer: { id: 9, peer_panel_id: "panel-a", status: "revoked" } });
    const revokedOutcome = await createGrant({ peerPanelId: "panel-a", scope: {}, expiresAt: LATER }, { db: revoked.db, now: () => NOW });
    expect(revokedOutcome.ok).toBe(false);
    if (!revokedOutcome.ok) expect(revokedOutcome.code).toBe("peer_revoked");

    const missing = makeGrantDb({ peer: null });
    const missingOutcome = await createGrant({ peerPanelId: "panel-a", scope: {}, expiresAt: LATER }, { db: missing.db, now: () => NOW });
    expect(missingOutcome.ok).toBe(false);
    if (!missingOutcome.ok) expect(missingOutcome.code).toBe("peer_unknown");
  });

  test("quota_reserved without a quota hook is refused: never claim a reservation that was not made", async () => {
    const { db, calls } = makeGrantDb({ peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" } });
    const outcome = await createGrant(
      { peerPanelId: "panel-a", scope: {}, expiresAt: LATER, quotaReserved: true },
      { db, now: () => NOW },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("internal_error");
    expect(calls.grantCreate).toHaveLength(0);
  });

  test("a wired quota hook is called on create, and rolled back when the insert fails", async () => {
    const { db } = makeGrantDb({ peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" } });
    const reserved: string[] = [];
    const released: string[] = [];
    const quota = {
      reserve: (i: any) => {
        reserved.push(i.grant_ref);
        return { ok: true };
      },
      release: (i: any) => {
        released.push(i.grant_ref);
        return { ok: true };
      },
    };

    const denied = { ...quota, reserve: () => ({ ok: false, message: "no room" }) };
    const deniedOutcome = await createGrant(
      { peerPanelId: "panel-a", scope: {}, expiresAt: LATER, quotaReserved: true },
      { db, now: () => NOW, quota: denied, audit: silentAudit },
    );
    expect(deniedOutcome.ok).toBe(false);
    if (!deniedOutcome.ok) expect(deniedOutcome.code).toBe("quota_exhausted");

    const okOutcome = await createGrant(
      { peerPanelId: "panel-a", scope: {}, expiresAt: LATER, quotaReserved: true },
      { db, now: () => NOW, quota, audit: silentAudit },
    );
    expect(okOutcome.ok).toBe(true);
    expect(reserved).toHaveLength(1);
    expect(released).toHaveLength(0);

    // 插入失败 → 预留必须归还（否则额度凭空少一块且无人引用）。
    const failing = { ...db, federationGrant: { ...db.federationGrant, create: async () => { throw new Error("db is down"); } } } as GrantDb;
    const failedOutcome = await createGrant(
      { peerPanelId: "panel-a", scope: {}, expiresAt: LATER, quotaReserved: true },
      { db: failing, now: () => NOW, quota, audit: silentAudit },
    );
    expect(failedOutcome.ok).toBe(false);
    if (!failedOutcome.ok) expect(failedOutcome.code).toBe("internal_error");
    expect(released).toHaveLength(1);
  });
});

/* ================================================================== */
/* revoke / suspend / resume / expire                                  */
/* ================================================================== */

describe("WP15 grant: revoke is irreversible, cascades teardown, and never lies about ports", () => {
  test("revoke bumps the epoch, stops every live lease and releases its port after teardown", async () => {
    const { db, grants, leases, calls } = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow()],
      leases: [leaseRow({ id: 11, state: "active" }), leaseRow({ id: 12, state: "reserved", lease_ref: "lease-2" }), leaseRow({ id: 13, state: "released", lease_ref: "lease-3" })],
    });
    const audit = captureAudit();
    const teardownCalls: number[] = [];
    const portCalls: string[] = [];

    const outcome = await revokeGrant(
      { grantRef: "grant-1", now: NOW },
      {
        db,
        audit: audit.sink,
        teardown: (i) => {
          teardownCalls.push(i.lease_epoch);
          return { ok: true };
        },
        releasePort: (i) => {
          portCalls.push(`${i.node_id}:${i.port}`);
          return { ok: true };
        },
      },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.grant_epoch).toBe(4);
    expect(outcome.leases_revoked).toBe(2);
    expect(outcome.teardown_ok).toBe(2);
    expect(outcome.teardown_failed).toBe(0);
    expect(outcome.ports_released).toBe(2);
    expect(outcome.ports_pending).toBe(0);
    expect(teardownCalls).toEqual([4, 4]);
    expect(portCalls).toEqual(["5:19001", "5:19001"]);
    expect(grants[0].status).toBe("revoked");
    // 终态行不被改写：历史事实保留。
    expect(leases.find((l) => l.id === 13)!.state).toBe("released");
    expect(leases.find((l) => l.id === 11)!.state).toBe("revoked");
    expect(leases.find((l) => l.id === 11)!.last_error_code).toBeNull();
    expect(audit.events.map((e) => e.action)).toEqual(["grant.revoke"]);
    expect(calls.leaseUpdateMany.length).toBeGreaterThan(0);
  });

  test("when teardown fails the lease is still revoked (fail-closed) and the port is NOT released", async () => {
    const { db, leases } = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow()],
      leases: [leaseRow({ id: 11, state: "active" })],
    });
    const portCalls: string[] = [];
    const outcome = await revokeGrant(
      { grantRef: "grant-1", now: NOW },
      {
        db,
        audit: silentAudit,
        teardown: () => ({ ok: false, message: "agent unreachable" }),
        releasePort: (i) => {
          portCalls.push(`${i.node_id}:${i.port}`);
          return { ok: true };
        },
      },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.teardown_failed).toBe(1);
    expect(outcome.ports_released).toBe(0);
    expect(outcome.ports_pending).toBe(1);
    expect(portCalls).toHaveLength(0);
    expect(leases[0].state).toBe("revoked");
    expect(leases[0].last_error_code).toBe("internal_error");
    expect(String(leases[0].last_error)).toContain("agent unreachable");
  });

  test("without a wired teardown hook the lease is revoked but flagged for reconcile", async () => {
    const { db, leases } = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow()],
      leases: [leaseRow({ id: 11, state: "active" })],
    });
    const outcome = await revokeGrant({ grantRef: "grant-1", now: NOW }, { db, audit: silentAudit, teardown: null });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.teardown_failed).toBe(1);
    expect(outcome.ports_pending).toBe(1);
    expect(leases[0].state).toBe("revoked");
    expect(String(leases[0].last_error)).toContain("not wired");
  });

  test("a repeated revoke is idempotent: same epoch, no extra teardown, still converges", async () => {
    const { db, grants, leases } = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow({ status: "revoked", grant_epoch: 4 })],
      leases: [leaseRow({ id: 11, state: "active" })],
    });
    const teardowns: string[] = [];
    const outcome = await revokeGrant(
      { grantRef: "grant-1", now: NOW },
      { db, audit: silentAudit, teardown: (i) => { teardowns.push(i.lease_ref); return { ok: true }; } },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.already_revoked).toBe(true);
    expect(outcome.grant_epoch).toBe(4);
    expect(outcome.leases_revoked).toBe(1);
    expect(teardowns).toEqual(["lease-1"]);
    expect(grants[0].grant_epoch).toBe(4);
    expect(leases[0].state).toBe("revoked");
  });

  test("unknown grant is a 404-class code, and a lost CAS is reported instead of silently winning", async () => {
    const none = makeGrantDb({ peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" } });
    const missing = await revokeGrant({ grantRef: "nope", now: NOW }, { db: none.db, audit: silentAudit });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("grant_not_found");

    const noKey = await revokeGrant({ now: NOW }, { db: none.db, audit: silentAudit });
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.code).toBe("grant_not_found");

    const { db } = makeGrantDb({ peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" }, grants: [grantRow()] });
    const frozen = { ...db, federationGrant: { ...db.federationGrant, updateMany: async () => ({ count: 0 }) } } as GrantDb;
    const raced = await revokeGrant({ grantRef: "grant-1", now: NOW }, { db: frozen, audit: silentAudit });
    expect(raced.ok).toBe(false);
    if (!raced.ok) expect(raced.code).toBe("internal_error");
  });

  test("revoking a quota_reserved grant returns the reservation", async () => {
    const { db } = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow({ quota_reserved: true })],
    });
    const released: string[] = [];
    const outcome = await revokeGrant(
      { grantRef: "grant-1", now: NOW },
      { db, audit: silentAudit, quota: { reserve: () => ({ ok: true }), release: (i) => { released.push(i.grant_ref); return { ok: true }; } } },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.quota_released).toBe(true);
    expect(released).toEqual(["grant-1"]);
  });
});

describe("WP15 grant: suspend only blocks new intents (existing leases keep running)", () => {
  test("suspend bumps the epoch, audits, and leaves leases untouched", async () => {
    const { db, grants, leases, calls } = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow()],
      leases: [leaseRow({ id: 11, state: "active" })],
    });
    const audit = captureAudit();
    const outcome = await suspendGrant({ grantRef: "grant-1", now: NOW }, { db, audit: audit.sink });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.already_suspended).toBe(false);
    expect(outcome.grant_epoch).toBe(4);
    expect(grants[0].status).toBe("suspended");
    expect(leases[0].state).toBe("active"); // 挂起不停服：那是 revoke 的语义
    expect(calls.leaseUpdateMany).toHaveLength(0);
    expect(audit.events.map((e) => e.action)).toEqual(["grant.suspend"]);
  });

  test("a repeated suspend is a no-op that does NOT advance the epoch", async () => {
    const { db, grants } = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow({ status: "suspended", grant_epoch: 7 })],
    });
    const outcome = await suspendGrant({ grantRef: "grant-1", now: NOW }, { db, audit: silentAudit });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.already_suspended).toBe(true);
    expect(outcome.grant_epoch).toBe(7);
    expect(grants[0].grant_epoch).toBe(7);
  });

  test("a revoked grant cannot be suspended, and the suspension can be lifted", async () => {
    const revokedFixture = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow({ status: "revoked" })],
    });
    const revoked = await suspendGrant({ grantRef: "grant-1", now: NOW }, { db: revokedFixture.db, audit: silentAudit });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.code).toBe("grant_not_active");

    const { db, grants } = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow({ status: "suspended" })],
    });
    const resumed = await resumeGrant({ grantRef: "grant-1" }, { db, now: () => NOW, audit: silentAudit });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.grant_epoch).toBe(4);
    expect(grants[0].status).toBe("active");
  });

  test("resume refuses to smuggle a past-expiry grant back to life", async () => {
    const { db } = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow({ status: "suspended", expires_at: NOW })],
    });
    const outcome = await resumeGrant({ grantRef: "grant-1" }, { db, now: () => LATER, audit: silentAudit });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("grant_expired");
  });
});

describe("WP15 grant: expiry sweep returns reserved quota and stays out of the winner's way", () => {
  test("only grants past expires_at flip to expired", async () => {
    const { db, grants } = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [
        grantRow({ id: 1, grant_ref: "g1", expires_at: NOW }),
        grantRow({ id: 2, grant_ref: "g2", expires_at: LATER }),
      ],
    });
    const audit = captureAudit();
    const result = await expireGrants({ now: NOW }, { db, audit: audit.sink });
    expect(result.evaluated).toBe(1);
    expect(result.expired).toBe(1);
    expect(grants.find((g) => g.id === 1)!.status).toBe("expired");
    expect(grants.find((g) => g.id === 1)!.grant_epoch).toBe(4);
    expect(grants.find((g) => g.id === 2)!.status).toBe("active");
    expect(audit.events.map((e) => e.action)).toEqual(["grant.expire"]);
  });

  test("expiry returns the reservation, and a lost CAS leaves the row to the concurrent winner", async () => {
    const { db } = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow({ id: 1, grant_ref: "g1", quota_reserved: true, expires_at: NOW })],
    });
    const released: string[] = [];
    const result = await expireGrants(
      { now: NOW },
      { db, audit: silentAudit, quota: { reserve: () => ({ ok: true }), release: (i) => { released.push(i.grant_ref); return { ok: true }; } } },
    );
    expect(result.expired).toBe(1);
    expect(result.quota_returned).toBe(1);
    expect(released).toEqual(["g1"]);

    // 用**新**夹具：上一轮已经把 g1 收口成 expired，同一个 db 再扫就扫不到了（那才是对的）。
    const fresh = makeGrantDb({
      peer: { id: 9, peer_panel_id: "panel-a", status: "trusted" },
      grants: [grantRow({ id: 1, grant_ref: "g1", quota_reserved: true, expires_at: NOW })],
    });
    const raced = { ...fresh.db, federationGrant: { ...fresh.db.federationGrant, updateMany: async () => ({ count: 0 }) } } as GrantDb;
    const racedResult = await expireGrants(
      { now: NOW },
      { db: raced, audit: silentAudit, quota: { reserve: () => ({ ok: true }), release: () => ({ ok: true }) } },
    );
    expect(racedResult.expired).toBe(0);
    expect(racedResult.evaluated).toBe(1);
  });
});
