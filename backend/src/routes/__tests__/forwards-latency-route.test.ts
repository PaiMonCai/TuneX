/**
 * D6 —— `GET /api/forwards/:id/latency` 的**路由级契约**。
 *
 * 为什么必须有这个文件：`services/latency-history.ts` 的读函数有测试，但它**没有任何读
 * 路由**（R3-B 的结论：`readLatencySeries` 无 consumer）。最近一次同类事故是 DNS 前门：
 * `POST /api/forwards/:id/dns` 曾被注册在 `post("/:id/:action")` catch-all **之后**，
 * 于是真实 API 上绑定直接 400「不支持的端口转发动作」，而当时 38 条服务层断言全绿。
 * 所以这里挂**真实** `forwardsRoutes`，用 `app.request()` 真的打。
 *
 * ── 为什么整段跑在**子进程**里（沿用 `workspace-rbac.test.ts` / `forwards-dns-route.test.ts`
 * 的同一模式）──
 * 本文件要钉的是"真实 `forwards.ts` + 真实权限内核"的行为，而 `mock.module` 是**进程级**
 * 注册表：同进程里别的测试文件（`forward-route-topology.test.ts` / `ddns-provider-route.test.ts`）
 * 若替换过 `workspace.ts`，本文件会解析到**别人的替身**。这不是猜想：本文件第一版是进程内
 * mock，单跑 39/39 绿，`bun test src` 全量里却红 2 条 —— 全量时 `resolveWorkspaceAccess`
 * 被解析成了另一个文件的"永远 owner"替身（于是"无 forward:read"拿到了 200），连"被拒"那条
 * 拿到的都是别人替身抛出的**非 JSON** 错误体。换成干净注册表后，这里断言的是产品权限内核
 * 本身（自定义角色替换语义、viewer/member、跨 Workspace 404），不是替身的语义。
 *
 * 替身面只有 `db.ts`（数据面）：转发行、出口池、`system_config`、以及档案的两张表。
 * **不**替身 `latency-history.ts` —— `readLatencySeries` 与 `defaultLatencyHistoryDeps` 都是
 * 真实现，于是本文件测的是"真路由 + 真读函数 + 真权限内核 + 替身数据库"，而不是替身互相对答案。
 *
 * 覆盖（四个场景各在一个 `group` 里，组内 status 断言计数必须**恰好**等于写死的数字：既证明
 * 这组真的跑到，也挡住"整组被跳过/被注释掉"这类静默失效）：
 *   ① 权限与作用域：无 `forward:read` 被拒（真内核）、viewer/member 既有语义、跨 Workspace 404
 *      与"真不存在"逐字同形、非法 id 400；
 *   ② 窗口钳制：非法输入 400 + 稳定 code、超上限 400 而不是静默截短、`to` 在将来被钳制、
 *      `raw_window_expired`（409）与"没有数据"（200 `no_samples`）可区分；
 *   ③ 观测维度与序列：DIRECT / 远端出口 / 无池 / 无目标 / 归属冲突 ⇒ 明确"无数据"而不是 0 值
 *      序列（且不猜一个 target 去查）、多目标 ⇒ 拒绝猜、成功形状逐字透传（`null` 仍是 `null`）、
 *      截断显式标注、键集冻结且不含内部材料；
 *   ④ 路由可达性与零副作用：子路由没被 catch-all 吃掉、GET 只碰只读面、幂等。
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

/** backend/src/（子进程的 import 前缀与 cwd 都与既有子进程用例保持一致）。 */
const root = new URL("../..", import.meta.url).pathname;

/* ------------------------------------------------------------------ */
/* 子进程前置：数据面替身 + 真实路由 + 真实权限内核                        */
/* ------------------------------------------------------------------ */

const PRELUDE = String.raw`
import { mock, expect } from "bun:test";
import { Hono } from "hono";
const root = process.env.TUNEX_LATENCY_ROOT;

const WS = 3;
const FORWARD_ID = 11;
const EGRESS_NODE_ID = 7;
const POOL_ID = 21;
const TARGET_HOST = "10.0.0.5";
const TARGET_PORT = 8080;
const TARGET_KEY = TARGET_HOST + ":" + TARGET_PORT;
/* 挂在行上、但**没有**任何 select 请求的内部材料：只为了证明"没被 select 就绝不出现"可断言。 */
const SEALED = "v1.SEALED-forward-internal-material-must-never-appear";

/* ── 可变状态（每个场景开头 reset()） ── */
let role = "owner", roleId = null, permissions = null, active = true;
let requestWorkspace = WS;
let tunnel = null, pool = null;
let rawRetention = null, bucketRetention = null;
let rawRows = [], bucketRows = [];
const dbCalls = [];
const findFirstWheres = [];
const rawSampleQueries = [];
const hourBucketQueries = [];
const writes = [];

function baseTunnel(over) {
  return Object.assign({
    id: FORWARD_ID, workspace_id: WS, category: "port_forward", user_id: 1, name: "relay-a",
    tunnel_mode: "relay", egress_node_id: EGRESS_NODE_ID, egress_pool_id: POOL_ID,
    federated_egress_peer: null, internal_material: SEALED,
  }, over || {});
}
function basePool(over) {
  return Object.assign({
    id: POOL_ID, node_id: EGRESS_NODE_ID,
    targets: [{ id: 1, host: TARGET_HOST, port: TARGET_PORT, status: "active", order_by: 1000 }],
  }, over || {});
}
function seedTunnel(over) { tunnel = over === null ? null : baseTunnel(over); }
function seedPool(over) { pool = basePool(over); }
/* 基础角色 / 自定义角色（自定义角色是**替换**语义，不会回落到基础角色）。 */
function asRole(base, perms) {
  role = base;
  roleId = perms === undefined ? null : 44;
  permissions = perms === undefined ? null : perms;
}
function reset() {
  role = "owner"; roleId = null; permissions = null; active = true; requestWorkspace = WS;
  seedTunnel({}); seedPool({}); rawRetention = null; bucketRetention = null;
  rawRows = []; bucketRows = [];
  dbCalls.length = 0; findFirstWheres.length = 0;
  rawSampleQueries.length = 0; hourBucketQueries.length = 0; writes.length = 0;
}

/* 与 Prisma 一致：undefined 的 where 键不构成条件；等值 / {gte, lt} 范围。 */
function matches(row, where) {
  return Object.keys(where).every(function (key) {
    const want = where[key];
    if (want === undefined) return true;
    if (want !== null && typeof want === "object" && !(want instanceof Date)) {
      const have = row[key];
      if (Object.prototype.hasOwnProperty.call(want, "gte") && !(have >= want.gte)) return false;
      if (Object.prototype.hasOwnProperty.call(want, "lt") && !(have < want.lt)) return false;
      return true;
    }
    return row[key] === want;
  });
}
/* 按 select 投影（true = 该列）：没被 select 的键不会出现在返回值里。 */
function project(row, select) {
  const out = {};
  Object.keys(select).forEach(function (key) {
    if (select[key] === true) out[key] = row[key] === undefined ? null : row[key];
  });
  return out;
}
function orderedTake(rows, orderBy, take) {
  const key = Object.keys(orderBy)[0];
  const desc = orderBy[key] === "desc";
  const sorted = rows.slice().sort(function (a, b) {
    const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
    return desc ? -cmp : cmp;
  });
  return take === undefined ? sorted : sorted.slice(0, take);
}
/* 写操作：读端点碰任何一次都必须**炸**（不是一条静默断言）。 */
function forbid(name) {
  return async function () { writes.push(name); throw new Error("读端点不得调用 " + name); };
}
function findManyOf(getRows, model, queries) {
  return async function (args) {
    dbCalls.push(model + ".findMany");
    if (queries) queries.push(args);
    const rows = getRows().filter(function (row) { return matches(row, args.where); });
    const ordered = orderedTake(rows, args.orderBy, args.take);
    return args.select ? ordered.map(function (r) { return project(r, args.select); }) : ordered;
  };
}

mock.module(root + "db.ts", () => ({ db: {
  workspace: { findUnique: async () => ({ id: 1 }) },
  workspaceMember: { findUnique: async (args) => {
    const w = args.where.workspace_id_user_id;
    if (!active || w.workspace_id !== requestWorkspace || w.user_id !== 1) return null;
    return {
      id: 70, workspace_id: requestWorkspace, user_id: 1, role: role, active: true, role_id: roleId,
      custom_role: roleId === null || permissions === null
        ? null
        : { id: roleId, workspace_id: requestWorkspace, permissions: permissions },
      workspace: { id: requestWorkspace, kind: "personal" },
    };
  } },
  tunnel: {
    findFirst: async (args) => {
      dbCalls.push("tunnel.findFirst");
      findFirstWheres.push(args.where);
      if (!tunnel || !matches(tunnel, args.where)) return null;
      return project(tunnel, args.select);
    },
    update: forbid("tunnel.update"), create: forbid("tunnel.create"), delete: forbid("tunnel.delete"),
    updateMany: forbid("tunnel.updateMany"), deleteMany: forbid("tunnel.deleteMany"),
  },
  egressPool: {
    findUnique: async (args) => {
      dbCalls.push("egressPool.findUnique");
      if (!pool || pool.id !== args.where.id) return null;
      const spec = args.select.targets;
      const targets = orderedTake(
        pool.targets.filter(function (t) { return matches(t, spec.where); }),
        spec.orderBy,
        undefined,
      ).map(function (t) { return project(t, spec.select); });
      return { id: pool.id, node_id: pool.node_id, targets: targets };
    },
    update: forbid("egressPool.update"), delete: forbid("egressPool.delete"),
  },
  systemConfig: { findUnique: async (args) => {
    dbCalls.push("systemConfig.findUnique");
    const value = args.where.name === "LATENCY_RAW_RETENTION_HOURS" ? rawRetention
      : args.where.name === "LATENCY_BUCKET_RETENTION_DAYS" ? bucketRetention
        : null;
    return value === null || value === undefined ? null : { value: value };
  } },
  targetLatencySample: {
    findMany: findManyOf(function () { return rawRows; }, "targetLatencySample", rawSampleQueries),
    createMany: forbid("targetLatencySample.createMany"),
    deleteMany: forbid("targetLatencySample.deleteMany"),
    groupBy: forbid("targetLatencySample.groupBy"),
  },
  targetLatencyHourly: {
    findMany: findManyOf(function () { return bucketRows; }, "targetLatencyHourly", hourBucketQueries),
    create: forbid("targetLatencyHourly.create"),
    deleteMany: forbid("targetLatencyHourly.deleteMany"),
    groupBy: forbid("targetLatencyHourly.groupBy"),
  },
} }));

const { forwardsRoutes } = await import(root + "routes/forwards.ts");
const app = new Hono();
app.use("*", async (c, next) => { c.set("user", { id: 1, super_admin: false }); await next(); });
app.route("/api/forwards", forwardsRoutes);

const PATH = "/api/forwards/" + FORWARD_ID + "/latency";
function headers() { return { "x-workspace-id": String(requestWorkspace) }; }
function req(query) { return app.request(PATH + (query || ""), { headers: headers() }); }
function reqWith(path, method) { return app.request(path, { method: method, headers: headers() }); }
function sampleRow(over) {
  return Object.assign({
    node_id: EGRESS_NODE_ID, target_key: TARGET_KEY,
    observed_at: new Date("2026-10-06T08:00:00.000Z"),
    reachable: true, latency_ms: 42.5, observation_source: "node-7/tcp_connect",
  }, over || {});
}
function bucketRow(over) {
  return Object.assign({
    node_id: EGRESS_NODE_ID, target_key: TARGET_KEY,
    hour_start: new Date("2026-10-06T08:00:00.000Z"), observation_source: "node-7/tcp_connect",
    sample_count: 120, success_count: 118, failure_count: 2,
    latency_samples: 118, latency_sum_ms: 4956, latency_min_ms: 12.1, latency_max_ms: 88.4,
    last_observed_at: new Date("2026-10-06T08:59:30.000Z"),
  }, over || {});
}
function recentWindow(granularity, fromHours, toHours) {
  const now = Date.now();
  return "?granularity=" + granularity
    + "&from=" + encodeURIComponent(new Date(now - fromHours * 3600000).toISOString())
    + "&to=" + encodeURIComponent(new Date(now - toHours * 3600000).toISOString());
}

/* 分组执行器：组内 status 断言计数必须**恰好**等于写死的数字（第二条护栏，见文件头）。 */
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
const DATA_KEYS = ["dimension","forward_id","granularity","mode","reason","series","status","truncated","window"].sort();
const POINT_KEYS = ["at","failures","latency_max_ms","latency_min_ms","latency_ms","observation_source","samples","successes"].sort();
`;

/* ------------------------------------------------------------------ */
/* 子进程执行器                                                        */
/* ------------------------------------------------------------------ */

/** 起一个干净的模块注册表跑一段场景；子进程非 0 退出即失败（错误原文带上子进程行号）。 */
function runScenario(scenario: string): string {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      PRELUDE + scenario +
        "\n/* 真实 redis 客户端会拖住事件循环：显式退出，否则 spawnSync 只能等超时。 */\nprocess.exit(0);\n",
    ],
    {
      cwd: root,
      env: { ...process.env, TUNEX_LATENCY_ROOT: root },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw new Error(`子进程启动失败：${result.error.message}\n${output}`);
  if (result.status !== 0) throw new Error(`子进程退出码 ${result.status}\n${output}`);
  return output;
}

/* ------------------------------------------------------------------ */
/* ① 权限与作用域                                                      */
/* ------------------------------------------------------------------ */

const SCENARIO_PERMISSIONS = String.raw`
await group("permissions-and-scope", 7, async () => {
  /* 自定义角色**没有** forward:read ⇒ 中间件就拒（真权限内核，不是替身放行）。 */
  reset();
  asRole("member", { "node:read": true });
  let res = await status(await req("?granularity=hour&hours=6"), 403);
  let body = await res.json();
  expect(body.code).toBe("permission_denied");
  expect(body.error_layer).toBe("rbac");
  /* 被拒时请求到不了处理器：没读库、没读档案、没写任何东西。 */
  expect(dbCalls).toEqual([]);
  expect(writes).toEqual([]);

  /* 正对照：同一自定义角色加上 forward:read ⇒ 放行。 */
  asRole("member", { "forward:read": true });
  await status(await req("?granularity=hour&hours=6"), 200);

  /* viewer 能读：读端点不放宽也不收紧既有角色语义。 */
  asRole("viewer");
  await status(await req("?granularity=hour&hours=6"), 200);

  /* base member 读他人转发：既有内核 read 直接放行（本任务不改动该语义，只如实记录）。 */
  asRole("member");
  seedTunnel({ user_id: 99 });
  await status(await req("?granularity=hour&hours=6"), 200);

  /* 跨 Workspace 与"真不存在"必须逐字同形（否则响应体成了存在性探针）。 */
  asRole("owner");
  seedTunnel(null);
  dbCalls.length = 0; findFirstWheres.length = 0;
  const missing = await status(await req("?granularity=hour&hours=6"), 404);
  const missingBody = await missing.json();
  seedTunnel({ workspace_id: WS + 6 });
  const foreign = await status(await req("?granularity=hour&hours=6"), 404);
  const foreignBody = await foreign.json();
  expect(foreignBody).toEqual(missingBody);
  expect(foreignBody.code).toBe("not_found");
  expect(findFirstWheres.length).toBe(2);
  findFirstWheres.forEach(function (where) {
    expect(where.id).toBe(FORWARD_ID);
    expect(where.workspace_id).toBe(WS);
    expect(where.category).toBe("port_forward");
  });
  /* 404 也不读档案（连池都不查：作用域先定，再谈数据）。 */
  expect(dbCalls.filter(function (c) { return c.indexOf("targetLatency") === 0; }).length).toBe(0);
  expect(dbCalls.filter(function (c) { return c === "egressPool.findUnique"; }).length).toBe(0);

  /* 非法 id ⇒ 400，在权限与读库之前。 */
  seedTunnel(null);
  dbCalls.length = 0;
  await status(await reqWith("/api/forwards/abc/latency?granularity=hour", "GET"), 400);
  expect(dbCalls).toEqual([]);
});
`;

/* ------------------------------------------------------------------ */
/* ② 窗口钳制与保留期                                                   */
/* ------------------------------------------------------------------ */

const SCENARIO_WINDOW = String.raw`
await group("window-clamping", 17, async () => {
  /* 形态非法 / 缺参数 ⇒ 400 + 稳定 code，且一次都不读档案。 */
  reset();
  const bad = [
    ["", "invalid_granularity"],
    ["?granularity=minute&hours=6", "invalid_granularity"],
    ["?granularity=sample", "missing_window"],
    ["?granularity=sample&hours=6&from=2026-10-06T00:00:00Z&to=2026-10-06T01:00:00Z", "invalid_window"],
    ["?granularity=sample&from=2026-10-06T00:00:00Z", "invalid_window"],
    ["?granularity=sample&hours=abc", "invalid_window"],
    ["?granularity=sample&hours=0", "invalid_window"],
    ["?granularity=sample&hours=6.5", "invalid_window"],
    ["?granularity=hour&from=not-a-time&to=2026-10-06T01:00:00Z", "invalid_window"],
    ["?granularity=hour&from=2026-10-06T02:00:00Z&to=2026-10-06T01:00:00Z", "invalid_window"],
    ["?granularity=hour&from=2099-01-01T00:00:00Z&to=2099-01-02T00:00:00Z", "invalid_window"],
  ];
  for (let i = 0; i < bad.length; i = i + 1) {
    const res = await status(await req(bad[i][0]), 400);
    const body = await res.json();
    expect(body.code).toBe(bad[i][1]);
  }
  /* 超过该粒度上限 ⇒ 400 window_too_long（带 max_hours，**不静默截短**）。 */
  const longSample = await status(await req("?granularity=sample&hours=48"), 400);
  const longSampleBody = await longSample.json();
  expect(longSampleBody.code).toBe("window_too_long");
  expect(longSampleBody.data.max_hours).toBe(24);
  const longHour = await status(await req("?granularity=hour&hours=721"), 400);
  const longHourBody = await longHour.json();
  expect(longHourBody.code).toBe("window_too_long");
  expect(longHourBody.data.max_hours).toBe(720);
  /* 参数在被拒之前没有碰过档案面。 */
  expect(dbCalls.filter(function (c) { return c.indexOf("targetLatency") === 0; }).length).toBe(0);
  expect(dbCalls.filter(function (c) { return c === "systemConfig.findUnique"; }).length).toBe(0);

  /* to 在将来 ⇒ 钳制到 now（不多给也不少给），from 保持原值。 */
  reset();
  const now = Date.now();
  const from = new Date(now - 3 * 3600000).toISOString();
  const to = new Date(now + 5 * 3600000).toISOString();
  const clamped = await status(
    await req("?granularity=sample&from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to)),
    200,
  );
  const clampedData = (await clamped.json()).data;
  expect(clampedData.window.from).toBe(from);
  expect(Date.parse(clampedData.window.to)).toBeLessThanOrEqual(Date.now());
  expect(clampedData.window.hours).toBeGreaterThan(2.9);
  expect(clampedData.window.hours).toBeLessThan(3.1);
  expect(clampedData.status).toBe("no_samples");
  /* 传给读函数的窗口与响应里那个**是同一个**（不让下游再算一次）。 */
  expect(rawSampleQueries[0].where.observed_at.gte.toISOString()).toBe(clampedData.window.from);
  expect(rawSampleQueries[0].where.observed_at.lt.toISOString()).toBe(clampedData.window.to);

  /* 原始保留期被配成 2h：sample 粒度读 6h ⇒ 409（**在查数据之前**就拒）。 */
  reset();
  rawRetention = "2";
  const expired = await status(await req("?granularity=sample&hours=6"), 409);
  const expiredBody = await expired.json();
  expect(expiredBody.code).toBe("raw_window_expired");
  expect(expiredBody.error_layer).toBe("retention");
  expect(dbCalls.filter(function (c) { return c === "systemConfig.findUnique"; }).length).toBe(2);
  expect(dbCalls.filter(function (c) { return c.indexOf("targetLatency") === 0; }).length).toBe(0);

  /* 同一窗口换成 hour 粒度 ⇒ 200 + no_samples：与上面的 409 明确可区分。 */
  const hourRes = await status(await req("?granularity=hour&hours=6"), 200);
  expect((await hourRes.json()).data.status).toBe("no_samples");

  /* sample 粒度窗口落在保留期内 ⇒ 200（「太旧」与「空」不是同一个码）。 */
  await status(await req("?granularity=sample&hours=1"), 200);
});
`;

/* ------------------------------------------------------------------ */
/* ③ 观测维度、序列形状                                                 */
/* ------------------------------------------------------------------ */

const SCENARIO_DIMENSION = String.raw`
await group("dimension-and-series", 9, async () => {
  /* DIRECT：目标由入口节点直拨、观测器只看出口池 ⇒ 按构造没有观测者。 */
  reset();
  seedTunnel({ tunnel_mode: "direct", egress_node_id: null, egress_pool_id: null });
  let res = await status(await req("?granularity=hour&hours=6"), 200);
  let data = (await res.json()).data;
  expect(data.status).toBe("no_observer");
  expect(data.reason).toBe("direct_not_observed");
  expect(data.dimension).toBeNull();
  expect(data.series).toEqual([]);
  expect(data.truncated).toBe(false);
  /* 不去猜一个 target 来查：DIRECT 只读了转发行；响应里连 latency 字段都没有。 */
  expect(dbCalls).toEqual(["tunnel.findFirst"]);
  expect(JSON.stringify(data).indexOf("latency_ms")).toBe(-1);

  /* RELAY 但没有出口池。 */
  reset();
  seedTunnel({ egress_pool_id: null });
  res = await status(await req("?granularity=hour&hours=6"), 200);
  data = (await res.json()).data;
  expect(data.status).toBe("no_observer");
  expect(data.reason).toBe("no_egress_pool");
  expect(dbCalls).toEqual(["tunnel.findFirst"]);

  /* 出口腿在 peer panel：观测落在**那边**的档案里。 */
  reset();
  seedTunnel({ federated_egress_peer: "peer-2", egress_node_id: null, egress_pool_id: null });
  res = await status(await req("?granularity=hour&hours=6"), 200);
  data = (await res.json()).data;
  expect(data.status).toBe("no_observer");
  expect(data.reason).toBe("federated_egress");
  expect(dbCalls).toEqual(["tunnel.findFirst"]);

  /* 池的主人 ≠ 转发出口节点：归属对不上，不挑一个信。 */
  reset();
  seedPool({ node_id: EGRESS_NODE_ID + 5 });
  res = await status(await req("?granularity=hour&hours=6"), 200);
  data = (await res.json()).data;
  expect(data.status).toBe("no_observer");
  expect(data.reason).toBe("dimension_conflict");
  expect(dbCalls.filter(function (c) { return c.indexOf("targetLatency") === 0; }).length).toBe(0);

  /* 池里只有停用目标 ⇒ 没有观测维度。 */
  reset();
  seedPool({ targets: [{ id: 1, host: TARGET_HOST, port: TARGET_PORT, status: "inactive", order_by: 1000 }] });
  res = await status(await req("?granularity=hour&hours=6"), 200);
  data = (await res.json()).data;
  expect(data.status).toBe("no_observer");
  expect(data.reason).toBe("no_active_target");
  expect(dbCalls.filter(function (c) { return c.indexOf("targetLatency") === 0; }).length).toBe(0);

  /* 多个 active 目标 ⇒ 拒绝猜（只报数量，不列 host:port 清单）。 */
  reset();
  seedPool({ targets: [
    { id: 1, host: TARGET_HOST, port: TARGET_PORT, status: "active", order_by: 1000 },
    { id: 2, host: "10.0.0.9", port: 9090, status: "active", order_by: 1010 },
    { id: 3, host: "10.0.0.9", port: 9090, status: "inactive", order_by: 1020 },
  ] });
  res = await status(await req("?granularity=hour&hours=6"), 200);
  data = (await res.json()).data;
  expect(data.status).toBe("ambiguous_target");
  expect(data.reason).toBe("multiple_targets");
  expect(data.candidate_targets).toBe(2);
  expect(data.series).toEqual([]);
  expect(dbCalls.filter(function (c) { return c.indexOf("targetLatency") === 0; }).length).toBe(0);

  /* 成功形状（sample）：点逐字透传，不可达样本的 latency_ms 保持 null（绝不补 0）。 */
  reset();
  rawRows = [
    sampleRow({ observed_at: new Date("2026-10-06T01:00:00.000Z"), latency_ms: 42.5 }),
    sampleRow({ observed_at: new Date("2026-10-06T01:00:30.000Z"), reachable: false, latency_ms: null }),
  ];
  /* 显式窗口（00:00–03:00Z）：样本就在窗口里，且两位小数/顺序都可逐字断言。 */
  const fixedWindow = "?granularity=sample"
    + "&from=" + encodeURIComponent("2026-10-06T00:00:00.000Z")
    + "&to=" + encodeURIComponent("2026-10-06T03:00:00.000Z");
  res = await status(await req(fixedWindow), 200);
  data = (await res.json()).data;
  expect(data.status).toBe("ok");
  expect(data.truncated).toBe(false);
  expect(data.dimension).toEqual({ observer_node_id: EGRESS_NODE_ID, target_key: TARGET_KEY });
  expect(data.series).toEqual([
    { at: "2026-10-06T01:00:00.000Z", latency_ms: 42.5, samples: 1, successes: 1, failures: 0,
      latency_min_ms: 42.5, latency_max_ms: 42.5, observation_source: "node-7/tcp_connect" },
    { at: "2026-10-06T01:00:30.000Z", latency_ms: null, samples: 1, successes: 0, failures: 1,
      latency_min_ms: null, latency_max_ms: null, observation_source: "node-7/tcp_connect" },
  ]);
  /* 维度是**服务端推导**的：查档案用的是 (出口节点, 池目标)，不是入口节点、也不是客户端参数。 */
  expect(rawSampleQueries[0].where.node_id).toBe(EGRESS_NODE_ID);
  expect(rawSampleQueries[0].where.target_key).toBe(TARGET_KEY);
  expect(rawSampleQueries[0].where.observation_source).toBe(undefined);
  expect(rawSampleQueries[0].take).toBe(2001);

  /* hour 粒度：一个样本都没测到的小时桶 ⇒ latency_ms null（不是 0）。 */
  reset();
  bucketRows = [bucketRow({ hour_start: new Date(Date.now() - 4 * 3600000),
    sample_count: 6, success_count: 0, failure_count: 6,
    latency_samples: 0, latency_sum_ms: 0, latency_min_ms: null, latency_max_ms: null })];
  res = await status(await req("?granularity=hour&hours=6"), 200);
  data = (await res.json()).data;
  expect(data.status).toBe("ok");
  expect(data.series.length).toBe(1);
  expect(data.series[0].latency_ms).toBeNull();
  expect(data.series[0].failures).toBe(6);
  /* hour 粒度不查原始样本表（分层保留期各自为政）。 */
  expect(dbCalls.filter(function (c) { return c === "targetLatencySample.findMany"; }).length).toBe(0);

  /* 命中点数上限 ⇒ truncated=true 且点数就是上限（显式标注，不假装完整）。 */
  reset();
  rawRows = [];
  /* 2001 行 × 30s ≈ 16.7h，全部落在 [now-20h, now) 里（留出时钟漂移余量）。 */
  const spanStart = Date.now() - 19 * 3600000;
  for (let i = 0; i < 2001; i = i + 1) {
    rawRows.push(sampleRow({ observed_at: new Date(spanStart + i * 30000) }));
  }
  res = await status(await req("?granularity=sample&hours=20"), 200);
  data = (await res.json()).data;
  expect(data.truncated).toBe(true);
  expect(data.series.length).toBe(2000);

  /* 键集冻结 + 内部材料逐字不出现。 */
  expect(tunnel.internal_material).toBe(SEALED);
  const rawText = JSON.stringify(data);
  expect(rawText.indexOf("SEALED")).toBe(-1);
  expect(rawText.indexOf("internal_material")).toBe(-1);
  expect(Object.keys(data).sort()).toEqual(DATA_KEYS);
  expect(Object.keys(data.series[0]).sort()).toEqual(POINT_KEYS);
});
`;

/* ------------------------------------------------------------------ */
/* ④ 路由可达性与零副作用                                               */
/* ------------------------------------------------------------------ */

const SCENARIO_ROUTING = String.raw`
await group("reachability-and-zero-side-effects", 5, async () => {
  /* 子路由真的落到延迟处理器（不是转发详情、也不是被 catch-all 吃掉）。 */
  reset();
  rawRows = [sampleRow({ observed_at: new Date() })];
  const res = await status(await req("?granularity=sample&hours=6"), 200);
  const data = (await res.json()).data;
  expect("status" in data).toBe(true);
  expect("window" in data).toBe(true);
  expect("name" in data).toBe(false);
  expect("target_host" in data).toBe(false);
  /* 零副作用：只碰这两张业务表 + 档案的只读面；任何写操作都会让替身抛错（→ 500）。 */
  expect(dbCalls).toEqual([
    "tunnel.findFirst", "egressPool.findUnique",
    "systemConfig.findUnique", "systemConfig.findUnique",
    "targetLatencySample.findMany",
  ]);
  expect(writes).toEqual([]);

  /* 该路径不是通配：未知子路径仍然 404。 */
  await status(await reqWith("/api/forwards/11/latency-typo?granularity=hour", "GET"), 404);

  /* 对照组：:id/:action catch-all 仍然存在且可达（未知动作 ⇒ 400）。 */
  const catchAll = await status(await reqWith("/api/forwards/11/not-an-action", "POST"), 400);
  expect((await catchAll.json()).error).toBe("不支持的端口转发动作");

  /* 幂等：同一窗口读两次结论一致（显式 from/to，不受"现在"漂移影响）。 */
  reset();
  rawRows = [sampleRow({ observed_at: new Date("2026-10-06T01:00:00.000Z") })];
  const fixed = "?granularity=sample"
    + "&from=" + encodeURIComponent("2026-10-06T00:00:00.000Z")
    + "&to=" + encodeURIComponent("2026-10-06T03:00:00.000Z");
  const before = dbCalls.length;
  const first = await status(await req(fixed), 200);
  const firstBody = await first.json();
  const second = await status(await req(fixed), 200);
  expect(await second.json()).toEqual(firstBody);
  expect(dbCalls.length - before).toBe(10);
});
`;

/* ------------------------------------------------------------------ */
/* 测试入口（四个场景各在一个干净注册表的子进程里）                        */
/* ------------------------------------------------------------------ */

test("D6 权限与作用域：真实路由 + 真实权限内核（干净注册表子进程）", () => {
  expect(runScenario(SCENARIO_PERMISSIONS)).toContain("GROUP permissions-and-scope=7");
}, 30_000);

test("D6 窗口由服务端钳制：非法 400、超上限 400、raw_window_expired 与 no_samples 可区分", () => {
  expect(runScenario(SCENARIO_WINDOW)).toContain("GROUP window-clamping=17");
}, 30_000);

test("D6 观测维度：无观测 ⇒ 明确「无数据」而不是 0 值序列，成功形状逐字透传", () => {
  expect(runScenario(SCENARIO_DIMENSION)).toContain("GROUP dimension-and-series=9");
}, 30_000);

test("D6 路由可达性与零副作用：子路由没被 catch-all 吃掉、GET 只碰只读面", () => {
  expect(runScenario(SCENARIO_ROUTING)).toContain("GROUP reachability-and-zero-side-effects=5");
}, 30_000);
