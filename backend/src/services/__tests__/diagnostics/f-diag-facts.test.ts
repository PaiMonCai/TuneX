/**
 * V5-WP19-F —— `diag` 作为面板一等事实的**行为断言**（与同目录的源码级守卫互为表里）。
 *
 * 三条要点：
 *   1. **可达**：Agent 上报 → 校验/落库投影 → 面板读路径（runtime 列表 + health 遥测视图），
 *      一路上都必须拿得到，并且实测钉住「校验通过 ⇒ 值真进得了库/视图」（DoD 5）；
 *   2. **可分辨**：`没有 diag 块`（tcp / 旧 Agent）≠ `facts: {}`（报了但这次没有标量）≠
 *      `facts: { drops: 0 }`。一个把每个报文都丢掉的出口与一个空闲的出口，区别就在这里；
 *   3. **不污染封闭键集**：`diag` 走 per-tunnel 对象，`runtime_counts` 的键集一个字都不加
 *      （往那里加未知键会让**整份上报**被 400 拒掉 —— 隧道/端口/健康一起丢）。
 */
import { describe, expect, test } from "bun:test";
import { projectReportedTunnels, validateStateReport } from "../../node-state.ts";
import { diagOfTunnel, normalizeTunnelDiag, TUNNEL_DIAG_MAX_KEYS, tunnelDiagsById } from "../../tunnel-diag.ts";
import { parseReportedRuntimes } from "../../node-health.ts";
import { getNodeHealth } from "../../node-health-service.ts";

const UDP_DIAG = {
  protocol: "udp",
  mappings: 2,
  packets_in: 9,
  packets_out: 7,
  bytes_in: 400,
  bytes_out: 300,
  drops: 4,
  idle_timeout_seconds: 60,
  hop_local_addr: "172.41.20.10:56588",
};

const NOW = new Date("2026-10-05T12:00:00.000Z");

describe("V5-WP19-F: normalizeTunnelDiag 是读取视图，不是第二份事实", () => {
  test("udp diag：标量事实全部进来，且不造任何 connection 语义", () => {
    const view = normalizeTunnelDiag(UDP_DIAG);
    expect(view).not.toBeNull();
    expect(view!.protocol).toBe("udp");
    expect(view!.truncated).toBe(false);
    expect(view!.facts.drops).toBe(4);
    expect(view!.facts.packets_in).toBe(9);
    expect(view!.facts.mappings).toBe(2);
    expect(view!.facts.hop_local_addr).toBe("172.41.20.10:56588");
    // datagram 的冻结形状里没有连接数（docs/v5-1b-datagram-contract-draft.md §4.4），
    // 读取视图更不该凭空造一个。
    expect(JSON.stringify(view!.facts).toLowerCase()).not.toContain("connection");
  });

  test("没有 diag 块 = null；报了但空 = {}；两者绝不合并", () => {
    expect(normalizeTunnelDiag(undefined)).toBeNull();
    expect(normalizeTunnelDiag(null)).toBeNull();
    expect(normalizeTunnelDiag("not-an-object")).toBeNull();
    expect(normalizeTunnelDiag([1, 2])).toBeNull();
    const empty = normalizeTunnelDiag({ protocol: "udp" });
    expect(empty).not.toBeNull();
    expect(empty!.facts).toEqual({ protocol: "udp" });
  });

  test("未知键照样进视图（键集由 Agent 拥有，G19.2 方向）", () => {
    const view = normalizeTunnelDiag({ protocol: "udp", packets_dropped_no_target: 3, future_fact: true });
    expect(view!.facts.packets_dropped_no_target).toBe(3);
    expect(view!.facts.future_fact).toBe(true);
  });

  test("坏值不进视图：嵌套结构、NaN/Infinity 都不是标量事实（未知 ≠ 0）", () => {
    const view = normalizeTunnelDiag({
      protocol: "udp",
      drops: 4,
      nested: { reason: "no_target" },
      list: [1, 2],
      broken: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      negative: -3,
      flag: false,
    });
    expect(view!.facts.drops).toBe(4);
    expect(Object.hasOwn(view!.facts, "nested")).toBe(false);
    expect(Object.hasOwn(view!.facts, "list")).toBe(false);
    expect(Object.hasOwn(view!.facts, "broken")).toBe(false);
    expect(Object.hasOwn(view!.facts, "infinite")).toBe(false);
    // **不 clamp**：负数原样保留（读的人要能发现 Agent 算错了，而不是看到一个假 0）。
    expect(view!.facts.negative).toBe(-3);
    expect(view!.facts.flag).toBe(false);
  });

  test("视图有界，且越界时显式标注 truncated（不静默变出一份「完整」的视图）", () => {
    const long = normalizeTunnelDiag({ protocol: "tls", last_handshake_error: "x".repeat(900) });
    expect((long!.facts.last_handshake_error as string).length).toBe(400);
    expect(long!.truncated).toBe(true);

    const many: Record<string, number> = { protocol: 0 };
    for (let i = 0; i < TUNNEL_DIAG_MAX_KEYS + 10; i += 1) many[`k${i}`] = i;
    const capped = normalizeTunnelDiag(many);
    expect(capped!.truncated).toBe(true);
    expect(Object.keys(capped!.facts).length).toBe(TUNNEL_DIAG_MAX_KEYS);
  });

  test("按 id 索引：只有真的带 diag 的 runtime 才有键；同 id 重复时第一条为准", () => {
    const tunnels = [
      { id: "tunex-7-direct", mode: "DIRECT", diag: UDP_DIAG },
      { id: "tunex-8-direct", mode: "DIRECT", protocol: "tcp" },
      { id: "tunex-7-direct", diag: { protocol: "udp", drops: 999 } },
      null,
      "nope",
    ];
    const byId = tunnelDiagsById(tunnels);
    expect(Object.keys(byId)).toEqual(["tunex-7-direct"]);
    expect(byId["tunex-7-direct"]!.facts.drops).toBe(4);
    // 单条读取与索引读取必须同源。
    expect(diagOfTunnel(tunnels, "tunex-7-direct")!.facts.drops).toBe(4);
    expect(diagOfTunnel(tunnels, "tunex-8-direct")).toBeNull();
    expect(diagOfTunnel(tunnels, "nope")).toBeNull();
    expect(diagOfTunnel("not-an-array", "tunex-7-direct")).toBeNull();
  });
});

describe("V5-WP19-F: diag 端到端可达（上报 → 投影 → 面板视图）", () => {
  test("校验通过 ⇒ diag 真的进了投影（原样，hop_local_addr 一个字节都不动）", () => {
    const result = validateStateReport({
      version: "1.0.0",
      tunnels: [{ id: "tunex-7-direct", mode: "DIRECT", ingress_port: 21000, revision: 3, diag: UDP_DIAG }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tunnel = result.report.tunnels![0] as unknown as Record<string, unknown>;
    expect(tunnel.diag).toEqual(UDP_DIAG);
    // ① 的出口取证纠正读的是**原始块**：这个键必须原样在。
    expect((tunnel.diag as Record<string, unknown>).hop_local_addr).toBe("172.41.20.10:56588");
  });

  test("坏 diag 块丢这一条信息，绝不毁整份上报（隧道/端口/健康都还在）", () => {
    const result = validateStateReport({
      version: "1.0.0",
      tunnels: [
        { id: "tunex-9-direct", mode: "DIRECT", ingress_port: 21001, revision: 1, diag: "not-an-object" },
        { id: "tunex-10-direct", mode: "DIRECT", ingress_port: 21002, revision: 1, diag: UDP_DIAG },
      ],
      used_ports: [21001, 21002],
      runtime_counts: { direct: 2, total: 2 },
      hostname: "n-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [bad, good] = result.report.tunnels! as unknown as Record<string, unknown>[];
    expect(bad!.id).toBe("tunex-9-direct");
    expect(Object.hasOwn(bad!, "diag")).toBe(false);
    expect(bad!.ingress_port).toBe(21001);
    expect(good!.diag).toEqual(UDP_DIAG);
    expect(result.report.used_ports).toEqual([21001, 21002]);
  });

  test("投影只处理 diag：其余未知字段原样保留（不在上报层做语义判断）", () => {
    const projected = projectReportedTunnels([
      { id: "t", mode: "RELAY", future_field: { a: 1 } } as never,
    ]);
    expect((projected![0] as unknown as Record<string, unknown>).future_field).toEqual({ a: 1 });
    expect(projectReportedTunnels(undefined)).toBeUndefined();
  });

  test("runtime_counts 的封闭键集一个字都没变（diag 不许走那里）", () => {
    // 未知键 → 整份 400，这是刻意的（放行一种未知 runtime 种类会让普查不完整）。
    const unknown = validateStateReport({
      version: "1.0.0",
      tunnels: [{ id: "t", mode: "DIRECT", diag: UDP_DIAG }],
      runtime_counts: { direct: 1, total: 1, udp_drops: 4 },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe("bad_telemetry");

    // 带 diag 的合规上报：runtime_counts 原样、且不因为 diag 出现任何新键。
    const ok = validateStateReport({
      version: "1.0.0",
      tunnels: [{ id: "t", mode: "DIRECT", diag: UDP_DIAG }],
      runtime_counts: { direct: 1, total: 1 },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(Object.keys(ok.report.runtime_counts!)).toEqual(["direct", "total"]);
  });

  test("面板读路径：runtime 列表带上 diag；tcp 隧道没有这个键", () => {
    const runtimes = parseReportedRuntimes([
      { id: "tunex-7-direct", mode: "DIRECT", ingress_port: 21000, revision: 3, diag: UDP_DIAG },
      { id: "tunex-8-direct", mode: "DIRECT", ingress_port: 21001, revision: 1, protocol: "tcp" },
      { id: "tunex-9-direct", diag: "not-an-object" },
    ]);
    expect(runtimes).toHaveLength(3);
    expect(runtimes[0]!.diag!.facts.drops).toBe(4);
    expect(runtimes[1]!.diag).toBeUndefined();
    expect(Object.hasOwn(runtimes[1]!, "diag")).toBe(false);
    expect(runtimes[2]!.diag).toBeUndefined();
  });

  test("面板接口（health 遥测视图）暴露按 runtime 索引的 diag：丢包出口 ≠ 空闲出口", async () => {
    const snapshot = {
      version: "1.0.0",
      role: "both",
      reported_revision: 3,
      known_revision: 3,
      reported_at: NOW,
      runtime_counts: { direct: 2, total: 2 },
      used_ports: [21000, 21001],
      tunnels: [
        { id: "tunex-7-direct", mode: "DIRECT", ingress_port: 21000, revision: 3, diag: UDP_DIAG },
        { id: "tunex-8-direct", mode: "DIRECT", ingress_port: 21001, revision: 1, protocol: "tcp" },
      ],
    };
    const nodeRow = {
      id: 1,
      node_id: "WP19-NODE",
      role: "both",
      status: "active",
      lifecycle: "active",
      version: "1.0.0",
      last_seen_at: NOW,
      port_range_min: 20000,
      port_range_max: 30000,
      node_credential_hash: "hash",
      credential_revoked: false,
    };
    const db = {
      node: { findUnique: async () => nodeRow, findMany: async () => [nodeRow] },
      nodeStateReport: { findUnique: async () => snapshot, findMany: async () => [snapshot] },
      tunnel: { findMany: async () => [] },
    };
    const result = await getNodeHealth(1, { db: db as never, now: () => NOW, expectedAgentVersion: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const runtime = result.view.telemetry!.runtime;
    // 两条 runtime 都在跑 —— 但只有真的上报了协议事实的那条有 diag。
    expect(runtime.running).toEqual(["tunex-7-direct", "tunex-8-direct"]);
    expect(Object.keys(runtime.diags)).toEqual(["tunex-7-direct"]);
    expect(runtime.diags["tunex-7-direct"]!.facts.drops).toBe(4);
    expect(runtime.diags["tunex-7-direct"]!.facts.packets_in).toBe(9);
    // tcp 隧道没有 diag 键：读取方不能把它读成"drops = 0"。
    expect(Object.hasOwn(runtime.diags, "tunex-8-direct")).toBe(false);
  });
});
