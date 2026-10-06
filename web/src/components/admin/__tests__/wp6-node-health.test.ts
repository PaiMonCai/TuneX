/**
 * V4-WP6 §13.4.4 — 节点健康（web 侧）契约单测。纯逻辑 + 源码断言，不起浏览器。
 *
 * 覆盖交付要求里的五件事：
 *   A. **端点契约**：`/admin/node/:id/health` 与 `/admin/node/health` 的响应形状
 *      与后端 `routes/node-health.ts` 一致（单节点裸 view；fleet 带 total/summary，
 *      且 summary 是**过滤前**全量口径）。
 *   B. **事实展示**：Agent 版本、资源采样、runtime 计数与端口、revision 对——
 *      UI 消费的每个字段都能从响应里取到，且「未知 ≠ 0」。
 *   C. **health / connection / lifecycle 三者正交**：offline 不判成 error，
 *      waiting（没凭据）与 never_reported 都落到 unknown。
 *   D. **可操作理由**：`port_not_bound` / `flags.ports_bound`（后端契约修订点）
 *      与其余 reason code 的词条覆盖 —— 未知码必须能被标题表退化处理而不是空白。
 *   E. **接线**：详情页挂了健康卡、列表页有健康列与四态概览、api.ts 用
 *      `unwrap: false` 取 fleet 信封。
 *
 * 跑法（web 目录）：bun test src/components/admin/__tests__/wp6-node-health.test.ts
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { handleMock } from "@/mocks/handler";
import { getStore, resetStore } from "@/mocks/state";
import {
  MOCK_REASON_CODES,
  mockHealthView,
  mockRuntimeId,
  type MockDesiredRuntime,
} from "@/mocks/node-health";
import {
  NODE_HEALTH_REASON_CODES,
  nodeHealthText,
  reasonAction,
  reasonTitle,
} from "@/lib/node-health-i18n";
import {
  EMPTY_HEALTH_SUMMARY,
  formatDuration,
  formatPercent,
  groupPorts,
  normalizeHealthSummary,
  resourceRows,
  runtimeCountEntries,
} from "@/lib/node-health";
import type { Node, NodeHealthView, NodeStateReport, NodeTelemetry } from "@/lib/types";

const COOKIE = "tunex_session=u1"; // mock 演示用户（owner，具备 admin 权限）
const call = <T>(method: string, path: string, query?: Record<string, string>) =>
  handleMock(method, path, { cookie: COOKIE, query }) as Promise<{ status: number; body: T }>;

/** 演示节点：sg-out-01（id 6）是种子里唯一「有凭据 + 在线 + 有上报」的节点。 */
const DEMO = 6;

beforeEach(() => {
  resetStore();
});

/* ================================================================== */
/* A. 端点契约                                                          */
/* ================================================================== */

describe("WP6 health 端点契约", () => {
  test("单节点：200 + 视图形状（health/connection/lifecycle/reasons/flags/telemetry）", async () => {
    const res = await call<NodeHealthView>("GET", `/admin/node/${DEMO}/health`);
    expect(res.status).toBe(200);
    const v = res.body;
    expect(v.node_id).toBe(DEMO);
    expect(v.node_key).toBe("sg-out-01");
    expect(["healthy", "warning", "error", "unknown"]).toContain(v.health);
    expect(["waiting", "online", "offline"]).toContain(v.connection);
    expect(["active", "maintenance", "disabled", "retiring"]).toContain(v.lifecycle);
    expect(Array.isArray(v.reasons)).toBe(true);
    // flags 是 reasons 的布尔投影，五个键都在（含契约修订新增的 ports_bound）
    expect(Object.keys(v.flags).sort()).toEqual(
      ["agent_errors_ongoing", "ports_bound", "reports_fresh", "resources_ok", "revision_in_sync"].sort(),
    );
    expect(v.telemetry).not.toBeNull();
  });

  test("单节点可用 node_id 字符串寻址（与后端 resolveNodeId 同语义）", async () => {
    const byKey = await call<NodeHealthView>("GET", "/admin/node/sg-out-01/health");
    expect(byKey.status).toBe(200);
    expect(byKey.body.node_id).toBe(DEMO);
  });

  test("未知节点 → 404（不返回空视图让面板误判为 healthy）", async () => {
    expect((await call("GET", "/admin/node/999/health")).status).toBe(404);
  });

  test("未上报的节点 → 200 且 telemetry 为 null（不是 404，也不是 0 值遥测）", async () => {
    const res = await call<NodeHealthView>("GET", "/admin/node/4/health");
    expect(res.status).toBe(200);
    expect(res.body.telemetry).toBeNull();
    expect(res.body.health).toBe("unknown");
    expect(res.body.reasons.map((r) => r.code)).toContain("never_reported");
  });

  test("fleet：返回 { data, total, summary }，summary 为四态计数", async () => {
    const res = await call<{ data: NodeHealthView[]; total: number; summary: Record<string, number> }>(
      "GET",
      "/admin/node/health",
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(getStore().nodes.length);
    expect(res.body.total).toBe(getStore().nodes.length);
    expect(Object.keys(res.body.summary).sort()).toEqual(["error", "healthy", "unknown", "warning"]);
    // summary 与 items 必须自洽：总数 = 四态之和
    const s = res.body.summary;
    expect(s.healthy + s.warning + s.error + s.unknown).toBe(res.body.total);
  });

  test("fleet：summary 是**过滤前**全量（列表被筛掉后计数不缩水）", async () => {
    const all = await call<{ total: number; summary: Record<string, number> }>("GET", "/admin/node/health");
    const filtered = await call<{ data: NodeHealthView[]; total: number; summary: Record<string, number> }>(
      "GET",
      "/admin/node/health",
      { health: "error" },
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.every((v) => v.health === "error")).toBe(true);
    expect(filtered.body.data.length).toBeLessThanOrEqual(all.body.data?.length ?? all.body.total);
    // 关键：total/summary 仍是全量口径
    expect(filtered.body.total).toBe(all.body.total);
    expect(filtered.body.summary).toEqual(all.body.summary);
  });

  test("fleet：非法 health / lifecycle 过滤值 → 400（不静默返回空列表）", async () => {
    expect((await call("GET", "/admin/node/health", { health: "banana" })).status).toBe(400);
    expect((await call("GET", "/admin/node/health", { lifecycle: "banana" })).status).toBe(400);
  });

  test("fleet：合法 lifecycle（含 all / 大小写）不报错", async () => {
    expect((await call("GET", "/admin/node/health", { lifecycle: "all" })).status).toBe(200);
    expect((await call("GET", "/admin/node/health", { lifecycle: "ACTIVE" })).status).toBe(200);
    expect((await call("GET", "/admin/node/health", { lifecycle: "maintenance" })).status).toBe(200);
  });
});

/* ================================================================== */
/* B. 事实展示：版本 / 资源 / runtime 计数与端口 / revision              */
/* ================================================================== */

describe("WP6 telemetry 展示字段", () => {
  test("版本：上报版本 + 面板建议版本 + uptime（面板时钟算）", async () => {
    const t = (await call<NodeHealthView>("GET", `/admin/node/${DEMO}/health`)).body.telemetry as NodeTelemetry;
    expect(t.version).toBe("1.8.4");
    expect(typeof t.expected_version).toBe("string");
    expect(t.hostname).toBe("sg-out-01");
    expect(t.os).toBe("linux");
    expect(t.arch).toBe("amd64");
    expect(t.uptime_seconds).toBeGreaterThan(0);
    expect(t.agent_started_at).not.toBeNull();
  });

  test("资源采样齐全：cpu / load / memory / disk / rss / host uptime", async () => {
    const t = (await call<NodeHealthView>("GET", `/admin/node/${DEMO}/health`)).body.telemetry as NodeTelemetry;
    const keys = resourceRows(t.host).map((r) => r.key);
    expect(keys).toEqual(["cpu", "load", "memory", "disk", "rss", "hostUptime"]);
    // 内存与磁盘有分母 → 有比例（渲染进度条的前提）
    expect(resourceRows(t.host).find((r) => r.key === "memory")?.ratio).not.toBeNull();
    expect(resourceRows(t.host).find((r) => r.key === "disk")?.ratio).not.toBeNull();
  });

  test("runtime 计数与运行清单 + 占用端口分组", async () => {
    const t = (await call<NodeHealthView>("GET", `/admin/node/${DEMO}/health`)).body.telemetry as NodeTelemetry;
    expect(runtimeCountEntries(t.runtime.counts)).toEqual([
      { key: "direct", value: 0 },
      { key: "relay_ingress", value: 0 },
      { key: "relay_egress", value: 2 },
      { key: "total", value: 2 },
    ]);
    expect(t.runtime.running).toEqual(["tunex-3-egress", "tunex-5-egress"]);
    expect(groupPorts(t.used_ports)).toBe("20010, 20030, 31011-31012");
  });

  test("revision 对：applied / known / pending 三者可由 UI 直接渲染", async () => {
    const t = (await call<NodeHealthView>("GET", `/admin/node/${DEMO}/health`)).body.telemetry as NodeTelemetry;
    expect(t.applied_revision).toBe(5);
    expect(t.known_revision).toBe(5);
    expect(t.revision_pending).toBe(false);
    const v = (await call<NodeHealthView>("GET", `/admin/node/${DEMO}/health`)).body;
    expect(v.forward_count).toBe(2);
    expect(v.desired_runtime_count).toBe(2);
  });

  test("错误账本：count / last_at / last_message 都在", async () => {
    const t = (await call<NodeHealthView>("GET", `/admin/node/${DEMO}/health`)).body.telemetry as NodeTelemetry;
    expect(t.errors.count).toBe(2);
    expect(t.errors.last_at).not.toBeNull();
    expect(t.errors.last_message).toContain("tunex-5-egress");
  });

  test("「未知 ≠ 0」：缺字段不上报时不编造数值", () => {
    // 旧 Agent 只报版本，不报资源 → 资源区不出行（而不是「内存 0%」）
    expect(resourceRows(null)).toEqual([]);
    expect(resourceRows({})).toEqual([]);
    expect(resourceRows({ cpu_count: 2 })).toEqual([{ key: "cpu", text: "2", ratio: null, note: null }]);
    // 分母缺失 ≠ 0%
    expect(formatPercent(null)).toBe("-");
    expect(formatDuration(null)).toBe("-");
    expect(formatDuration(-5)).toBe("-");
    expect(runtimeCountEntries(null)).toEqual([]);
    expect(runtimeCountEntries({})).toEqual([]);
    expect(groupPorts([])).toBe("-");
    expect(groupPorts(null)).toBe("-");
  });

  test("summary 归一化：缺字段 / 负数 / NaN 一律回落 0，且不改变全局常量", () => {
    expect(normalizeHealthSummary(undefined)).toEqual(EMPTY_HEALTH_SUMMARY);
    expect(normalizeHealthSummary({ healthy: 3 })).toEqual({ healthy: 3, warning: 0, error: 0, unknown: 0 });
    expect(normalizeHealthSummary({ healthy: -1, warning: Number.NaN, error: "2", unknown: 4 })).toEqual({
      healthy: 0,
      warning: 0,
      error: 0,
      unknown: 4,
    });
    expect(EMPTY_HEALTH_SUMMARY).toEqual({ healthy: 0, warning: 0, error: 0, unknown: 0 });
  });
});

/* ================================================================== */
/* C. health / connection / lifecycle 正交                              */
/* ================================================================== */

describe("WP6 三层状态正交", () => {
  test("无凭据 → connection=waiting、health=unknown、理由 no_credential", async () => {
    const v = (await call<NodeHealthView>("GET", "/admin/node/1/health")).body;
    expect(v.connection).toBe("waiting");
    expect(v.health).toBe("unknown");
    expect(v.reasons.map((r) => r.code)).toEqual(["no_credential"]);
  });

  test("有凭据但无上报 → connection=online（心跳新鲜）、health=unknown", async () => {
    const v = (await call<NodeHealthView>("GET", "/admin/node/4/health")).body;
    expect(v.connection).toBe("online");
    expect(v.health).toBe("unknown");
  });

  test("offline 不等于 error：连不上只是连接状态", async () => {
    // sg-out-02（id 7）无凭据；jp-out-02（id 5）凭据被吊销 → offline。
    // 两者都不允许被判成 error。
    for (const id of [5, 7]) {
      const v = (await call<NodeHealthView>("GET", `/admin/node/${id}/health`)).body;
      expect(v.connection).not.toBe("online");
      expect(v.health).toBe("unknown");
      expect(v.health).not.toBe("error");
    }
  });

  test("生命周期独立于连接：维护中的节点仍可 online", () => {
    const base: Node = {
      id: 42,
      node_id: "n42",
      weight: 1,
      status: "active",
      connect_ip: "1.1.1.1",
      version: "1.8.4",
      backup: false,
      order_by: 1,
      custom_line: null,
      dns_status: false,
      node_group_id: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      role: "ingress",
      last_seen_at: "2026-09-23T10:00:00.000Z",
      has_credential: true,
      credential_revoked: false,
      lifecycle: "maintenance",
    };
    const view = mockHealthView({
      node: base,
      snapshot: undefined,
      desired: [],
      forward_count: 0,
      now: new Date("2026-09-23T10:00:00.000Z"),
      expected_version: null,
    });
    expect(view.connection).toBe("online");
    expect(view.lifecycle).toBe("maintenance");
    expect(view.health).toBe("unknown"); // 无上报 → unknown，但连接与生命周期各自独立汇报
  });
});

/* ================================================================== */
/* D. 可操作理由（含后端契约修订点 port_not_bound / flags.ports_bound）   */
/* ================================================================== */

describe("WP6 理由与 flags", () => {
  const node: Node = {
    id: 9,
    node_id: "n9",
    weight: 1,
    status: "active",
    connect_ip: "1.1.1.1",
    version: "1.8.4",
    backup: false,
    order_by: 1,
    custom_line: null,
    dns_status: false,
    node_group_id: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    role: "ingress",
    last_seen_at: "2026-09-23T10:00:00.000Z",
    has_credential: true,
    credential_revoked: false,
  };

  const snapshotWith = (over: Partial<NodeStateReport>): NodeStateReport => ({
    node_id: 9,
    version: "1.8.4",
    role: "ingress",
    reported_revision: 1,
    tunnels: [{ id: mockRuntimeId(10, "direct"), mode: "direct", revision: 1 }],
    egress_pools: null,
    used_ports: [20001],
    last_error: null,
    reported_at: "2026-09-23T10:00:00.000Z",
    updated_at: "2026-09-23T10:00:00.000Z",
    ...over,
  });

  const desired: MockDesiredRuntime[] = [
    { label: "Web", runtime_id: mockRuntimeId(10, "direct"), config_revision: 1, wants_active: true, listen_port: 20001 },
  ];

  const view = (over: Partial<NodeStateReport>) =>
    mockHealthView({
      node,
      snapshot: snapshotWith(over),
      desired,
      forward_count: 1,
      now: new Date("2026-09-23T10:00:00.000Z"),
      expected_version: "1.8.4",
    });

  test("全部正常 → healthy + 无理由 + ports_bound", () => {
    const v = view({});
    expect(v.health).toBe("healthy");
    expect(v.reasons).toEqual([]);
    expect(v.flags.ports_bound).toBe(true);
    expect(v.flags.resources_ok).toBe(true);
    expect(v.flags.revision_in_sync).toBe(true);
    expect(v.flags.reports_fresh).toBe(true);
  });

  test("runtime 在跑但监听端口未占用 → error + port_not_bound + ports_bound=false", () => {
    // 契约修订点：runtime 存在（got !== null）且 Agent 报过 used_ports，
    // 此时 listen_port 不在清单里才是「端口真的没被监听」。
    const v = view({ used_ports: [20099] });
    expect(v.health).toBe("error");
    const codes = v.reasons.map((r) => r.code);
    expect(codes).toContain("port_not_bound");
    expect(v.flags.ports_bound).toBe(false);
    const reason = v.reasons.find((r) => r.code === "port_not_bound")!;
    expect(reason.severity).toBe("error");
    expect(reason.detail).toBe("20001");
  });

  test("used_ports 缺失（旧 Agent）→ 不判端口：unknown ≠ 未占用", () => {
    const v = view({ used_ports: null });
    expect(v.reasons.map((r) => r.code)).not.toContain("port_not_bound");
    expect(v.flags.ports_bound).toBe(true);
    expect(v.health).toBe("healthy");
  });

  test("runtime 不存在时只报 runtime_missing，不重复报端口（避免噪声）", () => {
    const v = view({ tunnels: [] });
    const codes = v.reasons.map((r) => r.code);
    expect(codes).toContain("runtime_missing");
    expect(codes).not.toContain("port_not_bound");
    expect(v.health).toBe("error");
  });

  test("apply 失败优先于「没有运行」（原因优先于症状）", () => {
    const v = mockHealthView({
      node,
      snapshot: snapshotWith({ tunnels: [] }),
      desired: [{ ...desired[0]!, apply_status: "error", apply_error: "bind: address in use" }],
      forward_count: 1,
      now: new Date("2026-09-23T10:00:00.000Z"),
      expected_version: null,
    });
    expect(v.reasons[0]!.code).toBe("forward_apply_error");
    expect(v.reasons[0]!.detail).toBe("bind: address in use");
  });

  test("版本落后 → agent_version_behind；不可比较 → agent_version_unknown（不误判落后）", () => {
    expect(view({ version: "1.7.0" }).reasons.map((r) => r.code)).toContain("agent_version_behind");
    const unknown = view({ version: "unknown" });
    expect(unknown.reasons.map((r) => r.code)).toContain("agent_version_unknown");
    expect(unknown.reasons.map((r) => r.code)).not.toContain("agent_version_behind");
  });

  test("历史错误（超出持续窗口）→ warning 级 agent_errors_historical", () => {
    const v = view({ error_count: 3, last_error: "apply failed", last_error_at: "2026-09-23T09:00:00.000Z" });
    const codes = v.reasons.map((r) => r.code);
    expect(codes).toContain("agent_errors_historical");
    expect(v.reasons.find((r) => r.code === "agent_errors_historical")!.severity).toBe("warning");
    expect(v.health).toBe("warning");
  });

  test("资源超阈值 → resource_* warning 且 resources_ok=false（不升级成 error）", () => {
    const v = view({
      host_metrics: { cpu_count: 2, load1: 9, memory_total_bytes: 100, memory_used_bytes: 95 },
    });
    const codes = v.reasons.map((r) => r.code);
    expect(codes).toContain("resource_memory_high");
    expect(codes).toContain("resource_load_high");
    expect(v.flags.resources_ok).toBe(false);
    expect(v.health).toBe("warning");
  });

  test("reasons 按严重度排序（error → warning → info），UI 直接顺序渲染", () => {
    const v = view({ used_ports: [20099], error_count: 1, last_error: "x", last_error_at: "2026-09-23T09:00:00.000Z" });
    const order = { error: 0, warning: 1, info: 2 } as Record<string, number>;
    const sev = v.reasons.map((r) => order[r.severity]!);
    expect(sev).toEqual([...sev].sort((a, b) => a - b));
    expect(v.reasons[0]!.severity).toBe("error");
  });

  test("理由码覆盖：mock 会发出的每个码都有中英文标题与下一步动作", () => {
    for (const code of MOCK_REASON_CODES) {
      const zh = reasonTitle("zh", code, "");
      const en = reasonTitle("en", code, "");
      expect(zh.length).toBeGreaterThan(0);
      expect(en.length).toBeGreaterThan(0);
      expect(reasonAction("zh", code)).not.toBeNull();
      expect(reasonAction("en", code)).not.toBeNull();
    }
    // 码表与 mock 码集合同源，防止后端新增码后前端静默漏翻
    expect([...NODE_HEALTH_REASON_CODES].sort()).toEqual([...MOCK_REASON_CODES].sort());
  });

  test("未知码退化：标题回落后端原句、动作为 null（不编造建议、不空白）", () => {
    expect(reasonTitle("zh", "brand_new_code", "后端原句")).toBe("后端原句");
    expect(reasonTitle("en", "brand_new_code", "raw")).toBe("raw");
    expect(reasonAction("zh", "brand_new_code")).toBeNull();
  });

  test("中英文词条键集一致（缺键会让某语言整列空白）", () => {
    const zh = nodeHealthText("zh");
    const en = nodeHealthText("en");
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const h of ["healthy", "warning", "error", "unknown"] as const) {
      expect(zh.health[h].length).toBeGreaterThan(0);
      expect(en.health[h].length).toBeGreaterThan(0);
    }
  });
});

/* ================================================================== */
/* E. 接线（源码级断言：CI 无浏览器，故直接读文件）                        */
/* ================================================================== */

/** 与 forward-edit-dialog.test.ts 同一手法：CI 里没有浏览器，源码断言直接读文件。 */
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
/** 归一化：折叠空白 + 去掉点号周围空格，避免断言被 prettier 折行干扰。 */
const flat = (src: string) => src.replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".");

describe("WP6 接线", () => {
  const panel = read("node-health-panel.tsx");
  const manager = read("node-health-manager.tsx");
  const detail = read("node-detail-manager.tsx");
  const nodes = read("nodes-manager.tsx");
  const api = readFileSync(new URL("../../../lib/api/admin.ts", import.meta.url), "utf8");
  const apiCore = readFileSync(new URL("../../../lib/api/core.ts", import.meta.url), "utf8");

  test("api.ts 暴露两个端点，fleet 用 unwrap:false 取带 summary 的信封", () => {
    expect(api).toContain("/admin/node/${id}/health");
    expect(api).toContain('"/admin/node/health"');
    expect(api).toContain("unwrap: false");
    expect(api).toContain("normalizeHealthSummary");
  });

  test("详情页挂载健康卡（取数在 manager，渲染在 panel）", () => {
    expect(detail).toContain("NodeHealthManager");
    expect(flat(manager)).toContain("api.admin.nodeHealth(");
    expect(manager).toContain("NodeHealthPanel");
    expect(panel).toContain('data-testid="node-health"');
  });

  test("面板渲染：四态徽章 / 连接 / 生命周期 / flags / 理由 / 遥测各区块", () => {
    for (const id of [
      "node-health-badge",
      "node-health-connection",
      "node-health-lifecycle",
      "node-health-flags",
      "node-health-flag-ports",
      "node-health-reasons",
      "node-health-reason-action",
      "node-health-version",
      "node-health-resources",
      "node-health-runtime",
      "node-health-errors",
      "node-health-no-report",
    ]) {
      expect(panel).toContain(id);
    }
  });

  test("面板不自己判健康：没有版本比较 / 阈值比较的痕迹", () => {
    // 前端只渲染后端结论 —— 出现这些就意味着出现了「第二套真相」
    expect(panel).not.toContain("compareVersion");
    expect(panel).not.toContain(">= 0.85");
    expect(panel).not.toMatch(/health\s*=\s*["']error["']/);
  });

  test("列表页：健康列 + 全量四态概览，并在列表刷新后同步", () => {
    expect(nodes).toContain("nodeHealthList");
    expect(nodes).toContain("nodes-health-summary");
    expect(nodes).toContain("nodes-health-column");
    expect(nodes).toContain("NodeHealthCell");
    expect(nodes).toContain("void loadHealth()");
  });

  test("列表取数失败不炸页面：增强数据静默回落（健康列显示 -）", () => {
    // loadHealth 的 catch 不得向上抛（health 是增强列，404 也要能用）
    const block = nodes.slice(nodes.indexOf("const loadHealth"), nodes.indexOf("const loadHealth") + 600);
    expect(block).toContain("catch");
    expect(block).toContain("EMPTY_HEALTH_SUMMARY");
    expect(block).not.toContain("toast.error");
  });

  test("WP9 并行分支不冲突：共享文件的改动落在互不相交的区域", () => {
    // 本分支与 WP9 都在改 api.ts / types.ts / handler.ts。二者若改到同一段代码，
    // 合并时就得人工介入。这个断言把「我们只往末尾加、不动别人段落」固定下来：
    // 只要新代码仍集中在下面的锚点附近，合并就是干净的。
    expect(api.indexOf('"/admin/node/health"')).toBeGreaterThan(api.indexOf("nodeState:"));
    expect(apiCore.indexOf("unwrap?: boolean")).toBeGreaterThan(apiCore.indexOf("workspaceId?: number"));
    // 归一化后，事实投影留在 runtime，HTTP 路由只负责调用它。
    // 这比依赖同一大文件中的源码先后顺序更稳定。
    const runtime = readFileSync(new URL("../../../mocks/runtime.ts", import.meta.url), "utf8");
    const adminHandler = readFileSync(new URL("../../../mocks/handlers/admin.ts", import.meta.url), "utf8");
    expect(runtime).toContain("function healthWorld");
    expect(runtime).toContain("function mockIngressNode");
    expect(adminHandler).toContain("healthWorld(db)");
  });
});
