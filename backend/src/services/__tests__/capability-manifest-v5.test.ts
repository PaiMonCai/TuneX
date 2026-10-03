/**
 * V5-WP1 —— 能力协商 v2（契约 + 规范化 + runtime admission）。
 *
 * DEVELOPMENT.md §5.2 列出了十条必须覆盖的行为，本文件逐条钉住。核心纪律只有
 * 一条，但它有三个方向，弄错任何一个都会造成真实故障：
 *
 *   缺失   → baseline（否则升级窗口内整批旧节点停摆）
 *   坏形状 → fail-closed（否则把坏载荷降级成"未上报"，即 fail-open）
 *   不含项 → 明确拒绝（否则向一个不认识该协议的 Agent 下发配置）
 */
import { describe, expect, test } from "bun:test";
import {
  ABSENT_V2_CAPABILITY_FACTS,
  BASELINE_PROTOCOLS,
  BASELINE_TRANSPORTS,
  CAPABILITY_MANIFEST_SCHEMA_VERSION,
  capabilityFactsFromStoredV2,
  decideProtocolCapability,
  decideRuntimeCapability,
  decideTransportCapability,
  normalizeCapabilityManifest,
  type AgentV2CapabilityFacts,
  type CapabilityManifest,
} from "../capability-manifest.ts";
import { telemetryColumns, validateStateReport } from "../node-state.ts";
import { admitOnNode } from "../runtime-admission.ts";

/* ================================================================== */
/* 夹具                                                                */
/* ================================================================== */

function facts(partial: Partial<AgentV2CapabilityFacts> = {}): AgentV2CapabilityFacts {
  return { ...ABSENT_V2_CAPABILITY_FACTS, ...partial };
}

function manifest(partial: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    schema_version: CAPABILITY_MANIFEST_SCHEMA_VERSION,
    protocols: ["tcp"],
    transports: ["stream"],
    runtime: ["graceful_drain", "hot_reload", "lkg_restore"],
    diagnostics: ["node_snapshot", "tunnel_probe"],
    ...partial,
  };
}

const NOW = new Date("2026-10-04T00:00:00.000Z");
const EARLIER = new Date("2026-10-03T00:00:00.000Z");

/* ================================================================== */
/* 规范化                                                              */
/* ================================================================== */

describe("normalizeCapabilityManifest", () => {
  test("missing field is null (old agent), never an empty manifest", () => {
    expect(normalizeCapabilityManifest(undefined)).toBeNull();
    expect(normalizeCapabilityManifest(null)).toBeNull();
  });

  test("normalises, sorts and de-duplicates every dimension", () => {
    const normalized = normalizeCapabilityManifest({
      schema_version: 2,
      protocols: [" tcp ", "tcp"],
      transports: ["stream"],
      runtime: ["lkg_restore", "hot_reload"],
      diagnostics: ["tunnel_probe"],
    });
    expect(normalized).toEqual({
      schema_version: 2,
      protocols: ["tcp"],
      transports: ["stream"],
      runtime: ["hot_reload", "lkg_restore"],
      diagnostics: ["tunnel_probe"],
    });
  });

  test("a dimension the agent did not report is an empty list, not a crash", () => {
    const normalized = normalizeCapabilityManifest({ schema_version: 2, protocols: ["tcp"] });
    expect(normalized).toEqual({
      schema_version: 2,
      protocols: ["tcp"],
      transports: [],
      runtime: [],
      diagnostics: [],
    });
  });

  test("bad shapes throw, so they can never be mistaken for 'never reported'", () => {
    const bad: unknown[] = [
      "manifest",
      42,
      [],
      {},
      { schema_version: "2" },
      { schema_version: 2.5 },
      { schema_version: 2, protocols: "tcp" },
      { schema_version: 2, protocols: [1] },
      { schema_version: 2, protocols: [""] },
      { schema_version: 2, protocols: ["x".repeat(65)] },
      { schema_version: 2, protocols: Array.from({ length: 33 }, (_v, i) => `p${i}`) },
    ];
    for (const value of bad) {
      expect(() => normalizeCapabilityManifest(value)).toThrow();
    }
  });

  /**
   * 更新版的清单是**读不懂**，不是**坏载荷**。
   *
   * 把它判成 malformed 并 fail-closed 全部维度，会让一次 Agent 灰度升级变成
   * 整批节点停摆；判成"未上报"则让 V4 baseline 继续跑，同时新协议仍然被拒
   * ——后者才是方向正确的降级。
   */
  test("a schema version this panel does not implement degrades to 'unreadable', not 'malformed'", () => {
    for (const version of [1, 3, 99]) {
      expect(normalizeCapabilityManifest({ schema_version: version, protocols: ["tcp"] })).toBeNull();
    }
  });

  /**
   * 未知条目名是**事实**，不是许可。
   *
   * 判定函数只回答「这台节点实现了没有」，因此一个广告了 udp 的节点在节点维度
   * 上确实是「实现了 udp」。真正阻止它的是更早的产品白名单（WP0 的
   * normalizeForwardProtocol / admitOnNode）——所以 udp 无论怎么上报都进不了
   * 下发路径。这两层必须分开断言，否则「未知能力被放行」这种回归看不出来。
   */
  test("unknown item names are kept as facts but can never admit anything", () => {
    const normalized = normalizeCapabilityManifest({
      schema_version: 2,
      protocols: ["tcp", "udp"],
      transports: ["stream", "datagram"],
    });
    expect(normalized?.protocols).toEqual(["tcp", "udp"]);
    expect(normalized?.transports).toEqual(["datagram", "stream"]);

    const v2 = facts({ protocolVersion: 2, capabilities: ["apply_tunnel"], manifest: normalized });
    // Node dimension: the agent really did advertise udp, so the fact is kept.
    expect(decideProtocolCapability(v2, "udp")).toEqual({ supported: true, basis: "advertised" });
    // Product dimension: udp is not a product protocol, so admission still refuses.
    expect(
      admitOnNode({ nodeId: 1, role: "ingress", facts: v2 }, { action: "apply_tunnel", protocol: "udp" }),
    ).toMatchObject({ ok: false, layer: "protocol", reason: "protocol_not_supported" });
    // And the transport is DERIVED from the protocol, never taken from the
    // agent's own advertising: a node claiming `datagram` still runs tcp as
    // stream, so the two agreeing is exactly what admission checks.
    expect(
      admitOnNode({ nodeId: 1, role: "ingress", facts: v2 }, { action: "apply_tunnel", protocol: "tcp" }),
    ).toEqual({ ok: true });
  });
});

/* ================================================================== */
/* 库行 → 事实                                                          */
/* ================================================================== */

describe("capabilityFactsFromStoredV2", () => {
  test("no row at all is 'no facts'", () => {
    expect(capabilityFactsFromStoredV2(null)).toBeNull();
  });

  test("reads both the V4 action facts and the v2 manifest", () => {
    const got = capabilityFactsFromStoredV2({
      control_protocol_version: 2,
      capabilities: ["apply_tunnel"],
      capability_manifest: manifest(),
      reported_at: NOW,
      credential_rotated_at: EARLIER,
    });
    expect(got?.protocolVersion).toBe(2);
    expect(got?.capabilities).toEqual(["apply_tunnel"]);
    expect(got?.manifest?.protocols).toEqual(["tcp"]);
    expect(got?.manifestMalformed).toBe(false);
  });

  test("an old agent with no manifest keeps a null manifest (baseline, not empty)", () => {
    const got = capabilityFactsFromStoredV2({
      control_protocol_version: 1,
      capabilities: ["apply_tunnel"],
      reported_at: NOW,
      credential_rotated_at: EARLIER,
    });
    expect(got?.manifest).toBeNull();
    expect(got?.manifestMalformed).toBe(false);
  });

  test("a malformed stored value is flagged, not downgraded to 'never reported'", () => {
    const got = capabilityFactsFromStoredV2({
      capabilities: ["apply_tunnel"],
      capability_manifest: { schema_version: 2, protocols: "tcp" },
      reported_at: NOW,
      credential_rotated_at: EARLIER,
    });
    expect(got?.manifestMalformed).toBe(true);
    expect(got?.manifest).toBeNull();
  });

  test("a malformed capabilities value is flagged too", () => {
    const got = capabilityFactsFromStoredV2({
      capabilities: "apply_tunnel",
      reported_at: NOW,
      credential_rotated_at: EARLIER,
    });
    expect(got?.capabilitiesMalformed).toBe(true);
  });

  /**
   * 重装会让上报过期：凭据在最后一次上报**之后**签发 ⇒ 那份广告描述的是上一个
   * 进程。此时它必须整份作废（含 manifest），否则面板会按一个已经不存在的
   * 二进制的自述去放行新协议。
   */
  test("an advertisement that predates the current credential is void (manifest included)", () => {
    const got = capabilityFactsFromStoredV2({
      control_protocol_version: 2,
      capabilities: ["apply_tunnel"],
      capability_manifest: manifest(),
      reported_at: EARLIER,
      credential_rotated_at: NOW,
    });
    expect(got).toBeNull();
    // And the verdict that follows must be baseline, not "advertised".
    expect(decideProtocolCapability(got, "tcp")).toMatchObject({ supported: true, basis: "baseline" });
  });

  test("a stale advertisement is still void even when its shape is corrupt", () => {
    const got = capabilityFactsFromStoredV2({
      capabilities: "broken",
      capability_manifest: "also broken",
      reported_at: EARLIER,
      credential_rotated_at: NOW,
    });
    expect(got).toBeNull();
  });
});

/* ================================================================== */
/* 三维判定                                                            */
/* ================================================================== */

describe("protocol / transport / runtime decisions", () => {
  /* §5.2 测试 1：老 Agent（无 manifest），TCP baseline 继续 */
  test("1. an old agent keeps the TCP baseline", () => {
    expect(decideProtocolCapability(null, "tcp")).toEqual({ supported: true, basis: "baseline" });
    expect(decideProtocolCapability(facts(), "tcp")).toEqual({ supported: true, basis: "baseline" });
    expect(decideTransportCapability(null, "stream")).toEqual({ supported: true, basis: "baseline" });
    expect(decideRuntimeCapability(null, "hot_reload")).toEqual({ supported: true, basis: "baseline" });
  });

  test("the baseline is exactly tcp/stream and never a future protocol", () => {
    expect([...BASELINE_PROTOCOLS]).toEqual(["tcp"]);
    expect([...BASELINE_TRANSPORTS]).toEqual(["stream"]);
    for (const name of ["udp", "quic", "tls", "ws"]) {
      expect(decideProtocolCapability(null, name)).toMatchObject({
        supported: false,
        reason: "upgrade_required",
      });
      expect(decideProtocolCapability(facts({ manifest: manifest() }), name)).toMatchObject({
        supported: false,
        reason: "protocol_not_supported",
      });
    }
  });

  /* §5.2 测试 2：v2 Agent 上报 tcp + stream → 放行 */
  test("2. a v2 agent advertising tcp + stream is admitted on the advertised basis", () => {
    const v2 = facts({ protocolVersion: 2, capabilities: ["apply_tunnel"], manifest: manifest() });
    expect(decideProtocolCapability(v2, "tcp")).toEqual({ supported: true, basis: "advertised" });
    expect(decideTransportCapability(v2, "stream")).toEqual({ supported: true, basis: "advertised" });
    expect(decideRuntimeCapability(v2, "lkg_restore")).toEqual({ supported: true, basis: "advertised" });
  });

  /* §5.2 测试 3：manifest 缺 protocol → 拒绝 */
  test("3. a manifest that does not list the protocol is refused", () => {
    const v2 = facts({ manifest: manifest({ protocols: [] }) });
    expect(decideProtocolCapability(v2, "tcp")).toMatchObject({
      supported: false,
      reason: "protocol_not_supported",
    });
  });

  /* §5.2 测试 4：manifest 缺 transport → 拒绝 */
  test("4. a manifest that does not list the transport is refused", () => {
    const v2 = facts({ manifest: manifest({ transports: [] }) });
    expect(decideTransportCapability(v2, "stream")).toMatchObject({
      supported: false,
      reason: "transport_not_supported",
    });
  });

  /* §5.2 测试 5：malformed manifest → fail-closed（连 baseline 也不例外） */
  test("5. a malformed manifest fails closed on every dimension, baseline included", () => {
    const broken = facts({ manifestMalformed: true });
    expect(decideProtocolCapability(broken, "tcp")).toMatchObject({
      supported: false,
      reason: "malformed_capability_manifest",
    });
    expect(decideTransportCapability(broken, "stream")).toMatchObject({
      supported: false,
      reason: "malformed_capability_manifest",
    });
    expect(decideRuntimeCapability(broken, "hot_reload")).toMatchObject({
      supported: false,
      reason: "malformed_capability_manifest",
    });
  });

  test("an empty item name is a caller bug, reported as incompatible rather than admitted", () => {
    for (const empty of ["", "   ", null, undefined, 7]) {
      expect(decideProtocolCapability(facts({ manifest: manifest() }), empty)).toMatchObject({
        supported: false,
        reason: "incompatible_agent",
      });
    }
  });

  test("a missing runtime feature is refused even when the manifest is otherwise healthy", () => {
    const v2 = facts({ manifest: manifest({ runtime: ["hot_reload"] }) });
    expect(decideRuntimeCapability(v2, "lkg_restore")).toMatchObject({
      supported: false,
      reason: "runtime_feature_not_supported",
    });
  });
});

/* ================================================================== */
/* 状态上报：校验 + 落库                                                */
/* ================================================================== */

describe("capability_manifest in the state report", () => {
  const BASE = { agent_id: "a".repeat(32), version: "0.20.0", role: "BOTH" };

  test("accepts a v2 manifest and normalises it on the way to the column", () => {
    const r = validateStateReport({
      ...BASE,
      capabilities: ["apply_tunnel"],
      control_protocol_version: 2,
      capability_manifest: {
        schema_version: 2,
        protocols: [" tcp ", "tcp"],
        transports: ["stream"],
        runtime: ["lkg_restore"],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(telemetryColumns(r.report).capability_manifest).toEqual({
      schema_version: 2,
      protocols: ["tcp"],
      transports: ["stream"],
      runtime: ["lkg_restore"],
      diagnostics: [],
    });
  });

  test("an agent that reports no manifest keeps it NULL (baseline, not 'supports nothing')", () => {
    const r = validateStateReport({ ...BASE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cols = telemetryColumns(r.report);
    // "Absent" must be represented exactly like the V4 action list's absent
    // sentinel (Prisma.JsonNull). An empty object here would read as "this agent
    // implements nothing" and fail every dispatch closed.
    expect(cols.capability_manifest).toBe(cols.capabilities);
    expect(cols.capability_manifest).toBe(columnsJsonNull() as never);
  });

  test("a malformed manifest is a 400, not a silently stored NULL", () => {
    const bad: unknown[] = [
      "manifest",
      7,
      [],
      {},
      { schema_version: "2" },
      { schema_version: 2, protocols: "tcp" },
      { schema_version: 2, transports: [null] },
    ];
    for (const capability_manifest of bad) {
      const r = validateStateReport({ ...BASE, capability_manifest });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("bad_capability_manifest");
    }
  });

  /**
   * 更新版清单必须能上报成功（落成 NULL = 未上报的语义）。
   *
   * 若这里回 400，一个未来版本的 Agent 连状态都上报不了——一次灰度升级就变成
   * 整批节点失去可观测性（health / telemetry / 隧道快照全部停止刷新）。
   */
  test("a newer schema version is accepted and stored as 'not reported'", () => {
    const r = validateStateReport({
      ...BASE,
      capability_manifest: { schema_version: 3, protocols: ["tcp", "udp"] },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(telemetryColumns(r.report).capability_manifest).toBe(columnsJsonNull() as never);
    // And the panel's verdict stays safe: baseline only.
    const stored = capabilityFactsFromStoredV2({
      capability_manifest: r.report.capability_manifest,
      reported_at: NOW,
      credential_rotated_at: EARLIER,
    });
    expect(decideProtocolCapability(stored, "tcp")).toMatchObject({ supported: true, basis: "baseline" });
    expect(decideProtocolCapability(stored, "udp")).toMatchObject({ supported: false });
  });

  test("the projection whitelist carries the field through (not silently dropped)", () => {
    const r = validateStateReport({ ...BASE, capability_manifest: { schema_version: 2, protocols: ["tcp"] } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.capability_manifest).toEqual({ schema_version: 2, protocols: ["tcp"] });
  });
});

/** Prisma 的 JSON 列用 JsonNull 表示 SQL NULL；这里只比较语义，不 import Prisma。 */
function columnsJsonNull(): unknown {
  return (telemetryColumns({}) as { capability_manifest: unknown }).capability_manifest;
}
