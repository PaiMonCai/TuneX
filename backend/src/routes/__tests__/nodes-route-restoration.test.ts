/**
 * 缺陷 1 的**真实路由级**回归 —— `GET /:ingressId/support-bundle`、
 * `GET|POST /:ingressId/bindings`、`DELETE /:ingressId/bindings/:egressId`。
 *
 * ── 被修的是什么（真事故，不是假想）──
 * 加 `GET /:ingressId/upgrade-state` 的那次改动，顺手动删了上面四个端点。
 * 证据链有三条，缺一条都可能被当成"没人在用"：
 *   1. `git diff origin/main...HEAD -- backend/src/routes/nodes.ts` 里它们整段是 `-`；
 *   2. 前端仍在调用（`web/src/lib/api/nodes.ts` 的 `bindings` / `bindEgress` /
 *      `unbindEgress` / `supportBundle`，消费方是 `node-workspace.tsx` /
 *      `node-diagnostics.tsx` / `forward-detail.tsx`）；
 *   3. `web/.../forward-copy-usage.test.ts` 直接**读后端源码**断言
 *      `lookupBindingUsage(` / `bindingUsageMap(` / `tunnel_mode: "relay"` /
 *      `code: "binding_in_use"` 仍在 —— 也就是说"删掉"这件事在**前端**先红了。
 *
 * ── 为什么必须是真实路由 + 真实权限内核（而不是静态断言）──
 * 静态断言只能证明"代码里有这几行"；它证明不了 Hono 真的把请求交给它们、证明不了
 * 中间件的 (action, resource) 映射没被改坏、也证明不了解绑闸门还在数 relay。
 * 最近一次同类事故（DNS 前门被 `:id/:action` catch-all 吃掉）就是"服务层全绿、真实
 * API 400"。所以这里挂**真实** `nodesRoutes`，用 `app.request()` 真的打，并**不替身**
 * `services/workspace.ts`：RBAC 断言要的正是真内核（自定义角色是**替换**语义）。
 *
 * ── 为什么不连生产库 / 为什么不污染同进程 ──
 * `mock.module` 是**进程级**注册表，同进程里别的测试文件也会替换 `db.ts`/`workspace.ts`。
 * 因此整段跑在**子进程**里（沿用 `node-upgrade-state.test.ts` / `forwards-latency-route.test.ts`
 * 的既有模式），子进程里只 mock `db.ts` 与 `redis.ts`（数据面替身），**零真实连接**。
 *
 * 覆盖（组内 status 断言计数写死：既证明这组真跑到，也挡住"整组被注释掉"的静默失效）：
 *   ① 注册与形状：四个端点真实可达、键集冻结、usage 投影（命中/缺口/裁剪）与 N+1 守卫、
 *      support-bundle 的白名单产物与脱敏；回归：`upgrade-state` 仍未被遮蔽；
 *   ② 参数与作用域：非法 id / 不存在 / 角色不符 / 同节点 / 跨 Workspace —— 与 origin/main 逐字同形；
 *   ③ RBAC：真内核下的 viewer/member/admin 与**只带 node:\* 的自定义角色**（usage 与
 *      support-bundle 段落必须按权限裁剪，而不是"读得到就什么都给"）；
 *   ④ 解绑依赖闸门：>0 ⇒ 409 `binding_in_use` + 使用量 + **不写**；=0 ⇒ 200 + 精确 where。
 *
 * 跑法（backend 目录）：bun test src/routes/__tests__/nodes-route-restoration.test.ts
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../..", import.meta.url).pathname;

const PRELUDE = String.raw`
import { mock, expect } from "bun:test";
import { Hono } from "hono";
const root = process.env.TUNEX_NODES_RESTORE_ROOT;

const PERSONAL_WS = 3;
const TEAM_WS = 9;
const INGRESS_ID = 1;
const EGRESS_ID = 2;
const SECOND_EGRESS_ID = 5;
const CREDENTIAL_HASH = "v1.SEALED-node-credential-hash-must-never-appear";

/* redis 替身：这四条端点都不碰 redis；替身只为把子进程从"真实 ioredis 连接重试"里
 * 解放出来（否则每次 spawn 都要等连接超时）。键构造器用 Proxy 兜住即可。 */
mock.module(root + "redis.ts", () => ({
  redis: new Proxy({ status: "ready" }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return async function () { return null; };
    },
  }),
  RedisKeys: new Proxy({}, { get() { return function () { return "k"; }; } }),
  scopedKey(key) { return String(key); },
  observerBufferKey(key) { return String(key); },
  OBSERVER_BUFFER_MAX: 500,
  redisPing: async function () { return true; },
}));

/* ── 可变状态（每个场景开头 reset()） ── */
let role = "owner", roleId = null, permissions = null, active = true;
let requestWorkspace = PERSONAL_WS;
let nodes = [];
let bindings = [];
let usageGroups = [];
let relayCount = 0;
let report = null;
let forwardRows = [];
const calls = [];
const writes = [];
const bindingListArgs = [];
const bindingUpsertArgs = [];
const bindingDeleteArgs = [];
const groupByArgs = [];
const tunnelCountArgs = [];
const tunnelFindManyArgs = [];

/* Prisma 语义：只有 select 里为 true 的列出现在返回值里；嵌套 select 递归。 */
function project(row, select) {
  const out = {};
  Object.keys(select).forEach(function (key) {
    const spec = select[key];
    if (spec === true) out[key] = row[key] === undefined ? null : row[key];
    else if (spec && typeof spec === "object" && spec.select) out[key] = row[key] ? project(row[key], spec.select) : null;
  });
  return out;
}
function forbid(name) {
  return async function () { writes.push(name); throw new Error("读端点不得调用 " + name); };
}
function nodeOf(id) {
  for (const row of nodes) if (row.id === id) return row;
  return null;
}
function egressNodeOf(binding) { return nodeOf(binding.egress_node_id); }

function node(id, over) {
  return Object.assign({
    id: id,
    node_id: "node-" + id,
    agent_id: "agent-uuid-" + id,
    connect_ip: "10.0.0." + id,
    role: id === INGRESS_ID ? "ingress" : "egress",
    status: "active",
    version: "unknown",
    last_seen_at: new Date("2026-10-07T00:00:00.000Z"),
    port_range_min: 21000,
    port_range_max: 21999,
    lb_strategy: "round",
    node_group_id: 1,
    node_credential_hash: CREDENTIAL_HASH,
    credential_revoked: false,
    lifecycle: "active",
    lifecycle_note: null,
    lifecycle_updated_at: null,
    node_group: { id: 1, name: "Group A", node_type: "in", workspace_id: PERSONAL_WS },
  }, over || {});
}
function reset() {
  role = "owner"; roleId = null; permissions = null; active = true; requestWorkspace = PERSONAL_WS;
  nodes = [node(INGRESS_ID), node(EGRESS_ID), node(SECOND_EGRESS_ID)];
  bindings = [{ id: 100, ingress_node_id: INGRESS_ID, egress_node_id: EGRESS_ID, created_at: new Date("2026-10-01T00:00:00.000Z") }];
  usageGroups = [{ ingress_node_id: INGRESS_ID, egress_node_id: EGRESS_ID, count: 2 }];
  relayCount = 0;
  report = null;
  forwardRows = [];
  calls.length = 0; writes.length = 0;
  bindingListArgs.length = 0; bindingUpsertArgs.length = 0; bindingDeleteArgs.length = 0;
  groupByArgs.length = 0; tunnelCountArgs.length = 0; tunnelFindManyArgs.length = 0;
}
/* 基础角色 / 自定义角色（自定义角色是**替换**语义，不会回落到基础角色）。 */
function asRole(base, perms) {
  role = base;
  roleId = perms === undefined ? null : 44;
  permissions = perms === undefined ? null : perms;
}
function addBinding(id, ingressId, egressId) {
  bindings.push({ id: id, ingress_node_id: ingressId, egress_node_id: egressId, created_at: new Date("2026-10-02T00:00:00.000Z") });
}
function seedForwards(rows) { forwardRows = rows; }

mock.module(root + "db.ts", () => ({ db: {
  /* 真权限内核（services/workspace.ts）要的两张表：本文件**不**替身 workspace.ts。 */
  workspace: { findUnique: async function () { return { id: PERSONAL_WS }; } },
  workspaceMember: { findUnique: async function (args) {
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

  node: {
    findFirst: async function (args) {
      calls.push("node.findFirst");
      const row = nodeOf(args.where.id);
      if (!row) return null;
      if (args.where.node_group && row.node_group.workspace_id !== args.where.node_group.workspace_id) return null;
      return project(row, args.select);
    },
    findUnique: async function (args) {
      calls.push("node.findUnique");
      const row = nodeOf(args.where.id);
      return row ? project(row, args.select) : null;
    },
    update: forbid("node.update"), findMany: forbid("node.findMany"),
  },

  nodeBinding: {
    findMany: async function (args) {
      calls.push("nodeBinding.findMany");
      bindingListArgs.push(args);
      const scope = args.where.egress_node.node_group.workspace_id;
      const rows = bindings
        .filter(function (b) {
          if (b.ingress_node_id !== args.where.ingress_node_id) return false;
          const egress = egressNodeOf(b);
          return !!egress && egress.node_group.workspace_id === scope;
        })
        .sort(function (a, b) { return a.id - b.id; });
      return rows.map(function (row) {
        const out = Object.assign({}, row);
        out.egress_node = project(nodeOf(row.egress_node_id), args.include.egress_node.select);
        return out;
      });
    },
    upsert: async function (args) {
      calls.push("nodeBinding.upsert");
      bindingUpsertArgs.push(args);
      const key = args.where.ingress_node_id_egress_node_id;
      let row = bindings.find(function (b) {
        return b.ingress_node_id === key.ingress_node_id && b.egress_node_id === key.egress_node_id;
      });
      if (!row) {
        row = Object.assign({ id: 200 + bindings.length, created_at: new Date("2026-10-03T00:00:00.000Z") }, args.create);
        bindings.push(row);
      }
      return Object.assign({}, row);
    },
    deleteMany: async function (args) {
      calls.push("nodeBinding.deleteMany");
      bindingDeleteArgs.push(args);
      const before = bindings.length;
      bindings = bindings.filter(function (b) {
        return !(b.ingress_node_id === args.where.ingress_node_id && b.egress_node_id === args.where.egress_node_id);
      });
      return { count: before - bindings.length };
    },
    count: forbid("nodeBinding.count"),
  },

  tunnel: {
    /* 列表使用量：一次 groupBy（N+1 守卫）。 */
    groupBy: async function (args) {
      calls.push("tunnel.groupBy");
      groupByArgs.push(args);
      return usageGroups.map(function (g) {
        return { ingress_node_id: g.ingress_node_id, egress_node_id: g.egress_node_id, _count: { _all: g.count } };
      });
    },
    count: async function (args) {
      calls.push("tunnel.count");
      tunnelCountArgs.push(args);
      return relayCount;
    },
    findMany: async function (args) {
      calls.push("tunnel.findMany");
      tunnelFindManyArgs.push(args);
      if (!args.select.remote_host) return [];
      return forwardRows.map(function (r) { return project(r, args.select); });
    },
    findFirst: forbid("tunnel.findFirst"),
    update: forbid("tunnel.update"), create: forbid("tunnel.create"), delete: forbid("tunnel.delete"),
  },

  nodeStateReport: { findUnique: async function (args) {
    calls.push("nodeStateReport.findUnique");
    return report && report.node_id === args.where.node_id ? project(report, args.select) : null;
  } },
  forwardRollout: { findMany: async function () { calls.push("forwardRollout.findMany"); return []; } },
  auditEvent: { findMany: async function () { calls.push("auditEvent.findMany"); return []; } },
} }));

const { nodesRoutes } = await import(root + "routes/nodes.ts");

const app = new Hono();
app.use("*", async function (c, next) { c.set("user", { id: 1, super_admin: false }); await next(); });
app.route("/api/nodes", nodesRoutes);

function req(path, options) {
  return app.request("/api/nodes" + path, Object.assign({
    method: "GET",
    headers: { "x-workspace-id": String(requestWorkspace) },
  }, options || {}));
}
function json(body) {
  return { method: "POST", headers: { "x-workspace-id": String(requestWorkspace), "content-type": "application/json" }, body: JSON.stringify(body) };
}
const BINDING_KEYS = ["created_at","egress_node","egress_node_id","id","ingress_node_id","unbind_blocked","usage_visible","used_by_forward_count"];

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
/* ① 四个端点真实可达 + 形状冻结 + usage 投影 + support-bundle 产物        */
/* ------------------------------------------------------------------ */

const SCENARIO_CONTRACT = String.raw`
await group("restored-endpoints-contract", 5, async () => {
  reset();

  /* GET /:ingressId/bindings —— 命中使用量的绑定 + 零使用量的绑定必须在同一形状里。 */
  addBinding(101, INGRESS_ID, SECOND_EGRESS_ID);
  const list = await status(await req("/1/bindings"), 200);
  const rows = (await list.json()).data;
  expect(rows.length).toBe(2);
  expect(Object.keys(rows[0]).sort()).toEqual(BINDING_KEYS);
  expect(rows[0].used_by_forward_count).toBe(2);
  expect(rows[0].unbind_blocked).toBe(true);
  /* 缺口 ⇒ 0/false（"没有被使用"），**不是** null（null 只用于"没权限看"）。 */
  expect(rows[1].used_by_forward_count).toBe(0);
  expect(rows[1].unbind_blocked).toBe(false);
  expect(rows[0].egress_node.id).toBe(EGRESS_ID);
  /* nodeView 投影仍在（凭据哈希只折算成布尔，绝不外泄）。 */
  expect(rows[0].egress_node.has_credential).toBe(true);
  expect(JSON.stringify(rows[0])).not.toContain(CREDENTIAL_HASH);
  /* N+1 守卫：两个绑定只允许一次 groupBy。 */
  expect(groupByArgs.length).toBe(1);
  expect(groupByArgs[0].where).toEqual({
    workspace_id: PERSONAL_WS, category: "port_forward", tunnel_mode: "relay",
    ingress_node_id: INGRESS_ID, egress_node_id: { not: null },
  });
  expect(groupByArgs[0].by).toEqual(["ingress_node_id", "egress_node_id"]);

  /* POST /:ingressId/bindings —— 201 + 新建必然 0 使用量（形状与列表一致）。 */
  const created = await status(await req("/1/bindings", json({ egress_node_id: SECOND_EGRESS_ID })), 201);
  const createdBody = (await created.json()).data;
  expect(createdBody.ingress_node_id).toBe(INGRESS_ID);
  expect(createdBody.egress_node_id).toBe(SECOND_EGRESS_ID);
  expect(createdBody.used_by_forward_count).toBe(0);
  expect(createdBody.unbind_blocked).toBe(false);
  expect(createdBody.egress_node.id).toBe(SECOND_EGRESS_ID);

  /* 幂等：重复绑定 upsert 同一行（不新增、不报错）。 */
  const again = await status(await req("/1/bindings", json({ egress_node_id: SECOND_EGRESS_ID })), 201);
  expect((await again.json()).data.id).toBe(createdBody.id);
  expect(bindingUpsertArgs[1].update).toEqual({});

  /* DELETE /:ingressId/bindings/:egressId —— 无依赖 ⇒ 200 {ok:true}，且 where 精确。 */
  const removed = await status(await req("/1/bindings/" + EGRESS_ID, { method: "DELETE" }), 200);
  expect((await removed.json()).data).toEqual({ ok: true });
  expect(bindingDeleteArgs[0].where).toEqual({ ingress_node_id: INGRESS_ID, egress_node_id: EGRESS_ID });

  /* GET /:ingressId/support-bundle —— 白名单产物 + 段落裁剪说明 + 脱敏。 */
  report = { node_id: INGRESS_ID, version: "0.13.22", role: "INGRESS", control_protocol_version: 2,
    capabilities: ["x"], reported_revision: 7, known_revision: 7, runtime_counts: {}, host_metrics: {},
    used_ports: [], error_count: 0, last_error: null, reported_at: new Date("2026-10-07T00:00:00.000Z") };
  seedForwards([{ id: 900, name: "relay-a", tunnel_mode: "relay", listen_port: 21001, remote_host: "10.0.0.5",
    remote_port: 8080, desired_status: "running", apply_status: "applied", config_revision: 3, applied_revision: 3,
    apply_error_code: null, apply_error: null, ingress_node_id: INGRESS_ID, egress_node_id: EGRESS_ID }]);
  const bundleRes = await status(await req("/1/support-bundle"), 200);
  const bundle = (await bundleRes.json()).data;
  expect(bundle.schema_version).toBe(1);
  expect(bundle.node.id).toBe(INGRESS_ID);
  expect(bundle.state_report.version).toBe("0.13.22");
  expect(bundle.forwards.length).toBe(1);
  expect(bundle.forwards[0].mode).toBe("relay");
  /* "没有"与"没取到"必须可区分：拿不到 agent 自述时给 error 对象 + 说明，而不是静默空值。 */
  expect(bundle.agent_facts ?? null).toBeNull();
  expect(typeof bundle.agent_facts_error.error_code).toBe("string");
  expect(bundle.notes.filter(function (n) { return n.indexOf("未包含节点自述事实") === 0; }).length).toBe(1);
  expect(JSON.stringify(bundle)).not.toContain(CREDENTIAL_HASH);
  /* 没有走到任何"被禁止"的写路径（读端点碰它们会抛错）。 */
  expect(writes).toEqual([]);
});
`;

/* ------------------------------------------------------------------ */
/* ② 恢复后的**回归面**：新端点没被遮蔽 + upgrade-state 仍可达            */
/* ------------------------------------------------------------------ */

const SCENARIO_COEXIST = String.raw`
await group("adjacent-literal-paths-coexist", 10, async () => {
  reset();

  /* 与恢复端点相邻的字面量子路径：全都要各自可达（catch-all 回归）。 */
  report = { node_id: INGRESS_ID, version: "0.13.22", role: "INGRESS", reported_at: new Date(), last_error: null };
  await status(await req("/1/upgrade-state"), 200);            /* 新端点仍在（没被这次恢复覆盖） */
  await status(await req("/1/support-bundle"), 200);
  await status(await req("/1/bindings"), 200);

  /* 非法 id ⇒ 400（各自的文案与 origin/main 逐字相同）。 */
  expect((await (await status(await req("/abc/bindings"), 400)).json()).error).toBe("入口节点 ID 不合法");
  expect((await (await status(await req("/abc/support-bundle"), 400)).json()).error).toBe("节点 ID 不合法");
  expect((await (await status(await req("/abc/bindings/2", { method: "DELETE" }), 400)).json()).error).toBe("节点 ID 不合法");
  expect((await (await status(await req("/1/bindings/abc", { method: "DELETE" }), 400)).json()).error).toBe("节点 ID 不合法");

  /* 跨 Workspace（不是该空间的活跃成员）⇒ 中间件先返回 404，且与"真不存在"同形：
   * 三个端点都不能在作用域判定之前就把资源细节漏出去。 */
  requestWorkspace = TEAM_WS;
  active = false;
  expect(await (await status(await req("/1/bindings"), 404)).text()).toBe("工作空间不存在");
  expect(await (await status(await req("/1/support-bundle"), 404)).text()).toBe("工作空间不存在");
  expect(await (await status(await req("/1/bindings/2", { method: "DELETE" }), 404)).text()).toBe("工作空间不存在");
  expect(bindingDeleteArgs.length).toBe(0);
  requestWorkspace = PERSONAL_WS; active = true;
});
`;

/* ------------------------------------------------------------------ */
/* ③ 参数拒绝分支（与 origin/main 逐字同形）                             */
/* ------------------------------------------------------------------ */

const SCENARIO_REJECTIONS = String.raw`
await group("restored-route-rejections", 12, async () => {
  reset();

  /* GET bindings：节点不存在 / 角色不具备入口能力。 */
  await status(await req("/999/bindings"), 404);
  nodes[0].role = "relay";               /* 既不是 ingress 也不是 both */
  await status(await req("/1/bindings"), 409);
  reset();

  /* POST bindings：体不合法 → 400（不是 500、也不是静默建一条）。 */
  await status(await req("/1/bindings", json({})), 400);
  await status(await req("/1/bindings", json({ egress_node_id: 0 })), 400);
  /* 出口不存在 / 同节点 / 角色不符。 */
  await status(await req("/1/bindings", json({ egress_node_id: 999 })), 404);
  await status(await req("/1/bindings", json({ egress_node_id: INGRESS_ID })), 409);
  nodes[0].role = "egress";
  await status(await req("/1/bindings", json({ egress_node_id: EGRESS_ID })), 409);
  nodes[0].role = "ingress";
  nodes[1].role = "ingress";
  await status(await req("/1/bindings", json({ egress_node_id: EGRESS_ID })), 409);
  reset();

  /* DELETE bindings：任一节点不在本空间 ⇒ 404，且**不**统计、**不**删。 */
  relayCount = 3;
  await status(await req("/1/bindings/999", { method: "DELETE" }), 404);
  expect(tunnelCountArgs.length).toBe(0);
  expect(bindingDeleteArgs.length).toBe(0);

  /* 入口节点不存在（自身）也必须先于任何统计。 */
  await status(await req("/999/bindings/2", { method: "DELETE" }), 404);

  /* DELETE 之后列表里真的没有了（幂等：再删一次仍 200）。 */
  relayCount = 0;
  await status(await req("/1/bindings/2", { method: "DELETE" }), 200);
  await status(await req("/1/bindings/2", { method: "DELETE" }), 200);
  expect(bindings.length).toBe(0);
});
`;

/* ------------------------------------------------------------------ */
/* ④ 解绑依赖闸门（usage = relay 计数）                                  */
/* ------------------------------------------------------------------ */

const SCENARIO_UNBIND_GATE = String.raw`
await group("unbind-dependency-gate", 4, async () => {
  reset();
  const { unbindBlockedMessage } = await import(root + "services/binding-usage.ts");

  /* >0 ⇒ 409 binding_in_use：文案与判定都来自 binding-usage.ts（单点），并回传使用量。 */
  relayCount = 3;
  const blocked = await status(await req("/1/bindings/" + EGRESS_ID, { method: "DELETE" }), 409);
  const blockedBody = await blocked.json();
  expect(blockedBody.code).toBe("binding_in_use");
  expect(blockedBody.error_layer).toBe("runtime_admission");
  expect(blockedBody.error).toBe(unbindBlockedMessage(3));
  expect(blockedBody.used_by_forward_count).toBe(3);
  expect(blockedBody.unbind_blocked).toBe(true);
  expect(writes).toEqual([]);                       /* 被闸门挡住 ⇒ 一个字节都没写 */
  expect(bindings.length).toBe(1);
  expect(tunnelCountArgs[0].where).toEqual({
    workspace_id: PERSONAL_WS, ingress_node_id: INGRESS_ID, egress_node_id: EGRESS_ID, tunnel_mode: "relay",
  });

  /* =0 ⇒ 放行；再验一次 count 的口径（只数 relay，不能把 DIRECT 算进来）。 */
  relayCount = 0;
  await status(await req("/1/bindings/" + EGRESS_ID, { method: "DELETE" }), 200);
  expect(bindingDeleteArgs.length).toBe(1);
  expect(tunnelCountArgs[1].where.tunnel_mode).toBe("relay");

  /* 只带 node:* 的自定义角色：能解绑、但**看不到**使用量（forward:read 被裁剪）——
   * 闸门仍然生效（409 是产品事实），只是不带 forward 明细。 */
  reset();
  relayCount = 2;
  asRole("member", { "node:read": true, "node:manage": true });
  const trimmed = await status(await req("/1/bindings/" + EGRESS_ID, { method: "DELETE" }), 409);
  const trimmedBody = await trimmed.json();
  expect(trimmedBody.code).toBe("binding_in_use");
  expect(trimmedBody.error).toBe("该绑定仍存在业务依赖，请由有转发权限的成员处理后再解绑");
  expect(Object.prototype.hasOwnProperty.call(trimmedBody, "used_by_forward_count")).toBe(false);
  const list = await status(await req("/1/bindings"), 200);
  const listBody = (await list.json()).data;
  expect(groupByArgs.length).toBe(0);               /* 没有 forward:read ⇒ 连 groupBy 都不该发生 */
  expect(listBody[0].usage_visible).toBe(false);
  expect(listBody[0].used_by_forward_count).toBeNull();
  expect(listBody[0].unbind_blocked).toBeNull();
  expect(listBody[0].usage).toBeNull();
});
`;

/* ------------------------------------------------------------------ */
/* ⑤ RBAC（真内核）+ support-bundle 段落裁剪                             */
/* ------------------------------------------------------------------ */

const SCENARIO_RBAC = String.raw`
await group("rbac-and-section-trimming", 7, async () => {
  reset();

  /* viewer：node:read 可读（GET），node:manage 不可写（POST/DELETE）。 */
  asRole("viewer");
  await status(await req("/1/bindings"), 200);
  await status(await req("/1/bindings", json({ egress_node_id: SECOND_EGRESS_ID })), 403);
  await status(await req("/1/bindings/2", { method: "DELETE" }), 403);

  /* base member 同样没有 node:manage（节点管理不继承转发权限）。 */
  asRole("member");
  await status(await req("/1/bindings", json({ egress_node_id: SECOND_EGRESS_ID })), 403);

  /* admin：node:manage 放行。 */
  asRole("admin");
  await status(await req("/1/bindings", json({ egress_node_id: SECOND_EGRESS_ID })), 201);

  /* support-bundle 段落裁剪：只带 node:read 的自定义角色拿不到转发明细，
   * 产物里必须**写明为什么没有**（而不是给一个空数组让人误以为"本来就没有"）。 */
  reset();
  report = { node_id: INGRESS_ID, version: "0.13.22", role: "INGRESS", control_protocol_version: 2,
    capabilities: [], reported_revision: null, known_revision: null, runtime_counts: null, host_metrics: null,
    used_ports: null, error_count: 0, last_error: null, reported_at: new Date() };
  seedForwards([{ id: 901, name: "relay-b", tunnel_mode: "relay" }]);
  asRole("member", { "node:read": true });
  const trimmedBundle = await status(await req("/1/support-bundle"), 200);
  const bundle = (await trimmedBundle.json()).data;
  expect(bundle.forwards).toEqual([]);
  expect(bundle.audit).toEqual([]);
  expect(bundle.notes).toContain("未包含转发明细：当前身份没有 forward:read");
  expect(bundle.notes).toContain("未包含审计记录：当前身份没有 audit:read");
  /* 转发明细那一段**根本没有发起查询**（不是"查了再过滤"）——作用域裁剪发生在取数之前。 */
  expect(tunnelFindManyArgs.filter(function (a) { return !!a.select.remote_host; }).length).toBe(0);
  const listed = await status(await req("/999/bindings"), 404);
  expect((await listed.json()).error).toBe("入口节点不存在");
});
`;

/* ------------------------------------------------------------------ */
/* 子进程执行器                                                        */
/* ------------------------------------------------------------------ */

function runScenario(scenario: string): string {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      PRELUDE + scenario +
        "\n/* 真实 redis/prisma 客户端会拖住事件循环：显式退出（沿用既有子进程用例）。 */\nprocess.exit(0);\n",
    ],
    {
      cwd: root,
      env: { ...process.env, TUNEX_NODES_RESTORE_ROOT: root },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw new Error(`子进程启动失败：${result.error.message}\n${output}`);
  if (result.status !== 0) throw new Error(`子进程退出码 ${result.status}\n${output}`);
  return output;
}

test("恢复的 binding / support-bundle 端点：契约、usage 投影、脱敏、只读", () => {
  const output = [
    runScenario(SCENARIO_CONTRACT),
    runScenario(SCENARIO_COEXIST),
    runScenario(SCENARIO_REJECTIONS),
    runScenario(SCENARIO_UNBIND_GATE),
    runScenario(SCENARIO_RBAC),
  ].join("\n");
  expect(output).toContain("GROUP restored-endpoints-contract=5");
  expect(output).toContain("GROUP adjacent-literal-paths-coexist=10");
  expect(output).toContain("GROUP restored-route-rejections=12");
  expect(output).toContain("GROUP unbind-dependency-gate=4");
  expect(output).toContain("GROUP rbac-and-section-trimming=7");
}, 300_000);

/**
 * 注册形态（静态面）：四个端点都必须是**字面量子路径**，且不能存在参数化的
 * `/:ingressId/:action` GET 兜底 —— 那正是会静默吃掉它们（并让 UI 404）的形态。
 * 同时钉住中间件的 (action, resource) 映射：`/bindings` 的 GET 是 `node:read`、
 * 其余方法是 `node:manage`（`update` 在本仓映射不到任何权限，等于人人都 403）。
 */
test("注册形态：恢复的端点是字面量子路径，且 bindings 的 RBAC 映射未被改动", () => {
  const raw = readFileSync(new URL("../nodes.ts", import.meta.url), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  expect(code).toMatch(/nodesRoutes\.get\(\s*"\/:ingressId\/support-bundle"/);
  expect(code).toMatch(/nodesRoutes\.get\(\s*"\/:ingressId\/bindings"/);
  expect(code).toMatch(/nodesRoutes\.post\(\s*"\/:ingressId\/bindings"/);
  expect(code).toMatch(/nodesRoutes\.delete\(\s*"\/:ingressId\/bindings\/:egressId"/);
  /* 新端点没被这次恢复覆盖掉。 */
  expect(code).toMatch(/nodesRoutes\.get\(\s*"\/:ingressId\/upgrade-state"/);
  expect(code).toMatch(/nodesRoutes\.patch\(\s*"\/:id"/);
  /* 没有参数化 GET 兜底会吃掉这些字面量子路径。 */
  expect(code).not.toMatch(/nodesRoutes\.get\(\s*"\/:ingressId\/:[A-Za-z]/);

  const bindingsBranch = code.slice(
    code.indexOf('path.includes("/bindings")'),
    code.indexOf('path.includes("/bindings")') + 200,
  );
  expect(bindingsBranch).toMatch(/method === "GET"\s*\?\s*"read"\s*:\s*"manage"/);
  expect(bindingsBranch).toContain('resource = "node"');
});
