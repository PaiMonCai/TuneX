/**
 * task-16 —— `GET /api/forwards/:id/ha` 的**路由级契约**（高可用只读投影）。
 *
 * 为什么必须有这个文件：这条端点把三件**已经在后端存在**的事实第一次暴露到用户域
 * （`tunnel.preferred_ingress_node_id`、`FAILOVER_POLICY` 两开关、failover 的候选判定）。
 * 它最容易犯的错不是 500，而是**说错话**：
 *
 *   ① 把"策略两个开关都是 false"渲染成"已启用/已保护"（缺省即关是生产缺省）；
 *   ② 把「期望」（首选入口）与「事实」（当前归属 / 在线 / 能否接业务）混成一个字段；
 *   ③ 把"这次读不到候选"（unavailable）与"确实没有合格候选"（none）压成同一个空值 ——
 *      本专项在这类"降级态被渲染成结论"上反复吃过亏（延迟端点的 `no_observer` 同理）。
 *
 * 所以这里挂**真实** `forwardsRoutes`（真路由 + 真权限内核 + 真 failover 判定函数 +
 * 真 preferred-ingress 写入服务），只替身数据面 `db.ts`。
 *
 * 为什么整段跑在**子进程**里（沿用 `forwards-latency-route.test.ts` / `workspace-rbac.test.ts`
 * 的同一模式）：`mock.module` 是**进程级**注册表，同进程里别的测试文件若替换过 `workspace.ts`
 * 或 `db.ts`，本文件会解析到**别人的替身** —— 断言就变成"替身互相对答案"。
 *
 * 覆盖（每组内 status 断言计数必须**恰好**等于写死的数字：既证明这组真跑到，也挡住整组被
 * 静默跳过）：
 *   ① 权限与作用域：无 `forward:read` 被拒（真内核，且一次库都不读）、viewer/member 既有语义、
 *      跨 Workspace 404 与"真不存在"逐字同形、非法 id 400；
 *   ② 投影真值：键集冻结、期望/事实分离、策略三态（缺省关 / 配成开 / 坏 JSON + parse_error）、
 *      候选三态（available / none 由**同一份**判定算出）、备选集合的 `can_be_preferred` 只用
 *      写入路径规则而 connection / accepts_new_business 是并列事实；
 *   ③ 写入路径未改动 + 读后写：PUT 设置/清除首选入口后，`/ha` 的**期望**变化而**事实**不变；
 *      角色不符的节点被真服务拒绝（400 preferred_role_mismatch）；
 *   ④ 顺序纪律：GET `/:id/ha` 没被 `/:id/:action` 吃掉（同一路径上 POST 仍走 catch-all，
 *      两条响应体**不同**，证明 GET 命中的是字面量子路由）。
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
const root = process.env.TUNEX_HA_ROOT;

const WS = 3;
const FORWARD_ID = 11;
const GROUP = 1;
// 现任入口 / 合格候选 / 离线 / 角色不符 / 未声明角色 / 维护中 / 别的组
const N_ACTIVE = 51, N_CANDIDATE = 52, N_OFFLINE = 53;
const N_EGRESS = 54, N_NOROLE = 55, N_MAINTENANCE = 56, N_FOREIGN_GROUP = 57;

let role = "owner", roleId = null, permissions = null, active = true;
let requestWorkspace = WS;
let tunnel = null;
let failoverQueryThrows = false;
let optionsQueryThrows = false;
const nodeGroups = { 1: WS, 2: WS + 6 };
const configRows = new Map();
const dbCalls = [];
const findFirstWheres = [];
const writes = [];
const updated = [];

const FRESH = new Date(Date.now() - 5_000);
const STALE = new Date(Date.now() - 30 * 60_000);
const SEALED = "v1.SEALED-node-credential-material-must-never-appear";

let nodes = [];
function seedNodes() {
  nodes = [
    nodeRow({ id: N_ACTIVE, role: "ingress" }),
    nodeRow({ id: N_CANDIDATE, role: "ingress" }),
    nodeRow({ id: N_OFFLINE, role: "both", last_seen_at: STALE }),
    nodeRow({ id: N_EGRESS, role: "egress" }),
    nodeRow({ id: N_NOROLE, role: null }),
    nodeRow({ id: N_MAINTENANCE, role: "ingress", lifecycle: "maintenance" }),
    nodeRow({ id: N_FOREIGN_GROUP, role: "ingress", node_group_id: 2 }),
  ];
}
function nodeRow(over) {
  return Object.assign({
    id: 0, node_id: "node-" + String(over && over.id),
    role: "ingress", status: "active", last_seen_at: FRESH,
    node_group_id: GROUP, lifecycle: "active",
    node_credential_hash: SEALED, credential_revoked: false,
  }, over || {});
}
function baseTunnel(over) {
  return Object.assign({
    id: FORWARD_ID, workspace_id: WS, category: "port_forward", user_id: 1,
    in_node_group_id: GROUP, ingress_node_id: N_ACTIVE, preferred_ingress_node_id: null,
    failback_healthy_checks: 0,
  }, over || {});
}
function reset() {
  role = "owner"; roleId = null; permissions = null; active = true; requestWorkspace = WS;
  tunnel = baseTunnel({});
  failoverQueryThrows = false; optionsQueryThrows = false;
  configRows.clear();
  dbCalls.length = 0; findFirstWheres.length = 0; writes.length = 0; updated.length = 0;
  seedNodes();
}
function seedTunnel(over) { tunnel = over === null ? null : baseTunnel(over); }
function asRole(base, perms) {
  role = base;
  roleId = perms === undefined ? null : 44;
  permissions = perms === undefined ? null : perms;
}

/* 与 Prisma 一致的最小匹配器：undefined 键不构成条件、{not}/{in}、以及 node_group 关系过滤。 */
function matches(row, where) {
  return Object.keys(where).every(function (key) {
    const want = where[key];
    if (want === undefined) return true;
    if (key === "node_group") return nodeGroups[row.node_group_id] === want.workspace_id;
    if (want !== null && typeof want === "object" && !(want instanceof Date)) {
      const have = row[key];
      if (Object.prototype.hasOwnProperty.call(want, "not")) return have !== want.not;
      if (Object.prototype.hasOwnProperty.call(want, "in")) return want.in.indexOf(have) >= 0;
    }
    return row[key] === want;
  });
}
function project(row, select) {
  const out = {};
  Object.keys(select).forEach(function (key) {
    if (select[key] === true) out[key] = row[key] === undefined ? null : row[key];
  });
  return out;
}
function orderedTake(rows, orderBy, take) {
  const key = Object.keys(orderBy || { id: "asc" })[0];
  const desc = (orderBy || {})[key] === "desc";
  const sorted = rows.slice().sort(function (a, b) {
    const cmp = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
    return desc ? -cmp : cmp;
  });
  return take === undefined ? sorted : sorted.slice(0, take);
}
/* 写操作：读端点碰任何一次都必须炸（不是一条静默断言）。 */
function forbid(name) {
  return async function () { writes.push(name); throw new Error("读端点不得调用 " + name); };
}
const FAILOVER_SELECT_MARK = "node_group_id";

mock.module(root + "db.ts", () => ({ db: {
  workspace: { findUnique: async () => ({ id: WS }) },
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
    findUnique: async (args) => {
      dbCalls.push("tunnel.findUnique");
      if (!tunnel || tunnel.id !== args.where.id) return null;
      return project(tunnel, args.select);
    },
    update: async (args) => {
      writes.push("tunnel.update");
      updated.push(args.data);
      if (tunnel && tunnel.id === args.where.id) Object.assign(tunnel, args.data);
      return tunnel;
    },
    create: forbid("tunnel.create"), delete: forbid("tunnel.delete"),
    updateMany: forbid("tunnel.updateMany"), deleteMany: forbid("tunnel.deleteMany"),
  },
  node: {
    findMany: async (args) => {
      dbCalls.push("node.findMany");
      /* 候选查询（failover）带 id:{not} 与角色白名单；备选集合查询带 node_group 关系。 */
      if (Object.prototype.hasOwnProperty.call(args.where, "id")) {
        if (failoverQueryThrows) throw new Error("db is down (failover candidate query)");
      }
      if (Object.prototype.hasOwnProperty.call(args.where, "node_group")) {
        if (optionsQueryThrows) throw new Error("db is down (preference options query)");
      }
      const rows = nodes.filter(function (row) { return matches(row, args.where); });
      const ordered = orderedTake(rows, args.orderBy, args.take);
      return args.select ? ordered.map(function (r) { return project(r, args.select); }) : ordered;
    },
    findUnique: async (args) => {
      dbCalls.push("node.findUnique");
      const row = nodes.filter(function (r) { return r.id === args.where.id; })[0];
      return row ? project(row, args.select) : null;
    },
    create: forbid("node.create"), update: forbid("node.update"), delete: forbid("node.delete"),
    updateMany: forbid("node.updateMany"),
  },
  systemConfig: {
    findUnique: async (args) => {
      dbCalls.push("systemConfig.findUnique");
      const value = configRows.has(args.where.name) ? configRows.get(args.where.name) : null;
      return value === null || value === undefined ? null : { name: args.where.name, value: value };
    },
    upsert: async (args) => {
      writes.push("systemConfig.upsert");
      const value = args.update ? args.update.value : args.create.value;
      configRows.set(args.where.name, value);
      return { name: args.where.name, value: value };
    },
  },
} }));

const { forwardsRoutes } = await import(root + "routes/forwards.ts");
const { systemConfig } = await import(root + "services/config.ts");
const app = new Hono();
app.use("*", async (c, next) => { c.set("user", { id: 1, super_admin: false }); await next(); });
app.route("/api/forwards", forwardsRoutes);

const PATH = "/api/forwards/" + FORWARD_ID + "/ha";
function headers() { return { "x-workspace-id": String(requestWorkspace) }; }
function req() { return app.request(PATH, { headers: headers() }); }
function reqPath(path, method, body) {
  return app.request(path, {
    method: method, headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ha() { const res = await status(await req(), 200); return (await res.json()).data; }
function nodeOf(data, id) {
  return data.preference_options.nodes.filter(function (n) { return n.node_id === id; })[0];
}

/* 分组执行器：组内 status 断言计数必须**恰好**等于写死的数字。 */
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
const DATA_KEYS = ["active_ingress_node_id","failover_candidate","forward_id","policy","preference_options","preferred_ingress_node_id"].sort();
const POLICY_KEYS = ["auto_failback","auto_failover","parse_error"].sort();
const CANDIDATE_KEYS = ["node_id","reason","status"].sort();
const OPTION_KEYS = ["accepts_new_business","admission_rejection","can_be_preferred","connection","is_active_ingress","is_preferred","lifecycle","name","node_group_id","node_id","preference_rejection","role"].sort();
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
      env: { ...process.env, TUNEX_HA_ROOT: root },
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
await group("permissions-and-scope", 6, async () => {
  /* 自定义角色**没有** forward:read ⇒ 中间件就拒（真权限内核，不是替身放行）。 */
  reset();
  asRole("member", { "node:read": true });
  let res = await status(await req(), 403);
  let body = await res.json();
  expect(body.code).toBe("permission_denied");
  expect(body.error_layer).toBe("rbac");
  /* 被拒时请求到不了处理器：一次库都没读。 */
  expect(dbCalls).toEqual([]);

  /* 正对照：同一自定义角色加上 forward:read ⇒ 放行。 */
  asRole("member", { "forward:read": true });
  await status(await req(), 200);

  /* viewer 能读：只读端点不放宽也不收紧既有角色语义。 */
  asRole("viewer");
  await status(await req(), 200);

  /* 跨 Workspace 与"真不存在"必须逐字同形（否则响应体成了存在性探针）。 */
  reset();
  seedTunnel(null);
  const missing = await status(await req(), 404);
  const missingBody = await missing.json();
  seedTunnel({ workspace_id: WS + 6 });
  const foreign = await status(await req(), 404);
  const foreignBody = await foreign.json();
  expect(foreignBody).toEqual(missingBody);
  expect(foreignBody.code).toBe("not_found");
  findFirstWheres.forEach(function (where) {
    expect(where.id).toBe(FORWARD_ID);
    expect(where.workspace_id).toBe(WS);
    expect(where.category).toBe("port_forward");
  });
  /* 404 也不读任何节点面（作用域先定，再谈事实）。 */
  expect(dbCalls.filter(function (c) { return c === "node.findMany"; }).length).toBe(0);

  /* 非法 id ⇒ 400，在权限与读库之前。 */
  reset();
  dbCalls.length = 0;
  await status(await reqPath("/api/forwards/abc/ha", "GET"), 400);
  expect(dbCalls).toEqual([]);
});
`;

/* ------------------------------------------------------------------ */
/* ② 投影真值（键集 / 期望 vs 事实 / 三态）                              */
/* ------------------------------------------------------------------ */

const SCENARIO_TRUTH = String.raw`
await group("projection-truth", 7, async () => {
  reset();
  asRole("owner");

  /* ── 缺省：策略从没配过 ⇒ 两个开关都 false（生产缺省，且是**生效事实**）── */
  let data = await ha();
  expect(Object.keys(data).sort()).toEqual(DATA_KEYS);
  expect(Object.keys(data.policy).sort()).toEqual(POLICY_KEYS);
  expect(Object.keys(data.failover_candidate).sort()).toEqual(CANDIDATE_KEYS);
  expect(data.policy).toEqual({ auto_failover: false, auto_failback: false, parse_error: null });
  expect(data.forward_id).toBe(FORWARD_ID);

  /* 期望 vs 事实：没有偏好 ≠ 不知道现在归谁。 */
  expect(data.preferred_ingress_node_id).toBe(null);
  expect(data.active_ingress_node_id).toBe(N_ACTIVE);

  /* 候选：现任被排除，最低 id 的合格在线入口就是它（与 failover 同一份判定）。 */
  expect(data.failover_candidate).toEqual({ status: "available", node_id: N_CANDIDATE, reason: null });

  /* 备选集合：只列这条转发的入口组，键集冻结，且**不含凭据材料**。 */
  expect(data.preference_options.status).toBe("ok");
  const ids = data.preference_options.nodes.map(function (n) { return n.node_id; });
  expect(ids).toEqual([N_ACTIVE, N_CANDIDATE, N_OFFLINE, N_EGRESS, N_NOROLE, N_MAINTENANCE]);
  data.preference_options.nodes.forEach(function (n) {
    expect(Object.keys(n).sort()).toEqual(OPTION_KEYS);
  });
  expect(JSON.stringify(data)).not.toContain(SEALED);
  expect(JSON.stringify(data)).not.toContain("node_credential_hash");

  /* ── 每条节点事实分开：能当首选（写入路径规则）与此刻的 connection / 准入结论 ── */
  const activeNode = nodeOf(data, N_ACTIVE);
  expect(activeNode.can_be_preferred).toBe(true);
  expect(activeNode.preference_rejection).toBe(null);
  expect(activeNode.connection).toBe("online");
  expect(activeNode.accepts_new_business).toBe(true);
  expect(activeNode.is_active_ingress).toBe(true);
  expect(activeNode.is_preferred).toBe(false);

  const candidateNode = nodeOf(data, N_CANDIDATE);
  expect(candidateNode.can_be_preferred).toBe(true);
  expect(candidateNode.is_active_ingress).toBe(false);

  /* 离线节点**仍然可以**被设为首选（偏好是"它回来后优先归它"）——写入路径就是这么判的。 */
  const offlineNode = nodeOf(data, N_OFFLINE);
  expect(offlineNode.can_be_preferred).toBe(true);
  expect(offlineNode.connection).toBe("offline");

  /* 维护中：连接是事实（online），准入是另一个维度（false + 原因码）。 */
  const maintenanceNode = nodeOf(data, N_MAINTENANCE);
  expect(maintenanceNode.connection).toBe("online");
  expect(maintenanceNode.accepts_new_business).toBe(false);
  expect(maintenanceNode.admission_rejection).toBe("node_in_maintenance");
  expect(maintenanceNode.can_be_preferred).toBe(true);

  /* 角色不符 / 未声明角色：**不能**当首选，原因码与 ingress-candidate 同一套词表。 */
  expect(nodeOf(data, N_EGRESS).can_be_preferred).toBe(false);
  expect(nodeOf(data, N_EGRESS).preference_rejection).toBe("role_mismatch");
  expect(nodeOf(data, N_NOROLE).can_be_preferred).toBe(false);
  expect(nodeOf(data, N_NOROLE).preference_rejection).toBe("role_undeclared");

  /* ── 策略真值：配成"开"就如实说开（只读，不提供写入口） ── */
  await systemConfig.setConfig("FAILOVER_POLICY", JSON.stringify({ auto_failover: true, auto_failback: false }));
  data = await ha();
  expect(data.policy).toEqual({ auto_failover: true, auto_failback: false, parse_error: null });

  /* 坏 JSON：fail-closed 成两个 false，但 parse_error 必须带出来（"配置坏了" ≠ "运维没开"）。 */
  await systemConfig.setConfig("FAILOVER_POLICY", "{not json");
  data = await ha();
  expect(data.policy.auto_failover).toBe(false);
  expect(data.policy.auto_failback).toBe(false);
  expect(typeof data.policy.parse_error).toBe("string");

  /* ── 候选三态：none（确实没有合格候选）与 unavailable（这次读不到）必须可分 ── */
  reset();
  await systemConfig.setConfig("FAILOVER_POLICY", "");
  /* 现任是组内唯一合格的入口：另一个在线的候选不存在 ⇒ none（不是 unavailable）。 */
  nodes = nodes.filter(function (n) { return n.id !== N_CANDIDATE; });
  data = await ha();
  expect(data.failover_candidate).toEqual({ status: "none", node_id: null, reason: null });
  /* 只有"在线"这一个维度的差异就能翻状态：把唯一候选取回但让它离线 ⇒ 仍是 none。 */
  nodes = nodes.filter(function (n) { return n.id !== N_CANDIDATE; }).concat([nodeRow({ id: N_CANDIDATE, role: "ingress", last_seen_at: STALE })]);
  data = await ha();
  expect(data.failover_candidate.status).toBe("none");

  /* 读不到：候选查询抛错 ⇒ unavailable + 稳定原因码（**不**渲染成"没有候选"）。 */
  failoverQueryThrows = true;
  data = await ha();
  expect(data.failover_candidate).toEqual({ status: "unavailable", node_id: null, reason: "candidate_query_failed" });
  /* 候选读不到时，备选集合仍然照常给出（两个事实各自独立降级）。 */
  expect(data.preference_options.status).toBe("ok");

  /* 反向：备选集合读不到 ⇒ 它自己是 unavailable，候选判定仍然可用。 */
  failoverQueryThrows = false;
  optionsQueryThrows = true;
  data = await ha();
  expect(data.preference_options).toEqual({ status: "unavailable", nodes: [] });
  expect(data.failover_candidate.status).toBe("none");
});
`;

/* ------------------------------------------------------------------ */
/* ③ 写入路径未改动 + 读后写                                            */
/* ------------------------------------------------------------------ */

const SCENARIO_WRITE = String.raw`
await group("write-then-read", 7, async () => {
  reset();
  asRole("owner");

  /* 设置首选入口（走**既有** PUT）：期望变了，事实（现在归谁 / 健康计数）另说。 */
  let res = await status(await reqPath(PATH.replace(/\/ha$/, "/preferred-ingress"), "PUT", { node_id: N_OFFLINE }), 200);
  expect((await res.json()).data).toEqual({ tunnel_id: FORWARD_ID, preferred_ingress_node_id: N_OFFLINE });
  /* 换了偏好就重新计数（否则旧偏好攒的"连续健康"会算到新节点头上）。 */
  expect(updated[updated.length - 1]).toEqual({ preferred_ingress_node_id: N_OFFLINE, failback_healthy_checks: 0 });

  let data = await ha();
  expect(data.preferred_ingress_node_id).toBe(N_OFFLINE);
  /* 事实没有被偏好改写：接入归属仍在原入口，且这个首选节点本身是离线的。 */
  expect(data.active_ingress_node_id).toBe(N_ACTIVE);
  expect(nodeOf(data, N_OFFLINE).is_preferred).toBe(true);
  expect(nodeOf(data, N_OFFLINE).connection).toBe("offline");

  /* 清除偏好（node_id = null）⇒ 回到"没有偏好"。 */
  const cleared = await status(await reqPath(PATH.replace(/\/ha$/, "/preferred-ingress"), "PUT", { node_id: null }), 200);
  expect((await cleared.json()).data.preferred_ingress_node_id).toBe(null);
  data = await ha();
  expect(data.preferred_ingress_node_id).toBe(null);

  /* 角色不符的节点被**真服务**拒绝（不是本端点自己判的）。 */
  const badRole = await status(await reqPath(PATH.replace(/\/ha$/, "/preferred-ingress"), "PUT", { node_id: N_EGRESS }), 400);
  const badBody = await badRole.json();
  expect(badBody.code).toBe("preferred_role_mismatch");
  expect(badBody.error_layer).toBe("failover");

  /* ── 顺序纪律：同一路径上 POST 仍走 /:id/:action catch-all，两条响应体不同 ── */
  const catchAll = await status(await reqPath(PATH, "POST", {}), 400);
  const catchAllBody = await catchAll.json();
  /* catch-all 的未知动作码是 invalid_input（本任务不改它），关键是**说明**这条件命中的是 catch-all。 */
  expect(catchAllBody.error).toBe("不支持的端口转发动作");
  const haBody = await ha();
  expect(haBody.failover_candidate).toBeTruthy();
  expect(Object.keys(haBody).sort()).toEqual(DATA_KEYS);
});
`;

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

test("GET /api/forwards/:id/ha（权限与作用域）", () => {
  const output = runScenario(SCENARIO_PERMISSIONS);
  expect(output).toContain("GROUP permissions-and-scope=6");
});

test("GET /api/forwards/:id/ha（投影真值：期望 vs 事实、策略、候选三态）", () => {
  const output = runScenario(SCENARIO_TRUTH);
  expect(output).toContain("GROUP projection-truth=7");
});

test("GET /api/forwards/:id/ha（写入路径未改动 + 读后写 + 顺序纪律）", () => {
  const output = runScenario(SCENARIO_WRITE);
  expect(output).toContain("GROUP write-then-read=7");
});
