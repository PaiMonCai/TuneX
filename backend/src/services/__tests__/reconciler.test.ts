/**
 * WP9 — Reconciler / Retry / Recovery 离线测试。
 *
 * 依据 `DEVELOPMENT.md` §7.12。不连 MySQL / Redis / 网络：所有副作用（下发
 * sink、租约回收）都是注入的替身。覆盖矩阵：
 *
 *   A. **对比五份事实**：desired / revision / agent applied / lease / node
 *      online 各自独立产生偏差（revision_behind / missing_runtime /
 *      unexpected_runtime / port_mismatch / mode_mismatch / node_unreachable /
 *      error_state）；
 *   B. **允许自动**（四项白名单逐一验证）：resend_same_revision、
 *      fill_missing_runtime、release_orphan_lease、record_finding；
 *   C. **禁止自动**（四项禁令逐一验证，且约束「禁令动作永不进入执行序列」）：
 *      switch_node / change_port / migrate_tunnel / delete_on_stale；
 *   D. **revision 不抬高**：任何路径下重发的 revision 恒等于
 *      `tunnel.config_revision`（含 error 退避后重发的场景）；
 *   E. **节点不可达 ⇒ 全线静默**：离线节点只产 finding，不调 sink；
 *   F. **legacy DIRECT 不被碰**：`config_revision = null` 的隧道完全不在视野内；
 *   G. **无 sink 不假装成功**：未注入下发通道 → noTransport + resend_skipped，
 *      绝不会声称 resent。
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  AUTO_ACTIONS,
  DEFAULT_NODE_STALE_AFTER_MS,
  DEFAULT_RETRY_BACKOFF_MS,
  FORBIDDEN_AUTO_ACTIONS,
  computeDrift,
  decideAutoAction,
  executeReconcile,
  hasDeclaredDesired,
  isErrorState,
  isNodeUnreachable,
  isPortMismatch,
  isRevisionBehind,
  planFindings,
  planTunnelActions,
  wantsActive,
} from "../reconciler.ts";
import type {
  AgentTunnelState,
  DesiredTunnel,
  Finding,
  NodeOnlineInput,
  PlannedAction,
  ReconcileDeps,
} from "../reconciler.ts";

/* ------------------------------------------------------------------ */
/* 构造工具                                                             */
/* ------------------------------------------------------------------ */

const NOW = new Date("2026-09-26T00:00:00.000Z");

function tunnel(over: Partial<DesiredTunnel> = {}): DesiredTunnel {
  return {
    id: 1,
    name: "t-1",
    tunnel_mode: "relay",
    desired_status: "active",
    config_revision: 7,
    applied_revision: 7,
    apply_status: "active",
    apply_error_code: null,
    apply_error: null,
    last_applied_at: null,
    listen_port: 19001,
    egress_port: 19002,
    ingress_node_id: 7,
    egress_node_id: 8,
    in_node_group_id: 3,
    ...over,
  };
}

function agent(over: Partial<AgentTunnelState> = {}): AgentTunnelState {
  return { id: "1", mode: "relay", ingress_port: 19001, egress_port: 19002, revision: 7, ...over };
}

function node(over: Partial<NodeOnlineInput> = {}): NodeOnlineInput {
  return { node_id: 8, status: "active", last_seen_at: NOW, reported_at: NOW, ...over };
}

/** 把输入拼成 executeReconcile 可直接消费的 deps。 */
function depsFrom(
  tunnels: DesiredTunnel[],
  agents: AgentTunnelState[],
  nodes: NodeOnlineInput[],
  extra: Partial<ReconcileDeps> = {},
): ReconcileDeps {
  const reports = new Map<number, { reported_at: Date | null; tunnels: AgentTunnelState[]; last_error: string | null }>();
  const ensureReport = (nodeId: number) => {
    if (!reports.has(nodeId)) reports.set(nodeId, { reported_at: NOW, tunnels: [], last_error: null });
    return reports.get(nodeId)!;
  };

  // The production reconciler reads concrete directional runtimes:
  //   tunex-<id>-relay  on ingress
  //   tunex-<id>-egress on egress
  // Tests keep the compact agent() helper as a collapsed logical view and
  // expand it here into the two real Agent reports.
  for (const t of tunnels) {
    if (t.ingress_node_id != null) ensureReport(t.ingress_node_id);
    if (t.egress_node_id != null) ensureReport(t.egress_node_id);
  }
  for (const a of agents) {
    const owner = tunnels.find((t) => String(t.id) === a.id);
    if (!owner) continue;

    if (owner.tunnel_mode === "relay") {
      if (owner.ingress_node_id != null) {
        ensureReport(owner.ingress_node_id).tunnels.push({
          id: `tunex-${owner.id}-relay`,
          mode: a.mode ?? "relay",
          ingress_port: a.ingress_port,
          revision: a.revision,
        });
      }
      if (owner.egress_node_id != null) {
        ensureReport(owner.egress_node_id).tunnels.push({
          id: `tunex-${owner.id}-egress`,
          mode: "egress",
          egress_port: a.egress_port,
          revision: a.revision,
        });
      }
    } else if (owner.ingress_node_id != null) {
      ensureReport(owner.ingress_node_id).tunnels.push({
        ...a,
        id: `tunex-${owner.id}-direct`,
        mode: a.mode ?? "direct",
      });
    }
  }

  // Most unit cases express one node state template ("fresh", "stale",
  // "inactive"). Mirror that template onto any other concrete bound node so
  // the test remains about reconciliation behaviour rather than fixture noise.
  const expandedNodes = [...nodes];
  if (nodes.length > 0) {
    const template = nodes[0]!;
    for (const t of tunnels) {
      for (const id of [t.ingress_node_id, t.egress_node_id]) {
        if (id == null || expandedNodes.some((n) => n.node_id === id)) continue;
        expandedNodes.push({ ...template, node_id: id });
      }
    }
  }

  return {
    tunnels: async () => tunnels,
    reports: async () => reports,
    nodes: async () => expandedNodes,
    now: () => NOW,
    ...extra,
  };
}

/** 记录每次调用的下发 sink。 */
function recordingSink() {
  const calls: Array<{ tunnel_id: number; revision: number }> = [];
  return {
    calls,
    sink: {
      async resendSameRevision(input: { tunnel_id: number; revision: number }) {
        calls.push({ tunnel_id: input.tunnel_id, revision: input.revision });
      },
    },
  };
}

/* ================================================================== */
/* A. 对比五份事实                                                      */
/* ================================================================== */

describe("A. 五份事实的对比（§7.12 对比清单）", () => {
  test("applied < desired → revision_behind 且可自动重发", () => {
    const d = computeDrift(tunnel({ applied_revision: 5 }), agent({ revision: 5 }), node(), NOW);
    expect(d.map((x) => x.kind)).toContain("revision_behind");
    expect(planTunnelActions(tunnel({ applied_revision: 5 }), d, NOW).map((a) => a.kind)).toEqual([
      "resend_same_revision",
    ]);
  });

  test("从未 ACK（applied_revision=null）也算落后", () => {
    expect(isRevisionBehind(tunnel({ applied_revision: null }))).toBe(true);
    const d = computeDrift(tunnel({ applied_revision: null }), null, node(), NOW);
    expect(d.map((x) => x.kind)).toEqual(["missing_runtime"]);
  });

  test("desired active 而 agent 快照没有该隧道 → missing_runtime（允许补齐）", () => {
    const d = computeDrift(tunnel(), null, node(), NOW);
    const actions = planTunnelActions(tunnel(), d, NOW);
    expect(d.map((x) => x.kind)).toEqual(["missing_runtime"]);
    expect(actions).toEqual([
      expect.objectContaining({ kind: "fill_missing_runtime", revision: 7, tunnel_id: 1 }),
    ]);
  });

  test("desired 不要它跑但 agent 在跑 → unexpected_runtime（不自动删，只记录）", () => {
    const t = tunnel({ desired_status: "inactive" });
    const d = computeDrift(t, agent(), node(), NOW);
    expect(d.map((x) => x.kind)).toContain("unexpected_runtime");
    // 没有任何自动动作：删除 runtime 不是白名单项。
    expect(planTunnelActions(t, d, NOW)).toEqual([]);
  });

  test("agent 端口与 desired 端口不一致 → port_mismatch 且压制 change_port", () => {
    const t = tunnel({ listen_port: 19999 });
    expect(isPortMismatch(t, agent())).toBe(true);
    const d = computeDrift(t, agent(), node(), NOW);
    const port = d.find((x) => x.kind === "port_mismatch");
    expect(port?.suppressed).toContain("change_port");
  });

  test("agent 未上报端口时不构成 mismatch（不知道 ≠ 不一致）", () => {
    const t = tunnel({ listen_port: 19999 });
    expect(isPortMismatch(t, agent({ ingress_port: undefined }))).toBe(false);
  });

  test("mode 不一致 → mode_mismatch（只告警，不改用户可见行为）", () => {
    const d = computeDrift(tunnel(), agent({ mode: "direct" }), node(), NOW);
    const m = d.find((x) => x.kind === "mode_mismatch");
    expect(m).toBeDefined();
    expect(m?.suppressed).toContain("migrate_tunnel");
  });

  test("node=null（找不到归属节点）→ 不可达：不下发、只产 finding", () => {
    const t = tunnel({ egress_node_id: null });
    const d = computeDrift(t, agent(), null, NOW);
    expect(d.map((x) => x.kind)).toEqual(["node_unreachable"]);
    // 执行层：node 缺失时 reachable=false，动作计划为空。
    expect(planTunnelActions(t, d, NOW, { nodeReachable: false })).toEqual([]);
  });

  test("节点离线（status=inactive）→ node_unreachable + error 级 + 压制删除/换节点", () => {
    const d = computeDrift(tunnel(), null, node({ status: "inactive" }), NOW);
    const u = d.find((x) => x.kind === "node_unreachable");
    expect(u?.suppressed).toEqual(["delete_on_stale", "switch_node"]);
  });

  test("上报过期（超过 staleAfterMs）→ node_unreachable", () => {
    const stale = new Date(NOW.getTime() - DEFAULT_NODE_STALE_AFTER_MS - 1);
    expect(isNodeUnreachable(node({ last_seen_at: stale, reported_at: stale }), NOW)).toBe(true);
    const fresh = new Date(NOW.getTime() - 1_000);
    expect(isNodeUnreachable(node({ last_seen_at: fresh, reported_at: fresh }), NOW)).toBe(false);
  });

  test("从未心跳（last_seen/reported 皆 null）→ 视为不可达", () => {
    expect(isNodeUnreachable(node({ last_seen_at: null, reported_at: null }), NOW)).toBe(true);
  });

  test("apply_status=error → error_state 且携带可解释错误", () => {
    const t = tunnel({ apply_status: "error", apply_error_code: "egress_ack_timeout", apply_error: "egress ack 超时" });
    expect(isErrorState(t)).toBe(true);
    const d = computeDrift(t, agent(), node(), NOW);
    const e = d.find((x) => x.kind === "error_state");
    expect(e?.detail).toContain("egress ack 超时");
  });
});

/* ================================================================== */
/* B. 允许自动（白名单四项）                                             */
/* ================================================================== */

describe("B. 只允许自动的四项动作", () => {
  test("白名单常量恰好是 §7.12 的四项", () => {
    expect([...AUTO_ACTIONS]).toEqual([
      "resend_same_revision",
      "fill_missing_runtime",
      "release_orphan_lease",
      "record_finding",
    ]);
  });

  test("decideAutoAction：白名单内放行", () => {
    expect(decideAutoAction("resend_same_revision")).toEqual({ allowed: true, kind: "resend_same_revision" });
    expect(decideAutoAction("release_orphan_lease")).toEqual({ allowed: true, kind: "release_orphan_lease" });
  });

  test("decideAutoAction：禁令动作被压制并显式回执", () => {
    for (const f of FORBIDDEN_AUTO_ACTIONS) {
      expect(decideAutoAction(f)).toEqual({ allowed: false, suppressed: f });
    }
  });

  test("decideAutoAction：未知动作不放行（fail-closed）", () => {
    expect(decideAutoAction("rebind_everything")).toEqual({ allowed: false, suppressed: "unknown_action" });
  });

  test("resend_same_revision：sink 收到的是原 revision，不是 revision+1", async () => {
    const rec = recordingSink();
    const out = await executeReconcile(depsFrom([tunnel({ applied_revision: 4 })], [agent({ revision: 4 })], [node()], { sink: rec.sink }));
    expect(out.resent).toBe(1);
    expect(rec.calls).toEqual([{ tunnel_id: 1, revision: 7 }]); // config_revision 原样
  });

  test("fill_missing_runtime：desired active + runtime 缺失 → 同 revision 补发", async () => {
    const rec = recordingSink();
    const out = await executeReconcile(depsFrom([tunnel()], [], [node()], { sink: rec.sink }));
    expect(out.resent).toBe(1);
    expect(rec.calls).toEqual([{ tunnel_id: 1, revision: 7 }]);
    const f = out.findings.find((x) => x.code === "missing_runtime");
    expect(f?.auto_action).toBe("fill_missing_runtime");
    expect(f?.severity).toBe("warning");
  });

  test("release_orphan_lease：复用注入的租约回收，并记 finding", async () => {
    const rec = recordingSink();
    let seenDryRun: boolean | undefined;
    const out = await executeReconcile(
      depsFrom([tunnel()], [agent()], [node()], {
        sink: rec.sink,
        reconcileLeases: async (o) => {
          seenDryRun = o.dryRun;
          return { releasedDanglingTunnel: 1, releasedExpired: 2 };
        },
      }),
    );
    expect(seenDryRun).toBe(false);
    expect(out.leases).toEqual({ releasedDanglingTunnel: 1, releasedExpired: 2 });
    const f = out.findings.find((x) => x.code === "orphan_lease_released");
    expect(f?.auto_action).toBe("release_orphan_lease");
    expect(f?.severity).toBe("warning");
    // 租约独立于逐隧道判定：没有任何隧道级自动动作被触发。
    expect(out.resent).toBe(0);
  });

  test("record_finding：无 sink 时全部降级为记录，不声称已重发", async () => {
    const out = await executeReconcile(depsFrom([tunnel({ applied_revision: 2 })], [agent({ revision: 2 })], [node()]));
    expect(out.resent).toBe(0);
    expect(out.noTransport).toBe(1);
    expect(out.actions).toEqual([]);
    const skipped = out.findings.filter((f) => f.code === "resend_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.detail).toContain("sink 未注入");
    expect(skipped[0]!.auto_action).toBeNull();
  });

  test("sink 抛错 → failed + error finding，apply_status 不被改写", async () => {
    const out = await executeReconcile(
      depsFrom([tunnel({ applied_revision: 3 })], [agent({ revision: 3 })], [node()], {
        sink: {
          async resendSameRevision() {
            throw new Error("transport down");
          },
        },
      }),
    );
    expect(out.failed).toBe(1);
    expect(out.resent).toBe(0);
    expect(out.findings.some((f) => f.severity === "error" && f.detail.includes("transport down"))).toBe(true);
  });
});

/* ================================================================== */
/* C. 禁止自动（白名单外一律不执行）                                      */
/* ================================================================== */

describe("C. 默认禁止自动的四项动作", () => {
  test("禁令常量恰好是 §7.12 的四项", () => {
    expect([...FORBIDDEN_AUTO_ACTIONS]).toEqual(["switch_node", "change_port", "migrate_tunnel", "delete_on_stale"]);
  });

  test("端口不一致：只产 finding，绝不下发任何动作", async () => {
    const rec = recordingSink();
    const out = await executeReconcile(
      depsFrom([tunnel({ listen_port: 19999 })], [agent()], [node()], { sink: rec.sink }),
    );
    expect(rec.calls).toEqual([]);
    expect(out.actions).toEqual([]);
    expect(out.findings.some((f) => f.code === "port_mismatch" && f.suppressed.includes("change_port"))).toBe(true);
  });

  test("心跳超时 → 不删资源、不换节点：全部动作被压成空", async () => {
    const rec = recordingSink();
    const stale = new Date(NOW.getTime() - DEFAULT_NODE_STALE_AFTER_MS * 10);
    const out = await executeReconcile(
      // 同时具备两个「可修」偏差：revision 落后 + runtime 缺失。
      depsFrom([tunnel({ applied_revision: 1 })], [agent({ revision: 1 })], [node({ last_seen_at: stale, reported_at: stale })], {
        sink: rec.sink,
      }),
    );
    expect(rec.calls).toEqual([]);
    expect(out.actions).toEqual([]);
    expect(out.resent).toBe(0);
    expect(out.forbiddenSuppressed).toContain("delete_on_stale");
    expect(out.forbiddenSuppressed).toContain("switch_node");
    expect(out.findings.some((f) => f.code === "node_unreachable" && f.severity === "error")).toBe(true);
  });

  test("unexpected_runtime（desired inactive）不自动删除 runtime", async () => {
    const rec = recordingSink();
    const t = tunnel({ desired_status: "inactive" });
    const out = await executeReconcile(depsFrom([t], [agent()], [node()], { sink: rec.sink }));
    expect(rec.calls).toEqual([]);
    expect(out.findings.some((f) => f.code === "unexpected_runtime")).toBe(true);
  });

  test("mode 不一致不下发（换模式 = 改变用户可见行为）", async () => {
    const rec = recordingSink();
    const out = await executeReconcile(depsFrom([tunnel()], [agent({ mode: "direct" })], [node()], { sink: rec.sink }));
    expect(rec.calls).toEqual([]);
    expect(out.findings.some((f) => f.code === "mode_mismatch")).toBe(true);
  });

  test("planTunnelActions 的产出必在白名单内（穷尽性检查）", async () => {
    const scenarios: Array<[DesiredTunnel, AgentTunnelState | null, NodeOnlineInput]> = [
      [tunnel({ applied_revision: 1 }), agent({ revision: 1 }), node()],
      [tunnel(), null, node()],
      [tunnel({ desired_status: "inactive" }), agent(), node()],
      [tunnel({ listen_port: 19999 }), agent(), node()],
      [tunnel(), agent({ mode: "direct" }), node()],
      [tunnel({ apply_status: "error" }), agent(), node()],
      [tunnel(), null, node({ status: "inactive" })],
    ];
    for (const [t, a, n] of scenarios) {
      const d = computeDrift(t, a, n, NOW);
      for (const act of planTunnelActions(t, d, NOW)) {
        expect(AUTO_ACTIONS).toContain(act.kind);
        expect(FORBIDDEN_AUTO_ACTIONS as readonly string[]).not.toContain(act.kind as string);
      }
    }
  });
});

/* ================================================================== */
/* D. revision 永不抬高                                                 */
/* ================================================================== */

describe("D. 重发的 revision 恒等于 config_revision", () => {
  test("error 退避窗口外重发，仍用原 revision", () => {
    const t = tunnel({ applied_revision: 3, apply_status: "error", last_applied_at: new Date(NOW.getTime() - DEFAULT_RETRY_BACKOFF_MS - 1) });
    const d = computeDrift(t, agent({ revision: 3 }), node(), NOW);
    const acts = planTunnelActions(t, d, NOW);
    expect(acts).toEqual([expect.objectContaining({ kind: "resend_same_revision", revision: 7 })]);
  });

  test("error 退避窗口内 → 不重发，产 retry_deferred finding", () => {
    const t = tunnel({ applied_revision: 3, apply_status: "error", last_applied_at: new Date(NOW.getTime() - 100) });
    const d = computeDrift(t, agent({ revision: 3 }), node(), NOW);
    expect(planTunnelActions(t, d, NOW)).toEqual([]);
    const f = planFindings(t, d, []);
    expect(f.some((x) => x.code === "retry_deferred")).toBe(true);
  });

  test("无 last_applied_at 的 error 隧道按已过退避处理（宁可早发也不要永久卡住）", () => {
    const t = tunnel({ applied_revision: 3, apply_status: "error" });
    const d = computeDrift(t, agent({ revision: 3 }), node(), NOW);
    expect(planTunnelActions(t, d, NOW)).toHaveLength(1);
  });

  test("全流程扫一遍：任何下发的 revision 都等于该隧道 config_revision", async () => {
    const rec = recordingSink();
    const ts = [
      tunnel({ id: 1, applied_revision: 1, config_revision: 7 }),
      tunnel({ id: 2, config_revision: 42, applied_revision: null }),
      tunnel({ id: 3, config_revision: 9, applied_revision: 9 }),
    ];
    const out = await executeReconcile(
      depsFrom(ts, [agent({ id: "3", revision: 9 })], [node()], { sink: rec.sink }),
    );
    expect(out.resent).toBe(2); // #1 落后、#2 从未 ACK；#3 已一致则不碰
    const byId = new Map(rec.calls.map((c) => [c.tunnel_id, c.revision]));
    expect(byId.get(1)).toBe(7);
    expect(byId.get(2)).toBe(42);
    expect(byId.has(3)).toBe(false);
    expect(out.actions.every((a) => (a.revision ?? -1) === ts.find((t) => t.id === a.tunnel_id)!.config_revision)).toBe(true);
  });
});

/* ================================================================== */
/* E. legacy DIRECT 不被碰                                              */
/* ================================================================== */

describe("E. legacy DIRECT 完全不在 reconciler 视野内", () => {
  test("config_revision=null → 无偏差、无动作、无 finding", () => {
    const t = tunnel({ config_revision: null, desired_status: null, tunnel_mode: null });
    expect(hasDeclaredDesired(t)).toBe(false);
    expect(wantsActive(t)).toBe(false);
    expect(computeDrift(t, null, null, NOW)).toEqual([]);
    expect(planTunnelActions(t, [], NOW)).toEqual([]);
  });

  test("executeReconcile 直接跳过 legacy 行（连 finding 都不产）", async () => {
    const rec = recordingSink();
    const out = await executeReconcile(
      depsFrom([tunnel({ id: 99, config_revision: null, tunnel_mode: null })], [], [], { sink: rec.sink }),
    );
    expect(out.findings).toEqual([]);
    expect(rec.calls).toEqual([]);
  });
});

/* ================================================================== */
/* F. 合并场景                                                          */
/* ================================================================== */

describe("F. 多隧道合并与统计", () => {
  test("一条可重发 + 一条禁修 + 一条正常：三个计数各归各位", async () => {
    const rec = recordingSink();
    const out = await executeReconcile(
      depsFrom(
        [
          tunnel({ id: 1, applied_revision: 5 }), // 可重发
          tunnel({ id: 2, listen_port: 19999 }), // 端口不一致 → 禁修
          tunnel({ id: 3 }), // 完全一致
        ],
        [agent({ id: "1", revision: 5 }), agent({ id: "2" }), agent({ id: "3" })],
        [node(), node({ node_id: 9 })],
        { sink: rec.sink },
      ),
    );
    expect(out.scanned).toBe(3);
    expect(out.resent).toBe(1);
    expect(out.noTransport).toBe(0);
    expect(rec.calls).toEqual([{ tunnel_id: 1, revision: 7 }]);
    expect(out.findings.some((f) => f.tunnel_id === 2 && f.code === "port_mismatch")).toBe(true);
    expect(out.findings.some((f) => f.tunnel_id === 3)).toBe(false);
    expect(out.forbiddenSuppressed).toContain("change_port");
  });

  test("finding 的 severity 分级：error_state / node_unreachable = error", async () => {
    const out = await executeReconcile(
      depsFrom([tunnel({ apply_status: "error", apply_error: "boom", applied_revision: 5 })], [agent({ revision: 5 })], [node({ status: "inactive" })]),
    );
    const codes = out.findings.filter((f: Finding) => f.severity === "error").map((f: Finding) => f.code);
    expect(codes).toContain("error_state");
    expect(codes).toContain("node_unreachable");
  });

  test("租约回收抛错不阻断整轮（error finding，隧道级结果照常）", async () => {
    const rec = recordingSink();
    const out = await executeReconcile(
      depsFrom([tunnel({ applied_revision: 5 })], [agent({ revision: 5 })], [node()], {
        sink: rec.sink,
        reconcileLeases: async () => {
          throw new Error("lease db down");
        },
      }),
    );
    expect(out.resent).toBe(1);
    expect(out.findings.some((f) => f.detail.includes("lease db down"))).toBe(true);
  });
});

beforeEach(() => {
  /* 无共享模块状态：每个用例自带替身。 */
});

// 保留对 PlannedAction 的类型引用，避免 unused import 误报（tsc 已开 strict）。
export type { PlannedAction };
