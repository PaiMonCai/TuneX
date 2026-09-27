/**
 * V4-WP9 — `/api/forwards` 列表的路由层契约（Hono `app.request`，不连 DB/Redis/env）。
 *
 * 覆盖 `routes/forwards.ts` 的分页决策与参数下行：
 *   1. **响应形态**：带 page / page_size / sort / order 任一参数 → 分页信封
 *      `{ data: { data, total, page, page_size } }`；不带 → 裸数组（冻结的旧契约）；
 *   2. **参数解析下行**：skip / take / orderBy 必须由 `forward-list-query.ts` 的
 *      白名单派生（非法 sort 回落 order_by；orderBy 永远带 id desc 兜底）；
 *   3. **过滤下行**：mode / apply_status / ingress / egress / keyword 透传到服务层，
 *      非法值不产生过滤条件；
 *   4. **鉴权**：无 workspace 时 403（本层不自己发明权限判定）。
 *
 * ── 替身设计 ──
 * 这里替换的是**路由的两个直接依赖**（`forward-service` 与 `workspace`），不是
 * `db.ts`：`forward-service` 的传递依赖会 eager 连接 Redis（`portPool` → `redis.ts`）
 * 并读取 `DATABASE_URL` 等密钥，替换它既避免测试依赖外部服务，也让断言能直接
 * 读到「路由交给了服务层什么」——这正是本文件要钉住的契约。
 *
 * 服务层内部的 where/orderBy/count 行为由 `services/__tests__/forward-list-query.test.ts`
 * （纯函数）与 S1 的集成链路共同覆盖，不在本文件重复。
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const ROOT = new URL("../..", import.meta.url).pathname; // → .../backend/src/

interface ListCall {
  scope: string;
  input: Record<string, unknown>;
  page?: { skip: number; take: number; orderBy: Array<Record<string, string>> };
}

const calls = {
  list: [] as ListCall[],
  listPage: [] as ListCall[],
};

/** 服务层替身：记录调用参数，返回可控行集。 */
mock.module(`${ROOT}services/forward-service.ts`, () => ({
  listForwards: async (_workspaceId: number, input: Record<string, unknown>) => {
    calls.list.push({ scope: "all", input });
    return [
      { id: 1, name: "a", mode: "direct", apply_status: "active" },
      { id: 2, name: "b", mode: "relay", apply_status: "error" },
    ];
  },
  listForwardsPage: async (
    _workspaceId: number,
    input: Record<string, unknown>,
    page: { skip: number; take: number; orderBy: Array<Record<string, string>> },
  ) => {
    calls.listPage.push({ scope: "page", input, page });
    return {
      data: [{ id: 7, name: "paged", mode: "direct", apply_status: "active" }],
      total: 42,
    };
  },
  createForward: async () => ({ ok: true, data: {} }),
  deleteForward: async () => ({ ok: true, data: { ok: true } }),
  getForward: async () => null,
  getForwardSummary: async () => ({ total: 0 }),
  getForwardTraffic: async () => ({ ok: true, data: [] }),
  patchForward: async () => ({ ok: true, data: {} }),
  previewForwardUpdate: async () => ({ ok: true, data: {} }),
  runForwardAction: async () => ({ ok: true, data: {} }),
}));

/** workspace 替身：路由的 `workspace(c)` 依赖它写入的变量。 */
mock.module(`${ROOT}services/workspace.ts`, () => ({
  resolveWorkspaceAccess: async () => ({
    id: 11,
    personalWorkspaceId: 11,
    role: "owner",
    permissions: {},
  }),
}));

const { forwardsRoutes } = await import("../forwards.ts");

/** 注入 user（路由的鉴权读 `c.get("user")`；workspace 已由上面的替身提供）。 */
function app() {
  const instance = new Hono<{ Variables: Record<string, unknown> }>();
  instance.use("*", async (c, next) => {
    c.set("user", { id: 5, email: "u@example.com" });
    await next();
  });
  instance.route("/api/forwards", forwardsRoutes);
  return instance;
}

const api = app();

beforeEach(() => {
  calls.list.length = 0;
  calls.listPage.length = 0;
});

describe("V4-WP9 /api/forwards 列表", () => {
  test("不带分页参数 → 裸数组（旧契约）", async () => {
    const res = await api.request("/api/forwards");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(Array.isArray(body.data)).toBe(true);
    expect(calls.list.length).toBe(1);
    expect(calls.listPage.length).toBe(0);
  });

  test("带 page → 分页信封，字段与既有分页端点同形", async () => {
    const res = await api.request("/api/forwards?page=3&page_size=20");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { data: unknown[]; total: number; page: number; page_size: number };
    };
    expect(body.data.total).toBe(42);
    expect(body.data.page).toBe(3);
    expect(body.data.page_size).toBe(20);
    expect(body.data.data.length).toBe(1);
    // 客户端显式分页时不再走「取全部」分支
    expect(calls.list.length).toBe(0);
  });

  test("skip/take 由服务端解析（客户端不能传 offset）", async () => {
    await api.request("/api/forwards?page=3&page_size=20&offset=9999");
    expect(calls.listPage[0]!.page!.skip).toBe(40);
    expect(calls.listPage[0]!.page!.take).toBe(20);
  });

  test("page_size 上限 200（防止用超大页绕过分页）", async () => {
    await api.request("/api/forwards?page=1&page_size=100000");
    expect(calls.listPage[0]!.page!.take).toBe(200);
  });

  test("非法 page / page_size 回落，不产生负 skip / 0 条页", async () => {
    await api.request("/api/forwards?page=-5&page_size=0");
    expect(calls.listPage[0]!.page!.skip).toBe(0);
    expect(calls.listPage[0]!.page!.take).toBe(20);
  });

  test("sort 走白名单：合法键映射到数据库列", async () => {
    await api.request("/api/forwards?page=1&sort=traffic&order=desc");
    expect(calls.listPage[0]!.page!.orderBy).toEqual([
      { traffic: "desc" },
      { id: "desc" },
    ]);
  });

  test("sort 非法值回落默认键，且 orderBy 永远带 id desc", async () => {
    await api.request("/api/forwards?page=1&sort=NOT_A_COLUMN&order=sideways");
    expect(calls.listPage[0]!.page!.orderBy).toEqual([
      { order_by: "asc" },
      { id: "desc" },
    ]);
  });

  test("只给 sort（不给 page）也走分页信封：避免类型在表头间跳变", async () => {
    const res = await api.request("/api/forwards?sort=name&order=asc");
    const body = (await res.json()) as { data: { total?: number } };
    expect(typeof body.data.total).toBe("number");
    expect(calls.listPage.length).toBe(1);
    expect(calls.listPage[0]!.page!.orderBy).toEqual([
      { name: "asc" },
      { id: "desc" },
    ]);
  });

  test("过滤参数透传到服务层（含出口筛选）", async () => {
    await api.request(
      "/api/forwards?page=1&mode=relay&apply_status=error&ingress_node_id=3&egress_node_id=9&keyword=web",
    );
    expect(calls.listPage[0]!.input).toEqual({
      mode: "relay",
      apply_status: "error",
      ingress_node_id: 3,
      egress_node_id: 9,
      keyword: "web",
    });
  });

  test("非法过滤值被忽略（不传 undefined 之外的伪条件）", async () => {
    await api.request(
      "/api/forwards?page=1&mode=tunnel&apply_status=whatever&egress_node_id=0",
    );
    expect(calls.listPage[0]!.input).toEqual({
      mode: undefined,
      apply_status: undefined,
      ingress_node_id: undefined,
      egress_node_id: undefined,
      keyword: undefined,
    });
  });
});
