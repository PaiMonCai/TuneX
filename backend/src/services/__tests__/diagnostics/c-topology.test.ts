/**
 * V5-WP19-C —— 链路拓扑与逐跳明细（只读投影）。
 *
 * 钉住的不变量：
 *
 * ① **段结构来自唯一真相源**（`probeTargetsForForward` 的 `node_facts` 段），本投影不自己
 *    算一遍拓扑 —— 第二份拓扑真相会和第一份漂移，而"两处各自都对、只是不同"最难查。
 * ② **"面板说 active" ≠ "节点在跑"**：`running` 只回答"这条 runtime 出现在该节点最近一次上报
 *    里吗"。这是本视图存在的理由（隧道 active 而数据面不通，就是靠这一列看出来）。
 * ③ **"从没上报过"与"上报里没有它"必须可区分**：前者 `reported_at === null`，后者
 *    `reported_at` 有值但 `running === false`。把两者压成一个"不健康"会让排障从"看数据"
 *    退化成"猜"。
 * ④ **不编造**：计划不成立（例如缺入口连接地址）时返回结构化失败，**不**返回一个空拓扑
 *    —— 空拓扑会被读成"这条转发没有跳"。
 * ⑤ DIRECT 没有节点间段是**正常**的，不是失败。
 */
import { describe, expect, test } from "bun:test";
import { projectForwardTopology, type TopologyNodeReport } from "../../forward-topology.ts";
import type { ForwardForDiagnose } from "../../agent-diagnose.ts";

const base: ForwardForDiagnose = {
  id: 42,
  mode: "relay",
  ingress_node_id: 3,
  ingress_node_key: "IN-A",
  ingress_connect_ip: "203.0.113.10",
  egress_node_id: 4,
  egress_node_key: "OUT-A",
  egress_connect_ip: "203.0.113.20",
  egress_port: 22000,
  remote_host: "198.51.100.7",
  remote_port: 8080,
  config_revision: 5,
  pool_targets: [{ host: "198.51.100.7", port: 8080 }],
};

/** 一段上报：某条 runtime 在跑（可选带上 diag）。 */
const report = (runtimeId: string, revision: number, diag?: Record<string, unknown>, at = "2026-10-05T04:00:00.000Z"): TopologyNodeReport => ({
  tunnels: [{ id: runtimeId, revision, port: 21000, ...(diag ? { diag } : {}) }],
  reported_at: at,
});

describe("V5-WP19-C: 单跳 RELAY 的拓扑投影", () => {
  test("段结构取自 probe plan，两端各自带上自己在报的事实", () => {
    const result = projectForwardTopology({
      forward: base,
      reports: {
        3: report("tunex-42-relay", 5, { protocol: "udp", packets_in: 7, mappings: 2 }),
        4: report("tunex-42-egress", 5, { protocol: "udp", packets_in: 6 }),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [seg] = result.topology.segments;
    expect(result.topology.segments).toHaveLength(1);
    expect(seg!.segment).toBe("ingress_to_egress");
    expect(seg!.from).toMatchObject({ node_id: 3, node_key: "IN-A", runtime_id: "tunex-42-relay", running: true, revision: 5 });
    expect(seg!.to).toMatchObject({ node_id: 4, runtime_id: "tunex-42-egress", running: true });
    // diag 走的是 wp19-F 的类型化视图，形状是 `{ protocol, facts, truncated }` ——
    // 协议事实在 `facts` **里面**（不是扁平展开），`truncated` 表示有界化时截断过。
    // 本投影**原样转述**这个视图，不重新组装（否则就是第二份 diag 真相）。
    expect(seg!.from.diag).toMatchObject({ protocol: "udp", facts: { packets_in: 7, mappings: 2 } });
    expect(seg!.hop).toEqual({ host: "203.0.113.20", port: 22000 });
    expect(seg!.expected_revision).toBe(5);
    expect(result.topology.observed_at).toBe("2026-10-05T04:00:00.000Z");
    expect(result.topology.stale_segments).toBe(0);
  });

  test("**面板说 active、节点没这么说** ⇒ running=false 且计入 stale（这正是本视图存在的理由）", () => {
    const result = projectForwardTopology({
      forward: base,
      reports: {
        // 出口上报了，但里面**没有**这条 egress runtime。
        3: report("tunex-42-relay", 5),
        4: { tunnels: [{ id: "tunex-999-egress", revision: 5 }], reported_at: "2026-10-05T04:00:00.000Z" },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [seg] = result.topology.segments;
    expect(seg!.to.running).toBe(false);
    expect(seg!.to.diag).toBeNull();
    expect(result.topology.stale_segments).toBe(1);
  });

  test("**从没上报过**与「上报里没有它」可区分（前者的机器从没说过话）", () => {
    const result = projectForwardTopology({ forward: base, reports: {} });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [seg] = result.topology.segments;
    expect(seg!.from.running).toBe(false);
    expect(result.topology.observed_at).toBeNull();
    // 两端都**没有过**上报 ⇒ 不算 stale（那是"观测缺失"，不是"节点说它没在跑"）。
    expect(result.topology.stale_segments).toBe(0);
  });

  test("上报里的 revision 落后不影响段结构（结构来自计划、事实来自上报）", () => {
    const result = projectForwardTopology({
      forward: base,
      reports: { 3: report("tunex-42-relay", 4), 4: report("tunex-42-egress", 4) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.topology.segments[0]!.from.revision).toBe(4);
    expect(result.topology.segments[0]!.expected_revision).toBe(5);
  });
});

describe("V5-WP19-C: 三跳被拆成两段（失败的那一段就是失败的那一跳）", () => {
  const threeHop: ForwardForDiagnose = {
    ...base,
    middle_node_id: 9,
    middle_node_key: "MID-B",
    middle_connect_ip: "203.0.113.30",
    middle_port: 23000,
  };

  test("两段各自点名它两端的节点与 runtime", () => {
    const result = projectForwardTopology({
      forward: threeHop,
      reports: {
        3: report("tunex-42-relay", 5),
        9: report("tunex-42-egress", 5),
        4: report("tunex-42-egress", 5),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.topology.segments.map((s) => s.segment)).toEqual(["ingress_to_middle", "middle_to_egress"]);
    expect(result.topology.segments[0]!.hop).toEqual({ host: "203.0.113.30", port: 23000 });
    expect(result.topology.segments[1]!.from.node_id).toBe(9);
    expect(result.topology.segments[1]!.to.node_id).toBe(4);
  });

  test("只有**一段**坏掉时 stale_segments 精确反映它（这就是「定位失败跳」）", () => {
    const result = projectForwardTopology({
      forward: threeHop,
      reports: {
        3: report("tunex-42-relay", 5),
        // 中转跳没上报这条 runtime ⇒ 第二段的两端都说不清；第一段仍然健康。
        9: { tunnels: [], reported_at: "2026-10-05T04:00:00.000Z" },
        4: report("tunex-42-egress", 5),
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.topology.stale_segments).toBe(2);
  });
});

describe("V5-WP19-C: 不编造（失败与空拓扑是两件事）", () => {
  test("计划不成立 ⇒ 结构化失败，**不是**空拓扑", () => {
    // 用"没有入口节点"制造真正的计划失败。注意**缺出口地址并不会**让计划失败 ——
    // 计划照样给出段，只是 `hop` 为 null（"没法拨号"≠"拓扑不成立"）。这个区分很重要：
    // 把两者混起来会让"出口地址还没配好"被误报成"拓扑不成立"。
    const result = projectForwardTopology({
      forward: { ...base, ingress_node_id: null },
      reports: {},
    });
    // 空拓扑会被读成"这条转发没有跳"；这里必须给出原因。
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });

  test("DIRECT 没有节点间段是**正常**的（不是失败）", () => {
    const result = projectForwardTopology({
      forward: { ...base, mode: "direct", egress_node_id: null, egress_connect_ip: null, egress_port: null },
      reports: { 3: report("tunex-42-direct", 5) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.topology.segments).toEqual([]);
    expect(result.topology.mode).toBe("direct");
  });
});
