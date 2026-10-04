/**
 * V5-WP4/G0 —— Agent 启动恢复快照的协议准入。
 *
 * 这是**唯一一条刻意绕过 orchestrator 的下发面**：Agent 主动来拉自己的期望状态，
 * 中间没有命令、没有 ACK、没有 runtime admission。所以协议门必须在这一层自己把住。
 *
 * 缺陷复现（Gate V5-G0 抓到的第二处）：`buildDesiredNodeSnapshot` 过去把每一条
 * 期望行为都写成 `protocol: "tcp"`。于是一条 `tunnel_type='wss'`、`forward_protocol`
 * 为 NULL 的历史行，只要它的 `desired_status` 还是 active，就会**在每次 Agent 重启时
 * 被当成 TCP 重新下发**——G0 的 LKG 用例每重启一次 Agent 就复现一次（Agent 日志里
 * 每隔 ~35s 一条 `tunnel applied ... revision=2`），而面板侧的调度器、reconcile
 * sink、rollout executor 三处门全都没被走到。
 *
 * 结论写在这里以免重犯：**"下发路径"不止 `dispatch*`**。
 */
import { describe, expect, test } from "bun:test";
import { desiredTunnelConfigFor, type DesiredRowProjection } from "../agent-command-bus.ts";

const NODE = 3;

function directRow(over: Partial<DesiredRowProjection> = {}): DesiredRowProjection {
  return {
    id: 156,
    tunnel_mode: "direct",
    desired_status: "active",
    config_revision: 2,
    forward_protocol: null,
    tunnel_type: "tcp",
    ingress_node_id: NODE,
    egress_node_id: null,
    listen_port: 21010,
    listen_ip: null,
    remote_host: "target-a",
    remote_port: 3030,
    egress_port: null,
    egress_node: null,
    egress_pool: null,
    ...over,
  };
}

describe("desired snapshot: the protocol fact is never invented", () => {
  test("a V4-shaped row (legacy column only) restores as its real protocol", () => {
    const outcome = desiredTunnelConfigFor(directRow(), NODE);
    expect(outcome.kind).toBe("config");
    if (outcome.kind !== "config") return;
    expect(outcome.config.protocol).toBe("tcp");
  });

  test("the canonical column wins over the legacy one", () => {
    const outcome = desiredTunnelConfigFor(directRow({ forward_protocol: "tcp", tunnel_type: "wss" }), NODE);
    expect(outcome.kind).toBe("config");
    if (outcome.kind !== "config") return;
    expect(outcome.config.protocol).toBe("tcp");
  });

  /** 这条就是 Gate 抓到的那个 bug：历史 wss 行不能变成 `protocol: "tcp"`。 */
  test("a historical non-TCP row is OMITTED, never relabelled tcp", () => {
    const outcome = desiredTunnelConfigFor(directRow({ tunnel_type: "wss" }), NODE);
    expect(outcome).toEqual({ kind: "skip", reason: "protocol_not_supported" });
  });

  test("every unopened protocol is refused, not just wss", () => {
    for (const legacy of ["wss", "quic", "mtcp", "carrier-pigeon"]) {
      expect(desiredTunnelConfigFor(directRow({ tunnel_type: legacy }), NODE)).toEqual({
        kind: "skip",
        reason: "protocol_not_supported",
      });
    }
  });

  /**
   * 行里**完全没有**协议事实 = 投影/迁移漏了列，不是 V4 的「省略协议 ⇒ tcp」。
   * 把它当 tcp 会把一个数据缺口变成一条真实运行的 TCP 转发。
   */
  /** V5-WP5-A1：tls 行会被放行，**并且**带着它的证书路径一起进快照。 */
  test("a tls row restores as tls, carrying its certificate paths", () => {
    const outcome = desiredTunnelConfigFor(
      directRow({
        forward_protocol: "tls",
        tunnel_type: "tls",
        tls_cert_path: "/etc/tunex/tls/site.crt",
        tls_key_path: "/etc/tunex/tls/site.key",
      }),
      NODE,
    );
    expect(outcome.kind).toBe("config");
    if (outcome.kind !== "config") return;
    expect(outcome.config.protocol).toBe("tls");
    expect(outcome.config.tls_cert_path).toBe("/etc/tunex/tls/site.crt");
    expect(outcome.config.tls_key_path).toBe("/etc/tunex/tls/site.key");
  });

  /** 没有证书的 tls 行是坏配置：不进快照，也绝不降级成普通 TCP。 */
  test("a tls row without certificate paths is skipped, never downgraded to tcp", () => {
    for (const paths of [
      {},
      { tls_cert_path: "/etc/tunex/tls/site.crt" },
      { tls_key_path: "/etc/tunex/tls/site.key" },
      { tls_cert_path: "  ", tls_key_path: "/etc/tunex/tls/site.key" },
    ]) {
      expect(desiredTunnelConfigFor(directRow({ forward_protocol: "tls", tunnel_type: "tls", ...paths }), NODE)).toEqual({
        kind: "skip",
        reason: "tls_paths_missing",
      });
    }
  });

  /** V5-WP5-A2：ws 行会被放行，且**不需要**额外字段（握手是服务端行为）。 */
  test("a ws row restores as ws with no extra configuration", () => {
    const outcome = desiredTunnelConfigFor(
      directRow({ forward_protocol: "ws", tunnel_type: "ws" }),
      NODE,
    );
    expect(outcome.kind).toBe("config");
    if (outcome.kind !== "config") return;
    expect(outcome.config.protocol).toBe("ws");
    // No certificate to carry: a ws front has nothing to configure.
    expect(outcome.config.tls_cert_path).toBeUndefined();
    expect(outcome.config.tls_key_path).toBeUndefined();
  });

  test("a row with no protocol fact at all is refused (fail closed)", () => {
    expect(desiredTunnelConfigFor(directRow({ tunnel_type: null, forward_protocol: null }), NODE)).toEqual({
      kind: "skip",
      reason: "protocol_not_supported",
    });
  });

  test("rows that do not belong to this node are not skipped, they are simply not its business", () => {
    expect(desiredTunnelConfigFor(directRow({ ingress_node_id: 99 }), NODE)).toEqual({ kind: "not_for_node" });
  });

  test("a revisionless row is not handed to the Agent", () => {
    expect(desiredTunnelConfigFor(directRow({ config_revision: 0 }), NODE)).toEqual({ kind: "not_for_node" });
  });

  test("a V5.4 ingress restart restores next_hop through the middle node, not directly to egress", () => {
    const outcome = desiredTunnelConfigFor(
      directRow({
        tunnel_mode: "relay",
        ingress_node_id: NODE,
        middle_node_id: 5,
        egress_node_id: 4,
        listen_port: 21006,
        egress_port: 22001,
        middle_node: { connect_ip: "10.0.0.5" },
        egress_node: { connect_ip: "10.0.0.4" },
        port_leases: [
          { node_id: NODE, port: 21006, status: "active" },
          { node_id: 5, port: 23001, status: "active" },
          { node_id: 4, port: 22001, status: "active" },
        ],
      }),
      NODE,
    );
    expect(outcome.kind).toBe("config");
    if (outcome.kind !== "config") return;
    expect(outcome.config.id).toBe("tunex-156-relay");
    expect(outcome.config.next_hop).toBe("10.0.0.5:23001");
    expect(outcome.config.remote_host).toBe("10.0.0.5");
    expect(outcome.config.remote_port).toBe(23001);
  });

  test("a V5.4 middle hop restores as the transit EGRESS runtime after an Agent restart", () => {
    const outcome = desiredTunnelConfigFor(
      directRow({
        tunnel_mode: "relay",
        ingress_node_id: 3,
        middle_node_id: NODE,
        egress_node_id: 4,
        egress_port: 22001,
        egress_node: { connect_ip: "10.0.0.4" },
        port_leases: [{ node_id: NODE, port: 23001, status: "active" }],
      }),
      NODE,
    );
    expect(outcome.kind).toBe("config");
    if (outcome.kind !== "config") return;
    expect(outcome.config.id).toBe("tunex-156-egress");
    expect(outcome.config.mode).toBe("EGRESS");
    expect(outcome.config.egress_port).toBe(23001);
    expect(outcome.config.targets).toEqual([
      { host: "10.0.0.4", port: 22001, weight: 1, order: 10 },
    ]);
  });

  test("a middle hop without its durable lease is omitted instead of guessing a port", () => {
    expect(
      desiredTunnelConfigFor(
        directRow({
          tunnel_mode: "relay",
          ingress_node_id: 3,
          middle_node_id: NODE,
          egress_node_id: 4,
          egress_port: 22001,
          egress_node: { connect_ip: "10.0.0.4" },
          port_leases: [],
        }),
        NODE,
      ),
    ).toEqual({ kind: "not_for_node" });
  });

  test("snapshot DB selection includes middle_node_id, not only ingress/egress", async () => {
    const src = await Bun.file(new URL("../agent-command-bus.ts", import.meta.url)).text();
    expect(src).toContain("{ middle_node_id: nodeId }");
    expect(src).toContain("port_leases:");
  });

  test("relay rows resolve one protocol for both legs", () => {
    const ingress = desiredTunnelConfigFor(
      directRow({
        tunnel_mode: "relay",
        ingress_node_id: NODE,
        egress_node_id: 4,
        egress_port: 22001,
        egress_node: { connect_ip: "10.0.0.2" },
      }),
      NODE,
    );
    expect(ingress.kind).toBe("config");
    if (ingress.kind === "config") {
      expect(ingress.config.mode).toBe("RELAY");
      expect(ingress.config.protocol).toBe("tcp");
      expect(ingress.config.next_hop).toBe("10.0.0.2:22001");
    }

    const egress = desiredTunnelConfigFor(
      directRow({
        tunnel_mode: "relay",
        ingress_node_id: 9,
        egress_node_id: NODE,
        egress_port: 22001,
        egress_pool: { lb_strategy: "round", targets: [{ host: "192.168.1.10", port: 8080, weight: 1, order_by: 10 }] },
      }),
      NODE,
    );
    expect(egress.kind).toBe("config");
    if (egress.kind === "config") {
      expect(egress.config.mode).toBe("EGRESS");
      expect(egress.config.protocol).toBe("tcp");
      expect(egress.config.targets).toHaveLength(1);
    }

    // And the same historical fact keeps the relay legs out of the snapshot too.
    const historical = desiredTunnelConfigFor(
      directRow({ tunnel_mode: "relay", tunnel_type: "wss", ingress_node_id: NODE }),
      NODE,
    );
    expect(historical.kind).toBe("skip");
  });
});
