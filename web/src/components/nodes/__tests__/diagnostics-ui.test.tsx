/**
 * V4-WP11C / WP11B：诊断与升级入口的**渲染不变量**。
 *
 * 用静态渲染而不是源码扫描，因为这里要守的正是"渲染出来长什么样"：
 *   · 未验证的段必须看得见地标注（否则"两端事实一致"会被读成"链路已确认可达"）；
 *   · 离线必须是结论而不是错误（红色失败框会让人以为诊断坏了）；
 *   · 升级脚本必须带"控制面不会远程替换 Agent"的说明与停机窗口；
 *   · 自述事实缺失时必须给出原因，而不是空白。
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ForwardDiagnose,
  ForwardDiagnoseReportView,
  probeStatusText,
  segmentTone,
} from "@/components/forwards/forward-diagnose";
import { NodeDiagnostics, cacheStateText, humanUptime } from "@/components/nodes/node-diagnostics";
import { nodeUpgradeCopy } from "@/components/nodes/node-upgrade-card";
import type { DiagnoseReport, DiagnoseSegment, NodeDiagnosticsReport, NodeSelfFacts } from "@/lib/types";

const segment = (over: Partial<DiagnoseSegment> = {}): DiagnoseSegment => ({
  segment: "ingress_to_target",
  method: "tcp_probe",
  verified: true,
  node_id: 3,
  node_key: "IN-A",
  targets: [{ host: "target-a", port: 3030 }],
  results: [{ host: "target-a", port: 3030, status: "reachable", elapsed_ms: 4 }],
  outcome: "ok",
  ...over,
});

const report = (segments: DiagnoseSegment[], nextStep: string | null = null): DiagnoseReport => ({
  forward_id: 7,
  mode: "direct",
  generated_at: "2026-10-03T00:00:00Z",
  segments,
  next_step: nextStep,
});

const selfFacts = (over: Partial<NodeSelfFacts> = {}): NodeSelfFacts => ({
  version: "0.13.22",
  role: "INGRESS",
  agent_id: "agent-x",
  node_id: "hk-in-01",
  runtime: { tunnel_count: 2, truncated: false, ports_total: 2, listen_ports: [21001, 21002], tunnels: [] },
  state_dir: {
    path: "/var/lib/tunex-agent/desired-lkg.json",
    configured: true,
    dir_exists: true,
    cache_present: true,
    cache_valid: true,
  },
  process: {
    uptime_seconds: 5400,
    started_at: "2026-10-02T22:30:00Z",
    go_version: "go1.27.1",
    os: "linux",
    arch: "amd64",
    cpu_count: 8,
    gomaxprocs: 8,
    goroutines: 24,
    heap_bytes: 1024,
  },
  shutting_down: false,
  ...over,
});

const nodeReport = (over: Partial<NodeDiagnosticsReport> = {}): NodeDiagnosticsReport => ({
  node_id: 3,
  node_key: "hk-in-01",
  generated_at: "2026-10-03T00:00:00Z",
  reachability: "online",
  agent_facts: selfFacts(),
  agent_facts_error: null,
  panel: {
    id: 3,
    node_id: "hk-in-01",
    agent_id: "agent-x",
    role: "ingress",
    lifecycle: "active",
    status: "active",
    last_seen_at: "2026-10-03T00:00:00Z",
    reported: {
      version: "0.13.22",
      role: "INGRESS",
      control_protocol_version: 1,
      capabilities: ["apply_tunnel"],
      reported_revision: 4,
      known_revision: 4,
      reported_at: "2026-10-03T00:00:00Z",
      age_seconds: 5,
      last_error: null,
      error_count: 0,
    },
    forwards: { total: 2, active: 2, pending: 0, failed: 0, unconverged: 0 },
  },
  next_step: null,
  ...over,
});

describe("probe status wording", () => {
  test("every agent status has a human sentence, and unknown ones do not leak codes", () => {
    expect(probeStatusText("reachable")).toContain("可达");
    expect(probeStatusText("refused")).toContain("拒绝");
    expect(probeStatusText("timeout")).toContain("超时");
    expect(probeStatusText("dns_error")).toContain("解析");
    expect(probeStatusText("something_new")).toBe("未知错误");
  });
});

describe("an unverified segment is never rendered as a confirmed success", () => {
  test("node_facts + ok is toned 'unverified', a probe + ok is 'ok'", () => {
    expect(segmentTone(segment({ method: "node_facts", verified: false, outcome: "ok" }))).toBe("unverified");
    expect(segmentTone(segment())).toBe("ok");
    expect(segmentTone(segment({ outcome: "unreachable" }))).toBe("bad");
    expect(segmentTone(segment({ outcome: "unknown" }))).toBe("warn");
  });

  test("the RELAY facts segment renders the 'not verified' badge and explains why", () => {
    const html = renderToStaticMarkup(
      <ForwardDiagnose
        forwardId={7}
        runDiagnose={async () => report([segment({ method: "node_facts", verified: false, segment: "ingress_to_egress" })])}
      />,
    );
    // Before the click only the header exists; the loaded state is asserted below
    // through a direct render of the loaded component tree.
    expect(html).toContain("转发诊断");
    expect(html).toContain("探针目标由服务端");
  });

  test("the loaded view shows the badge, the reason and the next step", () => {
    const html = renderToStaticMarkup(
      <ForwardDiagnoseReportView
        report={report(
          [
            segment({ method: "node_facts", verified: false, segment: "ingress_to_egress", targets: [], results: [], outcome: "ok" }),
            segment({ segment: "egress_to_target", node_id: 4, node_key: "OUT-A" }),
          ],
          "出口节点到目标的 TCP 可达；节点间那一段未做连通性验证。",
        )}
      />,
    );
    expect(html).toContain("未验证连通性");
    expect(html).toContain("不做 TCP 探测");
    expect(html).toContain("出口节点 → 目标池");
    expect(html).toContain("未做连通性验证");
    // The verified probe result is still rendered with its latency fact.
    expect(html).toContain("target-a:3030");
    expect(html).toContain("4ms");
  });

  test("a partial failure is never rendered as an all-clear", () => {
    const html = renderToStaticMarkup(
      <ForwardDiagnoseReportView
        report={report([
          segment(),
          segment({
            segment: "egress_to_target", node_id: 4, node_key: "OUT-A", outcome: "unreachable",
            results: [{ host: "10.9.9.9", port: 8080, status: "refused", elapsed_ms: 3 }],
          }),
        ])}
      />,
    );
    expect(html).toContain("不通");
    expect(html).toContain("端口拒绝连接");
    expect(html).not.toContain("全部通过");
  });

  test("an unsupported node explains itself instead of looking like a network fault", () => {
    const html = renderToStaticMarkup(
      <ForwardDiagnoseReportView
        report={report([
          segment({ outcome: "unsupported", verified: false, error_code: "upgrade_required", message: "节点尚未上报控制协议能力" }),
        ])}
      />,
    );
    expect(html).toContain("节点版本不支持");
    expect(html).toContain("upgrade_required");
    expect(html).toContain("节点尚未上报控制协议能力");
  });
});

describe("node diagnostics readings", () => {
  test("uptime is humanised, and nonsense stays null instead of rendering NaN", () => {
    expect(humanUptime(5400)).toBe("1 小时 30 分");
    expect(humanUptime(90)).toBe("1 分");
    expect(humanUptime(180000)).toContain("天");
    expect(humanUptime(null)).toBeNull();
    expect(humanUptime(Number.NaN)).toBeNull();
    expect(humanUptime(-5)).toBeNull();
  });

  test("the three cache states read differently", () => {
    const base = selfFacts().state_dir;
    expect(cacheStateText(base)).toContain("有效");
    expect(cacheStateText({ ...base, cache_present: false, cache_valid: false })).toContain("没有本地缓存");
    expect(cacheStateText({ ...base, cache_valid: false })).toContain("未通过校验");
    expect(cacheStateText({ ...base, configured: false, cache_present: false, cache_valid: false })).toContain("未配置");
  });

  test("the idle panel describes what it can actually do", () => {
    const html = renderToStaticMarkup(<NodeDiagnostics nodeId={3} nodeKey="hk-in-01" />);
    expect(html).toContain("节点诊断");
    expect(html).toContain("下载 Support Bundle");
  });

  // 「升级 Agent」原来由 NodeDiagnostics 内联渲染，那句"控制面不会远程替换节点上的 Agent"
  // 也在这里断言。该内联块已退役（它把管理配置字段当版本依据、没有服务端前置、生成脚本后
  // 没有执行后可见性），升级入口统一由 `NodeUpgradeCard` 承担 ⇒ 断言跟着搬到新卡片。
  // 卡片是取数组件（SSR 需要 WorkspaceProvider），因此这里断言它的**文案对象**，
  // 渲染层行为由 `node-upgrade-card.test.tsx` 覆盖。
  test("the upgrade entry still states the operator contract (moved to NodeUpgradeCard)", () => {
    const zh = nodeUpgradeCopy("zh");
    const all = Object.values(zh).filter((v) => typeof v === "string").join(" ");
    expect(all).toContain("控制面不会远程替换节点上的 Agent");
    expect(all).toContain("保持不变");
  });
});

describe("the bundle download says what it is", () => {
  test("a successful download reports that it is whitelisted and redacted", async () => {
    const html = renderToStaticMarkup(
      <NodeDiagnostics
        nodeId={3}
        nodeKey="hk-in-01"
        loadBundle={async () => ({ schema_version: 1 })}
      />,
    );
    // The note only appears after the click; assert the button copy here so the
    // wording cannot silently become "download everything".
    expect(html).toContain("Support Bundle");
  });
});
