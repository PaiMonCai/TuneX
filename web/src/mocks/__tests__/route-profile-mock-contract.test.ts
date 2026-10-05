/**
 * V5-WP13.5B Route Profile mock —— **契约一致性**（mock 必须和后端一字不差）。
 *
 * 与 task-5 的联邦 mock 同一手法：**直接读后端源码比对**，
 * 把「只能人工复核的接口漂移」变成 CI 能红的断言。
 *
 *   A. 四张错误表（码闭集 / HTTP 状态 / 失败层 / retryable / next_action）与
 *      `services/route-profile.ts` 逐项一致；
 *   B. `handleRouteProfileMock` 覆盖 `routes/route-profiles.ts` 的每一条路由声明；
 *   C. 响应字段名（列表 / 详情 / impact / apply / available）与后端映射一致；
 *   D. 行为契约：PATCH 拒模板键、发布新版本、乐观版本闸门、impact 只读、
 *      apply 必须显式 forward_ids、可见性 fail-closed、跨 workspace 404；
 *   E. `api.routeProfiles.*` 路径与后端一一对应。
 *
 * 跑法（web 目录）：bun test src/mocks/__tests__/
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROUTE_PROFILE_ERROR_LAYER,
  ROUTE_PROFILE_ERROR_NEXT_ACTION,
  ROUTE_PROFILE_ERROR_RETRYABLE,
  ROUTE_PROFILE_ERROR_STATUS,
  buildMockRouteProfiles,
  handleRouteProfileMock,
  parseMockRouteProfileTemplate,
  type MockRouteProfileState,
} from "@/mocks/route-profiles";
import { ROUTE_PROFILE_ERROR_CODES, type RouteProfileTemplate } from "@/lib/types";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const ROUTES_SRC = readFileSync(resolve(REPO_ROOT, "backend/src/routes/route-profiles.ts"), "utf8");
const SERVICE_SRC = readFileSync(resolve(REPO_ROOT, "backend/src/services/route-profile.ts"), "utf8");
const COMPILER_SRC = readFileSync(resolve(REPO_ROOT, "backend/src/services/route-profile-compiler.ts"), "utf8");
/** 跳数上限的**唯一定义处**（compiler 只是 import 它）。 */
const FORWARD_ROUTE_SRC = readFileSync(resolve(REPO_ROOT, "backend/src/services/forward-route.ts"), "utf8");
const API_SRC = readFileSync(resolve(REPO_ROOT, "web/src/lib/api.ts"), "utf8");

let state: MockRouteProfileState;
/** 作用域 = 演示用户（id 1）的个人 workspace（mock 里是 id 1，种子的 4 条模板都在这里）。 */
const ctx = { userId: 1, workspaceId: 1, isManager: true };

beforeEach(() => {
  state = buildMockRouteProfiles();
});

const call = (method: string, path: string, body?: unknown, query?: Record<string, unknown>) =>
  handleRouteProfileMock({ method, seg: path.split("/").filter(Boolean), body, query, state, ctx });

const asBody = <T>(res: { body: unknown } | null): T => res!.body as T;

/** 从后端 `Record<Code, X>` 表里抽出 code → 值 的映射。 */
function tableEntries(startMarker: string, valuePattern: RegExp): Array<[string, string]> {
  const from = SERVICE_SRC.indexOf(startMarker);
  expect({ startMarker, found: from >= 0 }).toEqual({ startMarker, found: true });
  const to = SERVICE_SRC.indexOf("};", from);
  expect({ startMarker, tableClosed: to >= 0 }).toEqual({ startMarker, tableClosed: true });
  const block = SERVICE_SRC.slice(from, to);
  return [...block.matchAll(new RegExp(`^\\s*([a-z_]+):\\s*(${valuePattern.source})`, "gm"))].map((m) => [m[1], m[2]] as [string, string]);
}

describe("A. 错误模型与后端逐项一致", () => {
  test("错误码闭集逐项一致", () => {
    const block = SERVICE_SRC.slice(
      SERVICE_SRC.indexOf("const ROUTE_PROFILE_ERROR_CODES"),
      SERVICE_SRC.indexOf("} as const;", SERVICE_SRC.indexOf("const ROUTE_PROFILE_ERROR_CODES")),
    );
    const codes = [...block.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(10);
    expect([...ROUTE_PROFILE_ERROR_CODES].sort()).toEqual([...codes].sort());
  });

  test("HTTP 状态表逐项一致", () => {
    const entries = tableEntries("const ROUTE_PROFILE_ERROR_STATUS", /\d+/);
    expect(entries.length).toBe(ROUTE_PROFILE_ERROR_CODES.length);
    for (const [code, status] of entries) {
      expect({ code, status: ROUTE_PROFILE_ERROR_STATUS[code] }).toEqual({ code, status: Number(status) });
    }
  });

  test("失败层表逐项一致", () => {
    const entries = tableEntries("const ROUTE_PROFILE_ERROR_LAYER", /"[a-z_]+"/);
    expect(entries.length).toBe(ROUTE_PROFILE_ERROR_CODES.length);
    for (const [code, layer] of entries) {
      expect({ code, layer: ROUTE_PROFILE_ERROR_LAYER[code] }).toEqual({ code, layer: layer.replace(/"/g, "") });
    }
  });

  test("retryable 表逐项一致", () => {
    const entries = tableEntries("const ROUTE_PROFILE_ERROR_RETRYABLE", /(?:true|false)/);
    expect(entries.length).toBe(ROUTE_PROFILE_ERROR_CODES.length);
    for (const [code, value] of entries) {
      expect({ code, retryable: ROUTE_PROFILE_ERROR_RETRYABLE[code] }).toEqual({ code, retryable: value === "true" });
    }
  });

  test("next_action 表逐项一致（前端展示的就是后端这句）", () => {
    const entries = tableEntries("const ROUTE_PROFILE_ERROR_NEXT_ACTION", /"[^"]*"/);
    expect(entries.length).toBe(ROUTE_PROFILE_ERROR_CODES.length);
    for (const [code, text] of entries) {
      expect({ code, next: ROUTE_PROFILE_ERROR_NEXT_ACTION[code] }).toEqual({ code, next: text.replace(/^"|"$/g, "") });
    }
  });

  test("模板解析规则与编译器一致（transit 上限 / 未知键 / 未知 selector kind 都 fail-closed）", () => {
    // 后端 MAX_ROUTE_HOPS = 3 ⇒ 最多 1 个中间跳
    // 上限定义在 forward-route.ts（compiler 与模板解析共用同一个常量）
    const maxHops = Number(/export const MAX_ROUTE_HOPS\s*=\s*(\d+)/.exec(FORWARD_ROUTE_SRC)?.[1] ?? "0");
    expect(maxHops).toBe(3);
    expect(COMPILER_SRC).toContain("MAX_ROUTE_HOPS");
    const twoMiddle = { ingress: { kind: "fixed_node", node_id: 1 }, transit: [{ kind: "fixed_node", node_id: 4 }, { kind: "fixed_node", node_id: 5 }] };
    const tooMany = parseMockRouteProfileTemplate(twoMiddle);
    expect(tooMany.ok).toBe(false);
    expect(tooMany.ok ? null : tooMany.code).toBe("unsupported_topology");

    const unknownKey = parseMockRouteProfileTemplate({ ingress: { kind: "fixed_node", node_id: 1 }, bogus: 1 });
    expect(unknownKey.ok).toBe(false);

    const badKind = parseMockRouteProfileTemplate({ ingress: { kind: "magic", node_id: 1 } });
    expect(badKind.ok).toBe(false);

    const groupInTransit = parseMockRouteProfileTemplate({
      ingress: { kind: "fixed_node", node_id: 1 },
      transit: [{ kind: "node_group", node_group_id: 2, strategy: "fallback" }],
    });
    expect(groupInTransit.ok ? null : groupInTransit.code).toBe("unsupported_topology");

    const unknownConstraint = parseMockRouteProfileTemplate({
      ingress: { kind: "fixed_node", node_id: 1 },
      constraints: { bogus: true },
    });
    expect(unknownConstraint.ok).toBe(false);

    // 合法模板通过
    const valid = parseMockRouteProfileTemplate({
      ingress: { kind: "fixed_node", node_id: 1 },
      transit: [{ kind: "fixed_node", node_id: 4 }],
      egress: { kind: "node_group", node_group_id: 3, strategy: "least_conn" },
      constraints: { allowed_lifecycles: ["active"] },
      required_capabilities: ["relay"],
    });
    expect(valid.ok).toBe(true);
  });

  test("模板键集合与后端一致（PATCH 的堵口必须覆盖同一批键）", () => {
    const block = SERVICE_SRC.slice(
      SERVICE_SRC.indexOf("const TEMPLATE_BODY_KEYS"),
      SERVICE_SRC.indexOf("] as const;", SERVICE_SRC.indexOf("const TEMPLATE_BODY_KEYS")),
    );
    const keys = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(keys).toContain("template");
    for (const key of keys) {
      expect(asBody<{ code: string }>(call("PATCH", "1", { [key]: key === "template" ? {} : null })).code).toBe("invalid_input");
    }
  });
});

describe("B. mock 覆盖后端每一条路由声明", () => {
  test("每条声明的路由在 mock 里都有响应（不是 null）", () => {
    const declared = [...ROUTES_SRC.matchAll(/routeProfilesRoutes\.(get|post|patch)\("([^"]+)"/g)].map(
      (m) => [m[1].toUpperCase(), m[2]] as const,
    );
    expect(declared.length).toBeGreaterThanOrEqual(8);
    const missing: string[] = [];
    for (const [method, path] of declared) {
      const concrete = path.replace(":id", "1").replace(":version", "3").replace(/^\/$/, "");
      const res = call(method, concrete, {});
      if (!res) missing.push(`${method} ${path}`);
    }
    expect(missing).toEqual([]);
  });

  test("未知路径返回 null；非法 id 返回 404 profile_not_found", () => {
    expect(call("GET", "nope/deep")).toBeNull();
    expect(asBody<{ code: string }>(call("GET", "999")).code).toBe("profile_not_found");
    expect(call("GET", "1/nope")).toBeNull();
  });
});

describe("C. 响应字段名与后端映射一致", () => {
  test("列表：信封与行字段", () => {
    const page = asBody<{ data: Array<Record<string, unknown>>; total: number; page: number; page_size: number }>(call("GET", ""));
    expect(Object.keys(page).sort()).toEqual(["data", "page", "page_size", "total"]);
    expect(page.data.length).toBeGreaterThan(0);
    // routeProfileView 的字段（后端 `RouteProfileView`）
    expect(Object.keys(page.data[0]).sort()).toEqual([
      "assignments",
      "created_at",
      "description",
      "enabled",
      "id",
      "name",
      "published_at",
      "template",
      "template_digest",
      "updated_at",
      "version",
      "visibility",
      "workspace_id",
    ]);
  });

  test("详情：列表视图 + versions + used_by_forwards", () => {
    const detail = asBody<Record<string, unknown>>(call("GET", "1"));
    expect(Object.keys(detail)).toContain("versions");
    expect(Object.keys(detail)).toContain("used_by_forwards");
    // 详情里的版本历史是**收窄投影**（后端 select: version / created_at / change_summary）
    const versions = detail.versions as Array<Record<string, unknown>>;
    expect(Object.keys(versions[0]).sort()).toEqual(["change_summary", "created_at", "version"]);
  });

  test("impact：read_only / scope / affected 条目字段", () => {
    const impact = asBody<Record<string, unknown>>(call("GET", "1/impact"));
    expect(Object.keys(impact).sort()).toEqual(["affected", "changing", "profile_id", "read_only", "scope", "total", "version"]);
    expect(impact.read_only).toBe(true);
    expect(impact.scope).toBe("referencing_forwards");
    const entry = (impact.affected as Array<Record<string, unknown>>)[0];
    for (const key of [
      "forward_id",
      "name",
      "tunnel_mode",
      "current_revision",
      "applied_revision",
      "apply_status",
      "source_version",
      "current_hops",
      "resolves",
      "resolved_hops",
      "change",
    ]) {
      expect(Object.keys(entry)).toContain(key);
    }
  });

  test("apply：dry_run / outcomes / applied_count / failed_count", () => {
    const res = asBody<Record<string, unknown>>(call("POST", "1/apply", { version: 3, forward_ids: [101], dry_run: true }));
    expect(Object.keys(res).sort()).toEqual(["applied_count", "dry_run", "failed_count", "outcomes", "profile_id", "version"]);
    const outcome = (res.outcomes as Array<Record<string, unknown>>)[0];
    for (const key of ["forward_id", "name", "revision", "runtime_changed", "resolved_hops", "status"]) {
      expect(Object.keys(outcome)).toContain(key);
    }
  });

  test("available：信封与消费侧字段（fail-closed）", () => {
    const res = asBody<{ data: Array<Record<string, unknown>>; total: number; user_id: number }>(call("GET", "available"));
    expect(Object.keys(res).sort()).toEqual(["data", "total", "user_id"]);
    expect(Object.keys(res.data[0]).sort()).toEqual(["description", "id", "name", "selectable", "template", "version", "visibility"]);
  });

  test("错误体形状与后端 `send()` 一致（人读原因是 error，不是 message）", () => {
    const res = call("POST", "1/apply", { version: 3 });
    expect(Object.keys(asBody<Record<string, unknown>>(res)).sort()).toEqual([
      "code",
      "error",
      "error_layer",
      "next_action",
      "retryable",
    ]);
    expect(asBody<Record<string, unknown>>(res)).not.toHaveProperty("message");
  });
});

describe("D. 行为契约（版本传播 / 只读 / 显式 apply / 可见性）", () => {
  const template = (): RouteProfileTemplate => asBody<{ template: RouteProfileTemplate }>(call("GET", "1")).template;

  test("PATCH 改 metadata 不 bump 版本；带模板键 → 400 且指向「发布新版本」", () => {
    const before = asBody<{ version: number }>(call("GET", "1")).version;
    const patched = call("PATCH", "1", { name: "改名不改版本" });
    expect(patched!.status).toBe(200);
    expect(asBody<{ version: number; name: string }>(patched)).toMatchObject({ version: before, name: "改名不改版本" });

    const rejected = call("PATCH", "1", { transit: [{ kind: "fixed_node", node_id: 4 }] });
    expect(rejected!.status).toBe(400);
    expect(asBody<{ code: string; error: string }>(rejected)).toMatchObject({ code: "invalid_input" });
    expect(asBody<{ error: string }>(rejected).error).toContain("发布新版本");
    // 被拒后内容没变
    expect(asBody<{ version: number }>(call("GET", "1")).version).toBe(before);
  });

  test("发布新版本：version+1、版本历史追加、内容真的换掉", () => {
    const before = asBody<{ version: number }>(call("GET", "1")).version;
    const next: RouteProfileTemplate = { ...template(), transit: [{ kind: "fixed_node", node_id: 5 }] };
    const published = call("POST", "1/versions", { template: next, expected_version: before, change_summary: "换中转" });
    expect(published!.status).toBe(201);
    const body = asBody<{ version: number; version_id: number; profile: { version: number } }>(published);
    expect(body.version).toBe(before + 1);
    expect(body.profile.version).toBe(before + 1);

    const detail = asBody<{ version: number; template: RouteProfileTemplate; versions: Array<{ change_summary: string }> }>(call("GET", "1"));
    expect(detail.version).toBe(before + 1);
    expect(detail.template.transit[0].node_id).toBe(5);
    expect(detail.versions[0].change_summary).toBe("换中转");
  });

  test("乐观版本闸门：expected_version 过期 → 409 version_conflict + data.latest_version", () => {
    const rejected = call("PATCH", "1", { name: "x", expected_version: 1 });
    expect(rejected!.status).toBe(409);
    const body = asBody<{ code: string; retryable: boolean; data: { latest_version: number } }>(rejected);
    expect(body.code).toBe("version_conflict");
    expect(body.retryable).toBe(true);
    expect(body.data.latest_version).toBe(3);

    const publishRejected = call("POST", "1/versions", { template: template(), expected_version: 1 });
    expect(publishRejected!.status).toBe(409);
    expect(asBody<{ code: string }>(publishRejected).code).toBe("version_conflict");
  });

  test("impact **只读**：调用前后状态行数 / revision 完全不变", () => {
    const before = JSON.stringify({
      profiles: state.profiles.map((p) => [p.id, p.version]),
      referencing: [...state.referencing.entries()].map(([id, f]) => [id, f.map((x) => [x.forward_id, x.current_revision, x.source_version])]),
    });
    const impact = call("GET", "1/impact");
    expect(impact!.status).toBe(200);
    const after = JSON.stringify({
      profiles: state.profiles.map((p) => [p.id, p.version]),
      referencing: [...state.referencing.entries()].map(([id, f]) => [id, f.map((x) => [x.forward_id, x.current_revision, x.source_version])]),
    });
    expect(after).toBe(before);
  });

  test("impact：无法解析的目标版本按码给出原因（no_eligible_node / route_invalid）", () => {
    // 把模板的出口组改成不存在的组 → 解析失败
    state.profiles[0].template = { ...state.profiles[0].template, egress: { kind: "node_group", node_group_id: 99, strategy: "fallback" } };
    const impact = asBody<{ affected: Array<{ resolves: boolean; error?: { code: string } }> }>(call("GET", "1/impact"));
    expect(impact.affected.every((a) => !a.resolves)).toBe(true);
    expect(impact.affected[0].error?.code).toBe("no_eligible_node");
  });

  test("apply 必须显式 forward_ids；dry_run 不改状态；真 apply 推进 revision 与来源版本", () => {
    const missing = call("POST", "1/apply", { version: 3 });
    expect(missing!.status).toBe(400);
    expect(asBody<{ code: string }>(missing).code).toBe("invalid_input");

    const empty = call("POST", "1/apply", { version: 3, forward_ids: [] });
    expect(empty!.status).toBe(400);

    const revBefore = state.referencing.get(1)!.find((f) => f.forward_id === 101)!.current_revision;
    const dry = asBody<{ dry_run: boolean; applied_count: number; outcomes: Array<{ status: string }> }>(
      call("POST", "1/apply", { version: 3, forward_ids: [101], dry_run: true }),
    );
    expect(dry.dry_run).toBe(true);
    expect(dry.outcomes[0].status).toBe("previewed");
    expect(dry.applied_count).toBe(0);
    expect(state.referencing.get(1)!.find((f) => f.forward_id === 101)!.current_revision).toBe(revBefore);

    const applied = asBody<{ applied_count: number; failed_count: number; outcomes: Array<{ status: string; runtime_changed?: boolean }> }>(
      call("POST", "1/apply", { version: 3, forward_ids: [101] }),
    );
    expect(applied.applied_count).toBe(1);
    expect(applied.outcomes[0].status).toBe("applied");
    const after = state.referencing.get(1)!.find((f) => f.forward_id === 101)!;
    expect(after.current_revision).toBe(revBefore + 1);
    expect(after.source_version).toBe(3);
  });

  test("apply：expected_revisions 冲突 → 该条 rollout_conflict（不覆盖）", () => {
    const res = asBody<{ outcomes: Array<{ status: string; error?: { code: string; retryable: boolean } }> }>(
      call("POST", "1/apply", { version: 3, forward_ids: [101], expected_revisions: [{ forward_id: 101, revision: 1 }] }),
    );
    expect(res.outcomes[0].status).toBe("failed");
    expect(res.outcomes[0].error?.code).toBe("rollout_conflict");
    expect(res.outcomes[0].error?.retryable).toBe(true);
  });

  test("apply：未知 Forward → profile_not_found（与后端同码）", () => {
    const res = asBody<{ outcomes: Array<{ status: string; error?: { code: string } }> }>(
      call("POST", "1/apply", { version: 3, forward_ids: [999] }),
    );
    expect(res.outcomes[0].status).toBe("failed");
    expect(res.outcomes[0].error?.code).toBe("profile_not_found");
  });

  test("消费侧可见性 fail-closed：INTERNAL 仅管理面、ASSIGNED 需授权、停用一律不可见", () => {
    const manager = asBody<{ data: Array<{ id: number }> }>(call("GET", "available"));
    const consumer = asBody<{ data: Array<{ id: number }> }>(
      handleRouteProfileMock({ method: "GET", seg: ["available"], state, ctx: { ...ctx, isManager: false } })!,
    );
    expect(manager.data.map((r) => r.id)).toEqual([1, 3]); // PUBLIC + INTERNAL（管理面）
    expect(consumer.data.map((r) => r.id)).toEqual([1]); // 只有 PUBLIC；ASSIGNED(ws1) 与 INTERNAL 都不可见
    expect(manager.data.some((r) => r.id === 4)).toBe(false); // enabled=false

    // ASSIGNED 授权给当前 workspace 时，消费者也能看到
    state.profiles[1].assignments = [{ target_type: "workspace", target_id: 1, active: true }];
    const consumer2 = asBody<{ data: Array<{ id: number }> }>(
      handleRouteProfileMock({ method: "GET", seg: ["available"], state, ctx: { ...ctx, isManager: false } })!,
    );
    expect(consumer2.data.map((r) => r.id)).toEqual([1, 2]);
  });

  test("跨 workspace 一律 404（不泄露存在性）", () => {
    const res = handleRouteProfileMock({ method: "GET", seg: ["1"], state, ctx: { ...ctx, workspaceId: 99 } });
    expect(res!.status).toBe(404);
    expect(asBody<{ code: string }>(res).code).toBe("profile_not_found");
  });
});

describe("E. api.routeProfiles.* 路径与后端一一对应", () => {
  const block = API_SRC.slice(API_SRC.indexOf("routeProfiles: {"), API_SRC.indexOf("  admin: {", API_SRC.indexOf("routeProfiles: {")));

  test("每条后端路由都能在 api 层找到", () => {
    const declared = [...ROUTES_SRC.matchAll(/routeProfilesRoutes\.(get|post|patch)\("([^"]+)"/g)].map((m) => m[2]);
    const patterns = declared.map((path) => {
      const body = path
        .split("/")
        .filter(Boolean)
        .map((seg) => (seg.startsWith(":") ? "\\$\\{[^}]+\\}" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/");
      return `/route-profiles${body ? `/${body}` : ""}`;
    });
    const missing = patterns.filter((p) => !new RegExp(p).test(block));
    expect(missing).toEqual([]);
  });

  test("api 层齐备：list/detail/create/patch/publishVersion/versions/version/impact/apply/available", () => {
    for (const method of [
      "list:",
      "detail:",
      "create:",
      "patch:",
      "publishVersion:",
      "versions:",
      "version:",
      "impact:",
      "apply:",
      "available:",
    ]) {
      expect({ method, present: block.includes(method) }).toEqual({ method, present: true });
    }
    // 不走 /admin 前缀（后端复用 workspace RBAC）
    expect(block.includes('"/admin/route-profiles')).toBe(false);
  });
});
