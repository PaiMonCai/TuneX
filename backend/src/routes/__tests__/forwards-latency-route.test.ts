/**
 * D6 —— `GET /api/forwards/:id/latency` 的**路由级契约**。
 *
 * 为什么必须有这个文件：`services/latency-history.ts` 的读函数有测试，但它**没有任何读
 * 路由**（R3-B 的结论：`readLatencySeries` 无 consumer）。最近一次同类事故是 DNS 前门：
 * `POST /api/forwards/:id/dns` 被注册在 `post("/:id/:action")` catch-all **之后**，
 * 于是真实 API 上绑定直接 400「不支持的端口转发动作」，而当时 38 条服务层断言全绿。
 * 所以这里挂**真实** `forwardsRoutes`，用 `app.request()` 真的打。
 *
 * 覆盖：
 *   ① 权限接线：读 = `forward:read`；被拒时请求到不了处理器（没有读库、没有读档案）；
 *   ② 作用域：跨 Workspace ⇒ 404，与「真不存在」逐字同形（不泄露存在性）；
 *   ③ 窗口参数：非法 ⇒ 明确 400 + 稳定 code；超上限 ⇒ 400 而不是静默截短；
 *   ④ `raw_window_expired`（409）与「没有数据」（200 `no_samples`）**必须可区分**；
 *   ⑤ DIRECT / 无观测维度 ⇒ 明确的「无数据」，**不是** 0 值序列，也不去猜一个 target 来查；
 *   ⑥ 成功形状：直接透传 `readLatencySeries` 的点（`null` 仍是 `null`），并冻结键集；
 *   ⑦ `GET /:id/latency` 没被任何参数化 catch-all 吃掉，且 catch-all 仍可达；
 *   ⑧ GET 零副作用（不写库、不写档案），幂等。
 *
 * ── 替身设计（沿用仓内既有路由测试的模式）──
 * `mock.module` 是**进程级**注册表，替换的是**整个模块**：所以三个替身都用
 * `{ ...real, 只覆盖要控制的那一个导出 }` 的**透传**写法（见
 * `forward-route-topology.test.ts` 里那次误判记录的教训）。特别是 `latency-history.ts`：
 * **只**换 `defaultLatencyHistoryDeps`，`readLatencySeries` 保持**真实现**——于是本文件
 * 测的是"真读函数 + 真路由 + 替身 DB/时钟"，而不是"两个替身互相对答案"。
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { HourlyBucket, LatencyHistoryDeps, RawSamplePoint } from "../../services/latency-history.ts";

/* ------------------------------------------------------------------ */
/* 常量与替身数据                                                       */
/* ------------------------------------------------------------------ */

const WORKSPACE_ID = 3;
const FORWARD_ID = 11;
const EGRESS_NODE_ID = 7;
const POOL_ID = 21;
const TARGET_HOST = "10.0.0.5";
const TARGET_PORT = 8080;
const TARGET_KEY = `${TARGET_HOST}:${TARGET_PORT}`;
/** 挂在行上、但**没有**任何 select 请求的内部材料：只为了证明"没被 select 就绝不出现"可断言。 */
const SEALED_MATERIAL = "v1.SEALED-forward-internal-material-must-never-appear";

/* ------------------------------------------------------------------ */
/* ① db 替身                                                           */
/* ------------------------------------------------------------------ */

interface TunnelRow {
  id: number;
  workspace_id: number;
  category: string;
  user_id: number;
  name: string;
  tunnel_mode: string | null;
  egress_node_id: number | null;
  egress_pool_id: number | null;
  federated_egress_peer: string | null;
  /** 内部材料（本端点若 select 了它，下面的"逐字不出现"断言会红）。 */
  internal_material: string;
}

interface PoolTargetRow {
  id: number;
  host: string;
  port: number;
  status: string;
  order_by: number;
}

interface PoolRow {
  id: number;
  node_id: number;
  targets: PoolTargetRow[];
}

let tunnel: TunnelRow | null = null;
let pool: PoolRow | null = null;

/** 路由对 DB 的每一次调用（模型 + 方法 + where），用来证"零副作用 / 没多查"。 */
const dbCalls: string[] = [];
const findFirstWheres: Array<Record<string, unknown>> = [];

/** 与 Prisma 一致的口径：`undefined` 的 where 键不构成条件，其余按等值匹配。 */
function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => value === undefined || row[key] === value);
}

/** 按 `select` 投影（`true` = 该列）。没被 select 的键不会出现在返回值里。 */
function project(row: Record<string, unknown>, select: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(select)) {
    if (value === true) out[key] = row[key] ?? null;
  }
  return out;
}

/** 写操作一律抛错：本端点是纯读，"写了一次"必须是硬失败而不是一条静默断言。 */
function forbiddenWrite(model: string, op: string): never {
  dbCalls.push(`${model}.${op}(WRITE)`);
  throw new Error(`读端点不得调用 db.${model}.${op}`);
}

const dbStub = {
  tunnel: {
    findFirst: async (args: { where: Record<string, unknown>; select: Record<string, unknown> }) => {
      dbCalls.push("tunnel.findFirst");
      findFirstWheres.push(args.where);
      if (!tunnel || !matches(tunnel as unknown as Record<string, unknown>, args.where)) return null;
      return project(tunnel as unknown as Record<string, unknown>, args.select);
    },
    update: async () => forbiddenWrite("tunnel", "update"),
    create: async () => forbiddenWrite("tunnel", "create"),
    delete: async () => forbiddenWrite("tunnel", "delete"),
    updateMany: async () => forbiddenWrite("tunnel", "updateMany"),
    deleteMany: async () => forbiddenWrite("tunnel", "deleteMany"),
  },
  egressPool: {
    findUnique: async (args: {
      where: { id: number };
      select: {
        id: true;
        node_id: true;
        targets: { where: Record<string, unknown>; select: Record<string, unknown> };
      };
    }) => {
      dbCalls.push("egressPool.findUnique");
      if (!pool || pool.id !== args.where.id) return null;
      const spec = args.select.targets;
      const targets = pool.targets
        .filter((t) => matches(t as unknown as Record<string, unknown>, spec.where))
        .sort((a, b) => a.order_by - b.order_by || a.id - b.id)
        .map((t) => project(t as unknown as Record<string, unknown>, spec.select));
      return { id: pool.id, node_id: pool.node_id, targets };
    },
    update: async () => forbiddenWrite("egressPool", "update"),
    delete: async () => forbiddenWrite("egressPool", "delete"),
  },
  $transaction: async () => forbiddenWrite("$", "transaction"),
};

// 真实 db 模块（用于未知模型的透传）必须在替换注册之前取到。
const realDbModule = await import("../../db.ts");
mock.module("../../db.ts", () => ({
  db: new Proxy(dbStub as unknown as Record<string, unknown>, {
    get: (target, prop) => {
      if (typeof prop === "string" && prop in target) return target[prop];
      const value = (realDbModule.db as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(realDbModule.db) : value;
    },
  }),
}));

/* ------------------------------------------------------------------ */
/* ② 档案依赖替身（`readLatencySeries` 保持真实现）                       */
/* ------------------------------------------------------------------ */

const LATENCY_MODULE = "../../services/latency-history.ts";
const realLatency = await import(LATENCY_MODULE);

let rawSamples: RawSamplePoint[] = [];
let hourBuckets: HourlyBucket[] = [];
/** `LATENCY_RAW_RETENTION_HOURS` 的配置值（null = 未配置 ⇒ 默认 24h）。 */
let rawRetentionHours: string | null = "24";
const depsCalls: string[] = [];
const rawQueries: Array<Record<string, unknown>> = [];
const bucketQueries: Array<Record<string, unknown>> = [];

function deps(): LatencyHistoryDeps {
  const write = (name: string) => async () => {
    depsCalls.push(`${name}(WRITE)`);
    throw new Error(`读端点不得调用档案的 ${name}`);
  };
  return {
    readConfig: async (name: string) => {
      // 两个保留期键分开读（`resolveRetention`）：把键名记下来，"读了几次什么"是可断言的。
      depsCalls.push(`readConfig:${name}`);
      return name === realLatency.LATENCY_RETENTION_CONFIG_KEYS.raw_hours ? rawRetentionHours : null;
    },
    insertSamples: write("insertSamples"),
    aggregateSamples: write("aggregateSamples"),
    aggregateReachable: write("aggregateReachable"),
    insertBucketIfAbsent: write("insertBucketIfAbsent"),
    deleteSamplesBefore: write("deleteSamplesBefore"),
    deleteBucketsBefore: write("deleteBucketsBefore"),
    readRawSamples: async (query) => {
      depsCalls.push("readRawSamples");
      rawQueries.push(query as unknown as Record<string, unknown>);
      return rawSamples;
    },
    readHourBuckets: async (query) => {
      depsCalls.push("readHourBuckets");
      bucketQueries.push(query as unknown as Record<string, unknown>);
      return hourBuckets;
    },
  } as unknown as LatencyHistoryDeps;
}

mock.module(LATENCY_MODULE, () => ({ ...realLatency, defaultLatencyHistoryDeps: () => deps() }));

/* ------------------------------------------------------------------ */
/* ③ workspace 替身（只换中间件那一跳，权限内核保持真实现）               */
/* ------------------------------------------------------------------ */

interface Access {
  id: number;
  role: "owner" | "admin" | "member" | "viewer";
  personalWorkspaceId: number;
  kind: "personal" | "team";
  customRoleId: number | null;
  customPermissions?: unknown;
}

function ownerAccess(): Access {
  return {
    id: WORKSPACE_ID,
    role: "owner",
    personalWorkspaceId: WORKSPACE_ID,
    kind: "personal",
    customRoleId: null,
  };
}

let currentAccess: Access = ownerAccess();
let deny = false;
const accesses: Array<{ action: string; resource: string }> = [];

const realWorkspace = await import("../../services/workspace.ts");
mock.module("../../services/workspace.ts", () => ({
  ...realWorkspace,
  resolveWorkspaceAccess: async (_c: unknown, action: string, resource: string) => {
    accesses.push({ action, resource });
    if (deny) throw realWorkspace.workspacePermissionDenied();
    // 真权限内核 + 真预筛口径（与中间件一致）：自定义角色缺少 forward:read 要在这一层被拒。
    const creatorPrefilter = false;
    if (!realWorkspace.canWorkspaceResourceAction(currentAccess, action as never, resource as never, creatorPrefilter)) {
      throw realWorkspace.workspacePermissionDenied();
    }
    return currentAccess;
  },
}));

/* ------------------------------------------------------------------ */
/* 被测路由                                                            */
/* ------------------------------------------------------------------ */

const { forwardsRoutes } = await import("../forwards.ts");

const app = new Hono<{ Variables: Record<string, unknown> }>();
app.use("*", async (c, next) => {
  c.set("user", { id: 1, super_admin: false });
  await next();
});
app.route("/api/forwards", forwardsRoutes);

interface Body {
  data?: Record<string, unknown> & {
    series?: Array<Record<string, unknown>>;
    window?: { from: string; to: string; hours: number };
    dimension?: { observer_node_id: number; target_key: string } | null;
    status?: string;
    reason?: string | null;
    truncated?: boolean;
  };
  error?: string;
  code?: string;
  error_layer?: string;
}

async function json(res: Response): Promise<Body> {
  return (await res.json()) as Body;
}

function get(query = ""): Promise<Response> {
  return app.request(`http://localhost/api/forwards/${FORWARD_ID}/latency${query}`);
}

function seedTunnel(over: Partial<TunnelRow> = {}): TunnelRow {
  tunnel = {
    id: FORWARD_ID,
    workspace_id: WORKSPACE_ID,
    category: "port_forward",
    user_id: 1,
    name: "relay-a",
    tunnel_mode: "relay",
    egress_node_id: EGRESS_NODE_ID,
    egress_pool_id: POOL_ID,
    federated_egress_peer: null,
    internal_material: SEALED_MATERIAL,
    ...over,
  };
  return tunnel;
}

function seedPool(over: Partial<PoolRow> = {}): PoolRow {
  pool = {
    id: POOL_ID,
    node_id: EGRESS_NODE_ID,
    targets: [{ id: 1, host: TARGET_HOST, port: TARGET_PORT, status: "active", order_by: 1000 }],
    ...over,
  };
  return pool;
}

function samplePoint(over: Partial<RawSamplePoint> = {}): RawSamplePoint {
  return {
    observed_at: new Date("2026-10-06T22:00:00.000Z"),
    reachable: true,
    latency_ms: 42.5,
    observation_source: "node-7/tcp_connect",
    ...over,
  };
}

function hourBucket(over: Partial<HourlyBucket> = {}): HourlyBucket {
  return {
    node_id: EGRESS_NODE_ID,
    target_key: TARGET_KEY,
    hour_start: new Date("2026-10-06T22:00:00.000Z"),
    observation_source: "node-7/tcp_connect",
    sample_count: 120,
    success_count: 118,
    failure_count: 2,
    latency_samples: 118,
    latency_sum_ms: 4956,
    latency_min_ms: 12.1,
    latency_max_ms: 88.4,
    last_observed_at: new Date("2026-10-06T22:59:30.000Z"),
    ...over,
  };
}

beforeEach(() => {
  dbCalls.length = 0;
  findFirstWheres.length = 0;
  depsCalls.length = 0;
  rawQueries.length = 0;
  bucketQueries.length = 0;
  accesses.length = 0;
  deny = false;
  currentAccess = ownerAccess();
  rawSamples = [];
  hourBuckets = [];
  rawRetentionHours = "24";
  seedTunnel();
  seedPool();
});

/** 冻结的成功响应键集（Web 切片对齐用；多一个少一个都算契约变更）。 */
const DATA_KEYS = [
  "dimension",
  "forward_id",
  "granularity",
  "mode",
  "reason",
  "series",
  "status",
  "truncated",
  "window",
].sort();

const POINT_KEYS = [
  "at",
  "failures",
  "latency_max_ms",
  "latency_min_ms",
  "latency_ms",
  "observation_source",
  "samples",
  "successes",
].sort();

/* ------------------------------------------------------------------ */
/* ① 权限接线                                                          */
/* ------------------------------------------------------------------ */

describe("D6: /api/forwards/:id/latency 的权限接线", () => {
  test("中间件被拒 ⇒ 403 rbac，且请求到不了处理器（没读库、没读档案）", async () => {
    deny = true;
    const res = await get("?granularity=hour&hours=6");
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.code).toBe("permission_denied");
    expect(body.error_layer).toBe("rbac");
    expect(dbCalls).toEqual([]);
    expect(depsCalls).toEqual([]);
    // 中间件分类：GET 走 read。
    expect(accesses).toEqual([{ action: "read", resource: "forward" }]);
  });

  test("自定义角色缺少 forward:read ⇒ 403（真权限内核判定，不是替身放行）", async () => {
    currentAccess = {
      ...ownerAccess(),
      role: "member",
      customRoleId: 9,
      customPermissions: { "node:read": true },
    };
    const res = await get("?granularity=hour&hours=6");
    expect(res.status).toBe(403);
    expect((await json(res)).code).toBe("permission_denied");
    expect(depsCalls).toEqual([]);
  });

  test("自定义角色有 forward:read ⇒ 放行（同一内核的正对照）", async () => {
    currentAccess = {
      ...ownerAccess(),
      role: "member",
      customRoleId: 9,
      customPermissions: { "forward:read": true },
    };
    const res = await get("?granularity=hour&hours=6");
    expect(res.status).toBe(200);
  });

  test("viewer 能读（读端点不放宽也不收紧既有角色语义）", async () => {
    currentAccess = { ...ownerAccess(), role: "viewer" };
    expect((await get("?granularity=hour&hours=6")).status).toBe(200);
  });

  test("base member 读他人转发仍是既有语义（read 不被 creator 守卫拦）", async () => {
    currentAccess = { ...ownerAccess(), role: "member" };
    seedTunnel({ user_id: 99 });
    // 既有内核：base member 的 read 直接放行（本任务不改动该语义，只如实记录）。
    expect((await get("?granularity=hour&hours=6")).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* ② 作用域：跨 Workspace 与不存在不可区分                               */
/* ------------------------------------------------------------------ */

describe("D6: 跨 Workspace 一律 404，不泄露存在性", () => {
  test("跨 Workspace 与「真不存在」逐字同形，且都不读档案", async () => {
    tunnel = null;
    const missing = await get("?granularity=hour&hours=6");
    const missingBody = await json(missing);

    seedTunnel({ workspace_id: WORKSPACE_ID + 6 });
    const foreign = await get("?granularity=hour&hours=6");
    const foreignBody = await json(foreign);

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(foreignBody).toEqual(missingBody);
    expect(foreignBody.code).toBe("not_found");
    // 每一次查询都带 workspace 作用域（否则就是一个跨租户读）。
    expect(findFirstWheres).toEqual([
      { id: FORWARD_ID, workspace_id: WORKSPACE_ID, category: "port_forward" },
      { id: FORWARD_ID, workspace_id: WORKSPACE_ID, category: "port_forward" },
    ]);
    expect(depsCalls).toEqual([]);
  });

  test("非法 id ⇒ 400 invalid_input（在权限与读库之前）", async () => {
    const res = await app.request("http://localhost/api/forwards/abc/latency?granularity=hour&hours=6");
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe("invalid_input");
    expect(dbCalls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* ③ 窗口参数：非法 ⇒ 400 + 稳定 code；超上限 ⇒ 拒绝而不是静默截短        */
/* ------------------------------------------------------------------ */

describe("D6: 时间窗口由服务端钳制", () => {
  const bad: Array<[string, string, string]> = [
    ["缺 granularity", "", "invalid_granularity"],
    ["granularity 不认识", "?granularity=minute&hours=6", "invalid_granularity"],
    ["三种窗口参数都没给", "?granularity=sample", "missing_window"],
    ["hours 与 from/to 同时给（自相矛盾）", "?granularity=sample&hours=6&from=2026-10-06T00:00:00Z&to=2026-10-06T01:00:00Z", "invalid_window"],
    ["from/to 不成对", "?granularity=sample&from=2026-10-06T00:00:00Z", "invalid_window"],
    ["hours 不是数字", "?granularity=sample&hours=abc", "invalid_window"],
    ["hours = 0", "?granularity=sample&hours=0", "invalid_window"],
    ["hours 不是整数", "?granularity=sample&hours=6.5", "invalid_window"],
    ["from/to 不可解析", "?granularity=hour&from=not-a-time&to=2026-10-06T01:00:00Z", "invalid_window"],
    ["from >= to", "?granularity=hour&from=2026-10-06T02:00:00Z&to=2026-10-06T01:00:00Z", "invalid_window"],
    ["窗口全落在将来", "?granularity=hour&from=2099-01-01T00:00:00Z&to=2099-01-02T00:00:00Z", "invalid_window"],
  ];

  for (const [name, query, code] of bad) {
    test(`${name} ⇒ 400 ${code}，且不读档案`, async () => {
      const res = await get(query);
      expect(res.status, name).toBe(400);
      expect((await json(res)).code, name).toBe(code);
      expect(depsCalls, name).toEqual([]);
    });
  }

  test("窗口超过该粒度上限 ⇒ 400 window_too_long（带 max_hours，不静默截短）", async () => {
    const sampleRes = await get("?granularity=sample&hours=48");
    expect(sampleRes.status).toBe(400);
    const sampleBody = await json(sampleRes);
    expect(sampleBody.code).toBe("window_too_long");
    expect((sampleBody.data as { max_hours?: number })?.max_hours).toBe(24);

    const hourRes = await get("?granularity=hour&hours=721");
    expect(hourRes.status).toBe(400);
    const hourBody = await json(hourRes);
    expect(hourBody.code).toBe("window_too_long");
    expect((hourBody.data as { max_hours?: number })?.max_hours).toBe(720);
    expect(depsCalls).toEqual([]);
  });

  test("to 在将来 ⇒ 钳制到 now（不多给也不少给），from 仍是原值", async () => {
    const before = Date.now();
    const from = new Date(before - 3 * 3_600_000).toISOString();
    const to = new Date(before + 5 * 3_600_000).toISOString();
    rawSamples = [];
    const res = await get(`?granularity=sample&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(res.status).toBe(200);
    const data = (await json(res)).data!;
    expect(data.window!.from).toBe(from);
    expect(Date.parse(data.window!.to)).toBeLessThanOrEqual(Date.now());
    expect(data.window!.hours).toBeGreaterThan(2.9);
    expect(data.window!.hours).toBeLessThan(3.1);
    // 传给读函数的窗口与响应里那个**是同一个**（不让下游再算一次）。
    expect((rawQueries[0]!.from as Date).toISOString()).toBe(data.window!.from);
    expect((rawQueries[0]!.to as Date).toISOString()).toBe(data.window!.to);
  });
});

/* ------------------------------------------------------------------ */
/* ④ raw_window_expired 与「没有数据」可区分                             */
/* ------------------------------------------------------------------ */

describe("D6: 「窗口太旧」与「没有数据」必须能分开", () => {
  test("原始保留期 2h：sample 粒度读 6h ⇒ 409 raw_window_expired（不是 200 空序列）", async () => {
    rawRetentionHours = "2";
    const res = await get("?granularity=sample&hours=6");
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.code).toBe("raw_window_expired");
    expect(body.error_layer).toBe("retention");
    // 「太旧」在**查数据之前**就被拒了：没有任何 readRawSamples。
    expect(depsCalls).toEqual([
      "readConfig:LATENCY_RAW_RETENTION_HOURS",
      "readConfig:LATENCY_BUCKET_RETENTION_DAYS",
    ]);
  });

  test("同一窗口换成 hour 粒度 ⇒ 200（小时桶覆盖 30d），形状是 no_samples 而不是错误", async () => {
    rawRetentionHours = "2";
    hourBuckets = [];
    const res = await get("?granularity=hour&hours=6");
    expect(res.status).toBe(200);
    const data = (await json(res)).data!;
    expect(data.status).toBe("no_samples");
    expect(data.series).toEqual([]);
    expect(data.dimension).toEqual({ observer_node_id: EGRESS_NODE_ID, target_key: TARGET_KEY });
  });

  test("sample 粒度窗口落在保留期内 ⇒ 不是 409（「太旧」与「空」不同码）", async () => {
    rawRetentionHours = "2";
    const res = await get("?granularity=sample&hours=1");
    expect(res.status).toBe(200);
    expect((await json(res)).data!.status).toBe("no_samples");
  });
});

/* ------------------------------------------------------------------ */
/* ⑤ DIRECT / 无观测维度 ⇒ 明确的「无数据」                              */
/* ------------------------------------------------------------------ */

describe("D6: 没有观测维度时如实说「没有数据」", () => {
  test("DIRECT 转发 ⇒ 200 no_observer/direct_not_observed，series 为空且**不去查档案**", async () => {
    seedTunnel({ tunnel_mode: "direct", egress_node_id: null, egress_pool_id: null });
    const res = await get("?granularity=hour&hours=6");
    expect(res.status).toBe(200);
    const data = (await json(res)).data!;
    expect(data.status).toBe("no_observer");
    expect(data.reason).toBe("direct_not_observed");
    expect(data.dimension).toBeNull();
    expect(data.series).toEqual([]);
    expect(data.truncated).toBe(false);
    // DIRECT 的目标由入口节点直拨、观测器只看出口池：拿 target_host 硬造一个 key 去查
    // 就是猜。这里证明它**没有**查档案，也没有编一个 0 值序列。
    expect(depsCalls).toEqual([]);
    expect(JSON.stringify(data)).not.toContain("latency_ms");
  });

  test("RELAY 但没有出口池 ⇒ no_observer/no_egress_pool", async () => {
    seedTunnel({ egress_pool_id: null });
    const data = (await json(await get("?granularity=hour&hours=6"))).data!;
    expect(data.status).toBe("no_observer");
    expect(data.reason).toBe("no_egress_pool");
    expect(depsCalls).toEqual([]);
  });

  test("出口腿在 peer panel ⇒ no_observer/federated_egress（本 panel 只说「我这边没有」）", async () => {
    seedTunnel({ federated_egress_peer: "peer-2", egress_node_id: null, egress_pool_id: null });
    const data = (await json(await get("?granularity=hour&hours=6"))).data!;
    expect(data.status).toBe("no_observer");
    expect(data.reason).toBe("federated_egress");
    expect(depsCalls).toEqual([]);
  });

  test("池的主人 ≠ 转发出口节点 ⇒ no_observer/dimension_conflict（不挑一个信）", async () => {
    seedPool({ node_id: EGRESS_NODE_ID + 5 });
    const data = (await json(await get("?granularity=hour&hours=6"))).data!;
    expect(data.status).toBe("no_observer");
    expect(data.reason).toBe("dimension_conflict");
    expect(depsCalls).toEqual([]);
  });

  test("池里没有 active 目标 ⇒ no_observer/no_active_target（停用目标不算观测维度）", async () => {
    seedPool({
      targets: [
        { id: 1, host: TARGET_HOST, port: TARGET_PORT, status: "inactive", order_by: 1000 },
      ],
    });
    const data = (await json(await get("?granularity=hour&hours=6"))).data!;
    expect(data.status).toBe("no_observer");
    expect(data.reason).toBe("no_active_target");
    expect(depsCalls).toEqual([]);
  });

  test("池里多个 active 目标 ⇒ ambiguous_target + 只报数量（拒绝藏起其余目标的抖动）", async () => {
    seedPool({
      targets: [
        { id: 1, host: TARGET_HOST, port: TARGET_PORT, status: "active", order_by: 1000 },
        { id: 2, host: "10.0.0.9", port: 9090, status: "active", order_by: 1010 },
        { id: 3, host: "10.0.0.9", port: 9090, status: "inactive", order_by: 1020 },
      ],
    });
    const res = await get("?granularity=hour&hours=6");
    expect(res.status).toBe(200);
    const data = (await json(res)).data!;
    expect(data.status).toBe("ambiguous_target");
    expect(data.reason).toBe("multiple_targets");
    expect(data.candidate_targets).toBe(2);
    expect(data.series).toEqual([]);
    expect(depsCalls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* ⑥ 成功形状：直接透传读函数的点                                        */
/* ------------------------------------------------------------------ */

describe("D6: 成功响应直接透传档案的点", () => {
  test("sample 粒度：不可达样本的 latency_ms 保持 null（绝不补 0），顺序不变", async () => {
    const first = samplePoint({ observed_at: new Date("2026-10-06T21:00:00.000Z"), latency_ms: 42.5 });
    const second = samplePoint({
      observed_at: new Date("2026-10-06T21:00:30.000Z"),
      reachable: false,
      latency_ms: null,
    });
    rawSamples = [first, second];
    const res = await get("?granularity=sample&hours=6");
    expect(res.status).toBe(200);
    const data = (await json(res)).data!;
    expect(data.status).toBe("ok");
    expect(data.truncated).toBe(false);
    expect(data.dimension).toEqual({ observer_node_id: EGRESS_NODE_ID, target_key: TARGET_KEY });
    expect(data.series).toEqual([
      {
        at: "2026-10-06T21:00:00.000Z",
        latency_ms: 42.5,
        samples: 1,
        successes: 1,
        failures: 0,
        latency_min_ms: 42.5,
        latency_max_ms: 42.5,
        observation_source: "node-7/tcp_connect",
      },
      {
        at: "2026-10-06T21:00:30.000Z",
        latency_ms: null,
        samples: 1,
        successes: 0,
        failures: 1,
        latency_min_ms: null,
        latency_max_ms: null,
        observation_source: "node-7/tcp_connect",
      },
    ]);
    // 维度是**服务端推导**的：查询维度必须是 (出口节点, 池目标)，不是入口节点。
    expect(rawQueries[0]!.node_id).toBe(EGRESS_NODE_ID);
    expect(rawQueries[0]!.target_key).toBe(TARGET_KEY);
    expect(rawQueries[0]!.observation_source).toBeNull();
  });

  test("hour 粒度：一个样本都没测到的小时桶 ⇒ latency_ms null（不是 0）", async () => {
    hourBuckets = [
      hourBucket({
        sample_count: 6,
        success_count: 0,
        failure_count: 6,
        latency_samples: 0,
        latency_sum_ms: 0,
        latency_min_ms: null,
        latency_max_ms: null,
      }),
    ];
    const data = (await json(await get("?granularity=hour&hours=6"))).data!;
    expect(data.status).toBe("ok");
    expect(data.series!.length).toBe(1);
    expect(data.series![0]!.latency_ms).toBeNull();
    expect(data.series![0]!.failures).toBe(6);
  });

  test("命中点数上限 ⇒ truncated=true 且点数就是上限（显式标注，不假装完整）", async () => {
    rawSamples = Array.from({ length: realLatency.MAX_SERIES_POINTS + 1 }, (_, i) =>
      samplePoint({ observed_at: new Date(1_700_000_000_000 + i * 30_000) }),
    );
    const data = (await json(await get("?granularity=sample&hours=6"))).data!;
    expect(data.truncated).toBe(true);
    expect(data.series!.length).toBe(realLatency.MAX_SERIES_POINTS);
    // 读函数只多取一条用于判"被截断"，不会把整个窗口拉进内存。
    expect(rawQueries[0]!.limit).toBe(realLatency.MAX_SERIES_POINTS + 1);
  });

  test("响应键集冻结，且不含任何内部材料", async () => {
    expect(tunnel!.internal_material).toBe(SEALED_MATERIAL);
    rawSamples = [samplePoint()];
    const res = await get("?granularity=sample&hours=6");
    const raw = await res.clone().text();
    expect(raw).not.toContain("SEALED");
    expect(raw).not.toContain("internal_material");
    const body = await json(res);
    expect(Object.keys(body.data!).sort()).toEqual(DATA_KEYS);
    expect(Object.keys(body.data!.series![0]!).sort()).toEqual(POINT_KEYS);
  });
});

/* ------------------------------------------------------------------ */
/* ⑦ catch-all 没吃掉子路由                                             */
/* ------------------------------------------------------------------ */

describe("D6: 子路由没被参数化 catch-all 吃掉", () => {
  test("GET /:id/latency 落到延迟处理器（有 status/window，不是转发详情）", async () => {
    const data = (await json(await get("?granularity=hour&hours=6"))).data!;
    expect("status" in data).toBe(true);
    expect("window" in data).toBe(true);
    expect("name" in data).toBe(false);
    expect("target_host" in data).toBe(false);
  });

  test("该路径不是通配：未知子路径仍然是 404", async () => {
    const res = await app.request(`http://localhost/api/forwards/${FORWARD_ID}/latency-typo?granularity=hour`);
    expect(res.status).toBe(404);
  });

  test("对照组：catch-all 仍然存在且可达（未知 action ⇒ 400）", async () => {
    const res = await app.request(`http://localhost/api/forwards/${FORWARD_ID}/not-an-action`, {
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe("不支持的端口转发动作");
  });
});

/* ------------------------------------------------------------------ */
/* ⑧ 零副作用                                                          */
/* ------------------------------------------------------------------ */

describe("D6: GET 是纯读", () => {
  test("一次成功读只碰两次库（转发行 + 出口池），且不写任何东西", async () => {
    rawSamples = [samplePoint()];
    const res = await get("?granularity=sample&hours=6");
    expect(res.status).toBe(200);
    // 写操作会让替身抛错（→ 500）；这里同时逐项核对调用面。
    expect(dbCalls).toEqual(["tunnel.findFirst", "egressPool.findUnique"]);
    expect(depsCalls).toEqual([
      "readConfig:LATENCY_RAW_RETENTION_HOURS",
      "readConfig:LATENCY_BUCKET_RETENTION_DAYS",
      "readRawSamples",
    ]);
  });

  test("幂等：同一窗口读两次结论一致（显式 from/to，不受「现在」漂移影响）", async () => {
    rawSamples = [samplePoint()];
    // 显式窗口：`hours` 形态的窗口以"请求那一刻"为右界，两次调用必然不同（那是时钟事实，
    // 不是幂等性缺陷）；这里要证明的是**同样的输入给出同样的输出**。
    const query =
      "?granularity=sample" +
      `&from=${encodeURIComponent("2026-10-06T00:00:00.000Z")}` +
      `&to=${encodeURIComponent("2026-10-06T03:00:00.000Z")}`;
    const first = (await json(await get(query))).data!;
    const second = (await json(await get(query))).data!;
    expect(second).toEqual(first);
    expect(dbCalls).toEqual([
      "tunnel.findFirst",
      "egressPool.findUnique",
      "tunnel.findFirst",
      "egressPool.findUnique",
    ]);
  });

  test("无观测维度时不多查库（DIRECT 只读转发行）", async () => {
    seedTunnel({ tunnel_mode: "direct", egress_node_id: null, egress_pool_id: null });
    expect((await get("?granularity=hour&hours=6")).status).toBe(200);
    expect(dbCalls).toEqual(["tunnel.findFirst"]);
  });
});
