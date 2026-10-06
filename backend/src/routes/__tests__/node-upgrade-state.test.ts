/**
 * R1-A / 退出条件 #7 —— 用户域升级读投影 `GET /api/nodes/:id/upgrade-state` 的路由级契约。
 *
 * 为什么必须有这个文件（而不是只断言服务层）：
 *
 *  1. **"用户域没有实际上报版本"这件事是产品缺陷，不是 UI 缺陷。** `node.version` 是管理员
 *     配置字段（真机取证：scratch 拓扑 9 台节点全为 `unknown`），实际上报版本只存在于
 *     `node_state_report.version`。这条投影是本任务新加的**唯一**用户域入口，所以它必须被
 *     真实 HTTP 请求钉住：路由真的可达、形状真的冻结、`configured_version` 与 `reported.version`
 *     真的是两个字段。
 *  2. **前置结论必须与 `POST /:id/upgrade-command` 同源。** 本文件**不**替身
 *     `services/node-upgrade.ts`：`checkUpgradePrecondition` 是真实现，断言就是"路由返回的
 *     code/message 与直接调用它逐字相同"。
 *  3. **最近一次同类事故是 DNS 前门与延迟端点**：`POST /:id/dns` 曾被注册在 `:id/:action`
 *     catch-all 之后 ⇒ 真实 API 400，而所有服务层断言全绿。所以这里既**动态**打真实路由
 *     （键集冻结，被别的处理器接走就会红），又**静态**钉住注册形态（字面量子路径）。
 *  4. 本端点**只读**：替身对任何写操作直接抛错，并在用例里断言调用序列里没有写。
 *
 * ── 为什么整段跑在**子进程**里 ──
 * `mock.module` 是**进程级**注册表：同进程里别的测试文件（`workspace-rbac.test.ts` /
 * `forwards-*-route.test.ts`）也替换 `workspace.ts` / `db.ts`，谁最后注册谁生效 —— 本专项已
 * 因此出现过"单跑绿、全量红"。子进程用干净注册表，断言的是本路由本身。
 *
 * 跑法（backend 目录）：bun test src/routes/__tests__/node-upgrade-state.test.ts
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../..", import.meta.url).pathname;

/* ------------------------------------------------------------------ */
/* 子进程前置：数据面替身 + 真实路由 + 真实前置判定                        */
/* ------------------------------------------------------------------ */

const PRELUDE = String.raw`
import { mock, expect } from "bun:test";
import { Hono } from "hono";
const root = process.env.TUNEX_UPGRADE_ROOT;

const WS = 3;
/* 数据面（可被场景改写） */
let node = null;      /* 用户域可见节点行；null = 不存在 / 不在本空间 */
let report = null;    /* node_state_report 行；null = 从未上报 */
const calls = [];
const writes = [];

function forbid(name) {
  return async function () { writes.push(name); throw new Error("只读端点不得调用 " + name); };
}
/* Prisma 语义：只有 select 里为 true 的列才出现在返回值里。 */
function project(row, select) {
  const out = {};
  Object.keys(select).forEach(function (key) {
    if (select[key] === true) out[key] = row[key] === undefined ? null : row[key];
  });
  return out;
}
function seedNode(over) {
  node = Object.assign({
    id: 1, node_id: "Integration-IN-A-NODE", agent_id: "agent-uuid-1", role: "ingress",
    status: "active", version: "unknown", last_seen_at: new Date(),
    port_range_min: 21000, port_range_max: 21999, lb_strategy: "round", node_group_id: 1,
    node_credential_hash: "deadbeef", credential_revoked: false,
    lifecycle: "active", lifecycle_note: null, lifecycle_updated_at: null,
    node_group: { id: 1, name: "Integration Ingress A", node_type: "in", workspace_id: WS },
  }, over || {});
}
function seedReport(over) {
  report = over === null ? null : Object.assign({
    node_id: 1, version: "0.13.22", role: "INGRESS", reported_at: new Date(), last_error: null,
  }, over || {});
}
function reset() {
  seedNode({}); seedReport({});
  calls.length = 0; writes.length = 0;
}

/* redis 替身：本端点是**纯 DB 读**，不碰 redis；替身只为把子进程从"真实 ioredis 连接重试"
 * 里解放出来（否则每次 spawn 要等连接超时，整套门禁被拖慢十几秒，日志也会被 ECONNREFUSED 刷屏）。
 * 键构造器用 Proxy 兜住：任何 RedisKeys.x() 都返回一个字符串键，不必在这里复刻键命名规则。 */
mock.module(root + "redis.ts", () => ({
  redis: new Proxy({ status: "ready" }, {
    get: function (target, prop) {
      if (prop in target) return target[prop];
      return async function () { return null; };
    },
  }),
  RedisKeys: new Proxy({}, { get: function () { return function () { return "k"; }; } }),
  scopedKey: function (key) { return String(key); },
  observerBufferKey: function (key) { return String(key); },
  OBSERVER_BUFFER_MAX: 500,
  redisPing: async function () { return true; },
}));

mock.module(root + "db.ts", () => ({ db: {
  node: {
    findFirst: async function (args) {
      calls.push("node.findFirst");
      if (!node) return null;
      if (args.where.id !== node.id) return null;
      if (!args.where.node_group || args.where.node_group.workspace_id !== WS) return null;
      return project(node, args.select);
    },
    update: forbid("node.update"),
    updateMany: forbid("node.updateMany"),
    create: forbid("node.create"),
    delete: forbid("node.delete"),
  },
  nodeStateReport: {
    findUnique: async function (args) {
      calls.push("nodeStateReport.findUnique");
      if (!report || report.node_id !== args.where.node_id) return null;
      return project(report, args.select);
    },
    upsert: forbid("nodeStateReport.upsert"),
    update: forbid("nodeStateReport.update"),
    create: forbid("nodeStateReport.create"),
    deleteMany: forbid("nodeStateReport.deleteMany"),
  },
} }));

/* workspace 替身：只提供路由 middleware 真正导入的那两个名字。 */
mock.module(root + "services/workspace.ts", () => ({
  resolveWorkspaceAccess: async function () { return { id: WS, role: "owner", permissions: {} }; },
  canWorkspaceResourceAction: function () { return true; },
}));

const { nodesRoutes } = await import(root + "routes/nodes.ts");
/* 真前置判定（**不**替身）：同源断言的对象就是它。 */
const { checkUpgradePrecondition } = await import(root + "services/node-upgrade.ts");
const { NODE_OFFLINE_AFTER_SECONDS } = await import(root + "services/node-diagnostics.ts");
const { env } = await import(root + "env.ts");

const app = new Hono();
app.use("*", async function (c, next) { c.set("user", { id: 1, super_admin: false }); await next(); });
app.route("/api/nodes", nodesRoutes);

function headers() { return { "x-workspace-id": String(WS) }; }
function req(path, method) {
  return app.request("/api/nodes" + path, { method: method || "GET", headers: headers() });
}

let checks = 0;
async function status(res, want) { expect(res.status).toBe(want); checks = checks + 1; return res; }
async function group(name, expectChecks, fn) {
  checks = 0;
  await fn();
  if (checks !== expectChecks) {
    throw new Error("GROUP " + name + ": expected " + expectChecks + " status checks, got " + checks);
  }
  console.log("GROUP " + name + "=" + checks);
}
`;

/* ------------------------------------------------------------------ */
/* ① 可达性 + 冻结契约（catch-all 回归）                                 */
/* ------------------------------------------------------------------ */

const SCENARIO_CONTRACT = String.raw`
await group("reachability-and-contract", 3, async () => {
  reset();
  const res = await status(await req("/1/upgrade-state"), 200);
  const body = await res.json();
  const data = body.data;

  /* 键集冻结：被别的处理器接走（例如诊断/转发列表/catch-all）就会红。 */
  expect(Object.keys(data).sort()).toEqual([
    "configured_version","generated_at","node","offline_after_seconds",
    "precondition","report_freshness","reported","target",
  ]);
  expect(Object.keys(data.node).sort()).toEqual(["agent_id","id","lifecycle","node_key","role"]);
  expect(Object.keys(data.target).sort()).toEqual([
    "expected_version","image","image_source","version_drift",
  ]);

  /* 相邻字面量子路径仍然各自可达（互不遮蔽）。 */
  const bad = await status(await req("/abc/upgrade-state"), 400);
  expect((await bad.json()).error).toBe("节点 ID 不合法");
  const missing = await status(await req("/999/upgrade-state"), 404);
  expect((await missing.json()).code).toBe("not_found");
});
`;

/* ------------------------------------------------------------------ */
/* ② 上报版本 ≠ 配置版本 + 新鲜度                                        */
/* ------------------------------------------------------------------ */

const SCENARIO_TRUTH = String.raw`
await group("reported-version-is-not-configured-version", 3, async () => {
  /* R1-A 的真实形状：配置字段 unknown，实际运行版本是上报来的 0.13.22。 */
  reset();
  seedNode({ version: "unknown" });
  seedReport({ version: "0.13.22", reported_at: new Date(Date.now() - 5000) });
  let data = (await (await status(await req("/1/upgrade-state"), 200)).json()).data;
  expect(data.reported.version).toBe("0.13.22");
  expect(data.configured_version).toBe("unknown");
  expect(data.report_freshness).toBe("fresh");

  /* 从未上报过：reported 为 null（**不接受**用配置值顶替），新鲜度 unknown。 */
  reset();
  seedNode({ version: "1.2.3" });
  seedReport(null);
  data = (await (await status(await req("/1/upgrade-state"), 200)).json()).data;
  expect(data.reported).toBeNull();
  expect(data.configured_version).toBe("1.2.3");
  expect(data.report_freshness).toBe("unknown");

  /* 超期上报：stale（阈值仍由服务端下发，前端不自己编）。 */
  reset();
  seedReport({ reported_at: new Date(Date.now() - (NODE_OFFLINE_AFTER_SECONDS + 30) * 1000) });
  data = (await (await status(await req("/1/upgrade-state"), 200)).json()).data;
  expect(data.report_freshness).toBe("stale");
  expect(data.offline_after_seconds).toBe(NODE_OFFLINE_AFTER_SECONDS);
  expect(data.reported.age_seconds).toBeGreaterThanOrEqual(NODE_OFFLINE_AFTER_SECONDS);

  /* 目标镜像来自部署配置；基线未配置（默认部署）⇒ expected_version null + drift unknown。 */
  expect(data.target.image.length).toBeGreaterThan(0);
  expect(data.target.expected_version).toBe(env.agentLatestVersion.trim() === "" ? null : env.agentLatestVersion.trim());
  if (env.agentLatestVersion.trim() === "") {
    expect(data.target.version_drift).toBe("unknown");
  }
});
`;

/* ------------------------------------------------------------------ */
/* ②b 版本基线：不可比较的配置**不折算**（task-26 的真机形态）              */
/* ------------------------------------------------------------------ */

const SCENARIO_BASELINE = String.raw`
await group("baseline-is-not-coerced", 1, async () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  reset();
  seedReport({ version: "0.13.22" });
  const data = (await (await status(await req("/1/upgrade-state"), 200)).json()).data;

  if (env.agentLatestVersion === SHA) {
    /* 旧版安装器把它写成 git sha：原值透传（不吞），drift 只能是 unknown ——
       既不是 behind，也不是"已是最新"。 */
    expect(data.target.expected_version).toBe(SHA);
    expect(data.target.version_drift).toBe("unknown");
  } else if (env.agentLatestVersion === "0.14.0") {
    /* 真正可比较的基线：落后判定正常出现（这才是修复后的那条路）。 */
    expect(data.target.expected_version).toBe("0.14.0");
    expect(data.target.version_drift).toBe("behind");
  } else {
    /* 不是"跳过"：子进程没收到期望配置就直接失败，避免这条用例被静默绕过。 */
    throw new Error("子进程未收到期望的基线形态：" + JSON.stringify(env.agentLatestVersion));
  }
});
`;

/* ------------------------------------------------------------------ */
/* ③ 前置结论与 POST 同源                                               */
/* ------------------------------------------------------------------ */

const SCENARIO_PRECONDITION = String.raw`
await group("precondition-is-the-same-truth", 4, async () => {
  /* active 节点：默认路径不能升级，且 code/message 与后端判定逐字相同。 */
  reset();
  seedNode({ lifecycle: "active" });
  let data = (await (await status(await req("/1/upgrade-state"), 200)).json()).data;
  const expectedActive = checkUpgradePrecondition({
    node_key: "Integration-IN-A-NODE", agent_id: "agent-uuid-1", role: "ingress", lifecycle: "active",
  });
  expect(data.precondition).toEqual({
    ok: false, code: expectedActive.code, message: expectedActive.message,
  });
  expect(data.precondition.code).toBe("node_not_in_maintenance");

  /* maintenance：默认路径放行。 */
  reset();
  seedNode({ lifecycle: "maintenance" });
  data = (await (await status(await req("/1/upgrade-state"), 200)).json()).data;
  expect(data.precondition).toEqual({ ok: true, code: null, message: null });

  /* retired：单向状态，allow_active 也救不回来（服务端语义，原样透传）。 */
  reset();
  seedNode({ lifecycle: "retired" });
  data = (await (await status(await req("/1/upgrade-state"), 200)).json()).data;
  expect(data.precondition.code).toBe("node_retired");

  /* 没有 agent_id（未完成安装）：同样是服务端判定。 */
  reset();
  seedNode({ agent_id: "", lifecycle: "maintenance" });
  data = (await (await status(await req("/1/upgrade-state"), 200)).json()).data;
  expect(data.precondition.code).toBe("node_has_no_agent_id");
});
`;

/* ------------------------------------------------------------------ */
/* ④ 只读：没有写、404 也不读上报行                                      */
/* ------------------------------------------------------------------ */

const SCENARIO_READONLY = String.raw`
await group("read-only-and-scope-first", 2, async () => {
  reset();
  await status(await req("/1/upgrade-state"), 200);
  expect(calls).toEqual(["node.findFirst", "nodeStateReport.findUnique"]);
  expect(writes).toEqual([]);

  /* 作用域先定：节点不在本空间 ⇒ 404（与自己不存在同形），且**不读**上报行。 */
  reset();
  node = null;
  calls.length = 0;
  await status(await req("/1/upgrade-state"), 404);
  expect(calls).toEqual(["node.findFirst"]);
});
`;

/* ------------------------------------------------------------------ */
/* 子进程执行器                                                        */
/* ------------------------------------------------------------------ */

function runScenario(scenario: string, baseline = ""): string {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      PRELUDE + scenario +
        "\n/* 真实 redis/prisma 客户端会拖住事件循环：显式退出（沿用既有子进程用例）。 */\nprocess.exit(0);\n",
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        TUNEX_UPGRADE_ROOT: root,
        // 缺省：基线未声明（本专项确认的"升级建议永不出现"的那个配置）。
        // 传第 2 个参数可模拟其它部署形态（旧版安装器写的 git sha / 真正的版本号）。
        TUNEX_AGENT_LATEST_VERSION: baseline,
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw new Error(`子进程启动失败：${result.error.message}\n${output}`);
  if (result.status !== 0) throw new Error(`子进程退出码 ${result.status}\n${output}`);
  return output;
}

const BASELINE_SHA = "0123456789abcdef0123456789abcdef01234567";

test("版本基线：不可比较的配置不折算成 behind / 已是最新", () => {
  const shaOutput = runScenario(SCENARIO_BASELINE, BASELINE_SHA);
  expect(shaOutput).toContain("GROUP baseline-is-not-coerced=1");
  const comparableOutput = runScenario(SCENARIO_BASELINE, "0.14.0");
  expect(comparableOutput).toContain("GROUP baseline-is-not-coerced=1");
}, 60_000);

test("升级读投影：契约、上报真相、同源前置、只读", () => {
  const output = [
    runScenario(SCENARIO_CONTRACT),
    runScenario(SCENARIO_TRUTH),
    runScenario(SCENARIO_PRECONDITION),
    runScenario(SCENARIO_READONLY),
  ].join("\n");
  expect(output).toContain("GROUP reachability-and-contract=3");
  expect(output).toContain("GROUP reported-version-is-not-configured-version=3");
  expect(output).toContain("GROUP precondition-is-the-same-truth=4");
  expect(output).toContain("GROUP read-only-and-scope-first=2");
}, 120_000);

/**
 * 顺序回归（静态面）：本端点必须注册为**字面量子路径**，不能落到任何参数化的
 * `/:ingressId/:action` 形状上 —— 那正是 DNS 前门踩过的坑（`post("/:id/:action")`
 * 吃掉 `/:id/dns`）。纯动态断言挡不住"以后有人把它改成变量段还顺手调整顺序"。
 */
test("路由注册形态：upgrade-state 是字面量子路径，不是参数段", () => {
  const raw = readFileSync(new URL("../nodes.ts", import.meta.url), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  expect(code).toMatch(/nodesRoutes\.get\(\s*"\/:ingressId\/upgrade-state"/);
  // 不存在任何 `/:ingressId/:something` 形式的 GET 兜底（那会把它吃掉）。
  expect(code).not.toMatch(/nodesRoutes\.get\(\s*"\/:ingressId\/:[A-Za-z]/);
});
