/**
 * V4-WP1 — Forward Revision Foundation 离线测试（不连 MySQL / Redis / 网络）。
 *
 * 依据 `DEVELOPMENT.md` §13.3.2（Revision Snapshot）、§13.3.3（Update API 与
 * 并发控制）、§13.3.4（Hot Reload 分类）。
 *
 * 覆盖矩阵：
 *   A. **单一校验实现**（§13.3.3 硬约束）：preview 与 update 必须调用同一组
 *      校验函数；这里钉死「同一候选 config → 同一 validation」。
 *   B. **合并优先于校验**：partial patch 不产生半配置；显式 null 是合法语义
 *      （listen_port:null = 自动分配）。
 *   C. **纯 metadata 不生成 revision**（§13.3.2）：改名不 bump、不收敛 runtime。
 *   D. **唯一性**：同一 (tunnel_id, revision) 唯一；P2002 → 409 revision_conflict
 *      + latest_revision（§13.3.3「返回/提示最新 revision」）。
 *   E. **互斥规则**：direct 禁 egress、relay 必须有 egress、同节点入口=出口
 *      拒绝、RELAY 目标 host/port 必须成对。
 *   F. **端口规则**：黑名单、越界、自动分配需节点区间。
 *   G. **影响面分类**与 §13.3.4 表逐行对应：target 热换不重建 listener；
 *      端口/入口节点/模式切换需要 listener replacement。
 *   H. **外部地址预测**：无法确定时不猜（返回 null）。
 */
import { describe, expect, test } from "bun:test";
import {
  FORWARD_REVISION_ERROR_STATUS,
  ForwardRevisionError,
  computeForwardImpact,
  currentDesiredConfig,
  ensureForwardBaselineRevision,
  handleRevisionConflict,
  isMetadataOnlyPatch,
  mergeForwardCandidate,
  nextRevisionNumber,
  normalizeForwardName,
  normalizeForwardPort,
  normalizeTargetHost,
  predictExternalAddress,
  targetAddress,
  validateForwardCandidate,
  validateForwardCandidateFull,
  type ForwardCandidateConfig,
  type ForwardCandidateContext,
  type ForwardRevisionRow,
} from "../forward-revision.ts";

/* ------------------------------------------------------------------ */
/* 夹具                                                                 */
/* ------------------------------------------------------------------ */

const BASE_CONFIG: ForwardCandidateConfig = {
  name: "web-prod",
  mode: "direct",
  ingress_node_id: 11,
  egress_node_id: null,
  listen_port: 19001,
  target_host: "10.0.0.10",
  target_port: 8080,
};

/** 一条「当前 desired」的 tunnel 行投影（存量行形态：无 snapshot）。 */
function row(over: Partial<ForwardRevisionRow> = {}): ForwardRevisionRow {
  const base: ForwardRevisionRow = {
    id: 501,
    workspace_id: 7,
    name: "web-prod",
    tunnel_mode: "direct",
    ingress_node_id: 11,
    egress_node_id: null,
    ingress_node: { id: 11, node_id: "ing-1", role: "ingress" },
    egress_node: null,
    egress_pool: null,
    listen_ip: "0.0.0.0",
    listen_port: 19001,
    remote_host: "10.0.0.10",
    remote_port: 8080,
    egress_port: null,
    desired_status: "active",
    apply_status: "active",
    config_revision: 3,
    applied_revision: 3,
    desired_revision_id: null,
  };
  return { ...base, ...over };
}

/** 健康上下文：ingress 有入口能力、egress 有出口能力、端口空闲、binding 存在。 */
function ctx(over: Partial<ForwardCandidateContext> = {}): ForwardCandidateContext {
  return {
    ingress: { id: 11, node_id: "ing-1", role: "ingress", connect_ip: "203.0.113.9" },
    egress: { id: 22, node_id: "egr-1", role: "egress" },
    portHolders: [],
    bindingExists: true,
    ingressRangeConfigured: true,
    ...over,
  };
}

/** 影响面的默认输入（current = candidate 时全 false）。 */
function impactInput(over: Partial<Parameters<typeof computeForwardImpact>[0]> = {}) {
  return {
    current: BASE_CONFIG,
    candidate: BASE_CONFIG,
    ingressNodeId: "ing-1",
    egressNodeId: null,
    currentIngressNodeId: "ing-1",
    currentEgressNodeId: null,
    ingressConnectIp: "203.0.113.9",
    resolvedListenPort: 19001,
    currentResolvedListenPort: 19001,
    bindingRequired: false,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* A. 合并 / 抽取                                                      */
/* ------------------------------------------------------------------ */

describe("A. 合并得到完整候选 config（§13.3.3）", () => {
  test("A1. partial patch 只改目标端口，其余沿用当前 desired", () => {
    const merged = mergeForwardCandidate(BASE_CONFIG, { target_port: 9090 });
    expect(merged).toEqual({ ...BASE_CONFIG, target_port: 9090 });
    expect(isMetadataOnlyPatch(BASE_CONFIG, merged)).toBe(false);
  });

  test("A2. 空 patch 不产生任何变化（等效于 metadata-only）", () => {
    const merged = mergeForwardCandidate(BASE_CONFIG, {});
    expect(merged).toEqual(BASE_CONFIG);
    expect(isMetadataOnlyPatch(BASE_CONFIG, merged)).toBe(true);
  });

  test("A3. 显式 listen_port:null 是「自动分配」语义，不是「未提供」", () => {
    const merged = mergeForwardCandidate(BASE_CONFIG, { listen_port: null });
    expect(merged.listen_port).toBeNull();
    // 与 BASE 的 19001 不同 → 是运行时变化（端口至少会被重新决定）。
    expect(isMetadataOnlyPatch(BASE_CONFIG, merged)).toBe(false);
  });

  test("A4. 从存量行抽取 current desired config（无 snapshot 的兼容路径）", () => {
    expect(currentDesiredConfig(row())).toEqual(BASE_CONFIG);
  });

  test("A5. 改名是唯一的纯 metadata 修改", () => {
    const merged = mergeForwardCandidate(BASE_CONFIG, { name: "renamed" });
    expect(merged.name).toBe("renamed");
    expect(isMetadataOnlyPatch(BASE_CONFIG, merged)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* B. 校验（preview 与 update 共用同一实现）                            */
/* ------------------------------------------------------------------ */

describe("B. 校验规则", () => {
  test("B1. 合法 direct 候选通过", () => {
    expect(validateForwardCandidate(BASE_CONFIG).ok).toBe(true);
  });

  test("B2. direct 指定 egress_node_id 被拒", () => {
    const v = validateForwardCandidate({ ...BASE_CONFIG, egress_node_id: 22 });
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain("DIRECT");
    expect(v.reasons).toContain("mode_topology_mismatch");
  });

  test("B3. relay 缺 egress_node_id 被拒", () => {
    const v = validateForwardCandidate({ ...BASE_CONFIG, mode: "relay", egress_node_id: null });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain("missing_egress");
  });

  test("B4. ingress 与 egress 同节点被拒", () => {
    const v = validateForwardCandidate({ ...BASE_CONFIG, mode: "relay", egress_node_id: 11, target_host: null, target_port: null });
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain("same_ingress_egress");
  });

  test("B5. RELAY 目标 host/port 必须成对", () => {
    const onlyHost = validateForwardCandidate({
      ...BASE_CONFIG, mode: "relay", egress_node_id: 22, target_host: "10.0.0.9", target_port: null,
    });
    expect(onlyHost.ok).toBe(false);
    expect(onlyHost.reasons).toContain("incomplete_target");

    const onlyPort = validateForwardCandidate({
      ...BASE_CONFIG, mode: "relay", egress_node_id: 22, target_host: null, target_port: 443,
    });
    expect(onlyPort.ok).toBe(false);
    expect(onlyPort.reasons).toContain("incomplete_target");
  });

  test("B6. 端口越界与黑名单被拒（含用户指定）", () => {
    expect(validateForwardCandidate({ ...BASE_CONFIG, listen_port: 70000 }).reasons).toContain("port_invalid");
    expect(validateForwardCandidate({ ...BASE_CONFIG, listen_port: 22 }).reasons).toContain("port_invalid");
    expect(validateForwardCandidate({ ...BASE_CONFIG, listen_port: 80 }).reasons).toContain("port_invalid");
  });

  test("B7. 名称归一化：trim、空、超长", () => {
    expect(normalizeForwardName("  web  ")).toBe("web");
    expect(normalizeForwardName("")).toBeNull();
    expect(normalizeForwardName("x".repeat(61))).toBeNull();
  });

  test("B8. host / port 归一化", () => {
    expect(normalizeTargetHost(" 10.0.0.1 ")).toBe("10.0.0.1");
    expect(normalizeTargetHost("")).toBeNull();
    expect(normalizeForwardPort(0)).toEqual({ ok: false, reason: expect.any(String), code: "port_invalid" });
    expect(normalizeForwardPort(65536).ok).toBe(false);
    expect(normalizeForwardPort(null)).toEqual({ ok: true, port: null });
  });

  test("B9. 读库校验：入口无入口能力 / 端口被占 / 未配区间", () => {
    const noRole = validateForwardCandidateFull(
      BASE_CONFIG,
      ctx({ ingress: { id: 11, node_id: "ing-1", role: null, connect_ip: null } }),
    );
    expect(noRole.ok).toBe(false);
    expect(noRole.reasons).toContain("node_unavailable");

    const taken = validateForwardCandidateFull(
      BASE_CONFIG,
      ctx({ portHolders: [{ tunnel_id: 777, port: 19001 }] }),
    );
    expect(taken.ok).toBe(false);
    expect(taken.reasons).toContain("port_conflict");

    const noRange = validateForwardCandidateFull(
      { ...BASE_CONFIG, listen_port: null },
      ctx({ ingressRangeConfigured: false }),
    );
    expect(noRange.ok).toBe(false);
    expect(noRange.reasons).toContain("node_unavailable");
  });

  test("B10. RELAY 未绑定 ingress→egress 被阻断（binding_required）", () => {
    const v = validateForwardCandidateFull(
      { ...BASE_CONFIG, mode: "relay", egress_node_id: 22, target_host: null, target_port: null },
      ctx({ bindingExists: false }),
    );
    expect(v.ok).toBe(false);
    expect(v.reasons).toContain("binding_required");
    expect(FORWARD_REVISION_ERROR_STATUS.binding_required).toBe(409);
  });

  test("B11. 纯校验失败时不做读库校验（短路）", () => {
    const v = validateForwardCandidateFull({ ...BASE_CONFIG, listen_port: 0 }, null);
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(["port_invalid"]);
  });
});

/* ------------------------------------------------------------------ */
/* C. 影响面（§13.3.4 分类表）                                         */
/* ------------------------------------------------------------------ */

describe("C. preview 影响面（§13.3.4）", () => {
  test("C1. 无变化 → metadata_only", () => {
    const impact = computeForwardImpact(impactInput());
    expect(impact.metadata_only).toBe(true);
    expect(impact.runtime_change).toBe(false);
    expect(impact.listener_replacement).toBe(false);
    expect(impact.changes_external_address).toBe(false);
    expect(impact.nodes_prepare_drain).toEqual([]);
  });

  test("C2. target host/port 热换：不重建 listener、不改外部地址", () => {
    const impact = computeForwardImpact(
      impactInput({ candidate: { ...BASE_CONFIG, target_host: "10.0.0.20", target_port: 9090 } }),
    );
    expect(impact.target_change).toBe(true);
    expect(impact.listener_replacement).toBe(false);
    expect(impact.changes_external_address).toBe(false);
    expect(impact.metadata_only).toBe(false);
  });

  test("C3. 换 listen port：外部端口改变 + listener replacement", () => {
    const impact = computeForwardImpact(
      impactInput({
        candidate: { ...BASE_CONFIG, listen_port: 19100 },
        resolvedListenPort: 19100,
      }),
    );
    expect(impact.listen_port_change).toBe(true);
    expect(impact.listener_replacement).toBe(true);
    expect(impact.changes_external_address).toBe(true);
    expect(impact.nodes_prepare_drain).toEqual(["ing-1"]);
  });

  test("C4. 换 ingress 节点：旧节点进 DRAIN，外部地址可能改变", () => {
    const impact = computeForwardImpact(
      impactInput({
        candidate: { ...BASE_CONFIG, ingress_node_id: 12 },
        ingressNodeId: "ing-2",
      }),
    );
    expect(impact.ingress_node_change).toBe(true);
    expect(impact.listener_replacement).toBe(true);
    expect(impact.changes_external_address).toBe(true);
    // 新入口 + 旧入口都要动（先 PREPARE 新、后 DRAIN 旧）。
    expect(impact.nodes_prepare_drain.sort()).toEqual(["ing-1", "ing-2"]);
  });

  test("C5. direct → relay：模式切换走完整重下发，两端节点入集", () => {
    const impact = computeForwardImpact(
      impactInput({
        candidate: { ...BASE_CONFIG, mode: "relay", egress_node_id: 22, target_host: null, target_port: null },
        egressNodeId: "egr-1",
      }),
    );
    expect(impact.mode_change).toBe(true);
    expect(impact.listener_replacement).toBe(true);
    expect(impact.nodes_prepare_drain.sort()).toEqual(["egr-1", "ing-1"]);
  });

  test("C6. relay → direct：出口节点从集合退出", () => {
    const relayCurrent: ForwardCandidateConfig = {
      ...BASE_CONFIG, mode: "relay", egress_node_id: 22, target_host: null, target_port: null,
    };
    const impact = computeForwardImpact(
      impactInput({
        current: relayCurrent,
        candidate: { ...BASE_CONFIG, target_host: "10.0.0.30", target_port: 8080 },
        egressNodeId: null,
        currentEgressNodeId: "egr-1",
      }),
    );
    expect(impact.mode_change).toBe(true);
    expect(impact.listener_replacement).toBe(true);
    // 旧出口要被撤掉（CLEANUP），因此仍在 prepare/drain 集合里。
    expect(impact.nodes_prepare_drain).toContain("egr-1");
  });

  test("C7. 自动分配端口时 port_status=auto 且不猜外部地址", () => {
    const impact = computeForwardImpact(
      impactInput({
        candidate: { ...BASE_CONFIG, listen_port: null },
        resolvedListenPort: null,
      }),
    );
    expect(impact.port_status).toBe("auto");
    expect(impact.desired_address).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* D. 外部地址预测                                                      */
/* ------------------------------------------------------------------ */

describe("D. 外部访问地址预测", () => {
  test("D1. connect_ip 含多地址时取第一个；端口确定才返回", () => {
    expect(predictExternalAddress(BASE_CONFIG, { connect_ip: "203.0.113.9, 198.51.100.2" }, 19001)).toBe(
      "203.0.113.9:19001",
    );
  });

  test("D2. 无法确定时不猜（无 IP / 无端口）", () => {
    expect(predictExternalAddress(BASE_CONFIG, { connect_ip: null }, 19001)).toBeNull();
    expect(predictExternalAddress(BASE_CONFIG, { connect_ip: "203.0.113.9" }, null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* E. revision 账本与并发冲突                                          */
/* ------------------------------------------------------------------ */

describe("E. revision 号与 409", () => {
  test("E1. nextRevision 取 config_revision 与 snapshot max 的较大者 +1", () => {
    expect(nextRevisionNumber({ configRevision: 3, maxSnapshotRevision: null })).toBe(4);
    expect(nextRevisionNumber({ configRevision: 3, maxSnapshotRevision: 9 })).toBe(10);
    expect(nextRevisionNumber({ configRevision: null, maxSnapshotRevision: null })).toBe(1);
  });

  test("E2. P2002 → 409 revision_conflict + latest_revision", () => {
    const err = new ForwardRevisionError("revision_conflict", "x", { latest_revision: 7 });
    expect(err.status).toBe(409);
    expect(err.code).toBe("revision_conflict");

    const p2002 = Object.assign(new Error("dup"), { code: "P2002" });
    const translated = handleRevisionConflict(p2002, 7);
    expect(translated.code).toBe("revision_conflict");
    expect(translated.status).toBe(409);
    expect(translated.data?.latest_revision).toBe(7);
  });

  test("E3. 非 P2002 的异常原样抛出（不篡改真实故障）", () => {
    const boom = new Error("connection lost");
    expect(() => handleRevisionConflict(boom, 1)).toThrow("connection lost");
  });

  test("E4. 其它错误码的 HTTP 映射稳定", () => {
    expect(FORWARD_REVISION_ERROR_STATUS.not_found).toBe(404);
    expect(FORWARD_REVISION_ERROR_STATUS.invalid_input).toBe(400);
    expect(FORWARD_REVISION_ERROR_STATUS.port_conflict).toBe(409);
    expect(FORWARD_REVISION_ERROR_STATUS.db_unavailable).toBe(503);
  });
});

/* ------------------------------------------------------------------ */
/* F. 冻结字段完整性（§13.3.2 要求逐项可恢复）                          */
/* ------------------------------------------------------------------ */

describe("F. snapshot 契约形状", () => {
  test("F1. 候选 config 承载 §13.3.2 全部运行态字段", () => {
    // mode / ingress / egress / listen_port(含 auto) / target_host / target_port
    const keys = Object.keys(BASE_CONFIG).sort();
    expect(keys).toEqual([
      "egress_node_id",
      "ingress_node_id",
      "listen_port",
      "mode",
      "name",
      "target_host",
      "target_port",
    ]);
  });

  test("F2. targetAddress 对 IPv6 加方括号", () => {
    expect(targetAddress("10.0.0.1", 8080)).toBe("10.0.0.1:8080");
    expect(targetAddress("::1", 8080)).toBe("[::1]:8080");
    expect(targetAddress("[::1]", 8080)).toBe("[::1]:8080");
  });
});


/* ------------------------------------------------------------------ */
/* G. create/retry 后 baseline snapshot                                */
/* ------------------------------------------------------------------ */

describe("G. applied baseline snapshot", () => {
  function baselineClient(over: Record<string, unknown> = {}) {
    const tunnel: Record<string, unknown> = {
      id: 501,
      category: "port_forward",
      name: "web-prod",
      tunnel_mode: "direct",
      ingress_node_id: 11,
      egress_node_id: null,
      listen_ip: "0.0.0.0",
      listen_port: 19001,
      remote_host: "10.0.0.10",
      remote_port: 8080,
      egress_pool_id: null,
      egress_port: null,
      config_revision: 3,
      applied_revision: 3,
      desired_revision_id: null,
      desired_status: "active",
      ...over,
    };
    const snapshots: Array<{ id: number; data: Record<string, unknown> }> = [];
    const client = {
      tunnel: {
        findUnique: async () => ({ ...tunnel }),
        updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const matches = Object.entries(args.where).every(
            ([key, value]) => value === undefined || tunnel[key] === value,
          );
          if (!matches) return { count: 0 };
          Object.assign(tunnel, args.data);
          return { count: 1 };
        },
      },
      forwardRevision: {
        findFirst: async (args: { where: { tunnel_id: number; revision: number } }) => {
          const hit = snapshots.find(
            (s) =>
              Number(s.data.tunnel_id) === args.where.tunnel_id &&
              Number(s.data.revision) === args.where.revision,
          );
          return hit ? { id: hit.id } : null;
        },
        create: async (args: { data: Record<string, unknown> }) => {
          const id = snapshots.length + 1;
          snapshots.push({ id, data: { ...args.data } });
          return { id };
        },
      },
      egressTarget: { findMany: async () => [] },
    };
    return { tunnel, snapshots, client };
  }

  test("G1. 首次成功 apply 后补同 revision baseline，不 bump revision", async () => {
    const f = baselineClient();
    const first = await ensureForwardBaselineRevision(501, 42, f.client as never);
    expect(first).toEqual({ revision: 3, snapshotId: 1, created: true });
    expect(f.snapshots).toHaveLength(1);
    expect(f.snapshots[0]!.data).toMatchObject({
      tunnel_id: 501,
      revision: 3,
      name: "web-prod",
      mode: "direct",
      ingress_node_id: 11,
      listen_port: 19001,
      target_host: "10.0.0.10",
      target_port: 8080,
      created_by_id: 42,
    });
    expect(f.tunnel.config_revision).toBe(3);
    expect(f.tunnel.applied_revision).toBe(3);
    expect(f.tunnel.desired_revision_id).toBe(1);

    const again = await ensureForwardBaselineRevision(501, 42, f.client as never);
    expect(again?.created).toBe(false);
    expect(f.snapshots).toHaveLength(1);
    expect(f.tunnel.config_revision).toBe(3);
  });

  test("G2. desired/applied 尚未收敛时不伪造 baseline", async () => {
    const f = baselineClient({ config_revision: 4, applied_revision: 3 });
    const res = await ensureForwardBaselineRevision(501, null, f.client as never);
    expect(res).toBeNull();
    expect(f.snapshots).toHaveLength(0);
    expect(f.tunnel.desired_revision_id).toBeNull();
  });
});
