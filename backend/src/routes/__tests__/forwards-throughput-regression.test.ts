/**
 * 缺陷 2 的**真实端点级**回归 —— `GET /api/forwards/:id/throughput` 的"今天"速率分母。
 *
 * ── 被修的是什么 ──
 * 分母起点原先写成 `billingDayKeyStamp(now)`。那个 helper 的名字里有"Day"，但它**不是**
 * 上海自然日的起点：它是**日标签的归档戳**（`YYYY-MM-DD` + `T00:00:00.000Z`），也就是
 * `tunnel_traffic.date` 的**存储**约定 —— 上海 08:00 才等于这个瞬时点（`billing-time.ts`
 * 的注释写得很清楚，另有 `billingDayStart` 才是当日上海 00:00）。
 *
 * 后果（分母错了，速率就错了，而速率是这一屏的唯一数字）：
 *   · 上海 08:00 **之前** `now - stamp` 为负 ⇒ 被 `Math.max(1, …)` 夹成 **1 秒**，
 *     早上的流量被放大成上千倍的假速率；
 *   · 08:00 之后只数到"当天已过的一部分"（例：12:00 得到 14400 秒而不是 43200 秒），
 *     同一份字节数据在上午显示为下午的数倍。
 *
 * ── 修法与边界（本文件钉的就是这条边界）──
 * **只**把分母换成 `billingDayStart(now)`（上海自然日 00:00）；日期查账的存储口径
 * （`todayKey` / `since` / 归档日键）**保持** `billingDayKeyStamp` 不变 —— 存量行的
 * `date` 全在 UTC 午夜，改口径需要一次全表回填，那是账本一致性问题。
 * 因此本文件同时断言两件事：分母是上海自然日已过秒数，`findMany.where.date.gte`
 * 仍是归档戳口径（用**字面量**时间戳断言，而不是"再调一次同一个 helper 比一比"）。
 *
 * ── 为什么必须打真实端点 ──
 * 分母是在路由里由 `new Date()` 现算的：只测纯函数就测不到"路由到底喂给分母哪个 helper"。
 * 所以这里挂**真实** `forwardsRoutes`，用 `app.request()` 真的打，并用 `setSystemTime`
 * 冻结时钟到指定上海时刻（07:00 / 12:00 / 日界 / 次日零点）。
 * 速率断言用 `Math.round(bytes / rate_bps)` 反推分母：`rate_bps` 是三位小数，反推能把
 * 分母钉在 ±3 秒内，足以区分 25200 / 43200 / 14400 / 1 这些候选值。
 *
 * 数据面替身只有 `db.ts`（`tunnel` + `tunnelTraffic`）与 `redis.ts`；**不**替身
 * `services/workspace.ts`（RBAC 用真内核）。整段跑在**子进程**里（`mock.module` 是进程级
 * 注册表，沿用 `forwards-latency-route.test.ts` / `nodes-route-restoration.test.ts` 的模式），
 * **零真实连接、零生产库**。
 *
 * 跑法（backend 目录）：bun test src/routes/__tests__/forwards-throughput-regression.test.ts
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = new URL("../..", import.meta.url).pathname;

const PRELUDE = String.raw`
import { mock, expect, setSystemTime } from "bun:test";
import { Hono } from "hono";
const root = process.env.TUNEX_THROUGHPUT_ROOT;

const WS = 3;
const OTHER_WS = 9;
const FORWARD_ID = 11;
const TODAY_SECONDS_MAX = 86400;

/* redis 替身：本端点不碰 redis；替身只为把子进程从"真实 ioredis 连接重试"里解放出来。 */
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

let role = "viewer", roleId = null, permissions = null, active = true;
let requestWorkspace = WS;
let tunnel = null;
let trafficRows = [];
const calls = [];
const trafficQueries = [];
const writes = [];

function forbid(name) {
  return async function () { writes.push(name); throw new Error("只读端点不得调用 " + name); };
}
function project(row, select) {
  const out = {};
  Object.keys(select).forEach(function (key) {
    if (select[key] === true) out[key] = row[key] === undefined ? null : row[key];
  });
  return out;
}
function asRole(base, perms) {
  role = base;
  roleId = perms === undefined ? null : 44;
  permissions = perms === undefined ? null : perms;
}
/* 归档行的存储口径：日标签 → 该标签在 **UTC 午夜**的瞬时点（= billingDayKeyStamp）。 */
function seedDay(label, bytes) {
  trafficRows.push({
    tunnel_id: FORWARD_ID, workspace_id: WS, date: new Date(label + "T00:00:00.000Z"), traffic: bytes,
  });
}
function reset() {
  role = "viewer"; roleId = null; permissions = null; active = true; requestWorkspace = WS;
  tunnel = { id: FORWARD_ID, workspace_id: WS, category: "port_forward" };
  trafficRows = [];
  calls.length = 0; trafficQueries.length = 0; writes.length = 0;
}

mock.module(root + "db.ts", () => ({ db: {
  /* 真权限内核要的两张表（本文件不替身 services/workspace.ts）。 */
  workspace: { findUnique: async function () { return { id: WS }; } },
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

  tunnel: {
    findFirst: async function (args) {
      calls.push("tunnel.findFirst");
      if (!tunnel || tunnel.id !== args.where.id) return null;
      if (tunnel.workspace_id !== args.where.workspace_id) return null;
      if (tunnel.category !== args.where.category) return null;
      return project(tunnel, args.select);
    },
    findMany: forbid("tunnel.findMany"),
    update: forbid("tunnel.update"), create: forbid("tunnel.create"), delete: forbid("tunnel.delete"),
    updateMany: forbid("tunnel.updateMany"), deleteMany: forbid("tunnel.deleteMany"),
  },

  tunnelTraffic: {
    findMany: async function (args) {
      calls.push("tunnelTraffic.findMany");
      trafficQueries.push(args);
      const since = args.where.date.gte.getTime();
      const rows = trafficRows
        .filter(function (row) {
          return row.tunnel_id === args.where.tunnel_id
            && row.workspace_id === args.where.workspace_id
            && row.date.getTime() >= since;
        })
        .sort(function (a, b) { return a.date.getTime() - b.date.getTime(); });
      return rows.map(function (row) { return project(row, args.select); });
    },
    create: forbid("tunnelTraffic.create"), createMany: forbid("tunnelTraffic.createMany"),
    update: forbid("tunnelTraffic.update"), deleteMany: forbid("tunnelTraffic.deleteMany"),
  },
} }));

const { forwardsRoutes } = await import(root + "routes/forwards.ts");

const app = new Hono();
app.use("*", async function (c, next) { c.set("user", { id: 1, super_admin: false }); await next(); });
app.route("/api/forwards", forwardsRoutes);

function req(path) {
  return app.request("/api/forwards" + path, { headers: { "x-workspace-id": String(requestWorkspace) } });
}
/* 冻结时钟到给定的上海时刻（路由里的 new Date() 会跟着走）。 */
function at(iso) { setSystemTime(new Date(iso)); }
async function throughput(days) {
  const res = await req("/" + FORWARD_ID + "/throughput?days=" + days);
  return res;
}
function pointFor(data, label) {
  return data.series.find(function (p) { return p.date === label; });
}
/* 速率分母（秒）：rate_bps = round(bytes / seconds * 1000) / 1000 ⇒ 反推把分母钉在 ±3 秒内。 */
function denominatorOf(point) {
  if (point.bytes === null || point.rate_bps === null) return null;
  return Math.round(point.bytes / point.rate_bps);
}
function isoOf(value) { return new Date(value).toISOString(); }

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
/* ① 上海自然日分母：07:00 / 12:00 / 日末 / 日界 / 零点后                */
/* ------------------------------------------------------------------ */

const SCENARIO_DENOMINATOR = String.raw`
await group("shanghai-natural-day-denominator", 5, async () => {
  /* ── ① 上海 07:00（本次缺陷最狠的一档：修前分母被夹成 1 秒）──
   * 期望：今天 25200 秒、昨天完整日 86400 秒。 */
  reset();
  seedDay("2026-10-06", 864000);      /* 昨天：864000 / 86400 = 10 bytes/s */
  seedDay("2026-10-07", 75600);       /* 今天：75600 / 25200 = 3 bytes/s */
  at("2026-10-07T07:00:00+08:00");
  let data = await (await status(await throughput(2), 200)).json();
  data = data.data;
  expect(data.series.map(function (p) { return p.date; })).toEqual(["2026-10-06", "2026-10-07"]);
  expect(data.archive.today_key).toBe("2026-10-07");
  expect(data.archive.today_incomplete).toBe(true);
  expect(data.window.time_zone).toBe("Asia/Shanghai");

  let today = pointFor(data, "2026-10-07");
  let yesterday = pointFor(data, "2026-10-06");
  expect(today.complete).toBe(false);
  expect(denominatorOf(today)).toBe(25200);          /* 07:00 ⇒ 7 * 3600 */
  expect(today.rate_bps).toBe(3);
  expect(yesterday.complete).toBe(true);
  expect(denominatorOf(yesterday)).toBe(86400);       /* 完整日仍是 86400 */
  expect(yesterday.rate_bps).toBe(10);
  /* 日期查账的**存储**口径没有变：日标签在 UTC 午夜的戳，days=2 ⇒ 昨天标签戳。 */
  expect(isoOf(trafficQueries[0].where.date.gte)).toBe("2026-10-06T00:00:00.000Z");

  /* ── ② 同一天、同样的字节，12:00 的分母必须是 43200（不是 14400，也不是 25200）── */
  reset();
  seedDay("2026-10-06", 864000);
  seedDay("2026-10-07", 75600);
  at("2026-10-07T12:00:00+08:00");
  data = (await (await status(await throughput(2), 200)).json()).data;
  today = pointFor(data, "2026-10-07");
  expect(denominatorOf(today)).toBe(43200);           /* 12:00 ⇒ 12 * 3600 */
  expect(today.rate_bps).toBe(1.75);                  /* 75600 / 43200 */
  /* 同一份字节在 07:00 是 3、12:00 是 1.75 —— 只有分母变了才对得上。 */
  expect(pointFor(data, "2026-10-06").rate_bps).toBe(10);

  /* ── ③ 日末一秒：分母 86399（永远不该达到/超过一个完整日）── */
  reset();
  seedDay("2026-10-06", 864000);
  seedDay("2026-10-07", 86399);
  at("2026-10-07T23:59:59+08:00");
  data = (await (await status(await throughput(2), 200)).json()).data;
  today = pointFor(data, "2026-10-07");
  expect(denominatorOf(today)).toBe(86399);
  expect(today.rate_bps).toBe(1);
  expect(denominatorOf(today)).toBeLessThanOrEqual(TODAY_SECONDS_MAX - 1);

  /* ── ④ 日界（恰在上海零点）：已过 0 秒被下界夹成 1（有意的，避免除以 0）；
   *     同时**昨天那一行立刻变成完整日 86400 秒**，今天换成新的日标签。 */
  reset();
  seedDay("2026-10-07", 86400);       /* 昨天的整天量：86400 / 86400 = 1 */
  seedDay("2026-10-08", 10);          /* 刚跨日：10 / 1 = 10 */
  at("2026-10-08T00:00:00+08:00");
  data = (await (await status(await throughput(2), 200)).json()).data;
  expect(data.archive.today_key).toBe("2026-10-08");
  expect(data.series.map(function (p) { return p.date; })).toEqual(["2026-10-07", "2026-10-08"]);
  expect(pointFor(data, "2026-10-07").complete).toBe(true);
  expect(denominatorOf(pointFor(data, "2026-10-07"))).toBe(86400);
  expect(pointFor(data, "2026-10-07").rate_bps).toBe(1);
  expect(pointFor(data, "2026-10-08").complete).toBe(false);
  expect(denominatorOf(pointFor(data, "2026-10-08"))).toBe(1);
  expect(isoOf(trafficQueries[0].where.date.gte)).toBe("2026-10-07T00:00:00.000Z");

  /* ── ⑤ 零点之后 30 秒：分母 30（不是"整天"、也不是日标签戳的负差）── */
  reset();
  seedDay("2026-10-08", 90);
  at("2026-10-08T00:00:30+08:00");
  data = (await (await status(await throughput(1), 200)).json()).data;
  expect(denominatorOf(pointFor(data, "2026-10-08"))).toBe(30);
  expect(pointFor(data, "2026-10-08").rate_bps).toBe(3);
  expect(writes).toEqual([]);          /* 全组只读：没有一次写路径 */
});
`;

/* ------------------------------------------------------------------ */
/* ② 缺口保留为 null（不是 0）+ 窗口与作用域                              */
/* ------------------------------------------------------------------ */

const SCENARIO_GAP_AND_SCOPE = String.raw`
await group("gap-is-null-and-scope", 6, async () => {
  reset();
  seedDay("2026-10-05", 86400);
  seedDay("2026-10-07", 86400);
  at("2026-10-07T12:00:00+08:00");
  let data = (await (await status(await throughput(3), 200)).json()).data;
  expect(data.series.map(function (p) { return p.date; })).toEqual(["2026-10-05", "2026-10-06", "2026-10-07"]);
  /* 中间那天没有归档行 ⇒ null（缺口看得见），**不是** 0（测到的零）。 */
  expect(pointFor(data, "2026-10-06").bytes).toBeNull();
  expect(pointFor(data, "2026-10-06").rate_bps).toBeNull();
  expect(pointFor(data, "2026-10-05").bytes).toBe(86400);
  expect(data.summary.coverage).toEqual({ days_with_data: 2, days_missing: 1 });
  expect(data.summary.total_bytes).toBe(172800);
  expect(data.granularity).toBe("day");
  expect(data.unit).toBe("bytes_per_second");

  /* 窗口钳制：days 超上限 90 被钳到 90（不静默截短、也不报错）。 */
  data = (await (await status(await throughput(1000), 200)).json()).data;
  expect(data.series.length).toBe(90);
  expect(data.limits.max_days).toBe(90);
  /* 非法 days ⇒ 回落默认 14。 */
  data = (await (await status(await throughput("abc"), 200)).json()).data;
  expect(data.series.length).toBe(14);

  /* 作用域与权限：非法 id 400；跨 Workspace / 真不存在逐字同形 404。 */
  expect((await (await status(await req("/abc/throughput"), 400)).json()).code).toBe("invalid_input");
  const missing = await status(await req("/999/throughput"), 404);
  const missingBody = await missing.json();
  expect(missingBody.code).toBe("not_found");
  expect(missingBody.error_layer).toBe("resource_scope");
  active = false; requestWorkspace = OTHER_WS;
  await status(await req("/" + FORWARD_ID + "/throughput"), 404);
  active = true; requestWorkspace = WS;
  expect(writes).toEqual([]);
});
`;

/* ------------------------------------------------------------------ */
/* ③ RBAC：forward:read 才看得到吞吐（真内核）                          */
/* ------------------------------------------------------------------ */

const SCENARIO_RBAC = String.raw`
await group("throughput-requires-forward-read", 3, async () => {
  reset();
  seedDay("2026-10-07", 86400);
  at("2026-10-07T12:00:00+08:00");

  /* viewer：有 forward:read ⇒ 可读。 */
  asRole("viewer");
  await status(await req("/" + FORWARD_ID + "/throughput"), 200);

  /* 只带 node:* 的自定义角色：能在节点屏干活，但看不到转发的吞吐结论。 */
  asRole("member", { "node:read": true, "node:manage": true });
  await status(await req("/" + FORWARD_ID + "/throughput"), 403);

  /* 被拒绝时**不得**先读账本（作用域/权限先于取数）。 */
  reset();
  seedDay("2026-10-07", 86400);
  asRole("member", { "node:read": true });
  const denied = await status(await req("/" + FORWARD_ID + "/throughput"), 403);
  const body = await denied.json();
  expect(body.code).toBe("permission_denied");
  expect(body.error_layer).toBe("rbac");
  expect(trafficQueries.length).toBe(0);
  expect(writes).toEqual([]);
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
      env: { ...process.env, TUNEX_THROUGHPUT_ROOT: root },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw new Error(`子进程启动失败：${result.error.message}\n${output}`);
  if (result.status !== 0) throw new Error(`子进程退出码 ${result.status}\n${output}`);
  return output;
}

test("吞吐分母：上海自然日已过秒数（07:00=25200 / 12:00=43200 / 日末 86399 / 日界夹 1），存储口径不变", () => {
  const output = [
    runScenario(SCENARIO_DENOMINATOR),
    runScenario(SCENARIO_GAP_AND_SCOPE),
    runScenario(SCENARIO_RBAC),
  ].join("\n");
  expect(output).toContain("GROUP shanghai-natural-day-denominator=5");
  expect(output).toContain("GROUP gap-is-null-and-scope=6");
  expect(output).toContain("GROUP throughput-requires-forward-read=3");
}, 300_000);

/**
 * 静态面：分母必须来自 `billingDayStart`，且**只**用在这一处；
 * `todayKey` / `since` / 归档日键仍旧用 `billingDayKeyStamp`（存储口径）。
 * 纯动态断言证明不了"另一个 helper 没被顺手换掉"，这条钉住分寸。
 */
test("静态：分母用 billingDayStart，日期查账仍用 billingDayKeyStamp", () => {
  const raw = readFileSync(new URL("../forwards.ts", import.meta.url), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  expect(code).toMatch(/import\s*\{[^}]*billingDayStart[^}]*\}\s*from\s*"\.\.\/services\/billing-time\.ts"/);
  /* 分母：now - 上海日首；不允许再出现 `now - billingDayKeyStamp(now)` 这种差。 */
  expect(code).toMatch(/now\.getTime\(\)\s*-\s*billingDayStart\(now\)\.getTime\(\)/);
  expect(code).not.toMatch(/now\.getTime\(\)\s*-\s*billingDayKeyStamp\(now\)\.getTime\(\)/);
  /* 存储口径仍在：日标签与查询下界都来自归档戳。 */
  expect(code).toMatch(/dayKeyOf\(billingDayKeyStamp\(now\)\)/);
  expect(code).toMatch(/billingDayKeyStamp\(now\)\.getTime\(\)\s*-\s*\(days - 1\) \* 86_400_000/);
  /* 完整日仍然是 86400（分母常量没被顺手改掉）。 */
  expect(code).toMatch(/complete \? 86_400 : elapsedTodaySeconds/);
});
