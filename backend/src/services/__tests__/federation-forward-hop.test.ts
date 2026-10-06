/**
 * V5.5 WP15 产品级接线 —— 远端出口腿编排的离线测试（不连 MySQL / Redis / 网络）。
 *
 * 依据：`docs/v5-wp14-16-federation-contract.md` §3.2（两阶段 + 幂等）/ §3.3（顺序铁律）
 * / §3.4（home 侧集成边界）/ §5（分区矩阵）/ §6（错误码闭集）/ §9（不开放项）。
 *
 * 覆盖矩阵（每一条都对应一个**具体的故障形态**，而不是"代码路径被走到"）：
 *   A. 确定性 intent 键：重试/续跑/对账必须用同一个键（否则第二次申请 = 第二条腿）。
 *   B. 拓扑 fail-closed：远端 ingress/transit、3+ 跳、本机+远端同时声明出口、
 *      需要节点本地证书的协议 —— 全部在**任何副作用之前**被拒。
 *   C. 声明校验：peer 未知 / 已撤销 / 未开启联邦 → 可行动错误码，且**不发请求**。
 *   D. 两阶段：reserve → apply → 镜像行；请求体形状与 host 路由的契约一致。
 *   E. 失败补偿：apply 失败必须立刻 DELETE 远端腿（不许在对面留孤儿 runtime/端口）。
 *   F. **结果未知 ≠ 失败**：apply 响应畸形时不得释放（那会拆掉一条可能正在服务的腿），
 *      只标 degraded 交给对账按同一 intent 重发。
 *   G. 释放：按同一 intent 键 DELETE、镜像行落 expired、重复释放幂等。
 */
import { describe, expect, it } from "bun:test";

import {
  checkFederatedEgressForSnapshot,
  checkFederatedEgressTopology,
  delegateFederatedEgress,
  federatedEgressForwardRef,
  federatedEgressIntentId,
  federatedEgressPeerOf,
  federatedEgressTargetsOf,
  FEDERATED_LEG_ERROR_CODES,
  FEDERATED_RECOVERY_IMPACT,
  federatedLegVisibleError,
  reconcileFederatedForwardHealth,
  releaseFederatedEgress,
  releaseStaleFederatedEgressForTunnel,
  validateFederatedEgressDeclaration,
  type ForwardHopDb,
  type ForwardHopSendOutcome,
  type ForwardHopSender,
} from "../federation/forward-hop.ts";

/* ------------------------------------------------------------------ */
/* 替身                                                                */
/* ------------------------------------------------------------------ */

interface FakePlacementRow {
  id: number;
  peer_panel_id: string;
  forward_ref: string;
  tunnel_id: number | null;
  intent_id: string;
  lease_ref: string | null;
  lease_epoch: number;
  hop_role: string;
  desired_revision: number;
  applied_revision: number | null;
  state: string;
  peer_node_ref: string | null;
  peer_port: number | null;
  last_error_code: string | null;
  last_error: string | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface FakeTunnelRow {
  id: number;
  apply_status: string | null;
  apply_error_code: string | null;
  apply_error: string | null;
  desired_status: string | null;
  config_revision: number | null;
  applied_revision: number | null;
  ingress_node_id: number | null;
  federated_egress_peer: string | null;
}

function fakeDb(over: {
  peer?: { peer_panel_id: string; endpoint_url: string; status: string } | null;
  tunnels?: FakeTunnelRow[];
  /** 入口节点 state report（`reconcileFederatedForwardHealth` 的默认事实来源）。 */
  reports?: Array<{ node_id: number; tunnels: unknown; reported_at: Date | null }>;
  /** 未完成的 rollout 行（非空 ⇒ 本拍不再触发恢复）。 */
  inFlightRollouts?: Array<{ id: number }>;
} = {}): {
  db: ForwardHopDb;
  placements: FakePlacementRow[];
  tunnels: FakeTunnelRow[];
  tunnelWrites: Array<Record<string, unknown>>;
} {
  const placements: FakePlacementRow[] = [];
  const tunnels: FakeTunnelRow[] = over.tunnels ?? [];
  const tunnelWrites: Array<Record<string, unknown>> = [];
  let nextId = 1;

  /** 只实现对账用到的三种 where 形状（等价于 Prisma 的语义子集）。 */
  const matchesPlacement = (row: FakePlacementRow, where: Record<string, unknown>): boolean => {
    if (typeof where.hop_role === "string" && row.hop_role !== where.hop_role) return false;
    if (typeof where.intent_id === "string" && row.intent_id !== where.intent_id) return false;
    if (typeof where.tunnel_id === "number" && row.tunnel_id !== where.tunnel_id) return false;
    const tunnelFilter = where.tunnel_id as { not?: unknown } | undefined;
    if (tunnelFilter && typeof tunnelFilter === "object" && "not" in tunnelFilter && row.tunnel_id === null) return false;
    const stateFilter = where.state as { in?: string[] } | undefined;
    if (stateFilter?.in && !stateFilter.in.includes(row.state)) return false;
    return true;
  };

  const db = {
    federationPeer: {
      findUnique: async () =>
        over.peer === undefined
          ? { peer_panel_id: "peer-b", endpoint_url: "http://panel-b:3000", status: "trusted" }
          : over.peer,
      findMany: async () => [],
    },
    federationPlacement: {
      findUnique: async (args: unknown) => {
        const where = (args as { where: { peer_panel_id_intent_id?: { peer_panel_id: string; intent_id: string } } }).where;
        const key = where.peer_panel_id_intent_id;
        if (!key) return null;
        return placements.find((p) => p.peer_panel_id === key.peer_panel_id && p.intent_id === key.intent_id) ?? null;
      },
      findFirst: async () => placements[0] ?? null,
      findMany: async (args: unknown) => {
        const where = ((args as { where?: Record<string, unknown> })?.where ?? {}) as Record<string, unknown>;
        return placements.filter((row) => matchesPlacement(row, where));
      },
      create: async (args: unknown) => {
        const data = (args as { data: Partial<FakePlacementRow> }).data;
        const row: FakePlacementRow = {
          id: nextId++,
          peer_panel_id: String(data.peer_panel_id),
          forward_ref: String(data.forward_ref),
          tunnel_id: data.tunnel_id ?? null,
          intent_id: String(data.intent_id),
          lease_ref: data.lease_ref ?? null,
          lease_epoch: Number(data.lease_epoch ?? 0),
          hop_role: String(data.hop_role),
          desired_revision: Number(data.desired_revision ?? 0),
          applied_revision: data.applied_revision ?? null,
          state: String(data.state ?? "pending"),
          peer_node_ref: data.peer_node_ref ?? null,
          peer_port: data.peer_port ?? null,
          last_error_code: data.last_error_code ?? null,
          last_error: data.last_error ?? null,
          expires_at: data.expires_at ?? null,
          created_at: new Date(),
          updated_at: new Date(),
        };
        placements.push(row);
        return row;
      },
      updateMany: async (args: unknown) => {
        const { where, data } = args as { where: { id: number }; data: Record<string, unknown> };
        const row = placements.find((p) => p.id === where.id);
        if (!row) return { count: 0 };
        Object.assign(row, data, { updated_at: new Date() });
        return { count: 1 };
      },
    },
    tunnel: {
      findUnique: async (args: unknown) => {
        const id = Number((args as { where: { id: number } }).where.id);
        return tunnels.find((t) => t.id === id) ?? null;
      },
      updateMany: async (args: unknown) => {
        const { where, data } = args as { where: { id: number }; data: Record<string, unknown> };
        const row = tunnels.find((t) => t.id === where.id);
        if (!row) return { count: 0 };
        tunnelWrites.push({ id: where.id, ...data });
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    forwardRollout: {
      findMany: async () => over.inFlightRollouts ?? [],
    },
    nodeStateReport: {
      findUnique: async (args: unknown) => {
        const nodeId = Number((args as { where: { node_id: number } }).where.node_id);
        return (over.reports ?? []).find((r) => r.node_id === nodeId) ?? null;
      },
    },
  } as unknown as ForwardHopDb;

  return { db, placements, tunnels, tunnelWrites };
}

/** 一条"联邦 RELAY Forward"的 tunnel 行投影（可见状态 + 声明）。 */
function federatedTunnel(over: Partial<FakeTunnelRow> = {}): FakeTunnelRow {
  return {
    id: 42,
    apply_status: "active",
    apply_error_code: null,
    apply_error: null,
    desired_status: "active",
    config_revision: 5,
    applied_revision: 5,
    ingress_node_id: 11,
    federated_egress_peer: "peer-b",
    ...over,
  };
}

/** 一条正对当代 revision 的 placement 行（`reconcileFederatedForwardHealth` 的输入）。 */
function placementRow(over: { tunnel_id?: number; desired_revision?: number; state?: string } = {}) {
  return {
    id: 1,
    peer_panel_id: "peer-b",
    forward_ref: "fw-42",
    tunnel_id: over.tunnel_id ?? 42,
    intent_id: `fw-${over.tunnel_id ?? 42}-${over.desired_revision ?? 5}`,
    lease_ref: "lease-1",
    lease_epoch: 1,
    hop_role: "egress",
    desired_revision: over.desired_revision ?? 5,
    applied_revision: over.desired_revision ?? 5,
    state: over.state ?? "active",
    peer_node_ref: "91",
    peer_port: 22015,
    last_error_code: null,
    last_error: null,
    expires_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  } as FakePlacementRow;
}

interface SentCall {
  method: string;
  path: string;
  body: unknown;
}

/** 一个可编程的假 transport：按 (method, path) 决定响应，并记录每一次调用。 */
function fakeSender(
  handler: (call: SentCall) => ForwardHopSendOutcome | Promise<ForwardHopSendOutcome>,
): { sender: ForwardHopSender; calls: SentCall[] } {
  const calls: SentCall[] = [];
  const sender: ForwardHopSender = async (input) => {
    const call: SentCall = { method: input.method, path: input.path, body: input.body };
    calls.push(call);
    return handler(call);
  };
  return { sender, calls };
}

const OK: ForwardHopSendOutcome = { ok: true, status: 200, body: { ok: true }, messageId: "m1" };

function reserveBodyObject(leaseRef = "lease-1"): Record<string, unknown> {
  return {
    lease_ref: leaseRef,
    lease_epoch: 7,
    state: "reserved",
    node_ref: "91",
    node_address: "203.0.113.77",
    port: 22015,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    applied_revision: null,
    replayed: false,
    reused: false,
  };
}

function reserveBody(leaseRef = "lease-1"): ForwardHopSendOutcome {
  return { ok: true, status: 200, messageId: "m1", body: reserveBodyObject(leaseRef) };
}

function applyBody(revision: number, leaseEpoch = 7): ForwardHopSendOutcome {
  return {
    ok: true,
    status: 200,
    messageId: "m1",
    body: { ok: true, state: "active", applied_revision: revision, lease_epoch: leaseEpoch, replayed: false, node_ref: "91", port: 22015 },
  };
}

const REQUEST = {
  tunnelId: 42,
  revision: 5,
  declaredPeer: "peer-b",
  mode: "relay",
  ingress_node_id: 11,
  local_egress_node_id: null as number | null,
  middle_node_id: null as number | null,
  protocol: "tcp",
  targets: [{ host: "10.9.9.9", port: 8080, weight: 1, order_by: 10 }],
};

function deps(db: ForwardHopDb, sender: ForwardHopSender) {
  return { db, sender, federationEnabled: async () => true, now: () => new Date() };
}

/* ------------------------------------------------------------------ */
/* A. 确定性键                                                         */
/* ------------------------------------------------------------------ */

describe("A. 幂等键与引用（契约 §3.2）", () => {
  it("A1. intent_id = fw-<tunnelId>-<revision>，同一代 revision 永远是同一个键", () => {
    expect(federatedEgressIntentId(42, 5)).toBe("fw-42-5");
    expect(federatedEgressIntentId(42, 5)).toBe(federatedEgressIntentId(42, 5));
    // 不同 revision 必须是不同的键（它是"换一代"的最小区分），不同 Forward 也是。
    expect(federatedEgressIntentId(42, 6)).not.toBe(federatedEgressIntentId(42, 5));
    expect(federatedEgressIntentId(43, 5)).not.toBe(federatedEgressIntentId(42, 5));
  });

  it("A2. forward_ref 是 home 侧的不透明归属引用，不含任何 host 资源标识", () => {
    expect(federatedEgressForwardRef(42)).toBe("fw-42");
  });

  it("A3. 声明列的读取：空串/空白/非字符串一律按「未声明」处理（= 今天的行为）", () => {
    expect(federatedEgressPeerOf({ federated_egress_peer: "peer-b" })).toBe("peer-b");
    expect(federatedEgressPeerOf({ federated_egress_peer: "  peer-b  " })).toBe("peer-b");
    expect(federatedEgressPeerOf({ federated_egress_peer: "" })).toBeNull();
    expect(federatedEgressPeerOf({ federated_egress_peer: "   " })).toBeNull();
    expect(federatedEgressPeerOf({ federated_egress_peer: null })).toBeNull();
    expect(federatedEgressPeerOf({})).toBeNull();
    expect(federatedEgressPeerOf(null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* B. 拓扑 fail-closed（契约 §9）                                       */
/* ------------------------------------------------------------------ */

describe("B. 第一阶段边界：只允许一个远端 hop，且必须在 egress", () => {
  const base = {
    tunnelId: 42,
    revision: 5,
    mode: "relay",
    ingress_node_id: 11,
    local_egress_node_id: null,
    middle_node_id: null,
    protocol: "tcp",
  };

  it("B1. 合法形状放行", () => {
    expect(checkFederatedEgressTopology(base, "peer-b")).toEqual({ ok: true, peer_panel_id: "peer-b" });
  });

  it("B2. 未声明 peer ⇒ message_malformed（这个分支根本不该被调用）", () => {
    const r = checkFederatedEgressTopology(base, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("message_malformed");
  });

  it("B3. DIRECT / 非 relay ⇒ unsupported_topology", () => {
    const r = checkFederatedEgressTopology({ ...base, mode: "direct" }, "peer-b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_topology");
  });

  it("B4. 远端出口 + 中间跳（3+ 跳）⇒ unsupported_topology", () => {
    const r = checkFederatedEgressTopology({ ...base, middle_node_id: 33 }, "peer-b");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("unsupported_topology");
      expect(r.message).toContain("3+");
    }
  });

  it("B5. 本机出口与远端 peer 同时声明 ⇒ unsupported_topology（出口腿只能在一侧）", () => {
    const r = checkFederatedEgressTopology({ ...base, local_egress_node_id: 21 }, "peer-b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_topology");
  });

  it("B6. 缺入口 ⇒ unsupported_topology（第一阶段远端 ingress 未开放）", () => {
    const r = checkFederatedEgressTopology({ ...base, ingress_node_id: null }, "peer-b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unsupported_topology");
  });

  it("B7. tls ⇒ unsupported_topology（证书是节点本地文件，apply 形状承载不了）", () => {
    const r = checkFederatedEgressTopology({ ...base, protocol: "tls" }, "peer-b");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("unsupported_topology");
      expect(r.message).toContain("tls");
    }
  });

  it("B8. 从快照读拓扑：与本机出口/中间跳/模式的事实一致（含 tls 拒绝）", () => {
    const snapshot = {
      mode: "relay",
      ingress_node_id: 11,
      egress_node_id: null,
      middle_node_id: null,
      federated_egress_peer: "peer-b",
    };
    expect(checkFederatedEgressForSnapshot({ tunnelId: 42, revision: 5, snapshot, protocol: "tcp" })).toEqual({
      ok: true,
      peer_panel_id: "peer-b",
    });
    const tls = checkFederatedEgressForSnapshot({ tunnelId: 42, revision: 5, snapshot, protocol: "tls" });
    expect(tls.ok).toBe(false);
    if (!tls.ok) expect(tls.code).toBe("unsupported_topology");
  });

  it("B9. 目标集原样转述（不加不减字段）", () => {
    expect(federatedEgressTargetsOf([{ host: "h", port: 1, weight: 2, order_by: 3 }])).toEqual([
      { host: "h", port: 1, weight: 2, order_by: 3 },
    ]);
    expect(federatedEgressTargetsOf(null)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* C. 声明校验（可行动错误码，不发请求）                                  */
/* ------------------------------------------------------------------ */

describe("C. 声明的校验：peer 必须存在、trusted、且联邦已开启", () => {
  it("C1. 未声明 ⇒ ok(null)，且不读库", async () => {
    const { db } = fakeDb({ peer: null });
    expect(await validateFederatedEgressDeclaration(null, deps(db, fakeSender(() => reserveBody()).sender))).toEqual({
      ok: true,
      peer_panel_id: null,
    });
  });

  it("C2. peer 不存在 ⇒ peer_unknown", async () => {
    const { db } = fakeDb({ peer: null });
    const r = await validateFederatedEgressDeclaration("peer-x", deps(db, fakeSender(() => reserveBody()).sender));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("peer_unknown");
  });

  it("C3. peer 已撤销 ⇒ peer_revoked（重试无用，必须让管理员重新走信任）", async () => {
    const { db } = fakeDb({ peer: { peer_panel_id: "peer-b", endpoint_url: "http://b:3000", status: "revoked" } });
    const r = await validateFederatedEgressDeclaration("peer-b", deps(db, fakeSender(() => reserveBody()).sender));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("peer_revoked");
  });

  it("C4. peer 处于 pending ⇒ 未完成握手，同样不可用（peer_unknown）", async () => {
    const { db } = fakeDb({ peer: { peer_panel_id: "peer-b", endpoint_url: "http://b:3000", status: "pending" } });
    const r = await validateFederatedEgressDeclaration("peer-b", deps(db, fakeSender(() => reserveBody()).sender));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("peer_unknown");
  });

  it("C5. peer_panel_id 超长 ⇒ message_malformed", async () => {
    const { db } = fakeDb();
    const r = await validateFederatedEgressDeclaration("p".repeat(65), deps(db, fakeSender(() => reserveBody()).sender));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("message_malformed");
  });

  it("C6. 联邦功能未开启 ⇒ federation_disabled（且不读 peer 表）", async () => {
    const { db } = fakeDb();
    const r = await validateFederatedEgressDeclaration("peer-b", {
      db,
      sender: fakeSender(() => reserveBody()).sender,
      federationEnabled: async () => false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("federation_disabled");
  });
});

/* ------------------------------------------------------------------ */
/* D. 两阶段：reserve → apply → 镜像                                     */
/* ------------------------------------------------------------------ */

describe("D. 委托一条远端出口腿（契约 §3.2 两阶段）", () => {
  it("D1. 正常路径：reserve → apply → 返回 host 的地址作为 next_hop", async () => {
    const { db, placements } = fakeDb();
    const { sender, calls } = fakeSender((call) =>
      call.path.endsWith("/apply") ? applyBody(5) : reserveBody(),
    );

    const outcome = await delegateFederatedEgress(REQUEST, deps(db, sender));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // next_hop 只能来自 host 的响应（node_address + port），**不许猜 IP**。
    expect(outcome.next_hop).toBe("203.0.113.77:22015");
    expect(outcome.lease_ref).toBe("lease-1");
    expect(outcome.applied_revision).toBe(5);
    expect(outcome.node_ref).toBe("91");

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/federation/v1/leases",
      "POST /api/federation/v1/leases/lease-1/apply",
    ]);

    // 请求体形状必须与 host 路由的契约一致：`intent` 是对象，不是扁平字段。
    const reserveCall = calls[0]!;
    expect(reserveCall.body).toEqual({
      intent: {
        intent_id: "fw-42-5",
        revision: 5,
        hop_role: "egress",
        forward_ref: "fw-42",
        requested: undefined,
      },
    });
    const applyCall = calls[1]!;
    expect(applyCall.body).toEqual({
      intent_id: "fw-42-5",
      revision: 5,
      targets: [{ host: "10.9.9.9", port: 8080, weight: 1, order_by: 10 }],
      lb_strategy: null,
      protocol: "tcp",
    });

    // 镜像行：唯一键 (peer, intent)，desired_revision = 本机这一代的 revision。
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({
      peer_panel_id: "peer-b",
      intent_id: "fw-42-5",
      forward_ref: "fw-42",
      tunnel_id: 42,
      hop_role: "egress",
      desired_revision: 5,
      lease_ref: "lease-1",
      lease_epoch: 7,
      applied_revision: 5,
      state: "active",
      peer_node_ref: "91",
      peer_port: 22015,
    });
  });

  it("D2. host 说这一代 revision 已经应用过 ⇒ 不再重复 apply（幂等重放）", async () => {
    const { db } = fakeDb();
    const { sender, calls } = fakeSender((call) =>
      call.path.endsWith("/apply")
        ? applyBody(5)
        : { ok: true as const, status: 200, messageId: "m1", body: { ...reserveBodyObject(), state: "active", applied_revision: 5, replayed: true } },
    );

    const outcome = await delegateFederatedEgress(REQUEST, deps(db, sender));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.replayed).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(["/api/federation/v1/leases"]);
  });

  it("D3. peer 不可达 ⇒ peer_unreachable + 镜像降级；**不回落本地**（没有任何本地副作用可回落）", async () => {
    const { db, placements } = fakeDb();
    const { sender, calls } = fakeSender(() => ({
      ok: false,
      code: "peer_unreachable",
      status: 0,
      message: "超时",
      retryable: true,
      messageId: "m1",
    }));

    const outcome = await delegateFederatedEgress(REQUEST, deps(db, sender));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("peer_unreachable");
      expect(outcome.retryable).toBe(true);
      // 没有远端租约 ⇒ 没有可释放的东西。
      expect(outcome.lease_ref).toBeNull();
      expect(outcome.compensated).toBe(true);
    }
    expect(calls).toHaveLength(1);
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ intent_id: "fw-42-5", desired_revision: 5, state: "degraded", last_error_code: "peer_unreachable" });
  });

  it("D4. 未开启联邦 ⇒ 一行请求都不发（fail-closed 在本地）", async () => {
    const { db, placements } = fakeDb();
    const { sender, calls } = fakeSender(() => reserveBody());
    const outcome = await delegateFederatedEgress({ ...REQUEST, protocol: "tls" }, deps(db, sender));
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(placements).toHaveLength(0);
  });

  it("D5. 同 revision 的 placement 已终态 ⇒ 不复活 intent、不重新 reserve", async () => {
    const made = fakeDb();
    made.placements.push(placementRow({ state: "expired" }));
    const { sender, calls } = fakeSender(() => reserveBody());

    const outcome = await delegateFederatedEgress(REQUEST, deps(made.db, sender));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("lease_expired");
      expect(outcome.message).toContain("终态 expired");
    }
    expect(calls).toHaveLength(0);
    expect(made.placements[0]!.state).toBe("expired");
  });
});

/* ------------------------------------------------------------------ */
/* E. 失败补偿：不许在对面留孤儿                                          */
/* ------------------------------------------------------------------ */

describe("E. 补偿：apply 失败必须立刻释放远端腿（契约 §3.3）", () => {
  it("E1. apply 失败 ⇒ DELETE /leases/:ref（同一 intent），镜像降级，compensated=true", async () => {
    const { db, placements } = fakeDb();
    const { sender, calls } = fakeSender((call) => {
      if (call.path.endsWith("/apply")) {
        return { ok: false, code: "quota_exhausted", status: 429, message: "容量耗尽", retryable: false, messageId: "m2" };
      }
      if (call.method === "DELETE") return OK as ForwardHopSendOutcome;
      return reserveBody();
    });

    const outcome = await delegateFederatedEgress(REQUEST, deps(db, sender));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("quota_exhausted");
      expect(outcome.lease_ref).toBe("lease-1");
      expect(outcome.compensated).toBe(true);
    }
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/federation/v1/leases",
      "POST /api/federation/v1/leases/lease-1/apply",
      "DELETE /api/federation/v1/leases/lease-1",
    ]);
    expect(placements[0]).toMatchObject({ lease_ref: "lease-1", state: "degraded", last_error_code: "quota_exhausted" });
  });

  it("E2. 补偿自身失败 ⇒ compensated=false（必须让对账/运维看见残留风险）", async () => {
    const { db } = fakeDb();
    const { sender, calls } = fakeSender((call) => {
      if (call.path.endsWith("/apply")) {
        return { ok: false, code: "internal_error", status: 500, message: "对面炸了", retryable: true, messageId: "m3" };
      }
      if (call.method === "DELETE") {
        return { ok: false, code: "peer_unreachable", status: 0, message: "超时", retryable: true, messageId: "m4" };
      }
      return reserveBody();
    });

    const outcome = await delegateFederatedEgress(REQUEST, deps(db, sender));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.compensated).toBe(false);
      expect(outcome.compensation_error).toBeTruthy();
      expect(outcome.lease_ref).toBe("lease-1");
    }
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("E3. reserve 的响应形状不认识 ⇒ 不释放（可能已经建成），标 degraded 交给对账重发", async () => {
    const { db, placements } = fakeDb();
    const { sender, calls } = fakeSender((call) => {
      if (call.method === "DELETE") return OK;
      return { ok: true as const, status: 200, messageId: "m1", body: { unexpected: true } };
    });

    const outcome = await delegateFederatedEgress(REQUEST, deps(db, sender));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("message_malformed");
      // **关键**：没有 lease_ref 可释放，也绝不能盲目 DELETE。
      expect(outcome.compensated).toBe(false);
      expect(outcome.lease_ref).toBeNull();
    }
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(placements[0]).toMatchObject({ state: "degraded", last_error_code: "message_malformed" });
  });

  it("E4. apply 的响应形状不认识 ⇒ **不释放**（结果未知 ≠ 失败），保留租约等对账收敛", async () => {
    const { db, placements } = fakeDb();
    const { sender, calls } = fakeSender((call) => {
      if (call.method === "DELETE") return OK;
      if (call.path.endsWith("/apply")) return { ok: true as const, status: 200, messageId: "m1", body: { unexpected: true } };
      return reserveBody();
    });

    const outcome = await delegateFederatedEgress(REQUEST, deps(db, sender));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.lease_ref).toBe("lease-1");
      expect(outcome.compensated).toBe(false);
    }
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(placements[0]).toMatchObject({ lease_ref: "lease-1", state: "degraded" });
    expect(placements[0]!.applied_revision).toBeNull();
  });

  it("E5. host 没给出可寻址地址 ⇒ next_hop=null（调用方必须 fail-closed，不许猜 IP）", async () => {
    const { db } = fakeDb();
    const { sender } = fakeSender((call) =>
      call.path.endsWith("/apply")
        ? applyBody(5)
        : { ok: true as const, status: 200, messageId: "m1", body: { ...reserveBodyObject(), node_address: null, port: null } },
    );

    const outcome = await delegateFederatedEgress(REQUEST, deps(db, sender));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.next_hop).toBeNull();
      expect(outcome.node_address).toBeNull();
    }
  });

  it("E6. reserve 已成功但本地 lease 镜像写失败 ⇒ 立即 DELETE 远端租约", async () => {
    const made = fakeDb();
    made.db.federationPlacement.updateMany = async () => {
      throw new Error("ledger write unavailable");
    };
    const { sender, calls } = fakeSender((call) => {
      if (call.method === "DELETE") return OK;
      return reserveBody();
    });

    const outcome = await delegateFederatedEgress(REQUEST, deps(made.db, sender));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("internal_error");
      expect(outcome.compensated).toBe(true);
      expect(outcome.lease_ref).toBe("lease-1");
      expect(outcome.message).toContain("本地 lease 镜像写入失败");
      expect(outcome.message).toContain("本地恢复账本缺失");
    }
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/federation/v1/leases",
      "DELETE /api/federation/v1/leases/lease-1",
    ]);
  });

  it("E7. apply 成功但 active 镜像写失败 ⇒ 补偿远端腿，不留下无法追踪的 active runtime", async () => {
    const made = fakeDb();
    const originalUpdate = made.db.federationPlacement.updateMany.bind(
      made.db.federationPlacement,
    );
    let writes = 0;
    made.db.federationPlacement.updateMany = async (args: unknown) => {
      writes++;
      if (writes === 2) throw new Error("active mirror unavailable");
      return originalUpdate(args);
    };
    const { sender, calls } = fakeSender((call) => {
      if (call.method === "DELETE") return OK;
      if (call.path.endsWith("/apply")) return applyBody(5);
      return reserveBody();
    });

    const outcome = await delegateFederatedEgress(REQUEST, deps(made.db, sender));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("internal_error");
      expect(outcome.compensated).toBe(true);
      expect(outcome.message).toContain("本地 active 镜像写入失败");
    }
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/federation/v1/leases",
      "POST /api/federation/v1/leases/lease-1/apply",
      "DELETE /api/federation/v1/leases/lease-1",
    ]);
    expect(made.placements[0]).toMatchObject({
      lease_ref: "lease-1",
      state: "degraded",
      last_error_code: "internal_error",
    });
  });

  it("E8. 主失败可见但 failure mirror 也失败 ⇒ 返回中明确暴露恢复账本缺失", async () => {
    const made = fakeDb();
    made.db.federationPlacement.updateMany = async () => {
      throw new Error("mirror db down");
    };
    const { sender } = fakeSender(() => ({
      ok: false,
      code: "peer_unreachable",
      status: 0,
      message: "peer timeout",
      retryable: true,
      messageId: "m-fail",
    }));

    const outcome = await delegateFederatedEgress(REQUEST, deps(made.db, sender));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe("peer_unreachable");
      expect(outcome.message).toContain("peer timeout");
      expect(outcome.message).toContain("本地恢复账本缺失");
      expect(outcome.message).toContain("mirror db down");
    }
  });
});

/* ------------------------------------------------------------------ */
/* G. 释放                                                             */
/* ------------------------------------------------------------------ */

describe("G. 释放：移除声明 / 改回本机出口 / 删除 Forward 共用同一个键", () => {
  it("G1. 按 (tunnel, revision) 找到镜像行并 DELETE，镜像落 expired", async () => {
    const { db, placements } = fakeDb();
    const { sender: reserveSender } = fakeSender((call) => (call.path.endsWith("/apply") ? applyBody(5) : reserveBody()));
    await delegateFederatedEgress(REQUEST, deps(db, reserveSender));
    expect(placements[0]!.state).toBe("active");

    const { sender, calls } = fakeSender(() => OK);
    const released = await releaseFederatedEgress({ tunnelId: 42, revision: 5 }, deps(db, sender));
    expect(released).toEqual({ ok: true, released: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /api/federation/v1/leases/lease-1"]);
    expect(placements[0]!.state).toBe("expired");
  });

  it("G2. 重复释放幂等：第二次仍然 ok（远端已是终态 = 已经没了）", async () => {
    const { db } = fakeDb();
    const { sender: reserveSender } = fakeSender((call) => (call.path.endsWith("/apply") ? applyBody(5) : reserveBody()));
    await delegateFederatedEgress(REQUEST, deps(db, reserveSender));

    const { sender } = fakeSender(() => ({
      ok: false,
      code: "lease_not_found",
      status: 404,
      message: "租约不存在",
      retryable: false,
      messageId: "m9",
    }));
    const released = await releaseFederatedEgress({ tunnelId: 42, revision: 5 }, deps(db, sender));
    expect(released.ok).toBe(true);
    expect(released.released).toBe(true);
  });

  it("G3. 没有镜像行、也没有 lease_ref ⇒ 没有可释放的远端资源（不是错误）", async () => {
    const { db } = fakeDb();
    const { sender, calls } = fakeSender(() => OK);
    const released = await releaseFederatedEgress({ tunnelId: 999, revision: 1 }, deps(db, sender));
    expect(released).toEqual({ ok: true, released: true });
    expect(calls).toHaveLength(0);
  });

  it("G4. peer 已被撤销 ⇒ 不发请求（host 会因信任撤销自行停服），但镜像要如实落 expired", async () => {
    const { db, placements } = fakeDb();
    const { sender: reserveSender } = fakeSender((call) => (call.path.endsWith("/apply") ? applyBody(5) : reserveBody()));
    await delegateFederatedEgress(REQUEST, deps(db, reserveSender));

    // 释放时 peer 已经是 revoked 状态（信任被撤销的典型时刻）。
    const revoked = fakeDb({ peer: { peer_panel_id: "peer-b", endpoint_url: "http://b:3000", status: "revoked" } });
    revoked.placements.push(...placements);
    const { sender, calls } = fakeSender(() => OK);
    const released = await releaseFederatedEgress({ tunnelId: 42, revision: 5 }, deps(revoked.db, sender));
    expect(calls).toHaveLength(0);
    expect(released.released).toBe(false);
    expect(released.code).toBe("peer_revoked");
    expect(revoked.placements[0]!.state).toBe("expired");
  });

  it("G5. lease_ref 由调用方直接给出（补偿路径不再查库也能释放）", async () => {
    // 镜像行不存在（例如崩溃在写镜像之前），但调用方记得 lease_ref + peer。
    const { db, placements } = fakeDb();
    const { sender, calls } = fakeSender(() => OK);
    const released = await releaseFederatedEgress(
      { tunnelId: 42, revision: 5, peer_panel_id: "peer-b", lease_ref: "lease-9" },
      deps(db, sender),
    );
    expect(released.ok).toBe(true);
    expect(placements).toHaveLength(0);
    expect(calls.map((c) => c.path)).toEqual(["/api/federation/v1/leases/lease-9"]);
  });

  it("G7. placement DB 读取失败不得伪装成“没有远端资源”成功", async () => {
    const made = fakeDb();
    made.db.federationPlacement.findMany = async () => {
      throw new Error("placement db unavailable");
    };
    const { sender, calls } = fakeSender(() => OK);

    const released = await releaseFederatedEgress(
      { tunnelId: 42, revision: 5 },
      deps(made.db, sender),
    );

    expect(released.ok).toBe(false);
    expect(released.released).toBe(false);
    expect(released.code).toBe("internal_error");
    expect(released.message).toContain("placement db unavailable");
    expect(calls).toHaveLength(0);
  });

  it("G8. 远端已释放但本地 expired 记账失败时返回部分成功，而不是假装完全收敛", async () => {
    const made = fakeDb();
    made.db.federationPlacement.findUnique = async () => {
      throw new Error("mirror write pre-read failed");
    };
    const { sender, calls } = fakeSender(() => OK);

    const released = await releaseFederatedEgress(
      {
        tunnelId: 42,
        revision: 5,
        peer_panel_id: "peer-b",
        lease_ref: "lease-9",
      },
      deps(made.db, sender),
    );

    expect(calls.map((c) => c.path)).toEqual(["/api/federation/v1/leases/lease-9"]);
    expect(released.ok).toBe(false);
    expect(released.released).toBe(true);
    expect(released.code).toBe("internal_error");
    expect(released.message).toContain("本地镜像记账失败");
  });

  it("G9. stale cleanup 的 placement 读取失败必须抛出，不能伪装 evaluated=0", async () => {
    const made = fakeDb();
    made.db.federationPlacement.findMany = async () => {
      throw new Error("stale placement db unavailable");
    };

    await expect(
      releaseStaleFederatedEgressForTunnel(42, 6, deps(made.db, fakeSender(() => OK).sender)),
    ).rejects.toThrow("stale placement db unavailable");
  });

  it("G10. stale cleanup 会检查全部非终态代，不用 take=20 截断后继续创建新一代", async () => {
    const made = fakeDb();
    for (let revision = 1; revision <= 25; revision++) {
      made.placements.push(placementRow({ desired_revision: revision, state: "active" }));
      made.placements.at(-1)!.intent_id = `fw-42-${revision}`;
      made.placements.at(-1)!.lease_ref = `lease-${revision}`;
    }
    const { sender, calls } = fakeSender(() => OK);

    const result = await releaseStaleFederatedEgressForTunnel(
      42,
      25,
      deps(made.db, sender),
    );

    expect(result.evaluated).toBe(25);
    expect(result.released).toBe(24);
    expect(result.failed).toEqual([]);
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(24);
  });

  it("G11. scheduler source treats stale cleanup as a hard precondition, never log-and-continue", async () => {
    const scheduler = await Bun.file(new URL("../scheduler.ts", import.meta.url).pathname).text();
    const start = scheduler.indexOf("let stale: Awaited<ReturnType<typeof releaseStaleFederatedEgressForTunnel>>");
    const end = scheduler.indexOf("const delegated = await delegateFederatedEgress", start);
    const block = scheduler.slice(start, end);

    expect(block).toContain("stale_release_lookup_failed");
    expect(block).toContain("SCHEDULER_ERROR_CODES.compensation_failed");
    expect(block).toContain("if (stale.failed.length > 0)");
    expect(block).toContain("return failAfterTeardown(");
    expect(block).not.toContain("ok: true");
  });

  it("G6. 行在但从未建成远端腿（reserve 就失败）⇒ 释放不得把 degraded 抹成 expired", async () => {
    // 这条守的是"可解释性"：reserve 失败留下的 degraded(unreachable) 是下一步动作的
    // 依据（等对账/等网络恢复）；把它写成 expired 会让它看起来像"这件事已经结束"。
    const { db, placements } = fakeDb();
    const { sender: failSender } = fakeSender(() => ({
      ok: false,
      code: "peer_unreachable",
      status: 0,
      message: "超时",
      retryable: true,
      messageId: "m0",
    }));
    await delegateFederatedEgress(REQUEST, deps(db, failSender));
    expect(placements[0]).toMatchObject({ state: "degraded", last_error_code: "peer_unreachable", lease_ref: null });

    const { sender, calls } = fakeSender(() => OK);
    const released = await releaseFederatedEgress({ tunnelId: 42, revision: 5 }, deps(db, sender));
    expect(released.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(placements[0]).toMatchObject({ state: "degraded", last_error_code: "peer_unreachable" });
  });
});

/* ------------------------------------------------------------------ */
/* H. 可见状态跟事实 + 通过既有 rollout 恢复整条腿（Gate 第二轮的 F1/F2）      */
/* ------------------------------------------------------------------ */

describe("H. 远端腿的生命周期驱动可见状态（F2：不得假活）", () => {
  it("H1. degraded ⇒ 可见状态写 error + 可解释原因；**desired / revision 一个字节不动**", async () => {
    const { db, placements, tunnels, tunnelWrites } = fakeDb({ tunnels: [federatedTunnel()] });
    placements.push(placementRow({ state: "degraded" }));

    const summary = await reconcileFederatedForwardHealth({}, { db, now: () => new Date() });
    expect(summary.marked_unhealthy).toBe(1);
    expect(summary.recovery_triggered).toBe(0);

    const tunnel = tunnels[0]!;
    expect(tunnel.apply_status).toBe("error");
    expect(tunnel.apply_error_code).toBe(FEDERATED_LEG_ERROR_CODES.degraded);
    // 只写这三列：改 error 绝不改写用户的期望状态与版本账本（V4 铁律）。
    expect(Object.keys(tunnelWrites[0]!).sort()).toEqual(
      ["apply_error", "apply_error_code", "apply_status", "id"].sort(),
    );
    expect(tunnel.desired_status).toBe("active");
    expect(tunnel.config_revision).toBe(5);
    expect(tunnel.applied_revision).toBe(5);
    // 用户可见文案里不得出现内部概念（grant / lease / epoch / peer_panel_id）。
    expect(tunnel.apply_error ?? "").not.toMatch(/grant|lease|epoch|peer-b/i);
  });

  it("H2. 幂等：状态已是目标值时不重复写（第二拍只记 already_unhealthy）", async () => {
    const { db, placements, tunnelWrites } = fakeDb({ tunnels: [federatedTunnel()] });
    placements.push(placementRow({ state: "degraded" }));
    await reconcileFederatedForwardHealth({}, { db, now: () => new Date() });
    const afterFirst = tunnelWrites.length;

    const second = await reconcileFederatedForwardHealth({}, { db, now: () => new Date() });
    expect(second.already_unhealthy).toBe(1);
    expect(second.marked_unhealthy).toBe(0);
    expect(tunnelWrites.length).toBe(afterFirst);
  });

  it("H3. expired / revoked / failed 各有自己的原因码（可解释、不混成一个 ERROR）", async () => {
    for (const [state, code] of [
      ["expired", FEDERATED_LEG_ERROR_CODES.expired],
      ["revoked", FEDERATED_LEG_ERROR_CODES.revoked],
      ["failed", FEDERATED_LEG_ERROR_CODES.failed],
    ] as const) {
      const { db, placements, tunnels } = fakeDb({ tunnels: [federatedTunnel()] });
      placements.push(placementRow({ state }));
      await reconcileFederatedForwardHealth({}, { db, now: () => new Date() });
      expect(tunnels[0]!.apply_error_code).toBe(code);
      expect(tunnels[0]!.apply_status).toBe("error");
    }
  });

  it("H4. pending / active 不算不健康（别在正常编辑窗口里闪一下「失败」）", async () => {
    for (const state of ["pending", "active"]) {
      const { db, placements, tunnelWrites } = fakeDb({ tunnels: [federatedTunnel()] });
      placements.push(placementRow({ state }));
      const summary = await reconcileFederatedForwardHealth(
        {},
        { db, now: () => new Date(), ingressRuntimePresent: async () => true },
      );
      expect(summary.marked_unhealthy).toBe(0);
      expect(tunnelWrites).toHaveLength(0);
    }
  });

  it("H5. 上一代 placement 的终态不驱动可见状态（只看当代那一行）", async () => {
    const { db, placements, tunnels } = fakeDb({ tunnels: [federatedTunnel({ config_revision: 6, applied_revision: 6 })] });
    // 旧一代（revision 5）已过期，但用户已经保存出第 6 代且它是活的。
    placements.push(placementRow({ desired_revision: 5, state: "expired" }));
    placements.push(placementRow({ desired_revision: 6, state: "active" }));

    const summary = await reconcileFederatedForwardHealth(
      {},
      { db, now: () => new Date(), ingressRuntimePresent: async () => true },
    );
    expect(summary.evaluated).toBe(1);
    expect(summary.marked_unhealthy).toBe(0);
    expect(tunnels[0]!.apply_status).toBe("active");
  });

  it("H6. suspended 是用户有意的可见状态，不被健康收口覆盖", async () => {
    const { db, placements, tunnels, tunnelWrites } = fakeDb({
      tunnels: [federatedTunnel({ apply_status: "suspended", desired_status: "inactive" })],
    });
    placements.push(placementRow({ state: "degraded" }));
    const summary = await reconcileFederatedForwardHealth({}, { db, now: () => new Date() });
    expect(summary.skipped).toBe(1);
    expect(tunnelWrites).toHaveLength(0);
    expect(tunnels[0]!.apply_status).toBe("suspended");
  });

  it("H7. 声明已移除（改回本机出口）⇒ 这里什么都不做（释放由编辑路径负责）", async () => {
    const { db, placements, tunnelWrites } = fakeDb({
      tunnels: [federatedTunnel({ federated_egress_peer: null })],
    });
    placements.push(placementRow({ state: "degraded" }));
    const summary = await reconcileFederatedForwardHealth({}, { db, now: () => new Date() });
    expect(summary.skipped).toBe(1);
    expect(tunnelWrites).toHaveLength(0);
  });
});

describe("H. 恢复必须重建整条腿（F1：只重建了远端半条腿）", () => {
  it("H8. 远端腿回到 active + 可见状态仍是我们写下的 error ⇒ 触发一次恢复 rollout（同一 revision）", async () => {
    const { db, placements } = fakeDb({
      tunnels: [federatedTunnel({ apply_status: "error", apply_error_code: FEDERATED_LEG_ERROR_CODES.degraded })],
    });
    placements.push(placementRow({ state: "active" }));
    const restarts: Array<{ tunnelId: number; revision: number; baseRevision: number | null }> = [];

    const summary = await reconcileFederatedForwardHealth({}, {
      db,
      now: () => new Date(),
      restartRollout: async (input) => {
        restarts.push(input);
        return { ok: true };
      },
    });

    expect(summary.recovery_triggered).toBe(1);
    // 恢复用**同一个 revision**（⇒ 同一个 intent_id ⇒ 对面不会出现第二条租约）。
    expect(restarts).toEqual([{ tunnelId: 42, revision: 5, baseRevision: 5 }]);
  });

  it("H9. 只触发一次：同一拍不会为同一条 Forward 重复触发", async () => {
    const { db, placements } = fakeDb({
      tunnels: [federatedTunnel({ apply_status: "error", apply_error_code: FEDERATED_LEG_ERROR_CODES.degraded })],
    });
    placements.push(placementRow({ state: "active" }));
    let calls = 0;
    await reconcileFederatedForwardHealth({}, {
      db,
      now: () => new Date(),
      restartRollout: async () => {
        calls++;
        return { ok: true };
      },
    });
    expect(calls).toBe(1);
  });

  it("H10. 可见状态说 active、远端在、但**本机入口腿不在**（F1 的原始形态）⇒ 同样触发恢复", async () => {
    const { db, placements } = fakeDb({ tunnels: [federatedTunnel()] });
    placements.push(placementRow({ state: "active" }));
    const restarts: number[] = [];

    const summary = await reconcileFederatedForwardHealth({}, {
      db,
      now: () => new Date(),
      ingressRuntimePresent: async () => false,
      restartRollout: async (input) => {
        restarts.push(input.revision);
        return { ok: true };
      },
    });
    expect(summary.recovery_triggered).toBe(1);
    expect(restarts).toEqual([5]);
  });

  it("H11. 本机入口腿在（Agent 快照里有它）⇒ 不触发（幂等、不制造噪声）", async () => {
    const { db, placements } = fakeDb({ tunnels: [federatedTunnel()] });
    placements.push(placementRow({ state: "active" }));
    const summary = await reconcileFederatedForwardHealth({}, {
      db,
      now: () => new Date(),
      ingressRuntimePresent: async () => true,
      restartRollout: async () => {
        throw new Error("不该触发");
      },
    });
    expect(summary.recovery_triggered).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it("H12. 快照过期/读不到（null = 不知道）⇒ 不据它触发", async () => {
    const { db, placements } = fakeDb({ tunnels: [federatedTunnel()] });
    placements.push(placementRow({ state: "active" }));
    const summary = await reconcileFederatedForwardHealth({}, {
      db,
      now: () => new Date(),
      ingressRuntimePresent: async () => null,
      restartRollout: async () => {
        throw new Error("不该触发");
      },
    });
    expect(summary.recovery_triggered).toBe(0);
  });

  it("H13. 恢复失败 ⇒ 记 recovery_failed，且**不**把可见状态假装成 active", async () => {
    const { db, placements, tunnels, tunnelWrites } = fakeDb({
      tunnels: [federatedTunnel({ apply_status: "error", apply_error_code: FEDERATED_LEG_ERROR_CODES.degraded })],
    });
    placements.push(placementRow({ state: "active" }));
    const summary = await reconcileFederatedForwardHealth({}, {
      db,
      now: () => new Date(),
      restartRollout: async () => ({ ok: false, code: "no_transport", message: "通道未就绪" }),
    });
    expect(summary.recovery_failed).toBe(1);
    expect(summary.recovery_triggered).toBe(0);
    expect(tunnelWrites).toHaveLength(0);
    expect(tunnels[0]!.apply_status).toBe("error");
  });

  it("H14. expired / revoked 是终态：只如实报状态，**不**自动恢复（要用户重新保存/重建信任）", async () => {
    for (const state of ["expired", "revoked"]) {
      const { db, placements, tunnels } = fakeDb({ tunnels: [federatedTunnel()] });
      placements.push(placementRow({ state }));
      const summary = await reconcileFederatedForwardHealth({}, {
        db,
        now: () => new Date(),
        restartRollout: async () => {
          throw new Error("终态不该触发恢复");
        },
      });
      expect(summary.recovery_triggered).toBe(0);
      expect(summary.marked_unhealthy).toBe(1);
      expect(federatedLegVisibleError(state)!.message).toMatch(/重新保存|重新建立信任/);
      expect(tunnels[0]!.apply_status).toBe("error");
    }
  });

  it("H15. 恢复影响面：只声明「入口监听重建」，**不**触发旧出口的 drain/drop", () => {
    // 这是"不产生第二份远端租约"的关键：egress_node_change=false 让计划器不生成
    // drain_egress / drop_old_egress（否则会先 DELETE 掉刚确认健康的远端租约）。
    expect(FEDERATED_RECOVERY_IMPACT.listener_replacement).toBe(true);
    expect(FEDERATED_RECOVERY_IMPACT.egress_node_change).toBe(false);
    expect(FEDERATED_RECOVERY_IMPACT.mode_change).toBe(false);
    expect(FEDERATED_RECOVERY_IMPACT.middle_node_change).toBe(false);
    expect(FEDERATED_RECOVERY_IMPACT.runtime_change).toBe(true);
  });

  it("H17. 已经有一次 rollout 在收敛 ⇒ 本拍不再触发第二次（不制造 phase 竞争与假告警）", async () => {
    const { db, placements } = fakeDb({
      tunnels: [federatedTunnel({ apply_status: "error", apply_error_code: FEDERATED_LEG_ERROR_CODES.degraded })],
      inFlightRollouts: [{ id: 77 }],
    });
    placements.push(placementRow({ state: "active" }));
    const summary = await reconcileFederatedForwardHealth({}, {
      db,
      now: () => new Date(),
      restartRollout: async () => {
        throw new Error("已有 rollout 在收敛时不该再触发");
      },
    });
    expect(summary.recovery_triggered).toBe(0);
    expect(summary.recovery_failed).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it("H18. 与另一个执行器竞争（rollout_in_progress）算跳过，不算恢复失败", async () => {
    const { db, placements } = fakeDb({
      tunnels: [federatedTunnel({ apply_status: "error", apply_error_code: FEDERATED_LEG_ERROR_CODES.degraded })],
    });
    placements.push(placementRow({ state: "active" }));
    const summary = await reconcileFederatedForwardHealth({}, {
      db,
      now: () => new Date(),
      restartRollout: async () => ({ ok: false, code: "rollout_in_progress", message: "已有正在进行的更新" }),
    });
    expect(summary.recovery_triggered).toBe(0);
    expect(summary.recovery_failed).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it("H19. placement ledger 读取失败必须抛给 Reconciler，不能返回全 0 假成功", async () => {
    const made = fakeDb({ tunnels: [federatedTunnel()] });
    made.db.federationPlacement.findMany = async () => {
      throw new Error("health placement db unavailable");
    };

    await expect(
      reconcileFederatedForwardHealth({}, { db: made.db, now: () => new Date() }),
    ).rejects.toThrow("health placement db unavailable");
  });

  it("H20. 可见状态写库失败必须抛出，marked_unhealthy 不能假增", async () => {
    const made = fakeDb({ tunnels: [federatedTunnel()] });
    made.placements.push(placementRow({ state: "degraded" }));
    made.db.tunnel!.updateMany = async () => {
      throw new Error("tunnel status write failed");
    };

    await expect(
      reconcileFederatedForwardHealth({}, { db: made.db, now: () => new Date() }),
    ).rejects.toThrow("tunnel status write failed");
    expect(made.tunnels[0]!.apply_status).toBe("active");
  });

  it("H21. CAS 丢失表示并发状态已变化：跳过，不声称 marked_unhealthy", async () => {
    const made = fakeDb({ tunnels: [federatedTunnel()] });
    made.placements.push(placementRow({ state: "degraded" }));
    made.db.tunnel!.updateMany = async () => ({ count: 0 });

    const summary = await reconcileFederatedForwardHealth(
      {},
      { db: made.db, now: () => new Date() },
    );

    expect(summary.marked_unhealthy).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(made.tunnels[0]!.apply_status).toBe("active");
  });

  it("H22. rollout ledger 读取失败时不触发第二次恢复", async () => {
    const made = fakeDb({
      tunnels: [
        federatedTunnel({
          apply_status: "error",
          apply_error_code: FEDERATED_LEG_ERROR_CODES.degraded,
        }),
      ],
    });
    made.placements.push(placementRow({ state: "active" }));
    made.db.forwardRollout!.findMany = async () => {
      throw new Error("rollout ledger unavailable");
    };
    let restarts = 0;

    await expect(
      reconcileFederatedForwardHealth(
        {},
        {
          db: made.db,
          now: () => new Date(),
          restartRollout: async () => {
            restarts++;
            return { ok: true };
          },
        },
      ),
    ).rejects.toThrow("rollout ledger unavailable");
    expect(restarts).toBe(0);
  });

  it("H16. 读取器可选：没有 tunnel 端口时安全返回（不抛）", async () => {
    const db = { federationPlacement: { findMany: async () => [] } } as unknown as ForwardHopDb;
    const summary = await reconcileFederatedForwardHealth({}, { db });
    expect(summary).toEqual({
      evaluated: 0,
      marked_unhealthy: 0,
      already_unhealthy: 0,
      recovery_triggered: 0,
      recovery_failed: 0,
      skipped: 0,
    });
  });
});
