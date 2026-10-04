/**
 * V5.5 WP15 —— host 侧远端租约的离线断言（bun:test，无 DB / 无网络）。
 *
 * 这里钉住四件事，每一件的错误方向都是"留下不该留的东西"：
 *   1. **状态机**：非法迁移必须报错，终态是吸收态（历史事实不可重写）；
 *   2. **幂等**：`(intent_id, revision, action)` 重投递返回首次结果，绝不第二次分配端口；
 *   3. **补偿**：任何一步失败都不许留下已分配的资源（G4 的教训，§3.3）；
 *   4. **顺序**：先停服、后还端口；停不下来就不还（这才是 fail-closed）。
 *
 * DB / 端口池 / 停服通道全部走注入替身（`LeaseHostDeps`），所以跑起来不碰 MySQL、不碰 Redis、
 * 更不碰 agent。
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_LEASE_TTL_SECONDS,
  renewalWindowIndex,
  applyRemoteLease,
  renewRemoteLease,
  sweepRevokedLeaseCleanup,
  EXPIRE_BATCH_LIMIT,
  LEASE_INTENT_PENDING_TTL_MS,
  LEASE_RECONCILE_TICK_SECONDS,
  LEASE_TRANSITIONS,
  assertLeaseTransition,
  canTransitionLease,
  claimLeaseIntent,
  evaluateLeaseRenewal,
  expireLeases,
  mapPortAllocationFailure,
  planLeaseApply,
  releaseRemoteLease,
  reserveRemoteLease,
  settleLeaseIntent,
  validateLeaseIntent,
  type FederationLeaseRow,
  type LeaseDb,
  type LeaseHostDeps,
} from "../federation/lease.ts";
import { PORT_RELEASE_PENDING_CODE, nextLeaseEpoch, type FederationAuditSink } from "../federation/grant.ts";
import { resetOrchestrator, setOrchestrator } from "../relay-wiring.ts";
import type { Orchestrator } from "../orchestrator.ts";
import {
  MAX_PLACEMENT_PROBES_PER_TICK,
  mapRemoteLeaseStateToPlacement,
  parseRemoteLeaseFact,
  planPlacementSync as planSync,
  planPlacementSync,
  reconcilePlacements,
  recordPlacementResult,
  upsertPlacement,
  type FederationPlacementRow,
  type PlacementDb,
} from "../federation/placement.ts";

/* ------------------------------------------------------------------ */
/* 夹具与内存替身                                                       */
/* ------------------------------------------------------------------ */

/**
 * 夹具行类型。测试替身只需要"能塞进注入接缝"，不需要复刻 Prisma 的投影类型；
 * 真正的类型安全由被测模块的签名保证（夹具塞错字段会在断言里立刻暴露）。
 */
type Row = any;

const NOW = new Date("2026-10-05T04:00:00Z");
const LATER = new Date("2026-10-05T06:00:00Z");
const GOOD_UNTIL = new Date("2026-10-05T05:00:00Z");

const silentAudit: FederationAuditSink = () => {};

function uniqueConflict(): Error {
  const e = new Error("unique constraint");
  (e as any).code = "P2002";
  return e;
}

function grantRow(over: Row = {}): Row {
  return {
    id: 1,
    grant_ref: "grant-1",
    peer_panel_id: "panel-a",
    workspace_id: null,
    grant_epoch: 2,
    status: "active",
    scope: { node_group_ids: [7], hop_roles: ["ingress", "egress", "transit"], allow_target_policy: null },
    capacity: { max_legs: 3, max_bandwidth_mbps: null, max_connections: null },
    expires_at: GOOD_UNTIL,
    ...over,
  };
}

function nodeRow(over: Row = {}): Row {
  return { id: 5, node_id: "host-node-5", connect_ip: "10.9.0.5", role: "egress", node_group_id: 7, ...over };
}

function leaseGrantRow(over: Row = {}): Row {
  return {
    id: 1,
    grant_ref: "grant-1",
    peer_panel_id: "panel-a",
    workspace_id: null,
    grant_epoch: 2,
    status: "active",
    scope: { node_group_ids: [7], hop_roles: ["ingress", "egress", "transit"], allow_target_policy: null },
    capacity: { max_legs: 3, max_bandwidth_mbps: null, max_connections: null },
    expires_at: GOOD_UNTIL,
    ...over,
  };
}

function leaseRow(over: Row = {}): FederationLeaseRow {
  return {
    id: 11,
    lease_ref: "lease-1",
    grant_id: 1,
    peer_panel_id: "panel-a",
    forward_ref: "fwd-1",
    intent_id: "intent-1",
    state: "reserved",
    lease_epoch: 4,
    hop_role: "egress",
    node_id: 5,
    listen_port: 19001,
    requested_revision: 7,
    applied_revision: null,
    last_error_code: null,
    last_error: null,
    expires_at: GOOD_UNTIL,
    applied_at: null,
    released_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function makeLeaseDb(fx: { leases?: Row[]; intents?: Row[]; nodes?: Row[]; grants?: Row[]; now?: () => Date } = {}) {
  const leases: Row[] = (fx.leases ?? []).map((l) => ({ ...l }));
  const intents: Row[] = (fx.intents ?? []).map((i) => ({ ...i }));
  const calls = {
    dispatch: [] as Row[],
    allocate: [] as Row[],
    releasePort: [] as Row[],
    teardown: [] as Row[],
    leaseCreate: [] as Row[],
    leaseUpdateMany: [] as Row[],
    intentCreate: [] as Row[],
    intentUpdate: [] as Row[],
  };

  function matchLease(l: Row, w: Row): boolean {
    if (w.id !== undefined && l.id !== w.id) return false;
    if (w.lease_epoch !== undefined && l.lease_epoch !== w.lease_epoch) return false;
    if (typeof w.state === "string" && l.state !== w.state) return false;
    if (w.state?.in !== undefined && !w.state.in.includes(l.state)) return false;
    if (w.intent_id !== undefined && l.intent_id !== w.intent_id) return false;
    if (w.peer_panel_id !== undefined && l.peer_panel_id !== w.peer_panel_id) return false;
    if (w.forward_ref !== undefined && l.forward_ref !== w.forward_ref) return false;
    if (w.hop_role !== undefined && l.hop_role !== w.hop_role) return false;
    if (w.expires_at?.lte !== undefined && l.expires_at.getTime() > w.expires_at.lte.getTime()) return false;
    if (w.last_error_code?.in !== undefined && !w.last_error_code.in.includes(l.last_error_code)) return false;
    if (w.applied_revision !== undefined && (l.applied_revision ?? null) !== w.applied_revision) return false;
    return true;
  }

  const db: LeaseDb = {
    federationLease: {
      async findFirst(args: any) {
        const rows = leases.filter((l) => matchLease(l, args.where ?? {}));
        if (rows.length === 0) return null;
        // orderBy 只被用来拿"谱系里最新的 epoch"，替身按 lease_epoch 复刻这一点。
        rows.sort((a, b) => b.lease_epoch - a.lease_epoch);
        return { ...rows[0] };
      },
      async findUnique(args: any) {
        const w = args.where ?? {};
        const row = leases.find((l) => (w.id !== undefined ? l.id === w.id : l.lease_ref === w.lease_ref));
        return row ? { ...row } : null;
      },
      async findMany(args: any) {
        const w = args.where ?? {};
        const rows = leases.filter((l) => matchLease(l, w)).map((l) => ({ ...l }));
        return typeof args.take === "number" ? rows.slice(0, args.take) : rows;
      },
      async create(args: any) {
        calls.leaseCreate.push(args.data);
        const row: Row = { id: 100 + leases.length, ...args.data };
        leases.push(row);
        return { ...row };
      },
      async updateMany(args: any) {
        calls.leaseUpdateMany.push(args);
        const w = args.where ?? {};
        let count = 0;
        for (const l of leases) {
          if (!matchLease(l, w)) continue;
          Object.assign(l, args.data);
          count++;
        }
        return { count };
      },
      async count(args: any) {
        const w = args.where ?? {};
        return leases.filter((l) => matchLease(l, w)).length;
      },
    },
    node: {
      async findUnique(args: any) {
        const row = (fx.nodes ?? []).find((n) => n.id === args.where?.id);
        return row ? { ...row } : null;
      },
    },
    federationGrant: {
      async findUnique(args: any) {
        const row = (fx.grants ?? []).find((g) => g.id === args.where?.id);
        return row ? { ...row } : null;
      },
    },
    federationIntent: {
      async findUnique(args: any) {
        const k = args.where?.intent_id_revision_action;
        const row = intents.find((i) => i.intent_id === k.intent_id && i.revision === k.revision && i.action === k.action);
        return row ? { ...row } : null;
      },
      async create(args: any) {
        const d = args.data;
        if (intents.some((i) => i.intent_id === d.intent_id && i.revision === d.revision && i.action === d.action)) {
          throw uniqueConflict();
        }
        calls.intentCreate.push(d);
        const row: Row = {
          id: 1 + intents.length,
          lease_id: null,
          error_code: null,
          created_at: (fx.now ?? (() => NOW))(),
          ...d,
        };
        intents.push(row);
        return { ...row };
      },
      async update(args: any) {
        const k = args.where?.intent_id_revision_action;
        const row = intents.find((i) => i.intent_id === k.intent_id && i.revision === k.revision && i.action === k.action);
        if (!row) // Prisma 抛 P2025；替身只需让调用方的 catch 生效。
          throw Object.assign(new Error("not found"), { code: "P2025" });
        calls.intentUpdate.push(args.data);
        Object.assign(row, args.data);
        return { ...row };
      },
    },
  };

  return { db, leases, intents, calls };
}

function intent(over: Row = {}): Row {
  return {
    intent_id: "intent-1",
    revision: 7,
    hop_role: "egress",
    forward_ref: "fwd-1",
    requested: { node_ref: null, port: null, lb: null },
    ...over,
  };
}

/** 默认全套钩子：分配成功、停服成功、还端口成功，并记录调用。 */
function hooks(calls: { dispatch: Row[]; allocate: Row[]; releasePort: Row[]; teardown: Row[] }, over: LeaseHostDeps = {}): LeaseHostDeps {
  return {
    audit: silentAudit,
    dispatch: (i) => {
      calls.dispatch.push(i as unknown as Row);
      return { ok: true };
    },
    allocatePort: (i: Row) => {
      calls.allocate.push(i);
      return { ok: true, port: 19001, port_lease_id: 77 };
    },
    releasePort: (i: Row) => {
      calls.releasePort.push(i);
      return { ok: true };
    },
    teardown: (i: Row) => {
      calls.teardown.push(i);
      return { ok: true };
    },
    ...over,
  };
}

function applyFixture(over: Row = {}, leaseOver: Row = {}) {
  const made = makeLeaseDb({
    nodes: [nodeRow()],
    grants: [leaseGrantRow()],
    leases: [leaseRow({ state: "reserved", applied_revision: null, ...leaseOver })],
  });
  const events: Row[] = [];
  const out = {
    ...made,
    events,
    deps: {
      ...hooks(made.calls),
      db: made.db,
      audit: (e: Row) => {
        events.push(e);
      },
    },
    input: {
      lease_ref: "lease-1",
      intent_id: "intent-1",
      revision: 7,
      targets: [{ host: "203.0.113.9", port: 443 }],
      lb_strategy: "ROUND_ROBIN",
      protocol: "tcp",
      ...over,
    },
  };
  return out;
}


function reserveInput(over: Row = {}) {
  return {
    intent: intent(),
    grant: grantRow(),
    workspaceId: null,
    resolvedNodeId: 5,
    resolvedNodeGroupId: 7,
    appliedRevision: null,
    previousEpoch: 3,
    ...over,
  };
}

/* ================================================================== */
/* 状态机                                                              */
/* ================================================================== */

describe("WP15 lease: the transition matrix rejects illegal moves instead of writing them", () => {
  test("the documented happy paths are allowed", () => {
    expect(canTransitionLease("reserved", "active")).toBe(true);
    expect(canTransitionLease("active", "releasing")).toBe(true);
    expect(canTransitionLease("releasing", "released")).toBe(true);
    expect(canTransitionLease("active", "revoked")).toBe(true);
    expect(canTransitionLease("active", "expired")).toBe(true);
    // failed 可以回到补偿路径（那是重试的正路）
    expect(canTransitionLease("failed", "releasing")).toBe(true);
    expect(canTransitionLease("releasing", "failed")).toBe(true);
  });

  test("terminal states are absorbing: history is never rewritten", () => {
    for (const terminal of ["released", "expired", "revoked"] as const) {
      expect(LEASE_TRANSITIONS[terminal]).toEqual([]);
      for (const to of Object.keys(LEASE_TRANSITIONS)) {
        expect(canTransitionLease(terminal, to)).toBe(false);
      }
    }
  });

  test("a release can never skip teardown (no direct -> released)", () => {
    expect(canTransitionLease("active", "released")).toBe(false);
    expect(canTransitionLease("reserved", "released")).toBe(false);
  });

  test("assertLeaseTransition reports the move instead of silently writing", () => {
    const ok = assertLeaseTransition("active", "releasing");
    expect(ok.ok).toBe(true);

    const illegal = assertLeaseTransition("released", "active");
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) {
      expect(illegal.code).toBe("internal_error");
      expect(illegal.message).toContain("released -> active");
    }

    const unknown = assertLeaseTransition("zombie", "active");
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain("unknown lease state");
  });
});

/* ================================================================== */
/* planLeaseApply（纯计划）                                             */
/* ================================================================== */

describe("WP15 lease: planLeaseApply produces the allocation + dispatch plan", () => {
  test("an egress intent plans a port allocation, an epoch bump and one ACKed dispatch", () => {
    const outcome = planLeaseApply({
      intent: intent(),
      grant: grantRow(),
      workspaceId: null,
      activeLegs: 1,
      appliedRevision: 6,
      resolvedNodeId: 5,
      resolvedNodeGroupId: 7,
      previousEpoch: 3,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.hop_role).toBe("egress");
    expect(outcome.plan.lease_epoch).toBe(4);
    expect(outcome.plan.allocate).toEqual({ node_id: 5, node_group_id: 7, requested_port: null, needs_node: false });
    expect(outcome.plan.dispatch).toEqual([{ action: "dispatch_egress", await_ack: true }]);
    expect(outcome.plan.expires_at.getTime()).toBe(NOW.getTime() + DEFAULT_LEASE_TTL_SECONDS * 1000);
  });

  test("hop roles map to their own dispatch action", () => {
    for (const [role, action] of [["ingress", "dispatch_ingress"], ["transit", "dispatch_transit"]] as const) {
      const outcome = planLeaseApply({
        intent: intent({ hop_role: role }),
        grant: grantRow(),
        workspaceId: null,
        activeLegs: 0,
        appliedRevision: null,
        resolvedNodeId: 5,
        resolvedNodeGroupId: 7,
        previousEpoch: null,
        now: NOW,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.plan.dispatch[0].action).toBe(action);
    }
  });

  test("a lease never outlives its grant", () => {
    const outcome = planLeaseApply({
      intent: intent(),
      grant: grantRow({ expires_at: new Date(NOW.getTime() + 30_000) }),
      workspaceId: null,
      activeLegs: 0,
      appliedRevision: null,
      resolvedNodeId: 5,
      resolvedNodeGroupId: 7,
      previousEpoch: null,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.plan.expires_at.getTime()).toBe(NOW.getTime() + 30_000);
  });

  test("stale revisions are refused and replays are named as such", () => {
    const stale = planLeaseApply({
      intent: intent({ revision: 6 }),
      grant: grantRow(),
      workspaceId: null,
      activeLegs: 0,
      appliedRevision: 7,
      resolvedNodeId: 5,
      resolvedNodeGroupId: 7,
      previousEpoch: null,
      now: NOW,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("intent_revision_stale");

    const replay = planLeaseApply({
      intent: intent({ revision: 7 }),
      grant: grantRow(),
      workspaceId: null,
      activeLegs: 0,
      appliedRevision: 7,
      resolvedNodeId: 5,
      resolvedNodeGroupId: 7,
      previousEpoch: null,
      now: NOW,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe("duplicate_message");
  });

  test("grant decisions are inherited verbatim (suspended, quota, scope, target policy)", () => {
    const base = {
      intent: intent(),
      workspaceId: null,
      activeLegs: 0,
      appliedRevision: null,
      resolvedNodeId: 5,
      resolvedNodeGroupId: 7,
      previousEpoch: null,
      now: NOW,
    };
    const suspended = planLeaseApply({ ...base, grant: grantRow({ status: "suspended" }) });
    expect(suspended.ok).toBe(false);
    if (!suspended.ok) expect(suspended.code).toBe("grant_not_active");

    const full = planLeaseApply({ ...base, grant: grantRow({ capacity: { max_legs: 1 } }), activeLegs: 1 });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.code).toBe("quota_exhausted");

    const wrongGroup = planLeaseApply({ ...base, grant: grantRow() });
    expect(wrongGroup.ok).toBe(true);
    const outOfScope = planLeaseApply({ ...base, grant: grantRow(), resolvedNodeGroupId: 8 });
    expect(outOfScope.ok).toBe(false);
    if (!outOfScope.ok) expect(outOfScope.code).toBe("grant_scope_violation");

    const policy = planLeaseApply({
      ...base,
      grant: grantRow({ scope: { node_group_ids: [7], hop_roles: ["egress"], allow_target_policy: ["pinned"] } }),
      intent: intent({ requested: { target_policy: "random" } }),
    });
    expect(policy.ok).toBe(false);
    if (!policy.ok) expect(policy.code).toBe("grant_scope_violation");
  });

  test("an unresolvable node_ref fails closed instead of picking some node", () => {
    const outcome = planLeaseApply({
      intent: intent({ requested: { node_ref: "peer-node-9" } }),
      grant: grantRow(),
      workspaceId: null,
      activeLegs: 0,
      appliedRevision: null,
      resolvedNodeId: null,
      resolvedNodeGroupId: 7,
      previousEpoch: null,
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("grant_scope_violation");
  });

  test("an unresolved node is a plan that still needs node selection, not an error", () => {
    const outcome = planLeaseApply({
      intent: intent({ requested: { node_group_id: 7, port: 19001 } }),
      grant: grantRow(),
      workspaceId: null,
      activeLegs: 0,
      appliedRevision: null,
      resolvedNodeId: null,
      resolvedNodeGroupId: 7,
      previousEpoch: 2,
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.allocate.needs_node).toBe(true);
    expect(outcome.plan.allocate.requested_port).toBe(19001);
    expect(outcome.plan.lease_epoch).toBe(3);
  });

  test("malformed intents are rejected before anything is planned", () => {
    expect(validateLeaseIntent(intent({ intent_id: "" })).ok).toBe(false);
    expect(validateLeaseIntent(intent({ forward_ref: "" })).ok).toBe(false);
    expect(validateLeaseIntent(intent({ revision: -1 })).ok).toBe(false);
    expect(validateLeaseIntent(intent({ hop_role: "uplink" })).ok).toBe(false);
    expect(validateLeaseIntent(intent({ requested: { port: 70000 } })).ok).toBe(false);
    expect(validateLeaseIntent(intent({ requested: { node_group_id: 0 } })).ok).toBe(false);
    expect(validateLeaseIntent(intent()).ok).toBe(true);
  });
});

/* ================================================================== */
/* 续约（Lead 的硬要求：挂起期间到期不再续）                              */
/* ================================================================== */

describe("WP15 lease: renewal follows the grant, so 'suspended' cannot become 'running forever'", () => {
  const base = {
    hopRole: "egress",
    nodeGroupId: 7,
    workspaceId: null,
    activeLegs: 1,
    now: NOW,
  };

  test("an active grant renews even when the leg budget is exactly full", () => {
    const decision = evaluateLeaseRenewal({ ...base, grant: grantRow({ capacity: { max_legs: 1 } }), activeLegs: 1 });
    expect(decision.allow).toBe(true);
  });

  test("suspended / revoked / expired grants never renew (the lease must be allowed to die)", () => {
    const suspended = evaluateLeaseRenewal({ ...base, grant: grantRow({ status: "suspended" }) });
    expect(suspended.allow).toBe(false);
    if (!suspended.allow) expect(suspended.code).toBe("grant_not_active");

    const revoked = evaluateLeaseRenewal({ ...base, grant: grantRow({ status: "revoked" }) });
    expect(revoked.allow).toBe(false);
    if (!revoked.allow) expect(revoked.code).toBe("grant_not_active");

    const expired = evaluateLeaseRenewal({ ...base, grant: grantRow({ expires_at: NOW }) });
    expect(expired.allow).toBe(false);
    if (!expired.allow) expect(expired.code).toBe("grant_expired");
  });
});

/* ================================================================== */
/* 端口失败映射                                                        */
/* ================================================================== */

describe("WP15 lease: port failures are translated into the contract's closed error set", () => {
  test("capacity-with-no-port is retryable-ish quota_exhausted, not a 500", () => {
    expect(mapPortAllocationFailure("no_available_port")).toBe("quota_exhausted");
    expect(mapPortAllocationFailure("port_taken")).toBe("quota_exhausted");
    expect(mapPortAllocationFailure("port_blacklisted")).toBe("quota_exhausted");
  });

  test("caller mistakes and host misconfiguration are separated", () => {
    expect(mapPortAllocationFailure("port_out_of_range")).toBe("message_malformed");
    expect(mapPortAllocationFailure("port_outside_node_range")).toBe("grant_scope_violation");
    expect(mapPortAllocationFailure("node_not_found")).toBe("internal_error");
    expect(mapPortAllocationFailure("node_range_unset")).toBe("internal_error");
    expect(mapPortAllocationFailure("something_new")).toBe("internal_error");
  });
});

/* ================================================================== */
/* 幂等占位                                                            */
/* ================================================================== */

describe("WP15 lease: the idempotency key is claimed in the database, not checked in a comment", () => {
  test("first claim wins, a fresh in-flight claim is reported, and done stays done", async () => {
    const { db } = makeLeaseDb();
    const arg = { intent_id: "intent-1", peer_panel_id: "panel-a", revision: 7, action: "create" as const, now: NOW };

    const first = await claimLeaseIntent(db, arg);
    expect(first.kind).toBe("claimed");

    const second = await claimLeaseIntent(db, arg);
    expect(second.kind).toBe("in_flight");

    await settleLeaseIntent(db, { intent_id: "intent-1", revision: 7, action: "create", status: "ok", lease_id: 11 });
    const third = await claimLeaseIntent(db, arg);
    expect(third.kind).toBe("done");
    if (third.kind === "done") expect(third.row.lease_id).toBe(11);
  });

  test("a failed attempt is retryable (takeover), and an abandoned pending claim expires", async () => {
    const { db } = makeLeaseDb();
    const arg = { intent_id: "intent-1", peer_panel_id: "panel-a", revision: 7, action: "create" as const, now: NOW };

    await claimLeaseIntent(db, arg);
    await settleLeaseIntent(db, { intent_id: "intent-1", revision: 7, action: "create", status: "failed", error_code: "quota_exhausted" });
    const retry = await claimLeaseIntent(db, arg);
    expect(retry.kind).toBe("claimed");

    const stale = new Date(NOW.getTime() + LEASE_INTENT_PENDING_TTL_MS + 1);
    const abandoned = await claimLeaseIntent(db, { ...arg, now: stale });
    expect(abandoned.kind).toBe("claimed");
  });

  test("a different intent / revision / action is a different key", async () => {
    const { db } = makeLeaseDb();
    const base = { peer_panel_id: "panel-a", now: NOW };
    expect((await claimLeaseIntent(db, { ...base, intent_id: "i1", revision: 1, action: "create" })).kind).toBe("claimed");
    expect((await claimLeaseIntent(db, { ...base, intent_id: "i1", revision: 2, action: "create" })).kind).toBe("claimed");
    expect((await claimLeaseIntent(db, { ...base, intent_id: "i1", revision: 1, action: "apply" })).kind).toBe("claimed");
    expect((await claimLeaseIntent(db, { ...base, intent_id: "i2", revision: 1, action: "create" })).kind).toBe("claimed");
  });
});

/* ================================================================== */
/* 预留（阶段 1）                                                       */
/* ================================================================== */

describe("WP15 lease: reserve allocates exactly once and compensates on failure", () => {
  test("the happy path allocates a port, writes a reserved row at the next epoch, and audits", async () => {
    const { db, leases, calls } = makeLeaseDb();
    const events: Row[] = [];
    const outcome = await reserveRemoteLease(reserveInput(), {
      ...hooks(calls),
      db,
      audit: (e: Row) => {
        events.push(e);
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(calls.allocate).toHaveLength(1);
    expect(outcome.port).toBe(19001);
    expect(outcome.lease_epoch).toBe(4);
    expect(outcome.lease.state).toBe("reserved");
    expect(outcome.plan?.dispatch[0].action).toBe("dispatch_egress");
    expect(leases).toHaveLength(1);
    expect(leases[0].requested_revision).toBe(7);
    expect(events.map((e) => e.action)).toEqual(["lease.reserve"]);
  });

  test("a replayed (intent_id, revision) returns the FIRST result and never allocates again", async () => {
    const { db, calls } = makeLeaseDb();
    const deps = { ...hooks(calls), db };
    const first = await reserveRemoteLease(reserveInput(), deps);
    const second = await reserveRemoteLease(reserveInput(), deps);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.lease.lease_ref).toBe(first.lease.lease_ref);
    expect(second.port).toBe(first.port);
    expect(second.plan).toBeNull();
    expect(calls.allocate).toHaveLength(1);
  });

  test("a concurrent in-flight claim is refused with duplicate_message (no second allocation)", async () => {
    const { db, calls } = makeLeaseDb({
      intents: [
        { id: 1, intent_id: "intent-1", peer_panel_id: "panel-a", revision: 7, action: "create", status: "pending", lease_id: null, error_code: null, created_at: NOW },
      ],
    });
    const outcome = await reserveRemoteLease(reserveInput(), { ...hooks(calls), db });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("duplicate_message");
    expect(calls.allocate).toHaveLength(0);
    expect(calls.leaseCreate).toHaveLength(0);
  });

  test("the grant decision runs before allocation: a denied intent spends nothing", async () => {
    const { db, calls, intents } = makeLeaseDb();
    const outcome = await reserveRemoteLease(reserveInput({ grant: grantRow({ status: "suspended" }) }), { ...hooks(calls), db });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("grant_not_active");
    expect(calls.allocate).toHaveLength(0);
    // 失败也留痕：决策不留痕的机制与从未运行过的机制无法区分（§8 教训）。
    expect(intents[0].status).toBe("failed");
    expect(intents[0].error_code).toBe("grant_not_active");
  });

  test("an unresolved node cannot be reserved (host must resolve one inside the grant scope)", async () => {
    const { db, calls } = makeLeaseDb();
    const outcome = await reserveRemoteLease(reserveInput({ resolvedNodeId: null, resolvedNodeGroupId: 7 }), { ...hooks(calls), db });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("grant_scope_violation");
    expect(calls.allocate).toHaveLength(0);
    expect(calls.leaseCreate).toHaveLength(0);
  });

  test("port exhaustion maps to quota_exhausted and leaves nothing behind", async () => {
    const { db, calls, leases } = makeLeaseDb();
    const outcome = await reserveRemoteLease(
      reserveInput(),
      { ...hooks(calls, { allocatePort: () => ({ ok: false, code: "no_available_port" }) }), db },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("quota_exhausted");
    expect(leases).toHaveLength(0);
    expect(calls.releasePort).toHaveLength(0);
  });

  test("if the lease row cannot be written, the allocated port is released immediately", async () => {
    const { db, calls } = makeLeaseDb();
    const failing = {
      ...db,
      federationLease: {
        ...db.federationLease,
        create: async () => {
          throw new Error("insert failed");
        },
      },
    } as LeaseDb;
    const outcome = await reserveRemoteLease(reserveInput(), { ...hooks(calls), db: failing });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("internal_error");
    expect(calls.allocate).toHaveLength(1);
    expect(calls.releasePort).toEqual([{ node_id: 5, port: 19001 }]);
  });

  test("after a compensated failure the same (intent_id, revision) can be retried", async () => {
    const { db, calls } = makeLeaseDb();
    let failing = true;
    const flaky = {
      ...db,
      federationLease: {
        ...db.federationLease,
        create: async (args: any) => {
          if (failing) throw new Error("insert failed");
          return db.federationLease.create(args);
        },
      },
    } as LeaseDb;

    const first = await reserveRemoteLease(reserveInput(), { ...hooks(calls), db: flaky });
    expect(first.ok).toBe(false);
    failing = false;
    const second = await reserveRemoteLease(reserveInput(), { ...hooks(calls), db: flaky });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.replayed).toBe(false);
    expect(calls.allocate).toHaveLength(2); // 第二次是真正的重试（首次的端口已归还）
    expect(calls.releasePort).toHaveLength(1);
  });
});

/* ================================================================== */
/* 释放                                                                */
/* ================================================================== */

describe("WP15 lease: release stops first, frees the port second, and is idempotent", () => {
  test("a reserved lease walks reserved -> releasing -> released and returns its port", async () => {
    const { db, leases, calls } = makeLeaseDb({ leases: [leaseRow({ state: "reserved" })] });
    const events: Row[] = [];
    const outcome = await releaseRemoteLease(
      { intent_id: "intent-1", revision: 7 },
      {
        ...hooks(calls),
        db,
        audit: (e: Row) => {
          events.push(e);
        },
      },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe("released");
    expect(outcome.port_released).toBe(true);
    expect(calls.teardown).toHaveLength(1);
    expect(calls.teardown[0].reason).toBe("released");
    expect(calls.releasePort).toEqual([{ node_id: 5, port: 19001 }]);
    expect(leases[0].state).toBe("released");
    expect(events.map((e) => e.action)).toEqual(["lease.release"]);
  });

  test("teardown failure keeps the port (it may still be listening) and asks for a retry", async () => {
    const { db, leases, calls } = makeLeaseDb({ leases: [leaseRow({ state: "active" })] });
    const outcome = await releaseRemoteLease(
      { intent_id: "intent-1", revision: 7 },
      { ...hooks(calls, { teardown: () => ({ ok: false, message: "agent unreachable" }) }), db },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("internal_error");
    expect(calls.releasePort).toHaveLength(0);
    expect(leases[0].state).toBe("failed");
    expect(leases[0].last_error_code).toBe("internal_error");
    expect(String(leases[0].last_error)).toContain("agent unreachable");
  });

  test("without a teardown hook the release refuses to claim success", async () => {
    const { db, leases, calls } = makeLeaseDb({ leases: [leaseRow({ state: "active" })] });
    const outcome = await releaseRemoteLease(
      { intent_id: "intent-1", revision: 7 },
      { db, audit: silentAudit, teardown: null, releasePort: hooks(calls).releasePort },
    );
    expect(outcome.ok).toBe(false);
    expect(leases[0].state).toBe("failed");
    expect(String(leases[0].last_error)).toContain("not wired");
    expect(calls.releasePort).toHaveLength(0);
  });

  test("a failed release can be retried (failed -> releasing -> released)", async () => {
    const { db, leases, calls } = makeLeaseDb({ leases: [leaseRow({ state: "failed" })] });
    const outcome = await releaseRemoteLease({ intent_id: "intent-1", revision: 8 }, { ...hooks(calls), db });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.state).toBe("released");
    expect(leases[0].state).toBe("released");
  });

  test("replaying the same release intent returns the first result without touching the runtime again", async () => {
    const { db, calls } = makeLeaseDb({ leases: [leaseRow({ state: "active" })] });
    const deps = { ...hooks(calls), db };
    const first = await releaseRemoteLease({ intent_id: "intent-1", revision: 7 }, deps);
    const second = await releaseRemoteLease({ intent_id: "intent-1", revision: 7 }, deps);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.already_released).toBe(true);
    expect(calls.teardown).toHaveLength(1);
  });

  test("releasing an already-terminal lease is a successful no-op", async () => {
    for (const state of ["revoked", "expired", "released"]) {
      const { db, calls } = makeLeaseDb({ leases: [leaseRow({ state })] });
      const outcome = await releaseRemoteLease({ intent_id: "intent-1", revision: 9 }, { ...hooks(calls), db });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.already_released).toBe(true);
        expect(outcome.lease_epoch).toBe(4);
      }
      expect(calls.teardown).toHaveLength(0);
    }
  });

  test("an unknown lease is reported as lease_not_found, not as a successful release", async () => {
    const { db, calls } = makeLeaseDb();
    const outcome = await releaseRemoteLease({ intent_id: "nope", revision: 1 }, { ...hooks(calls), db });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("lease_not_found");
    expect(calls.teardown).toHaveLength(0);
  });
});

/* ================================================================== */
/* 到期                                                                */
/* ================================================================== */

describe("WP15 lease: expiry tears down, frees the port and reports its own numbers", () => {
  test("a due active lease is stopped, its port returned, and it lands on expired", async () => {
    const { db, leases, calls } = makeLeaseDb({ leases: [leaseRow({ state: "active", expires_at: NOW })] });
    const result = await expireLeases({ now: NOW, deps: { ...hooks(calls), db } });

    expect(result).toEqual({
      evaluated: 1,
      expired: 1,
      tore_down: 1,
      teardown_failed: 0,
      skipped: 0,
      ports_released: 1,
      ports_pending: 0,
    });
    expect(calls.teardown[0].reason).toBe("expired");
    expect(calls.releasePort).toEqual([{ node_id: 5, port: 19001 }]);
    expect(leases[0].state).toBe("expired");
    expect(leases[0].last_error_code).toBeNull();
  });

  test("leases that are not due yet are not even evaluated", async () => {
    const { db, calls } = makeLeaseDb({ leases: [leaseRow({ state: "active", expires_at: LATER })] });
    const result = await expireLeases({ now: NOW, deps: { ...hooks(calls), db } });
    expect(result.evaluated).toBe(0);
    expect(calls.teardown).toHaveLength(0);
  });

  test("a teardown failure defers: the port is kept and the lease is retried next tick", async () => {
    const { db, leases, calls } = makeLeaseDb({ leases: [leaseRow({ state: "active", expires_at: NOW })] });
    const result = await expireLeases({
      now: NOW,
      deps: { ...hooks(calls, { teardown: () => ({ ok: false, message: "agent unreachable" }) }), db },
    });

    expect(result.teardown_failed).toBe(1);
    expect(result.expired).toBe(0);
    expect(result.ports_pending).toBe(1);
    expect(result.ports_released).toBe(0);
    expect(calls.releasePort).toHaveLength(0);
    expect(leases[0].state).toBe("failed");

    // 下一拍：停服恢复 → 收口成 expired（failed → releasing → expired 是矩阵允许的补偿路径）。
    const retry = await expireLeases({ now: NOW, deps: { ...hooks(calls, { teardown: () => ({ ok: true }) }), db } });
    expect(retry.expired).toBe(1);
    expect(leases[0].state).toBe("expired");
  });

  test("a lost CAS is counted as skipped instead of being forced through", async () => {
    const { db } = makeLeaseDb({ leases: [leaseRow({ state: "active", expires_at: NOW })] });
    const frozen = { ...db, federationLease: { ...db.federationLease, updateMany: async () => ({ count: 0 }) } } as LeaseDb;
    const result = await expireLeases({ now: NOW, deps: { db: frozen, audit: silentAudit, teardown: () => ({ ok: true }) } });
    expect(result.evaluated).toBe(1);
    expect(result.expired).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("the batch is bounded so one tick cannot scan the whole table", async () => {
    const many = Array.from({ length: EXPIRE_BATCH_LIMIT + 5 }, (_, i) =>
      leaseRow({ id: 1000 + i, lease_ref: `l-${i}`, intent_id: `i-${i}`, state: "active", expires_at: NOW }),
    );
    const { db, calls } = makeLeaseDb({ leases: many });
    const result = await expireLeases({ now: NOW, deps: { ...hooks(calls), db } });
    expect(result.evaluated).toBe(EXPIRE_BATCH_LIMIT);
    expect(calls.teardown).toHaveLength(EXPIRE_BATCH_LIMIT);
  });
});

/* ================================================================== */
/* revision 更新 = 复用，不是第二次分配                                    */
/* ================================================================== */

describe("WP15 lease: a new revision of the same intent updates the lease instead of allocating again", () => {
  test("the existing non-terminal lease is reused: same node, same port, same epoch", async () => {
    const { db, leases, calls } = makeLeaseDb({
      leases: [leaseRow({ state: "active", requested_revision: 7, applied_revision: 7, lease_epoch: 4 })],
    });
    const deps = { ...hooks(calls), db };
    const outcome = await reserveRemoteLease(reserveInput({ intent: intent({ revision: 8 }), appliedRevision: 7, previousEpoch: 4 }), deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reused).toBe(true);
    expect(outcome.lease_epoch).toBe(4);
    expect(outcome.port).toBe(19001);
    expect(outcome.plan?.new_occupancy).toBe(false);
    expect(calls.allocate).toHaveLength(0); // 关键：没有第二个端口
    expect(leases).toHaveLength(1);
    expect(leases[0].requested_revision).toBe(8);
    expect(leases[0].state).toBe("active"); // 状态不变，重新下发归 apply 路径
  });

  test("a superseded revision is still refused even when the lease exists", async () => {
    const { db, calls } = makeLeaseDb({ leases: [leaseRow({ state: "active", applied_revision: 9 })] });
    const outcome = await reserveRemoteLease(
      reserveInput({ intent: intent({ revision: 8 }), appliedRevision: 9 }),
      { ...hooks(calls), db },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("intent_revision_stale");
    expect(calls.allocate).toHaveLength(0);
  });

  test("after a terminal lease a new occupancy takes the NEXT epoch of the lineage", async () => {
    const { db, leases, calls } = makeLeaseDb({
      leases: [leaseRow({ id: 31, lease_ref: "lease-old", state: "expired", lease_epoch: 9, intent_id: "intent-old", node_id: 6, listen_port: 19009 })],
    });
    const outcome = await reserveRemoteLease(
      reserveInput({ intent: intent({ revision: 1 }), previousEpoch: null, resolvedNodeId: 5, resolvedNodeGroupId: 7 }),
      { ...hooks(calls), db },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reused).toBeUndefined();
    // 谱系上出现过 9 → 新占用必须是 10，即使调用方说 previousEpoch = null。
    expect(outcome.lease_epoch).toBe(10);
    expect(outcome.plan?.new_occupancy).toBe(true);
    expect(leases).toHaveLength(2);
    expect(leases[1].state).toBe("reserved");
  });

  test("a rollover on ANOTHER intent in the same lineage cannot reuse an epoch", async () => {
    const { db, leases, calls } = makeLeaseDb({
      leases: [leaseRow({ id: 41, lease_ref: "lease-a", state: "active", lease_epoch: 5, intent_id: "intent-old" })],
    });
    const outcome = await reserveRemoteLease(
      reserveInput({ intent: intent({ intent_id: "intent-new", revision: 1 }), previousEpoch: 1 }),
      { ...hooks(calls), db },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.lease_epoch).toBe(6);
    expect(leases).toHaveLength(2);
  });
});

/* ================================================================== */
/* 阶段 2：apply（真实下发路径 / 补偿 / 幂等）                             */
/* ================================================================== */

describe("WP15 lease: apply dispatches through the existing orchestrator seam", () => {

  test("a reserved lease becomes active with applied_revision and the opaque node_ref", async () => {
    const f = applyFixture();
    const outcome = await applyRemoteLease(f.input, f.deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe("active");
    expect(outcome.applied_revision).toBe(7);
    expect(outcome.lease_epoch).toBe(4);
    expect(outcome.replayed).toBe(false);
    expect(outcome.node_ref).toBe("host-node-5");
    expect(outcome.port).toBe(19001);
    expect(f.calls.dispatch).toHaveLength(1);
    expect(f.calls.dispatch[0].runtime_id).toBe("tunex-fed-lease-1-egress");
    expect(f.leases[0].state).toBe("active");
    expect(f.leases[0].applied_revision).toBe(7);
    expect(f.leases[0].applied_at).not.toBeNull();
    expect(f.events.map((e) => e.action)).toEqual(["lease.apply"]);
  });

  test("the same (intent_id, revision, apply) replay returns the first result without dispatching twice", async () => {
    const f = applyFixture();
    const first = await applyRemoteLease(f.input, f.deps);
    const second = await applyRemoteLease(f.input, f.deps);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.applied_revision).toBe(7);
    expect(f.calls.dispatch).toHaveLength(1);
  });

  test("a revision older than applied_revision is refused and never overwrites state", async () => {
    const f = applyFixture({ revision: 6 }, { applied_revision: 7, state: "active" });
    const outcome = await applyRemoteLease(f.input, f.deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("intent_revision_stale");
    expect(f.calls.dispatch).toHaveLength(0);
    expect(f.leases[0].applied_revision).toBe(7);
  });

  test("a failed dispatch compensates: runtime revoked, port returned, state failed with a code", async () => {
    const f = applyFixture();
    const failing = {
      ...f.deps,
      dispatch: (i: Row) => {
        f.calls.dispatch.push(i);
        return { ok: false, message: "ack_timeout: agent did not answer" };
      },
    };
    const outcome = await applyRemoteLease(f.input, failing);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("internal_error");
    expect(f.calls.teardown).toHaveLength(1);
    expect(f.calls.teardown[0].reason).toBe("failed");
    expect(f.calls.releasePort).toEqual([{ node_id: 5, port: 19001 }]);
    expect(f.leases[0].state).toBe("failed");
    expect(f.leases[0].last_error_code).toBeNull(); // 补偿完成 → 不留待办
    expect(String(f.leases[0].last_error)).toContain("ack_timeout");
  });

  test("after a compensated failure the SAME intent can retry and succeed", async () => {
    const f = applyFixture();
    let first = true;
    const flaky = {
      ...f.deps,
      dispatch: (i: Row) => {
        f.calls.dispatch.push(i);
        if (first) {
          first = false;
          return { ok: false, message: "agent_unreachable" };
        }
        return { ok: true as const };
      },
    };
    const failed = await applyRemoteLease(f.input, flaky);
    expect(failed.ok).toBe(false);
    const retried = await applyRemoteLease(f.input, flaky);
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.replayed).toBe(false);
    expect(f.calls.dispatch).toHaveLength(2);
  });

  test("terminal leases are refused with their own codes", async () => {
    for (const [state, code] of [["revoked", "lease_revoked"], ["expired", "lease_expired"], ["released", "lease_not_found"]] as const) {
      const f = applyFixture({}, { state });
      const outcome = await applyRemoteLease(f.input, f.deps);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe(code);
      expect(f.calls.dispatch).toHaveLength(0);
    }
  });

  test("a malformed link fails closed before any dispatch", async () => {
    const f = applyFixture({ targets: [] });
    const outcome = await applyRemoteLease(f.input, f.deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("message_malformed");
    expect(f.calls.dispatch).toHaveLength(0);

    const badPort = applyFixture({ targets: [{ host: "203.0.113.9", port: 99999 }] });
    const portOutcome = await applyRemoteLease(badPort.input, badPort.deps);
    expect(portOutcome.ok).toBe(false);
    if (!portOutcome.ok) expect(portOutcome.code).toBe("message_malformed");
  });

  test("cross-panel transit stays closed in the first version (contract §9)", async () => {
    const f = applyFixture({ next_hop: "10.9.0.6:19002" }, { hop_role: "transit" });
    const outcome = await applyRemoteLease(f.input, f.deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("unsupported_topology");
    expect(f.calls.dispatch).toHaveLength(0);
  });

  test("a remote ingress hop needs an explicit next_hop and never guesses one", async () => {
    const missing = applyFixture({}, { hop_role: "ingress" });
    const outcome = await applyRemoteLease(missing.input, missing.deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("message_malformed");
    expect(missing.calls.dispatch).toHaveLength(0);

    const f = applyFixture({ next_hop: "10.9.0.6:19002" }, { hop_role: "ingress" });
    const applied = await applyRemoteLease(f.input, f.deps);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(f.calls.dispatch).toHaveLength(1);
    // ingress 的运行时身份是 relay 段（拆除时必须用同一个方向，见下一条）。
    expect(f.calls.dispatch[0].runtime_id).toBe("tunex-fed-lease-1-relay");
    expect(f.calls.dispatch[0].link.next_hop).toBe("10.9.0.6:19002");
  });

  test("the default hooks build the federated runtime id AND tear down in the matching direction", async () => {
    // 通过 relay-wiring 的单例注入假 orchestrator：验的正是"默认钩子真的接到既有通道上"，
    // 以及"拆错方向等于没拆"（建立用 relay，拆除必须也用 relay）。
    const seen: Row[] = [];
    const fake = {
      async dispatchIngress(input: Row) {
        seen.push({ kind: "ingress", ...input });
        return { ok: true as const, result: { commandId: "c1", revision: input.revision, ack: {} } };
      },
      async dispatchEgress(input: Row) {
        seen.push({ kind: "egress", ...input });
        return { ok: true as const, result: { commandId: "c2", revision: input.revision, ack: {} }, egress_host: "10.9.0.5", egress_port: input.egressPort };
      },
      async removeTunnel(input: Row) {
        seen.push({ kind: "remove", ...input });
        return { ok: true as const, result: { commandId: "c3", revision: input.revision, ack: {} } };
      },
    };
    setOrchestrator(fake as unknown as Orchestrator);
    try {
      const ingress = applyFixture({ next_hop: "10.9.0.6:19002" }, { hop_role: "ingress" });
      // 不注入 dispatch/teardown → 走生产默认实现（假 orchestrator 让它们可断言）；
      // 端口归还是 portPool 的事，本用例用替身，免得去连真库。
      const deps = { db: ingress.db, audit: ingress.deps.audit, now: () => NOW, releasePort: ingress.deps.releasePort };
      const applied = await applyRemoteLease(ingress.input, deps);
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;

      const teardown = await releaseRemoteLease(
        { intent_id: "intent-1", revision: 7, lease_ref: "lease-1" },
        deps,
      );
      expect(teardown.ok).toBe(true);

      const remove = seen.find((c) => c.kind === "remove");
      expect(seen[0].kind).toBe("ingress");
      expect(seen[0].runtimeId).toBe("tunex-fed-lease-1-relay");
      expect(remove?.runtimeId).toBe("tunex-fed-lease-1-relay");
      expect(remove?.direction).toBe("ingress");

      // egress 腿走同一个约定：建立用 egress 段，拆除用 egress 方向。
      const egress = applyFixture();
      const egressDeps = { db: egress.db, audit: egress.deps.audit, now: () => NOW, releasePort: egress.deps.releasePort };
      const egressApplied = await applyRemoteLease(egress.input, egressDeps);
      expect(egressApplied.ok).toBe(true);
      const egressRemove = await releaseRemoteLease(
        { intent_id: "intent-1", revision: 7, lease_ref: "lease-1" },
        egressDeps,
      );
      expect(egressRemove.ok).toBe(true);
      const lastRemove = [...seen].reverse().find((c) => c.kind === "remove");
      expect(lastRemove?.runtimeId).toBe("tunex-fed-lease-1-egress");
      expect(lastRemove?.direction).toBe("egress");
    } finally {
      resetOrchestrator();
    }
  });

  test("F1: an expired-but-uncollected lease is NOT reused (a revision update starts a new occupancy)", async () => {
    const past = new Date(NOW.getTime() - 60_000);
    const { db, leases, calls } = makeLeaseDb({
      nodes: [nodeRow()],
      grants: [leaseGrantRow()],
      leases: [leaseRow({ state: "active", applied_revision: 7, lease_epoch: 4, expires_at: past })],
    });
    const outcome = await reserveRemoteLease(
      reserveInput({ intent: intent({ revision: 8 }), appliedRevision: 7, previousEpoch: 4 }),
      { ...hooks(calls), db, now: () => NOW },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.reused).toBeUndefined();
    expect(outcome.lease_epoch).toBe(5); // 谱系最大 4 → 新占用必须是 5
    expect(leases).toHaveLength(2);
    expect(leases[1].state).toBe("reserved");
  });

  test("C1: a non-numeric target weight is rejected instead of being silently dropped", async () => {
    const f = applyFixture({ targets: [{ host: "203.0.113.9", port: 443, weight: "5" as unknown as number }] });
    const outcome = await applyRemoteLease(f.input, f.deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("message_malformed");
      expect(outcome.message).toContain("weight");
    }
    expect(f.calls.dispatch).toHaveLength(0);
  });

  test("an unknown lease_ref is lease_not_found", async () => {
    const f = applyFixture({ lease_ref: "ghost" });
    const outcome = await applyRemoteLease(f.input, f.deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("lease_not_found");
  });
});

/* ================================================================== */
/* task-7 A：被超越的 revision 不得回退状态 / 不得拆掉新 runtime            */
/* ================================================================== */

describe("WP15 lease (task-7 A): a superseded revision never rolls state back nor tears down the newer runtime", () => {
  test("A3-1/2: if a newer revision lands during our dispatch, we neither write back nor tear down", async () => {
    const f = applyFixture({ revision: 8 }, { applied_revision: 7, state: "active" });
    // 并发模拟：我们下发期间，revision 9 已经落库（同一个 runtimeId）。
    const racing = {
      ...f.deps,
      dispatch: (i: Row) => {
        f.calls.dispatch.push(i);
        f.leases[0].applied_revision = 9;
        f.leases[0].state = "active";
        return { ok: true as const };
      },
    };
    const outcome = await applyRemoteLease(f.input, racing);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("intent_revision_stale");
    // 关键断言 1：没有拆掉 revision 9 的 runtime。
    expect(f.calls.teardown).toHaveLength(0);
    // 关键断言 2：applied_revision 没有被写回 8（状态单调）。
    expect(f.leases[0].applied_revision).toBe(9);
    expect(f.leases[0].state).toBe("active");
  });

  test("A3-2: a dispatch failure on a superseded revision is recorded, not compensated", async () => {
    const f = applyFixture({ revision: 8 }, { applied_revision: 7, state: "active" });
    const racing = {
      ...f.deps,
      dispatch: (i: Row) => {
        f.calls.dispatch.push(i);
        // Agent 对旧 revision 回 409 stale 的同一时刻，新 revision 已落库。
        f.leases[0].applied_revision = 9;
        return { ok: false as const, message: "agent_rejected: stale revision" };
      },
    };
    const outcome = await applyRemoteLease(f.input, racing);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("intent_revision_stale");
    expect(f.calls.teardown).toHaveLength(0);
    expect(f.calls.releasePort).toHaveLength(0);
    expect(f.leases[0].applied_revision).toBe(9);
    // 被超越也留痕：审计里有 superseded 事实，台账里没有"我们成功过"的假记录。
    expect(f.events.some((e) => e.action === "lease.apply.superseded")).toBe(true);
  });

  test("A3-2 对照：真正被撤销时仍然补偿（不是所有 CAS 失败都放过）", async () => {
    const f = applyFixture({ revision: 8 }, { applied_revision: 7, state: "active" });
    const revokedMidFlight = {
      ...f.deps,
      dispatch: (i: Row) => {
        f.calls.dispatch.push(i);
        f.leases[0].state = "revoked"; // 并发撤销
        return { ok: true as const };
      },
    };
    const outcome = await applyRemoteLease(f.input, revokedMidFlight);
    expect(outcome.ok).toBe(false);
    expect(f.calls.teardown).toHaveLength(1);
    expect(f.calls.releasePort).toEqual([{ node_id: 5, port: 19001 }]);
  });
});

/* ================================================================== */
/* 续约（host 侧）                                                      */
/* ================================================================== */

describe("WP15 lease: renewal extends the deadline only while the grant still allows it", () => {
  function renewFixture(grantOver: Row = {}, leaseOver: Row = {}) {
    const made = makeLeaseDb({
      nodes: [nodeRow()],
      grants: [leaseGrantRow(grantOver)],
      // 到期时间刻意靠近 NOW：续约要"真的往后推"，否则 monotonic max 会让它保持不变
      // （那是正确的防回退行为，但测不出"推进"这件事）。
      leases: [leaseRow({ state: "active", applied_revision: 7, expires_at: new Date(NOW.getTime() + 60_000), ...leaseOver })],
    });
    const events: Row[] = [];
    return {
      ...made,
      events,
      deps: { ...hooks(made.calls), db: made.db, now: () => NOW, audit: (e: Row) => { events.push(e); } },
    };
  }

  test("an active grant renewal pushes expires_at without touching the epoch", async () => {
    const f = renewFixture();
    const outcome = await renewRemoteLease({ lease_ref: "lease-1", intent_id: "intent-1", revision: 7 }, f.deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.lease_epoch).toBe(4);
    expect(outcome.expires_at.getTime()).toBe(NOW.getTime() + DEFAULT_LEASE_TTL_SECONDS * 1000);
    expect(f.leases[0].lease_epoch).toBe(4);
    expect(f.leases[0].expires_at.getTime()).toBe(outcome.expires_at.getTime());
    expect(f.events.map((e) => e.action)).toEqual(["lease.renew"]);
  });

  test("a suspended grant is a hard NO: the deadline is not moved (so the lease can die)", async () => {
    const f = renewFixture({ status: "suspended" });
    const before = f.leases[0].expires_at.getTime();
    const outcome = await renewRemoteLease({ lease_ref: "lease-1", intent_id: "intent-1", revision: 7 }, f.deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("grant_not_active");
    expect(f.leases[0].expires_at.getTime()).toBe(before);
  });

  test("revoked / expired grants and missing grants never renew", async () => {
    const revoked = renewFixture({ status: "revoked" });
    const revokedOutcome = await renewRemoteLease({ lease_ref: "lease-1", intent_id: "intent-1", revision: 7 }, revoked.deps);
    expect(revokedOutcome.ok).toBe(false);
    if (!revokedOutcome.ok) expect(revokedOutcome.code).toBe("grant_not_active");

    const expired = renewFixture({ expires_at: NOW });
    const expiredOutcome = await renewRemoteLease({ lease_ref: "lease-1", intent_id: "intent-1", revision: 7 }, expired.deps);
    expect(expiredOutcome.ok).toBe(false);
    if (!expiredOutcome.ok) expect(expiredOutcome.code).toBe("grant_expired");

    const noGrant = makeLeaseDb({ nodes: [nodeRow()], leases: [leaseRow({ state: "active" })] });
    const missingOutcome = await renewRemoteLease(
      { lease_ref: "lease-1", intent_id: "intent-1", revision: 7 },
      { ...hooks(noGrant.calls), db: noGrant.db, now: () => NOW, audit: silentAudit },
    );
    expect(missingOutcome.ok).toBe(false);
    if (!missingOutcome.ok) expect(missingOutcome.code).toBe("grant_not_found");
  });

  test("renewal replays idempotently and refuses terminal leases", async () => {
    const f = renewFixture();
    const first = await renewRemoteLease({ lease_ref: "lease-1", intent_id: "intent-1", revision: 7 }, f.deps);
    const moved = f.leases[0].expires_at.getTime();
    const second = await renewRemoteLease({ lease_ref: "lease-1", intent_id: "intent-1", revision: 7 }, f.deps);
    expect(first.ok && second.ok).toBe(true);
    if (second.ok) expect(second.expires_at.getTime()).toBe(moved);

    for (const [state, code] of [["revoked", "lease_revoked"], ["expired", "lease_expired"], ["released", "lease_not_found"]] as const) {
      const terminal = renewFixture({}, { state });
      const outcome = await renewRemoteLease({ lease_ref: "lease-1", intent_id: "intent-1", revision: 7 }, terminal.deps);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe(code);
    }
  });
});

/* ================================================================== */
/* task-7 D1：终态但端口未归还的行必须被下一拍补还                          */
/* ================================================================== */

describe("WP15 lease (task-7 D1): a terminal lease whose port was not returned is retried, port-only", () => {
  test("expiry with a failing port release marks it, and the next sweep returns the port without re-tearing-down", async () => {
    const { db, leases, calls } = makeLeaseDb({ leases: [leaseRow({ state: "active", expires_at: NOW })] });
    const failingRelease = {
      ...hooks(calls),
      db,
      releasePort: (i: Row) => {
        calls.releasePort.push(i);
        return { ok: false, message: "portPool is down" };
      },
    };
    const first = await expireLeases({ now: NOW, deps: failingRelease });

    expect(first.expired).toBe(1); // 停服成功 → 状态照样收口
    expect(first.ports_pending).toBe(1);
    expect(leases[0].state).toBe("expired");
    expect(leases[0].last_error_code).toBe(PORT_RELEASE_PENDING_CODE);

    const sweeping = { ...hooks(calls), db };
    const swept = await sweepRevokedLeaseCleanup({ now: NOW, deps: sweeping });
    expect(swept.evaluated).toBe(1);
    expect(swept.port_only_retried).toBe(1);
    expect(swept.ports_released).toBe(1);
    expect(calls.teardown).toHaveLength(1); // 只有到期那一次；扫尾**没有**再拆一次
    expect(leases[0].last_error_code).toBeNull();
    expect(calls.releasePort).toEqual([
      { node_id: 5, port: 19001 },
      { node_id: 5, port: 19001 },
    ]);

    // 幂等：清空标记后不再是候选。
    const again = await sweepRevokedLeaseCleanup({ now: NOW, deps: sweeping });
    expect(again.evaluated).toBe(0);
  });

  test("a released lease with a pending port is also picked up, and a wired-but-failing port keeps the marker", async () => {
    const { db, leases, calls } = makeLeaseDb({
      leases: [leaseRow({ state: "released", applied_revision: 7, last_error_code: PORT_RELEASE_PENDING_CODE, last_error: "port release failed" })],
    });
    const stillFailing = { ...hooks(calls), db, releasePort: () => ({ ok: false, message: "still down" }) };
    const swept = await sweepRevokedLeaseCleanup({ now: NOW, deps: stillFailing });
    expect(swept.ports_pending).toBe(1);
    expect(leases[0].last_error_code).toBe(PORT_RELEASE_PENDING_CODE);
    expect(calls.teardown).toHaveLength(0); // released 行不需要再停服

    const ok = { ...hooks(calls), db };
    const swept2 = await sweepRevokedLeaseCleanup({ now: NOW, deps: ok });
    expect(swept2.ports_released).toBe(1);
    expect(leases[0].last_error_code).toBeNull();
  });
});

/* ================================================================== */
/* 续约窗口幂等（"一直在续约却被自己的幂等键判死"的修复）                    */
/* ================================================================== */

describe("WP15 lease: renewal is a periodic action, so its idempotency key carries a window", () => {
  function renewDeps(leaseOver: Row = {}) {
    const made = makeLeaseDb({
      nodes: [nodeRow()],
      grants: [leaseGrantRow()],
      leases: [leaseRow({ state: "active", applied_revision: 7, expires_at: new Date(NOW.getTime() + 5_000), ...leaseOver })],
    });
    return { ...made, deps: { ...hooks(made.calls), db: made.db, now: () => NOW, audit: silentAudit } };
  }

  test("the window index advances with the clock and stays stable inside one TTL", () => {
    expect(renewalWindowIndex(NOW, 300)).toBe(Math.floor(NOW.getTime() / 300_000));
    expect(renewalWindowIndex(new Date(NOW.getTime() + 1_000), 300)).toBe(renewalWindowIndex(NOW, 300));
    expect(renewalWindowIndex(new Date(NOW.getTime() + 301_000), 300)).toBe(renewalWindowIndex(NOW, 300) + 1);
  });

  test("a replay inside the same window returns the first result and does NOT push again", async () => {
    const f = renewDeps();
    const first = await renewRemoteLease({ lease_ref: "lease-1", intent_id: "intent-1", revision: 7, ttlSeconds: 300 }, f.deps);
    const pushed = f.leases[0].expires_at.getTime();
    const second = await renewRemoteLease({ lease_ref: "lease-1", intent_id: "intent-1", revision: 7, ttlSeconds: 300 }, f.deps);
    expect(first.ok && second.ok).toBe(true);
    if (second.ok) expect(second.expires_at.getTime()).toBe(pushed);
    // 台账里只有一行（(intent, revision, renew@<window>) 唯一）：第二次没有产生第二次写入。
    expect(f.intents).toHaveLength(1);
    expect(String(f.intents[0].action)).toMatch(/^renew@\d+$/);
  });

  test("crossing a window really extends the deadline (the periodic-renewal path)", async () => {
    const f = renewDeps();
    const first = await renewRemoteLease({ lease_ref: "lease-1", intent_id: "intent-1", revision: 7, ttlSeconds: 10 }, f.deps);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 下一格：时钟前进一个 TTL（同一 revision、同一 intent —— home 侧本来就只能这样发）。
    const later = new Date(NOW.getTime() + 11_000);
    const second = await renewRemoteLease(
      { lease_ref: "lease-1", intent_id: "intent-1", revision: 7, ttlSeconds: 10 },
      { ...f.deps, now: () => later },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.expires_at.getTime()).toBeGreaterThan(first.expires_at.getTime());
    expect(f.leases[0].expires_at.getTime()).toBe(second.expires_at.getTime());
  });

  test("expires_at never walks backwards, even with a smaller ttl", async () => {
    const far = new Date(NOW.getTime() + 600_000);
    const f = renewDeps({ expires_at: far });
    const outcome = await renewRemoteLease({ lease_ref: "lease-1", intent_id: "intent-1", revision: 7, ttlSeconds: 5 }, f.deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.expires_at.getTime()).toBe(far.getTime());
    expect(f.leases[0].expires_at.getTime()).toBe(far.getTime());
  });

  test("a suspended grant still refuses renewal on the windowed path (no deadline moved)", async () => {
    const made = makeLeaseDb({
      nodes: [nodeRow()],
      grants: [leaseGrantRow({ status: "suspended" })],
      leases: [leaseRow({ state: "active", applied_revision: 7 })],
    });
    const before = made.leases[0].expires_at.getTime();
    const outcome = await renewRemoteLease(
      { lease_ref: "lease-1", intent_id: "intent-1", revision: 7, ttlSeconds: 300 },
      { ...hooks(made.calls), db: made.db, now: () => NOW, audit: silentAudit },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("grant_not_active");
    expect(made.leases[0].expires_at.getTime()).toBe(before);
  });
});

/* ================================================================== */
/* 撤销扫尾（peer 撤销 / grant 撤销之后的停服补做）                        */
/* ================================================================== */

describe("WP15 lease: revoked-but-not-yet-stopped leases are swept, port included", () => {
  test("a lease flipped to revoked by the trust cascade is stopped and its port returned exactly once", async () => {
    const { db, leases, calls } = makeLeaseDb({
      nodes: [nodeRow()],
      leases: [leaseRow({ state: "revoked", last_error_code: "peer_revoked", last_error: null })],
    });
    const deps = { ...hooks(calls), db };
    const result = await sweepRevokedLeaseCleanup({ peer_panel_id: "panel-a", now: NOW, deps });

    expect(result.stopped).toBe(1);
    expect(result.ports_released).toBe(1);
    expect(calls.teardown).toHaveLength(1);
    expect(calls.releasePort).toEqual([{ node_id: 5, port: 19001 }]);
    expect(leases[0].state).toBe("revoked");
    expect(leases[0].last_error_code).toBeNull(); // 确认完成 → 不再是候选，不会重复撤

    const again = await sweepRevokedLeaseCleanup({ peer_panel_id: "panel-a", now: NOW, deps });
    expect(again.evaluated).toBe(0);
    expect(calls.teardown).toHaveLength(1);
  });

  test("a failing teardown keeps the lease as a candidate for the next tick", async () => {
    const { db, leases, calls } = makeLeaseDb({
      nodes: [nodeRow()],
      leases: [leaseRow({ state: "revoked", last_error_code: "peer_revoked" })],
    });
    const failing = { ...hooks(calls), db, teardown: () => ({ ok: false, message: "agent still unreachable" }) };
    const result = await sweepRevokedLeaseCleanup({ peer_panel_id: "panel-a", now: NOW, deps: failing });

    expect(result.teardown_failed).toBe(1);
    expect(result.ports_pending).toBe(0);
    expect(leases[0].last_error_code).toBe("internal_error");
    expect(calls.releasePort).toHaveLength(0);

    const ok = { ...hooks(calls), db };
    const retry = await sweepRevokedLeaseCleanup({ peer_panel_id: "panel-a", now: NOW, deps: ok });
    expect(retry.stopped).toBe(1);
    expect(leases[0].last_error_code).toBeNull();
  });
});

/* ================================================================== */
/* WP15/WP16 home 侧镜像与对账                                           */
/* ================================================================== */

function placementRow(over: Partial<FederationPlacementRow> = {}): FederationPlacementRow {
  return {
    id: 1,
    peer_panel_id: "panel-b",
    forward_ref: "fwd-1",
    tunnel_id: 41,
    intent_id: "intent-1",
    lease_ref: "lease-1",
    lease_epoch: 3,
    hop_role: "egress",
    desired_revision: 7,
    applied_revision: 6,
    state: "active",
    peer_node_ref: "host-node-5",
    peer_port: 19001,
    last_error_code: null,
    last_error: null,
    expires_at: GOOD_UNTIL,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function makePlacementDb(seed: { placements?: Row[]; peers?: Row[] } = {}) {
  const placements: Row[] = (seed.placements ?? []).map((p) => ({ ...p }));
  const peers: Row[] = (seed.peers ?? [{ peer_panel_id: "panel-b", endpoint_url: "https://panel-b.example", status: "trusted" }]).map((p) => ({ ...p }));
  const calls = { create: [] as Row[], update: [] as Row[], send: [] as Row[] };
  const db: PlacementDb = {
    federationPlacement: {
      async findUnique(args: any) {
        const k = args.where?.peer_panel_id_intent_id;
        const row = placements.find((p) => p.peer_panel_id === k.peer_panel_id && p.intent_id === k.intent_id);
        return row ? { ...row } : null;
      },
      async findFirst(args: any) {
        return this.findUnique(args);
      },
      async findMany(args: any) {
        const wanted: string[] | undefined = args?.where?.state?.in;
        const rows = placements.filter((p) => wanted === undefined || wanted.includes(p.state)).map((p) => ({ ...p }));
        return typeof args?.take === "number" ? rows.slice(0, args.take) : rows;
      },
      async create(args: any) {
        calls.create.push(args.data);
        const row = { id: placements.length + 1, ...args.data };
        placements.push(row);
        return { ...row };
      },
      async updateMany(args: any) {
        calls.update.push(args.data);
        const row = placements.find((p) => p.id === args.where?.id);
        if (!row) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    federationPeer: {
      async findUnique(args: any) {
        const row = peers.find((p) => p.peer_panel_id === args.where?.peer_panel_id);
        return row ? { ...row } : null;
      },
      async findMany() {
        return peers.map((p) => ({ ...p }));
      },
    },
  };
  return { db, placements, peers, calls };
}

describe("WP15 placement: the home mirror resends by (intent_id, revision) or degrades — never falls back", () => {
  test("planPlacementSync distinguishes converged / resend / unreachable", () => {
    const rows = [
      placementRow({ intent_id: "i-converged", applied_revision: 7, desired_revision: 7 }),
      placementRow({ intent_id: "i-behind", applied_revision: 6, desired_revision: 7 }),
      placementRow({ intent_id: "i-never", applied_revision: null, desired_revision: 3 }),
      placementRow({ intent_id: "i-revoked", state: "revoked" }),
    ];
    const online = planPlacementSync(rows, { peerReachable: true, now: NOW });
    // task-10 起：已收敛**不再直接 continue**，而是进探活桶（这正是原先的缺口）。
    expect(online.probes.map((r) => r.intent_id)).toEqual(["i-converged"]);
    expect(online.resends.map((r) => r.intent_id).sort()).toEqual(["i-behind", "i-never"]);
    expect(online.skipped.map((r) => r.intent_id)).toEqual(["i-revoked"]);
    expect(online.degraded).toEqual([]);
    expect(online.expired).toEqual([]);

    // peer 不可达：**一条都不重发**，全部降级（不回落本地节点）。
    const offline = planPlacementSync(rows, { peerReachable: false, now: NOW });
    expect(offline.resends).toEqual([]);
    // §5 矩阵：host 不可达 → placement 一律 degraded(unreachable)；已"收敛"的行也不例外，
    // 因为"远端确认过"与"现在够得着"是两件事。
    expect(offline.degraded.map((r) => r.intent_id).sort()).toEqual(["i-behind", "i-converged", "i-never"]);
  });

  test("remote lease states map onto mirror states with terminal ones nailed down", () => {
    expect(mapRemoteLeaseStateToPlacement("reserved")?.state).toBe("pending");
    expect(mapRemoteLeaseStateToPlacement("active")?.state).toBe("active");
    expect(mapRemoteLeaseStateToPlacement("releasing")?.state).toBe("degraded");
    expect(mapRemoteLeaseStateToPlacement("released")?.state).toBe("expired");
    expect(mapRemoteLeaseStateToPlacement("expired")?.state).toBe("expired");
    expect(mapRemoteLeaseStateToPlacement("revoked")?.state).toBe("revoked");
    expect(mapRemoteLeaseStateToPlacement("weird")).toBeNull();
  });

  test("upsertPlacement keeps (peer, intent_id) unique and never resurrects a terminal row", async () => {
    const { db, placements, calls } = makePlacementDb();
    const first = await upsertPlacement(
      { peer_panel_id: "panel-b", forward_ref: "fwd-1", intent_id: "intent-1", hop_role: "egress", desired_revision: 7, tunnel_id: 41 },
      { db },
    );
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.created).toBe(true);

    const second = await upsertPlacement(
      { peer_panel_id: "panel-b", forward_ref: "fwd-1", intent_id: "intent-1", hop_role: "egress", desired_revision: 8, state: "pending" },
      { db },
    );
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.created).toBe(false);
    expect(placements).toHaveLength(1);
    expect(placements[0].desired_revision).toBe(8);

    const revoked = makePlacementDb({ placements: [placementRow({ state: "revoked" })] });
    const late = await upsertPlacement(
      { peer_panel_id: "panel-b", forward_ref: "fwd-1", intent_id: "intent-1", hop_role: "egress", desired_revision: 9, state: "pending" },
      { db: revoked.db },
    );
    expect(late.ok).toBe(true);
    if (late.ok) expect(late.placement.state).toBe("revoked");
    expect(revoked.placements[0].desired_revision).toBe(7); // 迟到的旧消息不改终态
    expect(calls.update.length).toBeGreaterThan(0);
  });

  test("a remote reply never walks applied_revision backwards, and unreachable becomes degraded", async () => {
    const { db, placements } = makePlacementDb({ placements: [placementRow({ applied_revision: 9 })] });
    await recordPlacementResult(
      { peer_panel_id: "panel-b", intent_id: "intent-1", ok: true, applied_revision: 4, remote_state: "active" },
      { db },
    );
    expect(placements[0].applied_revision).toBe(9);

    await recordPlacementResult(
      { peer_panel_id: "panel-b", intent_id: "intent-1", ok: false, code: "peer_unreachable", message: "connection refused" },
      { db },
    );
    expect(placements[0].state).toBe("degraded");
    expect(placements[0].last_error_code).toBe("peer_unreachable");
    expect(placements[0].applied_revision).toBe(9); // 事实不变，只是可解释地降级
  });

  test("reconcilePlacements resends unconfirmed intents and stops at the first unreachable peer", async () => {
    const { db, placements, calls } = makePlacementDb({
      placements: [placementRow({ applied_revision: 6, desired_revision: 7 }), placementRow({ id: 2, intent_id: "intent-2", applied_revision: 1, desired_revision: 2 })],
    });
    const sender = async (input: Row) => {
      calls.send.push(input);
      return { ok: true as const, status: 201, body: {}, messageId: "m1" };
    };
    const result = await reconcilePlacements({ now: NOW, deps: { db, sender } });
    expect(result.evaluated).toBe(2);
    expect(result.resent).toBe(2);
    expect(calls.send).toHaveLength(2);
    expect(calls.send[0].path).toBe("/api/federation/v1/leases");
    // B1：形状对齐 host 的 handler（`{grant_ref?, intent:{...}}`），且不假装记得 grant。
    const sentBody = calls.send[0].body as Row;
    expect(sentBody.intent.intent_id).toBe("intent-1");
    expect(sentBody.intent.revision).toBe(7);
    expect(sentBody.intent.hop_role).toBe("egress");
    expect(sentBody.intent.forward_ref).toBe("fwd-1");
    expect("grant_ref" in sentBody).toBe(false);
    expect(placements[0].state).toBe("active");

    const offline = makePlacementDb({
      placements: [placementRow(), placementRow({ id: 2, intent_id: "intent-2" })],
    });
    const offlineSends: Row[] = [];
    const offlineSender = async (input: Row) => {
      offlineSends.push(input);
      return { ok: false as const, code: "peer_unreachable" as const, status: 0, message: "unreachable", retryable: true, messageId: "m2" };
    };
    const offlineResult = await reconcilePlacements({ now: NOW, deps: { db: offline.db, sender: offlineSender } });
    expect(offlineResult.degraded).toBe(2);
    expect(offlineSends).toHaveLength(1); // 已知不可达后不再逐个重试
    expect(offline.placements.every((p) => p.state === "degraded")).toBe(true);
    // 绝不回落本地：隧道引用与状态事实都没被改写成本地节点。
    expect(offline.placements.every((p) => p.peer_panel_id === "panel-b")).toBe(true);
    expect(offline.placements.every((p) => p.applied_revision === 6)).toBe(true);
  });
});

/* ================================================================== */
/* task-10：本地到期 + 已收敛行探活                                       */
/* ================================================================== */

function convergedRow(over: Partial<FederationPlacementRow> = {}): FederationPlacementRow {
  return placementRow({
    state: "active",
    applied_revision: 7,
    desired_revision: 7,
    lease_ref: "lease-1",
    expires_at: new Date(NOW.getTime() + 600_000),
    ...over,
  });
}

describe("WP16 placement (task-10): local expiry terminates without asking the peer", () => {
  test("an expired mirror becomes expired locally and issues NO remote call at all", async () => {
    const { db, placements, peers } = makePlacementDb({
      placements: [placementRow({ state: "active", expires_at: new Date(NOW.getTime() - 1000) })],
    });
    const sends: Row[] = [];
    const sender = async (i: Row) => {
      sends.push(i);
      return { ok: true as const, status: 200, body: {}, messageId: "m" };
    };
    const plan = planSync(placements as unknown as FederationPlacementRow[], { peerReachable: true, now: NOW });
    expect(plan.expired).toHaveLength(1);
    expect(plan.probes).toHaveLength(0);
    expect(plan.resends).toHaveLength(0);

    const result = await reconcilePlacements({ now: NOW, deps: { db, sender } });
    expect(result.expired).toBe(1);
    expect(result.probed).toBe(0);
    expect(sends).toHaveLength(0); // 到期不需要网络
    expect(peers).toHaveLength(1); // 夹具自检（peer 行存在，因此不是因为"没有 peer"而跳过）
    expect(placements[0].state).toBe("expired");
    expect(placements[0].last_error_code).toBe("lease_expired");

    // 终态吸收：下一拍不再是候选，也不会被探活。
    const again = await reconcilePlacements({ now: NOW, deps: { db, sender } });
    expect(again.evaluated).toBe(0);
    expect(sends).toHaveLength(0);
  });

  test("a peer-less mirror still expires locally (the host is gone but the clock is ours)", async () => {
    const { db, placements } = makePlacementDb({
      placements: [placementRow({ state: "degraded", expires_at: new Date(NOW.getTime() - 1) })],
      peers: [],
    });
    const result = await reconcilePlacements({ now: NOW, deps: { db, sender: async () => ({ ok: true as const, status: 200, body: {}, messageId: "m" }) } });
    expect(result.expired).toBe(1);
    expect(result.degraded).toBe(0);
    expect(placements[0].state).toBe("expired");
  });
});

describe("WP16 placement (task-10): converged rows are probed and can degrade and recover", () => {
  test("probe failure → degraded with an explainable code; a later good probe → back to active", async () => {
    const { db, placements } = makePlacementDb({ placements: [convergedRow()] });
    const sends: Row[] = [];
    const sender = async (i: Row) => {
      sends.push(i);
      if (sends.length === 1) {
        return { ok: false as const, code: "peer_unreachable" as const, status: 0, message: "connection refused", retryable: true, messageId: "m1" };
      }
      return { ok: true as const, status: 200, body: { lease_ref: "lease-1", state: "active", applied_revision: 7 }, messageId: "m2" };
    };

    const first = await reconcilePlacements({ now: NOW, deps: { db, sender } });
    expect(first.probed).toBe(1);
    expect(first.degraded).toBe(1);
    expect(placements[0].state).toBe("degraded");
    expect(placements[0].last_error_code).toBe("peer_unreachable");

    const second = await reconcilePlacements({ now: NOW, deps: { db, sender } });
    expect(second.recovered).toBe(1);
    expect(placements[0].state).toBe("active");
    expect(placements[0].last_error_code).toBeNull();
    expect(sends[0].method).toBe("GET");
    expect(sends[0].path).toBe("/api/federation/v1/leases/lease-1");
  });

  test("one unreachable peer is not probed row by row in the same tick", async () => {
    const { db, placements } = makePlacementDb({
      placements: [
        convergedRow({ id: 1, intent_id: "i-1" }),
        convergedRow({ id: 2, intent_id: "i-2" }),
        convergedRow({ id: 3, intent_id: "i-3" }),
      ],
    });
    const sends: Row[] = [];
    const sender = async (i: Row) => {
      sends.push(i);
      return { ok: false as const, code: "peer_unreachable" as const, status: 0, message: "down", retryable: true, messageId: "m" };
    };
    const result = await reconcilePlacements({ now: NOW, deps: { db, sender } });
    expect(sends).toHaveLength(1); // 只探一次
    expect(result.degraded).toBe(3);
    expect(placements.every((p) => p.state === "degraded")).toBe(true);
  });

  test("a remote revoked lease mirrors to revoked (not degraded), using the shared mapping", async () => {
    const { db, placements } = makePlacementDb({ placements: [convergedRow()] });
    const result = await reconcilePlacements({
      now: NOW,
      deps: { db, sender: async () => ({ ok: true as const, status: 200, body: { lease_ref: "lease-1", state: "revoked", applied_revision: 7 }, messageId: "m" }) },
    });
    expect(result.probed).toBe(1);
    expect(result.revoked).toBe(1);
    expect(result.degraded).toBe(0);
    expect(placements[0].state).toBe("revoked");
  });

  test("a 404 lease_not_found mirrors to expired instead of a vague failure", async () => {
    const { db, placements } = makePlacementDb({ placements: [convergedRow()] });
    const result = await reconcilePlacements({
      now: NOW,
      deps: {
        db,
        sender: async () => ({ ok: false as const, code: "lease_not_found" as const, status: 404, message: "gone", retryable: false, messageId: "m" }),
      },
    });
    expect(result.expired).toBe(1);
    expect(placements[0].state).toBe("expired");
  });

  test("the probe budget bounds one tick, and the rest are deferred instead of degraded", async () => {
    const rows = Array.from({ length: MAX_PLACEMENT_PROBES_PER_TICK + 3 }, (_, i) => convergedRow({ id: i + 1, intent_id: `i-${i + 1}` }));
    const { db, placements } = makePlacementDb({ placements: rows });
    const sends: Row[] = [];
    const sender = async (i: Row) => {
      sends.push(i);
      return { ok: true as const, status: 200, body: { state: "active", applied_revision: 7 }, messageId: "m" };
    };
    const result = await reconcilePlacements({ now: NOW, deps: { db, sender } });
    expect(sends).toHaveLength(MAX_PLACEMENT_PROBES_PER_TICK);
    expect(result.probed).toBe(MAX_PLACEMENT_PROBES_PER_TICK);
    expect(result.deferred).toBe(3);
    // 没被探到的行保持原状：既没被降级，也没被写成别的状态（"没轮到"不等于"坏了"）。
    expect(placements.length).toBe(MAX_PLACEMENT_PROBES_PER_TICK + 3);
    expect(placements.filter((p) => p.last_error_code !== null)).toHaveLength(0);
  });

  test("the probe response parser refuses to guess when the payload has no state", async () => {
    expect(parseRemoteLeaseFact({ applied_revision: 3 })).toBeNull();
    expect(parseRemoteLeaseFact("nope")).toBeNull();
    const flat = parseRemoteLeaseFact({ state: "active", applied_revision: 3, lease_epoch: 2, expires_at: "2026-10-05T06:00:00Z" });
    expect(flat?.state).toBe("active");
    expect(flat?.applied_revision).toBe(3);
    const nested = parseRemoteLeaseFact({ lease: { state: "expired" } });
    expect(nested?.state).toBe("expired");
  });
});

/* ================================================================== */
/* 常量契约                                                            */
/* ================================================================== */

describe("WP15 lease: the TTL is a multiple of the reconcile tick, not equal to it", () => {
  test("a single missed tick must not tear a healthy remote link down", () => {
    expect(DEFAULT_LEASE_TTL_SECONDS).toBeGreaterThanOrEqual(3 * LEASE_RECONCILE_TICK_SECONDS);
  });

  test("epoch never regresses and never restarts from zero for a live lineage", () => {
    expect(nextLeaseEpoch(null)).toBe(1);
    expect(nextLeaseEpoch(0)).toBe(1);
    expect(nextLeaseEpoch(4)).toBe(5);
    expect(() => nextLeaseEpoch(-3)).toThrow();
  });
});
