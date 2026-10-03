/**
 * V4-WP9 §13.6「必要批量操作」——批量端点与专属限流规则的路由层契约。
 *
 * 依赖替换策略与 `forward-list-route.test.ts` 一致（替换路由的直接依赖
 * `forward-service` / `workspace`，而不是 `db.ts`）：batch 端点只做「解析 →
 * 逐条调用服务层 → 汇总响应」，本文件的断言正是这两段的边界。
 *
 * 另外钉住两件容易回归的事：
 *   1. `/batch` 必须在 `/:id/:action` **之前**注册（否则 "batch" 被当成 id）；
 *   2. 限流规则必须在 `api-global` 之前命中（否则 3/min 的上限形同虚设）。
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { selectRule } from "../../middlewares/rate-limit.ts";
import { GLOBAL_RATE_LIMIT_RULES } from "../../middlewares/rate-limit.ts";

const ROOT = new URL("../..", import.meta.url).pathname; // → .../backend/src/

interface BatchCall {
  ids: number[];
  action: string;
  workspaceId: number;
}

const calls = { batch: [] as BatchCall[], single: [] as BatchCall[] };

/** 服务层替身：按 id 决定成败，用来验证「逐条结果」而不是「整体成败」。 */
mock.module(`${ROOT}services/forward-service.ts`, () => ({
  listForwards: async () => [],
  listForwardsPage: async () => ({ data: [], total: 0 }),
  createForward: async () => ({ ok: true, data: {} }),
  deleteForward: async () => ({ ok: true, data: { ok: true } }),
  getForward: async () => null,
  getForwardSummary: async () => ({ total: 0 }),
  getForwardTraffic: async () => ({ ok: true, data: [] }),
  patchForward: async () => ({ ok: true, data: {} }),
  previewForwardUpdate: async () => ({ ok: true, data: {} }),
  /** 逐条：id=2 → 404；id=3 → 409；其余成功。 */
  runForwardAction: async (id: number, action: string, workspaceId: number) => {
    calls.single.push({ ids: [id], action, workspaceId });
    if (id === 2) {
      return { ok: false, code: "not_found", message: "端口转发不存在" };
    }
    if (id === 3) {
      return { ok: false, code: "conflict", message: "状态冲突" };
    }
    return { ok: true, data: { id, apply_status: action === "suspend" ? "suspended" : "active" } };
  },
  /**
   * 批量：有意**不**复用上面的替身，而是断言服务层收到的 ids/action，
   * 并返回可控的逐条结果 —— 真正的「顺序执行」在服务层实现，
   * 由服务层单元测试与集成链路覆盖。
   */
  runForwardBatch: async (ids: number[], action: string, workspaceId: number) => {
    calls.batch.push({ ids, action, workspaceId });
    const results = ids.map((id) =>
      id === 2
        ? { id, ok: false, apply_status: null, code: "not_found", message: "端口转发不存在" }
        : { id, ok: true, apply_status: "active" },
    );
    return {
      action,
      requested: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  },
}));

mock.module(`${ROOT}services/workspace.ts`, () => ({
  canWorkspaceResourceAction: (access: { role: string }) => access.role === "owner",
  resolveWorkspaceAccess: async () => ({
    id: 77,
    personalWorkspaceId: 77,
    role: "owner",
    permissions: {},
  }),
}));

const { forwardsRoutes } = await import("../forwards.ts");

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

const postBatch = (body: unknown) =>
  api.request("/api/forwards/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  calls.batch.length = 0;
  calls.single.length = 0;
});

describe("V4-WP9 POST /api/forwards/batch", () => {
  test("合法请求 → 200 + 逐条结果（部分失败不改变整体状态码）", async () => {
    const res = await postBatch({ action: "retry", ids: [1, 2, 3] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        action: string;
        requested: number;
        succeeded: number;
        failed: number;
        results: { id: number; ok: boolean; code?: string }[];
      };
    };
    expect(body.data.action).toBe("retry");
    expect(body.data.requested).toBe(3);
    expect(body.data.succeeded).toBe(2);
    expect(body.data.failed).toBe(1);
    // 失败的那条在结果里可见，而不是被吞掉
    expect(body.data.results.find((row) => row.id === 2)?.code).toBe("not_found");
  });

  test("工作空间作用域由服务层收到（不是路由自己查库）", async () => {
    await postBatch({ action: "suspend", ids: [7] });
    expect(calls.batch[0]!.workspaceId).toBe(77);
    expect(calls.batch[0]!.action).toBe("suspend");
  });

  test("去重后下行：服务层收到的是去重后的 ids", async () => {
    await postBatch({ action: "resume", ids: [4, 4, 6] });
    expect(calls.batch[0]!.ids).toEqual([4, 6]);
  });

  test("破坏性动作被拒（delete 不进批量白名单）", async () => {
    const res = await postBatch({ action: "delete", ids: [1, 2] });
    expect(res.status).toBe(400);
    expect(calls.batch.length).toBe(0);
    expect(calls.single.length).toBe(0);
  });

  test("超上限被拒且**不**执行任何一条", async () => {
    const res = await postBatch({
      action: "retry",
      ids: Array.from({ length: 51 }, (_, i) => i + 1),
    });
    expect(res.status).toBe(400);
    expect(calls.batch.length).toBe(0);
  });

  test("非法载荷（空 ids / 非整数 / 无 action）→ 400", async () => {
    for (const body of [
      { action: "retry", ids: [] },
      { action: "retry", ids: [1, "2"] },
      { action: "retry", ids: [0] },
      { ids: [1] },
      null,
    ]) {
      const res = await postBatch(body);
      expect(res.status).toBe(400);
    }
    expect(calls.batch.length).toBe(0);
  });

  test("路由顺序：/batch 不被 /:id/:action 吃掉", async () => {
    await postBatch({ action: "retry", ids: [1] });
    // 命中 batch 处理器（而不是被当作 id="batch" 的 action 路由）
    expect(calls.batch.length).toBe(1);
    expect(calls.single.length).toBe(0);
  });
});

describe("V4-WP9 批量限流规则", () => {
  test("POST /api/forwards/batch 命中 forward-batch（3/min），优于 api-global", () => {
    const rule = selectRule(GLOBAL_RATE_LIMIT_RULES, "/api/forwards/batch", "POST");
    expect(rule?.name).toBe("forward-batch");
    expect(rule?.max).toBe(3);
    expect(rule?.scope).toBe("user");
  });

  test("规则位置：forward-batch 索引 < api-global 索引（第一条命中才有效）", () => {
    const batch = GLOBAL_RATE_LIMIT_RULES.findIndex((r) => r.name === "forward-batch");
    const global = GLOBAL_RATE_LIMIT_RULES.findIndex((r) => r.name === "api-global");
    expect(batch).toBeGreaterThanOrEqual(0);
    expect(global).toBeGreaterThanOrEqual(0);
    expect(batch).toBeLessThan(global);
  });

  test("单条动作端点不受批量规则影响（仍走 api-global）", () => {
    const rule = selectRule(GLOBAL_RATE_LIMIT_RULES, "/api/forwards/12/retry", "POST");
    expect(rule?.name).toBe("api-global");
  });

  test("GET /api/forwards/batch 不触发批量规则（只限 POST）", () => {
    const rule = selectRule(GLOBAL_RATE_LIMIT_RULES, "/api/forwards/batch", "GET");
    expect(rule?.name).toBe("api-global");
  });
});
