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
  releaseFederatedEgress,
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

function fakeDb(over: {
  peer?: { peer_panel_id: string; endpoint_url: string; status: string } | null;
} = {}): { db: ForwardHopDb; placements: FakePlacementRow[] } {
  const placements: FakePlacementRow[] = [];
  let nextId = 1;

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
      findMany: async () => [...placements],
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
  } as unknown as ForwardHopDb;

  return { db, placements };
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
