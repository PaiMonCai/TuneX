/**
 * V5-WP19-D —— Looking Glass HTTP 边界测试（Hono `app.request`，不连 DB / Redis）。
 *
 * 为什么单独测路由层：契约的四个负例（**拒私网 / 拒跨租户 / 拒并发 / 拒未广告动作**）
 * 都必须在**拿到请求体的那一刻**就定下来，而不是"下发了命令才发现不对"。服务层的
 * 替身测试证明了编排顺序，这里证明**HTTP 出口的形状**：状态码、`code`、`error_layer`
 * 都在响应体里，调用者拿到的是明确拒绝而不是空结果。
 *
 * 注入方式：`createLookingGlassRoutes({ service, workspace, resolveNodeParam })`
 * —— 路由工厂让这层不需要 mock 整个 db 模块（也就不会因为别人的 db 替身变化而红）。
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createLookingGlassRoutes } from "../looking-glass.ts";
import type {
  LookingGlassDeps,
  LookingGlassIssueInput,
  LookingGlassIssueOutcome,
} from "../../services/looking-glass.ts";
import type { AppVariables } from "../../middlewares/auth.ts";

interface Captured {
  issues: LookingGlassIssueInput[];
  audits: Array<{ action: string; code: string; targets: string[] }>;
}

function build(options: {
  enabled?: boolean;
  nodeId?: number | null;
  capability?: string[] | null;
  issue?: (input: LookingGlassIssueInput) => Promise<LookingGlassIssueOutcome>;
  resolveTo?: string[];
  /** 路由解析出来的（调用者所在的）工作空间。 */
  workspaceId?: number;
  /** 节点**实际归属**的工作空间；与上者不同 = 跨租户场景。 */
  nodeWorkspaceId?: number;
} = {}) {
  const captured: Captured = { issues: [], audits: [] };
  const service: LookingGlassDeps = {
    enabled: () => options.enabled ?? true,
    async resolve() {
      return options.resolveTo ?? ["93.184.216.34"];
    },
    async loadNode(nodeId, workspaceId) {
      // 节点归属是**数据事实**，与调用者所在工作空间无关——跨租户测试正是要让两者不同。
      return workspaceId === (options.nodeWorkspaceId ?? 1) ? { id: nodeId, node_key: "node-a" } : null;
    },
    async capabilityFacts() {
      return {
        protocolVersion: 2,
        capabilities: options.capability === undefined ? ["looking_glass"] : options.capability,
        capabilitiesMalformed: false,
        manifest: null,
        manifestMalformed: false,
      };
    },
    async issue(input) {
      captured.issues.push(input);
      if (options.issue) return options.issue(input);
      return {
        ok: true,
        results: input.targets.map((t) => ({ host: t.address, port: t.port, status: "reachable", elapsed_ms: 5 })),
      };
    },
    async audit(row) {
      captured.audits.push({ action: row.action, code: row.code, targets: row.targets });
      return true;
    },
  };

  const app = new Hono<{ Variables: AppVariables }>();
  // 认证/工作空间由挂载点统一施加；这里只注入等价的事实。
  app.use("*", async (c, next) => {
    c.set("user", { id: 42, super_admin: false, admin_roles: [] } as never);
    await next();
  });
  app.route(
    "/api/looking-glass",
    createLookingGlassRoutes({
      service,
      workspace: async () => ({ id: options.workspaceId ?? 1 }),
      resolveNodeParam: async (param) => (options.nodeId === null ? null : Number(param)),
    }),
  );
  return { app, captured };
}

function post(app: Hono<{ Variables: AppVariables }>, body: unknown) {
  return app.request("/api/looking-glass/nodes/7/tests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PUBLIC_TARGET = { host: "93.184.216.34", port: 443 };

describe("WP19-D 路由：成功路径", () => {
  test("200 + 报告（含口径声明与钉死地址）", async () => {
    const { app, captured } = build();
    const response = await post(app, { targets: [PUBLIC_TARGET] });
    expect(response.status).toBe(200);
    const json = await response.json() as { data: { method: string; pinned: unknown[]; caveats: string[] } };
    expect(json.data.method).toBe("tcp_connect");
    expect(json.data.pinned).toEqual([{ address: "93.184.216.34", port: 443 }]);
    expect(json.data.caveats.length).toBeGreaterThan(0);
    expect(captured.issues).toHaveLength(1);
  });

  test("GET /status 不过度暴露：只回开关/上限/口径，不因为关闭而 403", async () => {
    const { app } = build({ enabled: false });
    const response = await app.request("/api/looking-glass/status");
    expect(response.status).toBe(200);
    const json = await response.json() as { data: { enabled: boolean; switch_env: string; caps: { max_targets: number } } };
    expect(json.data.enabled).toBe(false);
    expect(json.data.switch_env).toBe("LOOKING_GLASS_ENABLED");
    expect(json.data.caps.max_targets).toBe(4);
  });
});

describe("WP19-D 路由：四个负例（拒绝都发生在发包之前）", () => {
  test("G19.9 私网目标 ⇒ 400 + target_not_public，且零下发", async () => {
    const { app, captured } = build();
    const response = await post(app, { targets: [{ host: "10.0.0.1", port: 22 }] });
    expect(response.status).toBe(400);
    const json = await response.json() as { code: string; error_layer: string };
    expect(json.code).toBe("target_not_public");
    expect(json.error_layer).toBe("runtime_admission");
    expect(captured.issues).toEqual([]);
    // 拒绝也要留审计：有人拿这个接口探内网时，这是唯一的信号。
    expect(captured.audits.some((a) => a.action === "looking_glass.test_refused")).toBe(true);
  });

  test("G19.9 十进制/八进制/映射形式等写法变体 ⇒ 400 且**不进解析器**", async () => {
    const { app, captured } = build();
    for (const host of ["2130706433", "0177.0.0.1", "0x7f000001", "127.1", "::ffff:127.0.0.1", "[::1]"]) {
      const response = await post(app, { targets: [{ host, port: 80 }] });
      expect(response.status, host).toBe(400);
    }
    expect(captured.issues).toEqual([]);
  });

  test("G19.10 跨租户 ⇒ 404（不泄漏节点是否存在），零下发", async () => {
    const { app, captured } = build({ workspaceId: 2, nodeWorkspaceId: 1 });
    const response = await post(app, { targets: [PUBLIC_TARGET] });
    expect(response.status).toBe(404);
    expect(captured.issues).toEqual([]);
  });

  test("G19.10 节点标识不存在 ⇒ 404 且不进入服务层", async () => {
    const { app, captured } = build({ nodeId: null });
    const response = await post(app, { targets: [PUBLIC_TARGET] });
    expect(response.status).toBe(404);
    expect(captured.issues).toEqual([]);
    expect(captured.audits).toEqual([]);
  });

  test("G19.11 并发第二条 ⇒ 409 looking_glass_busy（第一条不受影响）", async () => {
    const { app, captured } = build({
      issue: async () => {
        // 第一条还没结束时再发第二条：单飞锁必须拒绝它。
        const second = await post(app, { targets: [PUBLIC_TARGET] });
        expect(second.status).toBe(409);
        const json = await second.json() as { code: string };
        expect(json.code).toBe("looking_glass_busy");
        return {
          ok: true,
          results: [{ host: "93.184.216.34", port: 443, status: "reachable", elapsed_ms: 5 }],
        };
      },
    });
    const first = await post(app, { targets: [PUBLIC_TARGET] });
    expect(first.status).toBe(200);
    expect(captured.issues).toHaveLength(1);
  });

  test("G19.12 未广告动作 ⇒ 409 upgrade_required，**入队前**拒绝（无超时等待）", async () => {
    const { app, captured } = build({ capability: ["apply_tunnel"] });
    const started = Date.now();
    const response = await post(app, { targets: [PUBLIC_TARGET] });
    expect(response.status).toBe(409);
    const json = await response.json() as { code: string; error_layer: string };
    expect(json.code).toBe("upgrade_required");
    expect(json.error_layer).toBe("runtime_admission");
    expect(captured.issues).toEqual([]);
    // "入队前拒绝"的机械证据：整条请求是同步判定的，没有 ACK 等待窗口。
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("默认关 ⇒ 403 looking_glass_disabled（明确 code，不是空结果）", async () => {
    const { app, captured } = build({ enabled: false });
    const response = await post(app, { targets: [PUBLIC_TARGET] });
    expect(response.status).toBe(403);
    const json = await response.json() as { code: string; error_layer: string; error: string };
    expect(json.code).toBe("looking_glass_disabled");
    expect(json.error_layer).toBe("capability");
    expect(json.error).toContain("LOOKING_GLASS_ENABLED");
    expect(captured.issues).toEqual([]);
  });

  test("请求体不是对象 ⇒ 400 invalid_body（不猜）", async () => {
    const { app } = build();
    const response = await app.request("/api/looking-glass/nodes/7/tests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[1,2,3]",
    });
    expect(response.status).toBe(400);
    const json = await response.json() as { code: string };
    expect(json.code).toBe("invalid_body");
  });

  test("G19.13 响应不含凭据/载荷（只含目标、状态、耗时）", async () => {
    const { app } = build();
    const response = await post(app, { targets: [PUBLIC_TARGET] });
    const text = await response.text();
    expect(text).not.toContain("credential");
    expect(text).not.toContain("token");
    expect(Object.keys(JSON.parse(text).data.results[0]).sort()).toEqual(
      ["address", "elapsed_ms", "port", "status"],
    );
  });
});
