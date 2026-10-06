/**
 * V5-WP17.3 —— `/api/forwards/:id/dns` 的**路由级契约**（G12 回归保护 + G2/G3 读投影）。
 *
 * 为什么必须有这个文件：`services/__tests__/ddns-binding.test.ts` 测的是服务层的"绑定落库"，
 * 它**不挂 Hono**，所以既证明不了这条路由可达，也证明不了权限接线。而这条路由恰恰有过一次
 * 真实事故：`POST /api/forwards/:id/dns` 曾被注册在 `post("/:id/:action")` catch-all **之后**，
 * 于是绑定直接返回 400「不支持的端口转发动作」——而当时 38 条服务层断言全绿
 * （见 `routes/forwards.ts` 里 DNS 区块上方那段实测注释）。
 *
 * ── 为什么整段跑在**子进程**里（沿用 workspace-rbac.test.ts 的同一模式）──
 * 本文件要钉的是"真实 `forwards.ts` + 真实权限内核"的行为。路由模块顶层的
 * `import { resolveWorkspaceAccess, canWorkspaceResourceAction } from "../services/workspace.ts"`
 * 是**模块作用域绑定**，而 Bun 的 `mock.module` 是**进程级**注册表：同进程里只要更早的测试文件
 * （`forward-list-route.test.ts` / `forward-route-topology.test.ts` / `ddns-provider-route.test.ts`）
 * 替换过 `workspace.ts`，本文件就可能解析到**别人的替身**。这不是理论：本文件第一版就是进程内
 * mock —— 单跑 28/28 绿，`bun test src` 全量里却红 3 条：全量时
 * `canWorkspaceResourceAction` 被解析成了另一个文件的 `(access) => access.role === "owner"`
 * （于是 viewer 读也 403、member 改自己的也被拒），而 `resolveWorkspaceAccess` 却是本文件的替身
 * （于是"被拒"那条又拿到了别人的错误体，连 JSON 都不是）。
 *
 * 修法就是本仓库对同类问题的既有结论（见 workspace-rbac.test.ts 顶部注释）：**换一个干净的模块
 * 注册表**。子进程里只 mock `db.ts`（数据面），`workspace.ts` 用真实现 —— 于是这里断言的是产品
 * 权限内核本身（viewer 只读、member 的 creator 守卫、自定义角色的替换语义），而不是替身的语义。
 *
 * 覆盖：
 *   ① 权限接线：读 = `forward:read`；POST = `forward:update`；被拒时请求到不了处理器；
 *   ② 作用域：跨 Workspace ⇒ 404，且与"真不存在"**逐字同形**（不泄露存在性）；
 *   ③ 平台级 provider 的既有 403 语义 + 平台管理员放行；
 *   ④ 绑定成功**只能**是 `pending`（绝不自称已同步），响应不含任何凭据字段；
 *   ⑤ 未绑定与"绑定存在"的 GET 形状可区分；
 *   ⑥ 未知字段 ⇒ 400（载荷封闭）；
 *   ⑦ `POST/GET/DELETE /:id/dns` **没有**被 `/:id/:action` catch-all 吃掉（回归保护）；
 *   ⑧ 三个新读投影字段的真实取值（有退避 / 无退避 / 开关关着 / 解绑后作废）；
 *   ⑨ `GET` 零副作用（不写库）。
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

/** backend/src/（子进程的 import 前缀与 cwd 都与 workspace-rbac.test.ts 保持一致）。 */
const root = new URL("../..", import.meta.url).pathname;

/* ------------------------------------------------------------------ */
/* 子进程前置：数据面替身 + 真实路由 + 真实权限内核                        */
/* ------------------------------------------------------------------ */

const PRELUDE = String.raw`
import { mock, expect } from "bun:test";
import { Hono } from "hono";
const root = process.env.TUNEX_DNS_ROOT;

/* ── 可变状态（每个场景开头 reset()） ── */
const SEALED = "v1.SEALED-CREDENTIAL-tok_live_must-never-appear";
const OWN_IP = "203.0.113.10";
const WS = 3;
let role = "owner";
let roleId = null;
let permissions = null;
let active = true;
let superAdmin = false;
let requestWorkspace = WS;
let node = { id: 4, connect_ip: OWN_IP, node_group_id: 2 };
let provider = null;
let tunnel = null;
const findFirstCalls = [];
const updateCalls = [];

function baseRow(over) {
  return Object.assign({
    id: 11, workspace_id: WS, category: "port_forward", user_id: 1, ingress_node_id: 4,
    dns_domain: null, dns_record_type: null, dns_mode: null, dns_provider_id: null,
    dns_confirmed_values: [], dns_synced_at: null, dns_verified: false, dns_last_error: null,
    dns_auto_resolve: false, dns_attempt_count: 0, dns_next_attempt_at: null,
    ingress_node: { connect_ip: OWN_IP },
    /* 只为了证明"没被 select 就绝不出现"是可断言的属性：封存凭据就挂在行上。 */
    dns_provider: { config: SEALED },
  }, over || {});
}
function reset() {
  role = "owner"; roleId = null; permissions = null; active = true; superAdmin = false;
  requestWorkspace = WS;
  node = { id: 4, connect_ip: OWN_IP, node_group_id: 2 };
  provider = { id: 5, workspace_id: WS, config: SEALED };
  tunnel = baseRow({});
  findFirstCalls.length = 0; updateCalls.length = 0;
}
function seed(over) { tunnel = over === null ? null : baseRow(over); }
/* 基础角色 / 自定义角色（自定义角色是**替换**语义，不会回落到基础角色）。 */
function asRole(base, perms) {
  role = base;
  roleId = perms === undefined ? null : 44;
  permissions = perms === undefined ? null : perms;
}

/* 与 Prisma 一致：undefined 的 where 键不构成条件，其余等值匹配。 */
function matches(row, where) {
  return Object.keys(where).every(function (k) { return where[k] === undefined || row[k] === where[k]; });
}
/* 按 select 投影（true = 该列；{select} = 关系）：没被 select 的键不会出现在返回值里。 */
function project(row, select) {
  const out = {};
  Object.keys(select).forEach(function (key) {
    const value = select[key];
    if (value === true) out[key] = row[key] === undefined ? null : row[key];
    else if (value !== null && typeof value === "object" && "select" in value) {
      const rel = row[key];
      out[key] = rel === null || rel === undefined ? null : project(rel, value.select);
    }
  });
  return out;
}

mock.module(root + "db.ts", () => ({ db: {
  workspace: { findUnique: async () => ({ id: 1 }) },
  workspaceMember: { findUnique: async (args) => {
    const w = args.where.workspace_id_user_id;
    if (!active || w.workspace_id !== WS || w.user_id !== 1) return null;
    return {
      id: 70, workspace_id: WS, user_id: 1, role: role, active: true, role_id: roleId,
      custom_role: roleId === null || permissions === null
        ? null
        : { id: roleId, workspace_id: WS, permissions: permissions },
      workspace: { id: WS, kind: "personal" },
    };
  } },
  tunnel: {
    findFirst: async (args) => {
      findFirstCalls.push(args.where);
      if (!tunnel || !matches(tunnel, args.where)) return null;
      return project(tunnel, args.select);
    },
    update: async (args) => {
      updateCalls.push(args);
      if (!tunnel || tunnel.id !== args.where.id) throw new Error("P2025");
      tunnel = Object.assign({}, tunnel, args.data);
      return project(tunnel, args.select);
    },
  },
  node: { findUnique: async () => node },
  dNSProvider: { findFirst: async () => provider },
  nodeGroupGrant: { findFirst: async () => null },
} }));

const { forwardsRoutes } = await import(root + "routes/forwards.ts");
const app = new Hono();
app.use("*", async (c, next) => { c.set("user", { id: 1, super_admin: superAdmin }); await next(); });
app.route("/api/forwards", forwardsRoutes);

const DNS = "/api/forwards/11/dns";
let checks = 0;
function req(path, method, body) {
  const init = {
    method: method || "GET",
    headers: { "x-workspace-id": String(requestWorkspace), "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}
async function status(res, want) { expect(res.status).toBe(want); checks = checks + 1; return res; }
async function body(res) { return await res.json(); }
const VALID_BIND = { domain: "Edge.Example.com.", record_type: "A", mode: "single_active", provider_id: 5, auto_resolve: true };
const VIEW_KEYS = ["state","domain","record_type","mode","provider_id","expected_values","confirmed_values","synced_at","verified","last_error","auto_resolve","attempt_count","next_attempt_at"].sort();
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
        "\nconsole.log('DNS ROUTE CHECKS:', checks);\n/* 真实 redis 客户端会拖住事件循环：显式退出，否则 spawnSync 只能等超时。 */\nprocess.exit(0);\n",
    ],
    {
      cwd: root,
      env: { ...process.env, TUNEX_DNS_ROOT: root },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  expect(result.error).toBeUndefined();
  if (result.status !== 0) throw new Error(result.stdout + "\n" + result.stderr);
  expect(result.stdout).toContain("DNS ROUTE CHECKS:");
  return result.stdout;
}

/**
 * 每组场景都要求检查计数**恰好**等于写死的数字。
 *
 * 两条护栏互补：子进程里 `expect` 失败会**抛出**（进程非 0 ⇒ `runScenario` 抛，错误原文带上子进程的
 * 行号与期望值），而计数相等能挡住"某条断言被注释掉 / 被条件跳过 / 提前 return"这一类静默失效
 * ——只断言"通过"的话，一个空场景也是绿的。
 */
function runExactly(scenario: string, expectedChecks: number): string {
  const stdout = runScenario(scenario);
  const matched = /DNS ROUTE CHECKS: (\d+)/.exec(stdout);
  expect(Number(matched?.[1] ?? 0)).toBe(expectedChecks);
  return stdout;
}

/* ------------------------------------------------------------------ */
/* ① 权限接线 + creator 守卫（真实权限内核）                             */
/* ------------------------------------------------------------------ */

test("权限接线：读=forward:read；POST=forward:update；viewer 只读；被拒不改库", async () => {
  runExactly(`
reset();
/* owner：三件事都做得了。 */
await status(await req(DNS, "GET"), 200);
await status(await req(DNS, "POST", VALID_BIND), 200);
await status(await req(DNS, "DELETE"), 200);

/* 基础 viewer：读得了，写一律 403（且被拒时请求到不了处理器）。 */
reset();
asRole("viewer");
await status(await req(DNS, "GET"), 200);
const deniedWrite = await status(await req(DNS, "POST", VALID_BIND), 403);
const deniedBody = await body(deniedWrite);
expect(deniedBody.code).toBe("permission_denied");
expect(deniedBody.error_layer).toBe("rbac");
expect((await body(await status(await req(DNS, "DELETE"), 403))).code).toBe("permission_denied");
/* 被拒时请求到不了处理器：唯一的读库来自那次**被允许的** GET，两次写没有增加任何调用。 */
expect(findFirstCalls.length).toBe(1);
expect(updateCalls.length).toBe(0);

/* 自定义角色只给 forward:read ⇒ 读得到、写不了（替换语义，不回落到基础角色）。 */
reset();
asRole("viewer", { "forward:read": true });
await status(await req(DNS, "GET"), 200);
await status(await req(DNS, "POST", VALID_BIND), 403);
expect(updateCalls.length).toBe(0);

/* 自定义角色给 forward:read + forward:update ⇒ POST 通了（POST 走的就是 update）。 */
reset();
asRole("viewer", { "forward:read": true, "forward:update": true });
await status(await req(DNS, "POST", VALID_BIND), 200);

/* 但 DELETE 还要过中间件的 forward:delete（中间件按**方法**分类）—— 既有形状，记录在案。 */
reset();
asRole("viewer", { "forward:read": true, "forward:update": true });
await status(await req(DNS, "DELETE"), 403);

/* 两把权限都给才解得开（中间件要 delete，处理器要 update）。 */
reset();
asRole("viewer", { "forward:read": true, "forward:update": true, "forward:delete": true });
await status(await req(DNS, "DELETE"), 200);
`, 11);
}, 30_000);

test("creator 守卫：基础 member 只能改自己创建的转发；读是工作空间级的", async () => {
  runExactly(`
/* 读：member 能看到本 workspace 里别人的转发（读不受 creator 限制）。 */
reset();
asRole("member");
seed({ user_id: 99 });
await status(await req(DNS, "GET"), 200);

/* 写：别人的转发 ⇒ 403（creator 守卫在处理器里兜底）。 */
reset();
asRole("member");
seed({ user_id: 99 });
const foreignBody = await body(await status(await req(DNS, "POST", VALID_BIND), 403));
expect(foreignBody.code).toBe("forbidden");
expect(foreignBody.error_layer).toBe("rbac");
expect(updateCalls.length).toBe(0);

/* 写：自己的转发 ⇒ 放行；解绑也放行（member+delete 预筛 + 处理器的 creator 证明）。 */
reset();
asRole("member");
seed({ user_id: 1 });
await status(await req(DNS, "POST", VALID_BIND), 200);
expect(updateCalls.length).toBe(1);
await status(await req(DNS, "DELETE"), 200);
`, 4);
}, 30_000);

/* ------------------------------------------------------------------ */
/* ② 作用域：跨 Workspace 一律 404，不泄露存在性                          */
/* ------------------------------------------------------------------ */

test("作用域：跨 Workspace 与「不存在」逐字同形；workspace 本身也要有成员资格", async () => {
  runExactly(`
/* GET：owner 下，行在别的 workspace 与行不存在必须给出同一个响应体。 */
reset();
tunnel = null;
const missingGetBody = await body(await status(await req(DNS, "GET"), 404));
seed({ workspace_id: WS + 6 });
const foreignGet = await status(await req(DNS, "GET"), 404);
expect(await body(foreignGet)).toEqual(missingGetBody);
expect(missingGetBody.code).toBe("not_found");

/* POST：同样 404（服务层兜底），两个响应体也必须一致。 */
reset();
tunnel = null;
const missingPost = await body(await status(await req(DNS, "POST", VALID_BIND), 404));
seed({ workspace_id: WS + 6 });
const foreignPost = await body(await status(await req(DNS, "POST", VALID_BIND), 404));
expect(foreignPost).toEqual(missingPost);
expect(["not_found", "ddns_not_found"]).toContain(foreignPost.code);
expect(updateCalls.length).toBe(0);

/* POST：member 走 creator 查询那条路径，同样是 404（错误层不同、状态码与"不存在"一致）。 */
reset();
asRole("member");
seed({ workspace_id: WS + 6 });
expect((await body(await status(await req(DNS, "POST", VALID_BIND), 404))).code).toBe("not_found");
expect(updateCalls.length).toBe(0);

/* workspace 本身也要有成员资格：换个没加入的 workspace ⇒ 404，且没碰转发数据。 */
reset();
requestWorkspace = WS + 6;
await status(await req(DNS, "GET"), 404);
expect(findFirstCalls.length).toBe(0);
`, 6);
}, 30_000);

/* ------------------------------------------------------------------ */
/* ③④⑥ 平台级 provider / 绑定响应契约 / 载荷封闭                         */
/* ------------------------------------------------------------------ */

test("平台级 provider 的 403 语义不变；绑定成功只能是 pending 且不含凭据", async () => {
  runExactly(`
/* 非平台管理员用平台级 provider（workspace_id NULL）⇒ 403。 */
reset();
provider = { id: 5, workspace_id: null, config: SEALED };
const forbiddenBody = await body(await status(await req(DNS, "POST", VALID_BIND), 403));
expect(forbiddenBody.code).toBe("dns_provider_forbidden");
expect(forbiddenBody.error_layer).toBe("ddns");
expect(updateCalls.length).toBe(0);
/* 403 的响应体里也不得出现平台凭据（连封存态都不行）。 */
expect(JSON.stringify(forbiddenBody).indexOf("SEALED")).toBe(-1);

/* 平台管理员 ⇒ 放行，但绑定仍然是 pending。 */
reset();
superAdmin = true;
provider = { id: 5, workspace_id: null, config: SEALED };
const adminBody = await body(await status(await req(DNS, "POST", VALID_BIND), 200));
expect(adminBody.data.state).toBe("pending");

/* 改绑：先造一个"已同步"的旧状态，绑定必须把它打回未确认。 */
reset();
seed({
  dns_domain: "old.example.com", dns_record_type: "A", dns_mode: "single_active", dns_provider_id: 5,
  dns_synced_at: new Date("2026-10-06T00:00:00Z"), dns_verified: true, dns_confirmed_values: [OWN_IP],
});
const bound = await body(await status(await req(DNS, "POST", VALID_BIND), 200));
expect(bound.data.state).toBe("pending");
expect(bound.data.state).not.toBe("synced");
expect(bound.data.verified).toBe(false);
expect(bound.data.synced_at).toBeNull();
expect(bound.data.confirmed_values).toEqual([]);
expect(bound.data.auto_resolve).toBe(true);
expect(bound.data.attempt_count).toBe(0);
expect(bound.data.next_attempt_at).toBeNull();
/* 落库口径与响应一致，且读投影三列都在 update 的 select 里（否则响应永远是 false/0）。 */
const call = updateCalls[0];
expect(call.data.dns_synced_at).toBeNull();
expect(call.data.dns_verified).toBe(false);
expect(call.data.dns_confirmed_values).toEqual([]);
expect(call.data.dns_auto_resolve).toBe(true);
expect(call.select.dns_auto_resolve).toBe(true);
expect(call.select.dns_attempt_count).toBe(true);
expect(call.select.dns_next_attempt_at).toBe(true);

/* 凭据不会出现：前提是它**确实挂在行上**。 */
expect(tunnel.dns_provider.config).toBe(SEALED);
const raw = JSON.stringify(bound);
expect(raw.indexOf("SEALED")).toBe(-1);
expect(raw.indexOf("token")).toBe(-1);
expect(raw.indexOf("config")).toBe(-1);
expect(Object.keys(bound.data).sort()).toEqual(VIEW_KEYS);
expect(Object.keys(bound.data)).not.toContain("workspace_id");
expect(Object.keys(bound.data)).not.toContain("user_id");

/* 未显式开开关时落库 false（省略字段不能蒙成 true）。 */
reset();
const noSwitch = { domain: VALID_BIND.domain, record_type: VALID_BIND.record_type, mode: VALID_BIND.mode, provider_id: 5 };
const off = await body(await status(await req(DNS, "POST", noSwitch), 200));
expect(off.data.auto_resolve).toBe(false);
expect(updateCalls[0].data.dns_auto_resolve).toBe(false);

/* 载荷封闭：未知字段 / 枚举 / 布尔形状一律 400，且不碰数据库。 */
reset();
const unknownField = await status(await req(DNS, "POST", Object.assign({}, VALID_BIND, { ttl: 300 })), 400);
expect((await body(unknownField)).code).toBe("invalid_input");
await status(await req(DNS, "POST", Object.assign({}, VALID_BIND, { record_type: "TXT" })), 400);
await status(await req(DNS, "POST", Object.assign({}, VALID_BIND, { mode: "whatever" })), 400);
await status(await req(DNS, "POST", Object.assign({}, VALID_BIND, { auto_resolve: "yes" })), 400);
expect(updateCalls.length).toBe(0);
expect(findFirstCalls.length).toBe(0);
`, 8);
}, 30_000);

/* ------------------------------------------------------------------ */
/* ⑤⑨ GET 形状 / 零副作用                                              */
/* ------------------------------------------------------------------ */

test("未绑定与已绑定的 GET 形状可区分；GET 是纯读", async () => {
  runExactly(`
/* 未绑定。 */
reset();
const unbound = await body(await status(await req(DNS, "GET"), 200));
expect(unbound.data.state).toBe("unbound");
expect(unbound.data.domain).toBeNull();
expect(unbound.data.record_type).toBeNull();
expect(unbound.data.mode).toBeNull();
expect(unbound.data.provider_id).toBeNull();
expect(unbound.data.last_error).toBeNull();
expect(unbound.data.auto_resolve).toBe(false);
/* 未绑定 ⇒ 执行器第一个分支就 noop：历史退避不构成任何可执行事实，投影必须是 null。 */
expect(unbound.data.attempt_count).toBeNull();
expect(unbound.data.next_attempt_at).toBeNull();
/* 既有行为（本任务未改动）：expected_values 是"当前 owner 的地址"，与是否已绑定无关；
   界面判断"有没有前门"必须看 state/domain。 */
expect(unbound.data.expected_values).toEqual([OWN_IP]);
expect(Object.keys(unbound.data).sort()).toEqual(VIEW_KEYS);
/* 纯读：一次 findFirst（owner 不需要 creator 查询），零写库。 */
expect(findFirstCalls.length).toBe(1);
expect(updateCalls.length).toBe(0);

/* 绑定存在：同形，但 state/domain/provider 都有值 ⇒ 两者可分。 */
reset();
seed({ dns_domain: "edge.example.com", dns_record_type: "A", dns_mode: "single_active", dns_provider_id: 5 });
const boundRow = await body(await status(await req(DNS, "GET"), 200));
expect(boundRow.data.state).toBe("pending");
expect(boundRow.data.domain).toBe("edge.example.com");
expect(boundRow.data.record_type).toBe("A");
expect(boundRow.data.mode).toBe("single_active");
expect(boundRow.data.provider_id).toBe(5);
expect(boundRow.data.expected_values).toEqual([OWN_IP]);
expect(Object.keys(boundRow.data).sort()).toEqual(VIEW_KEYS);
expect(updateCalls.length).toBe(0);

/* 入口没有 connect_ip ⇒ 期望值集为空（不猜地址），但绑定状态照实呈现。 */
reset();
seed({ dns_domain: "edge.example.com", dns_record_type: "A", dns_mode: "single_active", dns_provider_id: 5, ingress_node: { connect_ip: null } });
const noIp = await body(await status(await req(DNS, "GET"), 200));
expect(noIp.data.expected_values).toEqual([]);
expect(noIp.data.state).toBe("pending");

/* 非法 id 在权限之后被拒（400），不读库。 */
reset();
await status(await req("/api/forwards/abc/dns", "GET"), 400);
expect(findFirstCalls.length).toBe(0);
`, 4);
}, 30_000);

/* ------------------------------------------------------------------ */
/* ⑦⑧ 路由顺序回归 + 新字段真实取值                                      */
/* ------------------------------------------------------------------ */

test("回归保护：DNS 子路由没被 /:id/:action 吃掉；三个新字段的真实取值", async () => {
  runExactly(`
/* ⑦ POST /:id/dns 真的落到 DNS 处理器（而不是 400「不支持的端口转发动作」）。 */
reset();
const post = await body(await status(await req(DNS, "POST", VALID_BIND), 200));
expect(post.data.state).toBe("pending");
expect(post.error).toBeUndefined();
/* ⑦ GET /:id/dns 落到 DNS 处理器（不是 GET /:id 的转发视图）。 */
const got = await body(await status(await req(DNS, "GET"), 200));
expect("state" in got.data).toBe(true);
expect("name" in got.data).toBe(false);
/* ⑦ DELETE /:id/dns 落到解绑（不是 DELETE /:id 的删转发）。 */
await status(await req(DNS, "DELETE"), 200);
expect(tunnel.id).toBe(11);
/* 对照组：catch-all 仍然存在且可达（未知 action ⇒ 400）。 */
const catchAll = await status(await req("/api/forwards/11/not-an-action", "POST"), 400);
expect((await body(catchAll)).error).toBe("不支持的端口转发动作");

/* ⑧ 有退避：attempt_count 有值 + next_attempt_at 是 ISO 时刻 ⇒ 「将于 X 重试」。 */
const at = new Date("2026-10-07T00:10:00.000Z");
reset();
seed({ dns_domain: "edge.example.com", dns_record_type: "A", dns_mode: "single_active", dns_provider_id: 5,
  dns_auto_resolve: true, dns_last_error: "provider 限流", dns_attempt_count: 3, dns_next_attempt_at: at });
const backoff = await body(await status(await req(DNS, "GET"), 200));
expect(backoff.data.state).toBe("error");
expect(backoff.data.auto_resolve).toBe(true);
expect(backoff.data.attempt_count).toBe(3);
expect(backoff.data.next_attempt_at).toBe(at.toISOString());
expect(backoff.data.last_error).toBe("provider 限流");

/* ⑧ 不可重试：计数有值、next_attempt_at 是 null（不是 0 / 空串）⇒ 「不会自动重试」。 */
reset();
seed({ dns_domain: "edge.example.com", dns_record_type: "A", dns_mode: "single_active", dns_provider_id: 5,
  dns_auto_resolve: true, dns_last_error: "域名不在该 zone 下", dns_attempt_count: 1, dns_next_attempt_at: null });
const noRetry = await body(await status(await req(DNS, "GET"), 200));
expect(noRetry.data.next_attempt_at).toBeNull();
expect(noRetry.data.attempt_count).toBe(1);

/* ⑧ 开关关着：列上有退避时刻也不代表会自动重试（执行器在开关为 false 时零外呼）。 */
reset();
seed({ dns_domain: "edge.example.com", dns_record_type: "A", dns_mode: "single_active", dns_provider_id: 5,
  dns_auto_resolve: false, dns_last_error: "provider 限流", dns_attempt_count: 2, dns_next_attempt_at: at });
const offSwitch = await body(await status(await req(DNS, "GET"), 200));
expect(offSwitch.data.auto_resolve).toBe(false);
expect(offSwitch.data.next_attempt_at).toBe(at.toISOString());

/* ⑧ 同步成功后清零：attempt_count 0 且 next_attempt_at null（不是 0 时刻）。 */
reset();
seed({ dns_domain: "edge.example.com", dns_record_type: "A", dns_mode: "single_active", dns_provider_id: 5,
  dns_auto_resolve: true, dns_synced_at: new Date("2026-10-07T00:00:00.000Z"), dns_verified: true });
const synced = await body(await status(await req(DNS, "GET"), 200));
expect(synced.data.state).toBe("synced");
expect(synced.data.attempt_count).toBe(0);
expect(synced.data.next_attempt_at).toBeNull();

/* ⑧ 解绑后：历史退避一律投影成 null、开关归 false。 */
reset();
seed({ dns_domain: "edge.example.com", dns_record_type: "A", dns_mode: "single_active", dns_provider_id: 5,
  dns_auto_resolve: true, dns_last_error: "provider 限流", dns_attempt_count: 4, dns_next_attempt_at: at });
const unbound = await body(await status(await req(DNS, "DELETE"), 200));
expect(unbound.data.state).toBe("unbound");
expect(unbound.data.auto_resolve).toBe(false);
expect(unbound.data.attempt_count).toBeNull();
expect(unbound.data.next_attempt_at).toBeNull();
`, 9);
}, 30_000);
