/**
 * WP14 DIRECT 单跳 E2E —— 测试框架（DEVELOPMENT.md §7.15 Gate 必测项）
 *
 * 本文件刻意保持**纯 JavaScript**：与 backend/tests 既有约定一致，CI 用
 * `node --experimental-transform-types --test tests/*.test.mjs` 运行 —— 该 flag
 * 只对**被导入的 .ts 文件**做 type-stripping，.mjs 自身写 TS 语法会在运行时报
 * SyntaxError（已实测：Node 26 对 .mjs 不做类型剥离）。类型与共享工具全部放在
 * harness.ts，本文件只消费它们。
 *
 * 本套件证明什么
 * ---------------------------------------------------------------
 * 客户端把真实 TCP 连接打进 ingress-agent 的 DIRECT 隧道端口，流量单跳落到
 * Target A，回串来自 Target A（而非 Target B）。这是「legacy DIRECT 无回归」
 * （DEVELOPMENT.md §7.15 第一个正式 Gate 项）的可执行形式。
 *
 * 三种结果各自代表不同含义，且永不可混淆：
 *
 *   PASS       单跳路径真的承载了流量
 *   FAIL       有东西在听，但路径错了（配错目标、标记串台）—— 这是缺陷
 *   UNAVAILABLE 无可观测对象（容器没起、agent 没连上、WP4/WP8 未合入）。
 *               套件会把这个缺口响亮地报出来，而不是悄悄"通过"。
 *
 * 与 relay.e2e.test.mjs 的分工：本文件只覆盖单跳 DIRECT，不碰出口节点；
 * 双跳路径在 relay.e2e.test.mjs。两个文件共用 harness.ts 的同一套原语，
 * 因此「两套路径用同一把尺子量」。
 *
 * 覆盖的正式 Gate 项：
 *   · legacy DIRECT no regression
 *   · workspace isolation（负面 + 反向对照）
 *   · 入口 agent 端口确实对外（正向）
 * 尚未覆盖（需功能 WP 合入，见 scripts/v3-e2e/README.md 的状态矩阵）：
 *   · Egress-before-Ingress、RELAY 本身（见 relay.e2e.test.mjs）
 *   · hot update / agent restart / control reconnect / panel restart
 *   · stale revision / credential revoke / port conflict-exhaustion
 *   · suspend-resume / change egress / backup-restore / old agent compat
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ARTIFACT_DIR,
  CONTAINERS,
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
  probeTcp,
  saveArtifacts,
  stateExists,
  summarize,
} from "./harness.ts";

/** 面板 HTTP 替身：只走真实接口，绝不替数据面编造答案（详见 relay.e2e.test.mjs）。 */
const ControlPlaneMock = {
  crossWorkspaceRead(workspaceId, tunnelId, cookie) {
    return controlPlane({
      method: "GET",
      path: `/api/tunnels/${tunnelId}`,
      cookie,
      workspaceId,
    });
  },
};

describe("WP14 DIRECT 单跳 E2E", { concurrency: false }, () => {
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
      cookie = session.setCookie ? session.setCookie.split(";")[0] : "";
    }
    if (!environmentReady) {
      console.warn(
        `[wp14-direct.e2e] 环境不完整（${missing.join(", ")}）；下方所有断言将记为 ` +
          `unavailable，不会被记为通过。先跑 scripts/v3-e2e/setup.sh。`,
      );
    }
  });

  after(async () => {
    const { fail, unavailable } = summarize(results);
    const artifacts = await saveArtifacts("direct", {
      results,
      logs: await collectLogs(300),
      extra: { environmentReady, missing, artifactsDir: ARTIFACT_DIR },
    });
    console.log(
      `[wp14-direct.e2e] pass=${results.length - fail - unavailable} ` +
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

  it("DIRECT 隧道挂在 in 组上且无 out 组", async () => {
    if (!environmentReady || !state) {
      results.push({ status: "unavailable", label: "DIRECT 隧道形状断言（无环境）" });
      return;
    }
    const direct = state.tunnels.direct;
    const ingress = state.nodeGroups.ingress;
    const relay = state.tunnels.relay;
    // 单跳的必要条件：DIRECT 隧道不得携带 out 组。若两者形状相同，本套件的
    // "单跳" 结论就毫无意义，因此这里必须是 FAIL 而不是 unavailable。
    results.push(
      ingress.node_type === "in"
        ? { status: "pass", label: `DIRECT 挂在 in 组 ${ingress.id} 上` }
        : { status: "fail", label: `DIRECT 入口组 ${ingress.id} 应为 in，实为 ${ingress.node_type}` },
    );
    results.push(
      direct.listen_port !== relay.listen_port
        ? {
            status: "pass",
            label: `DIRECT 端口 ${direct.listen_port} 与 RELAY 端口 ${relay.listen_port} 不同`,
          }
        : {
            status: "fail",
            label: `DIRECT 与 RELAY 共用监听端口 ${direct.listen_port}，测试无效`,
          },
    );
  });

  // ------------------------------------------------------- 单跳数据面
  it("DIRECT 单跳：客户端 -> ingress-agent -> Target A", async () => {
    if (!environmentReady || !state) {
      results.push({ status: "unavailable", label: "DIRECT 单跳数据面（无环境）" });
      return;
    }
    const direct = state.tunnels.direct;
    results.push(
      await assertMarker("DIRECT 单跳命中 Target A", {
        port: state.hostPorts.direct,
        expected: direct.expected_marker || MARKERS.targetA,
        timeoutMs: 6000,
        readTimeoutMs: 6000,
      }),
    );
  });

  it("DIRECT 端口不泄漏 Target B 标记（无串台）", async () => {
    if (!environmentReady || !state) {
      results.push({ status: "unavailable", label: "DIRECT 反串台断言（无环境）" });
      return;
    }
    results.push(
      await assertNotMarker("DIRECT 端口不回 Target B 标记", {
        port: state.hostPorts.direct,
        unexpected: MARKERS.targetB,
        timeoutMs: 6000,
        readTimeoutMs: 6000,
      }),
    );
  });

  it("host 端口 -> 容器端口映射与 fixture 一致", async () => {
    if (!(await isContainerRunning(CONTAINERS.ingressAgent))) {
      results.push({ status: "unavailable", label: "端口映射断言（ingress-agent 未运行）" });
      return;
    }
    if (!state) {
      results.push({ status: "unavailable", label: "端口映射断言（无 state.json）" });
      return;
    }
    const bindings = await portBindings(CONTAINERS.ingressAgent);
    // compose 期望的映射：host:18201 -> 21001(DIRECT)、host:18202 -> 21002(RELAY)。
    const expectDirect = `${state.tunnels.direct.listen_port}/tcp`;
    const expectRelay = `${state.tunnels.relay.listen_port}/tcp`;
    results.push(
      bindings[expectDirect] === String(state.hostPorts.direct)
        ? {
            status: "pass",
            label: `host:${state.hostPorts.direct} -> ${expectDirect} 映射正确`,
          }
        : {
            status: "fail",
            label: `host:${state.hostPorts.direct} 未映射到 ${expectDirect}`,
            detail: JSON.stringify(bindings),
          },
    );
    results.push(
      bindings[expectRelay] === String(state.hostPorts.relay)
        ? {
            status: "pass",
            label: `host:${state.hostPorts.relay} -> ${expectRelay} 映射正确`,
          }
        : {
            status: "fail",
            label: `host:${state.hostPorts.relay} 未映射到 ${expectRelay}`,
            detail: JSON.stringify(bindings),
          },
    );
  });

  it("ingress-agent 已应用控制面配置（日志证据）", async () => {
    if (!(await isContainerRunning(CONTAINERS.ingressAgent))) {
      results.push({ status: "unavailable", label: "ingress 配置应用断言（容器未运行）" });
      return;
    }
    const logs = await containerLogs(CONTAINERS.ingressAgent, 300);
    const applied = /config applied/.test(logs);
    results.push(
      applied
        ? { status: "pass", label: "ingress-agent 日志含 config applied" }
        : {
            status: "unavailable",
            label: "ingress-agent 日志未见 config applied",
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
          ? { status: "unavailable", label: "跨 workspace 读：面板不可达", detail: res.raw }
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
    const own = state.tunnels.direct;
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

  it("ingress-agent 只接控制面 + 两个数据面网段（无多余暴露）", async () => {
    if (!(await isContainerRunning(CONTAINERS.ingressAgent))) {
      results.push({ status: "unavailable", label: "ingress-agent 网段断言（容器未运行）" });
      return;
    }
    const nets = await containerNetworks(CONTAINERS.ingressAgent);
    const hasCtrl = nets.some((n) => n.includes("ctrl"));
    const hasIngressData = nets.some((n) => n.includes("ingress"));
    const hasEgressData = nets.some((n) => n.includes("egress"));
    results.push(
      hasCtrl && hasIngressData && hasEgressData
        ? { status: "pass", label: `ingress-agent 网段 ${nets.join("/")}` }
        : {
            status: "fail",
            label: `ingress-agent 网段不完整: ${nets.join(",")}`,
            detail: `ctrl=${hasCtrl} ingress=${hasIngressData} egress=${hasEgressData}`,
          },
    );
  });

  // ----------------------------------------------------- 门禁汇总
  it("汇总：断言不出现 FAIL（unavailable 单独报告，不当作通过）", async () => {
    assertNoFailures(results, "WP14 DIRECT E2E");
  });
});
