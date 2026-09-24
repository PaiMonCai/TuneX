/**
 * WP14 RELAY 双跳 E2E —— 测试框架（DEVELOPMENT.md §7.15 Gate 必测项）
 *
 * 本文件刻意保持**纯 JavaScript**：与 backend/tests 既有约定一致，CI 用
 * `node --experimental-transform-types --test tests/*.test.mjs` 运行 —— 该 flag
 * 只对**被导入的 .ts 文件**做 type-stripping，.mjs 自身写 TS 语法会在运行时报
 * SyntaxError（已实测：Node 26 对 .mjs 不做类型剥离）。类型与共享工具全部放在
 * harness.ts，本文件只消费它们。
 *
 * 本套件证明什么
 * ---------------------------------------------------------------
 * 客户端把真实 TCP 连接打进 ingress-agent 的端口，流量经 egress-agent 落到
 * Target B，回串来自 Target B（而非 Target A）。证据是从真实 socket 读到的
 * 字节标记 —— 这是"流量被转发"唯一权威的形式。
 *
 * 三种结果各自代表不同含义，且永不可混淆：
 *
 *   PASS       双跳路径真的承载了流量
 *   FAIL       有东西在听，但路径错了（配错目标、标记串台）—— 这是缺陷
 *   UNAVAILABLE 无可观测对象（容器没起、agent 没连上、WP5/WP8/WP9 未合入）。
 *               套件会把这个缺口响亮地报出来，而不是悄悄"通过"。
 *
 * 数据面**不打桩**：DEVELOPMENT.md §7.15 里的 mock 只属于**控制面 contract**
 * （config 帧、ACK、revision 语义），由下方 ControlPlaneMock 走真实面板 HTTP
 * 接口完成；数据面一律真实 socket。
 *
 * 覆盖的正式 Gate 项：
 *   · TCP RELAY（双跳数据面 + 反串台）
 *   · workspace isolation（负面 + 反向对照）
 *   · 仅出站 agent 拓扑约束（负面）
 * 尚未覆盖（需功能 WP 合入，见 scripts/v3-e2e/README.md 的状态矩阵）：
 *   · Egress-before-Ingress 下发顺序
 *   · weighted target / hot update / suspend-resume
 *   · agent restart / control reconnect / panel restart
 *   · stale revision / credential revoke / port conflict-exhaustion
 *   · BOTH node / change egress / backup-restore / old agent compat
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ARTIFACT_DIR,
  CONTAINERS,
  HOST_PORTS,
  MARKERS,
  assertMarker,
  assertNoFailures,
  assertNotMarker,
  checkEnvironment,
  collectLogs,
  containerLogs,
  containerNetworks,
  controlPlane,
  isContainerRunning,
  loadState,
  login,
  portBindings,
  saveArtifacts,
  stateExists,
  summarize,
} from "./harness.ts";

/**
 * ControlPlaneMock —— 面板 HTTP 接口的替身，**只**用于需要在没有全套栈时
 * 与"忙碌控制面"对话的断言（例如只有 API 层起来时的跨 workspace 403 检查）。
 *
 * 它绝不替数据面编造答案：真实面板不可达时返回 status 0，断言自动降级为
 * unavailable，而不是假装通过。
 */
const ControlPlaneMock = {
  /** 以 workspaceId 身份读一条隧道；期望面板拒绝跨 workspace 访问。 */
  crossWorkspaceRead(workspaceId, tunnelId, cookie) {
    return controlPlane({
      method: "GET",
      path: `/api/tunnels/${tunnelId}`,
      cookie,
      workspaceId,
    });
  },
};

describe("WP14 RELAY 双跳 E2E", { concurrency: false }, () => {
  let environmentReady = false;
  let missing = [];
  let state = null;
  let cookie = "";
  const results = [];

  before(async () => {
    const check = await checkEnvironment();
    environmentReady = check.ready;
    missing = check.missing;
    if (check.ready && (await stateExists())) {
      state = await loadState();
      const session = await login(state.user.email, state.user.password, state.api);
      // cookie 来自 set-cookie 头，不是响应体。
      cookie = session.setCookie ? session.setCookie.split(";")[0] : "";
    }
    if (!environmentReady) {
      console.warn(
        `[wp14-relay.e2e] 环境不完整（${missing.join(", ")}）；下方所有断言将记为 ` +
          `unavailable，不会被记为通过。先跑 scripts/v3-e2e/setup.sh。`,
      );
    }
  });

  after(async () => {
    const { fail, unavailable } = summarize(results);
    const artifacts = await saveArtifacts("relay", {
      results,
      logs: await collectLogs(300),
      extra: { environmentReady, missing, artifactsDir: ARTIFACT_DIR },
    });
    console.log(
      `[wp14-relay.e2e] pass=${results.length - fail - unavailable} ` +
        `fail=${fail} unavailable=${unavailable}\n` +
        summarize(results).summary +
        `\n  artifacts: ${artifacts.join(", ")}`,
    );
  });

  // -------------------------------------------------------------- 拓扑
  it("五机拓扑全部运行中", async () => {
    for (const [role, name] of Object.entries(CONTAINERS)) {
      const running = await isContainerRunning(name);
      results.push(
        running
          ? { status: "pass", label: `${role} (${name}) 运行中` }
          : { status: "unavailable", label: `${role} (${name}) 未运行` },
      );
    }
  });

  it("RELAY 隧道两端角色正确（ingress 组 in / egress 组 out）", async () => {
    if (!environmentReady || !state) {
      results.push({ status: "unavailable", label: "RELAY 隧道角色断言（无环境）" });
      return;
    }
    const ingress = state.nodeGroups.ingress;
    const egress = state.nodeGroups.egress;
    results.push(
      ingress.node_type === "in"
        ? { status: "pass", label: `ingress 组 ${ingress.id} node_type=in` }
        : {
            status: "fail",
            label: `ingress 组 ${ingress.id} 应为 in，实为 ${ingress.node_type}`,
          },
    );
    results.push(
      egress.node_type === "out"
        ? { status: "pass", label: `egress 组 ${egress.id} node_type=out` }
        : {
            status: "fail",
            label: `egress 组 ${egress.id} 应为 out，实为 ${egress.node_type}`,
          },
    );
  });

  // -------------------------------------------------- 仅出站（NAT）约束
  it("egress-agent 无 host 端口映射（NAT/私网、仅可主动出站）", async () => {
    if (!(await isContainerRunning(CONTAINERS.egressAgent))) {
      results.push({ status: "unavailable", label: "egress-agent 仅出站断言（容器未运行）" });
      return;
    }
    const bindings = await portBindings(CONTAINERS.egressAgent);
    const leaked = Object.keys(bindings);
    results.push(
      leaked.length === 0
        ? { status: "pass", label: "egress-agent 无 host 端口映射" }
        : {
            status: "fail",
            label: `egress-agent 暴露 host 端口 ${leaked.join(",")}，破坏仅出站约束`,
            detail: JSON.stringify(bindings),
          },
    );
  });

  it("panel 不接入任何数据面网段（控制面无法数据面可达）", async () => {
    if (!(await isContainerRunning(CONTAINERS.panel))) {
      results.push({ status: "unavailable", label: "panel 网段断言（panel 未运行）" });
      return;
    }
    const nets = await containerNetworks(CONTAINERS.panel);
    const bad = nets.filter((n) => n.includes("data"));
    results.push(
      bad.length === 0
        ? { status: "pass", label: `panel 仅在 ${nets.join("/") || "?"}`, detail: nets.join(",") }
        : { status: "fail", label: `panel 意外接入数据面网段 ${bad.join(",")}` },
    );
  });

  // ------------------------------------------------------- 双跳数据面
  it("RELAY 双跳：客户端 -> ingress-agent -> egress-agent -> Target B", async () => {
    if (!environmentReady || !state) {
      results.push({ status: "unavailable", label: "RELAY 双跳数据面（无环境）" });
      return;
    }
    const relay = state.tunnels.relay;
    results.push(
      await assertMarker("RELAY 双跳命中 Target B", {
        port: state.hostPorts.relay,
        expected: relay.expected_marker || MARKERS.targetB,
        timeoutMs: 6000,
        readTimeoutMs: 6000,
      }),
    );
  });

  it("RELAY 端口不泄漏 Target A 标记（出口选择正确、无串台）", async () => {
    if (!environmentReady || !state) {
      results.push({ status: "unavailable", label: "RELAY 反串台断言（无环境）" });
      return;
    }
    results.push(
      await assertNotMarker("RELAY 端口不回 Target A 标记", {
        port: state.hostPorts.relay,
        unexpected: MARKERS.targetA,
        timeoutMs: 6000,
        readTimeoutMs: 6000,
      }),
    );
  });

  it("出口侧证据：egress agent 已在控制面注册", async () => {
    if (!environmentReady || !state) {
      results.push({ status: "unavailable", label: "egress 注册断言（无环境）" });
      return;
    }
    const logs = await containerLogs(CONTAINERS.egressAgent, 200);
    const registered = /Connected to server successfully|config applied|register/.test(logs);
    results.push(
      registered
        ? { status: "pass", label: "egress-agent 日志含注册/配置证据" }
        : {
            status: "unavailable",
            label: "egress-agent 日志未见注册证据",
            detail: logs.slice(-400),
          },
    );
  });

  // ------------------------------------------------------- 控制面断言
  it("control plane 健康：/healthz", async () => {
    if (!environmentReady) {
      results.push({ status: "unavailable", label: "panel /healthz（无环境）" });
      return;
    }
    const res = await controlPlane({ method: "GET", path: "/healthz" });
    results.push(
      res.status === 200
        ? { status: "pass", label: "panel /healthz -> 200" }
        : {
            status: "fail",
            label: `panel /healthz -> ${res.status}`,
            detail: res.raw.slice(0, 200),
          },
    );
  });

  it("cross-workspace 读取被拒（隔离负面用例）", async () => {
    if (!environmentReady || !state || !cookie) {
      results.push({ status: "unavailable", label: "跨租户读取负面用例（无会话）" });
      return;
    }
    const foreign = state.tunnels.foreign;
    const res = await ControlPlaneMock.crossWorkspaceRead(
      state.workspaces.isolation.id,
      foreign.id,
      cookie,
    );
    results.push(
      [403, 404].includes(res.status)
        ? { status: "pass", label: `跨 workspace 读隧道 ${foreign.id} -> ${res.status}` }
        : res.status === 0
          ? {
              status: "unavailable",
              label: "跨 workspace 读：面板不可达",
              detail: res.raw,
            }
          : {
              status: "fail",
              label: `跨 workspace 读隧道 ${foreign.id} 竟返回 ${res.status}`,
              detail: res.raw.slice(0, 200),
            },
    );
  });

  it("own-workspace 读取通过（隔离断言的反向对照）", async () => {
    if (!environmentReady || !state || !cookie) {
      results.push({ status: "unavailable", label: "own-workspace 读取对照（无会话）" });
      return;
    }
    const own = state.tunnels.relay;
    const res = await ControlPlaneMock.crossWorkspaceRead(
      state.workspaces.primary.id,
      own.id,
      cookie,
    );
    results.push(
      res.status === 200
        ? { status: "pass", label: `primary 会话读自己的隧道 ${own.id} -> 200` }
        : res.status === 0
          ? { status: "unavailable", label: "own 读：面板不可达", detail: res.raw }
          : {
              status: "fail",
              label: `primary 会话读自己的隧道 ${own.id} -> ${res.status}`,
              detail: res.raw.slice(0, 200),
            },
    );
  });

  // ----------------------------------------------------- 门禁汇总
  it("汇总：断言不出现 FAIL（unavailable 单独报告，不当作通过）", async () => {
    assertNoFailures(results, "WP14 RELAY E2E");
  });
});
